import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Readable} from 'node:stream';
import Database from 'better-sqlite3';
import {initial} from '../src/model.ts';
import {emptyPlacement} from '../src/docking-placement.ts';
import {commandIdentity} from '../server/command-identity.mjs';
import {createWorkspaceService} from '../server/workspace.mjs';
import {loadSqliteWorkspaceStore,tempRoot,removeRoot} from './fixtures/sqlite-store-helpers.mjs';

const SqliteWorkspaceStore=await loadSqliteWorkspaceStore();
function command(id,base,placement,operationId=randomUUID()) {
  return commandIdentity({workspace_id:id,base_revision:base,action:'placement_save',placement,operation_id:operationId,intent:'Test docking placement'},'owner');
}
function setup(t) {
  const root=tempRoot('orbit-placement-');
  assert.ok(root.startsWith('/tmp/opencode/'));
  let store=new SqliteWorkspaceStore(root);
  t.after(()=>{store.close();removeRoot(root);});
  const id=randomUUID();
  store.commit(command(id,0,emptyPlacement()),{create:()=>({id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4317'})});
  const window=store.read(id).state.monitors[0].id;
  const placement={...emptyPlacement(),floats:[{windows:[window],frame:{x:10,y:20,width:600,height:400}}],active:window};
  return {root,id,placement,get store(){return store;},reopen(){store.close();store=new SqliteWorkspaceStore(root);return store;}};
}
function save(store,id,placement,base=store.read(id).revision,identity=command(id,base,placement)) {
  return store.commit(identity,{apply:r=>r.state,placement,skipUnchanged:true,checkpointLabel:'Before docking placement change',response:r=>({revision:r.revision,placement_revision:r.placement_revision,placement:r.placement,command_receipt:{operation_id:identity.operationId,legacy:false}})});
}

test('schema 4 defaults and durable placement saves, no-op receipts, exact replay and CAS',t=>{
  const f=setup(t),{id,placement}=f;
  assert.equal(f.store.diagnostics().schema_version,6);
  assert.deepEqual(f.store.read(id).placement,emptyPlacement());
  assert.equal(f.store.read(id).placement_revision,0);
  const before=f.store.read(id).state,identity=command(id,1,placement);
  const first=save(f.store,id,placement,1,identity);
  assert.equal(first.result.revision,2);
  assert.equal(first.result.placement_revision,2);
  assert.deepEqual(f.reopen().read(id).placement,placement);
  assert.deepEqual(f.store.read(id).state,before);
  const second=save(f.store,id,placement);
  assert.equal(second.result.revision,2);
  assert.ok(second.result.command_receipt.operation_id);
  assert.equal(f.store.diagnostics().receipts,3);
  save(f.store,id,emptyPlacement());
  const replay=f.store.commit(identity,{apply:()=>{throw Error('Replay reapplied');}});
  assert.equal(replay.replayed,true);
  assert.deepEqual(replay.result,first.result);
  assert.equal(f.store.read(id).revision,3);
  assert.throws(()=>save(f.store,id,placement,1),{category:'REVISION_CONFLICT'});
  assert.throws(()=>save(f.store,id,emptyPlacement(),1,command(id,1,emptyPlacement(),identity.operationId)),{category:'IDEMPOTENCY_CONFLICT'});
  assert.deepEqual(JSON.parse(f.store.db.prepare('SELECT placement_json FROM revisions WHERE workspace_id=? AND revision=2').get(id).placement_json),placement);
});

test('invalid adjuncts roll back state, revision, checkpoints, receipts and events',t=>{
  const {store,id,placement}=setup(t);
  let deep={type:'group',windows:['deep-33']};
  for(let i=32;i>=0;i--)deep={type:'branch',direction:i%2?'vertical':'horizontal',ratio:0.5,first:deep,second:{type:'group',windows:[`deep-${i}`]}};
  const duplicate=structuredClone(placement);duplicate.layout={type:'group',windows:[placement.active]};
  const invalid=[{...placement,extra:true},duplicate,{...emptyPlacement(),layout:deep},{...emptyPlacement(),layout:{type:'group',windows:['unknown-window']}}];
  for(const width of [Infinity,NaN,10001,0]) {
    const p=structuredClone(placement);p.floats[0].frame.width=width;invalid.push(p);
  }
  const before=store.read(id),diagnostics=store.diagnostics();
  for(const p of invalid) {
    assert.throws(()=>save(store,id,p),{category:'INVALID_OPERATION',code:'INVALID_PLACEMENT'});
    assert.deepEqual(store.read(id),before);
    assert.deepEqual(store.diagnostics(),diagnostics);
  }
});

test('checkpoints copy previous placement; sync preserves adjunct and recovery hold permits saves',t=>{
  const {store,id,placement}=setup(t);
  store.commit(command(id,1,emptyPlacement()),{checkpointOnly:true,checkpointLabel:'Old empty checkpoint'});
  const old=store.checkpointList(id)[0];
  assert.deepEqual(store.checkpointGet(id,old.id).placement,emptyPlacement());
  save(store,id,placement);
  save(store,id,emptyPlacement());
  const entries=store.checkpointList(id);
  assert.ok(entries.every(entry=>!Object.hasOwn(entry,'placement')));
  const previous=entries.find(entry=>entry.revision===2);
  assert.deepEqual(store.checkpointGet(id,previous.id).placement,placement);
  save(store,id,placement);
  store.commit(command(id,4,emptyPlacement()),{apply:r=>({...r.state,sidebarHidden:!r.state.sidebarHidden}),skipUnchanged:true});
  assert.deepEqual(store.read(id).placement,placement);
  assert.equal(store.read(id).placement_revision,4);
  store.commit(command(id,5,emptyPlacement()),{recoveryPolicy:true});
  save(store,id,emptyPlacement());
  assert.equal(store.read(id).recovery_policy.held,true);
  assert.equal(store.read(id).placement_revision,7);
});

test('layout mutations prune orphaned adjunct references transactionally, including checkpoints',t=>{
  const {store,id,placement}=setup(t);save(store,id,placement);
  const oldWindow=placement.active;
  store.commit(command(id,2,emptyPlacement()),{apply:r=>({...r.state,
    selected:r.state.selected===oldWindow?'replacement-window':r.state.selected,
    monitors:r.state.monitors.map(m=>m.id===oldWindow?{...m,id:'replacement-window'}:m)}),checkpointLabel:'Before removal'});
  assert.deepEqual(store.read(id).placement,emptyPlacement());
  assert.equal(store.read(id).placement_revision,3);
  assert.deepEqual(store.checkpointGet(id,store.checkpointList(id).find(c=>c.revision===2).id).placement,placement);
  store.commit(command(id,3,emptyPlacement()),{checkpointOnly:true,checkpointLabel:'After removal'});
  const entry=store.checkpointList(id).find(c=>c.revision===3);
  assert.deepEqual(store.checkpointGet(id,entry.id).placement,emptyPlacement());
  // A retained early adjunct checkpoint with stale refs still restores safely.
  store.db.prepare('UPDATE checkpoints SET placement_json=? WHERE workspace_id=? AND id=?').run(JSON.stringify(placement),id,entry.id);
  assert.deepEqual(store.checkpointGet(id,entry.id).placement,emptyPlacement());
});

test('schema 3 upgrade backfills EMPTY checkpoints and missing record fields, twice safely',t=>{
  const f=setup(t),{id,placement}=f;
  save(f.store,id,placement);
  save(f.store,id,emptyPlacement());
  const checkpoint=f.store.checkpointList(id).find(entry=>entry.revision===2);
  f.store.close();
  const db=new Database(path.join(f.root,'workspace.sqlite'));
  try {
    db.exec("ALTER TABLE checkpoints DROP COLUMN placement_json; ALTER TABLE revisions DROP COLUMN placement_json; UPDATE workspaces SET record_json=json_remove(record_json,'$.placement','$.placement_revision'); PRAGMA user_version=3;");
  } finally {db.close();}
  for(let i=0;i<2;i++) {
    f.reopen();
    assert.equal(f.store.diagnostics().schema_version,6);
    assert.deepEqual(f.store.read(id).placement,emptyPlacement());
    assert.equal(f.store.read(id).placement_revision,0);
    for(const entry of f.store.checkpointList(id))assert.deepEqual(f.store.checkpointGet(id,entry.id).placement,emptyPlacement());
  }
  save(f.store,id,placement);
  const saved=f.store.checkpointGet(id,checkpoint.id);
  f.store.commit(command(id,4,saved.placement),{apply:()=>saved.state,placement:saved.placement,checkpointLabel:'Before restore'});
  assert.deepEqual(f.store.read(id).placement,emptyPlacement());
  assert.equal(f.store.read(id).placement_revision,5);
  f.store.db.prepare('UPDATE checkpoints SET placement_json=NULL WHERE workspace_id=? AND id=?').run(id,checkpoint.id);
  assert.deepEqual(f.store.checkpointGet(id,checkpoint.id).placement,emptyPlacement());
});

test('SQLite backup/CLI restore and archive-only legacy export preserve placement',async t=>{
  const {store,root,id,placement}=setup(t);
  save(store,id,placement);
  const destination=path.join(root,'backup.sqlite'),restored=path.join(root,'restored');
  await store.backup(destination);
  const result=spawnSync(process.execPath,['--experimental-strip-types','scripts/workspace_store.mjs','restore','--runtime',restored,'--source',destination,'--confirm-stopped'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const copy=new SqliteWorkspaceStore(restored);
  try {
    assert.equal(copy.diagnostics().schema_version,6);
    assert.deepEqual(copy.read(id).placement,placement);
    assert.equal(copy.read(id).placement_revision,2);
  } finally {copy.close();}
  const archive=path.join(root,'archive');store.exportLegacy(archive);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archive,'workspaces',`${id}.json`),'utf8')).placement,placement);
  const entry=store.checkpointList(id)[0];
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(archive,'checkpoints',id,`${entry.id}.json`),'utf8')).placement,emptyPlacement());
});

test('service saves via owner/control, rejects recovery route, restores placement and returns small receipts',async t=>{
  const {store,root,id,placement}=setup(t);
  const service=createWorkspaceService({store,root,token:'test-owner',port:4317,devOrigins:[],reply:(res,status,body)=>Object.assign(res,{status,body})});
  const call=async(body,control=false,recovery=false)=>{
    const req=Readable.from([JSON.stringify({workspace_id:id,...body})]);
    req.method='POST';req.headers={host:'127.0.0.1:4317',origin:'http://127.0.0.1:4317',authorization:`Bearer ${control?store.read(id).capability:'test-owner'}`};
    const res={};await service.handle(req,res,control,recovery);return res;
  };
  const request={action:'placement_save',base_revision:1,placement,operation_id:randomUUID(),intent:'Float a window'};
  const saved=await call(request);
  assert.equal(saved.status,200);
  assert.deepEqual(saved.body.placement,placement);
  assert.equal(saved.body.placement_revision,2);
  assert.ok(!Object.hasOwn(saved.body,'state'));
  assert.deepEqual(await call(request),saved);
  assert.equal((await call({...request,operation_id:randomUUID()})).body.category,'REVISION_CONFLICT');
  assert.equal((await call({...request,placement:emptyPlacement()})).body.category,'IDEMPOTENCY_CONFLICT');
  assert.equal((await call({...request,base_revision:2,operation_id:randomUUID()},false,true)).status,403);
  const emptyCheckpoint=store.checkpointList(id)[0].id;
  const cleared=await call({...request,base_revision:2,placement:emptyPlacement(),operation_id:randomUUID()},true);
  assert.equal(cleared.status,200);
  assert.equal(cleared.body.revision,3);
  const populatedCheckpoint=store.checkpointList(id).find(entry=>entry.revision===2).id;
  const restore=checkpoint_id=>({action:'restore',base_revision:store.read(id).revision,checkpoint_id,confirm:true,operation_id:randomUUID(),intent:'Restore docking placement'});
  const restored=await call(restore(populatedCheckpoint),true);
  assert.equal(restored.status,200);
  assert.deepEqual(restored.body.placement,placement);
  assert.ok(restored.body.state);
  store.db.prepare('UPDATE checkpoints SET placement_json=NULL WHERE workspace_id=? AND id=?').run(id,emptyCheckpoint);
  const old=await call(restore(emptyCheckpoint));
  assert.equal(old.status,200);
  assert.deepEqual(old.body.placement,emptyPlacement());
  assert.deepEqual((await call({action:'read'})).body.placement,emptyPlacement());
});
