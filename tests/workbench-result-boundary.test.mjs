// Flash lane boundary regressions: native result delivery + provenance attribution.
// Dedicated file so Sol can change production code without concurrent edits here.
// Asserts the frozen contracts/workbench-result-v1.mjs interfaces. Baseline
// (pre-implementation) is expected to FAIL the result/provenance assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchNative} from '../server/workbench-native.mjs';
import {createWorkbenchNativeRuntime} from '../server/workbench-native-runtime.mjs';
import {workbenchOwnerRoute} from '../server/workbench-owner-route.mjs';
import {HERMES_NATIVE_CONTRACT,validateNativeTool} from '../contracts/workbench-native-v1.mjs';
import {RESULT_MAX_SUGGESTED_REFERENCES,validateResultReceipt,validateWorkbenchProvenance} from '../contracts/workbench-result-v1.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const WRONG='export const sum = (a,b) => a - b;\n',RIGHT='export const sum = (a,b) => a + b;\n';
const wait=ms=>new Promise(r=>setTimeout(r,ms));

function fixture(t,adapter={},now=Date.now){
  const root=fs.mkdtempSync('/tmp/opencode/wrb-'),projectRoot=path.join(root,'project');
  fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'math.js'),WRONG);
  const store=new SqliteWorkspaceStore(path.join(root,'r')),workspace_id=randomUUID(),pane_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Boundary fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const data=new WorkbenchData(store,{now}),records=new WorkbenchStore(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Boundary fixture',identity:opened.identity});opened.close();
  const gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate}),base={workspace_id,project_id:project.id};
  const hermes={quarantineNative:()=>true,acknowledgeNativeUnknown:()=>{},readBinding:async()=>({trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'native-fixture',config_generation:1,binding_revision:1,native_runtime:hermes.bindingMetadata??{kind:'local-pinned',commit:HERMES_NATIVE_CONTRACT.commit,model:'orbit-local-fixture',destination:'loopback configured model endpoint',configuration_hash:'0'.repeat(64)}}),...adapter};
  const native=createWorkbenchNative({store,records,data,execution,hermes,now});
  const call=(action,fields={})=>execution.dispatch({...base,action,...fields});
  async function prepare({nativeCall=body=>native.dispatch(body),budget={calls:15,checks:2,duration_ms:90000}}={}){
    const {task}=await call('task_create',{title:'Repair sum',acceptance_statement:'sum must add',check_definition_id:'host-regression',profile_id:'fixture',session_id:'native-fixture',pane_id});
    const p=await call('candidate_preview',{task_id:task.id});const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});
    const {attempt}=await call('attempt_create',{task_id:task.id,candidate_id:candidate.id,profile_id:'fixture',session_id:'native-fixture',pane_id});
    const preview=await nativeCall({...base,action:'preview',attempt_id:attempt.id,context_ids:[],budget});
    const {grant}=await nativeCall({...base,action:'approve',preview_id:preview.preview_id,preview_digest:preview.preview_digest});
    return {candidate,attempt,grant,task};
  }
  t.after(()=>{native.close();execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,projectRoot,store,data,records,gate,execution,native,hermes,base,call,prepare};
}
function privateCall(channel,args,sequence=1,secret=channel.secret){
  const raw=JSON.stringify(args),mac=createHmac('sha256',secret).update(`${sequence}\n${raw}`).digest('hex');
  return new Promise((resolve,reject)=>{const req=http.request({socketPath:channel.socket,path:'/tool',method:'POST',headers:{'content-type':'application/json','x-orbit-grant':channel.grant_id,'x-orbit-sequence':String(sequence),'x-orbit-mac':mac}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(text)}));});req.on('error',reject);req.end(raw);});
}
async function settleJob(f,id){
  for(let i=0;i<300;i++){const {job}=await f.call('job_get',{job_id:id});if(['completed','failed','cancelled','inconclusive','outcome_unknown'].includes(job.status)&&!job.pending_result)return job;await wait(100);}
  throw Error('job did not settle');
}

test('native-agent job/evidence provenance names the agent, grant and recorder',async t=>{
  const channels=[];
  const f=fixture(t,{startNative:async config=>{channels.push(config.channel);await config.authorize();return {completion:new Promise(()=>{})};},stopNative:async()=>({requested:true})});
  const a=await f.prepare();
  await f.native.dispatch({...f.base,action:'start',grant_id:a.grant.id});
  const started=await privateCall(channels[0],{action:'job_start'});
  assert.equal(started.ok,true,JSON.stringify(started));
  const job=await settleJob(f,started.result.job.id);
  const evidence=f.data.list('evidence',f.base.workspace_id,f.base.project_id).filter(e=>e.job_id===job.id).at(-1);
  assert.ok(evidence,'a native job must record evidence');
  for(const [label,record] of [['job',job],['evidence',evidence]]){
    assert.equal(validateWorkbenchProvenance(record.provenance),true,`${label} provenance must validate: ${JSON.stringify(record.provenance)}`);
    assert.equal(record.provenance.initiated_by.kind,'native_agent',`${label} initiated_by`);
    assert.equal(record.provenance.initiated_by.grant_id,a.grant.id,`${label} grant`);
    assert.equal(record.provenance.initiated_by.attempt_id,a.attempt.id,`${label} attempt`);
    assert.equal(record.provenance.authorized_by.kind,'owner_grant',`${label} authorized_by`);
    assert.equal(record.provenance.authorized_by.grant_id,a.grant.id);
    assert.equal(record.provenance.recorded_by.kind,'comet_service',`${label} recorded_by`);
    assert.equal(record.provenance.recorded_by.component,'workbench-check-recorder');
    assert.match(record.provenance.recorded_by.build_id,/^[a-f0-9]{64}$/);
    assert.match(record.provenance.recorded_by.verifier_hash,/^[a-f0-9]{64}$/);
  }
});

test('owner-initiated checks attribute owner_action and owner_approval (negative control)',async t=>{
  const f=fixture(t);
  const {candidate}=await f.prepare();
  const p=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  const run=await f.call('check_run',{candidate_id:candidate.id,preview_id:p.preview_id,preview_digest:p.preview.spec_digest,op_id:randomUUID()});
  const job=await settleJob(f,run.job.id);
  const evidence=f.data.list('evidence',f.base.workspace_id,f.base.project_id).filter(e=>e.job_id===job.id).at(-1);
  for(const [label,record] of [['job',job],['evidence',evidence]]){
    assert.equal(validateWorkbenchProvenance(record.provenance),true,`${label} provenance must validate`);
    assert.equal(record.provenance.initiated_by.kind,'owner_action',`${label} initiated_by`);
    assert.equal(record.provenance.authorized_by.kind,'owner_approval',`${label} authorized_by`);
    assert.equal(record.provenance.recorded_by.kind,'comet_service',`${label} recorded_by`);
  }
});

test('model arguments cannot select an actor, grant, attempt or authority',()=>{
  for(const field of ['grant_id','attempt_id','workspace_id','candidate_id','principal','initiated_by','authorized_by','recorded_by'])
    assert.equal(validateNativeTool({action:'inspect',[field]:randomUUID()}),false,field);
});

test('real pinned Hermes delivers a typed result receipt with resolved evidence references',
  {skip:!process.env.HERMES_NATIVE_SOURCE,timeout:120000},async t=>{
  const f=fixture(t),requests=[];
  const answerToken=`FLASH-FINAL-ANSWER-${randomUUID()}`;
  let ownerRoute;const ownerToken=randomUUID(),ownerServer=http.createServer((req,res)=>ownerRoute(req,res));
  await new Promise(resolve=>ownerServer.listen(0,'127.0.0.1',resolve));t.after(()=>ownerServer.close());
  const ownerPort=ownerServer.address().port,ownerOrigin=`http://127.0.0.1:${ownerPort}`;
  ownerRoute=workbenchOwnerRoute({token:ownerToken,port:ownerPort,devOrigins:[],dispatch:body=>f.native.dispatch(body),reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
  const nativeCall=async body=>{const response=await fetch(`${ownerOrigin}/api/workbench/native`,{method:'POST',headers:{Authorization:`Bearer ${ownerToken}`,Origin:ownerOrigin,'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  const model=http.createServer(async(req,res)=>{
    if(req.method!=='POST'){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:[]}));return;}
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
    if(!Array.isArray(body.messages)){res.statusCode=404;res.end('{}');return;}requests.push(body);
    const results=body.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return {};}});
    const step=results.length;let args={action:'inspect'};
    if(step===1)args={action:'job_start'};
    if(step===2)args={action:'candidate_read',path:'math.js'};
    if(step===3)args={action:'candidate_patch',expected_candidate_hash:results[0].result.candidate.hash,changes:[{op:'change',path:'math.js',expected_hash:results[2].result.file.hash,content:RIGHT}]};
    if(step===4)args={action:'job_start'};
    if(step===5)args={action:'evidence',job_id:results[4].result.job.id};
    const evidenceRef=step>=6?` see evidence:${results[5]?.result?.evidence?.[0]?.id??''}`:'';
    const message=step<6?{role:'assistant',content:null,tool_calls:[{id:`call_${step}`,type:'function',function:{name:'orbit_workbench',arguments:JSON.stringify(args)}}]}:{role:'assistant',content:`Repair summary: ${answerToken}${evidenceRef}`};
    const result={id:'fixture',object:'chat.completion',created:1,model:'orbit-local-fixture',choices:[{index:0,message,finish_reason:step<6?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
    if(body.stream){const delta=structuredClone(message);if(delta.tool_calls)delta.tool_calls[0].index=0;res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({...result,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({...result,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:step<6?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}else{res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>model.close());
  const source=process.env.HERMES_NATIVE_SOURCE,runtime=createWorkbenchNativeRuntime({source,python:path.join(source,'.venv/bin/python'),root:path.join(f.root,'agents'),endpoint:`http://127.0.0.1:${model.address().port}/v1`,profile_id:'fixture',config_generation:1,gate:f.gate});
  Object.assign(f.hermes,runtime);
  const {grant,candidate,attempt}=await f.prepare({nativeCall});await nativeCall({...f.base,action:'start',grant_id:grant.id});
  let status;for(let i=0;i<900;i++){status=await nativeCall({...f.base,action:'status',grant_id:grant.id});if(status.grant.status!=='running')break;await wait(100);}
  assert.equal(status.grant.status,'completed',JSON.stringify(status.grant));

  const receipt=status.result;
  assert.ok(receipt,'completed native run must expose a result receipt');
  assert.equal(validateResultReceipt(receipt),true,JSON.stringify(receipt));
  assert.equal(receipt.availability,'available');
  assert.equal(receipt.unavailable_reason,null);
  assert.equal(receipt.hermes_completed,true);
  assert.ok(receipt.text.includes(answerToken),'final answer text must be delivered verbatim');
  assert.match(receipt.frame_hash,/^[a-f0-9]{64}$/);
  assert.ok(receipt.retained_until>receipt.received_at);
  assert.equal(receipt.grant_id,grant.id);
  assert.equal(receipt.run_id,status.grant.run_id);
  assert.equal(receipt.attempt_id,attempt.id);
  assert.equal(receipt.candidate_id,candidate.id);
  const finalCandidate=await f.call('candidate_get',{candidate_id:candidate.id});
  assert.equal(receipt.candidate_hash,finalCandidate.candidate.hash,'result binds the final repaired candidate hash');
  assert.equal(receipt.candidate_generation,finalCandidate.candidate.generation,'result binds the final candidate generation');
  assert.notEqual(receipt.candidate_hash,candidate.hash,'the repaired candidate differs from the pre-repair candidate');
  assert.equal(receipt.recipient.pane_id,attempt.recipient.pane_id);
  assert.equal(receipt.recipient.profile_id,attempt.recipient.profile_id);
  assert.equal(receipt.recipient.session_id,attempt.recipient.session_id);

  // Evidence references stay bounded, untrusted suggestions resolved only on the server.
  assert.ok(receipt.model_suggested_references.length<=RESULT_MAX_SUGGESTED_REFERENCES);
  for(const suggestion of receipt.model_suggested_references)assert.match(suggestion.evidence_id,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok(receipt.resolved_references.some(reference=>reference.verdict==='pass'&&reference.job_id),'server must resolve a same-candidate evidence reference');

  // Result GET is scoped and idempotent; provenance is service-derived.
  const fetched=await nativeCall({...f.base,action:'result_get',result_id:receipt.id});
  assert.equal(fetched.result.id,receipt.id);
  assert.deepEqual(fetched.result.text,receipt.text);
  const jobs=f.data.list('jobs',f.base.workspace_id,f.base.project_id),evidence=f.data.list('evidence',f.base.workspace_id,f.base.project_id);
  assert.ok(jobs.length>=2&&jobs.every(job=>job.provenance?.initiated_by?.kind==='native_agent'));
  assert.ok(evidence.length>=2&&evidence.every(entry=>entry.provenance?.initiated_by?.kind==='native_agent'));
  assert.deepEqual(evidence.map(entry=>entry.verdict),['fail','pass']);

  // The explanation never replaces recorder evidence, and the original is untouched.
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),WRONG);
  assert.equal((await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'})).file.text,RIGHT);
});

// True contradictory-result case: the model makes no repair and asserts success while
// the recorder records a failing check. The delivered explanation must remain visible
// as untrusted text, the evidence must stay `fail`, and review approval must be
// refused. This runs against the merged result/provenance channel.
test('a delivered success claim cannot override a failing recorded check',
  {skip:!process.env.HERMES_NATIVE_SOURCE,timeout:120000},async t=>{
  const f=fixture(t),claimToken=`FLASH-FALSE-PASS-${randomUUID()}`;
  let ownerRoute;const ownerToken=randomUUID(),ownerServer=http.createServer((req,res)=>ownerRoute(req,res));
  await new Promise(resolve=>ownerServer.listen(0,'127.0.0.1',resolve));t.after(()=>ownerServer.close());
  const ownerPort=ownerServer.address().port,ownerOrigin=`http://127.0.0.1:${ownerPort}`;
  ownerRoute=workbenchOwnerRoute({token:ownerToken,port:ownerPort,devOrigins:[],dispatch:body=>f.native.dispatch(body),reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
  const nativeCall=async body=>{const response=await fetch(`${ownerOrigin}/api/workbench/native`,{method:'POST',headers:{Authorization:`Bearer ${ownerToken}`,Origin:ownerOrigin,'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  const model=http.createServer(async(req,res)=>{
    if(req.method!=='POST'){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:[]}));return;}
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);
    if(!Array.isArray(body.messages)){res.statusCode=404;res.end('{}');return;}
    const results=body.messages.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content);}catch{return {};}});
    const step=results.length;
    const message=step<2?{role:'assistant',content:null,tool_calls:[{id:`call_${step}`,type:'function',function:{name:'orbit_workbench',arguments:JSON.stringify(step===0?{action:'inspect'}:{action:'job_start'})}}]}:{role:'assistant',content:`All required checks passed. ${claimToken}`};
    const result={id:'fixture',object:'chat.completion',created:1,model:'orbit-local-fixture',choices:[{index:0,message,finish_reason:step<2?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
    if(body.stream){const delta=structuredClone(message);if(delta.tool_calls)delta.tool_calls[0].index=0;res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({...result,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({...result,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:step<2?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}else{res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>model.close());
  const source=process.env.HERMES_NATIVE_SOURCE,runtime=createWorkbenchNativeRuntime({source,python:path.join(source,'.venv/bin/python'),root:path.join(f.root,'agents'),endpoint:`http://127.0.0.1:${model.address().port}/v1`,profile_id:'fixture',config_generation:1,gate:f.gate});
  Object.assign(f.hermes,runtime);
  const {grant,candidate}=await f.prepare({nativeCall});await nativeCall({...f.base,action:'start',grant_id:grant.id});
  let status;for(let i=0;i<900;i++){status=await nativeCall({...f.base,action:'status',grant_id:grant.id});if(status.grant.status!=='running')break;await wait(100);}
  assert.equal(status.grant.status,'completed',JSON.stringify(status.grant));
  const receipt=status.result;
  assert.equal(receipt.availability,'available','the untrusted claim is still delivered as text');
  assert.ok(receipt.text.includes(claimToken),receipt.text);
  assert.equal(receipt.resolved_references.length,0,'a claim without evidence refs resolves nothing');
  const state=await f.call('execution_state');
  assert.deepEqual(state.evidence.map(entry=>entry.verdict),['fail'],'the recorder verdict stays fail');
  const review=await f.call('candidate_get',{candidate_id:candidate.id});
  const evidence=f.data.list('evidence',f.base.workspace_id,f.base.project_id).at(-1);
  await assert.rejects(f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[evidence.id],decision:'approved',expected_identity:review.review_identity}),{code:'stale_resource'});
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),WRONG,'no repair was made and the original is untouched');
});
