import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {createAgentHandler} from '../server/agent.mjs';

test('trace hook preserves SSE bytes/status and only observes checked pane bindings',async t=>{
  const root=mkdtempSync('/tmp/opencode/technology-agent-');
  const token='technology-test-token-'.repeat(3),workspace='11111111-1111-4111-8111-111111111111',pane='22222222-2222-4222-8222-222222222222';
  const session='orbit-33333333-3333-4333-8333-333333333333',run='run_123456789abcdef';
  const bytes='event: update\ndata: {"event":"tool.started","tool":"read_file","tool_call_id":"call-1"}\n\ndata: [DONE]\n\n';
  const observed=[];let handler;
  const server=http.createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  handler=createAgentHandler({token,port,devOrigins:[],runtimeDirectory:root,apiUrl:'http://hermes.test',apiKey:'private-upstream-key',
    workspaceRead:()=>({state:{monitors:[{layout:{type:'pane',pane:{id:pane,kind:'agent'}}}]}}),
    reply:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));},
    onRunEvent:event=>{observed.push(event);throw Error('projection failed');},
    fetchImpl:async url=>{
      if(url.endsWith('/events'))return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(bytes.slice(0,25)));controller.enqueue(new TextEncoder().encode(bytes.slice(25)));controller.close();}}));
      if(url.endsWith('/capabilities'))return Response.json({features:{run_events_sse:true}});
      return Response.json({session_id:session,run_id:run,status:'completed',output:'authoritative output',started_at:1700000000,ended_at:1700000001});
    },
  });
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});
  const request=body=>fetch(origin+'/api/agent',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({session_id:session,...body})});
  const initial=await (await request({action:'shared_chat',workspace_id:workspace,pane_id:pane,initial:{session,messages:[]}})).json();
  const scope={workspace_id:workspace,pane_id:pane,expected_binding_revision:initial.state.binding_revision,profile_id:'default',run_id:run};
  const stream=await request({...scope,action:'events'});assert.equal(stream.status,200);assert.equal(await stream.text(),bytes);
  assert.equal(observed[0].workspace_id,workspace);assert.equal(observed[0].session_id,session);assert.equal(observed[0].profile_id,'default');assert.equal(observed[0].run_id,run);
  const status=await request({...scope,action:'status'});assert.equal(status.status,200);assert.equal((await status.json()).output,'authoritative output');
  const statusObservation=observed.find(event=>event.event.event==='run.status');assert.ok(statusObservation);assert.equal(statusObservation.event.output,undefined);
  const before=observed.length;
  assert.equal((await request({...scope,action:'events',expected_binding_revision:scope.expected_binding_revision+1})).status,409);
  assert.equal(observed.length,before);
  const legacy=await request({action:'events',run_id:run});assert.equal(await legacy.text(),bytes);assert.equal(observed.length,before);
});
