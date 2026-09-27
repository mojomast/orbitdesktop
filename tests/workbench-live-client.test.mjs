import test from 'node:test';
import assert from 'node:assert/strict';
import {watchWorkbenchLive} from '../src/workbench-live-client.ts';

const scope={workspaceId:'11111111-1111-4111-8111-111111111111',projectId:'22222222-2222-4222-8222-222222222222'};
const item=sequence=>({version:1,id:`event-${sequence}`,sequence,at:sequence,authority:'observed',category:'tools',kind:'tool.completed',summary:'Read completed',status:'completed'});
const page=(sequence,events,reset_required=false)=>({version:1,after_sequence:sequence,events,reset_required,has_more:false,project_generation:1});
const stream=value=>new Response(`event: page\ndata: ${JSON.stringify(value)}\n\n`,{headers:{'Content-Type':'text/event-stream'}});

test('Workbench reconnect uses a durable cursor and only read actions; disposal prevents later updates',async t=>{
  const original=globalThis.fetch,requests=[],pages=[],connections=[];let resumed;
  const replayed=new Promise(resolve=>{resumed=resolve;});
  globalThis.fetch=async (_url,options)=>{
    const request=JSON.parse(options.body);requests.push(request);
    assert.equal(options.headers.Authorization,'Bearer private-owner-token');
    assert.equal(options.cache,'no-store');
    if(requests.length===1)return stream(page(1,[item(1)]));
    if(request.action==='page')return Response.json(page(2,[item(2)]));
    assert.equal(request.action,'stream');assert.equal(request.after_sequence,2);
    const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(`event: page\ndata: ${JSON.stringify(page(3,[item(3)]))}\n\n`));options.signal.addEventListener('abort',()=>controller.close(),{once:true});}});
    resumed();return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
  };
  const live=watchWorkbenchLive({...scope,getToken:()=>'private-owner-token',onPage:value=>pages.push(value),onConnection:state=>connections.push(state)});
  t.after(()=>{live.dispose();globalThis.fetch=original;});
  await replayed;
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(pages.flatMap(value=>value.events.map(event=>event.sequence)),[1,2,3]);
  assert.ok(connections.includes('disconnected'));
  assert.deepEqual(requests.map(request=>request.action),['stream','page','stream']);
  assert.equal(requests[1].after_sequence,1);
  const count=pages.length;live.dispose();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(pages.length,count);
});

test('Workbench truncation replaces retained history; authority fencing cannot restart execution',async t=>{
  const original=globalThis.fetch,pages=[],connections=[];let resets=0;
  globalThis.fetch=async()=>new Response(`event: page\ndata: ${JSON.stringify(page(100,[item(99),item(100)],true))}\n\nevent: fenced\ndata: {"version":1}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  const live=watchWorkbenchLive({...scope,getToken:()=>'private-owner-token',onPage:value=>pages.push(value),onReset:()=>resets++,onConnection:(state,message)=>connections.push([state,message])});
  t.after(()=>{live.dispose();globalThis.fetch=original;});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(resets,1);assert.equal(live.getCursor(),100);assert.equal(pages.length,1);
  assert.equal(connections.at(-1)[0],'closed');assert.match(connections.at(-1)[1],/not be replayed/);
  await assert.rejects(live.tail('33333333-3333-4333-8333-333333333333'),/closed/);
});

test('a refused historical detail does not stop the independently authorized live stream',async t=>{
  const original=globalThis.fetch,pages=[],connections=[];let wire;
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);
    if(request.action==='detail')return Response.json({ok:false,code:'permission_denied'},{status:403});
    const body=new ReadableStream({start(controller){wire=controller;options.signal.addEventListener('abort',()=>controller.close(),{once:true});}});
    return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
  };
  const live=watchWorkbenchLive({...scope,getToken:()=>'owner',onPage:value=>pages.push(value),onConnection:state=>connections.push(state)});
  t.after(()=>{live.dispose();globalThis.fetch=original;});
  await assert.rejects(live.detail({kind:'candidate',id:'33333333-3333-4333-8333-333333333333',generation:1,hash:'a'.repeat(64)}),/permission_denied/);
  wire.enqueue(new TextEncoder().encode(`event: page\ndata: ${JSON.stringify(page(1,[item(1)]))}\n\n`));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(pages.length,1);assert.equal(connections.includes('closed'),false);
});
