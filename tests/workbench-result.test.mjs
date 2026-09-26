import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseNativeResult} from '../server/workbench-native-runtime.mjs';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchNative} from '../server/workbench-native.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
import {HERMES_NATIVE_CONTRACT} from '../contracts/workbench-native-v1.mjs';
import {validateResultReceipt} from '../contracts/workbench-result-v1.mjs';

const frame=(text,completed=true)=>Buffer.from(JSON.stringify({version:1,type:'final_response',text,completed})+'\n');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('FD4 validates UTF-8, byte bounds, framing, duplicates and partial outcomes',()=>{
  assert.equal(parseNativeResult(frame('🚀 測試')).text,'🚀 測試');
  assert.equal(parseNativeResult(Buffer.alloc(0)).reason,'missing');
  assert.equal(parseNativeResult(frame('')).reason,'empty');
  assert.equal(parseNativeResult(frame(' '.repeat(5))).reason,'empty');
  assert.equal(parseNativeResult(frame('a'.repeat(65537))).reason,'oversized');
  assert.equal(parseNativeResult(Buffer.from('{"version":1}\n')).reason,'malformed');
  assert.equal(parseNativeResult(Buffer.from([0xff,10])).reason,'malformed');
  assert.equal(parseNativeResult(frame('okay').subarray(0,-1)).reason,'incomplete');
  assert.equal(parseNativeResult(Buffer.concat([frame('same'),frame('same')])).availability,'available');
  assert.equal(parseNativeResult(Buffer.concat([frame('a'),frame('b')])).reason,'conflict');
  assert.equal(parseNativeResult(Buffer.concat([frame('a'),frame('a'),frame('a')])).reason,'duplicate');
  assert.equal(parseNativeResult(frame('partial',false)).reason,'runtime_failed');
  assert.equal(parseNativeResult(frame('partial',false)).text,'partial');
});

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/sol-result-'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum=(a,b)=>a-b;\n');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID(),pane_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Result fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4321'})});
  const records=new WorkbenchStore(store),opened=openProjectRoot(projectRoot),project=records.register(workspace_id,{root:projectRoot,name:'Result fixture',identity:opened.identity});opened.close();
  const data=new WorkbenchData(store),gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate}),base={workspace_id,project_id:project.id};let finish;
  const binding={trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'result-session',config_generation:1,binding_revision:1,native_runtime:{kind:'local-pinned',commit:HERMES_NATIVE_CONTRACT.commit,model:'fixture',destination:'loopback configured model endpoint',configuration_hash:'a'.repeat(64)}};
  const holds=new Map();const hermes={readBinding:async()=>binding,startNative:async config=>({completion:new Promise(resolve=>finish=resolve),releaseNative:gate.claim('agent',config.run_id)}),stopNative:async()=>({requested:true}),quarantineNative:({grant_id})=>{if(!holds.has(grant_id))holds.set(grant_id,gate.quarantine(`native:${grant_id}`));},acknowledgeNativeUnknown:({grant_id})=>{holds.get(grant_id)?.();holds.delete(grant_id);}};
  const native=createWorkbenchNative({store,records,data,execution,hermes});
  const call=(action,fields={})=>execution.dispatch({...base,action,...fields});
  const owner=(action,fields={})=>native.dispatch({...base,action,...fields});
  async function start(){
    const {task}=await call('task_create',{title:'Repair sum',acceptance_statement:'sum must add',check_definition_id:'host-regression',profile_id:'fixture',session_id:'result-session',pane_id});
    const p=await call('candidate_preview',{task_id:task.id}),{candidate}=await call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});
    const {attempt}=await call('attempt_create',{task_id:task.id,candidate_id:candidate.id,profile_id:'fixture',session_id:'result-session',pane_id});
    const preview=await owner('preview',{attempt_id:attempt.id,context_ids:[],budget:{calls:10,checks:1,duration_ms:90000}});
    const {grant}=await owner('approve',{preview_id:preview.preview_id,preview_digest:preview.preview_digest});
    await owner('start',{grant_id:grant.id});return {task,candidate,attempt,grant};
  }
  t.after(()=>{native.close();execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {store,records,data,execution,gate,hermes,binding,native,base,pane_id,start,owner,finish:result=>finish({termination_confirmed:true,exit_code:0,result:parseNativeResult(result===null?Buffer.alloc(0):frame(result))})};
}
test('durable owner result survives reload, stays distinct from checks, and host card requires explicit delivery',async t=>{
  const f=fixture(t),{task,candidate,attempt,grant}=await f.start();
  assert.equal((await f.owner('status',{grant_id:grant.id})).result.availability,'pending');
  f.finish('Repaired Unicode 🚀; evidence:00000000-0000-0000-0000-000000000001');await settle();
  const status=await f.owner('status',{grant_id:grant.id});assert.equal(status.grant.status,'completed');
  const result=status.result;assert.equal(result.availability,'available');assert.equal(result.text.includes('🚀'),true);
  assert.equal(validateResultReceipt(result),true);assert.equal(Object.hasOwn(result,'revision'),false);
  assert.equal(result.task_id,task.id);assert.equal(result.attempt_id,attempt.id);assert.equal(result.candidate_id,candidate.id);
  assert.deepEqual(result.model_suggested_references,[{evidence_id:'00000000-0000-0000-0000-000000000001'}]);assert.deepEqual(result.resolved_references,[]);
  assert.equal((await f.owner('result_get',{result_id:result.id})).result.text,result.text);
  assert.equal(f.data.list('cards',f.base.workspace_id,f.base.project_id).length,0);
  const op_id=randomUUID(),delivery=await f.owner('result_deliver',{result_id:result.id,pane_id:f.pane_id,profile_id:'fixture',session_id:'result-session',op_id});
  assert.equal((await f.owner('result_deliver',{result_id:result.id,pane_id:f.pane_id,profile_id:'fixture',session_id:'result-session',op_id})).card.id,delivery.card.id);
  const cards=await f.native.dispatch({action:'cards_list',workspace_id:f.base.workspace_id,pane_id:f.pane_id,profile_id:'fixture',session_id:'result-session'});assert.equal(cards.cards[0].text,result.text);
  assert.equal((await f.native.dispatch({action:'cards_list',workspace_id:f.base.workspace_id,pane_id:randomUUID(),profile_id:'fixture',session_id:'result-session'})).cards.length,0);
  assert.equal((await f.owner('status',{grant_id:grant.id})).result.id,result.id);
  const fresh=f.data.get('grants',f.base.workspace_id,f.base.project_id,grant.id);
  f.data.update('grants',f.base.workspace_id,f.base.project_id,grant.id,fresh.revision,{expires_at:0});
  assert.equal((await f.owner('result_get',{result_id:result.id})).result.text,result.text);
});
test('a zero exit with no FD4 frame is typed unavailable, without inventing explanation',async t=>{
  const f=fixture(t),{grant}=await f.start();
  f.finish(null);await settle();
  const result=(await f.owner('status',{grant_id:grant.id})).result;
  assert.equal(result.availability,'explanation_unavailable');assert.equal(result.unavailable_reason,'missing');assert.equal(result.text,null);
});
test('stop before result fences late explanation and preserves termination independently',async t=>{
  const f=fixture(t),{grant}=await f.start();await f.owner('stop',{grant_id:grant.id});f.finish('late secret');await settle();
  const status=await f.owner('status',{grant_id:grant.id});assert.equal(status.grant.status,'stopped');assert.equal(status.grant.runtime_status,'exited');assert.equal(status.result.unavailable_reason,'fenced');assert.equal(status.result.text,null);
});
test('result DB failure stages a private receipt and DB-only retry never reruns Hermes',async t=>{
  const f=fixture(t),{grant}=await f.start(),original=f.data.update.bind(f.data);let failed=false;
  f.data.update=(kind,...args)=>{if(kind==='results'&&!failed){failed=true;throw Error('injected result write failure');}return original(kind,...args);};
  f.finish('durable receipt');await settle();
  const pending=await f.owner('status',{grant_id:grant.id});
  assert.equal(pending.grant.status,'result_pending');assert.equal(pending.result.availability,'pending');assert.equal(pending.health.healthy,false);
  assert.throws(()=>f.gate.claim('job',randomUUID()),{code:'busy'});
  f.native.close();const replacement=createWorkbenchNative({store:f.store,records:f.records,data:f.data,execution:f.execution,hermes:f.hermes});t.after(()=>replacement.close());
  const dispatch=(action,fields={})=>replacement.dispatch({...f.base,action,...fields});
  const recovered=await dispatch('result_retry',{result_id:pending.result.id,expected_digest:pending.grant.pending_digest});
  assert.equal(recovered.result.text,'durable receipt');assert.equal((await dispatch('status',{grant_id:grant.id})).grant.status,'completed');
  const release=f.gate.claim('job',randomUUID());release();
  assert.equal((await dispatch('result_retry',{result_id:pending.result.id,expected_digest:pending.grant.pending_digest})).replayed,true);
});
test('card delivery rechecks project and recipient after asynchronous binding lookup',async t=>{
  const f=fixture(t),{grant}=await f.start();f.finish('safe text');await settle();
  const {result}=await f.owner('status',{grant_id:grant.id});
  let release,entered;const barrier=new Promise(resolve=>release=resolve),enteredPromise=new Promise(resolve=>entered=resolve);
  f.hermes.readBinding=async()=>{entered();await barrier;return f.binding;};
  const pending=f.owner('result_deliver',{result_id:result.id,pane_id:f.pane_id,profile_id:'fixture',session_id:'result-session',op_id:randomUUID()});
  await enteredPromise;const project=f.records.project(f.base.workspace_id,f.base.project_id);
  f.records.revoke(f.base.workspace_id,f.base.project_id,project.generation);release();
  await assert.rejects(pending,{code:'permission_denied'});
  assert.equal(f.data.list('cards',f.base.workspace_id,f.base.project_id).length,0);
});
test('cards_list paginates intact text under the owner response cap',async t=>{
  const f=fixture(t),{grant}=await f.start();f.finish('x'.repeat(60000));await settle();
  const {result}=await f.owner('status',{grant_id:grant.id}),op_id=randomUUID();
  const delivered=await f.owner('result_deliver',{result_id:result.id,pane_id:f.pane_id,profile_id:'fixture',session_id:'result-session',op_id});
  for(let i=0;i<42;i++)f.data.create('cards',{workspace_id:f.base.workspace_id,project_id:f.base.project_id,project_generation:result.project_generation,op_id:randomUUID(),result_id:result.id,task_id:result.task_id,attempt_id:result.attempt_id,pane_id:f.pane_id,profile_id:'fixture',session_id:'result-session',recipient_digest:delivered.card.recipient_digest});
  const query=fields=>f.native.dispatch({action:'cards_list',workspace_id:f.base.workspace_id,pane_id:f.pane_id,profile_id:'fixture',session_id:'result-session',...fields});
  const first=await query({});assert.equal(first.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(first))<1500000);assert.ok(first.cards.every(card=>card.text.length===60000));
  let count=first.cards.length,cursor=first.next_cursor;
  while(cursor){const page=await query({after_id:cursor});count+=page.cards.length;cursor=page.next_cursor;assert.ok(Buffer.byteLength(JSON.stringify(page))<1500000);}
  assert.equal(count,43);
});
test('post-commit journal unlink fault cannot wedge finalized receipt or replay',async t=>{
  const f=fixture(t),{grant}=await f.start(),unlink=fs.unlinkSync;
  try{
    fs.unlinkSync=(filename,...args)=>{if(String(filename).includes('native-result-journal'))throw Error('injected unlink failure');return unlink(filename,...args);};
    f.finish('committed despite cleanup fault');await settle();
  }finally{fs.unlinkSync=unlink;}
  const {result,grant:finished,health}=await f.owner('status',{grant_id:grant.id});
  assert.equal(finished.status,'completed');assert.equal(health.healthy,true);assert.equal(result.text,'committed despite cleanup fault');
  assert.equal((await f.owner('result_retry',{result_id:result.id,expected_digest:finished.finalized_digest})).replayed,true);
  const release=f.gate.claim('job',randomUUID());release();
});
test('restart restores observed-only journal without re-executing or disclosing unproven text',async t=>{
  const f=fixture(t),{grant}=await f.start(),original=f.data.get.bind(f.data);let candidateReads=0;
  f.data.get=(kind,...args)=>{if(kind==='candidates'&&++candidateReads===2)throw Error('candidate read fault');return original(kind,...args);};
  f.finish('observed but authorization unresolved');await settle();f.data.get=original;
  const pending=await f.owner('status',{grant_id:grant.id});assert.equal(pending.grant.status,'result_pending');
  // Emulate power loss after observed journal fsync but before pending-grant CAS.
  const persisted=f.data.get('grants',f.base.workspace_id,f.base.project_id,grant.id);
  f.data.update('grants',f.base.workspace_id,f.base.project_id,grant.id,persisted.revision,{status:'running',runtime_status:'running',result_status:'pending',pending_digest:null,final_status:null});
  f.native.close();const next=createWorkbenchNative({store:f.store,records:f.records,data:f.data,execution:f.execution,hermes:f.hermes});t.after(()=>next.close());
  const query=(action,fields={})=>next.dispatch({...f.base,action,...fields}),recovered=await query('status',{grant_id:grant.id});
  assert.equal(recovered.grant.status,'result_pending');assert.throws(()=>f.gate.claim('job',randomUUID()),{code:'busy'});
  const saved=await query('result_retry',{result_id:pending.result.id,expected_digest:recovered.grant.pending_digest});
  assert.equal(saved.result.unavailable_reason,'persistence_failed');assert.equal(saved.result.text,null);
  const release=f.gate.claim('job',randomUUID());release();
});
test('journal creation fault fences shared dispatch as unknown without publishing text',async t=>{
  const f=fixture(t),{grant}=await f.start(),open=fs.openSync;
  try{
    fs.openSync=(filename,...args)=>{if(String(filename).includes('native-result-journal'))throw Error('journal filesystem fault');return open(filename,...args);};
    f.finish('not durably observed');await settle();
  }finally{fs.openSync=open;}
  const status=await f.owner('status',{grant_id:grant.id});
  assert.equal(status.grant.status,'dispatch_unknown');assert.equal(status.result.availability,'pending');assert.throws(()=>f.gate.claim('job',randomUUID()),{code:'busy'});
  assert.equal((await f.owner('acknowledge_unknown',{grant_id:grant.id,expected_digest:status.unknown_digest,known_externally_terminated:true})).replayed,false);
  const acknowledged=await f.owner('status',{grant_id:grant.id});assert.equal(acknowledged.result.unavailable_reason,'persistence_failed');assert.equal(acknowledged.result.text,null);
  const release=f.gate.claim('job',randomUUID());release();
});
test('owner historical candidate reads bind exact generation/hash and reject tampered roots',async t=>{
  const f=fixture(t),{candidate}=await f.start(),original=candidate.files.find(file=>file.path==='math.js');
  const request=(action,fields={})=>f.execution.dispatch({...f.base,action,candidate_id:candidate.id,...fields});
  const changed=await request('candidate_apply',{expected_candidate_hash:candidate.hash,changes:[{op:'change',path:'math.js',expected_hash:original.hash,content:'export const sum=(a,b)=>a+b;\n'}]});
  const old={candidate_hash:candidate.hash,generation:candidate.generation},newer={candidate_hash:changed.candidate.hash,generation:changed.candidate.generation};
  const oldVersion=await request('candidate_version_get',old),newVersion=await request('candidate_version_get',newer);
  assert.equal(oldVersion.candidate.hash,candidate.hash);assert.equal(newVersion.candidate.hash,changed.candidate.hash);
  assert.equal((await request('candidate_version_read',{...old,path:'math.js'})).file.text,'export const sum=(a,b)=>a-b;\n');
  assert.equal((await request('candidate_version_read',{...newer,path:'math.js'})).file.text,'export const sum=(a,b)=>a+b;\n');
  await assert.rejects(request('candidate_version_get',{generation:1,candidate_hash:'f'.repeat(64)}),{code:'stale_resource'});
  const stored=f.data.get('candidates',f.base.workspace_id,f.base.project_id,candidate.id);
  fs.writeFileSync(path.join(stored.root_history[0].root,'math.js'),'tampered');
  await assert.rejects(request('candidate_version_get',old),{code:'stale_resource'});
  await assert.rejects(request('candidate_version_read',{...old,path:'math.js'}),{code:'stale_resource'});
});
