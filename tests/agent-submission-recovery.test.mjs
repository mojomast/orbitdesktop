import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentHandler } from '../server/agent.mjs';
import { createWorkbenchGate } from '../server/workbench-gate.mjs';

const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const session_id = 'orbit-12345678-1234-4234-9234-123456789abc';
const run_id = 'run_123456789abcdef';
const token = 'ordinary-test-token-'.repeat(4);
const actualCapabilities = {object:'hermes.api_server.capabilities',platform:'hermes-agent',runtime:{mode:'server_agent',tool_execution:'server'},features:{run_submission:true,run_status:true,run_stop:true,session_resources:true,session_continuity_header:'X-Hermes-Session-Id'}};
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const reply = (res,status,body) => { res.writeHead(status,{'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };

async function setup(t, {lost = false, legacy = false, durable = false, initial = {}, panes = [pane_id], messages = [{role:'user',content:'Earlier'},{role:'assistant',content:'Remembered'},{role:'system',content:'not context'}]} = {}) {
  const directory = fs.mkdtempSync('/tmp/opencode/ordinary-submission-');
  const calls = [];
  const runs = new Map();
  let runStatus = 'running', postFault;
  const gateway = http.createServer(async (req,res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({url:req.url,method:req.method,headers:req.headers,text});
    if (req.url === '/v1/capabilities') return reply(res,200,legacy ? {version:'fake',features:{session_continuation:true}} : {...actualCapabilities,features:{...actualCapabilities.features,...(durable ? {runs_idempotency:{supported:true,durable:true,retention_seconds:600}} : {})}});
    if (req.url.includes('/messages')) {
      const selectedMessages = typeof messages === 'function' ? messages(req.url) : messages;
      return reply(res,selectedMessages === 'missing' ? 404 : 200,selectedMessages === 'malformed' ? {unexpected:[]} : {data:selectedMessages});
    }
    if (req.url.startsWith('/api/sessions/')) return reply(res,200,{id:decodeURIComponent(req.url.split('/')[3]),title:'Selected'});
    if (req.url === '/v1/runs' && req.method === 'POST') {
      const session = JSON.parse(text).session_id;
      const binding = panes.map(id=>{try{return JSON.parse(fs.readFileSync(path.join(directory,'shared-chats',`${workspace_id}.${id}.json`),'utf8'));}catch{return null;}}).find(state=>state?.session===session&&state.workbench_pending);
      const record = JSON.parse(fs.readFileSync(path.join(directory,'ordinary-submissions',`${binding.ordinary_submission_id}.json`),'utf8'));
      assert.equal(record.state,'dispatching');
      assert.equal(JSON.stringify(record.payload),text);
      assert.equal(record.payload_hash,createHash('sha256').update(text).digest('hex'));
      assert.equal(binding.workbench_pending,record.receipt_id);
      if (lost) { req.socket.destroy(); return; }
      postFault?.();
      const id = panes.length > 1 ? `${run_id}_${runs.size}` : run_id;
      runs.set(id,session);
      return reply(res,202,{run_id:id,status:'running'});
    }
    if (panes.length > 1) {
      const id = req.url.split('/')[3];
      return reply(res,200,{run_id:id,session_id:runs.get(id),status:runStatus,output:`Finished ${runs.get(id)}`});
    }
    return reply(res,200,{run_id,session_id,status:runStatus,output:'Finished'});
  });
  await listen(gateway);
  let handler, gate;
  const server = http.createServer((req,res) => handler(req,res));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const restart = (apiKey = 'private-test-key') => {
    gate = createWorkbenchGate();
    handler = createAgentHandler({token,port:server.address().port,devOrigins:[],reply,runtimeDirectory:directory,executionGate:gate,apiUrl:`http://127.0.0.1:${gateway.address().port}`,apiKey,workspaceContext:()=>'\nTrusted workspace context',workspaceRead:()=>({state:{monitors:panes.map(id=>({layout:{type:'pane',pane:{id,kind:'agent'}}}))}})});
  };
  restart();
  t.after(async () => { await close(server); await close(gateway); fs.rmSync(directory,{recursive:true,force:true}); });
  async function request(body) {
    const response = await fetch(`${origin}/api/agent`,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id,pane_id,session_id,profile_id:'default',expected_binding_revision:0,...body})});
    return {status:response.status,body:await response.json()};
  }
  assert.equal((await request({action:'shared_chat',initial:{session:session_id,messages:[],...initial}})).status,200);
  return {request,restart,calls,directory,get workbench(){return handler.workbench;},get gate(){return gate;},setMessages:value=>{messages=value;},setStatus:value=>{runStatus=value;},setPostFault:value=>{postFault=value;}};
}

test('lost HTTP response persists exact intent and fences restart without a second POST', async t => {
  const f = await setup(t,{lost:true});
  const result = await f.request({action:'start',input:'A normal turn'});
  assert.equal(result.status,409); assert.equal(result.body.submission_state,'submission_unknown');
  f.restart();
  assert.equal((await f.request({action:'start',input:'Do not duplicate'})).status,409);
  const status = await f.request({action:'submission_status'});
  assert.equal(status.body.payload_hash,result.body.payload_hash);
  assert.equal((await f.request({action:'status',run_id})).status,409);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
  for (const name of fs.readdirSync(path.join(f.directory,'ordinary-submissions'))) {
    const file = path.join(f.directory,'ordinary-submissions',name);
    assert.equal(fs.statSync(file).mode & 0o777,0o600);
    assert.ok(!fs.readFileSync(file,'utf8').includes('private-test-key'));
  }
  assert.equal((await f.request({action:'acknowledge_submission_unknown',payload_hash:'wrong',upstream_investigated:true})).status,409);
  assert.equal((await f.request({action:'acknowledge_submission_unknown',payload_hash:status.body.payload_hash,upstream_investigated:true})).status,200);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('known receipt uses original configuration, normal status clears the fence, advertised native continuation still carries history', async t => {
  const f = await setup(t);
  const result = await f.request({action:'start',input:'Hello'});
  assert.equal(result.status,202); assert.equal(result.body.run_id,run_id);
  const post = f.calls.find(call=>call.method==='POST');
  assert.equal(post.headers['idempotency-key'],undefined);
  assert.deepEqual(JSON.parse(post.text).conversation_history,[{role:'user',content:'Earlier'},{role:'assistant',content:'Remembered'}]);
  assert.match(JSON.parse(post.text).instructions,/Trusted workspace context/);
  assert.equal(f.calls.filter(call=>call.url.includes('/messages')).length,1);
  f.restart('changed-key'); const count = f.calls.length;
  assert.equal((await f.request({action:'submission_status'})).status,409);
  assert.equal((await f.request({action:'status',run_id})).status,409);
  assert.equal(f.calls.length,count);
  f.restart(); f.setStatus('completed');
  const status = await f.request({action:'status',run_id});
  assert.equal(status.status,200); assert.equal(status.body.output,'Finished');
  const binding = await f.request({action:'shared_chat'});
  assert.equal(binding.body.state.workbench_pending,undefined);
  assert.equal(binding.body.state.messages.at(-1).text,'Finished');
  assert.equal((await f.request({action:'start',input:'Next'})).status,202);
});

test('legacy history is frozen once and model routing/actor fields are rejected', async t => {
  const f = await setup(t,{legacy:true});
  for (const extra of [{actor:'owner'},{instructions:'override'},{payload:{}},{receipt_id:'chosen'}]) assert.equal((await f.request({action:'start',input:'hello',...extra})).status,400);
  assert.equal(f.calls.length,0);
  assert.equal((await f.request({action:'start',input:'hello'})).status,202);
  const payload = JSON.parse(f.calls.find(call=>call.method==='POST').text);
  assert.deepEqual(payload.conversation_history,[{role:'user',content:'Earlier'},{role:'assistant',content:'Remembered'}]);
  assert.equal(f.calls.filter(call=>call.url.includes('/messages')).length,1);
});

test('advertised continuation cannot omit prior turns, inject metadata, or duplicate a pending/current message', async t => {
  const f = await setup(t,{messages:[
    {role:'system',content:'private instructions'},
    {role:'user',content:'Prior user',private_metadata:'do not forward'},
    {role:'assistant',content:'Prior answer',tool_calls:[]},
    {role:'tool',content:'private tool result'},
    {role:'assistant',content:'private tool invocation',tool_calls:[{id:'call'}]},
    {role:'user',content:'Current message'}, // an uncompleted turn must stay excluded
  ]});
  assert.equal((await f.request({action:'start',input:'Current message'})).status,202);
  const payload = JSON.parse(f.calls.find(call=>call.method==='POST').text);
  assert.equal(payload.input,'Current message');
  assert.deepEqual(payload.conversation_history,[{role:'user',content:'Prior user'},{role:'assistant',content:'Prior answer'}]);
  assert.deepEqual(Object.keys(payload).sort(),['conversation_history','input','instructions','session_id']);
  assert.match(f.calls.find(call=>call.url.includes('/messages')).url,/order=latest/);
});

test('missing history of an existing pane fails closed without a new run', async t => {
  const f = await setup(t,{messages:[]});
  const file = path.join(f.directory,'shared-chats',`${workspace_id}.${pane_id}.json`);
  const state = JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...state,messages:[{role:'user',text:'Previous question'},{role:'assistant',text:'Previous answer'}]}));
  const result = await f.request({action:'start',input:'follow-up'});
  assert.notEqual(result.status,202);
  assert.equal(f.calls.some(call=>call.url==='/v1/runs'),false);
});

test('malformed history and missing selected session never dispatch; fresh Orbit session permits empty history', async t => {
  const f = await setup(t,{messages:'malformed'});
  assert.notEqual((await f.request({action:'start',input:'first'})).status,202);
  f.setMessages([]);
  const selected = 'orbit-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  assert.equal((await f.request({action:'select_session',target_profile_id:'default',target_session_id:selected})).status,200);
  f.setMessages('missing');
  assert.notEqual((await f.request({action:'start',input:'selected follow-up',session_id:selected,expected_binding_revision:1})).status,202);
  assert.equal(f.calls.filter(call=>call.url==='/v1/runs').length,0);
  const created = await f.request({action:'select_session',session_id:selected,expected_binding_revision:1,target_profile_id:'default'});
  assert.equal(created.status,200);
  const fresh = created.body.state;
  assert.equal((await f.request({action:'start',session_id:fresh.session,expected_binding_revision:2,input:'first'})).status,202);
  assert.deepEqual(JSON.parse(f.calls.find(call=>call.url==='/v1/runs').text).conversation_history,[]);
});

test('unmarked old empty Orbit binding and malformed successful rows fail before POST', async t => {
  const f = await setup(t,{messages:'missing'});
  await f.request({action:'shared_chat',initial:{session:session_id,messages:[],create_new:true}});
  const absent = await f.request({action:'start',input:'Do not start a replacement thread'});
  assert.equal(absent.status,409);
  assert.match(absent.body.error,/Select New chat explicitly/);
  f.setMessages([{role:'user',content:42}]);
  assert.notEqual((await f.request({action:'start',input:'Do not silently omit malformed context'})).status,202);
  assert.equal(f.calls.filter(call=>call.url==='/v1/runs').length,0);
});

test('explicit fresh-pane creation admits first message after restart without reclassifying legacy history', async t => {
 const f=await setup(t,{messages:'missing',initial:{create_new:true}});
 f.restart();
 const submitted=await f.request({action:'start',input:'First message in a newly created pane'});
 assert.equal(submitted.status,202);
 const posted=f.calls.filter(call=>call.url==='/v1/runs');assert.equal(posted.length,1);
 assert.deepEqual(JSON.parse(posted[0].text).conversation_history,[]);
 const cached=await setup(t,{messages:'missing',initial:{create_new:true,messages:[{role:'user',text:'Existing cached turn'}]}});
 assert.equal((await cached.request({action:'start',input:'Must retain prior history'})).status,409);
 assert.equal(cached.calls.filter(call=>call.url==='/v1/runs').length,0);
});

test('latest bounded raw page retains earlier conversation through tool-heavy turns and never splits Unicode', async t => {
  const rows = [{role:'user',content:'Earlier question'},{role:'assistant',content:'Earlier answer'},
    ...Array.from({length:110},(_,i)=>({role:'tool',content:`Tool result ${i}`}))];
  const f = await setup(t,{messages:rows});
  assert.equal((await f.request({action:'start',input:'Follow-up'})).status,202);
  const post = f.calls.find(call=>call.url==='/v1/runs');
  assert.deepEqual(JSON.parse(post.text).conversation_history,[{role:'user',content:'Earlier question'},{role:'assistant',content:'Earlier answer'}]);
  assert.match(f.calls.find(call=>call.url.includes('/messages?')).url,/limit=500.*order=latest/);
  const unicodeFixture = await setup(t,{messages:[{role:'user',content:'x'.repeat(15999)+'😀'},{role:'assistant',content:'answer'}]});
  assert.equal((await unicodeFixture.request({action:'start',input:'Follow-up'})).status,202);
  const unicode = JSON.parse(unicodeFixture.calls.find(call=>call.url==='/v1/runs').text).conversation_history;
  assert.equal(unicode[0].content,'x'.repeat(15999));
  assert.equal(JSON.stringify(unicode).includes('�'),false);
});

test('switching conversations reads only the bound session; Workbench card text and unsent drafts stay out', async t => {
  const other = 'selected-conversation';
  const f = await setup(t,{messages:url=>url.includes(other)
    ? [{role:'user',content:'Workbench question'},{role:'assistant',content:'Workbench answer'}]
    : [{role:'user',content:'Normal question'},{role:'assistant',content:'Normal answer'}]});
  assert.equal((await f.request({action:'start',input:'Normal follow-up'})).status,202);
  f.setStatus('completed');
  assert.equal((await f.request({action:'status',run_id})).status,200);
  const switched = await f.request({action:'select_session',target_profile_id:'default',target_session_id:other});
  assert.equal(switched.status,200);
  const file = path.join(f.directory,'shared-chats',`${workspace_id}.${pane_id}.json`);
  const state = JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...state,queued_draft:'Unsent draft',host_result_card:'Private Workbench result'}));
  assert.equal((await f.request({action:'start',session_id:other,expected_binding_revision:1,input:'Workbench follow-up'})).status,202);
  const posts = f.calls.filter(call=>call.url==='/v1/runs').map(call=>JSON.parse(call.text));
  assert.deepEqual(posts.map(post=>post.conversation_history),[
    [{role:'user',content:'Normal question'},{role:'assistant',content:'Normal answer'}],
    [{role:'user',content:'Workbench question'},{role:'assistant',content:'Workbench answer'}],
  ]);
  assert.equal(posts[0].session_id,session_id);
  assert.equal(posts[1].session_id,other);
  assert.ok(!JSON.stringify(posts).includes('Private Workbench result'));
  assert.ok(!JSON.stringify(posts).includes('Unsent draft'));
});

test('durable advertised idempotency uses the receipt UUID but never replays unknown POSTs', async t => {
  const f = await setup(t,{durable:true,lost:true});
  const result = await f.request({action:'start',input:'hello'});
  assert.equal(f.calls.find(call=>call.method==='POST').headers['idempotency-key'],result.body.receipt_id);
  f.restart(); await f.request({action:'submission_status'}); await f.request({action:'start',input:'hello'});
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('accepted receipt survives shared-binding write failure and restart', async t => {
  const f = await setup(t);
  const tempBinding = path.join(f.directory,'shared-chats',`${workspace_id}.${pane_id}.json.tmp`);
  f.setPostFault(()=>fs.mkdirSync(tempBinding));
  const result = await f.request({action:'start',input:'hello'});
  assert.equal(result.body.submission_state,'submission_unknown');
  assert.equal(result.body.run_id,run_id);
  fs.rmdirSync(tempBinding); f.restart(); f.setStatus('completed');
  assert.equal((await f.request({action:'submission_status'})).body.status,'completed');
  assert.equal((await f.request({action:'shared_chat'})).body.state.workbench_pending,undefined);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('distinct Normal conversations overlap across restart; same session and Workbench remain exclusive', async t => {
 const second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', third='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const secondSession='orbit-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const f=await setup(t,{panes:[pane_id,second,third]});
 const bind=async(pane,session)=>f.request({action:'shared_chat',pane_id:pane,initial:{session,messages:[]}});
 await bind(second,secondSession);await bind(third,session_id);
 const first=await f.request({action:'start',input:'first conversation'});assert.equal(first.status,202);
 f.restart();
 const next=await f.request({action:'start',pane_id:second,session_id:secondSession,input:'independent second conversation'});
 assert.equal(next.status,202);assert.notEqual(first.body.run_id,next.body.run_id);
 assert.equal((await f.request({action:'start',pane_id:third,input:'duplicate session'})).status,409);
 const recipient=await f.workbench.readBinding({workspace_id,pane_id:third});
 await assert.rejects(f.workbench.prepareSubmission({workspace_id,pane_id:third,session_id,profile_id:'default',input:'Workbench stays exclusive',expected_binding_revision:0,expected_config_generation:recipient.config_generation}),{code:'busy'});
 f.setStatus('completed');
 const secondDone=await f.request({action:'submission_status',pane_id:second,session_id:secondSession});
 const firstDone=await f.request({action:'submission_status'});
 assert.equal(secondDone.body.output,`Finished ${secondSession}`);assert.equal(firstDone.body.output,`Finished ${session_id}`);
 assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url==='/v1/runs').length,2);
 const release=f.gate.claim('agent','native-worker');
 assert.equal((await f.request({action:'start',pane_id:second,session_id:secondSession,input:'native fence'})).status,409);
 release();
 const releaseJob=f.gate.claim('job','managed-check');
 assert.equal((await f.request({action:'start',pane_id:second,session_id:secondSession,input:'job fence'})).status,409);
 releaseJob();
});

test('unknown, unreceipted and configuration-drifted conversations cannot admit concurrent Normal work', async t => {
 const second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', secondSession='orbit-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 for(const mode of ['unknown','unreceipted','configuration-drift']){
  const f=await setup(t,{panes:[pane_id,second],lost:mode==='unknown'});
  await f.request({action:'shared_chat',pane_id:second,initial:{session:secondSession,messages:[]}});
  await f.request({action:'start',input:mode});
  if(mode==='unreceipted'){
   const file=path.join(f.directory,'shared-chats',`${workspace_id}.${pane_id}.json`),state=JSON.parse(fs.readFileSync(file));
   delete state.ordinary_submission_id;fs.writeFileSync(file,JSON.stringify(state));
  }
  f.restart(mode==='configuration-drift'?'changed-key':'private-test-key');
  assert.equal((await f.request({action:'start',pane_id:second,session_id:secondSession,input:'must stay fenced'})).status,409,mode);
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.url==='/v1/runs').length,1,mode);
 }
});
