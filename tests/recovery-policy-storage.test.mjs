import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
const exec=promisify(execFile);
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-policy-storage-')),id=randomUUID(),store=new SqliteWorkspaceStore(root);
  const identity=(revision,key)=>commandIdentity({workspace_id:id,base_revision:revision,action:'sync',operation_id:key,intent:'Isolated policy fixture'},'owner');
  store.commit(identity(0,'create'),{create:()=>({id,revision:1,state:initial(),capability:'fixture-only',api:'http://127.0.0.1:4318'})});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});return {root,id,store,identity};
}
test('administrative restore retains hold and legacy export refuses to discard it',async t=>{
  const {root,id,store,identity}=fixture(t);
  store.commit(identity(1,'enter-hold'),{recoveryPolicy:true,checkpointLabel:'Before hold'});
  const backup=path.join(root,'held.sqlite'),restoredRoot=path.join(root,'restored');
  await store.backup(backup);
  await exec(process.execPath,['--experimental-strip-types','scripts/workspace_store.mjs','restore','--source',backup,'--runtime',restoredRoot,'--confirm-stopped'],{env:{PATH:process.env.PATH}});
  const restored=new SqliteWorkspaceStore(restoredRoot);
  try {
    assert.deepEqual(restored.read(id).recovery_policy,{held:true,generation:1});
    assert.throws(()=>restored.exportLegacy(path.join(root,'unsafe-export')),error=>error.category==='RECOVERY_HOLD');
    assert.equal(fs.existsSync(path.join(root,'unsafe-export')),false);
    restored.commit(identity(2,'release-hold'),{recoveryPolicy:false});
    restored.exportLegacy(path.join(root,'released-export'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'released-export','workspaces',`${id}.json`))).recovery_policy.held,false);
  } finally {restored.close();}
});
test('SIGKILL during v1-to-v2 policy upgrade rolls back schema and retries without record loss',async t=>{
  const {root,id,store}=fixture(t),before=store.read(id);store.close();
  const file=path.join(root,'workspace.sqlite'),database=new Database(file);
  database.exec("ALTER TABLE receipts DROP COLUMN policy_generation; UPDATE workspaces SET record_json=json_remove(record_json,'$.recovery_policy'); UPDATE receipts SET record_json=json_remove(record_json,'$.recovery_policy'); PRAGMA user_version=1");database.close();
  const moduleUrl=new URL('../server/sqlite-workspace-store.mjs',import.meta.url).href;
  const script=`import Database from 'better-sqlite3';import {SqliteWorkspaceStore} from ${JSON.stringify(moduleUrl)};const original=Database.prototype.exec;Database.prototype.exec=function(sql){const result=original.call(this,sql);if(sql.includes('ALTER TABLE receipts ADD COLUMN policy_generation'))process.kill(process.pid,'SIGKILL');return result;};new SqliteWorkspaceStore(process.argv[1]);`;
  const worker=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,root],{env:{PATH:process.env.PATH},stdio:'ignore'});
  t.after(()=>{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');});
  const [code,signal]=await once(worker,'exit',{signal:AbortSignal.timeout(10000)});
  assert.equal(code,null);assert.equal(signal,'SIGKILL');
  const inspect=new Database(file);
  try {
    assert.equal(inspect.pragma('user_version',{simple:true}),1);
    assert.equal(inspect.pragma('table_info(receipts)').some(column=>column.name==='policy_generation'),false);
  } finally {inspect.close();}
  const reopened=new SqliteWorkspaceStore(root);
  try {assert.deepEqual(reopened.read(id),before);assert.equal(reopened.diagnostics().schema_version,5);}finally {reopened.close();}
});
