import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {createResourceDelegation} from '../server/resource-delegation.mjs';
import {createKnowledgeSearch} from '../server/knowledge-index.mjs';
import {createDocumentsService} from '../server/documents-store.mjs';
import {boundedWorkspaceContext} from '../server/workspace-description.mjs';
import {featureCapabilities} from '../contracts/feature-capabilities.mjs';
const ws='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
async function fixture(t,longRoot=false){
  const temp=fs.mkdtempSync('/tmp/opencode/agency-'),root=longRoot?`${temp}/${'long-runtime-name-'.repeat(8)}`:temp;fs.mkdirSync(root,{recursive:true,mode:0o700});let clock=Date.now(),hook=()=>{};
  const workspaceRead=async()=>{await hook();return {state:{monitors:[]}};};
  const knowledge=createKnowledgeSearch({root,workspaceRead}),documents=createDocumentsService({root,workspaceRead});
  let service=await createResourceDelegation({root,workspaceRead,knowledge,documents,now:()=>clock});
  t.after(async()=>{await service.close();await knowledge.close();fs.rmSync(temp,{recursive:true,force:true});});
  const owner=(action,fields={},workspace_id=ws)=>service.dispatch({action,workspace_id,...fields});
  const ingest=(text,title='Selected source')=>knowledge.dispatch({action:'ingest_text',workspace_id:ws,kind:'owner_text',title,text});
  async function recipient(sources,verbs=['search','read_source','create_document']){
    const r=await owner('prepare',{destination:'Synthetic local test destination'});
    await owner('grant',{recipient_id:r.recipient_id,source_ids:sources.map(s=>s.source_id),verbs});
    const channel=JSON.parse(fs.readFileSync(r.channel_file));let sequence=0;
    const call=(body,overrides={})=>new Promise((resolve,reject)=>{
      const raw=Buffer.from(JSON.stringify(body)),seq=String(++sequence),mac=createHmac('sha256',channel.secret).update(`${seq}\n`).update(raw).digest('hex');
      const req=http.request({socketPath:channel.socket,path:'/tool',method:'POST',headers:{'X-Orbit-Recipient':r.recipient_id,'X-Orbit-Sequence':seq,'X-Orbit-Mac':mac,...overrides}},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve(JSON.parse(raw)));});req.on('error',reject);req.end(raw);
    });return {...r,call,channel};
  }
  return {root,knowledge,documents,owner,ingest,recipient,setHook:fn=>{hook=fn;},expire:()=>{clock+=3600001;},restart:async()=>{await service.close();service=await createResourceDelegation({root,workspaceRead,knowledge,documents,now:()=>clock});}};
}
test('selected sources -> exact citation -> saved editable brief; retries and receipt isolation',async t=>{
  const f=await fixture(t),a=await f.ingest('The red planet has two moons.'),b=await f.ingest('Secret excluded title text','PRIVATE C');
  const recipient=await f.recipient([a]),otherRecipient=await f.recipient([b]);
  for(let i=0;i<10;i++){
    const result=await recipient.call({action:'search',query:'planet Secret'});
    assert.equal(result.ok,true);assert.equal(result.result.results.length,1);assert.equal(result.result.results[0].source_id,a.source_id);assert.ok(!JSON.stringify(result).includes('PRIVATE C'));
  }
  assert.equal((await recipient.call({action:'read_source',source_id:b.source_id})).code,'permission_denied');
  assert.equal((await recipient.call({action:'read_source',source_id:a.source_id,workspace_id:other})).code,'invalid_request');
  const exact=await recipient.call({action:'read_source',source_id:a.source_id,offset:4,length:10});assert.equal(exact.result.text,'red planet');assert.equal(exact.result.char_start,4);
  const request={action:'create_document',op_id:randomUUID(),title:'Cited brief',text:'Mars has two moons.',citations:[{source_id:a.source_id,content_sha256:a.content_sha256,char_start:0,char_end:28}]};
  const saved=await recipient.call(request);assert.equal(saved.saved,true);assert.equal(saved.opened,false);assert.equal(saved.browser_acknowledged,false);
  assert.deepEqual(await recipient.call(request),saved);
  assert.equal((await recipient.call({...request,text:'Changed'})).code,'operation_mismatch');
  assert.equal((await recipient.call({action:'receipt',op_id:request.op_id})).result.document_id,saved.document_id);
  assert.equal((await otherRecipient.call({action:'receipt',op_id:request.op_id})).found,false);
  assert.equal((await f.documents.dispatch({action:'list',workspace_id:ws})).documents.length,1);
  const doc=await f.documents.dispatch({action:'read',workspace_id:ws,document_id:saved.document_id});assert.match(doc.data.content,/Mars has two moons/);assert.match(doc.data.content,new RegExp(a.source_id));
  assert.equal((await recipient.call({action:'read_document',document_id:saved.document_id})).code,'invalid_request');
});
test('long durable runtime paths retain short private sockets and invalidate them on restart',async t=>{
  const f=await fixture(t,true),source=await f.ingest('Long-path source'),r=await f.recipient([source]);
  assert.ok(Buffer.byteLength(f.root)>100);
  assert.ok(Buffer.byteLength(r.channel.socket)<100);
  assert.equal(fs.statSync(r.channel.socket).mode&0o777,0o600);
  assert.equal(fs.statSync(new URL('.',`file://${r.channel.socket}`)).mode&0o777,0o700);
  assert.equal((await r.call({action:'read_source',source_id:source.source_id})).result.text,'Long-path source');
  await f.restart();assert.equal(fs.existsSync(r.channel.socket),false);
  assert.equal(fs.existsSync(r.channel_file),false);
});
test('cross-recipient HMAC, guessed identities, revoke, expiry and restart fail closed',async t=>{
  const f=await fixture(t),a=await f.ingest('Shared corpus'),one=await f.recipient([a]),two=await f.recipient([a]);
  assert.equal((await one.call({action:'describe'},{'X-Orbit-Recipient':two.recipient_id})).code,'permission_denied');
  await assert.rejects(f.owner('revoke',{recipient_id:one.recipient_id},other),{code:'permission_denied'});
  await f.owner('revoke',{recipient_id:one.recipient_id});assert.equal((await one.call({action:'describe'})).code,'permission_denied');
  f.expire();assert.equal((await two.call({action:'describe'})).code,'expired');
  await f.restart();const listing=await f.owner('list');assert.equal(listing.recipients.find(r=>r.recipient_id===one.recipient_id).state,'revoked');assert.equal(listing.recipients.find(r=>r.recipient_id===two.recipient_id).state,'expired');
});
test('revocation around asynchronous read prevents disclosure; deletion invalidates exact access',async t=>{
  const f=await fixture(t),a=await f.ingest('Revocable text'),r=await f.recipient([a]);
  let trigger=true;f.setHook(async()=>{if(trigger){trigger=false;await f.owner('revoke',{recipient_id:r.recipient_id});}});
  const result=await r.call({action:'read_source',source_id:a.source_id});assert.equal(result.code,'revoked');assert.ok(!JSON.stringify(result).includes('Revocable text'));
  f.setHook(()=>{});const second=await f.recipient([a]);const status=await f.knowledge.dispatch({action:'status',workspace_id:ws});await f.knowledge.dispatch({action:'delete_source',workspace_id:ws,source_id:a.source_id,base_consent_generation:status.consent_generation});
  assert.equal((await second.call({action:'read_source',source_id:a.source_id})).code,'resource_gone');
});
test('read byte budget and create-only authority are independent',async t=>{
  const f=await fixture(t),a=await f.ingest('budget '.repeat(3000)),r=await f.recipient([a],['read_source']);
  let last;for(let i=0;i<80;i++){last=await r.call({action:'read_source',source_id:a.source_id,length:16000});if(!last.ok)break;}assert.equal(last.code,'limit_exceeded');assert.equal(last.result,undefined);
  const writer=await f.recipient([],['create_document']);assert.equal((await writer.call({action:'search',query:'budget'})).code,'permission_denied');
  const created=await writer.call({action:'create_document',op_id:randomUUID(),title:'Fresh content',text:'New content',citations:[]});assert.equal(created.saved,true);
});
test('lost response after document commit recovers the same artifact with exact key',async t=>{
  const f=await fixture(t),r=await f.recipient([],['create_document']);
  const original=f.documents.dispatch;let lose=true;
  f.documents.dispatch=async(...args)=>{const result=await original(...args);if(lose){lose=false;throw Error('synthetic response loss after atomic commit');}return result;};
  const request={action:'create_document',op_id:randomUUID(),title:'Recover me',text:'One durable document',citations:[]};
  const lost=await r.call(request);assert.equal(lost.outcome,'unknown');assert.equal(lost.op_id,request.op_id);
  assert.equal((await r.call({action:'receipt',op_id:request.op_id})).outcome,'unknown');
  const saved=await r.call(request);assert.equal(saved.saved,true);assert.equal((await f.documents.dispatch({action:'list',workspace_id:ws})).documents.length,1);
  assert.equal((await r.call({action:'receipt',op_id:request.op_id})).outcome,'committed');
});
test('revocation while a document awaits workspace validation blocks the commit',async t=>{
  const f=await fixture(t),r=await f.recipient([],['create_document']);let trigger=true;
  f.setHook(async()=>{if(trigger){trigger=false;await f.owner('revoke',{recipient_id:r.recipient_id});}});
  const result=await r.call({action:'create_document',op_id:randomUUID(),title:'Must not commit',text:'Withheld',citations:[]});
  assert.equal(result.code,'revoked');f.setHook(()=>{});
  assert.equal((await f.documents.dispatch({action:'list',workspace_id:ws})).documents.length,0);
});
test('empty scoped search means no sources; excluded corpus does not change rank',async t=>{
  const f=await fixture(t),a=await f.ingest('planet science'),b=await f.ingest('planet planet research');
  const query={action:'search',workspace_id:ws,query:'planet',mode:'keyword',source_ids:[a.source_id,b.source_id]};
  const before=await f.knowledge.dispatch(query);await f.ingest('planet '.repeat(10000),'excluded');assert.deepEqual(await f.knowledge.dispatch(query),before);
  assert.deepEqual((await f.knowledge.dispatch({...query,source_ids:[]})).results,[]);
});
test('bounded context is valid JSON and feature discovery contains only reviewed types',()=>{
  const context=boundedWorkspaceContext({id:ws,revision:7,state:{monitors:Array.from({length:100},()=>({id:randomUUID(),name:'private '.repeat(1000)}))}});
  assert.ok(Buffer.byteLength(context)<=24000);const parsed=JSON.parse(context);assert.equal(parsed.truncated,true);assert.equal(parsed.counts.windows,100);assert.ok(!context.includes('private'));
  const descriptors=featureCapabilities();assert.equal(descriptors.features.find(f=>f.feature_id==='knowledge-search').surface_uri,'orbit://surface/search');assert.ok(descriptors.features.every(f=>f.content.availability==='not_granted'));
});
test('64 live slots exclude historical receipts but include revoked calls still in flight',async t=>{
  const f=await fixture(t),recipients=[];
  for(let i=0;i<64;i++)recipients.push(await f.recipient([],['create_document']));
  await assert.rejects(f.owner('prepare',{destination:'Over active capacity'}),{code:'limit_exceeded'});
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  let first=true;f.setHook(async()=>{if(first){first=false;enter();await hold;}});
  const op_id=randomUUID(),writing=recipients[0].call({action:'create_document',op_id,title:'Do not replay',text:'Pending effect',citations:[]});
  await entered;await f.owner('revoke',{recipient_id:recipients[0].recipient_id});
  const closing=await f.owner('list');assert.equal(closing.capacity.active_channels,64);assert.equal(closing.capacity.closing_channels,1);
  await assert.rejects(f.owner('prepare',{destination:'Still draining'}),{code:'limit_exceeded'});
  release();assert.equal((await writing).code,'revoked');f.setHook(()=>{});
  const before=JSON.parse(fs.readFileSync(path.join(f.root,'resource-delegation',`${recipients[0].recipient_id}.json`)));
  assert.ok(before.operations[op_id].document_id);assert.equal(before.operations[op_id].result,undefined);
  await f.owner('prepare',{destination:'New live slot'});const listed=await f.owner('list');
  assert.equal(listed.capacity.active_channels,64);assert.equal(listed.capacity.retained_records,65);
  assert.equal((await recipients[1].call({action:'describe'})).ok,true);assert.equal((await recipients[1].call({action:'describe'})).ok,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'resource-delegation',`${recipients[0].recipient_id}.json`))).operations,before.operations);
  assert.equal((await f.documents.dispatch({action:'list',workspace_id:ws})).documents.length,0);
});
