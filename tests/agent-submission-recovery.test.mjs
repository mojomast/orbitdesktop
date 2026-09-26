import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentHandler } from '../server/agent.mjs';

const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const session_id = 'orbit-12345678-1234-4234-9234-123456789abc';
const run_id = 'run_123456789abcdef';
const token = 'ordinary-test-token-'.repeat(4);
const actualCapabilities = {object:'hermes.api_server.capabilities',platform:'hermes-agent',runtime:{mode:'server_agent',tool_execution:'server'},features:{run_submission:true,run_status:true,run_stop:true,session_resources:true,session_continuity_header:'X-Hermes-Session-Id'}};
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const reply = (res,status,body) => { res.writeHead(status,{'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };

async function setup(t, {lost = false, legacy = false, durable = false} = {}) {
  const directory = fs.mkdtempSync('/tmp/opencode/ordinary-submission-');
  const calls = [];
  let runStatus = 'running', postFault;
  const gateway = http.createServer(async (req,res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({url:req.url,method:req.method,headers:req.headers,text});
    if (req.url === '/v1/capabilities') return reply(res,200,legacy ? {version:'fake',features:{session_continuation:true}} : {...actualCapabilities,features:{...actualCapabilities.features,...(durable ? {runs_idempotency:{supported:true,durable:true,retention_seconds:600}} : {})}});
    if (req.url.includes('/messages')) return reply(res,200,{data:[{role:'user',content:'Earlier'},{role:'assistant',content:'Remembered'},{role:'system',content:'not context'}]});
    if (req.url === '/v1/runs' && req.method === 'POST') {
      const binding = JSON.parse(fs.readFileSync(path.join(directory,'shared-chats',`${workspace_id}.${pane_id}.json`),'utf8'));
      const record = JSON.parse(fs.readFileSync(path.join(directory,'ordinary-submissions',`${binding.ordinary_submission_id}.json`),'utf8'));
      assert.equal(record.state,'dispatching');
      assert.equal(JSON.stringify(record.payload),text);
      assert.equal(record.payload_hash,createHash('sha256').update(text).digest('hex'));
      assert.equal(binding.workbench_pending,record.receipt_id);
      if (lost) { req.socket.destroy(); return; }
      postFault?.();
      return reply(res,202,{run_id,status:'running'});
    }
    return reply(res,200,{run_id,session_id,status:runStatus,output:'Finished'});
  });
  await listen(gateway);
  let handler;
  const server = http.createServer((req,res) => handler(req,res));
  await listen(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const restart = (apiKey = 'private-test-key') => {
    handler = createAgentHandler({token,port:server.address().port,devOrigins:[],reply,runtimeDirectory:directory,apiUrl:`http://127.0.0.1:${gateway.address().port}`,apiKey,workspaceContext:()=>'\nTrusted workspace context',workspaceRead:()=>({state:{monitors:[{layout:{type:'pane',pane:{id:pane_id,kind:'agent'}}}]}})});
  };
  restart();
  t.after(async () => { await close(server); await close(gateway); fs.rmSync(directory,{recursive:true,force:true}); });
  async function request(body) {
    const response = await fetch(`${origin}/api/agent`,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id,pane_id,session_id,profile_id:'default',expected_binding_revision:0,...body})});
    return {status:response.status,body:await response.json()};
  }
  assert.equal((await request({action:'shared_chat',initial:{session:session_id,messages:[]}})).status,200);
  return {request,restart,calls,directory,setStatus:value=>{runStatus=value;},setPostFault:value=>{postFault=value;}};
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

test('known receipt uses original configuration, normal status clears the fence, native continuation is actual-contract gated', async t => {
  const f = await setup(t);
  const result = await f.request({action:'start',input:'Hello'});
  assert.equal(result.status,202); assert.equal(result.body.run_id,run_id);
  const post = f.calls.find(call=>call.method==='POST');
  assert.equal(post.headers['idempotency-key'],undefined);
  assert.equal(JSON.parse(post.text).conversation_history,undefined);
  assert.match(JSON.parse(post.text).instructions,/Trusted workspace context/);
  assert.ok(!f.calls.some(call=>call.url.includes('/messages')));
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
