// Durable file-backed immutable drafts/proposals; atomic installs/revocations use
// the existing SQLite command/receipt/checkpoint transaction. Schema 11 fences
// older writers that cannot enforce release revocations; no new tables.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import {studioSchema,STUDIO_PROFILE} from '../contracts/extension-studio-v1.mjs';
import {focusTimerArtifact,bundleDigest,hash} from './extension-studio-artifact.mjs';
import {canonicalJson,commandIdentity} from './command-identity.mjs';
import {applyOperation} from '../src/workspace-ops.ts';
import {pluginSelector} from '../src/plugins.ts';
import {wbError} from './workbench-store.mjs';

const valid=new Ajv({strict:true}).compile(studioSchema),execute=promisify(execFile);
const digest=value=>hash(canonicalJson(value));
const permissions=Object.freeze({host:[],network:false,storage:false,model:false});
export function createExtensionStudio({store,now=Date.now}){
  const root=path.join(store.root,'extension-studio');
  const publisher=fileURLToPath(new URL('../scripts/plugin_publish.py',import.meta.url));
  function directory(workspace){
    for(const dir of [root,path.join(root,workspace)]){
      if(fs.existsSync(dir)&&(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink()))throw wbError('unavailable');
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
    }
    return path.join(root,workspace);
  }
  function load(workspace,key){
    const file=path.join(directory(workspace),key+'.json');
    if(!fs.existsSync(file))throw wbError('unavailable');
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256000)throw wbError('unavailable');
    return JSON.parse(fs.readFileSync(file,'utf8'));
  }
  function persist(workspace,key,value){
    const dir=directory(workspace),file=path.join(dir,key+'.json');
    const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>256000)throw wbError('limit_exceeded');
    const temporary=path.join(dir,'.write-'+randomUUID());
    const fd=fs.openSync(temporary,'wx',0o600);
    try{
      fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);
      try{fs.linkSync(temporary,file);const directoryFd=fs.openSync(dir,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}return value;}
      catch(error){if(error.code!=='EEXIST')throw error;const old=load(workspace,key);if(old.request_hash!==value.request_hash)throw wbError('conflict');return old;}
    }finally{try{fs.closeSync(fd);}catch{}fs.rmSync(temporary,{force:true});}
  }
  function bound(workspace,prefix){
    if(fs.readdirSync(directory(workspace)).filter(name=>name.startsWith(prefix)&&name.endsWith('.json')).length>=128)throw wbError('limit_exceeded');
  }
  function current(workspace){return store.read(workspace);}
  function revoked(workspace,entry){return !!store.db.prepare("SELECT 1 FROM receipts WHERE workspace_id=? AND actor='studio-revoke' AND json_extract(result_json,'$.revoked_entry')=? LIMIT 1").get(workspace,entry);}
  function gate(workspace,draft){
    const r=current(workspace);
    if(r.recovery_policy?.held)throw wbError('permission_denied');
    if(draft&&revoked(workspace,draft.manifest.entry))throw wbError('revoked');
    return r;
  }
  function artifact(workspace,id){const d=load(workspace,'draft-'+id);if(d.id!==id||d.workspace_id!==workspace||d.profile!==STUDIO_PROFILE)throw wbError('unavailable');return d;}
  function verify(d){
    const expected=focusTimerArtifact(d.spec);
    if(bundleDigest(expected)!==d.artifact_digest||d.manifest.entry!==`/apps/${d.spec.id}-${d.artifact_digest.slice(0,24)}/index.html`)throw wbError('conflict');
    const slug=d.manifest.entry.split('/')[2];
    for(const [name,bytes] of Object.entries(expected)){
      if(!store.bundles.resolveFile(slug,name).bytes.equals(Buffer.from(bytes)))throw wbError('conflict');
    }
    // Refuse added files too: the exact inventory is part of the digest.
    const dir=path.join(store.root,'apps',slug);
    if(canonicalJson(fs.readdirSync(dir).sort())!==canonicalJson(Object.keys(expected).sort()))throw wbError('conflict');
    return expected;
  }
  function brief(d){return {id:d.id,profile:d.profile,spec:d.spec,manifest:d.manifest,artifact_digest:d.artifact_digest,created_at:d.created_at,permissions,revoked:revoked(d.workspace_id,d.manifest.entry)};}
  async function dispatch(body){
    if(!valid(body))throw wbError('invalid_request');
    const w=body.workspace_id;current(w);
    if(body.action==='list'){
      const drafts=fs.readdirSync(directory(w)).filter(n=>/^draft-[a-f0-9-]+\.json$/.test(n)).map(n=>brief(load(w,n.slice(0,-5)))).sort((a,b)=>b.created_at-a.created_at);
      return {drafts,revision:current(w).revision,recovery_policy:current(w).recovery_policy};
    }
    if(body.action==='draft'){
      gate(w);const key='draft-'+body.operation_id,request_hash=digest(body);
      if(fs.existsSync(path.join(directory(w),key+'.json'))){const d=load(w,key);if(d.request_hash!==request_hash)throw wbError('conflict');return {draft:brief(d)};}
      bound(w,'draft-');
      const files=focusTimerArtifact(body.spec),artifact_digest=bundleDigest(files),staging=fs.mkdtempSync(path.join(directory(w),'.stage-'));
      try{
        for(const [name,bytes] of Object.entries(files))fs.writeFileSync(path.join(staging,name),bytes,{mode:0o600});
        const result=await execute('python3',[publisher,staging,'--id',body.spec.id,'--version',body.spec.version,'--title',body.spec.title,'--runtime',store.root],{env:{PATH:process.env.PATH},timeout:30000,maxBuffer:65536});
        const manifest=JSON.parse(result.stdout);gate(w);
        const d=persist(w,key,{id:body.operation_id,workspace_id:w,request_hash,profile:STUDIO_PROFILE,spec:body.spec,manifest,artifact_digest,created_at:now()});
        verify(d);return {draft:brief(d)};
      }finally{fs.rmSync(staging,{recursive:true,force:true});}
    }
    if(body.action==='get'){
      const d=artifact(w,body.draft_id);gate(w,d);return {draft:brief(d),files:verify(d)};
    }
    if(body.action==='check'){
      const d=artifact(w,body.draft_id),r=gate(w,d);const files=verify(d);
      const report={profile:STUDIO_PROFILE,artifact_digest:d.artifact_digest,checks:['Exact generated bytes and three-file inventory','Escaped title and bounded timer settings','Network/storage/host-free finite template'],kind:'structural',runtime_tested:false,passed:true};
      report.digest=digest(report);
      persist(w,'check-'+d.id,{request_hash:d.artifact_digest,report});
      return {report,files,preview_config:r.state.plugins?.find(p=>p.manifest.id===d.manifest.id)?.config??{}};
    }
    if(body.action==='preview'){
      const d=artifact(w,body.draft_id),r=gate(w,d);verify(d);
      const {report}=load(w,'check-'+d.id);if(!report.passed||report.artifact_digest!==d.artifact_digest)throw wbError('conflict');
      const key='proposal-'+body.operation_id,request_hash=digest(body);
      if(fs.existsSync(path.join(directory(w),key+'.json'))){const p=load(w,key);if(p.request_hash!==request_hash)throw wbError('conflict');return {proposal:publicProposal(p)};}
      bound(w,'proposal-');
      const old=r.state.plugins?.find(p=>p.manifest.id===d.manifest.id);
      if(old?.backendEndpoint)throw wbError('unsupported');
      let state=applyOperation(r.state,old?{action:'plugin_update',plugin_id:d.manifest.id,manifest:d.manifest}:{action:'plugin_install',manifest:d.manifest});
      if(!old)state=applyOperation(state,{action:'plugin_enable',plugin_id:d.manifest.id});
      const p={id:body.operation_id,workspace_id:w,draft_id:d.id,request_hash,artifact_digest:d.artifact_digest,report_digest:report.digest,base_revision:r.revision,policy_generation:r.recovery_policy?.generation??0,expires_at:now()+60000,state,preview_config:old?.config??{},summary:old?'Replace the pinned release; retain configuration, window identity and enabled state.':'Install and open one new sandboxed focus-timer window.',previous_manifest:old?.manifest??null};
      p.preview_digest=digest(p);persist(w,key,p);return {proposal:publicProposal(p)};
    }
    if(body.action==='install'){
      const p=load(w,'proposal-'+body.proposal_id),d=artifact(w,p.draft_id);
      if(p.preview_digest!==body.preview_digest||p.artifact_digest!==body.artifact_digest)throw wbError('conflict');
      const {preview_digest,...unsigned}=p;if(digest(unsigned)!==preview_digest)throw wbError('conflict');
      const command=commandIdentity({...body,base_revision:p.base_revision,intent:'Install exact reviewed Studio artifact'},'studio');
      const result=store.commit(command,{
        authorize:r=>{gate(w,d);verify(d);if((r?.recovery_policy?.generation??0)!==p.policy_generation)throw wbError('stale_resource');return true;},
        apply:()=>{if(now()>p.expires_at)throw wbError('expired');return structuredClone(p.state);},
        checkpointLabel:'Before Studio release install',
        response:(r,c)=>({revision:r.revision,artifact_digest:d.artifact_digest,manifest:d.manifest,checkpoint_id:c.id,operation_id:body.operation_id}),
      });
      return {...result.result,replayed:result.replayed};
    }
    if(body.action==='revoke'){
      const d=artifact(w,body.draft_id);
      const result=store.commit(commandIdentity({...body,intent:'Revoke Studio release'},'studio-revoke'),{
        apply:r=>{let state=r.state;for(const p of state.plugins??[])if(p.manifest.entry===d.manifest.entry)state=applyOperation(state,{action:'plugin_disable',...pluginSelector(p)});return state;},
        checkpointLabel:'Before Studio release revocation',
        response:r=>({revision:r.revision,revoked_entry:d.manifest.entry,artifact_digest:d.artifact_digest,operation_id:body.operation_id}),
      });return {...result.result,replayed:result.replayed};
    }
    throw wbError('invalid_request');
  }
  function publicProposal(p){return {id:p.id,draft_id:p.draft_id,base_revision:p.base_revision,artifact_digest:p.artifact_digest,preview_digest:p.preview_digest,report_digest:p.report_digest,expires_at:p.expires_at,summary:p.summary,previous_manifest:p.previous_manifest,preview_config:p.preview_config};}
  const lanes=new Map();
  return {dispatch:body=>{
    if(!valid(body))return Promise.reject(wbError('invalid_request'));
    const w=body.workspace_id,previous=lanes.get(w)??Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{try{return await dispatch(body);}catch(error){if(error.category)throw wbError(['REVISION_CONFLICT','RECOVERY_POLICY_CHANGED'].includes(error.category)?'stale_resource':'conflict');if(error.code?.startsWith('SQLITE_'))throw wbError('busy');throw error;}});
    lanes.set(w,task);void task.finally(()=>{if(lanes.get(w)===task)lanes.delete(w);}).catch(()=>{});return task;
  }};
}
