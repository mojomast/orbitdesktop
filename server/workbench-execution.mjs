import path from 'node:path';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import {wbError} from './workbench-store.mjs';
import {captureProject,openProjectRoot,readProjectFile,literalPreview,repositorySnapshot} from './project-files.mjs';
import {previewCandidate,createCandidate,readCandidateFile,applyCandidateChanges,candidateHash as providerCandidateHash,removeCandidateWorkspace} from './workbench-candidates.mjs';
import {CHECK_LIMITS,CHECK_DEFINITIONS,checkDefinition,definitionDigest,checkSpecDigest,discoverTestFiles,runCheck,activeCheckCount,cancelCheck,acknowledgeCheck} from './workbench-checks.mjs';
import {workbenchBuildIdentity} from './workbench-build-identity.mjs';
import {createArtifactVerifier} from './workbench-artifact-verification.mjs';
import {validateWorkbenchProvenance} from '../contracts/workbench-result-v1.mjs';

// Slice C — managed task/candidate/check/evidence/review orchestration for the
// owner-only Comet Project Workbench. WorkbenchData (SQLite) is the authority.
// A private pending-result journal is used only if SQLite cannot stage an
// observed result; it can finalize that exact job, never dispatch a new one.
//
// Boundaries deliberately kept here:
// - Dispatch is strictly serial for the `job` lane (shared gate). A managed job
//   is never dispatched in parallel; an agent conversation and a job may be open
//   at once, only same-kind dispatch is serialized.
// - Approvals are real, process-local, expiring issued previews bound to the
//   project generation, exact task/candidate and acceptance/definition. A caller
//   cannot compute a digest and use it as approval; `candidate_create` and
//   `check_run` require an issued preview and consume it once. `confirm` on the
//   request is never approval proof.
// - A durable `jobs` record with a unique op_id is written BEFORE the check can
//   spawn. If the recorder loses the child, the outcome is `outcome_unknown`,
//   which blocks new checks for that project until the owner acknowledges the
//   exact unknown record (a risk action bound to its digest). Never replayed.
// - The candidate identity is the FULL confined tree (files + exclusions +
//   limits), re-captured before and after the spawn. An injected or removed file
//   makes the run `inconclusive`, never a pass. No caller-supplied root, path or
//   destination is ever accepted.
// - `[WORKSHOP_DONE]` is never parsed and no output string is a verification.
//   Exit status, structured actual test events, and before/after tree hashes
//   produce a verdict. Empty/skipped/TODO-only Node runs cannot pass.
//   Accepting a review is not a merge or deployment.

export const ACCEPTANCE_POLICY='Versioned acceptance: this exact task acceptance (statement + allowlisted check definition digest + pinned required test files/discovery + limits) is frozen before execution. A check whose issued spec does not match the acceptance version and current candidate tree hash is refused. Node checks require complete structured actual test results with substantive passing tests in every required file; zero-exit empty/skipped/TODO-only runs cannot pass. A passing check is recorded evidence, not a merge, deployment or reusable model grant.';
export const CHECK_POLICY='The owner approves one exact allowlisted check definition (fixed executable + argv, no package-script discovery). The check is supervised by a fixed trusted /usr/bin/timeout so the main command has its own wall-time deadline; the recorder measures the real exit status and re-captures the full candidate tree before and after the spawn. A changed or unreadable tree, missing child identity, timeout or revocation yields `inconclusive`, never a pass. HONEST LIMITS: these limits bound the supervised command and the recorder, not arbitrary host resources; they are not CPU, filesystem or network isolation and same-UID processes are not a sandbox. The supervisor bounds the command only while it waits: if the leader exits and a descendant survives its process group, the survivor is not killed (a reused PGID must never be signalled) and the evidence is marked process_survival_unknown with an inconclusive verdict, never a pass.';
export const SUBMISSION_NOTE='Owner-pasted proposed patch (kind patch_proposal). There is no secure Hermes runtime binding for reusable agent file tools yet, so this is not agent-authored and not verified. Apply each file through the candidate edit API with its expected hash; the recorder still decides the check verdict.';
export const EXECUTION_POLICY='Managed jobs run one at a time under the shared serial gate. Evidence is recorder-measured exit/hash output, not a claim. Accepting a review is not a merge or deployment. Reusable agent tools stay blocked until a sound authenticated runtime binding exists. [WORKSHOP_DONE] is never verification.';
export const PREVIEW_TTL_MS=60000;
const MAX_PREVIEWS=64;
// Durable per-project candidate cap (mirrors WorkbenchData's candidates limit).
// Checked before materialization so a rejected create cannot orphan a private copy.
const CANDIDATE_CAP=200;

const sha=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>{
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const digest=value=>sha(stable(value));
const publicCandidate=({root,root_history,...candidate})=>candidate;
const legacyProvenance=()=>({version:1,initiated_by:{kind:'legacy_unknown'},authorized_by:{kind:'legacy_unknown'},recorded_by:{kind:'legacy_unknown'}});
const publicActor=row=>row.provenance?row.provenance.initiated_by.kind==='owner_action'?'owner':row.provenance.initiated_by.kind:'legacy_unknown';
const publicJob=({pending_result,...job})=>({...job,actor:publicActor(job),provenance:job.provenance??legacyProvenance()});
const publicEvidence=({log_path,...evidence})=>({...evidence,actor:publicActor(evidence),provenance:evidence.provenance??legacyProvenance()});
const publicAttempt=({...attempt})=>attempt;
const publicSubmission=({...submission})=>submission;
const publicReview=({...review})=>review;
const order=(a,b)=>a<b?-1:a>b?1:0;
const terminalJob=new Set(['completed','failed','cancelled','inconclusive','outcome_unknown']);

// A single-holder gate with the same lane semantics as the lead-owned
// server/workbench-gate.mjs. Used only when the caller does not inject one.
export function createExecutionGate(){
  const active=new Map(),quarantines=new Set();
  const lane=kind=>kind==='legacy-agent'?'agent':['agent','legacy-agent','job'].includes(kind)?kind:(()=>{throw wbError('invalid_request');})();
  const holder=k=>active.get(k);
  return {
    claim(kind,id){
      if(typeof id!=='string'||!id)throw wbError('invalid_request');
      const key=lane(kind);
      if(quarantines.size||holder(key))throw wbError('busy');
      const token=Symbol(id);active.set(key,token);let released=false;
      return ()=>{if(released)return;released=true;if(active.get(key)===token)active.delete(key);};
    },
    quarantine(id){if(typeof id!=='string'||!id)throw wbError('invalid_request');quarantines.add(id);return ()=>quarantines.delete(id);},
    legacyStatus(){return {enabled:false,active:0,uncertain:0,pending:0};},
    setLegacyStatus(){throw wbError('unsupported');},
    busy(kind){return quarantines.size>0||!!holder(lane(kind));},
    status(){return {agent:!!holder('agent'),job:!!holder('job'),legacy:this.legacyStatus(),...(quarantines.size?{quarantines:[...quarantines]}:{})};},
  };
}

// --- Strict owner request schema. The router never softens this. ---
const uuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hash64={type:'string',pattern:'^[a-f0-9]{64}$'};
const safePath={type:'string',minLength:1,maxLength:4096,pattern:'^[^\\u0000\\\\]+$'};
const statement={type:'string',minLength:1,maxLength:4000};
const profileId={type:'string',minLength:1,maxLength:64,pattern:'^[A-Za-z0-9_-]+$'};
const sessionId={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_:-]+$'};
const definitionId={type:'string',minLength:1,maxLength:64,pattern:'^[A-Za-z0-9_-]+$'};
const strict=(properties,required=Object.keys(properties))=>Object.freeze({type:'object',properties,required,additionalProperties:false});
const base={action:{type:'string'},workspace_id:uuid,project_id:uuid};
const withoutNote=values=>values.filter(value=>value!=='note');
const reviewFields={candidate_id:uuid,evidence_ids:{type:'array',minItems:1,maxItems:64,items:uuid},decision:{enum:['approved','rejected']},expected_identity:hash64,note:{type:'string',minLength:1,maxLength:1000}};
const candidateChange={oneOf:[
  strict({op:{const:'delete'},path:safePath,expected_hash:hash64}),
  ...['create','change'].flatMap(op=>['content','content_base64'].map(field=>strict({op:{const:op},path:safePath,expected_hash:op==='create'?{type:'null'}:hash64,[field]:{type:'string',maxLength:field==='content'?262144:349528}}))),
]};
const requiredChecksSchema={type:'array',minItems:1,maxItems:8,items:strict({definition_id:definitionId,execution_profile_id:uuid},['definition_id'])};
export const executionRequests=Object.freeze({
  execution_state:strict({...base,action:{const:'execution_state'}}),
  task_create:strict({...base,action:{const:'task_create'},title:{type:'string',minLength:1,maxLength:240},acceptance_statement:statement,check_definition_id:definitionId,required_checks:requiredChecksSchema,profile_id:profileId,session_id:sessionId,pane_id:uuid},['action','workspace_id','project_id','title','acceptance_statement','check_definition_id','profile_id','session_id']),
  task_acceptance_preview:strict({...base,action:{const:'task_acceptance_preview'},task_id:uuid,candidate_id:uuid,expected_acceptance_digest:hash64,required_checks:requiredChecksSchema}),
  task_acceptance_approve:strict({...base,action:{const:'task_acceptance_approve'},task_id:uuid,candidate_id:uuid,preview_id:uuid,preview_digest:hash64}),
  candidate_preview:strict({...base,action:{const:'candidate_preview'},task_id:uuid}),
  candidate_create:strict({...base,action:{const:'candidate_create'},task_id:uuid,preview_id:uuid,preview_digest:hash64}),
  candidate_get:strict({...base,action:{const:'candidate_get'},candidate_id:uuid}),
  candidate_version_get:strict({...base,action:{const:'candidate_version_get'},candidate_id:uuid,candidate_hash:hash64,generation:{type:'integer',minimum:1,maximum:256}}),
  candidate_version_read:strict({...base,action:{const:'candidate_version_read'},candidate_id:uuid,candidate_hash:hash64,generation:{type:'integer',minimum:1,maximum:256},path:safePath}),
  candidate_read:strict({...base,action:{const:'candidate_read'},candidate_id:uuid,path:safePath}),
  candidate_export:strict({...base,action:{const:'candidate_export'},candidate_id:uuid}),
  candidate_edit:strict({...base,action:{const:'candidate_edit'},candidate_id:uuid,path:safePath,expected_hash:hash64,content:{type:'string',maxLength:262144}}),
  candidate_apply:strict({...base,action:{const:'candidate_apply'},candidate_id:uuid,expected_candidate_hash:hash64,changes:{type:'array',minItems:1,maxItems:256,items:candidateChange}}),
  submission_create:strict({...base,action:{const:'submission_create'},task_id:uuid,candidate_id:uuid,files:{type:'array',minItems:1,maxItems:64,items:strict({path:safePath,content:{type:'string',maxLength:262144},base_hash:hash64})}}),
  attempt_create:strict({...base,action:{const:'attempt_create'},task_id:uuid,candidate_id:uuid,profile_id:profileId,session_id:sessionId,pane_id:uuid},['action','workspace_id','project_id','task_id','candidate_id','profile_id','session_id']),
  check_preview:strict({...base,action:{const:'check_preview'},candidate_id:uuid,definition_id:definitionId,execution_profile_id:uuid},['action','workspace_id','project_id','candidate_id','definition_id']),
  check_run:strict({...base,action:{const:'check_run'},candidate_id:uuid,preview_id:uuid,preview_digest:hash64,op_id:uuid}),
  check_start:strict({...base,action:{const:'check_start'},candidate_id:uuid,preview_id:uuid,preview_digest:hash64,op_id:uuid}),
  check_cancel:strict({...base,action:{const:'check_cancel'},job_id:uuid,expected_pid:{type:'integer',minimum:1},expected_started_at:{type:'string',minLength:1,maxLength:64}}),
  job_get:strict({...base,action:{const:'job_get'},job_id:uuid}),
  job_finalize_retry:strict({...base,action:{const:'job_finalize_retry'},job_id:uuid}),
  job_acknowledge:strict({...base,action:{const:'job_acknowledge'},job_id:uuid,digest:hash64}),
  review_decide:strict({...base,action:{const:'review_decide'},...reviewFields},withoutNote(Object.keys(reviewFields))),
  context_source:strict({...base,action:{const:'context_source'},job_id:uuid}),
});
export const executionSchema=Object.freeze({$schema:'http://json-schema.org/draft-07/schema#',title:'Comet Project Workbench execution v1',oneOf:Object.values(executionRequests)});
const validate=new Ajv({strict:true}).compile(executionSchema);
export const validateExecution=body=>validate(body)===true;

export function createWorkbenchExecution({store,records,data,gate,environments,now=Date.now}={}){
  if(!records||typeof records.project!=='function')throw Error('createWorkbenchExecution requires records');
  if(!data||typeof data.create!=='function'||typeof data.get!=='function'||typeof data.list!=='function'||typeof data.update!=='function')throw Error('createWorkbenchExecution requires a WorkbenchData implementation');
  if(typeof store?.root!=='string'||!path.isAbsolute(store.root))throw Error('createWorkbenchExecution requires an absolute store runtime root');
  const serial=gate&&typeof gate.claim==='function'?gate:createExecutionGate();
  if(typeof serial.legacyStatus!=='function')throw wbError('invalid_request');
  const runtimeRoot=path.join(store.root,'workbench-execution');
  fs.mkdirSync(runtimeRoot,{recursive:true,mode:0o700});
  const inFlight=new Set(),owned=new Map(),previews=new Map(),fencedJobs=new Set(),heldReleases=new Map(),memoryPending=new Map(),mutatingCandidates=new Set(),workers=new Map();
  const journalRoot=path.join(runtimeRoot,'pending');fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});
  let admissionError=null;
  const health=()=>({healthy:admissionError===null,reason:admissionError,active_count:inFlight.size});
  let closed=false;

  const requireWorkspace=workspaceId=>{if(store&&typeof store.read==='function')store.read(workspaceId);};
  // New private reads/writes require an ACTIVE registration. Metadata reads and
  // cancellation do not: revocation must not hide or strand existing records.
  const requireActive=(workspaceId,projectId)=>{requireWorkspace(workspaceId);return records.project(workspaceId,projectId);};
  const requireScope=(workspaceId,projectId)=>{requireWorkspace(workspaceId);data.list('tasks',workspaceId,projectId);return {workspace_id:workspaceId,project_id:projectId};};
  const task=(workspaceId,projectId,id)=>data.get('tasks',workspaceId,projectId,id);
  const candidateRecord=(workspaceId,projectId,id)=>data.get('candidates',workspaceId,projectId,id);
  const revise=(kind,workspaceId,projectId,id,patch)=>{
    for(let attempt=0;attempt<3;attempt++){
      const current=data.get(kind,workspaceId,projectId,id);
      try{return data.update(kind,workspaceId,projectId,id,current.revision,patch);}
      catch(error){if(attempt||error?.code!=='stale_resource')throw error;}
    }
    throw wbError('stale_resource');
  };
  const purgePreviews=()=>{for(const [id,value] of previews)if(value.expires_at<=now())previews.delete(id);};
  function issuePreview(record){
    purgePreviews();
    if(previews.size>=MAX_PREVIEWS)throw wbError('busy');
    const preview_id=randomUUID(),expires_at=now()+PREVIEW_TTL_MS;
    previews.set(preview_id,{...record,expires_at});
    return {preview_id,expires_at};
  }
  function consumePreview(preview_id,{kind,workspace_id,project_id,digest:requested,generation,task_id,candidate_id}){
    const record=previews.get(preview_id);
    if(!record||record.kind!==kind||record.workspace_id!==workspace_id||record.project_id!==project_id)throw wbError('expired');
    if(record.expires_at<=now()){previews.delete(preview_id);throw wbError('expired');}
    if(record.digest!==requested)throw wbError('stale_resource');
    if(generation!==undefined&&record.project_generation!==generation)throw wbError('stale_resource');
    if(task_id!==undefined&&record.task_id!==task_id)throw wbError('stale_resource');
    if(candidate_id!==undefined&&record.candidate_id!==candidate_id)throw wbError('stale_resource');
    previews.delete(preview_id);
    return record;
  }
  // The candidate identity is the full confined tree: files + exclusions + limits.
  const treeHash=(candidate,{files,exclusions,limited})=>digest({version:1,generation:candidate.generation,base_hash:candidate.base_hash,files:[...files].map(file=>({path:file.path,hash:file.hash,bytes:file.bytes})).sort((a,b)=>order(a.path,b.path)),exclusions:[...exclusions].map(entry=>({path:entry.path,reason:entry.reason})).sort((a,b)=>order(a.path,b.path)||order(a.reason,b.reason)),limited:limited===true});
  const rehashCandidate=candidate=>{
    const opened=openProjectRoot(candidate.root);
    let capture;
    try{capture=captureProject({root:candidate.root,identity:opened.identity});}finally{opened.close();}
    const files=capture.files.map(file=>({path:file.path,hash:file.hash,bytes:file.bytes.length,state:candidate.files.find(entry=>entry.path===file.path)?.state??'unexpected'}));
    return {hash:treeHash(candidate,{files,exclusions:capture.exclusions,limited:capture.limited}),files,exclusions:capture.exclusions,limited:capture.limited};
  };
  // Any job that was `starting`/`running` when this process lost the child is an
  // unknown outcome. It is converted once and is never replayed; it blocks new
  // checks for the project until the owner acknowledges the exact record.
  function recover(workspaceId,projectId){
    for(const job of data.list('jobs',workspaceId,projectId)){
      if(memoryPending.has(job.id)){
        try{stageFinalization(job,memoryPending.get(job.id).raw);}catch{admissionError='pending_journal_persistence_failed';}
        continue;
      }
      if(fs.existsSync(journalPath(job.id))){
        if(terminalJob.has(job.status)&&data.list('evidence',workspaceId,projectId).some(entry=>entry.job_id===job.id))continue;
        if(job.status!=='finalization_pending')try{revise('jobs',workspaceId,projectId,job.id,{status:'finalization_pending'});}catch{admissionError='pending_guard_persistence_failed';}
        continue;
      }
      if(['starting','running'].includes(job.status)&&!inFlight.has(job.id)&&!job.ended_at){
        try{data.update('jobs',workspaceId,projectId,job.id,job.revision,{status:'outcome_unknown',ended_at:now(),acknowledged:false,outcome_note:'The recorder lost the child handle (for example a restart). The outcome is unknown and is never replayed automatically; acknowledge this exact record before starting another check.'});}catch{admissionError='unknown_guard_persistence_failed';}
      }
    }
  }
  function recoverAll(){
    let rows=[];
    try{rows=data.db.prepare("SELECT DISTINCT workspace_id,project_id FROM wb_jobs").all();}catch{admissionError='recovery_unavailable';}
    for(const row of rows)recover(row.workspace_id,row.project_id);
  }
  const unknownJobs=(workspaceId,projectId)=>data.list('jobs',workspaceId,projectId).filter(job=>job.status==='finalization_pending'||job.status==='outcome_unknown'&&job.acknowledged!==true);
  const ackDigest=job=>digest({version:1,id:job.id,op_id:job.op_id,status:job.status,candidate_id:job.candidate_id,candidate_hash:job.candidate_hash,definition_id:job.definition_id,spec_digest:job.spec_digest});
  const reviewIdentity=(candidateRecordValue,evidence,ownerTask)=>digest({version:1,candidate_id:candidateRecordValue.id,candidate_hash:candidateRecordValue.hash,acceptance_digest:ownerTask.acceptance_digest,evidence:evidence.map(entry=>({id:entry.id,artifact_hash:entry.artifact_hash,verdict:entry.verdict})).sort((a,b)=>order(a.id,b.id))});
  const projectedEvidence=(workspaceId,projectId)=>{
    const annotations=data.list('annotations',workspaceId,projectId);
    return data.list('evidence',workspaceId,projectId).map(entry=>{
      const supersession=annotations.find(annotation=>['evidence_superseded','acceptance_superseded'].includes(annotation.kind)&&annotation.evidence_id===entry.id);
      return supersession?{...entry,superseded:true,superseded_at:supersession.created_at,superseded_reason:supersession.reason}:entry;
    });
  };
  const candidateEvidence=(workspaceId,projectId,candidateId)=>projectedEvidence(workspaceId,projectId).filter(entry=>entry.candidate_id===candidateId);
  const requirements=ownerTask=>Array.isArray(ownerTask.acceptance?.required_checks)?ownerTask.acceptance.required_checks:[];
  const latestAcceptanceEvidence=(workspaceId,projectId,candidate,ownerTask)=>{
    const jobs=data.list('jobs',workspaceId,projectId),evidence=candidateEvidence(workspaceId,projectId,candidate.id);
    return requirements(ownerTask).map(required=>{
      const latestJob=jobs.filter(job=>job.candidate_id===candidate.id&&job.definition_id===required.definition_id&&job.execution_profile_id===required.execution_profile_id&&job.acceptance_version===ownerTask.acceptance_version&&job.acceptance_digest===ownerTask.acceptance_digest&&job.candidate_hash===candidate.hash&&job.project_generation===candidate.project_generation).at(-1);
      if(!latestJob||latestJob.status!=='completed')return undefined;
      return evidence.find(entry=>entry.job_id===latestJob.id&&entry.definition_digest===required.definition_digest&&entry.acceptance_digest===ownerTask.acceptance_digest&&entry.execution_profile_id===required.execution_profile_id&&digest(entry.execution_profile??null)===digest(required.execution_profile??null)&&entry.candidate_hash_before===candidate.hash&&entry.candidate_hash_after===candidate.hash&&entry.project_generation===candidate.project_generation&&!entry.revoked&&!entry.superseded&&entry.verdict==='pass');
    });
  };
  // The candidate's source is the identified capture manifest. If the registered
  // project root no longer captures to that same identity, the target changed:
  // an approval is stale and needs a fresh candidate/review. Revocation or an
  // unreadable root is treated as changed (fail closed).
  function captureSource(workspaceId,projectId){
    try{const project=records.project(workspaceId,projectId);return {hash:captureProject(project).hash,project};}
    catch{return {hash:null,project:null};}
  }
  const targetChanged=(source,candidate)=>source.hash===null||source.hash!==candidate.source_manifest_hash;
  const reviewIdentityFor=(workspaceId,projectId,candidateRecordValue,ownerTask)=>{
    const latest=latestAcceptanceEvidence(workspaceId,projectId,candidateRecordValue,ownerTask);
    const choosable=latest.every(Boolean)?latest:[];
    return reviewIdentity(candidateRecordValue,choosable,ownerTask);
  };

  function profileIdentity(workspace_id,project_id,candidate_id,profile_id){
    if(!profile_id)return null;
    if(!environments?.verifyProfile||!environments?.createExecutionView)throw wbError('unsupported');
    return environments.verifyProfile({workspace_id,project_id,candidate_id,profile_id});
  }
  function buildRequirements(workspace_id,project_id,candidate_id,files,requested){
    if(new Set(requested.map(check=>check.definition_id)).size!==requested.length)throw wbError('invalid_request');
    return requested.map(check=>{
      const definition=checkDefinition(check.definition_id),execution_profile_id=check.execution_profile_id??null;
      return {version:1,definition_id:definition.id,definition_digest:definitionDigest(definition),required_test_files:definition.id==='node-test'?discoverTestFiles(files):[],discovery:definition.discovery??'host-owned regression',execution_profile_id,execution_profile:profileIdentity(workspace_id,project_id,candidate_id,execution_profile_id)};
    });
  }
  function acceptanceFor(statement,required_checks){
    const first=required_checks[0],required_test_files=[...new Set(required_checks.flatMap(check=>check.required_test_files))].sort();
    return {version:1,statement,check_definition_id:first.definition_id,definition_digest:first.definition_digest,required_test_files,discovery:first.discovery,required_checks,required_checks_digest:digest(required_checks),limits:CHECK_LIMITS,policy:ACCEPTANCE_POLICY};
  }
  function createTask({workspace_id,project_id,title,acceptance_statement,check_definition_id,required_checks:requested,profile_id,session_id,pane_id}){
    const project=requireActive(workspace_id,project_id);
    const required_checks=buildRequirements(workspace_id,project_id,undefined,captureProject(project).files,requested??[{definition_id:check_definition_id}]);
    if(!required_checks.some(check=>check.definition_id===check_definition_id))throw wbError('invalid_request');
    const acceptance=acceptanceFor(acceptance_statement,required_checks);
    const acceptance_digest=digest(acceptance);
    // Owner-declared recipient with no disclosure authority; B resolves the live
    // profile/session/pane binding before any share and compares this exact value.
    const recipient={...(pane_id?{pane_id}:{}),profile_id,session_id};
    return {task:data.create('tasks',{workspace_id,project_id,project_generation:project.generation,title,acceptance,acceptance_version:1,acceptance_digest,check_definition_id,recipient,recipient_authority:'owner_declared_unbound; no disclosure authority until B resolves the live binding',status:'open',candidate_id:null,latest_evidence_id:null})};
  }
  function idleTask(workspace_id,project_id,task_id){
    if(data.list('jobs',workspace_id,project_id).some(job=>job.task_id===task_id&&(inFlight.has(job.id)||['starting','running','cancel_requested','finalization_pending'].includes(job.status)||job.status==='outcome_unknown'&&!job.acknowledged)))throw wbError('busy');
  }
  function taskAcceptancePreview({workspace_id,project_id,task_id,candidate_id,expected_acceptance_digest,required_checks}){
    const project=requireActive(workspace_id,project_id),ownerTask=task(workspace_id,project_id,task_id),candidate=candidateRecord(workspace_id,project_id,candidate_id);
    idleTask(workspace_id,project_id,task_id);
    if(ownerTask.project_generation!==project.generation||candidate.project_generation!==project.generation||candidate.task_id!==task_id||ownerTask.candidate_id!==candidate_id||ownerTask.acceptance_digest!==expected_acceptance_digest||digest(ownerTask.acceptance)!==expected_acceptance_digest||rehashCandidate(candidate).hash!==candidate.hash)throw wbError('stale_resource');
    const acceptance=acceptanceFor(ownerTask.acceptance.statement,buildRequirements(workspace_id,project_id,candidate_id,candidate.files,required_checks));
    const preview={version:1,task_id,candidate_id,candidate_hash:candidate.hash,project_generation:project.generation,previous_acceptance_digest:expected_acceptance_digest,acceptance_version:ownerTask.acceptance_version+1,acceptance,acceptance_digest:digest(acceptance)};
    const previewDigest=digest(preview),issued=issuePreview({...preview,kind:'acceptance',workspace_id,project_id,digest:previewDigest});
    return {preview:{...preview,digest:previewDigest},preview_id:issued.preview_id,expires_at:issued.expires_at};
  }
  function taskAcceptanceApprove({workspace_id,project_id,task_id,candidate_id,preview_id,preview_digest}){
    const project=requireActive(workspace_id,project_id),ownerTask=task(workspace_id,project_id,task_id),candidate=candidateRecord(workspace_id,project_id,candidate_id);
    idleTask(workspace_id,project_id,task_id);
    const issued=consumePreview(preview_id,{kind:'acceptance',workspace_id,project_id,digest:preview_digest,generation:project.generation,task_id,candidate_id});
    if(ownerTask.acceptance_digest!==issued.previous_acceptance_digest||ownerTask.candidate_id!==candidate_id||candidate.hash!==issued.candidate_hash||rehashCandidate(candidate).hash!==candidate.hash)throw wbError('stale_resource');
    validatePinned({...ownerTask,acceptance:issued.acceptance,acceptance_digest:issued.acceptance_digest},candidate,project);
    const updated=data.db.transaction(()=>{
      const value=data.update('tasks',workspace_id,project_id,task_id,ownerTask.revision,{acceptance:issued.acceptance,acceptance_digest:issued.acceptance_digest,acceptance_version:issued.acceptance_version,check_definition_id:issued.acceptance.check_definition_id,status:'candidate_ready',latest_evidence_id:null});
      for(const evidence of candidateEvidence(workspace_id,project_id,candidate_id))if(!evidence.superseded)data.create('annotations',{workspace_id,project_id,kind:'acceptance_superseded',evidence_id:evidence.id,candidate_id,acceptance_digest:issued.acceptance_digest,reason:'acceptance_revised',actor:'owner'});
      return value;
    }).immediate();
    for(const [id,preview] of previews)if(preview.task_id===task_id)previews.delete(id);
    return {task:updated};
  }
  function candidatePreview({workspace_id,project_id,task_id}){
    const ownerTask=task(workspace_id,project_id,task_id);
    const project=requireActive(workspace_id,project_id);
    if(ownerTask.project_generation!==project.generation)throw wbError('stale_resource');
    const capture=captureProject(project);
    const preview=previewCandidate({project,capture,now});
    const issued=issuePreview({kind:'candidate',workspace_id,project_id,project_generation:project.generation,task_id:ownerTask.id,digest:preview.digest,base_manifest_hash:preview.base.manifest_hash});
    return {task_id:ownerTask.id,preview:{digest:preview.digest,base:preview.base},preview_id:issued.preview_id,expires_at:issued.expires_at};
  }
  function candidateCreate({workspace_id,project_id,task_id,preview_id,preview_digest}){
    const ownerTask=task(workspace_id,project_id,task_id);
    const project=requireActive(workspace_id,project_id);
    if(ownerTask.project_generation!==project.generation)throw wbError('stale_resource');
    if(ownerTask.acceptance_digest!==digest(ownerTask.acceptance))throw wbError('stale_resource');
    consumePreview(preview_id,{kind:'candidate',workspace_id,project_id,digest:preview_digest,generation:project.generation,task_id:ownerTask.id});
    // Precheck the durable cap BEFORE materializing a private copy, so a full or
    // failing store never leaves an orphan filesystem candidate behind.
    if(data.list('candidates',workspace_id,project_id).length>=CANDIDATE_CAP)throw wbError('limit_exceeded');
    const capture=captureProject(project);
    const fields=createCandidate({store,project,capture,preview_digest,now});
    try{
      const assembled={generation:fields.generation,base_hash:fields.base_hash,root:fields.root,files:fields.files};
      const full=rehashCandidate(assembled);
      const candidate=data.create('candidates',{workspace_id,project_id,project_generation:project.generation,task_id:ownerTask.id,source_manifest_hash:fields.source_manifest_hash,preview_digest:fields.preview_digest,base_hash:fields.base_hash,generation:fields.generation,hash:full.hash,root:fields.root,files:full.files,exclusions:full.exclusions,limited:full.limited,total_bytes:fields.total_bytes,head:null,status:'approved'});
      const updatedTask=revise('tasks',workspace_id,project_id,ownerTask.id,{candidate_id:candidate.id,status:'candidate_ready'});
      return {candidate:publicCandidate(candidate),task:updatedTask};
    }catch(error){
      // Persistence failed after materialization (cap, DB or validation). Remove
      // ONLY the copy this call just created, bounded and via its owned root; no
      // other candidate is ever touched and no failure is silently swallowed.
      try{removeCandidateWorkspace(store,{root:fields.root});}catch{}
      throw error;
    }
  }
  function candidateGet({workspace_id,project_id,candidate_id}){
    requireScope(workspace_id,project_id);
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    const ownerTask=task(workspace_id,project_id,candidate.task_id);
    const source=captureSource(workspace_id,project_id);
    const latest=latestAcceptanceEvidence(workspace_id,project_id,candidate,ownerTask),acceptance_complete=latest.length>0&&latest.every(Boolean);
    return {candidate:publicCandidate(candidate),review_identity:reviewIdentityFor(workspace_id,project_id,candidate,ownerTask),review_evidence_ids:acceptance_complete?latest.map(entry=>entry.id):[],acceptance_complete,target_changed:targetChanged(source,candidate),current_source_hash:source.hash};
  }
  function candidateRead({workspace_id,project_id,candidate_id,path:relative}){
    requireActive(workspace_id,project_id);
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    const file=readCandidateFile(store,candidate,relative);
    return {candidate_id:candidate.id,file:{path:file.path,hash:file.hash,bytes:file.bytes,text:file.binary?'':file.text,binary:file.binary}};
  }
  function candidateVersion({workspace_id,project_id,candidate_id,candidate_hash,generation}){
    const project=requireActive(workspace_id,project_id),candidate=candidateRecord(workspace_id,project_id,candidate_id);
    if(candidate.project_generation!==project.generation)throw wbError('stale_resource');
    const version=candidate.generation===generation&&candidate.hash===candidate_hash?candidate:
      (candidate.root_history??[]).find(entry=>entry.generation===generation&&entry.hash===candidate_hash);
    if(!version)throw wbError('stale_resource');
    const historical={...candidate,root:version.root,generation,hash:candidate_hash,files:version===candidate?candidate.files:[]};
    let observed;
    try{observed=rehashCandidate(historical);}catch(error){throw wbError(error?.code==='stale_resource'?'stale_resource':'unavailable');}
    if(observed.hash!==candidate_hash)throw wbError('stale_resource');
    return {...historical,files:observed.files,exclusions:observed.exclusions,limited:observed.limited};
  }
  function candidateVersionGet(body){
    const candidate=candidateVersion(body);
    return {candidate:publicCandidate(candidate)};
  }
  function candidateVersionRead(body){
    const candidate=candidateVersion(body),file=readCandidateFile(store,candidate,body.path);
    if(rehashCandidate(candidate).hash!==body.candidate_hash||!candidate.files.some(entry=>entry.path===body.path&&entry.hash===file.hash&&entry.bytes===file.bytes))throw wbError('stale_resource');
    return {candidate_id:candidate.id,candidate_hash:candidate.hash,generation:candidate.generation,file:{path:file.path,hash:file.hash,bytes:file.bytes,text:file.binary?'':file.text,binary:file.binary}};
  }
  function candidateExport({workspace_id,project_id,candidate_id}){
    const project=requireActive(workspace_id,project_id);
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    const source=captureSource(workspace_id,project_id);
    const files=[];let total=0,truncated=false;
    for(const file of candidate.files){
      const read=readCandidateFile(store,candidate,file.path);
      const candidateText=read.binary?null:read.text;
      let sourceText=null,sourceState='missing';
      try{
        const original=readProjectFile(project,file.path),preview=literalPreview(original.bytes);
        if(preview.binary)sourceState='binary';
        else{sourceText=preview.text;sourceState=original.hash===file.hash?'same':'changed';}
      }catch{sourceState='missing';}
      const bytes=Buffer.byteLength(candidateText??'','utf8')+Buffer.byteLength(sourceText??'','utf8');
      if(total+bytes>262144){truncated=true;break;}
      total+=bytes;
      files.push({path:file.path,state:file.state,candidate_hash:file.hash,candidate_bytes:file.bytes,candidate_text:candidateText,binary:read.binary,source_text:sourceText,source_state:sourceState});
    }
    // A read-only convenience view of the actual old/source bytes beside the
    // candidate bytes. It is never applied. Accepting a review is not a merge,
    // deployment or reusable grant, and a changed source target requires a fresh
    // candidate and review rather than an overwrite.
    return {artifact:{version:1,candidate_id:candidate.id,task_id:candidate.task_id,candidate_hash:candidate.hash,generation:candidate.generation,source_manifest_hash:candidate.source_manifest_hash,current_source_hash:source.hash,target_changed:targetChanged(source,candidate),files,truncated:truncated||files.length<candidate.files.length,generated_at:now()},integration_supported:false,integration_note:'Read-only export. It is not applied to any project and no descriptor-write integration path is proven safe, so an owner integration step must fail closed rather than overwrite. Accepting a review is not a merge, deployment or reusable grant.'};
  }
  function candidateEdit({workspace_id,project_id,candidate_id,path:relative,expected_hash,content}){
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    if(!candidate.files.some(file=>file.path===relative))throw wbError('unsupported');
    const result=candidateApply({workspace_id,project_id,candidate_id,expected_candidate_hash:candidate.hash,changes:[{op:'change',path:relative,expected_hash,content}]});
    const file=result.candidate.files.find(file=>file.path===relative);
    return {...result,file:{path:file.path,hash:file.hash,bytes:file.bytes}};
  }
  function candidateApply({workspace_id,project_id,candidate_id,expected_candidate_hash,changes,principal={kind:'owner'}}){
    const project=requireActive(workspace_id,project_id);
    if(mutatingCandidates.has(candidate_id)||data.list('jobs',workspace_id,project_id).some(job=>job.candidate_id===candidate_id&&(inFlight.has(job.id)||memoryPending.has(job.id)||fs.existsSync(journalPath(job.id))||['starting','running','cancel_requested','finalization_pending'].includes(job.status)||job.status==='outcome_unknown'&&!job.acknowledged)))throw wbError('busy');
    mutatingCandidates.add(candidate_id);let staged;
    try{
      const candidate=candidateRecord(workspace_id,project_id,candidate_id),ownerTask=task(workspace_id,project_id,candidate.task_id);
      if(candidate.project_generation!==project.generation||candidate.hash!==expected_candidate_hash||rehashCandidate(candidate).hash!==candidate.hash)throw wbError('stale_resource');
      if(changes.some(change=>change.op==='delete'&&(ownerTask.acceptance.required_test_files??[]).includes(change.path)))throw wbError('stale_resource');
      // Provider identity covers its complete file manifest. The public execution
      // identity additionally binds exclusions and capture limits; verify both.
      const providerHash=providerCandidateHash(candidate);
      staged=applyCandidateChanges({store,candidate:{...candidate,hash:providerHash},expected_candidate_hash:providerHash,changes});
      const full=rehashCandidate({...candidate,...staged});
      const next={...candidate,...staged,hash:full.hash,files:full.files,exclusions:full.exclusions,limited:full.limited};
      validatePinned(ownerTask,next,project);
      const result=data.db.transaction(()=>{
        const updated=data.update('candidates',workspace_id,project_id,candidate.id,candidate.revision,{root:staged.root,root_history:[...(candidate.root_history??[]),{root:candidate.root,generation:candidate.generation,hash:candidate.hash}],generation:staged.generation,hash:full.hash,files:full.files,exclusions:full.exclusions,limited:full.limited,total_bytes:staged.total_bytes,status:'approved'});
        const superseded=[];
        for(const entry of candidateEvidence(workspace_id,project_id,candidate.id)){
          if(entry.superseded)continue;
          data.create('annotations',{workspace_id,project_id,kind:'evidence_superseded',evidence_id:entry.id,candidate_id:candidate.id,candidate_generation:staged.generation,reason:'candidate_edited',actor:principal.kind,grant_id:principal.grant_id??null});superseded.push(entry.id);
        }
        return {candidate:publicCandidate(updated),superseded_evidence_ids:superseded};
      }).immediate();
      staged=null;return result;
    }finally{
      try{if(staged)removeCandidateWorkspace(store,{root:staged.root});}
      finally{mutatingCandidates.delete(candidate_id);}
    }
  }
  function submissionCreate({workspace_id,project_id,task_id,candidate_id,files}){
    const ownerTask=task(workspace_id,project_id,task_id);
    requireActive(workspace_id,project_id);
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    if(candidate.task_id!==ownerTask.id)throw wbError('stale_resource');
    for(const file of files){
      const known=candidate.files.find(entry=>entry.path===file.path);
      if(!known||known.hash!==file.base_hash)throw wbError('stale_resource');
    }
    // `kind` is the discriminator that keeps owner-pasted proposals separate from
    // B's durable Hermes context submissions in the shared `submissions` table.
    const submission=data.create('submissions',{workspace_id,project_id,kind:'patch_proposal',task_id:ownerTask.id,candidate_id:candidate.id,files,source:'owner_paste',tool:'agent_tool_blocked',actual_isolation:false,applied:false,candidate_hash_at_submit:candidate.hash,note:SUBMISSION_NOTE});
    return {submission:publicSubmission(submission)};
  }
  function attemptCreate({workspace_id,project_id,task_id,candidate_id,profile_id,session_id,pane_id}){
    const ownerTask=task(workspace_id,project_id,task_id);
    const project=requireActive(workspace_id,project_id);
    if(ownerTask.acceptance_digest!==digest(ownerTask.acceptance))throw wbError('stale_resource');
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    if(candidate.task_id!==ownerTask.id)throw wbError('stale_resource');
    if(candidate.project_generation!==project.generation||ownerTask.project_generation!==project.generation)throw wbError('stale_resource');
    const attempt=data.create('attempts',{workspace_id,project_id,project_generation:project.generation,task_id:ownerTask.id,candidate_id:candidate.id,recipient:{...(pane_id?{pane_id}:{}),profile_id,session_id},recipient_authority:pane_id?'owner_declared_pane; requires live binding resolution':'owner_declared_unbound; no disclosure authority',acceptance_version:ownerTask.acceptance_version,acceptance_digest:ownerTask.acceptance_digest,candidate_hash:candidate.hash,status:'created'});
    return {attempt:publicAttempt(attempt)};
  }
  function specFor(ownerTask,candidate,definition,required){return checkSpecDigest({definition_id:definition.id,definition_digest:definitionDigest(definition),project_generation:candidate.project_generation,candidate_id:candidate.id,candidate_generation:candidate.generation,candidate_hash:candidate.hash,acceptance_version:ownerTask.acceptance_version,acceptance_digest:ownerTask.acceptance_digest,required_check:required});}
  function validatePinned(ownerTask,candidate,project){
    if(candidate.project_generation!==project.generation||ownerTask.project_generation!==project.generation)throw wbError('stale_resource');
    if(!requirements(ownerTask).length||digest(requirements(ownerTask))!==ownerTask.acceptance.required_checks_digest)throw wbError('stale_resource');
    for(const required of requirements(ownerTask)){
      if(required.definition_digest!==definitionDigest(checkDefinition(required.definition_id)))throw wbError('stale_resource');
      if(required.definition_id==='node-test'){
        const pinned=required.required_test_files;
        if(!Array.isArray(pinned)||!pinned.length||JSON.stringify(discoverTestFiles(candidate.files))!==JSON.stringify(pinned))throw wbError('stale_resource');
      }
      if(digest(profileIdentity(candidate.workspace_id,candidate.project_id,candidate.id,required.execution_profile_id))!==digest(required.execution_profile??null))throw wbError('stale_resource');
    }
  }
  function checkPreview({workspace_id,project_id,candidate_id,definition_id,execution_profile_id}){
    const project=requireActive(workspace_id,project_id);
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    const ownerTask=task(workspace_id,project_id,candidate.task_id);
    validatePinned(ownerTask,candidate,project);
    const required=requirements(ownerTask).find(check=>check.definition_id===definition_id);
    if(ownerTask.acceptance_digest!==digest(ownerTask.acceptance)||!required||execution_profile_id!==undefined&&execution_profile_id!==required.execution_profile_id)throw wbError('stale_resource');
    if(ownerTask.candidate_id&&ownerTask.candidate_id!==candidate.id)throw wbError('stale_resource');
    const definition=checkDefinition(definition_id);
    const definition_digest=definitionDigest(definition);
    const spec_digest=specFor(ownerTask,candidate,definition,required);
    const issued=issuePreview({kind:'check',workspace_id,project_id,project_generation:project.generation,task_id:ownerTask.id,candidate_id:candidate.id,candidate_hash:candidate.hash,definition_id,definition_digest,required_check:required,acceptance_version:ownerTask.acceptance_version,acceptance_digest:ownerTask.acceptance_digest,digest:spec_digest});
    return {task_id:ownerTask.id,preview:{spec_digest,candidate_id:candidate.id,candidate_hash:candidate.hash,acceptance_version:ownerTask.acceptance_version,required_test_files:required.required_test_files,required_check:required,execution_profile_id:required.execution_profile_id,execution_profile:required.execution_profile,definition_id,definition_digest,definition_hash:definition_digest,executable:definition.executable,args:[...definition.args],script:definition_id==='host-regression'?'<host-owned immutable verify script>':null,limits:CHECK_LIMITS,policy:CHECK_POLICY},preview_id:issued.preview_id,expires_at:issued.expires_at};
  }
  function admitCheck({workspace_id,project_id,candidate_id,preview_id,preview_digest,op_id},principal={kind:'owner'}){
    const project=requireActive(workspace_id,project_id);
    if(mutatingCandidates.has(candidate_id))throw wbError('busy');
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    const ownerTask=task(workspace_id,project_id,candidate.task_id);
    // A retry of an already-durable operation ID is answered from the receipt and
    // does not consume a new preview or spawn again.
    const existing=data.list('jobs',workspace_id,project_id).find(entry=>entry.op_id===op_id);
    if(existing){
      const historical=digest({...existing.request_identity,workspace_id,project_id,project_generation:project.generation,candidate_id,preview_digest});
      if(!existing.request_identity||existing.request_fingerprint!==historical||existing.project_generation!==project.generation)throw wbError('stale_resource');
      const evidence=projectedEvidence(workspace_id,project_id).filter(entry=>entry.job_id===existing.id).at(-1)??null;
      return {job:publicJob(existing),evidence:evidence?publicEvidence(evidence):null,idempotent:true};
    }
    if(!health().healthy)throw wbError('unavailable');
    validatePinned(ownerTask,candidate,project);
    const preview=previews.get(preview_id);
    if(!preview){const matches=requirements(ownerTask).some(required=>specFor(ownerTask,candidate,checkDefinition(required.definition_id),required)===preview_digest);throw wbError(matches?'expired':'stale_resource');}
    if(preview.kind!=='check'||preview.workspace_id!==workspace_id||preview.project_id!==project_id)throw wbError('expired');
    const definition=checkDefinition(preview.definition_id),required=requirements(ownerTask).find(check=>check.definition_id===definition.id);
    if(!required)throw wbError('stale_resource');
    const spec=specFor(ownerTask,candidate,definition,required);
    if(spec!==preview_digest)throw wbError('stale_resource');
    if(ownerTask.candidate_id!==candidate.id||ownerTask.acceptance_digest!==digest(ownerTask.acceptance))throw wbError('stale_resource');
    // A changed or injected candidate tree is refused before the issued approval
    // is consumed so a failed attempt does not burn a valid preview.
    const current=rehashCandidate(candidate);
    if(current.hash!==candidate.hash)throw wbError('stale_resource');
    if(unknownJobs(workspace_id,project_id).length)throw wbError('outcome_unknown');
    const issued=consumePreview(preview_id,{kind:'check',workspace_id,project_id,digest:preview_digest,generation:project.generation,task_id:ownerTask.id,candidate_id:candidate.id});
    if(issued.candidate_hash!==candidate.hash||issued.acceptance_version!==ownerTask.acceptance_version||issued.acceptance_digest!==ownerTask.acceptance_digest||issued.definition_id!==definition.id||digest(issued.required_check)!==digest(required))throw wbError('stale_resource');
    const request_identity={version:2,workspace_id,project_id,project_generation:project.generation,candidate_id,candidate_generation:candidate.generation,candidate_hash:candidate.hash,task_id:ownerTask.id,acceptance_digest:ownerTask.acceptance_digest,acceptance_version:ownerTask.acceptance_version,definition_digest:definitionDigest(definition),execution_inputs:required,preview_digest};
    const request_fingerprint=digest(request_identity);
    let initiated_by={kind:'owner_action'},authorized_by={kind:'owner_approval',preview_id};
    if(principal.kind==='native_agent'){
      const grant=data.get('grants',workspace_id,project_id,principal.grant_id);
      const call=data.get('toolcalls',workspace_id,project_id,op_id);
      if(grant.status!=='running'||grant.authority_generation!==principal.authority_generation||grant.run_id!==principal.run_id||grant.candidate_id!==candidate_id||call.id!==op_id||call.grant_id!==grant.id||call.attempt_id!==grant.attempt_id||call.action!=='job_start'||call.status!=='started')throw wbError('permission_denied');
      initiated_by={kind:'native_agent',attempt_id:grant.attempt_id,grant_id:grant.id,run_id:grant.run_id,tool_call_id:call.id};
      authorized_by={kind:'owner_grant',grant_id:grant.id,authority_generation:grant.authority_generation};
    }else if(principal.kind!=='owner')throw wbError('permission_denied');
    const provenance={version:1,initiated_by,authorized_by,recorded_by:{kind:'comet_service',component:'workbench-check-recorder',build_id:workbenchBuildIdentity(),verifier_id:definition.id,verifier_hash:definitionDigest(definition)}};
    if(!validateWorkbenchProvenance(provenance))throw wbError('invalid_request');
    const release=serial.claim('job',op_id);
    let job;
    try{
       job=data.create('jobs',{workspace_id,project_id,project_generation:project.generation,request_fingerprint,request_identity,execution_profile_id:required.execution_profile_id,execution_profile:required.execution_profile,required_check:required,candidate_generation:candidate.generation,task_id:ownerTask.id,candidate_id:candidate.id,candidate_hash:candidate.hash,acceptance_version:ownerTask.acceptance_version,acceptance_digest:ownerTask.acceptance_digest,definition_id:definition.id,definition_digest:definitionDigest(definition),definition_hash:definitionDigest(definition),spec_digest:spec,op_id,status:'starting',pid:null,pgid:null,process_start:null,started_at:null,ended_at:null,outcome_note:null,acknowledged:true,limits:CHECK_LIMITS,actor:principal.kind==='native_agent'?'native_agent':'owner',provenance});
    }catch(error){release();throw error;}
    inFlight.add(job.id);
    return {job,candidate,ownerTask,definition,required,release};
  }
  function launchCheck(admitted,{defer=false}={}){
    const {job}=admitted;
    const work=defer?new Promise(resolve=>setImmediate(resolve)).then(()=>executeAdmitted(admitted)):executeAdmitted(admitted);
    // Service-owned lifecycle: disconnecting the admitting HTTP/tool request
    // neither cancels observation nor abandons durable finalization.
    workers.set(job.id,work);
    work.then(()=>workers.delete(job.id),()=>workers.delete(job.id));
    return work;
  }
  async function checkRun(body,principal){
    const admitted=admitCheck(body,principal);
    if(admitted.idempotent)return admitted;
    return launchCheck(admitted);
  }
  function startApprovedCheck(body,principal){
    const admitted=admitCheck(body,principal);
    if(admitted.idempotent)return {...admitted,accepted:true};
    launchCheck(admitted,{defer:true}).catch(()=>{}); // executeAdmitted persists every failure.
    return {job:publicJob(admitted.job),evidence:null,accepted:true};
  }
  async function executeAdmitted({job:initialJob,candidate,ownerTask,definition,required,release}){
    let job=initialJob;const {workspace_id,project_id}=job;
    let raw,view;const observations=[];
    try{
      if(closed)throw wbError('unavailable');
      const project=requireActive(workspace_id,project_id);validatePinned(ownerTask,candidate,project);
      if(required.execution_profile_id)view=environments.createExecutionView({workspace_id,project_id,profile_id:required.execution_profile_id,candidate_id:candidate.id});
      const observe=()=>{
        const source=rehashCandidate(candidate),observed={source_hash:source.hash,view_source_hash:null,dependency_hash:null,output_hash:null,verified:false};
        observations.push(observed);
        if(source.hash!==candidate.hash)throw wbError('stale_resource');
        const verified=view?view.verify():{source_hash:source.hash,dependency_hash:null,output_hash:digest([])};
        Object.assign(observed,{view_source_hash:verified.source_hash,dependency_hash:verified.dependency_hash,output_hash:verified.output_hash,verified:true});
        return {hash:source.hash};
      };
      raw=await runCheck({definition_id:definition.id,required_test_files:required.required_test_files,candidate_root:view?.root??candidate.root,candidate_boundary:view?path.join(store.root,'workbench-environments'):runtimeRoot,workspace_id,project_id,job_id:job.id,artifact_root:runtimeRoot,rehash:observe,spawn_record:record=>{
        owned.set(job.id,{pid:record.pid,process_start:String(record.started_at),workspace_id,project_id});
        job=revise('jobs',workspace_id,project_id,job.id,{status:'running',pid:record.pid,pgid:record.pgid,process_start:String(record.started_at),started_at:now(),supervisor:record.supervisor,command:record.command??null});
      }});
      raw.execution_observation={source_before:observations[0]?.source_hash??null,source_after:observations[1]?.source_hash??null,view_source_before:observations[0]?.view_source_hash??null,view_source_after:observations[1]?.view_source_hash??null,dependency_before:observations[0]?.dependency_hash??null,dependency_after:observations[1]?.dependency_hash??null,output_hash_before:observations[0]?.output_hash??null,output_hash_after:observations[1]?.output_hash??null,allowed_outputs:[],verified_view:!!view&&observations.length===2&&observations.every(observed=>observed.verified)};
      raw.environment=view?{...required.execution_profile,source_hash:candidate.hash,execution_view_identity:view.prepared.environment_identity,execution_view_id:path.basename(path.dirname(view.root))}:null;
      raw.artifact_hash=digest({recorder_artifact_hash:raw.artifact_hash,environment:raw.environment,execution_observation:raw.execution_observation});
    }catch(error){
      const uncertain=owned.has(job.id);
      if(!uncertain){inFlight.delete(job.id);release();}else heldReleases.set(job.id,release);
      try{revise('jobs',workspace_id,project_id,job.id,{status:uncertain?'outcome_unknown':'failed',ended_at:now(),acknowledged:!uncertain,outcome_note:`Check did not complete: ${typeof error?.code==='string'?error.code:'unavailable'}. No automatic retry.`});}catch{admissionError='failure_guard_persistence_failed';}
      throw error;
    }
    if(!raw.process_survival_unknown){try{view?.dispose();}catch{raw.disposal_error='execution_view_retained';}}
    if(raw.process_survival_unknown)heldReleases.set(job.id,release);
    else{inFlight.delete(job.id);owned.delete(job.id);release();}
    try{
      stageFinalization(job,raw);
      return recoverFinalization({workspace_id,project_id,job_id:job.id});
    }catch{
      return {job:publicJob(data.get('jobs',workspace_id,project_id,job.id)),evidence:null,finalization_pending:true,health:health()};
    }
  }
  function journalPath(id){if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw wbError('invalid_request');return path.join(journalRoot,`${id}.json`);}
  function stageFinalization(job,raw){
    const record={version:1,workspace_id:job.workspace_id,project_id:job.project_id,job_id:job.id,request_fingerprint:job.request_fingerprint,project_generation:job.project_generation,fenced:fencedJobs.has(job.id),raw};
    memoryPending.set(job.id,record);
    const pendingPatch={status:'finalization_pending',pending_digest:digest(record),ended_at:raw.ended_at,outcome_note:'Observed result awaits atomic evidence/job/task finalization. Retry finalization never executes a process.'};
    try{
      revise('jobs',job.workspace_id,job.project_id,job.id,{...pendingPatch,pending_result:record});
      memoryPending.delete(job.id);return;
    }catch{admissionError='pending_guard_persistence_failed';}
    const payload=JSON.stringify({record,digest:digest(record)}),destination=journalPath(job.id),temporary=destination+'.tmp';
    try{
      const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      try{fs.writeFileSync(fd,payload);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,destination);const dir=fs.openSync(journalRoot,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    }catch(error){admissionError='pending_journal_persistence_failed';throw error;}
    memoryPending.delete(job.id);
    try{revise('jobs',job.workspace_id,job.project_id,job.id,pendingPatch);}
    catch(error){admissionError='pending_guard_persistence_failed';throw error;}
  }
  function recoverFinalization({workspace_id,project_id,job_id}){
    requireScope(workspace_id,project_id);
    const job=data.get('jobs',workspace_id,project_id,job_id);
    const existing=projectedEvidence(workspace_id,project_id).find(entry=>entry.job_id===job.id);
    if(existing&&terminalJob.has(job.status)){
      if(fs.existsSync(journalPath(job.id)))fs.unlinkSync(journalPath(job.id));
      return {job:publicJob(job),evidence:publicEvidence(existing),idempotent:true};
    }
    let envelope;
    if(job.pending_result)envelope={record:job.pending_result,digest:job.pending_digest};
    else if(fs.existsSync(journalPath(job.id))){
      const fd=fs.openSync(journalPath(job.id),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>512*1024||stat.nlink!==1)throw wbError('unavailable');envelope=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
    }else if(memoryPending.has(job.id)){const record=memoryPending.get(job.id);envelope={record,digest:digest(record)};}
    else throw wbError('stale_resource');
    const {record}=envelope;
    if(record.version!==1||record.job_id!==job.id||record.workspace_id!==workspace_id||record.project_id!==project_id||record.request_fingerprint!==job.request_fingerprint||record.project_generation!==job.project_generation||envelope.digest!==digest(record)||job.pending_digest&&job.pending_digest!==envelope.digest)throw wbError('stale_resource');
    const result=data.db.transaction(()=>finalize(job,record.raw,record.fenced)).immediate();
    if(fs.existsSync(journalPath(job.id)))fs.unlinkSync(journalPath(job.id));fencedJobs.delete(job.id);memoryPending.delete(job.id);
    if(!memoryPending.size&&['pending_guard_persistence_failed','pending_journal_persistence_failed'].includes(admissionError))admissionError=null;
    return result;
  }
  function finalize(initialJob,raw,fenced){
    let job=initialJob;const {workspace_id,project_id}=job;
    const candidate=candidateRecord(workspace_id,project_id,job.candidate_id),ownerTask=task(workspace_id,project_id,job.task_id);
    let revokedNow=fenced===true;
    try{revokedNow=revokedNow||records.project(workspace_id,project_id).generation!==job.project_generation;}catch{revokedNow=true;}
    const verdict=revokedNow?'inconclusive':raw.verdict;
     const evidence=data.create('evidence',{workspace_id,project_id,project_generation:job.project_generation,acceptance_digest:job.acceptance_digest,execution_profile_id:job.execution_profile_id,execution_profile:job.execution_profile,environment:raw.environment??null,execution_observation:raw.execution_observation??null,job_id:job.id,candidate_id:candidate.id,task_id:ownerTask.id,verdict,test_results:raw.test_results??null,exit_code:Number.isInteger(raw.exit_code)?raw.exit_code:null,signal:raw.signal??null,timed_out:raw.timed_out===true,spawn_error:raw.spawn_error??null,recording_error:raw.recording_error??null,process_survival_unknown:raw.process_survival_unknown===true,started_at:raw.started_at,ended_at:raw.ended_at,candidate_hash_before:raw.candidate_hash_before,candidate_hash_after:raw.candidate_hash_after,definition_id:raw.definition_id,definition_digest:raw.definition_digest,definition_hash:raw.definition_hash,artifact_hash:raw.artifact_hash,log_hash:raw.log_hash,log_bytes:raw.log_bytes,env_fingerprint:raw.env_fingerprint,supervisor:raw.supervisor,command:raw.command,stdout_preview:raw.stdout_preview,stderr_preview:raw.stderr_preview,limits:raw.limits,superseded:false,revoked:revokedNow,actor:job.provenance?.initiated_by.kind==='native_agent'?'native_agent':job.provenance?'owner':'legacy_unknown',provenance:job.provenance??{version:1,initiated_by:{kind:'legacy_unknown'},authorized_by:{kind:'legacy_unknown'},recorded_by:{kind:'legacy_unknown'}}});
    const computed=verdict==='pass'?'completed':verdict==='fail'?'failed':raw.timed_out?'cancelled':'inconclusive';
    const currentJob=data.get('jobs',workspace_id,project_id,job.id);
    const cancelled=raw.cancelled||currentJob.status==='cancel_requested'||currentJob.status==='cancelled'||raw.spawn_error;
    const status=raw.process_survival_unknown?'outcome_unknown':cancelled?'cancelled':computed;
    const survivalUnknown=raw.process_survival_unknown===true;
    // Cancellation is only confirmed when no process survived; a possible
    // descendant escape blocks a false "cancelled/terminated" claim.
    job=revise('jobs',workspace_id,project_id,job.id,{status,pending_result:null,ended_at:raw.ended_at,acknowledged:!survivalUnknown,cancel_confirmed:status==='cancelled'&&!survivalUnknown,process_survival_unknown:survivalUnknown,outcome_note:revokedNow?'Project access was revoked during the check; the result is fenced and is never treated as verified.':survivalUnknown?'Process survival is unknown: a descendant may have outlived the leader and was not signalled. The result is not a pass.':raw.spawn_error?'Spawn identity recording failed; the supervised process was stopped and cannot pass.':status==='cancelled'?'Owner requested cancellation of the identity-verified process group.':null});
    revise('tasks',workspace_id,project_id,ownerTask.id,{latest_evidence_id:evidence.id,status:revokedNow?'revoked':'checked'});
    return {job:publicJob(job),evidence:publicEvidence(evidence)};
  }
  function checkCancel({workspace_id,project_id,job_id,expected_pid,expected_started_at}){
    requireScope(workspace_id,project_id);
    const job=data.get('jobs',workspace_id,project_id,job_id);
    if(terminalJob.has(job.status)||job.ended_at)throw wbError('stale_resource');
    if(job.pid!==expected_pid)throw wbError('unavailable');
    const result=cancelCheck({job_id:job.id,pid:job.pid,started_at:expected_started_at});
    if(!result.requested)throw wbError('unavailable');
    const updated=revise('jobs',workspace_id,project_id,job.id,{status:'cancel_requested',cancel_requested_at:now(),cancel_confirmed:result.confirmed===true});
    return {job:publicJob(updated),cancel_requested:true,cancel_confirmed:result.confirmed===true};
  }
  function jobAcknowledge({workspace_id,project_id,job_id,digest:provided}){
    requireScope(workspace_id,project_id);
    const job=data.get('jobs',workspace_id,project_id,job_id);
    if(job.status!=='outcome_unknown')throw wbError('stale_resource');
    if(ackDigest(job)!==provided)throw wbError('stale_resource');
    const updated=revise('jobs',workspace_id,project_id,job.id,{acknowledged:true,acknowledged_at:now()});
    acknowledgeCheck(job.id);
    heldReleases.get(job.id)?.();heldReleases.delete(job.id);owned.delete(job.id);inFlight.delete(job.id);
    return {job:publicJob(updated)};
  }
  async function reviewDecide({workspace_id,project_id,candidate_id,evidence_ids,decision,expected_identity,note}){
    const project=requireActive(workspace_id,project_id);
    const candidate=candidateRecord(workspace_id,project_id,candidate_id);
    const ownerTask=task(workspace_id,project_id,candidate.task_id);
    if(ownerTask.acceptance_digest!==digest(ownerTask.acceptance))throw wbError('stale_resource');
    const evidence=candidateEvidence(workspace_id,project_id,candidate.id);
    const chosen=evidence_ids.map(id=>evidence.find(entry=>entry.id===id)??(()=>{throw wbError('permission_denied');})());
    const identity=reviewIdentity(candidate,chosen,ownerTask);
    if(identity!==expected_identity)throw wbError('stale_resource');
    if(decision==='approved'&&chosen.some(entry=>entry.project_generation!==project.generation||entry.superseded||entry.revoked||entry.verdict!=='pass'||entry.candidate_hash_after!==candidate.hash))throw wbError('stale_resource');
    // Every required definition/profile needs its latest matching pass. Older
    // passes, missing checks, and evidence from prior acceptance versions fail.
    if(decision==='approved'){
      const latest=latestAcceptanceEvidence(workspace_id,project_id,candidate,ownerTask);
      if(latest.some(entry=>!entry)||chosen.length!==latest.length||new Set(chosen.map(entry=>entry.id)).size!==chosen.length||latest.some(entry=>!chosen.some(selected=>selected.id===entry.id)))throw wbError('stale_resource');
      validatePinned(ownerTask,candidate,project);
      if(data.list('jobs',workspace_id,project_id).some(job=>job.candidate_id===candidate.id&&(inFlight.has(job.id)||job.status==='finalization_pending'||job.status==='outcome_unknown'&&!job.acknowledged)))throw wbError('busy');
    }
    // Approval re-verifies the ACTUAL private candidate tree, not just the
    // persisted hash: an out-of-band edit after the passing check invalidates
    // the evidence even though no API edit occurred.
    if(decision==='approved'&&rehashCandidate(candidate).hash!==candidate.hash)throw wbError('stale_resource');
    // An approval over a candidate whose source capture no longer matches the
    // identified target is stale: it needs a fresh candidate and review. The
    // original project is never written.
    if(decision==='approved'&&targetChanged(captureSource(workspace_id,project_id),candidate))throw wbError('stale_resource');
    let source_repository=null;
    if(decision==='approved'&&(project.git_mapping||fs.existsSync(path.join(project.root,'.git')))){
      const observation=await repositorySnapshot(project,captureProject(project),{scratchRoot:path.join(store.root,'workbench-review-scratch')});
      if(observation.state!=='available')throw wbError('unsupported');
      source_repository={head:observation.head,head_reference:observation.head_reference};
      if(requireActive(workspace_id,project_id).generation!==project.generation||candidateRecord(workspace_id,project_id,candidate_id).hash!==candidate.hash||task(workspace_id,project_id,ownerTask.id).acceptance_digest!==ownerTask.acceptance_digest||rehashCandidate(candidate).hash!==candidate.hash||targetChanged(captureSource(workspace_id,project_id),candidate))throw wbError('stale_resource');
      // Repository observation awaits bounded subprocesses. Another tab may have
      // admitted a newer check meanwhile; revalidate the entire verdict at commit.
      const latest=latestAcceptanceEvidence(workspace_id,project_id,candidate,ownerTask);
      if(latest.some(entry=>!entry)||latest.length!==chosen.length||latest.some(entry=>!chosen.some(selected=>selected.id===entry.id)))throw wbError('stale_resource');
      if(data.list('jobs',workspace_id,project_id).some(job=>job.candidate_id===candidate.id&&(inFlight.has(job.id)||job.status==='finalization_pending'||job.status==='outcome_unknown'&&!job.acknowledged)))throw wbError('busy');
    }
    const existing=data.list('reviews',workspace_id,project_id).find(entry=>entry.review_identity===identity&&entry.decision===decision&&digest(entry.source_repository??null)===digest(source_repository));
    if(existing)return {review:publicReview(existing),idempotent:true};
    const review=data.create('reviews',{workspace_id,project_id,task_id:ownerTask.id,candidate_id:candidate.id,candidate_hash:candidate.hash,evidence_ids:chosen.map(entry=>entry.id),decision,review_identity:identity,source_repository,acceptance_version:ownerTask.acceptance_version,acceptance_digest:ownerTask.acceptance_digest,actor:'owner',accept_is_merge:false,...(note?{note}:{})});
    const updatedTask=revise('tasks',workspace_id,project_id,ownerTask.id,{status:decision==='approved'?'accepted':'rejected'});
    return {review:publicReview(review),task:updatedTask};
  }
  async function contextSource({workspace_id,project_id,job_id}){
    requireActive(workspace_id,project_id);
    const job=data.get('jobs',workspace_id,project_id,job_id);
    const evidence=projectedEvidence(workspace_id,project_id).filter(entry=>entry.job_id===job.id).at(-1)??null;
    const text=summaryText(job,evidence);
    const hash=sha(text);
    const previewBytes=Buffer.byteLength(evidence?.stdout_preview??'','utf8')+Buffer.byteLength(evidence?.stderr_preview??'','utf8');
    // The recorded log may exceed the bounded previews or hit the cap. The
    // context snapshot is an exact prefix, not a full replay, so it must say so.
    const truncated=!!evidence&&(evidence.log_bytes>previewBytes||evidence.log_bytes>=CHECK_LIMITS.logBytes);
    return {text,hash,captured_at:now(),resource_id:job.id,truncated,
      provenance:{kind:'job',job_id:job.id,task_id:job.task_id,candidate_id:job.candidate_id,candidate_hash:job.candidate_hash,op_id:job.op_id,evidence_id:evidence?.id??null,definition_id:job.definition_id,verdict:evidence?.verdict??null,exit_code:evidence?.exit_code??null,process_survival_unknown:evidence?.process_survival_unknown===true,bounded:true,
        interleaving:'stdout and stderr are bounded partial prefixes captured separately; their relative order is not preserved and the recorded log is not fully replayed.',
        immutable:'Recorded job/evidence hashes are immutable; a late or revoked result is fenced and never presented as verified.'}};
  }
  function summaryText(job,evidence){
    const limit=65536;
    const parts=[
      `Workbench job ${job.id} (recorder evidence, not a claim)`,
      `status=${job.status} candidate=${job.candidate_id} candidate_hash=${job.candidate_hash}`,
      `definition=${job.definition_id} spec_digest=${job.spec_digest}`,
      `acceptance_version=${job.acceptance_version} acceptance_digest=${job.acceptance_digest}`,
      evidence?`verdict=${evidence.verdict} exit_code=${evidence.exit_code} timed_out=${evidence.timed_out}`:'verdict=not_recorded',
      evidence?`candidate_hash_before=${evidence.candidate_hash_before} candidate_hash_after=${evidence.candidate_hash_after}`:'',
      evidence?'--- stdout (bounded) ---\n'+(evidence.stdout_preview||''):'',
      evidence?'--- stderr (bounded) ---\n'+(evidence.stderr_preview||''):'',
    ].filter(Boolean).join('\n');
    return parts.length>limit?`${parts.slice(0,limit)}\n[bounded]`:parts;
  }
  function executionState({workspace_id,project_id}){
    requireScope(workspace_id,project_id);
    recover(workspace_id,project_id);
    const tasks=data.list('tasks',workspace_id,project_id);
    const candidates=data.list('candidates',workspace_id,project_id).map(publicCandidate);
    const jobs=data.list('jobs',workspace_id,project_id).map(publicJob);
    const evidence=projectedEvidence(workspace_id,project_id).map(publicEvidence);
    const reviews=data.list('reviews',workspace_id,project_id).map(publicReview);
    const review_identity={},unknown={},target_changed={};
    const source=captureSource(workspace_id,project_id);
    for(const candidate of candidates){
      const ownerTask=tasks.find(entry=>entry.id===candidate.task_id);
      target_changed[candidate.id]=targetChanged(source,candidate);
      if(!ownerTask)continue;
      try{review_identity[candidate.id]=reviewIdentityFor(workspace_id,project_id,candidate,ownerTask);}catch{}
    }
    for(const job of jobs)if(job.status==='outcome_unknown'&&job.acknowledged!==true)unknown[job.id]=ackDigest(job);
    return {tasks,candidates,jobs,evidence,reviews,review_identity,target_changed,unknown_jobs:unknown,active_count:inFlight.size,health:health(),revoked:source.project===null,definitions:Object.values(CHECK_DEFINITIONS).map(definition=>({id:definition.id,executable:definition.executable,args:[...definition.args],limits:CHECK_LIMITS,policy:CHECK_POLICY})),policy:EXECUTION_POLICY,execution:EXECUTION_POLICY};
  }

  async function dispatch(body,principal={kind:'owner'}){
    if(closed)throw wbError('unavailable');
    if(!validateExecution(body))throw wbError('invalid_request');
    if(store&&typeof store.read==='function')store.read(body.workspace_id);
    switch(body.action){
      case 'execution_state':return executionState(body);
      case 'task_create':return createTask(body);
      case 'task_acceptance_preview':return taskAcceptancePreview(body);
      case 'task_acceptance_approve':return taskAcceptanceApprove(body);
      case 'candidate_preview':return candidatePreview(body);
      case 'candidate_create':return candidateCreate(body);
      case 'candidate_get':return candidateGet(body);
      case 'candidate_version_get':return candidateVersionGet(body);
      case 'candidate_version_read':return candidateVersionRead(body);
      case 'candidate_read':return candidateRead(body);
      case 'candidate_export':return candidateExport(body);
      case 'candidate_edit':return candidateEdit(body);
      case 'candidate_apply':return candidateApply({...body,principal});
      case 'submission_create':return submissionCreate(body);
      case 'attempt_create':return attemptCreate(body);
      case 'check_preview':return checkPreview(body);
       case 'check_run':return checkRun(body,principal);
       case 'check_start':return startApprovedCheck(body,principal);
      case 'check_cancel':return checkCancel(body);
      case 'job_acknowledge':return jobAcknowledge(body);
      case 'job_finalize_retry':return recoverFinalization(body);
      case 'job_get':{
        requireScope(body.workspace_id,body.project_id);recover(body.workspace_id,body.project_id);
        const job=data.get('jobs',body.workspace_id,body.project_id,body.job_id);
        const evidence=projectedEvidence(body.workspace_id,body.project_id).filter(entry=>entry.job_id===job.id).map(publicEvidence);
        return {job:publicJob(job),evidence};
      }
      case 'review_decide':return reviewDecide(body);
      case 'context_source':return {context:await contextSource(body)};
      default:throw wbError('unsupported');
    }
  }
  function onRevoke(projectId){
    if(typeof projectId!=='string'||!projectId)throw wbError('invalid_request');
    for(const id of inFlight){const row=data.db.prepare('SELECT project_id FROM wb_jobs WHERE id=?').get(id);if(row?.project_id===projectId)fencedJobs.add(id);}
    for(const [id,identity] of owned)if(identity.project_id===projectId)fencedJobs.add(id);
    for(const [id,preview] of previews)if(preview.project_id===projectId)previews.delete(id);
    // Revocation fences FUTURE grants and late results. It never kills a running
    // job; only an explicit check_cancel stops a process, and only when its
    // recorded process identity still matches.
    return {revoked:true,active_jobs:inFlight.size,cancelled:0};
  }
  function close(){
    if(closed)return;
    closed=true;
    // Clean up process groups this process still owns. Identity-checked cancel;
    // if termination cannot be confirmed the job is marked unknown, never a
    // silent success and never a future blind start.
    for(const [jobId,identity] of owned){
      let stopped=false;
      try{stopped=cancelCheck({job_id:jobId,pid:identity.pid,started_at:identity.process_start}).requested;}catch{}
      try{revise('jobs',identity.workspace_id,identity.project_id,jobId,{status:stopped?'cancel_requested':'outcome_unknown',ended_at:now(),acknowledged:false,outcome_note:stopped?'Server shutting down; cancellation requested for the identity-verified process group.':'Server shutting down with a child whose termination cannot be confirmed; outcome unknown and never replayed.'});}catch{}
    }
    owned.clear();inFlight.clear();
  }
  recoverAll();
  const {verifyPatchArtifact,retryPatchArtifact,acknowledgePatchArtifactUnknown,cancelPatchArtifact,patchArtifactRecovery}=createArtifactVerifier({store,records,data,gate:serial,now,verifyCurrent:({workspace_id,project_id,patch,candidate,task,review,project})=>{
    const active=records.project(workspace_id,project_id);
    if(active.generation!==project.generation)throw wbError('stale_resource');
    if(closed||!health().healthy||unknownJobs(workspace_id,project_id).length||candidate.project_generation!==project.generation||task.acceptance_digest!==digest(task.acceptance)||review.candidate_id!==candidate.id||review.candidate_hash!==candidate.hash||review.review_identity!==patch.review_identity)throw wbError('stale_resource');
    validatePinned(task,candidate,project);
    if(rehashCandidate(candidate).hash!==candidate.hash||reviewIdentityFor(workspace_id,project_id,candidate,task)!==review.review_identity||!latestAcceptanceEvidence(workspace_id,project_id,candidate,task).every(Boolean))throw wbError('stale_resource');
  }});
  return {dispatch,contextSource,onRevoke,close,health,recoverFinalization,startApprovedCheck,verifyPatchArtifact,retryPatchArtifact,acknowledgePatchArtifactUnknown,cancelPatchArtifact,patchArtifactRecovery,activeCount:()=>inFlight.size,activeChecks:()=>activeCheckCount(),unknownJobDigest:(workspaceId,projectId)=>unknownJobs(workspaceId,projectId).map(ackDigest),records:data};
}
