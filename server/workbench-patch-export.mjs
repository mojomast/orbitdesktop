import fs from 'node:fs';
import {constants as C} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validatePatchRequest,RESULT_PATCH_MAX_BYTES} from '../contracts/workbench-result-v1.mjs';
import {wbError} from './workbench-store.mjs';
import {openProjectRoot,readProjectFile} from './project-files.mjs';
import {readCandidateFile} from './workbench-candidates.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashJson=value=>sha(Buffer.from(JSON.stringify(value)));
const TTL=60000,RESPONSE_MAX=2*1024*1024,FILE_MAX=256*1024;
const gitEnv={PATH:'/usr/bin:/bin',HOME:'/dev/null',XDG_CONFIG_HOME:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'};
const publicPatch=({private_root,op_id,...record})=>({...record,artifact_id:record.id});
const safeRelative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.startsWith('/')&&!value.includes('\\')&&!/[\0-\x1f\x7f:]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));

function readWithMode(rootPath,rootIdentity,relative){
  if(!safeRelative(relative))throw wbError('unsupported');
  const root=openProjectRoot(rootPath,rootIdentity),opened=[];let parent=root.fd;
  try{
    const parts=relative.split('/');
    for(let index=0;index<parts.length;index++){
      const flags=C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|(index<parts.length-1?C.O_DIRECTORY:0);
      const fd=fs.openSync(`/proc/self/fd/${parent}/${parts[index]}`,flags);opened.push(fd);parent=fd;
      const stat=fs.fstatSync(fd);if(stat.dev!==root.dev||index<parts.length-1&&!stat.isDirectory())throw wbError('stale_resource');
      if(index===parts.length-1){
        if(!stat.isFile()||stat.nlink!==1||stat.size>FILE_MAX)throw wbError('unsupported');
        const before=stat,bytes=Buffer.alloc(before.size),read=fs.readSync(fd,bytes,0,bytes.length,0),after=fs.fstatSync(fd);
        if(read!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw wbError('stale_resource');
        return {bytes,hash:sha(bytes),mode:(before.mode&0o111)?'100755':'100644'};
      }
    }
    throw wbError('unsupported');
  }catch(error){throw error?.code?error:wbError('unavailable');}
  finally{for(const fd of opened.reverse())fs.closeSync(fd);root.close();}
}

function materialize(root,manifest,bytesFor){
  for(const entry of manifest){
    const destination=path.join(root,entry.path),directory=path.dirname(destination);
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const content=bytesFor(entry);
    if(sha(content)!==entry.hash||content.length!==entry.bytes)throw wbError('stale_resource');
    fs.writeFileSync(destination,content,{flag:'wx',mode:entry.mode==='100755'?0o700:0o600});
  }
}
function text(bytes){if(bytes.includes(0))return null;try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}}
function diffFor(folder,change,oldBytes,newBytes){
  const oldFile=path.join(folder,'old'),newFile=path.join(folder,'new');
  fs.writeFileSync(oldFile,oldBytes,{mode:0o600});fs.writeFileSync(newFile,newBytes,{mode:0o600});
  try{return execFileSync('/usr/bin/diff',['-u','--label',change.kind==='add'?'/dev/null':`a/${change.path}`,'--label',change.kind==='delete'?'/dev/null':`b/${change.path}`,'--',oldFile,newFile],{encoding:'buffer',timeout:5000,maxBuffer:RESULT_PATCH_MAX_BYTES+1});}
  catch(error){if(error.status===1&&Buffer.isBuffer(error.stdout))return error.stdout;throw error;}
}
function rm(folder){try{fs.rmSync(folder,{recursive:true,force:true,maxRetries:2});}catch{}}

export function createWorkbenchPatchExport({store,records,data,execution,inspect,now=Date.now}={}){
  if(!path.isAbsolute(store?.root??'')||!records?.project||!data?.db||!execution?.dispatch||typeof inspect!=='function')throw Error('Patch export dependencies required');
  const root=path.join(store.root,'workbench-patches');fs.mkdirSync(root,{recursive:true,mode:0o700});
  const previews=new Map();
  function scope(body){store.read(body.workspace_id);return records.project(body.workspace_id,body.project_id);}
  function readSource(project,entry){const bytes=readProjectFile(project,entry.path),observed=readWithMode(project.root,project.identity,entry.path);if(bytes.hash!==entry.hash||bytes.hash!==observed.hash||bytes.bytes.length!==entry.bytes||bytes.bytes.length!==observed.bytes.length)throw wbError('stale_resource');return {bytes:bytes.bytes,mode:observed.mode};}
  function readCandidate(candidate,entry){
    const rootStat=fs.lstatSync(candidate.root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw wbError('stale_resource');const identity=`${rootStat.dev}:${rootStat.ino}`;
    const observed=readWithMode(candidate.root,identity,entry.path),visible=readCandidateFile(store,candidate,entry.path);
    if(visible.hash!==entry.hash||observed.hash!==entry.hash||observed.bytes.length!==entry.bytes)throw wbError('stale_resource');
    return {bytes:observed.bytes,mode:observed.mode};
  }
  async function snapshot(body){
    const target=await inspect(body),{project,candidate,review,source,files}=target;
    if(candidate.task_id!==body.task_id||source.limited||candidate.limited)throw wbError('unsupported');
    const executionState=await execution.dispatch({action:'candidate_get',workspace_id:body.workspace_id,project_id:body.project_id,candidate_id:candidate.id});
    if(executionState.target_changed||!executionState.acceptance_complete||executionState.candidate.hash!==candidate.hash||review.decision!=='approved'||review.candidate_id!==candidate.id||review.candidate_hash!==candidate.hash||review.review_identity!==executionState.review_identity)throw wbError('stale_resource');
    const sourceFiles=source.manifest.map(entry=>{const observed=readSource(project,entry);return {...entry,mode:observed.mode};});
    const candidateFiles=files.map(entry=>{const observed=readCandidate(candidate,entry);return {...entry,mode:observed.mode};});
    const sourceMap=new Map(sourceFiles.map(file=>[file.path,file])),candidateMap=new Map(candidateFiles.map(file=>[file.path,file]));
    const lower=new Map();for(const file of [...sourceFiles,...candidateFiles]){const key=file.path.normalize('NFC').toLocaleLowerCase('en-US');const prior=lower.get(key);if(prior&&prior!==file.path)throw wbError('unsupported');lower.set(key,file.path);}
    const changes=[];
    for(const file of sourceFiles){const next=candidateMap.get(file.path);if(!next)changes.push({path:file.path,kind:'delete',old_hash:file.hash,old_mode:file.mode});else{if(file.mode!==next.mode)throw wbError('unsupported');if(file.hash!==next.hash)changes.push({path:file.path,kind:'modify',old_hash:file.hash,new_hash:next.hash,old_mode:file.mode,new_mode:next.mode});}}
    for(const file of candidateFiles)if(!sourceMap.has(file.path))changes.push({path:file.path,kind:'add',new_hash:file.hash,new_mode:file.mode});
    changes.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    if(!changes.length)throw wbError('unsupported');
    const scratch=path.join(root,`.verify-${randomUUID()}`);fs.mkdirSync(scratch,{mode:0o700});
    try{
      const base=path.join(scratch,'base'),roundtrip=path.join(scratch,'roundtrip'),candidateRoot=path.join(scratch,'candidate'),diffdir=path.join(scratch,'diff');
      for(const folder of [base,roundtrip,candidateRoot,diffdir])fs.mkdirSync(folder,{mode:0o700});
      const sourceContent=new Map(sourceFiles.map(file=>[file.path,readSource(project,file)]));
      const candidateContent=new Map(candidateFiles.map(file=>[file.path,readCandidate(candidate,file)]));
      materialize(base,sourceFiles,entry=>sourceContent.get(entry.path).bytes);
      materialize(roundtrip,sourceFiles,entry=>sourceContent.get(entry.path).bytes);
      materialize(candidateRoot,candidateFiles,entry=>candidateContent.get(entry.path).bytes);
      const hunks=[];
      for(const change of changes){
        const old=sourceContent.get(change.path)?.bytes??Buffer.alloc(0),fresh=candidateContent.get(change.path)?.bytes??Buffer.alloc(0);
        if(text(old)===null||text(fresh)===null)throw wbError('unsupported');
        let chunk;try{chunk=diffFor(diffdir,change,old,fresh);}catch(error){if(error.status===1)continue;throw error;}
        if(!chunk.length)throw wbError('unsupported');
        hunks.push(chunk);
        if(hunks.reduce((sum,item)=>sum+item.length,0)>RESULT_PATCH_MAX_BYTES)throw wbError('limit_exceeded');
      }
      const patch=Buffer.concat(hunks);
      if(!patch.length||patch.length>RESULT_PATCH_MAX_BYTES)throw wbError('unsupported');
      const patchFile=path.join(scratch,'patch.diff');fs.writeFileSync(patchFile,patch,{mode:0o600});
      execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','init.defaultBranch=main','-C',roundtrip,'init','--quiet'],{env:gitEnv,timeout:5000});
      try{execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-C',roundtrip,'apply','--check',patchFile],{env:gitEnv,timeout:5000});execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-C',roundtrip,'apply',patchFile],{env:gitEnv,timeout:5000});}catch{throw wbError('unsupported');}
      const roundPaths=[];const walk=folder=>{for(const dirent of fs.readdirSync(folder,{withFileTypes:true})){if(folder===roundtrip&&dirent.name==='.git')continue;const absolute=path.join(folder,dirent.name),relative=path.relative(roundtrip,absolute).split(path.sep).join('/');if(dirent.isDirectory())walk(absolute);else roundPaths.push(relative);}};walk(roundtrip);
      const candidateNames=candidateFiles.map(file=>file.path).sort(),actualNames=roundPaths.sort();
      if(JSON.stringify(candidateNames)!==JSON.stringify(actualNames))throw wbError('stale_resource');
      for(const file of candidateFiles){const bytes=fs.readFileSync(path.join(roundtrip,file.path));if(sha(bytes)!==file.hash||bytes.length!==file.bytes)throw wbError('stale_resource');}
      const exclusions=[...(source.exclusions??[]),...(candidate.exclusions??[])];
      const state={version:1,workspace_id:body.workspace_id,project_id:body.project_id,task_id:candidate.task_id,candidate_id:candidate.id,candidate_hash:candidate.hash,candidate_generation:candidate.generation,review_id:review.id,review_identity:review.review_identity,source:{manifest_hash:source.hash,head:target.source_head??null,files:sourceFiles,limited:source.limited},candidate:{manifest_hash:candidate.source_manifest_hash,head:null,files:candidateFiles,limited:candidate.limited},review:{id:review.id,identity:review.review_identity,evidence_ids:review.evidence_ids,required_check_state:{complete:executionState.acceptance_complete,acceptance_version:review.acceptance_version,acceptance_digest:review.acceptance_digest}},changes,exclusions,unsupported:[],roundtrip:{base_identity:source.hash,result_identity:candidate.hash,verified:true,unrelated_unchanged:true}};
      const final=await inspect(body);
      if(final.source.hash!==source.hash||final.source_head!==(target.source_head??null)||final.candidate.hash!==candidate.hash||final.review.review_identity!==review.review_identity)throw wbError('stale_resource');
      const finalExecution=await execution.dispatch({action:'candidate_get',workspace_id:body.workspace_id,project_id:body.project_id,candidate_id:candidate.id});
      if(finalExecution.target_changed||!finalExecution.acceptance_complete||finalExecution.candidate.hash!==candidate.hash||finalExecution.review_identity!==review.review_identity)throw wbError('stale_resource');
      const finalSource=final.source.manifest.map(entry=>{const value=readSource(final.project,entry);return {...entry,mode:value.mode};});
      const finalCandidate=final.files.map(entry=>{const value=readCandidate(final.candidate,entry);return {...entry,mode:value.mode};});
      if(hashJson(finalSource)!==hashJson(sourceFiles)||hashJson(finalCandidate)!==hashJson(candidateFiles))throw wbError('stale_resource');
      const preview_digest=hashJson(state);
      const response={preview_id:randomUUID(),preview_digest,expires_at:now()+TTL,...state,format:'git-unified-diff',artifact_hash:sha(patch),bytes:patch.length};
      const wouldGet={artifact_id:'0'.repeat(36),receipt:response,patch:patch.toString('utf8'),ok:true};
      if(Buffer.byteLength(JSON.stringify(wouldGet))>RESPONSE_MAX-256)throw wbError('limit_exceeded');
      previews.set(response.preview_id,{state,preview_digest,patch,expires_at:response.expires_at});
      if(previews.size>64)for(const [id,value] of previews)if(value.expires_at<=now()||previews.size>64)previews.delete(id);
      return response;
    }finally{rm(scratch);}
  }
  async function preview(body){return snapshot(body);}
  async function exportPatch(body){
    scope(body);
    const prior=data.list('patches',body.workspace_id,body.project_id).find(item=>item.op_id===body.op_id);
    if(prior){if(prior.preview_digest!==body.preview_digest||prior.candidate_id!==body.candidate_id||prior.review_id!==body.review_id)throw wbError('conflict');return {patch:publicPatch(prior),idempotent:true};}
    const issued=previews.get(body.preview_id);if(!issued||issued.expires_at<=now())throw wbError('expired');
    if(issued.preview_digest!==body.preview_digest||issued.state.candidate_id!==body.candidate_id||issued.state.review_id!==body.review_id||issued.state.task_id!==body.task_id)throw wbError('stale_resource');
    const current=await inspect(body),candidate=current.candidate,review=current.review;
    const checked=await snapshot({workspace_id:body.workspace_id,project_id:body.project_id,task_id:body.task_id,candidate_id:body.candidate_id,review_id:body.review_id});
    if(checked.preview_digest!==issued.preview_digest||candidate.hash!==issued.state.candidate_hash||review.review_identity!==issued.state.review_identity)throw wbError('stale_resource');
    previews.delete(body.preview_id);
    const intent=data.create('patches',{workspace_id:body.workspace_id,project_id:body.project_id,task_id:body.task_id,candidate_id:body.candidate_id,candidate_hash:issued.state.candidate_hash,review_id:body.review_id,review_identity:issued.state.review_identity,preview_digest:body.preview_digest,op_id:body.op_id,status:'preparing',artifact_hash:sha(issued.patch),bytes:issued.patch.length,format:'git-unified-diff',source:issued.state.source,candidate:issued.state.candidate,review:issued.state.review,changes:issued.state.changes,exclusions:issued.state.exclusions,unsupported:[],roundtrip:issued.state.roundtrip,private_root:path.join(root,`${randomUUID()}.patch`)});
    try{const fd=fs.openSync(intent.private_root,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,issued.patch);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const dir=fs.openSync(root,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}const final=await inspect(body);if(final.source.hash!==issued.state.source.manifest_hash||final.source_head!==(issued.state.source.head??null)||final.candidate.hash!==issued.state.candidate_hash||final.review.review_identity!==issued.state.review_identity)throw wbError('stale_resource');const updated=data.update('patches',body.workspace_id,body.project_id,intent.id,intent.revision,{status:'available'});return {patch:publicPatch(updated),idempotent:false};}
    catch(error){try{data.update('patches',body.workspace_id,body.project_id,intent.id,intent.revision,{status:'preparation_failed'});}catch{}throw error;}
  }
  function getPatch(body){
    scope(body);const record=data.list('patches',body.workspace_id,body.project_id).find(item=>item.id===body.artifact_id);
    if(!record||record.status!=='available')throw wbError('permission_denied');
    if(path.resolve(record.private_root)!==record.private_root||path.dirname(record.private_root)!==root||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.patch$/.test(path.basename(record.private_root)))throw wbError('permission_denied');
    const stat=fs.lstatSync(record.private_root);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.size!==record.bytes)throw wbError('stale_resource');
    const patch=fs.readFileSync(record.private_root);if(sha(patch)!==record.artifact_hash||patch.length!==record.bytes)throw wbError('stale_resource');
    const receipt=publicPatch(record),result={artifact_id:record.id,receipt,patch:patch.toString('utf8')};
    if(Buffer.byteLength(JSON.stringify({...result,ok:true}))>RESPONSE_MAX-32)throw wbError('limit_exceeded');
    return result;
  }
  async function dispatch(body){
    if(!validatePatchRequest(body))return null;
    if(body.action==='patch_preview')return preview(body);
    if(body.action==='patch_export')return exportPatch(body);
    if(body.action==='private_patch_get')return getPatch(body);
    return null;
  }
  return {dispatch};
}
