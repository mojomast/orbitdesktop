import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
const exec=promisify(execFile);
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-backup-safety-')),id=randomUUID(),store=new SqliteWorkspaceStore(root);
  store.commit(commandIdentity({workspace_id:id,base_revision:0,action:'sync',operation_id:randomUUID(),intent:'Backup fixture'},'owner'),{create:()=>({id,revision:1,state:initial(),capability:'private-test-only',api:'http://127.0.0.1:4318'})});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});return {root,store,id};
}
test('backup cannot overwrite a database through binding filename trimming',async t=>{
  const {root,store}=fixture(t),victim=path.join(root,'sentinel.sqlite');
  const db=new Database(victim);db.exec('CREATE TABLE owner_data(secret TEXT); INSERT INTO owner_data VALUES (\'canary\')');db.close();
  const original=fs.readFileSync(victim);
  await assert.rejects(store.backup(victim+' '),error=>error.category==='INVALID_DESTINATION');
  assert.deepEqual(fs.readFileSync(victim),original);assert.equal(fs.existsSync(victim+' '),false);
});
test('backup publication is exclusive even if destination appears during backup',async t=>{
  const {root,store}=fixture(t),destination=path.join(root,'racing.sqlite');
  const promise=store.backup(destination);
  fs.writeFileSync(destination,'unrelated fixture data',{flag:'wx'});
  await assert.rejects(promise,error=>error.code==='EEXIST');
  assert.equal(fs.readFileSync(destination,'utf8'),'unrelated fixture data');
  assert.ok(!fs.readdirSync(root).some(name=>name.startsWith('.orbit-backup-')));
});
test('an existing empty store is not silently accepted as a restored backup',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-empty-backup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'workspace.sqlite'),'');
  assert.throws(()=>new SqliteWorkspaceStore(root),error=>error.category==='STORE_UNINITIALIZED');
});
test('reconciliation repairs projection permissions and metadata-only reads preserve acknowledgement',t=>{
  const {root,store,id}=fixture(t),directory=path.join(root,'workspace-access'),file=path.join(directory,`${id}.json`);
  fs.chmodSync(directory,0o755);fs.chmodSync(file,0o644);
  store.reconcileConnections();
  assert.equal(fs.statSync(directory).mode&0o777,0o700);assert.equal(fs.statSync(file).mode&0o777,0o600);
  store.observe(id,{observedRevision:1});store.observe(id,{});
  assert.equal(store.read(id).observed_revision,1);
});
test('administration backup, restore and legacy export operate only on new destinations',async t=>{
  const {root,store,id}=fixture(t),backup=path.join(root,'backup.sqlite'),restore=path.join(root,'restored'),legacy=path.join(root,'legacy-export');
  const command=async(action,args)=>exec(process.execPath,['--experimental-strip-types','scripts/workspace_store.mjs',action,...args],{env:{PATH:process.env.PATH}});
  await command('backup',['--runtime',root,'--destination',backup]);
  await command('restore',['--runtime',restore,'--source',backup,'--confirm-stopped']);
  const restored=new SqliteWorkspaceStore(restore);
  try {assert.deepEqual(restored.read(id),store.read(id));assert.deepEqual(restored.eventsAfter(0),store.eventsAfter(0));}finally {restored.close();}
  await assert.rejects(command('restore',['--runtime',restore,'--source',backup,'--confirm-stopped']));
  await command('export-legacy',['--runtime',root,'--destination',legacy,'--confirm-stopped']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacy,'workspaces',`${id}.json`))),store.read(id));
  assert.equal(fs.existsSync(path.join(legacy,'workspace.sqlite')),false);
  await assert.rejects(command('export-legacy',['--runtime',root,'--destination',legacy,'--confirm-stopped']));
});
