import {randomUUID} from 'node:crypto';
import {wbError} from './workbench-store.mjs';

// Private execution/application records. These tables never enter a layout
// checkpoint, workspace projection, receipt outbox, or public static directory.
// Typed relationships within each record are validated by its owning service.
// Project/workspace foreign keys also protect the authoritative storage boundary.
export const WORKBENCH_RECORD_KINDS=Object.freeze(['tasks','attempts','contexts','disclosures','submissions','candidates','jobs','evidence','reviews','grants','toolcalls','profiles','integrations','annotations','results','cards','patches','proposals','recipes']);
const limits=Object.freeze({tasks:200,attempts:400,contexts:512,disclosures:512,submissions:512,candidates:200,jobs:512,evidence:1024,reviews:512,grants:512,toolcalls:4096,profiles:64,integrations:200,annotations:2048,results:512,cards:512,patches:200,proposals:200,recipes:32});
export const WORKBENCH_RECORD_LIMITS=limits;
const identifier=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const table=kind=>{if(!WORKBENCH_RECORD_KINDS.includes(kind))throw wbError('invalid_request');return `wb_${kind}`;};
const recordTableSql=kind=>`
CREATE TABLE IF NOT EXISTS wb_${kind}(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES wb_projects(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  record_json TEXT NOT NULL CHECK(json_valid(record_json))
    CHECK(json_extract(record_json,'$.version')=1)
    CHECK(json_extract(record_json,'$.id')=id)
    CHECK(json_extract(record_json,'$.workspace_id')=workspace_id)
    CHECK(json_extract(record_json,'$.project_id')=project_id)
    CHECK(json_extract(record_json,'$.revision')=revision)
);
CREATE INDEX IF NOT EXISTS wb_${kind}_project ON wb_${kind}(workspace_id,project_id);
`;
// Schema 6 must stay frozen: proposals/recipes are created by the additive
// schema-9 migration, not while upgrading a legacy schema-5 database.
export const workbenchExecutionSchemaSql=WORKBENCH_RECORD_KINDS.filter(kind=>!['results','cards','patches','proposals','recipes'].includes(kind)).map(recordTableSql).join('\n');
export const workbenchOperationSchemaSql=`
CREATE UNIQUE INDEX IF NOT EXISTS wb_jobs_operation_identity
ON wb_jobs(workspace_id,project_id,json_extract(record_json,'$.op_id'))
WHERE json_extract(record_json,'$.op_id') IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wb_integrations_operation_identity
ON wb_integrations(workspace_id,project_id,json_extract(record_json,'$.op_id'))
WHERE json_extract(record_json,'$.op_id') IS NOT NULL;
`;
export const workbenchResultSchemaSql=`
${['results','cards','patches'].map(recordTableSql).join('\n')}
CREATE UNIQUE INDEX IF NOT EXISTS wb_results_run ON wb_results(workspace_id,project_id,json_extract(record_json,'$.run_id'));
CREATE UNIQUE INDEX IF NOT EXISTS wb_cards_operation ON wb_cards(workspace_id,project_id,json_extract(record_json,'$.op_id'));
CREATE UNIQUE INDEX IF NOT EXISTS wb_patches_operation ON wb_patches(workspace_id,project_id,json_extract(record_json,'$.op_id')) WHERE json_extract(record_json,'$.op_id') IS NOT NULL;
`;
// Additive schema 9: durable arrangement proposals, portable saved recipes and
// append-only recipe-save operation receipts. The proposal operation index is
// created separately after a duplicate guard so a conflicted old copy fails
// migration instead of silently dropping a receipt.
export const workbenchProposalSchemaSql=`${['proposals','recipes'].map(recordTableSql).join('\n')}
CREATE TABLE IF NOT EXISTS wb_recipe_receipts(
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor TEXT NOT NULL,
  op_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  intent TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,actor,op_id)
);
CREATE INDEX IF NOT EXISTS wb_recipe_receipts_workspace ON wb_recipe_receipts(workspace_id);
`;
export const workbenchProposalIndexSql=`CREATE UNIQUE INDEX IF NOT EXISTS wb_proposals_operation ON wb_proposals(workspace_id,project_id,json_extract(record_json,'$.op_id'),json_extract(record_json,'$.committed_actor')) WHERE json_extract(record_json,'$.op_id') IS NOT NULL AND json_extract(record_json,'$.committed_actor') IS NOT NULL;`;


export class WorkbenchData {
  // Optional read-only observers. They are notified only after an authoritative
  // create/update is durably committed, and a throwing observer must never fail
  // or replay that authoritative operation. Notifications carry no authority.
  #observers=new Set();
  #pending=[];
  #flushScheduled=false;
  constructor(store,{now=Date.now}={}){this.store=store;this.db=store.db;this.now=now;}
  subscribe(observer){
    if(typeof observer!=='function')throw wbError('invalid_request');
    this.#observers.add(observer);
    return ()=>{this.#observers.delete(observer);};
  }
  // Durability guard: a nested `data.update` inside another `db.transaction`
  // returns from a savepoint, not a commit. Those changes are deferred to a
  // microtask and verified against the exact committed record bytes before
  // notifying. Revision comparison alone is insufficient: a rolled-back
  // revision can be reused by a later write with a different payload, so only
  // an exact `record_json` match proves the captured payload committed. On a
  // mismatch the captured transition is discarded and the current authoritative
  // state is surfaced as a snapshot instead of a fabricated transition.
  #notifyAfterCommit(kind,record,phase,json){
    const change={phase,kind,record,json};
    if(this.db.inTransaction){
      // Savepoint write: the outer transaction may still roll back, and an
      // intermediate revision can later be reused by an unrelated payload.
      // Mark it deferred so only provable current state is ever surfaced.
      change.deferred=true;
      this.#pending.push(change);
      if(!this.#flushScheduled){
        this.#flushScheduled=true;
        queueMicrotask(()=>{this.#flushScheduled=false;for(const item of this.#pending.splice(0))this.#emitVerified(item);});
      }
      return;
    }
    this.#emitVerified(change);
  }
  #emitVerified(change){
    if(!this.#observers.size)return;
    let row;
    try{row=this.db.prepare(`SELECT record_json FROM ${table(change.kind)} WHERE id=? AND workspace_id=? AND project_id=?`).get(change.record.id,change.record.workspace_id,change.record.project_id);}
    catch{return;}
    if(!row)return;
    let notify=change;
    if(change.deferred||row.record_json!==change.json){
      // Only the exact committed payload may be announced as a transition. A
      // deferred savepoint write is announced only as the current authoritative
      // snapshot, so a rollback or revision reuse can never fabricate a prior
      // transition. Duplicate revisions collapse on the projection unique index.
      try{notify={phase:'snapshot',kind:change.kind,json:row.record_json,record:JSON.parse(row.record_json)};}
      catch{return;}
    }
    for(const observer of [...this.#observers]){try{observer(notify);}catch{}}
  }
  #scope(workspaceId,projectId){
    if(!identifier.test(workspaceId||'')||!identifier.test(projectId||''))throw wbError('invalid_request');
    if(!this.db.prepare('SELECT id FROM wb_projects WHERE id=? AND workspace_id=?').get(projectId,workspaceId))throw wbError('permission_denied');
  }
  #encode(kind,value){
    let json;try{json=JSON.stringify(value);}catch{throw wbError('invalid_request');}
    const max=kind==='candidates'?16*1024*1024:kind==='contexts'||kind==='submissions'?1024*1024:kind==='proposals'?2*1024*1024:512*1024;
    if(Buffer.byteLength(json)>max)throw wbError('limit_exceeded');
    return json;
  }
  create(kind,fields){
    const name=table(kind);
    if(!fields||typeof fields!=='object'||Array.isArray(fields))throw wbError('invalid_request');
    const {workspace_id,project_id}=fields;this.#scope(workspace_id,project_id);
    for(const key of ['id','version','revision','created_at','updated_at'])if(Object.hasOwn(fields,key))throw wbError('invalid_request');
    const committed=this.db.transaction(()=>{
      if(this.db.prepare(`SELECT count(*) AS n FROM ${name} WHERE workspace_id=? AND project_id=?`).get(workspace_id,project_id).n>=limits[kind])throw wbError('limit_exceeded');
      const time=this.now();
      const value={...structuredClone(fields),id:randomUUID(),version:1,revision:1,created_at:time,updated_at:time};
      const encoded=this.#encode(kind,value);
      this.db.prepare(`INSERT INTO ${name} VALUES (?,?,?,?,?)`).run(value.id,workspace_id,project_id,1,encoded);
      return {value,encoded};
    }).immediate();
    this.#notifyAfterCommit(kind,committed.value,'create',committed.encoded);
    return committed.value;
  }
  get(kind,workspaceId,projectId,id){
    const name=table(kind);this.#scope(workspaceId,projectId);
    if(!identifier.test(id||''))throw wbError('invalid_request');
    const row=this.db.prepare(`SELECT record_json FROM ${name} WHERE id=? AND workspace_id=? AND project_id=?`).get(id,workspaceId,projectId);
    if(!row)throw wbError('permission_denied');return JSON.parse(row.record_json);
  }
  list(kind,workspaceId,projectId){
    const name=table(kind);this.#scope(workspaceId,projectId);
    return this.db.prepare(`SELECT record_json FROM ${name} WHERE workspace_id=? AND project_id=? ORDER BY rowid`).all(workspaceId,projectId).map(row=>JSON.parse(row.record_json));
  }
  update(kind,workspaceId,projectId,id,expectedRevision,patch){
    const name=table(kind);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||!patch||typeof patch!=='object'||Array.isArray(patch))throw wbError('invalid_request');
    for(const key of ['id','version','revision','workspace_id','project_id','created_at','updated_at'])if(Object.hasOwn(patch,key))throw wbError('invalid_request');
    const committed=this.db.transaction(()=>{
      const current=this.get(kind,workspaceId,projectId,id);
      if(current.revision!==expectedRevision)throw wbError('stale_resource');
      const next={...current,...structuredClone(patch),revision:expectedRevision+1,updated_at:this.now()};
      const encoded=this.#encode(kind,next);
      if(this.db.prepare(`UPDATE ${name} SET revision=?,record_json=? WHERE id=? AND revision=?`).run(next.revision,encoded,id,expectedRevision).changes!==1)throw wbError('stale_resource');
      return {next,encoded};
    }).immediate();
    this.#notifyAfterCommit(kind,committed.next,'update',committed.encoded);
    return committed.next;
  }
}
