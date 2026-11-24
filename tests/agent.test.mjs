import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentHandler } from '../server/agent.mjs';
const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const runId = 'run_123456789abcdef';

async function setup(t, mock, configured = true, extra = {}) {
  const calls = [];
  const runtimeDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-agent-test-'));
  let port, handler;
  const reply = (res, status, data) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
  const server = http.createServer((req,res) => (handler ||= createAgentHandler({token,port,devOrigins:[],reply,runtimeDirectory,apiUrl:configured?'http://hermes.test':null,apiKey:configured?'private-upstream-key':null,...extra,fetchImpl:async (url, options) => { calls.push({url,options}); return mock(url,options); }}))(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); port=server.address().port;
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(runtimeDirectory,{recursive:true,force:true});});
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
 for(const body of [{action:'start',input:'hi',session_id:'dashboard-other'}, {action:'start',input:''}, {action:'start',input:'x'.repeat(100001)}, {action:'shell'}, {action:'status',run_id:'../secret'}]) assert.equal((await request(body)).status,400);
 assert.equal((await request({action:'start',input:'x'.repeat(1048576)})).status,413);
 assert.equal(calls.length,0);
});
test('large messages and guidance reach Hermes intact, including Unicode and JSON escapes', async t=>{
 const {request,calls}=await setup(t,url=>json(url.endsWith('/steer')?{accepted:true}:{session_id:session,run_id:runId,status:'running'}));
 for (const input of ['x'.repeat(100000), '界😀\n'.repeat(25000), '\u0001'.repeat(100000)]) {
  assert.equal((await request({action:'start',input})).status,202);
  assert.equal(JSON.parse(calls.at(-1).options.body).input,input.trim());
  assert.equal((await request({action:'steer',run_id:runId,input})).body.accepted,true);
  assert.equal(JSON.parse(calls.at(-1).options.body).input,input.trim());
 }
 assert.equal((await request({action:'steer',run_id:runId,input:'x'.repeat(100001)})).status,400);
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
 for(const action of ['status','stop','approval','steer','events']) assert.equal((await request({action,run_id:runId,choice:'once',input:'guidance'})).status,404);
 assert.equal(calls.length,5);
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
test('catalog is authenticated, bounded and strips private fields',async t=>{
 const {request,calls}=await setup(t,url=>json(url.endsWith('/capabilities')?{endpoints:{skills:{},toolsets:{}}}:{data:[{name:'safe',description:'description',path:'/private',enabled:true,configured:false,tools:['terminal']}]}));
 assert.equal((await request({action:'catalog',kind:'skills'},{Authorization:'Bearer wrong'})).status,401);assert.equal(calls.length,0);
 assert.equal((await request({action:'catalog',kind:'../secrets'})).status,400);
 assert.deepEqual((await request({action:'catalog',kind:'skills'})).body.items,[{name:'safe',description:'description'}]);
 const result=await request({action:'catalog',kind:'toolsets'});assert.equal(result.body.items[0].configured,false);assert.equal(result.body.items[0].path,undefined);
});
test('live streaming is capability-gated and session-scoped',async t=>{
 const {request,calls}=await setup(t,url=>json(url.endsWith('/capabilities')?{features:{run_events_sse:false},secret:'hidden'}:{session_id:session}));
 assert.deepEqual((await request({action:'capabilities'})).body,{features:{run_events_sse:false}});
 assert.equal((await request({action:'events',run_id:runId})).status,409);
 assert.ok(!calls.some(c=>c.url.endsWith('/events')));
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
test('profiles and sessions expose bounded public fields; selection validates upstream history and fences bindings',async t=>{
  const workspace_id='12345678-1234-4234-9234-123456789abc', pane_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const target='external:valid_001';
  const extra={profiles:[{id:'blue',label:'Blue',apiUrl:'https://blue.example/p/blue',apiKey:'blue-secret'}],workspaceRead:()=>({state:{monitors:[{layout:{type:'pane',pane:{id:pane_id,kind:'agent'}}}]}})};
  const {request,calls}=await setup(t,(url,opts)=>url.endsWith('/api/sessions?limit=100&offset=0')?json({data:[{id:target,title:'External',secret:'hidden'},{id:'../bad',title:'Bad'}],has_more:false}):url.endsWith(`/api/sessions/${encodeURIComponent(target)}`)?json({id:target,title:'External',secret:'hidden'}):url.includes('/messages?')?json({data:[{role:'user',content:'hello'},{role:'assistant',content:'world'},{role:'system',content:'secret'}]}):url.endsWith('/v1/runs')?json({run_id:runId,status:'running'}):json({data:[]}),true,extra);
  const base={workspace_id,pane_id,session_id:session};
  assert.equal((await request({action:'profiles'},{Authorization:'Bearer wrong'})).status,401);
  const profiles=await request({...base,action:'profiles'});
  assert.deepEqual(profiles.body,{profiles:[{id:'default',label:'Default'},{id:'blue',label:'Blue'}],default_profile_id:'default'});
  assert.equal((await request({...base,action:'shared_chat',initial:{session,messages:[]}})).body.state.binding_revision,0);
  assert.equal((await request({...base,action:'shared_chat',replace:true,initial:{session,messages:[{role:'user',text:'injected'}]}})).status,409);
  const list=await request({...base,action:'sessions',target_profile_id:'blue'});
  assert.deepEqual(list.body.sessions,[{id:target,title:'External',updated_at:''}]);
  assert.ok(!JSON.stringify(list.body).includes('secret'));
  assert.equal((await request({...base,action:'select_session',target_profile_id:'blue',target_session_id:'../bad',expected_binding_revision:0})).status,400);
  assert.equal((await request({...base,action:'select_session',target_profile_id:'blue',target_session_id:'missing',expected_binding_revision:0})).status,404);
  const selected=await request({...base,action:'select_session',target_profile_id:'blue',target_session_id:target,expected_binding_revision:0});
  assert.equal(selected.status,200);assert.equal(selected.body.state.profile_id,'blue');assert.equal(selected.body.state.binding_revision,1);
  assert.deepEqual(selected.body.state.messages,[{role:'user',text:'hello'},{role:'assistant',text:'world'}]);
  assert.equal((await request({...base,action:'start',input:'hi'})).status,409);
  const scoped={...base,profile_id:'blue',session_id:target,expected_binding_revision:1};
  assert.equal((await request({...base,profile_id:'blue',session_id:target,action:'start',input:'hi'})).status,409);
  assert.equal((await request({...scoped,action:'start',input:'hi'})).status,202);
  assert.equal(calls.at(-1).url,'https://blue.example/p/blue/v1/runs');
  assert.equal(calls.at(-1).options.headers.Authorization,'Bearer blue-secret');
  assert.equal(JSON.parse(calls.at(-1).options.body).profile,undefined);
  assert.equal((await request({...scoped,action:'select_session',target_profile_id:'default'})).status,409);
  assert.equal((await request({...scoped,action:'shared_chat',initial:{session}})).body.state.run,runId);
});

test('rejected concurrent pane requests cannot release another request\'s start lock', async t => {
  const workspace_id = '12345678-1234-4234-9234-123456789abc', pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { request } = await setup(t, async url => {
    if (url.endsWith('/v1/runs')) { entered(); await pending; return json({run_id:runId,status:'running'}); }
    return json({data:[]});
  }, true, {workspaceRead:()=>({state:{monitors:[{layout:{type:'pane',pane:{id:pane_id,kind:'agent'}}}]}})});
  const base = {workspace_id,pane_id,session_id:session,profile_id:'default',expected_binding_revision:0};
  await request({...base,action:'shared_chat',initial:{session,messages:[]}});
  const start = request({...base,action:'start',input:'hello'});
  try {
    await started;
    for (let i=0;i<3;i++) assert.equal((await request({...base,action:'select_session',target_profile_id:'default'})).status,409);
  } finally { release(); }
  assert.equal((await start).status,202);
  assert.equal((await request({...base,action:'shared_chat'})).body.state.run,runId);
});

test('owner can explicitly replace an unavailable default profile without executing on a fallback', async t => {
  const workspace_id='12345678-1234-4234-9234-123456789abc',pane_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const {request,calls}=await setup(t,()=>json({data:[]}),false,{
    profiles:[{id:'research',label:'Research',apiUrl:'http://research.test/p/research',apiKey:'private-research'}],
    workspaceRead:()=>({state:{monitors:[{layout:{type:'pane',pane:{id:pane_id,kind:'agent'}}}]}}),
  });
  const base={workspace_id,pane_id,session_id:session,profile_id:'default',expected_binding_revision:0};
  assert.equal((await request({...base,action:'shared_chat',initial:{session,messages:[]}})).status,200);
  assert.equal((await request({...base,action:'start',input:'No fallback'})).status,400);
  assert.equal(calls.length,0);
  assert.equal((await request({...base,action:'sessions',target_profile_id:'research'})).status,200);
  const selected=await request({...base,action:'select_session',target_profile_id:'research'});
  assert.equal(selected.status,200);
  assert.equal(selected.body.state.profile_id,'research');
  assert.equal(selected.body.state.binding_revision,1);
});
