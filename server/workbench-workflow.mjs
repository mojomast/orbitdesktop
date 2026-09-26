import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import Ajv from 'ajv';
import {wbError} from './workbench-store.mjs';
import {captureProject,readProjectFile,repositorySnapshot} from './project-files.mjs';
import {readCandidateFile} from './workbench-candidates.mjs';
import {applyOperation} from '../src/workspace-ops.ts';
import {validate} from '../src/model.ts';
import {commandIdentity} from './command-identity.mjs';
import {patchRequests,validatePatchRequest} from '../contracts/workbench-result-v1.mjs';
import {createWorkbenchPatchExport} from './workbench-patch-export.mjs';

const uuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const base={workspace_id:uuid,project_id:uuid};
const request=(action,fields={})=>({type:'object',properties:{...base,action:{const:action},...fields},required:[...Object.keys(base),'action',...Object.keys(fields)],additionalProperties:false});
export const workflowSchema={$schema:'http://json-schema.org/draft-07/schema#',oneOf:[
  request('integration_preview',{candidate_id:uuid,review_id:uuid}),
  request('integrate_confirm',{candidate_id:uuid,review_id:uuid,preview_id:uuid,preview_digest:hash,op_id:uuid}),
  request('integration_list'),request('retention_inventory'),request('retention_plan'),
  request('recipe_preview',{recipe:{enum:['project_focus','investigate','implement','review','return']}}),
  request('recipe_apply',{recipe:{enum:['project_focus','investigate','implement','review','return']},preview_id:uuid,preview_digest:hash,op_id:uuid}),
  ...Object.values(patchRequests),
]};
const valid=new Ajv({strict:true}).compile(workflowSchema);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>sha(JSON.stringify(value));
const TTL=60000;
const gitEnv={PATH:'/usr/bin:/bin',HOME:'/dev/null',XDG_CONFIG_HOME:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_AUTHOR_NAME:'Orbit Workbench',GIT_AUTHOR_EMAIL:'workbench@localhost',GIT_COMMITTER_NAME:'Orbit Workbench',GIT_COMMITTER_EMAIL:'workbench@localhost'};
function git(root,...args){return execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-c','core.fsmonitor=false','-C',root,...args],{env:gitEnv,timeout:10000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).toString('utf8').trim();}
const publicIntegration=({private_root,...record})=>({...record,artifact_path:private_root});

export function createWorkbenchWorkflow({store,records,data,execution,now=Date.now}){
  if(!path.isAbsolute(store?.root??'')||!records?.project||!data?.db||!execution?.dispatch)throw Error('Workbench workflow dependencies required');
  const root=path.join(store.root,'workbench-integration');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const previews=new Map(),previousArrangements=new Map();
  const patchExport=createWorkbenchPatchExport({store,records,data,execution,inspect:actual,now});
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
      return {path:file.path,hash:file.hash,bytes:file.bytes};
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
      fs.writeFileSync(destination,bytes,{flag:'wx',mode:0o600});
    }
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
    const intent=data.create('integrations',{workspace_id:body.workspace_id,project_id:body.project_id,project_generation:project.generation,candidate_id:candidate.id,candidate_hash:candidate.hash,review_id:review.id,review_identity:review.review_identity,source_hash:source.hash,source_head,preview_digest:body.preview_digest,op_id:body.op_id,status:'preparing',private_root:destination,staging_root:staging,branch:`comet/integration-${name}`,artifact_kind:'independent_private_git_repository'});
    let published=false;
    try{
      fs.mkdirSync(staging,{mode:0o700});
      git(staging,'init','--quiet','--initial-branch',`comet/integration-${name}`);
      materialize(staging,source.manifest,file=>readProjectFile(project,file.path).bytes);
      git(staging,'add','--all');git(staging,'commit','--quiet','-m','Captured approved source base');
      const base_commit=git(staging,'rev-parse','HEAD');
      for(const file of source.manifest)fs.unlinkSync(path.join(staging,file.path));
      materialize(staging,files,file=>{
        const observed=readCandidateFile(store,candidate,file.path);
        if(observed.hash!==file.hash)stale();
        return readProjectFile({root:candidate.root,identity:`${fs.statSync(candidate.root).dev}:${fs.statSync(candidate.root).ino}`},file.path).bytes;
      });
      git(staging,'add','--all');git(staging,'commit','--quiet','--allow-empty','-m',`Reviewed candidate ${candidate.id}`);
      const candidate_commit=git(staging,'rev-parse','HEAD');
      // Revalidate both trees immediately before making the branch visible.
      const final=await actual(body);
      if(final.source.hash!==source.hash||final.source_head!==source_head||final.candidate.hash!==candidate.hash||final.review.review_identity!==review.review_identity)stale();
      if(data.list('integrations',body.workspace_id,body.project_id).some(item=>item.id!==intent.id&&(item.op_id===body.op_id||item.candidate_id===candidate.id&&item.candidate_hash===candidate.hash&&item.status==='integrated')))stale();
      fs.renameSync(staging,destination);published=true;
      const integration=data.update('integrations',body.workspace_id,body.project_id,intent.id,intent.revision,{status:'integrated',base_commit,candidate_commit,published_at:now()});
      return {integration:publicIntegration(integration),idempotent:false};
    }catch(error){
      // Once renamed, retain the artifact for explicit recovery, never silently
      // report a successful integration when the durable receipt failed.
      try{data.update('integrations',body.workspace_id,body.project_id,intent.id,intent.revision,{status:published?'receipt_pending':'preparation_failed',recovery_note:'Inspect the retained private stage/artifact. Retrying this operation only reads its receipt and never republishes.'});}catch{}
      throw error;
    }
  }
  function recipePreview(body){
    const project=scope(body),workspace=store.read(body.workspace_id);
    const bindings=records.bindings(body.workspace_id,body.project_id);
    const monitorIds=new Set();
    for(const binding of bindings){
      const monitor=workspace.state.monitors.find(m=>{
        const visit=node=>node.type==='pane'?node.pane.id===binding.pane_id:visit(node.first)||visit(node.second);
        return visit(m.layout);
      });
      if(monitor)monitorIds.add(monitor.id);
    }
    if(!monitorIds.size)throw wbError('unsupported');
    const ids=workspace.state.monitors.map(m=>m.id);
    const key=`${body.workspace_id}:${body.project_id}`;
    const saved=previousArrangements.get(key);
    if(body.recipe==='return'&&(!saved||saved.applied_revision!==workspace.revision||saved.ids.length!==ids.length||saved.ids.some(id=>!ids.includes(id))))stale();
    const roles={investigate:['primary_agent','project_files','active_terminal','preview'],implement:['primary_agent','candidate_diff','job_output','project_files'],review:['candidate_diff','job_output','project_files','primary_agent'],project_focus:[]};
    const priorities=roles[body.recipe]??[];
    const priority=id=>{const monitor=workspace.state.monitors.find(m=>m.id===id);const panes=new Set();const visit=node=>node.type==='pane'?panes.add(node.pane.id):(visit(node.first),visit(node.second));visit(monitor.layout);return Math.min(99,...bindings.filter(b=>panes.has(b.pane_id)).map(b=>{const index=priorities.indexOf(b.role);return index<0?99:index;}));};
    const next=body.recipe==='return'?saved.ids:[...ids.filter(id=>monitorIds.has(id)).sort((a,b)=>priority(a)-priority(b)),...ids.filter(id=>!monitorIds.has(id))];
    const operations=[{action:'reorder_windows',window_ids:next}];
    const state=validate(applyOperation(workspace.state,operations[0]));
    const identity={workspace_id:body.workspace_id,project_id:body.project_id,project_generation:project.generation,recipe:body.recipe,base_revision:workspace.revision,bindings:bindings.map(b=>b.id),operations,previous_ids:ids};
    const preview_id=randomUUID(),preview_digest=digest(identity),expires_at=now()+TTL;
    previews.set(preview_id,{identity,preview_digest,expires_at});
    return {preview_id,preview_digest,expires_at,base_revision:workspace.revision,operations,changed:JSON.stringify(state)!==JSON.stringify(workspace.state),warning:'Explicit workspace revision CAS. Reorders existing windows only; pane IDs and contents stay the same. Browser continuity depends on native moveBefore support.'};
  }
  function recipeApply(body){
    const issued=previews.get(body.preview_id);if(!issued||issued.expires_at<=now())throw wbError('expired');
    const identity=issued.identity;
    if(issued.preview_digest!==body.preview_digest||identity.workspace_id!==body.workspace_id||identity.project_id!==body.project_id||identity.recipe!==body.recipe)stale();
    const project=scope(body),current=store.read(body.workspace_id);
    if(current.revision!==identity.base_revision||project.generation!==identity.project_generation||JSON.stringify(records.bindings(body.workspace_id,body.project_id).map(b=>b.id))!==JSON.stringify(identity.bindings))stale();
    const command={workspace_id:body.workspace_id,action:'apply',operations:identity.operations,base_revision:identity.base_revision,operation_id:body.op_id};
    const receipt=store.commit(commandIdentity(command,'owner'),{apply:value=>validate(applyOperation(value.state,identity.operations[0])),checkpointLabel:`Before ${body.recipe} recipe`,response:next=>({workspace_id:next.id,revision:next.revision,state:next.state})});
    const key=`${body.workspace_id}:${body.project_id}`;
    if(body.recipe!=='return')previousArrangements.set(key,{ids:identity.previous_ids,applied_revision:receipt.result.revision});
    else previousArrangements.delete(key);
    previews.delete(body.preview_id);
    return {workspace:receipt.result,recipe:body.recipe};
  }
  function inventory(body){
    scope(body);
    const counts={};for(const kind of ['tasks','attempts','candidates','profiles','jobs','evidence','reviews','integrations','contexts','submissions','grants','toolcalls'])counts[kind]=data.list(kind,body.workspace_id,body.project_id).length;
    const integrations=data.list('integrations',body.workspace_id,body.project_id).map(publicIntegration);
    const jobs=data.list('jobs',body.workspace_id,body.project_id),reviews=data.list('reviews',body.workspace_id,body.project_id),calls=data.list('toolcalls',body.workspace_id,body.project_id);
    const metrics={basis:'Current retained authoritative records; baseline counts, not SLOs or lifetime totals',jobs:jobs.length,passed_checks:data.list('evidence',body.workspace_id,body.project_id).filter(e=>e.verdict==='pass').length,accepted_reviews:reviews.filter(r=>r.decision==='approved').length,unknown_jobs:jobs.filter(j=>j.status==='outcome_unknown'||j.status==='finalization_pending').length,native_tool_calls:calls.length,denied_or_failed_tool_calls:calls.filter(c=>c.status==='failed').length,duplicate_external_dispatch_incidents:null,lost_session_incidents:null,token_usage:null,cost:null};
    return {counts,integrations,metrics,policy:'Inventory only. Candidate trees, evidence, receipts, source files, active jobs and unknown records are never removed by this endpoint.'};
  }
  async function dispatch(body){
    if(validatePatchRequest(body))return patchExport.dispatch(body);
    if(!valid(body))throw wbError('invalid_request');
    switch(body.action){
      case 'integration_preview':return integrationPreview(body);
      case 'integrate_confirm':return confirm(body);
      case 'integration_list':return {integrations:data.list('integrations',body.workspace_id,body.project_id).map(publicIntegration)};
      case 'retention_inventory':return inventory(body);
      case 'retention_plan':return {...inventory(body),deletions:[],requires_explicit_cleanup:true,reason:'No automated deletion is safe while references, active jobs and unknown outcomes can exist.'};
      case 'recipe_preview':return recipePreview(body);
      case 'recipe_apply':return recipeApply(body);
    }
  }
  return {dispatch};
}
