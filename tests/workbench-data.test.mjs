import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData,WORKBENCH_RECORD_KINDS} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {legacyQueueSnapshot} from '../server/workbench-legacy-state.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-data-'),store=new SqliteWorkspaceStore(root);
  const workspace=randomUUID();store.commit(commandIdentity({workspace_id:workspace,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id:workspace,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const records=new WorkbenchStore(store),project=records.register(workspace,{root:path.join(root,'project'),name:'Synthetic',identity:'synthetic'}),data=new WorkbenchData(store);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});return {root,store,workspace,project,records,data};
}
test('private execution records are workspace/project scoped with immutable IDs and revision CAS',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const first=f.data.create('tasks',{...scope,outcome:'Fix synthetic defect'});
  assert.equal(first.version,1);assert.equal(first.revision,1);
  assert.throws(()=>f.data.get('tasks',randomUUID(),f.project.id,first.id),{code:'permission_denied'});
  assert.throws(()=>f.data.get('tasks',f.workspace,randomUUID(),first.id),{code:'permission_denied'});
  assert.throws(()=>f.data.create('tasks',{...scope,id:first.id}),{code:'invalid_request'});
  assert.throws(()=>f.data.update('tasks',f.workspace,f.project.id,first.id,1,{project_id:randomUUID()}),{code:'invalid_request'});
  const changed=f.data.update('tasks',f.workspace,f.project.id,first.id,1,{status:'blocked'});
  assert.equal(changed.id,first.id);assert.equal(changed.revision,2);
  assert.throws(()=>f.data.update('tasks',f.workspace,f.project.id,first.id,1,{status:'verified'}),{code:'stale_resource'});
  assert.throws(()=>f.data.list('tasks; DROP TABLE workspaces',f.workspace,f.project.id),{code:'invalid_request'});
});
test('layout synchronization cannot erase records; backup carries exact private facts without events',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const payload='SYNTHETIC_PRIVATE_CONTEXT_ONLY';
  const context=f.data.create('contexts',{...scope,text:payload,hash:'fixturehash'});
  const before=f.store.read(f.workspace);
  f.store.commit(commandIdentity({workspace_id:f.workspace,action:'sync',base_revision:1,state:before.state,operation_id:randomUUID(),intent:'Old client'},'owner'),{apply:()=>before.state});
  assert.deepEqual(f.data.get('contexts',f.workspace,f.project.id,context.id),context);
  assert.ok(!JSON.stringify(f.store.read(f.workspace)).includes(payload));
  for(const row of f.store.db.prepare('SELECT * FROM events').all())assert.ok(!JSON.stringify(row).includes(payload));
  const backup=path.join(f.root,'private-backup.sqlite');await f.store.backup(backup);
  const copy=new Database(backup,{readonly:true});try{assert.equal(JSON.parse(copy.prepare('SELECT record_json FROM wb_contexts').get().record_json).text,payload);}finally{copy.close();}
});
test('schema 5 additive upgrade retains project identities and leaves source backup unchanged',async t=>{
  const f=fixture(t);
  for(const kind of WORKBENCH_RECORD_KINDS)f.store.db.exec(`DROP TABLE wb_${kind}`);
  f.store.db.pragma('user_version=5');
  const backup=path.join(f.root,'v5.sqlite');await f.store.backup(backup);const bytes=fs.readFileSync(backup);
  const target=path.join(f.root,'upgraded');fs.mkdirSync(target);fs.copyFileSync(backup,path.join(target,'workspace.sqlite'));
  const upgraded=new SqliteWorkspaceStore(target);
  try{
    assert.equal(upgraded.db.pragma('user_version',{simple:true}),6);
    assert.equal(new WorkbenchStore(upgraded).project(f.workspace,f.project.id).id,f.project.id);
    for(const kind of WORKBENCH_RECORD_KINDS)assert.deepEqual(new WorkbenchData(upgraded).list(kind,f.workspace,f.project.id),[]);
  }finally{upgraded.close();}
  assert.deepEqual(fs.readFileSync(backup),bytes);
});
test('serial lanes fence legacy active/unknown outcomes without dropping queued state',()=>{
  const gate=createWorkbenchGate();let legacy={enabled:false,active:0,uncertain:0,pending:2};gate.setLegacyStatus(()=>legacy);
  const release=gate.claim('job','job-one');assert.throws(()=>gate.claim('job','job-two'),{code:'busy'});
  const agentRelease=gate.claim('agent','attempt-one');assert.throws(()=>gate.claim('legacy-agent','legacy-task'),{code:'busy'});
  release();release();agentRelease();
  legacy={...legacy,uncertain:1};assert.throws(()=>gate.claim('job','job-two'),{code:'busy'});assert.throws(()=>gate.claim('agent','attempt-two'),{code:'busy'});
  assert.equal(gate.legacyStatus().pending,2);
  legacy={...legacy,uncertain:0,enabled:true};assert.throws(()=>gate.claim('agent','attempt-two'),{code:'busy'});
  const legacyRelease=gate.claim('legacy-agent','legacy-task');legacyRelease();
});

test('durable legacy uncertainty fences dispatch before its lazy UI adapter is created',t=>{
  const f=fixture(t),root=path.join(f.root,'build-queue');fs.mkdirSync(root);
  const file=path.join(root,'queue.json');
  fs.writeFileSync(file,JSON.stringify({version:1,enabled:true,tasks:[{id:'old-task',status:'starting',input:'SYNTHETIC_PRIVATE_INPUT'}]}));
  const before=fs.readFileSync(file),gate=createWorkbenchGate({legacySnapshot:legacyQueueSnapshot(f.root)});
  assert.throws(()=>gate.claim('agent','new-attempt'),{code:'busy'});
  assert.throws(()=>gate.claim('job','new-job'),{code:'busy'});
  assert.equal(gate.status().legacy.uncertain,1);
  assert.ok(!JSON.stringify(gate.status()).includes('SYNTHETIC_PRIVATE_INPUT'));
  assert.deepEqual(fs.readFileSync(file),before);
  fs.writeFileSync(file,'malformed');assert.equal(gate.status().legacy.uncertain,1);
});
