import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchNative} from '../server/workbench-native.mjs';
import {createWorkbenchNativeRuntime,readNativeApiKeyFile,nativeRuntimeEnvironmentOptions,nativeRuntimeMetadata} from '../server/workbench-native-runtime.mjs';
import {workbenchOwnerRoute} from '../server/workbench-owner-route.mjs';
import {validateNative,validateNativeTool,HERMES_NATIVE_CONTRACT} from '../contracts/workbench-native-v1.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';
const WRONG='export const sum = (a,b) => a - b;\n',RIGHT='export const sum = (a,b) => a + b;\n';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('private native endpoint key file is bounded, identity-bound and never projected',t=>{
  const root=fs.mkdtempSync('/tmp/opencode/native-key-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'key'),alias=path.join(root,'alias');fs.writeFileSync(file,'private-endpoint-token\n',{mode:0o600});
  assert.equal(readNativeApiKeyFile(file),'private-endpoint-token');
  const options=nativeRuntimeEnvironmentOptions({root,env:{ORBIT_NATIVE_HERMES_SOURCE:'/tmp/source',ORBIT_NATIVE_HERMES_PYTHON:'/tmp/python',ORBIT_NATIVE_HERMES_MODEL_URL:'http://127.0.0.1:3456/v1',ORBIT_NATIVE_HERMES_PROFILE:'fixture',ORBIT_NATIVE_HERMES_API_KEY_FILE:file}});
  assert.equal(options.apiKey,'private-endpoint-token');assert.equal(options.apiKeyFile,undefined);
  const a=nativeRuntimeMetadata({source:'/tmp/source',python:'/tmp/python',endpoint:'http://127.0.0.1:3456/v1',profile_id:'fixture',apiKey:readNativeApiKeyFile(file)});
  assert.deepEqual(nativeRuntimeMetadata(options),a,'server/index.mjs binds consent using the same key-file identity as runtime startup');
  const b=nativeRuntimeMetadata({source:'/tmp/source',python:'/tmp/python',endpoint:'http://127.0.0.1:3456/v1',profile_id:'fixture',apiKey:'rotated'});
  assert.notEqual(a.configuration_hash,b.configuration_hash);assert.equal(JSON.stringify(a).includes('private-endpoint-token'),false);
  fs.writeFileSync(file,'rotated\n');assert.deepEqual(nativeRuntimeMetadata(options),a,'rotation requires explicit service restart, not a second credential read');
  fs.writeFileSync(file,'private-endpoint-token\n');
  fs.symlinkSync(file,alias);assert.throws(()=>readNativeApiKeyFile(alias));
  fs.chmodSync(file,0o644);assert.throws(()=>readNativeApiKeyFile(file));
  fs.chmodSync(file,0o600);fs.writeFileSync(file,'x'.repeat(4097));assert.throws(()=>readNativeApiKeyFile(file));
});
function fixture(t,adapter={},now=Date.now){
  const root=fs.mkdtempSync('/tmp/opencode/wn-'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'math.js'),WRONG);
  const store=new SqliteWorkspaceStore(path.join(root,'r')),workspace_id=randomUUID(),pane_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Native fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const data=new WorkbenchData(store,{now}),records=new WorkbenchStore(store),opened=openProjectRoot(projectRoot),project=records.register(workspace_id,{root:projectRoot,name:'Native fixture',identity:opened.identity});opened.close();
  const gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate}),base={workspace_id,project_id:project.id};let bindingGeneration=1;
  const quarantines=new Map();
  const hermes={quarantineNative:({grant_id})=>{if(!quarantines.has(grant_id))quarantines.set(grant_id,gate.quarantine(`native:${grant_id}`));return true;},acknowledgeNativeUnknown:({grant_id})=>{quarantines.get(grant_id)?.();quarantines.delete(grant_id);},readBinding:async()=>({trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'native-fixture',config_generation:bindingGeneration,binding_revision:1,native_runtime:hermes.bindingMetadata??{kind:'local-pinned',commit:HERMES_NATIVE_CONTRACT.commit,model:'orbit-local-fixture',destination:'loopback configured model endpoint',configuration_hash:'0'.repeat(64)}}),...adapter};
  const native=createWorkbenchNative({store,records,data,execution,hermes,now});
  const call=(action,fields={})=>execution.dispatch({...base,action,...fields});
  async function prepare({nativeCall=body=>native.dispatch(body),budget={calls:15,checks:2,duration_ms:90000}}={}){
    const {task}=await call('task_create',{title:'Repair sum',acceptance_statement:'sum must add',check_definition_id:'host-regression',profile_id:'fixture',session_id:'native-fixture',pane_id});
    const p=await call('candidate_preview',{task_id:task.id});const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});
    const {attempt}=await call('attempt_create',{task_id:task.id,candidate_id:candidate.id,profile_id:'fixture',session_id:'native-fixture',pane_id});
    const preview=await nativeCall({...base,action:'preview',attempt_id:attempt.id,context_ids:[],budget});
    const {grant}=await nativeCall({...base,action:'approve',preview_id:preview.preview_id,preview_digest:preview.preview_digest});return {candidate,attempt,grant};
  }
  t.after(()=>{native.close();execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,projectRoot,store,data,records,gate,execution,native,hermes,base,call,prepare,bumpBinding:()=>bindingGeneration++};
}
function privateCall(channel,args,sequence=1,secret=channel.secret){
  const raw=JSON.stringify(args),mac=createHmac('sha256',secret).update(`${sequence}\n${raw}`).digest('hex');
  return new Promise((resolve,reject)=>{const req=http.request({socketPath:channel.socket,path:'/tool',method:'POST',headers:{'content-type':'application/json','x-orbit-grant':channel.grant_id,'x-orbit-sequence':String(sequence),'x-orbit-mac':mac}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(text)}));});req.on('error',reject);req.end(raw);});
}
test('strict contracts exclude model authority and owner-supplied approval shortcuts',()=>{
  assert.equal(validateNativeTool({action:'inspect'}),true);
  for(const field of ['attempt_id','workspace_id','candidate_id','profile_id','run_id','confirm','grant_id'])assert.equal(validateNativeTool({action:'inspect',[field]:randomUUID()}),false);
  assert.equal(validateNative({action:'start',workspace_id:randomUUID(),project_id:randomUUID(),grant_id:randomUUID(),confirm:true}),false);
});
test('real SQLite owner grants: HMAC/replay/cross-attempt/schema isolation, budget and binding fences',async t=>{
  const channels=[];const f=fixture(t,{startNative:async config=>{channels.push(config.channel);await config.authorize();return {completion:new Promise(()=>{})};},stopNative:async()=>({requested:true})});
  const a=await f.prepare(),b=await f.prepare();
  await f.native.dispatch({...f.base,action:'start',grant_id:a.grant.id});
  await f.native.dispatch({...f.base,action:'start',grant_id:b.grant.id});
  assert.equal((await privateCall(channels[0],{action:'inspect'},1,'wrong')).ok,false);
  const first=await privateCall(channels[0],{action:'inspect'});assert.equal(first.ok,true);assert.equal(first.result.candidate.id,a.candidate.id);
  assert.equal((await privateCall(channels[0],{action:'inspect'})).ok,false);
  assert.equal((await privateCall(channels[1],{action:'inspect'},1,channels[0].secret)).ok,false);
  assert.equal((await privateCall(channels[0],{action:'candidate_read',path:'math.js',candidate_id:b.candidate.id},2)).ok,false);
  const second=await privateCall(channels[1],{action:'inspect'});assert.equal(second.result.candidate.id,b.candidate.id);
  f.bumpBinding();assert.equal((await privateCall(channels[0],{action:'candidate_read',path:'math.js'},3)).ok,false);
  const status=await f.native.dispatch({...f.base,action:'status',grant_id:a.grant.id});assert.equal(JSON.stringify(status).includes(channels[0].secret),false);
  await f.native.dispatch({...f.base,action:'stop',grant_id:a.grant.id});assert.equal((await privateCall(channels[0],{action:'inspect'},4)).ok,false);
});

test('call/check budgets and expiration fence admission and late private results',async t=>{
  let clock=Date.now(),channel;const f=fixture(t,{startNative:async config=>{channel=config.channel;return {completion:new Promise(()=>{})};},stopNative:async()=>({requested:true})},()=>clock);
  const a=await f.prepare({budget:{calls:1,checks:0,duration_ms:1000}});await f.native.dispatch({...f.base,action:'start',grant_id:a.grant.id});
  assert.equal((await privateCall(channel,{action:'job_start'},1)).error,'limit_exceeded');
  assert.equal((await privateCall(channel,{action:'inspect'},2)).ok,true);
  assert.equal((await privateCall(channel,{action:'inspect'},3)).ok,false);
  const paused=await f.native.dispatch({...f.base,action:'status',grant_id:a.grant.id});assert.equal(paused.grant.status,'paused_budget');assert.equal(paused.grant.reason,'calls_exhausted');
  const b=await f.prepare({budget:{calls:2,checks:0,duration_ms:1000}});await f.native.dispatch({...f.base,action:'start',grant_id:b.grant.id});
  const original=f.execution.dispatch;let unblock,entered;const enteredPromise=new Promise(r=>entered=r),barrier=new Promise(r=>unblock=r);
  f.execution.dispatch=async body=>{const result=await original(body);if(body.action==='candidate_read'){entered();await barrier;}return result;};
  const pending=privateCall(channel,{action:'candidate_read',path:'math.js'},1);await enteredPromise;clock+=2000;unblock();
  const result=await pending;assert.equal(result.ok,false);assert.equal(JSON.stringify(result).includes(WRONG),false);
  assert.equal((await privateCall(channel,{action:'inspect'},2)).ok,false);
});

test('scope metadata is immutable to the channel and lost runtime ownership stays unknown on restart',async t=>{
  let channel;const f=fixture(t,{startNative:async config=>{channel=config.channel;return {completion:new Promise(()=>{})};},stopNative:async()=>({requested:true})});
  const a=await f.prepare();await f.native.dispatch({...f.base,action:'start',grant_id:a.grant.id});
  const current=f.data.get('grants',f.base.workspace_id,f.base.project_id,a.grant.id);
  f.data.update('grants',f.base.workspace_id,f.base.project_id,a.grant.id,current.revision,{authority_generation:randomUUID()});
  assert.equal((await privateCall(channel,{action:'inspect'})).ok,false);
  f.native.close();
  const replacement=createWorkbenchNative({store:f.store,records:f.records,data:f.data,execution:f.execution,hermes:f.hermes});t.after(()=>replacement.close());
  const status=await replacement.dispatch({...f.base,action:'status',grant_id:a.grant.id});assert.equal(status.grant.status,'dispatch_unknown');
  assert.equal((await replacement.dispatch({...f.base,action:'stop',grant_id:a.grant.id})).outcome_unknown,true);
  assert.equal(status.health.healthy,false);assert.equal(status.health.shared_quarantine,true);
  for(const lane of ['agent','legacy-agent','job'])assert.throws(()=>f.gate.claim(lane,randomUUID()),{code:'busy'});
  await assert.rejects(replacement.dispatch({...f.base,action:'acknowledge_unknown',grant_id:a.grant.id,expected_digest:'0'.repeat(64),known_externally_terminated:true}),{code:'stale_resource'});
  const acknowledged=await replacement.dispatch({...f.base,action:'acknowledge_unknown',grant_id:a.grant.id,expected_digest:status.unknown_digest,known_externally_terminated:true});assert.equal(acknowledged.replayed,false);
  const release=f.gate.claim('agent',randomUUID());release();
});

test('closed attempts and old project generations cannot gain or retain native authority',async t=>{
  let channel;const f=fixture(t,{startNative:async c=>{channel=c.channel;return {completion:new Promise(()=>{})};},stopNative:async()=>({requested:true})});
  const a=await f.prepare();await f.native.dispatch({...f.base,action:'start',grant_id:a.grant.id});
  const attempt=f.data.get('attempts',f.base.workspace_id,f.base.project_id,a.attempt.id);f.data.update('attempts',f.base.workspace_id,f.base.project_id,attempt.id,attempt.revision,{status:'stopped'});
  assert.equal((await privateCall(channel,{action:'inspect'})).ok,false);
  const b=await f.prepare(),project=f.records.project(f.base.workspace_id,f.base.project_id);f.records.revoke(f.base.workspace_id,project.id,project.generation);
  const opened=openProjectRoot(f.projectRoot);f.records.register(f.base.workspace_id,{root:f.projectRoot,name:'Reregistered',identity:opened.identity});opened.close();
  await assert.rejects(f.native.dispatch({...f.base,action:'start',grant_id:b.grant.id}),{code:'expired'});
  await assert.rejects(f.native.dispatch({...f.base,action:'preview',attempt_id:b.attempt.id,context_ids:[],budget:{calls:2,checks:0,duration_ms:1000}}),{code:'stale_resource'});
});

test('stop_requested does not claim termination until the owned runtime reports exit',async t=>{
  let finish;const f=fixture(t,{startNative:async()=>({completion:new Promise(resolve=>finish=resolve)}),stopNative:async()=>({requested:true})});
  const a=await f.prepare();await f.native.dispatch({...f.base,action:'start',grant_id:a.grant.id});
  const stopped=await f.native.dispatch({...f.base,action:'stop',grant_id:a.grant.id});assert.equal(stopped.grant.status,'stop_requested');assert.equal(stopped.termination_confirmed,false);
  finish({termination_confirmed:true,exit_code:0});await wait(0);
  const status=await f.native.dispatch({...f.base,action:'status',grant_id:a.grant.id});assert.equal(status.grant.status,'stopped');assert.equal(status.grant.runtime_status,'exited');assert.equal(status.grant.termination_confirmed,true);
});

test('pinned real Hermes -> actual plugin -> authenticated private bridge -> SQLite execution providers', {skip:!process.env.HERMES_NATIVE_SOURCE,timeout:120000},async t=>{
  const f=fixture(t),requests=[],toolResults=[];
  let ownerRoute;const ownerToken=randomUUID(),ownerServer=http.createServer((req,res)=>ownerRoute(req,res));
  await new Promise(resolve=>ownerServer.listen(0,'127.0.0.1',resolve));t.after(()=>ownerServer.close());
  const ownerPort=ownerServer.address().port,ownerOrigin=`http://127.0.0.1:${ownerPort}`;
  ownerRoute=workbenchOwnerRoute({token:ownerToken,port:ownerPort,devOrigins:[],dispatch:body=>f.native.dispatch(body),reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
  const nativeCall=async body=>{const response=await fetch(`${ownerOrigin}/api/workbench/native`,{method:'POST',headers:{Authorization:`Bearer ${ownerToken}`,Origin:ownerOrigin,'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  assert.equal((await fetch(`${ownerOrigin}/api/workbench/native`,{method:'POST',headers:{Origin:ownerOrigin},body:'{}'})).status,403);
  const model=http.createServer(async(req,res)=>{
    if(req.method!=='POST'){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:[]}));return;}
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
    if(!Array.isArray(body.messages)){res.statusCode=404;res.end('{}');return;}requests.push(body);
    const results=body.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return {};}});toolResults.push(...results);
    const step=results.length;let args={action:'inspect'};
    if(step===1)args={action:'job_start'};
    if(step===2)args={action:'candidate_read',path:'math.js'};
    if(step===3)args={action:'candidate_patch',expected_candidate_hash:results[0].result.candidate.hash,changes:[{op:'change',path:'math.js',expected_hash:results[2].result.file.hash,content:RIGHT}]};
    if(step===4)args={action:'job_start'};
    if(step===5)args={action:'evidence',job_id:results[4].result.job.id};
    const message=step<6?{role:'assistant',content:null,tool_calls:[{id:`call_${step}`,type:'function',function:{name:'orbit_workbench',arguments:JSON.stringify(args)}}]}:{role:'assistant',content:`Finished fixture; recorder evidence is authoritative. evidence:${results[5].result.evidence[0].id}`};
    const result={id:'fixture',object:'chat.completion',created:1,model:'orbit-local-fixture',choices:[{index:0,message,finish_reason:step<6?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
    if(body.stream){const delta=structuredClone(message);if(delta.tool_calls)delta.tool_calls[0].index=0;res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({...result,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({...result,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:step<6?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}else{res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>model.close());
  const source=process.env.HERMES_NATIVE_SOURCE,runtime=createWorkbenchNativeRuntime({source,python:path.join(source,'.venv/bin/python'),root:path.join(f.root,'agents'),endpoint:`http://127.0.0.1:${model.address().port}/v1`,profile_id:'fixture',config_generation:1,gate:f.gate});
  Object.assign(f.hermes,runtime);
  const {grant,candidate}=await f.prepare({nativeCall});await nativeCall({...f.base,action:'start',grant_id:grant.id});
  let status;for(let i=0;i<900;i++){status=await nativeCall({...f.base,action:'status',grant_id:grant.id});if(status.grant.status!=='running')break;await wait(100);}
  assert.equal(status.grant.status,'completed',JSON.stringify({status,toolResults}));
  assert.equal(status.result.availability,'available',JSON.stringify(status.result));
  assert.equal(status.result.text.startsWith('Finished fixture; recorder evidence is authoritative. evidence:'),true);
  assert.equal(status.result.resolved_references.length,1);
  assert.equal(status.result.resolved_references[0].verdict,'pass');
  const linked=f.data.get('evidence',f.base.workspace_id,f.base.project_id,status.result.resolved_references[0].evidence_id);
  f.data.update('evidence',f.base.workspace_id,f.base.project_id,linked.id,linked.revision,{superseded:true});
  const relinked=await nativeCall({...f.base,action:'result_get',result_id:status.result.id});
  assert.equal(relinked.result.model_suggested_references.length,1);
  assert.deepEqual(relinked.result.resolved_references,[]);
  assert.equal((await nativeCall({...f.base,action:'result_get',result_id:status.result.id})).result.text,status.result.text);
  const state=await f.call('execution_state');assert.deepEqual(state.evidence.map(e=>e.verdict),['fail','pass']);
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),WRONG);
  assert.equal((await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'})).file.text,RIGHT);
  assert.equal(status.toolcalls.filter(c=>c.status==='completed').length,6);
  for(const request of requests)if(request.tools)assert.deepEqual(request.tools.map(t=>t.function.name),['orbit_workbench']);
  assert.equal(JSON.stringify(requests).includes(ownerToken),false);
  console.log(JSON.stringify({contract:HERMES_NATIVE_CONTRACT.commit,requests:requests.length,completed_toolcalls:status.toolcalls.length,verdicts:state.evidence.map(e=>e.verdict),original_unchanged:true}));
});
