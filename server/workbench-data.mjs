import {randomUUID} from 'node:crypto';
import {wbError} from './workbench-store.mjs';

// Private execution/application records. These tables never enter a layout
// checkpoint, workspace projection, receipt outbox, or public static directory.
// Typed relationships within each record are validated by its owning service.
// Project/workspace foreign keys also protect the authoritative storage boundary.
export const WORKBENCH_RECORD_KINDS=Object.freeze(['tasks','attempts','contexts','disclosures','submissions','candidates','jobs','evidence','reviews']);
const limits=Object.freeze({tasks:200,attempts:400,contexts:512,disclosures:512,submissions:512,candidates:200,jobs:512,evidence:1024,reviews:512});
const identifier=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const table=kind=>{if(!WORKBENCH_RECORD_KINDS.includes(kind))throw wbError('invalid_request');return `wb_${kind}`;};
export const workbenchExecutionSchemaSql=WORKBENCH_RECORD_KINDS.map(kind=>`
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
`).join('\n');

export class WorkbenchData {
  constructor(store,{now=Date.now}={}){this.store=store;this.db=store.db;this.now=now;}
  #scope(workspaceId,projectId){
    if(!identifier.test(workspaceId||'')||!identifier.test(projectId||''))throw wbError('invalid_request');
    if(!this.db.prepare('SELECT id FROM wb_projects WHERE id=? AND workspace_id=?').get(projectId,workspaceId))throw wbError('permission_denied');
  }
  #encode(kind,value){
    let json;try{json=JSON.stringify(value);}catch{throw wbError('invalid_request');}
    const max=kind==='candidates'?16*1024*1024:kind==='contexts'||kind==='submissions'?1024*1024:512*1024;
    if(Buffer.byteLength(json)>max)throw wbError('limit_exceeded');
    return json;
  }
  create(kind,fields){
    const name=table(kind);
    if(!fields||typeof fields!=='object'||Array.isArray(fields))throw wbError('invalid_request');
    const {workspace_id,project_id}=fields;this.#scope(workspace_id,project_id);
    for(const key of ['id','version','revision','created_at','updated_at'])if(Object.hasOwn(fields,key))throw wbError('invalid_request');
    return this.db.transaction(()=>{
      if(this.db.prepare(`SELECT count(*) AS n FROM ${name} WHERE workspace_id=? AND project_id=?`).get(workspace_id,project_id).n>=limits[kind])throw wbError('limit_exceeded');
      const time=this.now();
      const value={...structuredClone(fields),id:randomUUID(),version:1,revision:1,created_at:time,updated_at:time};
      this.db.prepare(`INSERT INTO ${name} VALUES (?,?,?,?,?)`).run(value.id,workspace_id,project_id,1,this.#encode(kind,value));
      return value;
    }).immediate();
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
    return this.db.transaction(()=>{
      const current=this.get(kind,workspaceId,projectId,id);
      if(current.revision!==expectedRevision)throw wbError('stale_resource');
      const next={...current,...structuredClone(patch),revision:expectedRevision+1,updated_at:this.now()};
      if(this.db.prepare(`UPDATE ${name} SET revision=?,record_json=? WHERE id=? AND revision=?`).run(next.revision,this.#encode(kind,next),id,expectedRevision).changes!==1)throw wbError('stale_resource');
      return next;
    }).immediate();
  }
}
