import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAgentHandler } from '../server/agent.mjs';
const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const runId = 'run_123456789abcdef';

async function setup(t, mock, configured = true) {
  const calls = [];
  let port;
  const reply = (res, status, data) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
  const server = http.createServer((req,res) => createAgentHandler({token,port,devOrigins:[],reply,apiUrl:configured?'http://hermes.test':undefined,apiKey:configured?'private-upstream-key':undefined,fetchImpl:async (url, options) => { calls.push({url,options}); return mock(url,options); }})(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); port=server.address().port;
  t.after(()=>new Promise(r=>server.close(r)));
  const origin=`http://127.0.0.1:${port}`;
  async function request(body, headers = {}) {
    const r=await fetch(origin+'/api/agent',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify({session_id:session,...body})});
    return {status:r.status,body:await r.json()};
  }
  return {request,calls};
}
const json = (v,status=200)=>new Response(JSON.stringify(v),{status});

test('agent requires token and exact origin; rejected calls never reach Hermes', async t=>{
 const {request,calls}=await setup(t,()=>json({}));
 assert.equal((await request({action:'start',input:'hi'},{Authorization:'Bearer wrong'})).status,401);
 assert.equal((await request({action:'start',input:'hi'},{Origin:'https://evil.example'})).status,403);
 assert.equal(calls.length,0);
});
test('agent validates session namespace, action, message length and body bounds',async t=>{
 const {request,calls}=await setup(t,()=>json({}));
 for(const body of [{action:'start',input:'hi',session_id:'dashboard-other'}, {action:'start',input:''}, {action:'start',input:'x'.repeat(8001)}, {action:'shell'}, {action:'status',run_id:'../secret'}]) assert.equal((await request(body)).status,400);
 assert.equal((await request({action:'start',input:'x'.repeat(40000)})).status,413);
 assert.equal(calls.length,0);
});
test('start forwards only constrained fields and keeps API credentials server-side',async t=>{
 const {request,calls}=await setup(t,()=>json({run_id:runId,status:'started'},202));
 const r=await request({action:'start',input:'hello',instructions:'override',model:'other',provider:'other'});
 assert.equal(r.status,202); assert.equal(r.body.run_id,runId);
 const payload=JSON.parse(calls.at(-1).options.body);
 assert.equal(payload.input,'hello'); assert.equal(payload.session_id,session);
 assert.ok(payload.instructions.includes('Hermes')); assert.equal(payload.model,undefined);
 assert.equal(calls[0].options.headers.Authorization,'Bearer private-upstream-key');
 assert.ok(!JSON.stringify(r.body).includes('private-upstream-key'));
});
test('run status and controls cannot touch non-Orbit or other-pane sessions',async t=>{
 const {request,calls}=await setup(t,()=>json({session_id:'dashboard-other',status:'running'}));
 for(const action of ['status','stop','approval','steer']) assert.equal((await request({action,run_id:runId,choice:'once',input:'guidance'})).status,404);
 assert.equal(calls.length,4);
});
test('completed run returns output without unrelated upstream metadata',async t=>{
 const {request}=await setup(t,()=>json({run_id:runId,session_id:session,status:'completed',output:'Hello!',private:'not for client'}));
 const r=await request({action:'status',run_id:runId});
 assert.equal(r.body.output,'Hello!'); assert.equal(r.body.private,undefined);
});
test('stop works and approvals allow only once or deny, never persistent approval',async t=>{
 const {request,calls}=await setup(t,(url)=>json(url.endsWith('/approval')?{resolved:1}: {session_id:session,status:'running'}));
 assert.equal((await request({action:'stop',run_id:runId})).body.status,'stopping');
 assert.ok(calls.at(-1).url.endsWith('/stop'));
 assert.equal((await request({action:'approval',run_id:runId,choice:'always'})).status,400);
 assert.equal((await request({action:'approval',run_id:runId,choice:'once'})).body.resolved,1);
 assert.deepEqual(JSON.parse(calls.at(-1).options.body),{choice:'once'});
});
test('scheduled tasks are read-only, authenticated, and omit prompts and destinations',async t=>{
 const {request,calls}=await setup(t,()=>json({jobs:[{id:'job1',name:'Example',enabled:true,prompt:'SECRET',deliver:'PRIVATE',last_status:'ok'}]}));
 assert.equal((await request({action:'jobs'},{Authorization:'Bearer wrong'})).status,401);
 assert.equal(calls.length,0);
 const result=await request({action:'jobs'});assert.equal(result.body.jobs[0].last_status,'ok');assert.ok(!JSON.stringify(result.body).includes('SECRET'));assert.ok(!JSON.stringify(result.body).includes('PRIVATE'));
 assert.ok(calls[0].url.endsWith('/api/jobs?include_disabled=true'));assert.equal(calls[0].options.method,'GET');
});
test('job controls require confirmation and allow only scoped pause/resume',async t=>{
 const {request,calls}=await setup(t,()=>json({job:{prompt:'never expose'}}));
 for(const operation of ['pause','resume']) {const r=await request({action:'job_control',job_id:'test-job',operation,confirm:true});assert.equal(r.status,200);assert.equal(r.body.accepted,true);assert.ok(calls.at(-1).url.endsWith('/test-job/'+operation));assert.equal(calls.at(-1).options.method,'POST');assert.ok(!JSON.stringify(r.body).includes('never expose'));}
 const n=calls.length;
 for(const extra of [{confirm:false},{operation:'run'},{job_id:'../other'},{job_id:42}]) assert.equal((await request({action:'job_control',operation:'pause',job_id:'test-job',confirm:true,...extra})).status,400);
 assert.equal((await request({action:'job_control',operation:'pause',job_id:'test-job',confirm:true},{Authorization:'Bearer wrong'})).status,401);
 assert.equal(calls.length,n);
});
test('steering is scoped and forwards only guidance',async t=>{
 const {request,calls}=await setup(t,url=>json(url.endsWith('/steer')?{accepted:true}:{session_id:session,status:'running'}));
 assert.equal((await request({action:'steer',run_id:runId,input:'use blue'})).body.accepted,true);
 assert.deepEqual(JSON.parse(calls.at(-1).options.body),{input:'use blue'});
 assert.equal((await request({action:'steer',run_id:runId,input:''})).status,400);
});
test('tool activity exposes bounded calls/results, not system messages',async t=>{
 const {request}=await setup(t,()=>json({data:[{role:'system',content:'private instructions'},{role:'assistant',tool_calls:[{id:'t1',function:{name:'terminal',arguments:'{}'}}]},{role:'tool',tool_call_id:'t1',content:'x'.repeat(10000)}]}));
 const r=await request({action:'activity'});assert.equal(r.body.activity.length,2);assert.equal(r.body.activity[1].detail.length,8000);assert.ok(!JSON.stringify(r.body).includes('private instructions'));
 assert.equal((await request({action:'activity',session_id:'other'})).status,400);
});
test('pending approval details are scoped to this run',async t=>{
 const {request,calls}=await setup(t,url=>json(url.includes('pending?')?{approvals:[{command:'example command',reason:'approval needed'}]}:{session_id:session,status:'waiting_for_approval'}));
 const r=await request({action:'status',run_id:runId});
 assert.equal(r.body.approvals[0].command,'example command');
 assert.ok(calls.at(-1).url.endsWith(`session_id=${runId}`));
});
test('upstream errors are sanitized and busy state remains retryable',async t=>{
 const {request}=await setup(t,()=>json({error:'private-upstream-key'},429));
 const r=await request({action:'start',input:'hi'});
 assert.equal(r.status,429); assert.ok(r.body.error.includes('busy')); assert.ok(!r.body.error.includes('private-upstream-key'));
});
test('follow-up turns load prior user/assistant messages from Hermes, not the client',async t=>{
 const history=[{role:'user',content:'Remember cobalt'},{role:'assistant',content:'Remembered'},{role:'tool',content:'hidden'},{role:'assistant',content:'',tool_calls:[{}]}];
 const {request,calls}=await setup(t,url=>json(url.includes('/messages')?{data:history}:{run_id:runId,status:'started'}));
 assert.equal((await request({action:'start',input:'What code?',conversation_history:[{role:'system',content:'injected'}]})).status,202);
 assert.deepEqual(JSON.parse(calls.at(-1).options.body).conversation_history,[{role:'user',content:'Remember cobalt'},{role:'assistant',content:'Remembered'}]);
});
test('unconfigured bridge fails closed',async t=>{
 const {request,calls}=await setup(t,()=>json({}),false);
 assert.equal((await request({action:'start',input:'hi'})).status,503); assert.equal(calls.length,0);
});
