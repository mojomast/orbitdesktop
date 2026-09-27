import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {wbError} from './workbench-store.mjs';
import {WORKBENCH_RECORD_KINDS} from './workbench-data.mjs';
import {LIVE_LIMITS,liveReferenceSchema,validateLiveItem} from '../contracts/workbench-live-v1.mjs';
import {readLiveCandidateDiff} from './workbench-live-diff.mjs';

// Private, workspace-independent observability projection. This database is NOT
// the source of truth: it is a bounded, append-only, best-effort record that a
// live UI can reconnect to. Authoritative WorkbenchData rows always win. The
// separate file means no core workspace schema bump and no cross-contamination
// with layout checkpoints, receipts or workspace events.
export const LIVE_REFERENCE_KINDS=Object.freeze([...liveReferenceSchema.properties.kind.enum]);
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LIVE_DB_FILE='workbench-live.sqlite';
const TERMINAL_JOB=new Set(['completed','failed','cancelled','inconclusive','outcome_unknown']);
const ACTIVE_GRANT=new Set(['starting','running','stop_requested']);

const liveSchemaSql=`
CREATE TABLE IF NOT EXISTS live_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt_id TEXT,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('create','update','snapshot')),
  project_generation INTEGER,
  at INTEGER NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json))
);
CREATE UNIQUE INDEX IF NOT EXISTS live_events_identity
  ON live_events(workspace_id,project_id,kind,record_id,revision);
CREATE INDEX IF NOT EXISTS live_events_scope
  ON live_events(workspace_id,project_id,seq);
CREATE INDEX IF NOT EXISTS live_events_attempt
  ON live_events(workspace_id,project_id,attempt_id,seq);
CREATE TABLE IF NOT EXISTS live_floors(
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  floor INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,project_id,attempt_key)
);
-- Durable high-water mark per record, independent of the pruned event rows.
-- It prevents reconcile from re-appending a source revision that was already
-- projected and then pruned. Bounded by the authoritative record caps.
CREATE TABLE IF NOT EXISTS live_projected(
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  projected_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,project_id,kind,record_id)
);
`;

const STATUS_MAP=Object.freeze({
  created:'ready',approved:'ready',open:'ready',candidate_ready:'ready',ready:'ready',info:'info',
  starting:'waiting',running:'running',in_progress:'running',started:'running',stop_requested:'waiting',paused_budget:'waiting',
  // A cancellation request is not a confirmed cancellation; termination can
  // still be unconfirmed, so it stays `waiting` until a confirmed terminal state.
  cancel_requested:'waiting',cancelling:'waiting',
  pending:'pending',finalization_pending:'pending',result_pending:'pending',preparing:'pending',verifying:'running',
  completed:'completed',checked:'completed',accepted:'completed',pass:'completed',passed:'completed',available:'completed',verified:'completed',
  failed:'failed',rejected:'failed',fail:'failed',denied:'denied',
  // Revocation is an access fence, not proof the process stopped.
  stopped:'stopped',revoked:'unknown',cancelled:'cancelled',
  inconclusive:'unknown',outcome_unknown:'unknown',dispatch_unknown:'unknown',acknowledged_unknown:'unknown',unknown:'unknown',expired:'unknown',unavailable:'unknown',
  superseded:'info',fenced:'unknown',legacy_unknown:'unknown',explanation_unavailable:'unknown',
});
const statusFor=raw=>Object.hasOwn(STATUS_MAP,raw)?STATUS_MAP[raw]:'info';
const KIND_LABEL=Object.freeze({
  tasks:'task',attempts:'attempt',contexts:'context',disclosures:'disclosure',submissions:'submission',
  candidates:'candidate',jobs:'job',evidence:'evidence',reviews:'review',grants:'grant',toolcalls:'toolcall',
  profiles:'profile',integrations:'integration',annotations:'annotation',results:'result',cards:'card',patches:'patch',
});
const CATEGORY=Object.freeze({
  tasks:'agent',attempts:'agent',grants:'agent',results:'agent',cards:'agent',disclosures:'agent',submissions:'agent',profiles:'agent',
  toolcalls:'tools',candidates:'files',patches:'files',integrations:'files',contexts:'files',
  jobs:'checks',evidence:'evidence',reviews:'evidence',annotations:'warnings',
});
const short=(value,max=240)=>typeof value==='string'?[...value].slice(0,max).join(''):value;

function provenanceKind(record){return record?.provenance?.initiated_by?.kind;}
// Authority reflects who actually produced the fact, not just who started a run.
// A reconciled snapshot keeps recorder authority only for structured evidence
// itself; every other current-state observation is labelled observed.
function authorityFor(kind,record,phase){
  if(phase==='snapshot'&&kind!=='evidence')return 'observed';
  if(kind==='evidence')return 'recorder';
  switch(kind){
    // Running checks and artifact observations are the service observing a
    // process; only a verified artifact is a recorder-produced final fact.
    case 'jobs':return 'observed';
    // A patch receipt is verified only when its recorder verification says so;
    // the receipt status itself is an availability state.
    case 'patches':return record.verification?.status==='verified'?'recorder':'observed';
    case 'reviews':case 'cards':return 'human';
    // A native tool request is the agent acting; its completion is observed.
    case 'toolcalls':return record.status==='started'?'agent':'observed';
    case 'results':return 'observed';
    // Grant lifecycle is owner-controlled; a stop request is a human request,
    // distinct from a confirmed stop that the service observed.
    case 'grants':return record.status==='approved'||record.status==='stop_requested'?'human':'observed';
    case 'tasks':case 'attempts':return 'human';
    default:
      if(record?.actor==='native_agent')return 'agent';
      if(record?.actor==='owner')return 'human';
      return 'observed';
  }
}
// Exact candidate identity carried by a record, used only to match a retained
// candidate generation to one attempt. Never substitutes a newer generation.
function candidateRefFor(kind,record){
  switch(kind){
    case 'candidates':return {candidate_id:record.id,generation:Number.isSafeInteger(record.generation)?record.generation:null,hash:record.hash};
    case 'reviews':return {candidate_id:record.candidate_id,generation:null,hash:record.candidate_hash};
    case 'patches':return {candidate_id:record.candidate_id,generation:Number.isSafeInteger(record.candidate_generation)?record.candidate_generation:null,hash:record.candidate_hash};
    case 'jobs':return {candidate_id:record.candidate_id,generation:Number.isSafeInteger(record.candidate_generation)?record.candidate_generation:null,hash:record.candidate_hash};
    case 'evidence':return {candidate_id:record.candidate_id,generation:null,hash:record.candidate_hash_after??record.candidate_hash_before};
    default:return null;
  }
}
function durationFor(record){
  const start=record.started_at??record.created_at,end=record.ended_at??record.updated_at;
  if(Number.isFinite(start)&&Number.isFinite(end)&&end>=start)return end-start;
  return undefined;
}

// Bounded recorder test totals from the actual parseTestResults shape:
// {tests,passed,failed,skipped,todo,required_files:[],covered_files:[],complete,valid,success}.
// Arrays are reduced to lengths; any model text is never consulted.
function recorderCounts(testResults){
  if(!testResults||typeof testResults!=='object')return null;
  const source=(testResults.test_summary&&typeof testResults.test_summary==='object')?testResults.test_summary:testResults;
  const num=value=>Number.isFinite(value)?value:undefined;
  const len=value=>Array.isArray(value)?value.length:undefined;
  const counts={
    passed:num(source.passed),tests:num(source.tests),
    covered_files:len(source.covered_files),required_files:len(source.required_files),
    failed:num(source.failed),skipped:num(source.skipped),todo:num(source.todo),
    complete:source.complete===true?1:undefined,
  };
  return Object.values(counts).some(value=>value!==undefined)?counts:null;
}
const recorderFieldOrder=Object.freeze(['passed','tests','covered_files','required_files','failed','skipped','todo','complete']);

// Whitelisted scalar facts only. Never raw source, tool arguments/results,
// context snapshots, log paths, prompts, credentials or hidden reasoning.
function safeFields(kind,record){
  const fields=[];
  const push=(label,value)=>{
    if(value===undefined||value===null)return;
    if(typeof value==='number'&&Number.isFinite(value))fields.push({label,value});
    else if(typeof value==='string')fields.push({label,value:short(value,240)});
  };
  switch(kind){
    case 'tasks':push('acceptance_version',record.acceptance_version);push('status',short(record.status,80));break;
    case 'attempts':push('acceptance_version',record.acceptance_version);push('status',short(record.status,80));break;
    case 'grants':push('calls_used',record.calls_used);push('checks_used',record.checks_used);push('repairs_used',record.repairs_used);push('runtime_status',short(record.runtime_status,80));break;
    case 'toolcalls':{
      push('action',short(record.action,80));push('status',short(record.status,80));push('attempt_id',record.attempt_id);push('grant_id',record.grant_id);
      // Completed candidate patch: bounded changed-file count plus the first
      // file's old/new hashes. Never source content or raw arguments.
      const changes=Array.isArray(record.result_changes)?record.result_changes:[];
      if(changes.length){
        push('changed_files',changes.length);
        const first=changes[0];
        if(first&&typeof first.path==='string')push('first_path',first.path);
        if(typeof first?.old_hash==='string')push('first_old',first.old_hash);
        if(typeof first?.new_hash==='string')push('first_new',first.new_hash);
      }
      break;
    }
    case 'candidates':push('generation',record.generation);push('total_bytes',record.total_bytes);push('files',Array.isArray(record.files)?record.files.length:undefined);push('limited',record.limited===true?1:0);break;
    case 'jobs':push('exit_code',record.exit_code);push('log_bytes',record.log_bytes);push('definition_id',short(record.definition_id,80));push('timed_out',record.timed_out===true?1:0);push('process_survival_unknown',record.process_survival_unknown===true?1:0);break;
    case 'evidence':{
      // Recorder counts first, in a fixed order; technical fields after.
      const counts=recorderCounts(record.test_results);
      if(counts)for(const label of recorderFieldOrder)push(label,counts[label]);
      push('exit_code',record.exit_code);push('log_bytes',record.log_bytes);push('timed_out',record.timed_out===true?1:0);
      break;
    }
    case 'reviews':push('decision',short(record.decision,80));push('evidence_count',Array.isArray(record.evidence_ids)?record.evidence_ids.length:undefined);break;
    case 'results':push('availability',short(record.availability,80));push('hermes_completed',record.hermes_completed===true?1:0);break;
    case 'contexts':push('bytes',typeof record.snapshot?.bytes==='number'?record.snapshot.bytes:undefined);break;
    case 'patches':{
      push('status',short(record.status,80));push('artifact_bytes',record.bytes);
      // Verified artifact: recorder-aggregated totals over its per-check results.
      const verification=record.verification&&typeof record.verification==='object'?record.verification:null;
      const results=Array.isArray(verification?.results)?verification.results:[];
      if(verification?.status==='verified')push('verified_checks',results.length);
      const totals={tests:0,passed:0,failed:0,skipped:0,todo:0};let seen=false;
      for(const item of results){const counts=recorderCounts(item?.test_results);if(!counts)continue;seen=true;for(const key of Object.keys(totals))if(Number.isFinite(counts[key]))totals[key]+=counts[key];}
      if(seen){push('passed',totals.passed);push('tests',totals.tests);push('failed',totals.failed);push('skipped',totals.skipped);push('todo',totals.todo>0?totals.todo:undefined);}
      break;
    }
    case 'annotations':push('annotation',short(record.kind,80));break;
    default:push('status',short(record.status,80));
  }
  return fields.slice(0,12);
}
function referenceFor(kind,record){
  switch(kind){
    case 'toolcalls':{
      const reference={kind:'toolcall',id:record.id};
      const applied=record.result_candidate;
      if(applied&&typeof applied.id==='string'){
        reference.candidate_id=applied.id;
        if(Number.isSafeInteger(applied.generation))reference.generation=applied.generation;
        if(typeof applied.hash==='string')reference.hash=applied.hash;
      }
      return reference;
    }
    case 'candidates':return {kind:'candidate',id:record.id,candidate_id:record.id,generation:record.generation,hash:record.hash};
    case 'jobs':return {kind:'job',id:record.id};
    case 'evidence':return {kind:'evidence',id:record.id,candidate_id:record.candidate_id,hash:record.candidate_hash_after};
    case 'results':return {kind:'result',id:record.id,candidate_id:record.candidate_id,generation:record.candidate_generation,hash:record.candidate_hash};
    case 'reviews':return {kind:'review',id:record.id};
    case 'patches':return {kind:'artifact',id:record.id};
    default:return undefined;
  }
}
function summaryFor(kind,record){
  switch(kind){
    case 'tasks':return `Task ${short(record.title,120)||record.id}`;
    case 'attempts':return `Attempt ${record.id}`;
    case 'grants':return `Native grant ${short(record.status,80)||'unknown'}`;
    case 'toolcalls':return `Tool ${short(record.action,80)||'call'}`;
    case 'candidates':return `Candidate generation ${record.generation??'?'}`;
    case 'jobs':return `Check ${short(record.definition_id,80)||record.id}`;
    case 'evidence':return `Recorded evidence ${short(record.verdict,80)||'unknown'}`;
    case 'reviews':return `Human review ${short(record.decision,80)||'recorded'}`;
    case 'results':return `Task result ${short(record.availability,80)||'pending'}`;
    case 'cards':return `Conversation card ${record.id}`;
    case 'contexts':return `Captured context ${record.id}`;
    case 'patches':return `Private patch ${short(record.status,80)||'recorded'}`;
    case 'integrations':return `Integration ${short(record.status,80)||'recorded'}`;
    case 'annotations':return `Annotation ${short(record.kind,80)||'recorded'}`;
    default:return `${KIND_LABEL[kind]??kind} ${short(record.status,80)||record.id}`;
  }
}

/** Pure projection of one authoritative record revision into the lead-owned
 * LiveItem contract. No sequence: the durable row's global sequence is attached
 * on read. Never contains raw content. */
export function projectWorkbenchEvent(kind,record,{phase='update',at=record.updated_at??record.created_at??null,related=false}={}){
  if(!WORKBENCH_RECORD_KINDS.includes(kind))throw wbError('invalid_request');
  const rawStatus=kind==='evidence'?record.verdict:kind==='reviews'?record.decision:kind==='results'?record.availability:record.status;
  let category=CATEGORY[kind]??'agent';
  // Revocation / fenced evidence is a warning, never a quiet terminal state.
  if(rawStatus==='revoked'||record.revoked===true)category='warnings';
  const event={
    version:1,
    id:`${kind}:${record.id}:${record.revision}`,
    at:Number.isFinite(at)?at:null,
    authority:authorityFor(kind,record,phase),
    category,
    kind:KIND_LABEL[kind]??kind,
    summary:short(summaryFor(kind,record),240),
    status:statusFor(rawStatus),
  };
  const duration=durationFor(record);
  if(duration!==undefined)event.duration_ms=duration;
  // Safe request target for a tool call (whitelisted path/id, never arguments).
  if(kind==='toolcalls'&&typeof record.safe_target==='string'&&record.safe_target)event.target=short(record.safe_target,512);
  const reference=referenceFor(kind,record);
  if(reference)event.reference=reference;
  const fields=safeFields(kind,record);
  // A reconciled snapshot is a current-state observation, made explicit without
  // changing the record's producer authority below.
  if(phase==='snapshot')fields.push({label:'observed',value:'reconciled_snapshot'});
  // Candidate/review/patch lifecycle whose owning attempt cannot be proven is a
  // related snapshot, not an attributed mutation.
  if(related)fields.push({label:'origin',value:'related_snapshot'});
  if(fields.length>12)fields.length=12;
  if(fields.length)event.fields=fields;
  if(JSON.stringify(event).length>LIVE_LIMITS.eventBytes){
    delete event.fields;
    if(JSON.stringify(event).length>LIVE_LIMITS.eventBytes)delete event.duration_ms;
  }
  if(JSON.stringify(event).length>LIVE_LIMITS.eventBytes)throw wbError('limit_exceeded');
  if(!validateLiveItem(event))throw wbError('invalid_request');
  return event;
}

const clampLimit=value=>Number.isSafeInteger(value)&&value>0?Math.min(value,LIVE_LIMITS.page):LIVE_LIMITS.page;

export function createWorkbenchLive({store,records,data,gate,execution,native,now=Date.now}={}){
  if(!store||typeof store.root!=='string'||!path.isAbsolute(store.root))throw Error('createWorkbenchLive requires an absolute store runtime root');
  if(!records||typeof records.project!=='function')throw Error('createWorkbenchLive requires a WorkbenchStore');
  if(!data||typeof data.subscribe!=='function')throw Error('createWorkbenchLive requires a WorkbenchData with subscribe');
  const root=store.root;
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const filename=path.join(root,LIVE_DB_FILE);
  const sidecars=[filename,`${filename}-wal`,`${filename}-shm`,`${filename}-journal`];
  const assertPrivatePath=target=>{
    let stat;
    try{stat=fs.lstatSync(target);}catch(error){if(error?.code==='ENOENT')return;throw error;}
    if(stat.isSymbolicLink())throw Object.assign(Error('workbench live database path is a symlink'),{code:'permission_denied'});
    if(stat.nlink>1)throw Object.assign(Error('workbench live database path is hardlinked'),{code:'permission_denied'});
    if(!stat.isFile())throw Object.assign(Error('workbench live database path is not a regular file'),{code:'permission_denied'});
  };
  for(const sidecar of sidecars)assertPrivatePath(sidecar);
  if(!fs.existsSync(filename)){const handle=fs.openSync(filename,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR,0o600);fs.closeSync(handle);}
  const lockDown=()=>{for(const sidecar of sidecars){try{fs.chmodSync(sidecar,0o600);}catch{}}};
  lockDown();
  const db=new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(liveSchemaSql);
  lockDown();
  const artifactRoot=path.resolve(root,'workbench-execution');

  const subscribers=new Set();
  let closed=false;
  let unsubscribeData=null;
  // Projection failures are counted and swallowed; they never propagate into an
  // authoritative action or the caller's operation error channel.
  let projectionErrors=0;

  const notify=notification=>{for(const listener of [...subscribers]){try{listener(notification);}catch{}}};

  // Retention is per-attempt bucket (attempt_id NULL is the project-level bucket),
  // matching contract LIVE_LIMITS.retainedPerAttempt.
  const prune=(workspaceId,projectId,attemptId)=>{
    const filter=attemptId?' AND attempt_id=?':' AND attempt_id IS NULL';
    const params=[workspaceId,projectId,...(attemptId?[attemptId]:[])];
    const cutoff=db.prepare(`SELECT seq FROM live_events WHERE workspace_id=? AND project_id=?${filter} ORDER BY seq DESC LIMIT 1 OFFSET ?`).get(...params,LIVE_LIMITS.retainedPerAttempt-1);
    if(!cutoff)return;
    db.prepare(`DELETE FROM live_events WHERE workspace_id=? AND project_id=?${filter} AND seq<?`).run(...params,cutoff.seq);
    const key=attemptId??'';
    const floor=Math.max(cutoff.seq-1,db.prepare('SELECT floor FROM live_floors WHERE workspace_id=? AND project_id=? AND attempt_key=?').get(workspaceId,projectId,key)?.floor??0);
    db.prepare('INSERT INTO live_floors(workspace_id,project_id,attempt_key,floor) VALUES(?,?,?,?) ON CONFLICT(workspace_id,project_id,attempt_key) DO UPDATE SET floor=excluded.floor').run(workspaceId,projectId,key,floor);
  };
  const floorFor=(workspaceId,projectId,attemptId)=>db.prepare('SELECT floor FROM live_floors WHERE workspace_id=? AND project_id=? AND attempt_key=?').get(workspaceId,projectId,attemptId??'')?.floor??0;
  // A project-scope page can be missing rows pruned from any attempt bucket, so
  // its floor is the maximum bucket floor. An attempt page uses its own floor.
  const retainedFloor=(workspaceId,projectId,attemptId)=>attemptId?floorFor(workspaceId,projectId,attemptId):db.prepare('SELECT MAX(floor) AS floor FROM live_floors WHERE workspace_id=? AND project_id=?').get(workspaceId,projectId)?.floor??0;
  // Resolve one attempt from an authenticated grant id. The stored value is the
  // attempt id string, not a grant object.
  const grantAttempt=(workspace_id,project_id,grantId)=>{
    if(typeof grantId!=='string'||!grantId)return null;
    try{const value=data.get('grants',workspace_id,project_id,grantId)?.attempt_id;return typeof value==='string'&&value?value:null;}catch{return null;}
  };
  // Exact candidate-generation attribution. A record is attributed only when a
  // single attempt is provably responsible:
  //   1. a completed native candidate_patch result naming this exact candidate
  //      generation/hash;
  //   2. an in-flight native candidate_patch for this candidate (the mutation is
  //      happening now, native lane is serial);
  //   3. a unique attempt whose candidate_hash matches the referenced hash.
  // Anything ambiguous returns null and is never attributed to a newest attempt.
  const resolveCandidateAttempt=(workspace_id,project_id,ref)=>{
    if(!ref||typeof ref.candidate_id!=='string'||!ref.candidate_id)return null;
    let calls=[],attempts=[];
    try{calls=data.list('toolcalls',workspace_id,project_id);}catch{}
    try{attempts=data.list('attempts',workspace_id,project_id);}catch{}
    const completed=new Set(),started=new Set();
    for(const call of calls){
      if(call.action!=='candidate_patch'||typeof call.attempt_id!=='string'||!call.attempt_id)continue;
      if(call.status==='completed'&&call.result_candidate){
        const result=call.result_candidate;
        if(result.id!==ref.candidate_id)continue;
        if(ref.generation!==null&&result.generation!==ref.generation)continue;
        if(ref.hash&&result.hash!==ref.hash)continue;
        completed.add(call.attempt_id);
      }else if(call.status==='started'&&call.candidate_id===ref.candidate_id){
        started.add(call.attempt_id);
      }
    }
    if(completed.size===1)return [...completed][0];
    if(completed.size>1)return null;
    if(started.size===1)return [...started][0];
    if(started.size>1)return null;
    const bound=[...new Set(attempts.filter(attempt=>attempt.candidate_id===ref.candidate_id&&(!ref.hash||attempt.candidate_hash===ref.hash)).map(attempt=>attempt.id))];
    return bound.length===1?bound[0]:null;
  };
  const attemptIdFor=(kind,record)=>{
    if(kind==='attempts')return record.id;
    if(typeof record.attempt_id==='string'&&record.attempt_id)return record.attempt_id;
    const initiated=record?.provenance?.initiated_by;
    if(initiated&&typeof initiated.attempt_id==='string'&&initiated.attempt_id)return initiated.attempt_id;
    if(initiated&&initiated.grant_id){const resolved=grantAttempt(record.workspace_id,record.project_id,initiated.grant_id);if(resolved)return resolved;}
    const ref=candidateRefFor(kind,record);
    if(ref)return resolveCandidateAttempt(record.workspace_id,record.project_id,ref);
    return null;
  };
  const append=({phase,kind,record})=>{
    if(closed)return null;
    const workspace_id=record.workspace_id,project_id=record.project_id;
    if(!UUID.test(workspace_id??'')||!UUID.test(project_id??''))return null;
    let attemptId;
    try{attemptId=attemptIdFor(kind,record);}catch{attemptId=null;}
    // A candidate/review/patch whose origin cannot be proven is labelled a
    // related snapshot rather than silently claimed by an attempt.
    const related=attemptId===null&&['candidates','reviews','patches'].includes(kind);
    let event;
    try{event=projectWorkbenchEvent(kind,record,{phase,at:record.updated_at??record.created_at??now(),related});}
    catch{projectionErrors++;return null;}
    try{
      // Durable high-water: never re-project a revision below one already seen,
      // even after its event row was pruned. Prevents reconcile churn.
      const seen=db.prepare('SELECT revision FROM live_projected WHERE workspace_id=? AND project_id=? AND kind=? AND record_id=?').get(workspace_id,project_id,kind,record.id);
      if(seen&&Number.isSafeInteger(seen.revision)&&seen.revision>=record.revision)return null;
      // Replay scope is fixed when a row is written; existing rows are never
      // re-attributed retroactively.
      const info=db.prepare(`INSERT OR IGNORE INTO live_events(workspace_id,project_id,attempt_id,kind,record_id,revision,phase,project_generation,at,event_json)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(workspace_id,project_id,attemptId,kind,record.id,record.revision,phase,Number.isSafeInteger(record.project_generation)?record.project_generation:null,event.at??now(),JSON.stringify(event));
      db.prepare(`INSERT INTO live_projected(workspace_id,project_id,kind,record_id,revision,projected_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(workspace_id,project_id,kind,record_id) DO UPDATE SET revision=excluded.revision,projected_at=excluded.projected_at WHERE excluded.revision>live_projected.revision`).run(workspace_id,project_id,kind,record.id,record.revision,now());
      if(info.changes!==1)return null;
      prune(workspace_id,project_id,attemptId);
      lockDown();
      const row=db.prepare('SELECT * FROM live_events WHERE seq=?').get(info.lastInsertRowid);
      const notification={workspace_id:row.workspace_id,project_id:row.project_id,attempt_id:row.attempt_id??null,sequence:row.seq,event:{...JSON.parse(row.event_json),sequence:row.seq}};
      notify(notification);
      return notification;
    }catch{projectionErrors++;return null;}
  };

  const observer=change=>{try{append({phase:change.phase,kind:change.kind,record:change.record});}catch{projectionErrors++;}};

  const reconcile=({workspace_id,project_id}={})=>{
    let added=0;
    const workspaceIds=workspace_id?[workspace_id]:store.db.prepare('SELECT id FROM workspaces ORDER BY id').all().map(row=>row.id);
    for(const workspace of workspaceIds){
      let projects;
      try{projects=records.list(workspace);}catch{continue;}
      for(const project of projects){
        if(project_id&&project.id!==project_id)continue;
        for(const kind of WORKBENCH_RECORD_KINDS){
          let rows;
          try{rows=data.list(kind,workspace,project.id);}catch{continue;}
          for(const record of rows){
            if(!Number.isSafeInteger(record?.revision))continue;
            const seen=db.prepare('SELECT revision FROM live_projected WHERE workspace_id=? AND project_id=? AND kind=? AND record_id=?').get(workspace,project.id,kind,record.id);
            if(seen&&Number.isSafeInteger(seen.revision)&&seen.revision>=record.revision)continue;
            if(append({phase:'snapshot',kind,record}))added++;
          }
        }
      }
    }
    lockDown();
    return {added};
  };

  // Factual gate lane state, never inferred from records or events.
  const lane=()=>{
    try{
      const status=gate?.status?.();
      if(!status||typeof status!=='object')return {agent_busy:false,job_busy:false,unknown:true};
      const uncertain=Number(status.legacy?.uncertain)||0;
      return {agent_busy:status.agent===true,job_busy:status.job===true,unknown:uncertain>0||(Array.isArray(status.quarantines)&&status.quarantines.length>0)};
    }catch{return {agent_busy:false,job_busy:false,unknown:true};}
  };
  // Targeted, non-scanning metrics. Project scope uses SQL counts and a single
  // newest row per table; an attempt scope adds only that attempt's own
  // candidate/grant/job/evidence/result so no other task's candidate can leak.
  const countRows=(table,where,params)=>data.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=? AND project_id=?${where}`).get(...params).n;
  const newestRow=(kind,where,params)=>{
    const row=data.db.prepare(`SELECT record_json FROM wb_${kind} WHERE workspace_id=? AND project_id=?${where} ORDER BY rowid DESC LIMIT 1`).get(...params);
    return row?JSON.parse(row.record_json):null;
  };
  const projectMetrics=(workspace_id,project_id)=>{
    const scope=[workspace_id,project_id];
    return {
      tasks:countRows('wb_tasks','',scope),attempts:countRows('wb_attempts','',scope),candidates:countRows('wb_candidates','',scope),
      grants:countRows('wb_grants','',scope),jobs:countRows('wb_jobs','',scope),evidence:countRows('wb_evidence','',scope),results:countRows('wb_results','',scope),
      active_grants:countRows('wb_grants'," AND json_extract(record_json,'$.status') IN ('starting','running','stop_requested')",scope),
      active_jobs:countRows('wb_jobs'," AND json_extract(record_json,'$.status') NOT IN ('completed','failed','cancelled','inconclusive','outcome_unknown')",scope),
      unknown_jobs:countRows('wb_jobs'," AND (json_extract(record_json,'$.status')='finalization_pending' OR (json_extract(record_json,'$.status')='outcome_unknown' AND json_extract(record_json,'$.acknowledged')!=1))",scope),
      latest_candidate:null,latest_grant:null,latest_job:null,latest_evidence:null,latest_result:null,
    };
  };
  const snapshot=({workspace_id,project_id,attempt_id}={})=>{
    const metrics=projectMetrics(workspace_id,project_id);
    if(typeof attempt_id!=='string'||!attempt_id){
      const latestCandidate=newestRow('candidates','',[workspace_id,project_id]);
      const latestGrant=newestRow('grants','',[workspace_id,project_id]);
      const latestJob=newestRow('jobs','',[workspace_id,project_id]);
      const latestEvidence=newestRow('evidence','',[workspace_id,project_id]);
      const latestResult=newestRow('results','',[workspace_id,project_id]);
      metrics.latest_candidate=latestCandidate?{id:latestCandidate.id,generation:latestCandidate.generation,hash:latestCandidate.hash??null,status:short(latestCandidate.status,80)}:null;
      metrics.latest_grant=latestGrant?{id:latestGrant.id,attempt_id:latestGrant.attempt_id??null,status:short(latestGrant.status,80),runtime_status:short(latestGrant.runtime_status,80)??null,result_status:short(latestGrant.result_status,80)??null}:null;
      metrics.latest_job=latestJob?{id:latestJob.id,status:short(latestJob.status,80),definition_id:short(latestJob.definition_id,80),candidate_id:latestJob.candidate_id??null}:null;
      metrics.latest_evidence=latestEvidence?{id:latestEvidence.id,verdict:short(latestEvidence.verdict,80),candidate_id:latestEvidence.candidate_id??null,job_id:latestEvidence.job_id??null}:null;
      metrics.latest_result=latestResult?{id:latestResult.id,availability:short(latestResult.availability,80),candidate_id:latestResult.candidate_id??null,candidate_generation:latestResult.candidate_generation??null,candidate_hash:latestResult.candidate_hash??null}:null;
      return {scope:'project',attempt_id:null,...metrics};
    }
    // Attempt scope: only this attempt's own linked records.
    const attempt=data.get('attempts',workspace_id,project_id,attempt_id);
    const candidate=attempt?.candidate_id?data.get('candidates',workspace_id,project_id,attempt.candidate_id):null;
    const candidateId=candidate?.id??null;
    const granted=countRows('wb_grants'," AND json_extract(record_json,'$.attempt_id')=?",[workspace_id,project_id,attempt_id]);
    const jobCount=candidateId?countRows('wb_jobs'," AND json_extract(record_json,'$.candidate_id')=?",[workspace_id,project_id,candidateId]):0;
    const resultCount=countRows('wb_results'," AND json_extract(record_json,'$.attempt_id')=?",[workspace_id,project_id,attempt_id]);
    const latestGrant=newestRow('grants'," AND json_extract(record_json,'$.attempt_id')=?",[workspace_id,project_id,attempt_id]);
    const latestJob=candidateId?newestRow('jobs'," AND json_extract(record_json,'$.candidate_id')=?",[workspace_id,project_id,candidateId]):null;
    const latestEvidence=candidateId?newestRow('evidence'," AND json_extract(record_json,'$.candidate_id')=?",[workspace_id,project_id,candidateId]):null;
    const latestResult=newestRow('results'," AND json_extract(record_json,'$.attempt_id')=?",[workspace_id,project_id,attempt_id]);
    return {
      scope:'attempt',attempt_id,...metrics,
      // Attempt scope never reports a project-wide latest record from another task.
      latest_candidate:undefined,latest_grant:undefined,latest_job:undefined,latest_evidence:undefined,latest_result:undefined,
      attempt_granted:granted,attempt_jobs:jobCount,attempt_results:resultCount,
      attempt:{id:attempt.id,status:short(attempt.status,80),task_id:attempt.task_id??null,candidate_id:attempt.candidate_id??null,candidate_hash:attempt.candidate_hash??null,acceptance_version:attempt.acceptance_version??null,project_generation:attempt.project_generation??null},
      candidate:candidate?{id:candidate.id,generation:candidate.generation,hash:candidate.hash??null,status:short(candidate.status,80),total_bytes:candidate.total_bytes??null,files:Array.isArray(candidate.files)?candidate.files.length:null,limited:candidate.limited===true?1:0}:null,
      grant:latestGrant?{id:latestGrant.id,status:short(latestGrant.status,80),runtime_status:short(latestGrant.runtime_status,80)??null,result_status:short(latestGrant.result_status,80)??null,calls_used:latestGrant.calls_used??null,checks_used:latestGrant.checks_used??null,expires_at:latestGrant.expires_at??null,started_at:latestGrant.started_at??null,ended_at:latestGrant.ended_at??null}:null,
      job:latestJob?{id:latestJob.id,status:short(latestJob.status,80),definition_id:short(latestJob.definition_id,80),candidate_id:latestJob.candidate_id??null,started_at:latestJob.started_at??null,ended_at:latestJob.ended_at??null}:null,
      evidence:latestEvidence?{id:latestEvidence.id,verdict:short(latestEvidence.verdict,80),candidate_id:latestEvidence.candidate_id??null,job_id:latestEvidence.job_id??null}:null,
      result:latestResult?{id:latestResult.id,availability:short(latestResult.availability,80),candidate_id:latestResult.candidate_id??null,candidate_generation:latestResult.candidate_generation??null,candidate_hash:latestResult.candidate_hash??null}:null,
    };
  };

  const scopeFilter=attemptId=>attemptId?' AND attempt_id=?':'';
  // Validate an optional supplied attempt against the current project
  // generation. A missing or superseded attempt is fenced, never silently
  // treated as a project-wide page.
  const validateAttempt=(workspace_id,project_id,attempt_id,project)=>{
    if(typeof attempt_id!=='string'||!attempt_id)return null;
    const attempt=data.get('attempts',workspace_id,project_id,attempt_id);
    if(Number.isSafeInteger(attempt.project_generation)&&attempt.project_generation!==project.generation)throw wbError('stale_resource');
    return attempt_id;
  };
  const page=({workspace_id,project_id,attempt_id,after_sequence,limit}={})=>{
    const project=records.project(workspace_id,project_id); // throws if revoked/unknown
    const size=clampLimit(limit);
    const after=Number.isSafeInteger(after_sequence)&&after_sequence>=0?after_sequence:0;
    const attempt=validateAttempt(workspace_id,project_id,attempt_id,project);
    const filter=scopeFilter(attempt);
    const params=[workspace_id,project_id,...(attempt?[attempt]:[])];
    const latest=db.prepare(`SELECT seq FROM live_events WHERE workspace_id=? AND project_id=?${filter} ORDER BY seq DESC LIMIT 1`).get(...params)?.seq??0;
    const oldestRetained=db.prepare(`SELECT seq FROM live_events WHERE workspace_id=? AND project_id=?${filter} ORDER BY seq ASC LIMIT 1`).get(...params)?.seq??0;
    // Cursor-presence semantics (no schema token): a cursor at or after the
    // oldest retained row in this exact scope is a valid retained position and
    // continues paging, even when a different bucket has a higher pruned floor.
    // Reset only a forward cursor, or one below the oldest retained row that is
    // also below this scope's own pruned floor (rows the scope actually lost).
    // A non-matching prefix in a filtered scope is not a gap.
    const scopeFloor=retainedFloor(workspace_id,project_id,attempt);
    const forward=after>latest;
    const stale=oldestRetained>0&&after<oldestRetained-1&&after<scopeFloor;
    const reset_required=forward||stale;
    const start=reset_required?(oldestRetained>0?oldestRetained-1:0):after;
    const rows=db.prepare(`SELECT * FROM live_events WHERE workspace_id=? AND project_id=?${filter} AND seq>? ORDER BY seq LIMIT ?`).all(...params,start,size+1);
    const events=rows.slice(0,size).map(row=>({...JSON.parse(row.event_json),sequence:row.seq}));
    return {
      version:1,
      events,
      after_sequence:events.at(-1)?.sequence??(reset_required?start:after),
      reset_required,
      // True whenever a retained-floor gap exists for this scope (a pruned
      // bucket above the current start), so an old retained cursor never claims
      // an exact/complete history.
      projection_incomplete:reset_required||scopeFloor>start,
      has_more:rows.length>size,
      project_generation:project.generation,
      snapshot:snapshot({workspace_id,project_id,attempt_id:attempt}),
      lane:lane(),
    };
  };

  const requireReference=reference=>{
    if(!reference||typeof reference!=='object'||Array.isArray(reference))throw wbError('invalid_request');
    if(!LIVE_REFERENCE_KINDS.includes(reference.kind))throw wbError('unsupported');
    if(typeof reference.id!=='string'||!UUID.test(reference.id))throw wbError('invalid_request');
    return reference;
  };
  // References must belong to the request scope, not merely the same project.
  // When attempt_id is supplied the referenced record's authoritative link to
  // that attempt is checked; a mismatched or superseded generation fails closed.
  const assertAttemptScope=(kind,record,attempt,project)=>{
    const recordGeneration=Number.isSafeInteger(record.project_generation)?record.project_generation:null;
    if(recordGeneration!==null&&recordGeneration!==project.generation)throw wbError('stale_resource');
    if(!attempt)return;
    // Exact, ambiguity-free attribution only. An unprovable or shared candidate
    // generation fails closed rather than borrowing another attempt's scope.
    const linked=attemptIdFor(kind,record);
    if(linked!==attempt.id)throw wbError('permission_denied');
  };

  const detail=async({workspace_id,project_id,attempt_id,reference}={})=>{
    const ref=requireReference(reference);
    const project=records.project(workspace_id,project_id); // revoked project hard-fences here
    const attempt=typeof attempt_id==='string'&&attempt_id?data.get('attempts',workspace_id,project_id,attempt_id):null;
    if(attempt&&Number.isSafeInteger(attempt.project_generation)&&attempt.project_generation!==project.generation)throw wbError('stale_resource');
    try{
      switch(ref.kind){
        case 'toolcall':{
          const row=data.get('toolcalls',workspace_id,project_id,ref.id);
          assertAttemptScope('toolcalls',row,attempt,project);
          const changes=(Array.isArray(row.result_changes)?row.result_changes:[]).slice(0,32).map(change=>({path:short(change.path,512),op:short(change.op,16),old_hash:change.old_hash??null,new_hash:change.new_hash??null}));
          const applied=row.result_candidate&&typeof row.result_candidate.id==='string'?{id:row.result_candidate.id,generation:row.result_candidate.generation??null,hash:row.result_candidate.hash??null}:null;
          // A recorded tool call is metadata, not verification.
          return {reference:{kind:'toolcall',id:row.id},mode:'metadata',not_diff:true,verified:false,project_generation:project.generation,
            fields:{action:short(row.action,80),status:short(row.status,80),args_digest:row.args_digest??null,result_digest:row.result_digest??null,error:short(row.error,120)??null,changed_files:changes.length,created_at:row.created_at,updated_at:row.updated_at},
            ...(applied?{result_candidate:applied}:{}),...(changes.length?{changes}:{})};
        }
        case 'job':{
          if(!execution||typeof execution.dispatch!=='function')throw wbError('unavailable');
          const result=await execution.dispatch({action:'job_get',workspace_id,project_id,job_id:ref.id});
          const job=result.job;
          assertAttemptScope('jobs',job,attempt,project);
          // A running/finished check record is observed metadata, not verification.
          return {reference:{kind:'job',id:job.id},mode:'job_record',not_diff:true,verified:false,project_generation:project.generation,
            fields:{status:short(job.status,80),definition_id:short(job.definition_id,80),exit_code:job.exit_code??null,acknowledged:job.acknowledged===true,started_at:job.started_at??null,ended_at:job.ended_at??null,outcome_note:short(job.outcome_note,512)??null},
            checks:(result.evidence??[]).map(entry=>({id:entry.id,verdict:short(entry.verdict,80),exit_code:entry.exit_code??null,timed_out:entry.timed_out===true,artifact_hash:entry.artifact_hash??null,log_bytes:entry.log_bytes??null,test_results:recorderCounts(entry.test_results)}))};
        }
        case 'evidence':{
          const entry=data.list('evidence',workspace_id,project_id).find(row=>row.id===ref.id);
          if(!entry)throw wbError('unavailable');
          assertAttemptScope('evidence',entry,attempt,project);
          return {reference:{kind:'evidence',id:entry.id},mode:'evidence_record',not_diff:true,verified:true,project_generation:project.generation,
            fields:{verdict:short(entry.verdict,80),exit_code:entry.exit_code??null,timed_out:entry.timed_out===true,artifact_hash:entry.artifact_hash??null,log_bytes:entry.log_bytes??null,log_hash:entry.log_hash??null,candidate_id:entry.candidate_id??null,candidate_hash:entry.candidate_hash_after??null},
            test_results:recorderCounts(entry.test_results)};
        }
        case 'review':{
          const row=data.get('reviews',workspace_id,project_id,ref.id);
          assertAttemptScope('reviews',row,attempt,project);
          return {reference:{kind:'review',id:row.id},mode:'review_record',not_diff:true,verified:false,project_generation:project.generation,
            fields:{decision:short(row.decision,80),evidence_count:Array.isArray(row.evidence_ids)?row.evidence_ids.length:0,created_at:row.created_at,updated_at:row.updated_at}};
        }
        case 'artifact':{
          const row=data.get('patches',workspace_id,project_id,ref.id);
          assertAttemptScope('patches',row,attempt,project);
          const verification=row.verification&&typeof row.verification==='object'?row.verification:null;
          const results=Array.isArray(verification?.results)?verification.results:[];
          // Only a recorder-verified artifact is verified; per-check counts are
          // bounded recorder totals, never source or model text.
          return {reference:{kind:'artifact',id:row.id},mode:'artifact_receipt',not_diff:true,verified:verification?.status==='verified',project_generation:project.generation,
            fields:{status:short(row.status,80),format:short(row.format,80),artifact_hash:row.artifact_hash??null,bytes:row.bytes??null,verification_status:verification?short(verification.status,80):null,verified_checks:verification?.status==='verified'?results.length:null},
            checks:results.slice(0,8).map(item=>({definition_id:short(item.definition_id,64),verdict:short(item.verdict,40),test_results:recorderCounts(item.test_results)})),
            note:'Private patch receipt metadata only; no artifact bytes are returned here.'};
        }
        case 'candidate':{
          const candidate_id=UUID.test(ref.candidate_id??'')?ref.candidate_id:ref.id;
          const candidateRecord=data.get('candidates',workspace_id,project_id,candidate_id);
          assertAttemptScope('candidates',candidateRecord,attempt,project);
          const reference={kind:'candidate',id:candidate_id,generation:Number.isSafeInteger(ref.generation)?ref.generation:undefined,hash:typeof ref.hash==='string'?ref.hash:undefined};
          // Absent exact generation/hash: refuse and never substitute current
          // content for a specific generation.
          if(!Number.isSafeInteger(ref.generation)||typeof ref.hash!=='string'){
            return {reference,mode:'candidate_generation_diff',not_diff:true,verified:false,available:false,reason:'exact_generation_required',project_generation:project.generation,
              note:'Supply the exact retained candidate generation and hash. Current content is never substituted for a requested generation.'};
          }
          if(!execution||typeof execution.dispatch!=='function')throw wbError('unavailable');
          let outcome;
          try{outcome=await readLiveCandidateDiff({execution,candidate:candidateRecord,workspace_id,project_id,reference:{...reference,candidate_id}});}
          catch(error){
            if(['stale_resource','unavailable','permission_denied'].includes(error?.code))throw error;
            throw wbError('unavailable');
          }
          // A comparison is exact when both retained generations were read, but
          // it is never recorder evidence: exact true, verified always false.
          return {...outcome,mode:'candidate_generation_diff',not_diff:outcome.available!==true,exact:outcome.available===true,verified:false,reference,project_generation:project.generation};
        }
        case 'result':{
          if(!native||typeof native.dispatch!=='function')throw wbError('unavailable');
          const result=(await native.dispatch({action:'result_get',workspace_id,project_id,result_id:ref.id})).result;
          assertAttemptScope('results',result,attempt,project);
          // A host-recorded result receipt is not a check verification.
          return {reference:{kind:'result',id:result.id},mode:'result_receipt',not_diff:true,verified:false,project_generation:project.generation,
            fields:{availability:short(result.availability,80),hermes_completed:result.hermes_completed===true?1:0,frame_hash:result.frame_hash??null,received_at:result.received_at??null,retained_until:result.retained_until??null,candidate_id:result.candidate_id??null,candidate_generation:result.candidate_generation??null,candidate_hash:result.candidate_hash??null},
            provenance:result.provenance??null,
            note:'Receipt metadata only. The explanation text is not returned through the live surface.'};
        }
        default:throw wbError('unsupported');
      }
    }catch(error){
      if(['unavailable','stale_resource','permission_denied','unsupported','invalid_request'].includes(error?.code))throw error;
      throw wbError('unavailable');
    }
  };

  // Descriptor-anchored tail: the only admitted source is the private identity
  // the recorder persisted on the job at output.log creation. Artifact root and
  // check directory are opened O_DIRECTORY|O_NOFOLLOW through process-owned
  // descriptors (no fd scan, no directory search, no request path), and the log
  // inode must equal the recorded dev/ino, so a replaced log or a symlinked
  // parent can never redirect the read.
  const safeTail=identity=>{
    if(!identity||typeof identity.path!=='string'||!identity.path)return {available:false,reason:'untrusted_path'};
    const resolved=path.resolve(identity.path);
    if(resolved!==identity.path)return {available:false,reason:'untrusted_path'};
    if(!resolved.startsWith(`${artifactRoot}${path.sep}`))return {available:false,reason:'outside_artifact_root'};
    if(path.basename(resolved)!=='output.log')return {available:false,reason:'unexpected_artifact'};
    const dir=path.dirname(resolved);
    if(path.dirname(dir)!==artifactRoot||!path.basename(dir).startsWith('check-'))return {available:false,reason:'unexpected_artifact'};
    if(!Number.isSafeInteger(identity.dev)||!Number.isSafeInteger(identity.ino))return {available:false,reason:'untrusted_identity'};
    let rootFd,directoryFd,fd;
    try{
      rootFd=fs.openSync(artifactRoot,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
      const rootStat=fs.fstatSync(rootFd);
      if(Number.isSafeInteger(identity.root_ino)&&(rootStat.dev!==identity.root_dev||rootStat.ino!==identity.root_ino))return {available:false,reason:'artifact_root_replaced'};
      directoryFd=fs.openSync(`/proc/self/fd/${rootFd}/${path.basename(dir)}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
      const dirStat=fs.fstatSync(directoryFd);
      if(Number.isSafeInteger(identity.dir_ino)&&(dirStat.dev!==identity.dir_dev||dirStat.ino!==identity.dir_ino))return {available:false,reason:'artifact_dir_replaced'};
      fd=fs.openSync(`/proc/self/fd/${directoryFd}/output.log`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const before=fs.fstatSync(fd);
      if(!before.isFile())return {available:false,reason:'not_a_regular_file'};
      if(before.dev!==identity.dev||before.ino!==identity.ino)return {available:false,reason:'replaced_log'};
      const length=Math.min(LIVE_LIMITS.tailBytes,before.size);
      const buffer=Buffer.alloc(length);
      let read=0;
      while(read<length){const count=fs.readSync(fd,buffer,read,length-read,before.size-length+read);if(!count)break;read+=count;}
      const after=fs.fstatSync(fd);
      if(after.dev!==identity.dev||after.ino!==identity.ino||after.dev!==before.dev||after.ino!==before.ino)return {available:false,reason:'replaced_during_read'};
      const bytes=buffer.subarray(0,read);
      return {available:true,bytes:before.size,tail_bytes:bytes.length,truncated:before.size>bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),text:new TextDecoder('utf-8',{fatal:false}).decode(bytes)};
    }catch{return {available:false,reason:'unreadable'};}
    finally{for(const handle of [fd,directoryFd,rootFd])if(handle!==undefined)try{fs.closeSync(handle);}catch{}}
  };
  const tail=({workspace_id,project_id,attempt_id,job_id}={})=>{
    const project=records.project(workspace_id,project_id); // revoked project hard-fences here
    if(typeof job_id!=='string'||!UUID.test(job_id))throw wbError('invalid_request');
    const job=data.get('jobs',workspace_id,project_id,job_id);
    const attempt=typeof attempt_id==='string'&&attempt_id?data.get('attempts',workspace_id,project_id,attempt_id):null;
    if(attempt&&Number.isSafeInteger(attempt.project_generation)&&attempt.project_generation!==project.generation)throw wbError('stale_resource');
    assertAttemptScope('jobs',job,attempt,project);
    const identity=job.artifact_log_identity&&typeof job.artifact_log_identity==='object'?job.artifact_log_identity:null;
    const base={job_id:job.id,status:short(job.status,80),verified:false,cap_bytes:LIVE_LIMITS.tailBytes,log_bytes:Number.isFinite(job.log_bytes)?job.log_bytes:null};
    if(!identity)return {...base,available:false,reason:'unresolved',note:'No recorded private artifact identity exists for this job. Request-supplied paths and directory searches are never used.'};
    const result=safeTail(identity);
    if(!result.available)return {...base,available:false,reason:result.reason,note:'The trusted log artifact could not be read safely; no partial content is shown.'};
    return {...base,available:true,bytes:result.bytes,truncated:result.truncated,sha256:result.sha256,text:result.text,at:now(),
      note:'Unverified tail of the private log artifact recorded by this job. Ordering and completeness are not guaranteed and this is never a progress, pass or failure signal.'};
  };

  const dispatch=async body=>{
    if(closed)throw wbError('unavailable');
    switch(body?.action){
      case 'page':return page(body);
      case 'detail':return await detail(body);
      case 'tail':return tail(body);
      default:throw wbError('unsupported');
    }
  };
  const subscribe=listener=>{
    if(typeof listener!=='function')throw wbError('invalid_request');
    subscribers.add(listener);
    return ()=>{subscribers.delete(listener);};
  };
  // Single fence check for stream callers: resolves the current project
  // generation and, for an attempt scope, validates that attempt belongs to it.
  const authorize=({workspace_id,project_id,attempt_id}={})=>{
    const project=records.project(workspace_id,project_id);
    if(typeof attempt_id!=='string'||!attempt_id)return {project_generation:project.generation,attempt_id:null,attempt_generation:null};
    const attempt=data.get('attempts',workspace_id,project_id,attempt_id);
    if(Number.isSafeInteger(attempt.project_generation)&&attempt.project_generation!==project.generation)throw wbError('stale_resource');
    return {project_generation:project.generation,attempt_id,attempt_generation:attempt.project_generation??null};
  };

  unsubscribeData=data.subscribe(observer);
  reconcile();

  return {
    page,detail,tail,dispatch,subscribe,reconcile,lane,snapshot,authorize,
    projectionErrors:()=>projectionErrors,
    close(){
      if(closed)return;
      closed=true;
      try{unsubscribeData?.();}catch{}
      subscribers.clear();
      try{db.close();}catch{}
    },
    limits:LIVE_LIMITS,
    filename,
    artifactRoot,
    records,
    clock:now,
  };
}
