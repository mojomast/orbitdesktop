import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {createBuildQueue} from '../server/build-queue.mjs';
const workspace_id='eed047a8-e519-495e-a7ca-1c8c150a6ef4';
function fixture(t){const directory=mkdtempSync(path.join(os.tmpdir(),'orbit-queue-'));let calls=[],run={},fail;const q=createBuildQueue({directory,interval:0,context:()=>'',upstream:async(p,b)=>{calls.push([p,b]);if(fail)throw fail;if(p==='/v1/runs'){run={session_id:b.session_id,status:'running',run_id:'run_queue_testing'};return run;}return run;}});t.after(()=>{q.close();rmSync(directory,{recursive:true,force:true});});const read=()=>q.action({workspace_id,operation:'read'});const act=async(operation,extra={})=>q.action({workspace_id,operation,base_revision:(await read()).revision,...extra});return {q,read,act,calls,directory,set:(v)=>Object.assign(run,v),fail:(v)=>fail=v};}
test('queue submits once, serializes tasks, retains evidence; terminal completion never auto-advances',async t=>{
 const f=fixture(t);await f.act('add',{input:'first'});await f.act('add',{input:'second'});await f.act('start',{confirm:true});
 await Promise.all([f.q.tick(),f.q.tick()]);assert.equal(f.calls.filter(c=>c[0]==='/v1/runs').length,1);
 await f.q.tick();assert.equal(f.calls.filter(c=>c[0]==='/v1/runs').length,1);
 f.set({status:'completed',output:'Verified output\n[WORKSHOP_DONE]'});await f.q.tick();
 const done=await f.read();assert.equal(done.tasks[0].status,'completed');assert.equal(done.enabled,false);
 assert.match(done.tasks[0].note,/Not recorder-verified/);
 assert.match(done.tasks[0].note,/WORKSHOP_DONE/);
 // The marker is an annotation only: it never advances the next task on its own.
 await f.q.tick();assert.equal(f.calls.filter(c=>c[0]==='/v1/runs').length,1);
 // Only an explicit owner Start resumes the queued task.
 await f.act('start',{confirm:true});await f.q.tick();
 assert.equal(f.calls.filter(c=>c[0]==='/v1/runs').length,2);
});
test('agent-reported completion without a marker still stops and never auto-advances',async t=>{
 const f=fixture(t);await f.act('add',{input:'one'});await f.act('add',{input:'two'});await f.act('start',{confirm:true});await f.q.tick();
 f.set({status:'completed',output:'I need clarification.'});await f.q.tick();
 const done=await f.read();assert.equal(done.enabled,false);assert.equal(done.tasks[0].status,'completed');
 assert.match(done.tasks[0].note,/Not recorder-verified/);
 await f.q.tick();assert.equal(f.calls.filter(c=>c[0]==='/v1/runs').length,1);
});
test('a failed terminal run blocks for review and cannot be resumed past',async t=>{
 const f=fixture(t);await f.act('add',{input:'one'});await f.act('start',{confirm:true});await f.q.tick();
 f.set({status:'failed',output:'boom'});await f.q.tick();
 assert.equal((await f.read()).enabled,false);assert.equal((await f.read()).tasks[0].status,'blocked');
 await assert.rejects(f.act('start',{confirm:true}),/Review/);
});
test('busy submission is queued but never retried automatically',async t=>{const f=fixture(t);await f.act('add',{input:'one'});await f.act('start',{confirm:true});f.fail(Object.assign(Error('busy'),{status:429}));await f.q.tick();await f.q.tick();assert.equal(f.calls.length,1);assert.equal((await f.read()).tasks[0].status,'queued');assert.equal((await f.read()).enabled,false);});
test('ambiguous network failure blocks replay',async t=>{const f=fixture(t);await f.act('add',{input:'one'});await f.act('start',{confirm:true});f.fail(Error('timeout'));await f.q.tick();assert.equal((await f.read()).tasks[0].status,'blocked');await assert.rejects(f.act('start',{confirm:true}));});
test('approval pauses queue; explicit approval resumes run only',async t=>{const f=fixture(t);await f.act('add',{input:'one'});await f.act('start',{confirm:true});await f.q.tick();f.set({status:'waiting_for_approval'});await f.q.tick();let d=await f.read();assert.equal(d.enabled,false);await f.act('approval',{task_id:d.tasks[0].id,choice:'once',confirm:true});assert.equal((await f.read()).enabled,false);assert.equal(f.calls.at(-1)[0],'/v1/runs/run_queue_testing/approval');});
test('restart retains tasks and run ID but starts paused; revision protects edits',async t=>{const f=fixture(t);await f.act('add',{input:'one'});await f.act('start',{confirm:true});await f.q.tick();const q=createBuildQueue({directory:f.directory,interval:0,context:()=>'',upstream:async()=>{throw Error('unexpected');}});t.after(()=>q.close());const d=await q.action({workspace_id,operation:'read'});assert.equal(d.enabled,false);assert.equal(d.tasks[0].run,'run_queue_testing');await assert.rejects(q.action({workspace_id,operation:'add',base_revision:0,input:'bad'}),/changed/);await assert.rejects(q.action({workspace_id:'../x',operation:'read'}),/Invalid workspace/);});
test('pause and stop do not launch the next task',async t=>{const f=fixture(t);await f.act('add',{input:'one'});await f.act('start',{confirm:true});await f.q.tick();await f.act('stop',{task_id:(await f.read()).tasks[0].id,confirm:true});assert.equal(f.calls.at(-1)[0],'/v1/runs/run_queue_testing/stop');assert.equal((await f.read()).enabled,false);});
// ---- staged adapter: legacy queue registers with the shared serial gate ----
function fakeGate(initial={}){
 let provider=null,releases=0,busy=false,job=!!initial.job;const claims=[];
 return {
  setLegacyStatus(fn){provider=fn;},
  status(){return {agent:false,job,legacy:provider?provider():undefined};},
  claim(kind,id){claims.push([kind,id]);if(busy)throw Object.assign(Error('busy'),{code:'busy'});return ()=>{releases++;};},
  setJob(v){job=v;},setBusy(v){busy=v;},claims,hasProvider:()=>typeof provider==='function',provider:()=>provider&&provider(),releaseCount:()=>releases,
 };
}
function gateFixture(t,gate){
 const directory=mkdtempSync(path.join(os.tmpdir(),'orbit-queue-'));let calls=[],run={},fail;
 const q=createBuildQueue({directory,interval:0,context:()=>'',executionGate:gate,upstream:async(p,b)=>{calls.push([p,b]);if(fail)throw fail;if(p==='/v1/runs'){run={session_id:b.session_id,status:'running',run_id:'run_queue_testing'};return run;}return run;}});
 t.after(()=>{q.close();rmSync(directory,{recursive:true,force:true});});
 const read=()=>q.action({workspace_id,operation:'read'});const act=async(operation,extra={})=>q.action({workspace_id,operation,base_revision:(await read()).revision,...extra});
 return {q,read,act,calls,directory,set:(v)=>Object.assign(run,v),fail:(v)=>fail=v};
}
test('staged adapter: start refuses while a managed Workbench job is active',async t=>{
 const gate=fakeGate({job:true});const f=gateFixture(t,gate);
 await f.act('add',{input:'first'});
 await assert.rejects(f.act('start',{confirm:true}),/A managed Workbench job is active; wait for it to finish\./);
 assert.equal((await f.read()).enabled,false);
});
test('staged adapter: legacy lane release is invoked when the run reaches terminal state',async t=>{
 const gate=fakeGate();const f=gateFixture(t,gate);
 await f.act('add',{input:'first'});await f.act('start',{confirm:true});await f.q.tick();
 assert.deepEqual(gate.claims,[['legacy-agent',(await f.read()).tasks[0].id]]);
 f.set({status:'completed',output:'done\n[WORKSHOP_DONE]'});
 await f.q.tick();
 assert.equal(gate.releaseCount(),1);
});
test('staged adapter: busy legacy claim stays queued and paused with no replay',async t=>{
 const gate=fakeGate();gate.setBusy(true);const f=gateFixture(t,gate);
 await f.act('add',{input:'first'});await f.act('start',{confirm:true});await f.q.tick();
 let d=await f.read();
 assert.equal(d.tasks[0].status,'queued');
 assert.equal(d.enabled,false);
 assert.match(d.tasks[0].note,/managed Workbench job/);
 const before=f.calls.length;
 await f.q.tick();
 assert.equal(f.calls.length,before);
});
test('staged adapter: status/check counts contain no task input or run payload',async t=>{
 const gate=fakeGate();const f=gateFixture(t,gate);
 await f.act('add',{input:'SECRET-INPUT'});
 let st=f.q.status();
 assert.deepEqual({...st},{revision:st.revision,enabled:false,active:0,uncertain:0,pending:1});
 await f.act('start',{confirm:true});await f.q.tick();
 st=f.q.status();
 assert.deepEqual({...st},{revision:st.revision,enabled:true,active:1,uncertain:0,pending:0});
 const chk=f.q.check();
 assert.deepEqual(chk,{enabled:true,counts:{active:1,uncertain:0,pending:0},managed_job_active:false});
 const payload=JSON.stringify(st)+JSON.stringify(chk);
 assert.equal(payload.includes('SECRET-INPUT'),false);
 assert.equal(payload.includes('run_queue_testing'),false);
});
test('staged adapter: setLegacyStatus provider reports pending then active',async t=>{
 const gate=fakeGate();const f=gateFixture(t,gate);
 assert.equal(gate.hasProvider(),true);
 await f.act('add',{input:'first'});
 assert.deepEqual(gate.provider(),{enabled:false,active:0,uncertain:0,pending:1});
 await f.act('start',{confirm:true});await f.q.tick();
 assert.deepEqual(gate.provider(),{enabled:true,active:1,uncertain:0,pending:0});
});
test('staged adapter: old queue.json still migrates starting to blocked/uncertain, no replay',async t=>{
 const directory=mkdtempSync(path.join(os.tmpdir(),'orbit-queue-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const old={version:1,revision:7,enabled:true,tasks:[{id:'11111111-1111-1111-1111-111111111111',workspace:workspace_id,session:'orbit-x',input:'legacy input',status:'starting',run:'run_old',note:'Submitting'}]};
 writeFileSync(path.join(directory,'queue.json'),JSON.stringify(old));
 const gate=fakeGate();
 const q=createBuildQueue({directory,interval:0,context:()=>'',executionGate:gate,upstream:async()=>{throw Error('unexpected');}});
 t.after(()=>q.close());
 const d=await q.action({workspace_id,operation:'read'});
 assert.equal(d.enabled,false);
 assert.equal(d.tasks[0].status,'blocked');
 assert.match(d.tasks[0].note,/outcome unknown/i);
 assert.deepEqual(q.status(),{revision:q.status().revision,enabled:false,active:0,uncertain:1,pending:0});
 assert.deepEqual(q.check(),{enabled:false,counts:{active:0,uncertain:1,pending:0},managed_job_active:false});
 await q.tick();
 assert.equal((await q.action({workspace_id,operation:'read'})).enabled,false);
});
