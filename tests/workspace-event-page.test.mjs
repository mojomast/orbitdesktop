import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-event-page-')),store=new SqliteWorkspaceStore(root),ids=[randomUUID(),randomUUID()];
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const commit=(id,revision)=>store.commit(commandIdentity({workspace_id:id,action:'sync',base_revision:revision,operation_id:randomUUID(),intent:'Private fixture intent'},'owner'),revision?{apply:r=>({...r.state,arc:12})}:{create:()=>({id,revision:1,state:initial(),capability:'secret-fixture',api:'http://127.0.0.1:4318'})});
  return {store,ids,commit};
}
test('event pages scope before limit, retain scoped cursor across unrelated writes and omit private data',t=>{
  const {store,ids:[a,b],commit}=fixture(t);
  commit(a,0);commit(b,0);commit(b,1);commit(a,1);commit(b,2);
  const first=store.eventPage(a,0,1);
  assert.equal(first.events.length,1);assert.equal(first.events[0].payload.revision,1);assert.equal(first.has_more,true);
  const second=store.eventPage(a,first.cursor,1);
  assert.equal(second.events.length,1);assert.equal(second.events[0].payload.revision,2);assert.equal(second.has_more,false);
  const empty=store.eventPage(a,second.cursor,100);
  assert.equal(empty.cursor,second.cursor);assert.deepEqual(empty.events,[]);
  const text=JSON.stringify([first,second,empty]);
  for(const secret of [b,'secret-fixture','Private fixture intent','monitors','record_json'])assert.equal(text.includes(secret),false,secret);
  assert.equal(store.eventPage(b,0,100).events.length,3);
});
test('expired and future cursors explicitly request a snapshot reset with a workspace-local cursor',t=>{
  const {store,ids:[a,b],commit}=fixture(t);commit(a,0);commit(b,0);
  const insert=store.db.prepare('INSERT INTO events(event_json) VALUES (?)');
  store.db.transaction(()=>{for(let i=0;i<1002;i++)insert.run(JSON.stringify({workspace_id:a,type:'workspace.command',timestamp:i,causation_id:'fixture',correlation_id:'fixture',payload:{action:'sync',revision:2,changed:false,state:{secret:'must-not-escape'},capability:'never'}}));})();
  const reset=store.eventPage(a,0,100);
  assert.deepEqual(reset,{workspace_id:a,events:[],cursor:1004,has_more:false,reset_required:true});
  assert.equal(store.eventPage(a,reset.cursor,100).reset_required,false);
  assert.equal(store.eventPage(a,reset.cursor+1,100).reset_required,true);
  assert.equal(store.eventPage(b,0,100).reset_required,false,'Other workspace volume cannot expire this cursor');
  const replay=store.eventPage(a,1003,100);
  assert.equal(replay.events.length,1);assert.equal(JSON.stringify(replay).includes('must-not-escape'),false);assert.equal(JSON.stringify(replay).includes('capability'),false);
});
test('event pages reject invalid bounds and missing workspace without changing observation or outbox',t=>{
  const {store,ids:[a],commit}=fixture(t);commit(a,0);const before=store.read(a),count=store.diagnostics().events;
  for(const [cursor,limit] of [[-1,1],[0,0],[0,101],[NaN,1],[Number.MAX_SAFE_INTEGER+1,1]])assert.throws(()=>store.eventPage(a,cursor,limit),error=>error.category==='INVALID_OPERATION');
  assert.throws(()=>store.eventPage(randomUUID(),0,1),error=>error.code==='ENOENT');
  store.eventPage(a,0,100);assert.deepEqual(store.read(a),before);assert.equal(store.diagnostics().events,count);
});
