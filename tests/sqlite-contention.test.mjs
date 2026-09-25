import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initial} from '../src/model.ts';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
const moduleUrl=new URL('../server/sqlite-workspace-store.mjs',import.meta.url).href;

function command(id,revision) {return commandIdentity({workspace_id:id,base_revision:revision,operation_id:randomUUID(),intent:'Isolated contention test',action:'sync'},'test-owner');}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-contention-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
function child(script,args=[]) {
  return spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',script,...args],{cwd:path.resolve('.'),env:{PATH:process.env.PATH},stdio:['ignore','ignore','pipe','ipc']});
}
test('another process holding the writer lock is bounded; failed command key remains safely retryable',async t=>{
  const root=fixture(t),store=new SqliteWorkspaceStore(root,{busyTimeoutMs:30}),id=randomUUID();
  t.after(()=>store.close());
  store.commit(command(id,0),{create:()=>({id,revision:1,state:initial(),capability:'test-only',api:'http://127.0.0.1:4318'})});
  const process=child(`import Database from 'better-sqlite3'; const db=new Database(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.on('message',()=>{db.exec('ROLLBACK');db.close();process.exit(0)});process.send('locked');`,[path.join(root,'workspace.sqlite')]);
  t.after(()=>{if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL');});
  const exited=once(process,'exit');
  assert.equal((await once(process,'message',{signal:AbortSignal.timeout(5000)}))[0],'locked');
  const identity=command(id,1),change={apply:record=>({...record.state,sidebarHidden:true}),checkpointLabel:'Before change'};
  const start=Date.now();
  assert.throws(()=>store.commit(identity,change),error=>error.category==='RESOURCE_BUSY');
  assert.ok(Date.now()-start<2000,'Busy timeout should not hang indefinitely');
  assert.equal(store.read(id).revision,1);assert.equal(store.eventsAfter(0).length,1);
  process.send('release');await exited;
  assert.equal(store.commit(identity,change).record.revision,2);
  assert.equal(store.commit(identity,change).replayed,true);
});
test('two real processes with the same base revision cannot both commit',async t=>{
  const root=fixture(t),id=randomUUID(),store=new SqliteWorkspaceStore(root);
  t.after(()=>store.close());
  store.commit(command(id,0),{create:()=>({id,revision:1,state:initial(),capability:'test-only',api:'http://127.0.0.1:4318'})});
  const script=`import {SqliteWorkspaceStore} from ${JSON.stringify(moduleUrl)};const store=new SqliteWorkspaceStore(process.argv[1]);const command=JSON.parse(process.argv[2]);try{store.commit(command,{apply:r=>({...r.state,sidebarHidden:true}),checkpointLabel:'Concurrent change'});process.send('committed')}catch(e){process.send(e.category)}finally{store.close();process.disconnect()}`;
  const workers=[child(script,[root,JSON.stringify(command(id,1))]),child(script,[root,JSON.stringify(command(id,1))])];
  t.after(()=>workers.forEach(worker=>{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');}));
  const exits=workers.map(worker=>once(worker,'exit'));
  const results=await Promise.all(workers.map(worker=>once(worker,'message',{signal:AbortSignal.timeout(10000)}).then(([message])=>message)));
  await Promise.all(exits);
  assert.deepEqual(results.sort(),['REVISION_CONFLICT','committed']);
  assert.equal(store.read(id).revision,2);assert.equal(store.checkpointList(id).length,1);assert.equal(store.eventsAfter(0).length,2);
});
test('SIGKILL during legacy import leaves no partial migration and retained originals permit a clean retry',async t=>{
  const root=fixture(t),id=randomUUID(),checkpointId=randomUUID();
  fs.mkdirSync(path.join(root,'workspaces'));fs.mkdirSync(path.join(root,'checkpoints',id),{recursive:true});
  const record={id,revision:3,state:initial(),capability:'legacy-fixture',api:'http://127.0.0.1:4318'};
  const original=JSON.stringify(record,null,2),checkpoint=JSON.stringify({id:checkpointId,revision:2,created:1234,label:'Retained',state:record.state});
  const recordFile=path.join(root,'workspaces',`${id}.json`),checkpointFile=path.join(root,'checkpoints',id,`${checkpointId}.json`);
  fs.writeFileSync(recordFile,original);fs.writeFileSync(checkpointFile,checkpoint);
  const process=child(`import {SqliteWorkspaceStore} from ${JSON.stringify(moduleUrl)};class Interrupted extends SqliteWorkspaceStore {insertCheckpoint(...args){super.insertCheckpoint(...args);process.kill(process.pid,'SIGKILL')}};new Interrupted(process.argv[1],{importLegacy:true});`,[root]);
  const [code,signal]=await once(process,'exit',{signal:AbortSignal.timeout(10000)});
  assert.equal(code,null);assert.equal(signal,'SIGKILL');
  assert.equal(fs.readFileSync(recordFile,'utf8'),original);assert.equal(fs.readFileSync(checkpointFile,'utf8'),checkpoint);
  assert.throws(()=>new SqliteWorkspaceStore(root),error=>error.category==='MIGRATION_REQUIRED');
  const store=new SqliteWorkspaceStore(root,{importLegacy:true});t.after(()=>store.close());
  assert.deepEqual(store.read(id),record);assert.equal(store.checkpointList(id).length,1);assert.equal(store.eventsAfter(0).length,0);
});
