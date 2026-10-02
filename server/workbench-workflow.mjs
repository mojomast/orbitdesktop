import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import Ajv from 'ajv';
import {wbError} from './workbench-store.mjs';
import {captureProject,readProjectFile,repositorySnapshot} from './project-files.mjs';
import {readCandidateFile} from './workbench-candidates.mjs';
import {patchRequests,validatePatchRequest} from '../contracts/workbench-result-v1.mjs';
import {arrangementRequests} from '../contracts/workbench-workflow-v1.mjs';
import {createWorkbenchPatchExport} from './workbench-patch-export.mjs';
import {createWorkspaceArrangements} from './workspace-arrangements.mjs';
import {WORKBENCH_RECORD_KINDS} from './workbench-data.mjs';
import {publicationManifest,flushDirectory} from './workbench-publication.mjs';
import {createWorkbenchStatus} from './workbench-status.mjs';

const uuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const base={workspace_id:uuid,project_id:uuid};
const request=(action,fields={})=>({type:'object',properties:{...base,action:{const:action},...fields},required:[...Object.keys(base),'action',...Object.keys(fields)],additionalProperties:false});
export const workflowSchema={$schema:'http://json-schema.org/draft-07/schema#',oneOf:[
  request('integration_preview',{candidate_id:uuid,review_id:uuid}),
  request('integrate_confirm',{candidate_id:uuid,review_id:uuid,preview_id:uuid,preview_digest:hash,op_id:uuid}),
  request('integration_finalize_retry',{integration_id:uuid,expected_recovery_digest:hash}),
  request('task_status_snapshot'),request('task_status_read',{task_id:uuid,expected_notification_id:hash}),
  request('integration_list'),request('retention_inventory'),request('retention_plan'),
  ...Object.values(arrangementRequests),
  ...Object.values(patchRequests),
]};
const valid=new Ajv({strict:true}).compile(workflowSchema);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>sha(JSON.stringify(value));
const TTL=60000;
const gitEnv={PATH:'/usr/bin:/bin',HOME:'/dev/null',XDG_CONFIG_HOME:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_AUTHOR_NAME:'Orbit Workbench',GIT_AUTHOR_EMAIL:'workbench@localhost',GIT_COMMITTER_NAME:'Orbit Workbench',GIT_COMMITTER_EMAIL:'workbench@localhost'};
function git(root,...args){return execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','core.fsmonitor=false','-C',root,...args],{env:gitEnv,timeout:10000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).toString('utf8').trim();}
function gitInput(root,args,input){return execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','core.fsmonitor=false','-C',root,...args],{env:gitEnv,timeout:10000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe'],input}).toString('utf8').trim();}
const publicIntegration=({private_root,publication,...record})=>({...record,artifact_path:private_root});
const modeOf=(root,pathValue)=>{const stat=fs.lstatSync(path.join(root,pathValue));if(!stat.isFile()||stat.isSymbolicLink())stale();return (stat.mode&0o111)?'100755':'100644';};

export function createWorkbenchWorkflow({store,records,data,execution,now=Date.now}){
  if(!path.isAbsolute(store?.root??'')||!records?.project||!data?.db||!execution?.dispatch)throw Error('Workbench workflow dependencies required');
  const root=path.join(store.root,'workbench-integration');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const previews=new Map();
  const patchExport=createWorkbenchPatchExport({store,records,data,execution,inspect:actual,now});
  const arrangements=createWorkspaceArrangements({store,records,data,now});
  const status=createWorkbenchStatus({data,recordedAcceptance:execution.recordedAcceptance,now});
  const scope=body=>{store.read(body.workspace_id);return records.project(body.workspace_id,body.project_id);};
  const stale=()=>{throw wbError('stale_resource');};
  async function actual(body){
    const project=scope(body),candidate=data.get('candidates',body.workspace_id,body.project_id,body.candidate_id),review=data.get('reviews',body.workspace_id,body.project_id,body.review_id);
    const result=await execution.dispatch({action:'candidate_get',workspace_id:body.workspace_id,project_id:body.project_id,candidate_id:body.candidate_id});
    // candidate_get is a synchronous execution read. Never trust a persisted hash
    // alone: read and hash EVERY file, and reject unexpected private tree entries.
    if(result.target_changed||candidate.hash!==result.candidate.hash||candidate.project_generation!==project.generation||review.decision!=='approved'||review.candidate_id!==candidate.id||review.candidate_hash!==candidate.hash||review.review_identity!==result.review_identity)stale();
    const evidence=data.list('evidence',body.workspace_id,body.project_id);
    if(!review.evidence_ids?.length||review.evidence_ids.some(id=>!evidence.some(e=>e.id===id&&e.candidate_id===candidate.id&&e.verdict==='pass'&&!e.superseded&&!e.revoked&&e.candidate_hash_after===candidate.hash&&e.project_generation===project.generation)))stale();
    const source=captureProject(project);
    if(source.hash!==candidate.source_manifest_hash||source.limited||candidate.limited)stale();
    const hasGit=project.git_mapping||fs.existsSync(path.join(project.root,'.git'));
    const repository=hasGit?await repositorySnapshot(project,source,{scratchRoot:path.join(store.root,'workbench-integration','scratch')}):null;
    if(hasGit&&repository?.state!=='available')throw wbError('unsupported');
    if(hasGit&&digest(review.source_repository??null)!==digest({head:repository.head,head_reference:repository.head_reference}))stale();
    const captured=captureProject({root:candidate.root,identity:`${fs.statSync(candidate.root).dev}:${fs.statSync(candidate.root).ino}`});
    if(captured.limited||captured.files.length!==candidate.files.length||captured.exclusions.length!==candidate.exclusions.length||captured.files.some(file=>!candidate.files.some(entry=>entry.path===file.path&&entry.hash===file.hash&&entry.bytes===file.bytes.length)))stale();
    // Capture exclusions include intentionally private/excluded source files; the
    // artifact is explicitly a bounded captured tree, not a full repo mirror.
    const files=candidate.files.map(file=>{
      const read=readCandidateFile(store,candidate,file.path);
      if(read.hash!==file.hash||read.bytes!==file.bytes)stale();
       return {path:file.path,hash:file.hash,bytes:file.bytes,mode:modeOf(candidate.root,file.path)};
    });
    return {project,candidate,review,source,files,source_head:repository?.head??null};
  }
  async function integrationPreview(body){
    const {project,candidate,review,source,files,source_head}=await actual(body);
    if(data.list('integrations',body.workspace_id,body.project_id).some(item=>item.candidate_id===candidate.id&&item.candidate_hash===candidate.hash&&item.status==='integrated'))stale();
    const identity={version:1,workspace_id:body.workspace_id,project_id:body.project_id,project_generation:project.generation,candidate_id:candidate.id,candidate_hash:candidate.hash,review_id:review.id,review_identity:review.review_identity,source_hash:source.hash,source_head,files,source_files:source.manifest};
    const preview_digest=digest(identity),preview_id=randomUUID(),expires_at=now()+TTL;
    previews.set(preview_id,{identity,preview_digest,expires_at});
    if(previews.size>64)for(const [key,value] of previews)if(value.expires_at<=now()||previews.size>64)previews.delete(key);
    return {preview_id,preview_digest,expires_at,source_hash:source.hash,source_head,candidate_hash:candidate.hash,files,source_files:source.manifest,excluded_paths:source.exclusions,artifact_kind:'independent_private_git_repository',warning:'Creates a separate private Git repository with a captured-source base commit and reviewed-candidate branch commit. It does not share ancestry with the original repository. Excluded paths are not included; the original repository is untouched.'};
  }
  function materialize(folder,manifest,read){
    for(const entry of manifest){
      const destination=path.join(folder,entry.path);
      fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
      const bytes=read(entry);
      if(sha(bytes)!==entry.hash||bytes.length!==entry.bytes)stale();
      fs.writeFileSync(destination,bytes,{flag:'wx',mode:entry.mode==='100755'?0o700:0o600});
    }
  }
  // Build the Git index from the explicit captured manifest. This bypasses
  // .gitignore and .gitattributes, so repository metadata cannot silently
  // omit, transform, or reclassify reviewed bytes during private integration.
  function commitManifest(folder,manifest,read,message,parent){
    git(folder,'read-tree','--empty');
    const expected=new Map();
    for(const file of manifest){
      const bytes=read(file);if(sha(bytes)!==file.hash||bytes.length!==file.bytes)stale();
      const oid=gitInput(folder,['hash-object','-w','--stdin','--no-filters'],bytes);
      git(folder,'update-index','--add','--cacheinfo',`${file.mode??'100644'},${oid},${file.path}`);
      expected.set(file.path,`${file.mode??'100644'} blob ${oid}`);
    }
    const tree=git(folder,'write-tree'),args=['commit-tree',tree];if(parent)args.push('-p',parent);args.push('-m',message);
    const commit=git(folder,...args),branch=git(folder,'symbolic-ref','HEAD');git(folder,'update-ref',branch,commit);
    const actual=git(folder,'ls-tree','-r','-z','--full-tree',commit).split('\0').filter(Boolean).map(row=>{const [meta,name]=row.split('\t');return {meta,path:name};});
    if(actual.length!==expected.size||actual.some(entry=>expected.get(entry.path)!==entry.meta))stale();
    return commit;
  }
  async function confirm(body){
    scope(body);
    const existing=data.list('integrations',body.workspace_id,body.project_id).find(item=>item.op_id===body.op_id);
    if(existing){if(existing.preview_digest!==body.preview_digest||existing.candidate_id!==body.candidate_id||existing.review_id!==body.review_id)throw wbError('stale_resource');return {integration:publicIntegration(existing),idempotent:true};}
    const issued=previews.get(body.preview_id);
    if(!issued||issued.expires_at<=now())throw wbError('expired');
    if(issued.preview_digest!==body.preview_digest||issued.identity.workspace_id!==body.workspace_id||issued.identity.project_id!==body.project_id||issued.identity.candidate_id!==body.candidate_id||issued.identity.review_id!==body.review_id)stale();
    const {project,candidate,review,source,files,source_head}=await actual(body);
    const concurrent=data.list('integrations',body.workspace_id,body.project_id).find(item=>item.op_id===body.op_id||item.candidate_id===candidate.id&&item.candidate_hash===candidate.hash&&item.status==='integrated');
    if(concurrent)stale();
    const identity={version:1,workspace_id:body.workspace_id,project_id:body.project_id,project_generation:project.generation,candidate_id:candidate.id,candidate_hash:candidate.hash,review_id:review.id,review_identity:review.review_identity,source_hash:source.hash,source_head,files,source_files:source.manifest};
    if(digest(identity)!==issued.preview_digest)stale();
    previews.delete(body.preview_id);
    const name=randomUUID(),staging=path.join(root,`.staging-${name}`),destination=path.join(root,name);
    let intent=data.create('integrations',{workspace_id:body.workspace_id,project_id:body.project_id,project_generation:project.generation,candidate_id:candidate.id,candidate_hash:candidate.hash,review_id:review.id,review_identity:review.review_identity,source_hash:source.hash,source_head,preview_digest:body.preview_digest,op_id:body.op_id,status:'preparing',private_root:destination,staging_root:staging,branch:`comet/integration-${name}`,artifact_kind:'independent_private_git_repository'});
    let published=false;
    try{
      fs.mkdirSync(staging,{mode:0o700});
      git(staging,'init','--quiet','--initial-branch',`comet/integration-${name}`);
      const sourceFiles=source.manifest.map(file=>({...file,mode:modeOf(project.root,file.path)}));
      materialize(staging,sourceFiles,file=>readProjectFile(project,file.path).bytes);
      const base_commit=commitManifest(staging,sourceFiles,file=>readProjectFile(project,file.path).bytes,'Captured approved source base');
      for(const file of source.manifest)fs.unlinkSync(path.join(staging,file.path));
      materialize(staging,files,file=>{
        const observed=readCandidateFile(store,candidate,file.path);
        if(observed.hash!==file.hash)stale();
        return readProjectFile({root:candidate.root,identity:`${fs.statSync(candidate.root).dev}:${fs.statSync(candidate.root).ino}`},file.path).bytes;
      });
      const candidate_commit=commitManifest(staging,files,file=>{
        const observed=readCandidateFile(store,candidate,file.path);
        if(observed.hash!==file.hash)stale();
        return readProjectFile({root:candidate.root,identity:`${fs.statSync(candidate.root).dev}:${fs.statSync(candidate.root).ino}`},file.path).bytes;
      },`Reviewed candidate ${candidate.id}`,base_commit);
      // Revalidate both trees immediately before making the branch visible.
      const final=await actual(body);
      if(final.source.hash!==source.hash||final.source_head!==source_head||final.candidate.hash!==candidate.hash||final.review.review_identity!==review.review_identity)stale();
      if(data.list('integrations',body.workspace_id,body.project_id).some(item=>item.id!==intent.id&&(item.op_id===body.op_id||item.candidate_id===candidate.id&&item.candidate_hash===candidate.hash&&item.status==='integrated')))stale();
      // Persist exact byte/commit identity before rename. Both sides of the
      // rename/receipt crash window are now distinguishable without republishing.
      const publication={version:1,integration_id:intent.id,op_id:body.op_id,preview_digest:body.preview_digest,base_commit,candidate_commit,manifest:publicationManifest(staging,{flush:true})};
      intent=data.update('integrations',body.workspace_id,body.project_id,intent.id,intent.revision,{status:'receipt_pending',publication,recovery_digest:digest(publication)});
      fs.renameSync(staging,destination);published=true;flushDirectory(root);
      const integration=data.update('integrations',body.workspace_id,body.project_id,intent.id,intent.revision,{status:'integrated',base_commit,candidate_commit,published_at:now()});
      return {integration:publicIntegration(integration),idempotent:false};
    }catch(error){
      // Once renamed, retain the artifact for explicit recovery, never silently
      // report a successful integration when the durable receipt failed.
      try{data.update('integrations',body.workspace_id,body.project_id,intent.id,intent.revision,{status:published||intent.publication?'receipt_pending':'preparation_failed',recovery_note:'Explicit finalization verifies the published byte identity and only updates the database. An unpublished stage remains fenced.'});}catch{}
      throw error;
    }
  }
  function finalizeIntegration(body){
    // Historical settlement deliberately does not re-grant revoked authority.
    // It returns metadata only and performs no Git command, rename or execution.
    store.read(body.workspace_id);
    const item=data.get('integrations',body.workspace_id,body.project_id,body.integration_id),p=item.publication;
    if(!p||item.recovery_digest!==body.expected_recovery_digest||digest(p)!==item.recovery_digest||p.integration_id!==item.id||p.op_id!==item.op_id||p.preview_digest!==item.preview_digest)stale();
    if(item.status==='integrated')return {integration_id:item.id,status:item.status,base_commit:item.base_commit,candidate_commit:item.candidate_commit,idempotent:true,historical_only:true};
    if(item.status!=='receipt_pending'||path.dirname(item.private_root)!==root||!/^[-a-f0-9]{36}$/.test(path.basename(item.private_root)))stale();
    let observed;try{observed=publicationManifest(item.private_root);}catch{stale();}
    if(digest(observed)!==digest(p.manifest))stale();
    const settled=data.update('integrations',body.workspace_id,body.project_id,item.id,item.revision,{status:'integrated',base_commit:p.base_commit,candidate_commit:p.candidate_commit,finalized_at:now(),historical_finalization:true});
    return {integration_id:settled.id,status:settled.status,base_commit:settled.base_commit,candidate_commit:settled.candidate_commit,idempotent:false,historical_only:true};
  }
  function inventory(body){
    scope(body);
    const counts={},capacity={};for(const kind of WORKBENCH_RECORD_KINDS){capacity[kind]=data.capacity(kind,body.workspace_id,body.project_id);counts[kind]=capacity[kind].retained;}
    const integrations=data.list('integrations',body.workspace_id,body.project_id).map(publicIntegration);
    const jobs=data.list('jobs',body.workspace_id,body.project_id),reviews=data.list('reviews',body.workspace_id,body.project_id),calls=data.list('toolcalls',body.workspace_id,body.project_id);
    const metrics={basis:'Current retained authoritative records; baseline counts, not SLOs or lifetime totals',jobs:jobs.length,passed_checks:data.list('evidence',body.workspace_id,body.project_id).filter(e=>e.verdict==='pass').length,accepted_reviews:reviews.filter(r=>r.decision==='approved').length,unknown_jobs:jobs.filter(j=>j.status==='outcome_unknown'||j.status==='finalization_pending').length,native_tool_calls:calls.length,denied_or_failed_tool_calls:calls.filter(c=>c.status==='failed').length,duplicate_external_dispatch_incidents:null,lost_session_incidents:null,token_usage:null,cost:null};
    return {counts,capacity,integrations,metrics,policy:'Inventory only. Candidate trees, evidence, receipts, source files, active jobs and unknown records are never removed by this endpoint.'};
  }
  async function dispatch(body){
    if(validatePatchRequest(body))return patchExport.dispatch(body);
    if(!valid(body))throw wbError('invalid_request');
    if(body.action.startsWith('recipe_')||body.action.startsWith('proposal_'))return arrangements.dispatch(body,{actor:'owner'});
    switch(body.action){
      case 'integration_preview':return integrationPreview(body);
      case 'integrate_confirm':return confirm(body);
      case 'integration_finalize_retry':return finalizeIntegration(body);
      case 'task_status_snapshot':case 'task_status_read':scope(body);return status.dispatch(body);
      case 'integration_list':return {integrations:data.list('integrations',body.workspace_id,body.project_id).map(publicIntegration)};
      case 'retention_inventory':return inventory(body);
      case 'retention_plan':return {...inventory(body),deletions:[],requires_explicit_cleanup:true,reason:'No automated deletion is safe while references, active jobs and unknown outcomes can exist.'};
    }
  }
  return {dispatch};
}
