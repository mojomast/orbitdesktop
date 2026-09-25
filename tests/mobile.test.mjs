import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {isPixel,validMobileOrigin,pixelNode} from '../server/mobile-security.mjs';
import {createSharedChats} from '../server/shared-chats.mjs';
import {createAgentHandler} from '../server/agent.mjs';
test('mobile device auth ignores headers, requires exact IP AND stable node ID, and fails closed',async()=>{
 const yes=async()=>({Node:{StableID:pixelNode}});
 assert.equal(await isPixel('100.90.5.126',yes),true);
 assert.equal(await isPixel('::ffff:100.90.5.126',yes),true);
 assert.equal(await isPixel('127.0.0.1',yes),false);
 assert.equal(await isPixel('100.90.5.126',async()=>({Node:{StableID:'other'}})),false);
 assert.equal(await isPixel('100.90.5.126',async()=>{throw Error('offline daemon');}),false);
 const origin='https://kimi.tailec998.ts.net:4367';
 assert.equal(validMobileOrigin({headers:{host:'kimi.tailec998.ts.net:4367',origin}},origin),true);
 assert.equal(validMobileOrigin({headers:{host:'kimi.tailec998.ts.net:4367',origin:'https://evil.test','x-forwarded-for':'100.90.5.126'}},origin),false);
 assert.equal(validMobileOrigin({headers:{host:'evil.test'}},origin),false);
});
test('shared chat registry preserves the first desktop conversation and private disk permissions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-shared-'));
 try{const s=createSharedChats(dir),w=randomUUID(),p=randomUUID(),a={session:'orbit-'+randomUUID(),messages:[{role:'user',text:'test fixture'}]},b={session:'orbit-'+randomUUID(),messages:[]};
 assert.equal(s.bind(w,p,null),null);assert.equal(s.bind(w,p,a).session,a.session);assert.equal(s.bind(w,p,b).session,a.session);
 assert.equal(fs.statSync(path.join(dir,`${w}.${p}.json`)).mode&0o777,0o600);
 assert.throws(()=>s.read('../outside',p));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('two devices share a run and transcript; concurrent starts are rejected',async()=>{
 const w=randomUUID(),p=randomUUID(),session='orbit-'+randomUUID(),token='x'.repeat(40),run='run_mobile_fixture_001';
 const record=new URL(`../.runtime/workspaces/${w}.json`,import.meta.url);
 fs.writeFileSync(record,JSON.stringify({state:{monitors:[{layout:{type:'pane',pane:{id:p,kind:'agent'}}}]}}));
 let starts=0,complete=false;
 const fetchImpl=async(url,opts)=>{
  if(url.includes('/messages'))return Response.json({data:[]});
  if(url.endsWith('/v1/runs')){starts++;await new Promise(r=>setTimeout(r,80));return Response.json({run_id:run,status:'running'});}
  if(url.endsWith('/'+run))return Response.json({run_id:run,session_id:session,status:complete?'completed':'running',output:complete?'fixture reply':''});
  throw Error('Unexpected fixture endpoint');
 };
 const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const handler=createAgentHandler({token,port,devOrigins:[],apiUrl:'http://fixture',apiKey:'fixture',fetchImpl,reply:(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}});server.on('request',handler);
 const call=async(body)=>{const r=await fetch(`http://127.0.0.1:${port}`,{method:'POST',headers:{Origin:`http://127.0.0.1:${port}`,Authorization:`Bearer ${token}`},body:JSON.stringify({workspace_id:w,pane_id:p,session_id:session,...body})});return {status:r.status,data:await r.json()};};
 try{
  assert.equal((await call({action:'start',input:'test'})).status,409);
  assert.equal((await call({action:'shared_chat',initial:{session,messages:[]}})).data.state.session,session);
  const results=await Promise.all([call({action:'start',input:'test'}),call({action:'start',input:'other'})]);
  assert.deepEqual(results.map(x=>x.status).sort(),[202,409]);assert.equal(starts,1);
  assert.equal((await call({action:'shared_chat'})).data.state.run,run);
  complete=true;await call({action:'status',run_id:run});await call({action:'status',run_id:run});
  const linked=(await call({action:'shared_chat'})).data.state;
  assert.equal(linked.messages.length,2);assert.equal(linked.messages[1].text,'fixture reply');assert.equal(linked.run,undefined);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(record,{force:true});fs.rmSync(new URL(`../.runtime/shared-chats/${w}.${p}.json`,import.meta.url),{force:true});}
});
