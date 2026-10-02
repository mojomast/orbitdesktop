import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createRunTraces,createRunTraceTee} from '../server/run-traces.mjs';
import {createRunTracesHandler} from '../server/run-traces-route.mjs';
import {createAgentHandler} from '../server/agent.mjs';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
import {validateTraceSpan,TRACE_LIMITS} from '../contracts/run-trace-v1.mjs';

function fixture(t){const root=fs.mkdtempSync('/tmp/opencode/run-traces-test-');const workspaces=[randomUUID(),randomUUID()];let clock=1790810000000;
  const service=createRunTraces({root,workspaceRead:id=>{if(!workspaces.includes(id))throw Error();return {id};},now:()=>clock});
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
  const binding={workspace_id:workspaces[0],profile_id:'default',session_id:'orbit-fixture',run_id:'run_fixture'};
  const event=(event,extra={})=>service.observe({...binding,event,at:clock,...extra});
  const request=(action,fields={})=>service.dispatch({workspace_id:workspaces[0],action,...fields});
  return {root,workspaces,service,binding,event,request,advance:ms=>clock+=ms};
}

test('observed Normal events isolate workspace/profile/session, redact payloads, replay idempotently and use real SDK local exporter',t=>{
  const f=fixture(t);const start={event:'run.started',timestamp:1700000000,input:'SECRET_PROMPT',tokens:123};f.event(start);f.event(start);
  f.event({event:'tool.started',tool:'read_file',tool_call_id:'call-1',timestamp:1700000000.1,arguments:{path:'SECRET_PATH'}});
  f.event({event:'tool.completed',tool:'read_file',tool_call_id:'call-1',timestamp:1700000000.4,result:'SECRET_RESULT'});
  f.event({event:'run.completed',timestamp:1700000001,output:'SECRET_OUTPUT'});
  const trace=f.request('list').traces[0];assert.equal(trace.status,'completed');
  const page=f.request('page',{trace_id:trace.trace_id});assert.equal(page.spans.length,2);assert.equal(page.spans.find(s=>s.name==='tool read_file').end_unix_ms-page.spans.find(s=>s.name==='tool read_file').start_unix_ms,300);
  for(const span of page.spans)assert.equal(validateTraceSpan(span),true);
  assert.equal(f.service.sdkExports(),2);assert.equal(f.service.projectionErrors(),0);
  const out=f.request('export',{trace_id:trace.trace_id});assert.ok(out.bytes<TRACE_LIMITS.exportBytes);assert.equal(out.resource_spans.resourceSpans[0].scopeSpans[0].spans.length,2);assert.ok(!JSON.stringify(out).match(/SECRET|tokens|arguments|result|input|output/));
  for(const extra of [{workspace_id:f.workspaces[1]},{profile_id:'other'},{session_id:'other'}])f.event(start,extra);
  assert.equal(f.request('list').traces.length,3);assert.equal(f.request('list',{profile_id:'other',session_id:'orbit-fixture'}).traces.length,1);
  assert.throws(()=>f.service.dispatch({action:'page',workspace_id:f.workspaces[1],trace_id:trace.trace_id}),{code:'permission_denied'});
  assert.throws(()=>f.request('export',{trace_id:trace.trace_id,prompt:'bad'}),{code:'invalid_request'});
  assert.throws(()=>f.service.dispatch({action:'list',workspace_id:randomUUID()}),{code:'permission_denied'});
});

test('unknown, missing starts, local timing and restart remain honest partial observations',t=>{
  const f=fixture(t);f.event({event:'tool.completed',tool:'terminal',tool_call_id:'orphan',timestamp:1700000001});
  const orphan=f.request('list').traces[0];assert.equal(orphan.partial,true);const span=f.request('page',{trace_id:orphan.trace_id}).spans[0];assert.equal(span.duration_origin,'instant');assert.equal(span.start_unix_ms,span.end_unix_ms);
  f.event({event:'run.status',status:'running'},{run_id:'run_restart'});const active=f.request('list').traces.find(r=>r.run_id==='run_restart');f.service.close();
  const reopened=createRunTraces({root:f.root,workspaceRead:id=>({id})});t.after(()=>reopened.close());
  const list=reopened.dispatch({action:'list',workspace_id:f.workspaces[0]});assert.equal(list.traces.find(r=>r.trace_id===active.trace_id).status,'partial');
  const open=reopened.dispatch({action:'page',workspace_id:f.workspaces[0],trace_id:active.trace_id}).spans[0];assert.equal(open.end_unix_ms,null);assert.equal(open.duration_origin,'local_observation');
});

test('upstream start timestamps replace local receipt timing rather than fabricating a mixed-clock interval',t=>{
  const f=fixture(t);f.event({event:'run.status',status:'running'});f.event({event:'run.started',timestamp:1700000000});f.event({event:'run.completed',timestamp:1700000001});
  const trace=f.request('list').traces[0];const root=f.request('page',{trace_id:trace.trace_id}).spans[0];assert.equal(root.duration_origin,'observed');assert.equal(root.end_unix_ms-root.start_unix_ms,1000);
});

test('span and trace caps bound durable projections and flag truncation partial',t=>{
  const f=fixture(t);f.event({event:'run.started',timestamp:1700000000});
  for(let i=0;i<TRACE_LIMITS.spansPerTrace+2;i++)f.event({event:'tool.started',tool:'read',tool_call_id:`call-${i}`,timestamp:1700000000});
  const trace=f.request('list').traces[0];assert.equal(trace.status,'partial');let cursor=0,count=0;for(;;){const page=f.request('page',{trace_id:trace.trace_id,after_sequence:cursor});count+=page.spans.length;cursor=page.after_sequence;if(!page.has_more)break;}assert.equal(count,TRACE_LIMITS.spansPerTrace);
  for(let i=0;i<TRACE_LIMITS.tracesPerScope+2;i++){f.advance(1);f.event({event:'run.started'},{run_id:`run-${i}`});}
  assert.equal(f.request('list').traces.length,TRACE_LIMITS.tracesPerScope);assert.throws(()=>f.request('page',{trace_id:trace.trace_id}),{code:'permission_denied'});
  f.workspaces.push(randomUUID());
  for(const workspace_id of f.workspaces.slice(1))for(let i=0;i<TRACE_LIMITS.tracesPerScope;i++){f.advance(1);f.event({event:'run.started'},{workspace_id,run_id:`run-${i}`});}
  const total=f.workspaces.reduce((n,workspace_id)=>n+f.service.dispatch({action:'list',workspace_id}).traces.length,0);assert.equal(total,TRACE_LIMITS.tracesTotal);
});

test('retention is scoped and explicit, removing traces never removes upstream records',t=>{
  const f=fixture(t);f.event({event:'run.started'});const trace=f.request('list').traces[0];f.advance(8*86400000);
  assert.equal(f.request('retention',{dry_run:true}).eligible,1);assert.equal(f.request('list').traces.length,1);
  assert.equal(f.request('retention',{dry_run:false}).removed,1);assert.equal(f.request('list').traces.length,0);
  f.event({event:'run.started'},{run_id:'fresh'});const fresh=f.request('list').traces[0];assert.equal(f.request('remove',{trace_id:fresh.trace_id}).removed,true);
  assert.throws(()=>f.request('page',{trace_id:trace.trace_id}),{code:'permission_denied'});
});

test('Workbench attempt creation is an instant fact and actual native grant lifecycle drives run status',t=>{
  const f=fixture(t),project_id=randomUUID(),attempt_id=randomUUID(),grant_id=randomUUID();
  const scope={workspace_id:f.workspaces[0],project_id,attempt_id};
  const record={...scope,id:attempt_id,revision:1,status:'created',created_at:1790810000000,updated_at:1790810000000};
  f.service.observe({kind:'attempts',phase:'create',record});let trace=f.request('list').traces[0];assert.equal(trace.status,'partial');assert.equal(f.request('page',{trace_id:trace.trace_id}).spans[0].duration_origin,'instant');
  const grant={...scope,id:grant_id,revision:1,status:'approved',created_at:1790810000000,updated_at:1790810000000};f.service.observe({kind:'grants',phase:'create',record:grant});
  f.service.observe({kind:'grants',phase:'update',record:{...grant,revision:2,status:'running',started_at:1790810000100,updated_at:1790810000100}});assert.equal(f.request('list').traces[0].status,'running');
  f.service.observe({kind:'grants',phase:'update',record:{...grant,revision:3,status:'completed',started_at:1790810000100,ended_at:1790810000500,updated_at:1790810000500}});assert.equal(f.request('list').traces[0].status,'completed');const spans=f.request('page',{trace_id:trace.trace_id}).spans;const run=spans.find(s=>s.name==='grant');assert.equal(run.duration_origin,'observed');assert.equal(run.end_unix_ms-run.start_unix_ms,400);
  f.service.observe({kind:'grants',phase:'snapshot',record:{...grant,revision:2,status:'failed'}});assert.equal(f.request('list').traces[0].status,'completed','older revisions never replace current lifecycle');
});

test('real WorkbenchData commit subscription projects actual records and isolates callback failure',t=>{
  const root=fs.mkdtempSync('/tmp/opencode/run-traces-wb-');const store=new SqliteWorkspaceStore(root);const workspace=randomUUID();
  store.commit(commandIdentity({workspace_id:workspace,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id:workspace,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const records=new WorkbenchStore(store);const project=records.register(workspace,{root:path.join(root,'project'),name:'Synthetic',identity:'synthetic'});const data=new WorkbenchData(store);
  const traces=createRunTraces({root,workspaceRead:id=>store.read(id),workbenchData:data});t.after(()=>{traces.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  traces.subscribe(()=>{throw Error('private observer error');});const scope={workspace_id:workspace,project_id:project.id};
  const attempt=data.create('attempts',{...scope,status:'running',input:'SECRET_PROMPT'});
  const tool=data.create('toolcalls',{...scope,attempt_id:attempt.id,action:'candidate_read',status:'started',arguments:'SECRET_ARGS'});
  data.update('toolcalls',workspace,project.id,tool.id,tool.revision,{status:'completed',result:'SECRET_RESULT'});
  data.update('attempts',workspace,project.id,attempt.id,attempt.revision,{status:'completed'});
  const trace=traces.dispatch({action:'list',workspace_id:workspace}).traces[0];assert.equal(trace.method,'workbench');assert.equal(trace.status,'completed');
  const page=traces.dispatch({action:'page',workspace_id:workspace,trace_id:trace.trace_id});assert.equal(page.spans.length,2);assert.equal(page.spans[1].duration_origin,'local_observation');assert.ok(!JSON.stringify(page).includes('SECRET'));assert.equal(traces.sdkExports(),2);
  // Real execution jobs/evidence often carry provenance rather than attempt_id.
  const job=data.create('jobs',{...scope,status:'running',started_at:1790810000000,op_id:tool.id,provenance:{initiated_by:{kind:'native_agent',tool_call_id:tool.id}},stdout_preview:'SECRET_LOG'});
  data.update('jobs',workspace,project.id,job.id,job.revision,{status:'completed',ended_at:1790810000500,exit_code:0});
  data.create('evidence',{...scope,job_id:job.id,verdict:'pass',test_results:{tests:3,passed:3},stdout_preview:'SECRET_LOG'});
  const related=traces.dispatch({action:'page',workspace_id:workspace,trace_id:trace.trace_id});assert.equal(related.spans.length,4);const check=related.spans.find(s=>s.name==='job');assert.equal(check.duration_origin,'observed');assert.equal(check.end_unix_ms-check.start_unix_ms,500);assert.equal(related.spans.find(s=>s.name==='evidence').authority,'recorder');assert.ok(!JSON.stringify(related).includes('SECRET'));
  assert.throws(()=>store.db.transaction(()=>{data.create('jobs',{...scope,attempt_id:attempt.id,status:'running'});throw Error('rollback');})());
});

test('optional projection failure cannot break an authoritative submit and private symlinks are rejected',t=>{
  const f=fixture(t);fs.symlinkSync('/dev/null',path.join(f.root,'run-traces.sqlite'));
  assert.doesNotThrow(()=>f.event({event:'run.started'}));assert.equal(f.service.projectionErrors(),1);assert.equal(f.request('capability').available,false);
});

test('bounded SSE tee handles split UTF-8, multiline data, replay, oversize and throwing observers without changing source bytes',()=>{
  const events=[];let errors=0;const tee=createRunTraceTee({binding:{workspace_id:'w'},onRunEvent:e=>events.push(e),maxFrameBytes:100,onError:()=>errors++});
  const source=Buffer.from('data: {"event":"tool.started",\ndata: "tool":"read","tool_call_id":"a"}\r\n\r\n');for(let i=0;i<source.length;i+=3)tee.write(source.subarray(i,i+3));assert.equal(events.length,1);
  tee.write(Buffer.from(`data: ${'x'.repeat(300)}`));tee.write(Buffer.from('\n\ndata: {"event":"run.started"}\n\n'));assert.equal(events.filter(e=>e.event.event!=='trace.gap').length,2);assert.ok(errors>0);
  const throwing=createRunTraceTee({binding:{},onRunEvent:()=>{throw Error();}});assert.doesNotThrow(()=>throwing.write(Buffer.from('data: {}\n\n')));
});

test('owner POST route authenticates scope and bounds request payload',async t=>{
  const f=fixture(t);const token='trace-test-token'.repeat(4);let handler,port;const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  const server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;handler=createRunTracesHandler({token,port,devOrigins:[],reply,traces:f.service});t.after(()=>new Promise(r=>server.close(r)));const origin=`http://127.0.0.1:${port}`;
  const request=(body,headers={})=>fetch(origin+'/api/run-traces',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,...headers},body:JSON.stringify(body)});
  assert.equal((await request({action:'list',workspace_id:f.workspaces[0]},{Authorization:'Bearer wrong'})).status,403);
  assert.equal((await request({action:'list',workspace_id:f.workspaces[0]},{Origin:'https://evil.test'})).status,403);
  assert.equal((await request({action:'list',workspace_id:f.workspaces[0],extra:1})).status,400);
  assert.equal((await request({action:'list',workspace_id:f.workspaces[0],extra:'x'.repeat(20000)})).status,413);
  const good=await request({action:'capability',workspace_id:f.workspaces[0]});assert.equal(good.status,200);assert.equal(good.headers.get('cache-control'),'no-store');assert.equal((await good.json()).available,true);
});

test('real agent handler observes fake Hermes SSE through actual optional callback',async t=>{
  const f=fixture(t);const session='orbit-12345678-1234-4234-9234-123456789abc',run='run_123456789abcdef',token='trace-agent-token'.repeat(4),pane_id=randomUUID();let handler,port;
  const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  const frames=[{event:'run.started',timestamp:1700000000},{event:'tool.started',tool:'fixture_read',tool_call_id:'real-call',timestamp:1700000000.1,arguments:'SECRET_ARGS'},{event:'tool.completed',tool:'fixture_read',tool_call_id:'real-call',timestamp:1700000000.2,output:'SECRET_OUTPUT'},{event:'run.completed',timestamp:1700000001}];
  const server=http.createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
  handler=createAgentHandler({token,port,devOrigins:[],reply,runtimeDirectory:f.root,apiUrl:'http://hermes.test',apiKey:'private-upstream-key',workspaceRead:id=>({id,state:{monitors:[{layout:{type:'pane',pane:{id:pane_id,kind:'agent'}}}]}}),onRunEvent:e=>f.service.observe(e),fetchImpl:async url=>url.endsWith('/events')?new Response(frames.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}}):new Response(JSON.stringify(url.endsWith('/capabilities')?{features:{run_events_sse:true}}:{run_id:run,session_id:session,status:'completed'}))});
  t.after(()=>new Promise(r=>server.close(r)));const origin=`http://127.0.0.1:${port}`;
  const base={workspace_id:f.workspaces[0],pane_id,profile_id:'default',session_id:session};const bound=await fetch(origin+'/api/agent',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`},body:JSON.stringify({action:'shared_chat',...base,initial:{session,profile_id:'default',messages:[]}})});assert.equal(bound.status,200);const revision=(await bound.json()).state.binding_revision;
  const response=await fetch(origin+'/api/agent',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`},body:JSON.stringify({action:'events',...base,expected_binding_revision:revision,run_id:run})});assert.equal(response.status,200);assert.ok((await response.text()).includes('SECRET_OUTPUT'),'proxy bytes remain unchanged');
  const traces=f.request('list').traces;assert.equal(traces.length,1);assert.equal(traces[0].status,'completed');const spans=f.request('page',{trace_id:traces[0].trace_id}).spans;assert.equal(spans.length,2);assert.ok(!JSON.stringify(spans).includes('SECRET'));assert.ok(f.service.sdkExports()>0);
});
