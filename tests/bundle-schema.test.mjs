import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
test('bundle CLI refuses implicit old-schema upgrade; interrupted schema 3 migration retains policy and receipts',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-bundle-schema-')),id=randomUUID();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new SqliteWorkspaceStore(root);
  const identity=(revision,key)=>commandIdentity({workspace_id:id,action:'sync',base_revision:revision,operation_id:key,intent:'Schema fixture'},'owner');
  store.commit(identity(0,'seed'),{create:()=>({id,revision:1,state:initial(),capability:'fixture-only',api:'http://127.0.0.1:4318'})});
  const held=store.commit(identity(1,'hold'),{recoveryPolicy:true}),before=store.read(id);store.close();
  const file=path.join(root,'workspace.sqlite'),db=new Database(file);
  db.exec('DROP TABLE bundle_files; DROP TABLE bundles; DROP INDEX events_workspace_sequence; PRAGMA user_version=2');db.close();
  assert.throws(()=>execFileSync(process.execPath,['--experimental-strip-types','scripts/workspace_bundles.mjs','refresh','--root',root],{env:{PATH:process.env.PATH},stdio:'pipe'}));
  const inspect=new Database(file);assert.equal(inspect.pragma('user_version',{simple:true}),2);inspect.close();
  const moduleUrl=new URL('../server/sqlite-workspace-store.mjs',import.meta.url).href;
  const worker=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import Database from 'better-sqlite3';import {SqliteWorkspaceStore} from ${JSON.stringify(moduleUrl)};const exec=Database.prototype.exec;Database.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql.includes('CREATE TABLE IF NOT EXISTS bundles'))process.kill(process.pid,'SIGKILL');return result;};new SqliteWorkspaceStore(process.argv[1]);`,root],{env:{PATH:process.env.PATH},stdio:'ignore'});
  t.after(()=>{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');});
  const [code,signal]=await once(worker,'exit',{signal:AbortSignal.timeout(10000)});assert.equal(code,null);assert.equal(signal,'SIGKILL');
  const check=new Database(file);try {assert.equal(check.pragma('user_version',{simple:true}),2);assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='bundles'").get(),undefined);}finally {check.close();}
  const restored=new SqliteWorkspaceStore(root);
  try {
    assert.equal(restored.diagnostics().schema_version,7);assert.deepEqual(restored.read(id),before);
    assert.deepEqual(restored.commit(identity(1,'hold'),{recoveryPolicy:true}).result,held.result);
    assert.ok(restored.db.prepare("SELECT name FROM sqlite_master WHERE name='events_workspace_sequence'").get());
  }finally {restored.close();}
});
