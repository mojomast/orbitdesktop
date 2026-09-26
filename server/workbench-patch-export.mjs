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
const publicPatch=record=>({version:record.version,id:record.id,artifact_id:record.id,workspace_id:record.workspace_id,project_id:record.project_id,task_id:record.task_id,candidate_id:record.candidate_id,candidate_hash:record.candidate_hash,candidate_generation:record.candidate_generation,review_id:record.review_id,review_identity:record.review_identity,preview_digest:record.preview_digest,status:record.status,artifact_hash:record.artifact_hash,bytes:record.bytes,format:record.format,source:record.source,candidate:record.candidate,review:record.review,changes:record.changes,exclusions:record.exclusions,unsupported:record.unsupported,roundtrip:record.roundtrip,verification:record.verification?{version:record.verification.version,id:record.verification.id,status:record.verification.status,artifact_id:record.verification.artifact_id,artifact_hash:record.verification.artifact_hash,source_manifest_hash:record.verification.source_manifest_hash,candidate_id:record.verification.candidate_id,candidate_hash:record.verification.candidate_hash,candidate_generation:record.verification.candidate_generation,review_id:record.verification.review_id,review_identity:record.verification.review_identity,acceptance_digest:record.verification.acceptance_digest,required_checks_digest:record.verification.required_checks_digest,results:(record.verification.results??[]).map(({definition_id,definition_digest,required_test_files,verdict,test_results,candidate_hash_before,candidate_hash_after,artifact_hash,log_hash,env_fingerprint,recorded_by})=>({definition_id,definition_digest,required_test_files,verdict,test_results,candidate_hash_before,candidate_hash_after,artifact_hash,log_hash,env_fingerprint,recorded_by})),recorded_by:record.verification.recorded_by,verified_at:record.verification.verified_at??null}:null,created_at:record.created_at,updated_at:record.updated_at});
const publicPatchSummary=record=>({artifact_id:record.id,id:record.id,task_id:record.task_id,candidate_id:record.candidate_id,candidate_hash:record.candidate_hash,candidate_generation:record.candidate_generation,review_id:record.review_id,status:record.status,artifact_hash:record.artifact_hash,bytes:record.bytes,format:record.format,created_at:record.created_at,verification:record.verification?{id:record.verification.id,status:record.verification.status,artifact_hash:record.verification.artifact_hash,acceptance_digest:record.verification.acceptance_digest,required_checks_digest:record.verification.required_checks_digest,results:(record.verification.results??[]).map(({definition_id,definition_digest,verdict,log_hash,env_fingerprint})=>({definition_id,definition_digest,verdict,log_hash,env_fingerprint})),verified_at:record.verification.verified_at??null}:null});
const safeRelative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!value.startsWith('/')&&!value.includes('\\')&&!/[\0-\x1f\x7f:]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
const ROUNDTRIP=Symbol('patch-roundtrip-stage');

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
  const previews=new Map(),exportFlights=new Map();
  function scope(body){store.read(body.workspace_id);return records.project(body.workspace_id,body.project_id);}
  function readSource(project,entry){const bytes=readProjectFile(project,entry.path),observed=readWithMode(project.root,project.identity,entry.path);if(bytes.hash!==entry.hash||bytes.hash!==observed.hash||bytes.bytes.length!==entry.bytes||bytes.bytes.length!==observed.bytes.length)throw wbError('stale_resource');return {bytes:bytes.bytes,mode:observed.mode};}
  function readCandidate(candidate,entry){
    const rootStat=fs.lstatSync(candidate.root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw wbError('stale_resource');const identity=`${rootStat.dev}:${rootStat.ino}`;
    const observed=readWithMode(candidate.root,identity,entry.path),visible=readCandidateFile(store,candidate,entry.path);
    if(visible.hash!==entry.hash||observed.hash!==entry.hash||observed.bytes.length!==entry.bytes)throw wbError('stale_resource');
    return {bytes:observed.bytes,mode:observed.mode};
  }
  async function snapshot(body,{retainStage=false}={}){
    const target=await inspect(body),{project,candidate,review,source,files}=target,taskRecord=data.get('tasks',body.workspace_id,body.project_id,candidate.task_id);
    if(candidate.task_id!==body.task_id||source.limited||candidate.limited)throw wbError('unsupported');
    const executionState=await execution.dispatch({action:'candidate_get',workspace_id:body.workspace_id,project_id:body.project_id,candidate_id:candidate.id});
    if(executionState.target_changed||!executionState.acceptance_complete||executionState.candidate.hash!==candidate.hash||review.decision!=='approved'||review.candidate_id!==candidate.id||review.candidate_hash!==candidate.hash||review.review_identity!==executionState.review_identity)throw wbError('stale_resource');
    const sourceFiles=source.manifest.map(entry=>{const observed=readSource(project,entry);return {...entry,mode:observed.mode};});
    const candidateFiles=files.map(entry=>{const observed=readCandidate(candidate,entry);return {...entry,mode:observed.mode};});
    const sourceMap=new Map(sourceFiles.map(file=>[file.path,file])),candidateMap=new Map(candidateFiles.map(file=>[file.path,file]));
    const lower=new Map();for(const file of [...sourceFiles,...candidateFiles]){const key=file.path.normalize('NFC').toLocaleLowerCase('en-US');const prior=lower.get(key);if(prior&&prior!==file.path)throw wbError('unsupported');lower.set(key,file.path);}
    const changes=[];
    for(const file of sourceFiles){const next=candidateMap.get(file.path);if(!next){if(file.mode!=='100644')throw wbError('unsupported');changes.push({path:file.path,kind:'delete',old_hash:file.hash,old_mode:file.mode});}else{if(file.mode!==next.mode)throw wbError('unsupported');if(file.hash!==next.hash)changes.push({path:file.path,kind:'modify',old_hash:file.hash,new_hash:next.hash,old_mode:file.mode,new_mode:next.mode});}}
    for(const file of candidateFiles)if(!sourceMap.has(file.path)){if(file.mode!=='100644')throw wbError('unsupported');changes.push({path:file.path,kind:'add',new_hash:file.hash,new_mode:file.mode});}
    changes.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    if(!changes.length)throw wbError('unsupported');
    const scratch=path.join(root,`.verify-${randomUUID()}`);fs.mkdirSync(scratch,{mode:0o700});
    let keepStage=false;
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
      for(const file of candidateFiles){const filename=path.join(roundtrip,file.path),bytes=fs.readFileSync(filename),stat=fs.lstatSync(filename),mode=(stat.mode&0o111)?'100755':'100644';if(sha(bytes)!==file.hash||bytes.length!==file.bytes||mode!==file.mode)throw wbError('stale_resource');}
      const exclusions=[...(source.exclusions??[]),...(candidate.exclusions??[])];
      const state={version:1,workspace_id:body.workspace_id,project_id:body.project_id,task_id:candidate.task_id,candidate_id:candidate.id,candidate_hash:candidate.hash,candidate_generation:candidate.generation,review_id:review.id,review_identity:review.review_identity,source:{manifest_hash:source.hash,head:target.source_head??null,files:sourceFiles,limited:source.limited},candidate:{manifest_hash:candidate.source_manifest_hash,head:null,files:candidateFiles,limited:candidate.limited},review:{id:review.id,identity:review.review_identity,evidence_ids:review.evidence_ids,required_check_state:{complete:executionState.acceptance_complete,acceptance_version:review.acceptance_version,acceptance_digest:taskRecord.acceptance_digest,required_checks_digest:taskRecord.acceptance.required_checks_digest,required_checks:taskRecord.acceptance.required_checks.map(({definition_id,definition_digest,execution_profile_id,required_test_files})=>({definition_id,definition_digest,execution_profile_id,required_test_files}))}},changes,exclusions,unsupported:[],roundtrip:{base_identity:source.hash,result_identity:candidate.hash,verified:true,unrelated_unchanged:true}};
      const final=await inspect(body);
      if(final.source.hash!==source.hash||final.source_head!==(target.source_head??null)||final.candidate.hash!==candidate.hash||final.review.review_identity!==review.review_identity)throw wbError('stale_resource');
      const finalExecution=await execution.dispatch({action:'candidate_get',workspace_id:body.workspace_id,project_id:body.project_id,candidate_id:candidate.id});
      if(finalExecution.target_changed||!finalExecution.acceptance_complete||finalExecution.candidate.hash!==candidate.hash||finalExecution.review_identity!==review.review_identity)throw wbError('stale_resource');
      const finalSource=final.source.manifest.map(entry=>{const value=readSource(final.project,entry);return {...entry,mode:value.mode};});
      const finalCandidate=final.files.map(entry=>{const value=readCandidate(final.candidate,entry);return {...entry,mode:value.mode};});
      if(hashJson(finalSource)!==hashJson(sourceFiles)||hashJson(finalCandidate)!==hashJson(candidateFiles))throw wbError('stale_resource');
      const preview_digest=hashJson(state);
      const response={preview_id:randomUUID(),preview_digest,expires_at:now()+TTL,...state,format:'git-unified-diff',patch_text:patch.toString('utf8'),artifact_hash:sha(patch),bytes:patch.length};
      const wouldGet={artifact_id:'0'.repeat(36),receipt:response,patch:patch.toString('utf8'),ok:true};
      if(Buffer.byteLength(JSON.stringify(wouldGet))>RESPONSE_MAX-256)throw wbError('limit_exceeded');
      Object.defineProperty(response,ROUNDTRIP,{value:scratch,enumerable:false});
      previews.set(response.preview_id,{state,preview_digest,patch,expires_at:response.expires_at});
      if(previews.size>64)for(const [id,value] of previews)if(value.expires_at<=now()||previews.size>64)previews.delete(id);
      if(retainStage)keepStage=true;
      return response;
    }finally{if(!keepStage)rm(scratch);}
  }
  async function preview(body){return snapshot(body);}
  const sameRequest=(record,body)=>record.workspace_id===body.workspace_id&&record.project_id===body.project_id&&record.task_id===body.task_id&&record.candidate_id===body.candidate_id&&record.review_id===body.review_id&&record.preview_id===body.preview_id&&record.preview_digest===body.preview_digest&&record.op_id===body.op_id;
  const matchingReplay=(body)=>data.list('patches',body.workspace_id,body.project_id).find(item=>item.op_id===body.op_id);
  function isVerifiedPatch(record){
    const verification=record.verification;
    const required=record.review?.required_check_state?.required_checks;
    return (record.status==='verified'||record.status==='available')&&verification?.status==='verified'&&verification.artifact_id===record.id&&verification.artifact_hash===record.artifact_hash&&verification.candidate_id===record.candidate_id&&verification.candidate_hash===record.candidate_hash&&verification.candidate_generation===record.candidate_generation&&verification.review_id===record.review_id&&verification.review_identity===record.review_identity&&verification.source_manifest_hash===record.source?.manifest_hash&&verification.acceptance_digest===record.review?.required_check_state?.acceptance_digest&&verification.required_checks_digest===record.review?.required_check_state?.required_checks_digest&&Array.isArray(required)&&Array.isArray(verification.results)&&verification.results.length===required.length&&verification.results.every((item,index)=>item.verdict==='pass'&&item.definition_id===required[index].definition_id&&item.definition_digest===required[index].definition_digest);
  }
  function assertVerified(record,body){
    if(!isVerifiedPatch(record))throw wbError('unavailable');
    if(!sameRequest(record,body))throw wbError('conflict');
  }
  function artifactBytes(record){
    if(path.resolve(record.private_root)!==record.private_root||path.dirname(record.private_root)!==root||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.patch$/.test(path.basename(record.private_root)))throw wbError('permission_denied');
    const fd=fs.openSync(record.private_root,C.O_RDONLY|C.O_NOFOLLOW);try{const stat=fs.fstatSync(fd),bytes=fs.readFileSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.size!==record.bytes||sha(bytes)!==record.artifact_hash||bytes.length!==record.bytes)throw wbError('stale_resource');return bytes;}finally{fs.closeSync(fd);}
  }
  async function promoteVerified(body,record){
    assertVerified(record,body);
    const final=await snapshot({workspace_id:body.workspace_id,project_id:body.project_id,task_id:body.task_id,candidate_id:body.candidate_id,review_id:body.review_id});
    if(final.preview_digest!==record.preview_digest)throw wbError('stale_resource');
    const bytes=artifactBytes(record);if(sha(bytes)!==record.artifact_hash||bytes.length!==record.bytes)throw wbError('stale_resource');
    const current=data.get('patches',body.workspace_id,body.project_id,record.id);
    if(current.status==='available')return current;
    if(current.revision!==record.revision||current.status!=='verified')throw wbError('stale_resource');
    return data.update('patches',body.workspace_id,body.project_id,current.id,current.revision,{status:'available'});
  }
  async function exportPatch(body){
    scope(body);
    const prior=matchingReplay(body);
    if(prior){if(!sameRequest(prior,body))throw wbError('conflict');if(prior.status==='verified')return {patch:publicPatch(await promoteVerified(body,prior)),idempotent:true};return {patch:publicPatch(prior),idempotent:true};}
    const issued=previews.get(body.preview_id);if(!issued||issued.expires_at<=now())throw wbError('expired');
    if(issued.preview_digest!==body.preview_digest||issued.state.candidate_id!==body.candidate_id||issued.state.review_id!==body.review_id||issued.state.task_id!==body.task_id)throw wbError('stale_resource');
    const current=await inspect(body),candidate=current.candidate,review=current.review;
    const checked=await snapshot({workspace_id:body.workspace_id,project_id:body.project_id,task_id:body.task_id,candidate_id:body.candidate_id,review_id:body.review_id},{retainStage:true});
    if(checked.preview_digest!==issued.preview_digest||candidate.hash!==issued.state.candidate_hash||review.review_identity!==issued.state.review_identity){rm(checked[ROUNDTRIP]);throw wbError('stale_resource');}
    previews.delete(body.preview_id);
    let intent;
    try{
      intent=data.create('patches',{workspace_id:body.workspace_id,project_id:body.project_id,task_id:body.task_id,candidate_id:body.candidate_id,candidate_hash:issued.state.candidate_hash,candidate_generation:issued.state.candidate_generation,review_id:body.review_id,review_identity:issued.state.review_identity,preview_id:body.preview_id,preview_digest:body.preview_digest,op_id:body.op_id,status:'preparing',artifact_hash:sha(issued.patch),bytes:issued.patch.length,format:'git-unified-diff',source:issued.state.source,candidate:issued.state.candidate,review:issued.state.review,changes:issued.state.changes,exclusions:issued.state.exclusions,unsupported:[],roundtrip:issued.state.roundtrip,private_root:path.join(root,`${randomUUID()}.patch`)});
      const fd=fs.openSync(intent.private_root,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,issued.patch);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const dir=fs.openSync(root,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
      if(typeof execution.verifyPatchArtifact!=='function')throw wbError('unavailable');
      const checkedResult=await execution.verifyPatchArtifact({workspace_id:body.workspace_id,project_id:body.project_id,artifact_id:intent.id,stage_root:path.join(checked[ROUNDTRIP],'roundtrip')});
      let current=data.get('patches',body.workspace_id,body.project_id,intent.id);
      if(checkedResult?.verification?.status!=='verified')return {patch:publicPatch(current),idempotent:false};
      assertVerified(current,body);
      const final=await snapshot({workspace_id:body.workspace_id,project_id:body.project_id,task_id:body.task_id,candidate_id:body.candidate_id,review_id:body.review_id});
      if(final.preview_digest!==issued.preview_digest)throw wbError('stale_resource');
      const bytes=artifactBytes(current);if(sha(bytes)!==current.artifact_hash||bytes.length!==current.bytes)throw wbError('stale_resource');
      current=data.get('patches',body.workspace_id,body.project_id,intent.id);
      if(current.status!=='verified')throw wbError('stale_resource');
      const updated=data.update('patches',body.workspace_id,body.project_id,current.id,current.revision,{status:'available'});return {patch:publicPatch(updated),idempotent:false};
    }catch(error){
      if(intent){try{const current=data.get('patches',body.workspace_id,body.project_id,intent.id);if(current.status==='preparing')data.update('patches',body.workspace_id,body.project_id,intent.id,current.revision,{status:'preparation_failed'});}catch{}}
      const concurrent=matchingReplay(body);if(!intent&&concurrent&&sameRequest(concurrent,body))return {patch:publicPatch(concurrent),idempotent:true};
      throw error;
    }finally{rm(checked[ROUNDTRIP]);}
  }
  function getPatch(body){
    scope(body);const record=data.list('patches',body.workspace_id,body.project_id).find(item=>item.id===body.artifact_id);
    if(!record||record.status!=='available'||!isVerifiedPatch(record))throw wbError('permission_denied');
    if(path.resolve(record.private_root)!==record.private_root||path.dirname(record.private_root)!==root||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.patch$/.test(path.basename(record.private_root)))throw wbError('permission_denied');
    const stat=fs.lstatSync(record.private_root);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||stat.size!==record.bytes)throw wbError('stale_resource');
    const patch=fs.readFileSync(record.private_root);if(sha(patch)!==record.artifact_hash||patch.length!==record.bytes)throw wbError('stale_resource');
    const receipt=publicPatch(record),result={artifact_id:record.id,receipt,patch:patch.toString('utf8')};
    if(Buffer.byteLength(JSON.stringify({...result,ok:true}))>RESPONSE_MAX-32)throw wbError('limit_exceeded');
    return result;
  }
  function recoveryView(body,record){
    const state=execution.patchArtifactRecovery({workspace_id:body.workspace_id,project_id:body.project_id,artifact_id:record.id});
    return {artifact_id:state.artifact_id,status:state.status,verification_status:state.verification_status,recovery_digest:state.recovery_digest,recoverable:state.recoverable,process_owned:state.process_owned};
  }
  function listPatches(body){scope(body);return {patches:data.list('patches',body.workspace_id,body.project_id).map(record=>({...publicPatchSummary(record),recovery:recoveryView(body,record)}))};}
  async function retryFinalization(body){
    scope(body);const before=data.get('patches',body.workspace_id,body.project_id,body.artifact_id);
    const recovery=execution.patchArtifactRecovery({workspace_id:body.workspace_id,project_id:body.project_id,artifact_id:body.artifact_id});
    if(recovery.recovery_digest!==body.expected_digest)throw wbError('stale_resource');
    let current=before;
    if(before.status==='verified')current=await promoteVerified({workspace_id:body.workspace_id,project_id:body.project_id,task_id:before.task_id,candidate_id:before.candidate_id,review_id:before.review_id,preview_id:before.preview_id,preview_digest:before.preview_digest,op_id:before.op_id},before);
    else{
      const result=execution.retryPatchArtifact({workspace_id:body.workspace_id,project_id:body.project_id,artifact_id:body.artifact_id,expected_digest:body.expected_digest});
      current=data.get('patches',body.workspace_id,body.project_id,body.artifact_id);
      if(result.verification?.status==='verified'&&current.status==='verified')current=await promoteVerified({workspace_id:body.workspace_id,project_id:body.project_id,task_id:before.task_id,candidate_id:before.candidate_id,review_id:before.review_id,preview_id:before.preview_id,preview_digest:before.preview_digest,op_id:before.op_id},current);
    }
    return {patch:publicPatch(current),recovery:recoveryView(body,current),idempotent:false};
  }
  function acknowledgeUnknown(body){
    scope(body);execution.acknowledgePatchArtifactUnknown({workspace_id:body.workspace_id,project_id:body.project_id,artifact_id:body.artifact_id,expected_digest:body.expected_digest,known_externally_terminated:body.known_externally_terminated});
    const patch=data.get('patches',body.workspace_id,body.project_id,body.artifact_id);return {patch:publicPatch(patch),recovery:recoveryView(body,patch)};
  }
  function cancelCheck(body){
    scope(body);const result=execution.cancelPatchArtifact({workspace_id:body.workspace_id,project_id:body.project_id,artifact_id:body.artifact_id}),patch=data.get('patches',body.workspace_id,body.project_id,body.artifact_id);return {patch:publicPatch(patch),recovery:recoveryView(body,patch),cancellation:result};
  }
  async function dispatch(body){
    if(!validatePatchRequest(body))return null;
    if(body.action==='patch_preview')return preview(body);
    if(body.action==='patch_export'){
      const key=`${body.workspace_id}:${body.project_id}:${body.op_id}`,fingerprint=JSON.stringify([body.workspace_id,body.project_id,body.task_id,body.candidate_id,body.review_id,body.preview_id,body.preview_digest,body.op_id]),active=exportFlights.get(key);
      if(active){if(active.fingerprint!==fingerprint)throw wbError('conflict');return active.promise;}
      const promise=exportPatch(body);exportFlights.set(key,{fingerprint,promise});
      try{return await promise;}finally{if(exportFlights.get(key)?.promise===promise)exportFlights.delete(key);}
    }
    if(body.action==='private_patch_get')return getPatch(body);
    if(body.action==='patch_list')return listPatches(body);
    if(body.action==='patch_finalize_retry')return retryFinalization(body);
    if(body.action==='patch_acknowledge_unknown')return acknowledgeUnknown(body);
    if(body.action==='patch_check_cancel')return cancelCheck(body);
    return null;
  }
  return {dispatch};
}
