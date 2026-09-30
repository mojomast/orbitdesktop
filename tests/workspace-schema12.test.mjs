import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';
import {archivedSchema11Store} from './fixtures/schema11-store.mjs';

function snapshot(db){
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const tables=schema.filter(row=>row.type==='table').map(row=>row.name);
  const rows=Object.fromEntries(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  return {schema,rows};
}

test('11→12 is a row-preserving writer fence, survives backup, and an authentic schema-11 writer refuses reopen',async t=>{
  const root=fs.mkdtempSync('/tmp/opencode/orbit-schema12-');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const OldStore=await archivedSchema11Store(t);
  const runtime=path.join(root,'runtime'),old=new OldStore(runtime),id=randomUUID();
  assert.equal(old.diagnostics().schema_version,11);
  const identity=(action,revision)=>commandIdentity({workspace_id:id,action,base_revision:revision,operation_id:randomUUID(),intent:'Schema fence fixture'},'owner');
  old.commit(identity('sync',0),{create:()=>({id,revision:1,state:initial(),capability:'fixture-only',api:'http://127.0.0.1:4318'})});
  old.commit(identity('apply',1),{apply:record=>({...structuredClone(record.state),arc:record.state.arc+1}),checkpointLabel:'Preserve checkpoint'});
  // Studio revocations are independent of checkpoints and must survive the fence.
  old.commit(identity('studio-revoke',2),{});
  const before=snapshot(old.db),record=old.read(id);
  assert.ok(before.rows.receipts.length>=3);assert.ok(before.rows.checkpoints.length);
  old.close();
  const current=new SqliteWorkspaceStore(runtime);
  assert.equal(current.diagnostics().schema_version,12);
  assert.deepEqual(snapshot(current.db),before,'all tables, indices and records must survive exactly');
  assert.deepEqual(current.read(id),record);
  const backup=path.join(root,'schema12.sqlite');await current.backup(backup);current.close();
  assert.throws(()=>new OldStore(runtime),error=>error.category==='UPGRADE_REQUIRED');
  const untouched=new Database(path.join(runtime,'workspace.sqlite'),{readonly:true});
  try{assert.equal(untouched.pragma('user_version',{simple:true}),12);assert.deepEqual(snapshot(untouched),before);}finally{untouched.close();}
  const restoredRoot=path.join(root,'restored');fs.mkdirSync(restoredRoot);fs.copyFileSync(backup,path.join(restoredRoot,'workspace.sqlite'));
  const restored=new SqliteWorkspaceStore(restoredRoot);
  try{assert.equal(restored.diagnostics().schema_version,12);assert.deepEqual(snapshot(restored.db),before);}finally{restored.close();}
});
