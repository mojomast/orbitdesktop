import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {createResourceDelegation} from '../server/resource-delegation.mjs';
import {createKnowledgeSearch} from '../server/knowledge-index.mjs';
import {createDocumentsService} from '../server/documents-store.mjs';

const ws='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
const ALL=['search','read_source','create_document','list_documents','read_document','revise_document','request_permission'];
const element=(over={})=>({id:'shape-1',type:'rectangle',x:0,y:0,width:120,height:60,angle:0,strokeColor:'#111',backgroundColor:'transparent',fillStyle:'solid',strokeWidth:2,strokeStyle:'solid',roughness:1,opacity:100,groupIds:[],frameId:null,index:'a0',roundness:null,seed:1,version:1,versionNonce:1,isDeleted:false,boundElements:null,updated:1,link:null,locked:false,...over});
// A genuine Excalidraw export: full appState, collaborators, frame name, customData.
const scene=()=>JSON.stringify({type:'excalidraw',version:2,source:'https://excalidraw.com',
  elements:[element(),element({id:'text-1',type:'text',fontFamily:5,fontSize:16,text:'Stage 1',originalText:'Stage 1',width:60,height:20}),element({id:'frame-1',type:'frame',name:'Board',customData:{note:'power'}})],
  appState:{gridSize:20,viewBackgroundColor:'#ffffff',scrollX:90,scrollY:-12,zoom:{value:1.25},theme:'light',currentItemFontFamily:5,collaborators:{u1:{username:'owner'}},openDialog:'elementProperties'},files:{}});

async function fixture(t){
  const temp=fs.mkdtempSync('/tmp/opencode/content-verbs-'),root=temp;fs.mkdirSync(root,{recursive:true,mode:0o700});
  const workspaceRead=async()=>({state:{monitors:[]}});
  const knowledge=createKnowledgeSearch({root,workspaceRead}),documents=createDocumentsService({root,workspaceRead});
  const service=await createResourceDelegation({root,workspaceRead,knowledge,documents});
  t.after(async()=>{await service.close();await knowledge.close();await documents.close?.();fs.rmSync(temp,{recursive:true,force:true});});
  const owner=(action,fields={},workspace_id=ws)=>service.dispatch({action,workspace_id,...fields});
  // The owner route throws its refusal code; the HTTP wrapper is what turns it
  // into a body. Model that boundary so error paths are assertable.
  const ownerTry=async(action,fields={},workspace_id=ws)=>{try{return await owner(action,fields,workspace_id);}catch(e){return {ok:false,code:e.code??'unavailable'};}};
  const ingest=(text,title='Selected source')=>knowledge.dispatch({action:'ingest_text',workspace_id:ws,kind:'owner_text',title,text});
  async function recipient(sources,verbs=ALL){
    const r=await owner('prepare',{destination:'Synthetic local test destination'});
    await owner('grant',{recipient_id:r.recipient_id,source_ids:sources.map(s=>s.source_id),verbs});
    const channel=JSON.parse(fs.readFileSync(r.channel_file));let sequence=0;
    const call=(body)=>new Promise((resolve,reject)=>{
      const raw=Buffer.from(JSON.stringify(body)),seq=String(++sequence),mac=createHmac('sha256',channel.secret).update(`${seq}\n`).update(raw).digest('hex');
      const req=http.request({socketPath:channel.socket,path:'/tool',method:'POST',headers:{'X-Orbit-Recipient':r.recipient_id,'X-Orbit-Sequence':seq,'X-Orbit-Mac':mac}},res=>{let out='';res.on('data',x=>out+=x);res.on('end',()=>resolve(JSON.parse(out)));});req.on('error',reject);req.end(raw);
    });
    return {...r,call,channel};
  }
  return {root,knowledge,documents,owner,ownerTry,ingest,recipient};
}

test('an agent creates a real canvas through its grant, then reads it back',async t=>{
  const f=await fixture(t),source=await f.ingest('Relay terminal ships month 12.'),r=await f.recipient([source]);
  const request={action:'create_document',op_id:randomUUID(),title:'Deployment board',citations:[],kind:'scene',scene:scene()};
  const saved=await r.call(request);
  assert.equal(saved.ok,true,JSON.stringify(saved));
  assert.equal(saved.saved,true);
  // Saving is not opening. The agent must not claim the owner is looking at it.
  assert.equal(saved.opened,false);
  assert.equal(saved.browser_acknowledged,false);
  assert.equal(saved.kind,'scene');
  assert.equal(saved.artifact_uri,`orbit://document/${saved.document_id}`);
  // An exact retry is idempotent, never a second canvas.
  assert.deepEqual(await r.call(request),saved);
  assert.equal((await r.call({...request,scene:scene().replace('"seed":1','"seed":99')})).code,'operation_mismatch');
  assert.equal((await f.documents.dispatch({action:'list',workspace_id:ws})).documents.length,1);

  const read=await r.call({action:'read_document',document_id:saved.document_id});
  assert.equal(read.ok,true);
  assert.equal(read.result.kind,'scene');
  assert.equal(read.result.revision,saved.revision);
  assert.match(read.result.text,/excalidraw/);
  // The real export's view-only state was normalized, not rejected.
  assert.doesNotMatch(read.result.text,/collaborators/);
  assert.doesNotMatch(read.result.text,/openDialog/);
  RESULT.canvas=true;
});

test('a revision-bound edit applies and a stale base is refused',async t=>{
  const f=await fixture(t),source=await f.ingest('Budget is two million.'),r=await f.recipient([source]);
  const created=await r.call({action:'create_document',op_id:randomUUID(),title:'Board',citations:[],kind:'scene',scene:scene()});
  const revised=await r.call({action:'revise_document',op_id:randomUUID(),document_id:created.document_id,expected_revision:created.revision,title:'Board',kind:'scene',scene:scene().replace('"seed":1','"seed":7')});
  assert.equal(revised.ok,true,JSON.stringify(revised));
  assert.equal(revised.revision,created.revision+1);
  assert.equal(revised.document_id,created.document_id);
  // Replaying revision 0 now must not silently overwrite the newer edit.
  const stale=await r.call({action:'revise_document',op_id:randomUUID(),document_id:created.document_id,expected_revision:0,title:'Board',kind:'scene',scene:scene()});
  assert.equal(stale.code,'stale_resource');
  assert.equal((await r.call({action:'read_document',document_id:created.document_id})).result.revision,revised.revision);
  // A scene cannot be revised into a document.
  assert.equal((await r.call({action:'revise_document',op_id:randomUUID(),document_id:created.document_id,expected_revision:revised.revision,title:'Board',kind:'richtext',text:'plain'})).code,'invalid_request');
  RESULT.revision=true;
});

test('content verbs are refused unless the owner granted them',async t=>{
  const f=await fixture(t),source=await f.ingest('Narrow grant.'),r=await f.recipient([source],['search','read_source','create_document']);
  assert.equal((await r.call({action:'list_documents'})).code,'permission_denied');
  assert.equal((await r.call({action:'read_document',document_id:randomUUID()})).code,'permission_denied');
  assert.equal((await r.call({action:'revise_document',op_id:randomUUID(),document_id:randomUUID(),expected_revision:0,title:'T',kind:'richtext',text:'x'})).code,'permission_denied');
  assert.equal((await r.call({action:'request_permission',op_id:randomUUID(),need:'revise_document',reason:'Need to update the plan.'})).code,'permission_denied');
  // Creation still works, because that verb was granted.
  assert.equal((await r.call({action:'create_document',op_id:randomUUID(),title:'T',citations:[],kind:'richtext',text:'body'})).ok,true);
  RESULT.scoped_verbs=true;
});

test('an unknown action fails closed instead of becoming a source read',async t=>{
  const f=await fixture(t),source=await f.ingest('Exact source text.'),r=await f.recipient([source]);
  for(const action of ['update_document','delete_document','create_canvas','Read_Document',''])
    assert.equal((await r.call({action,document_id:randomUUID(),source_id:source.source_id})).code,'invalid_request',action);
  // A malformed identity must not be treated as a missing optional field.
  assert.equal((await r.call({action:'read_document',document_id:'not-a-uuid'})).code,'invalid_request');
  // A scene body with a document kind, or both bodies at once, is refused.
  assert.equal((await r.call({action:'create_document',op_id:randomUUID(),title:'T',citations:[],kind:'richtext',scene:scene()})).code,'invalid_request');
  assert.equal((await r.call({action:'create_document',op_id:randomUUID(),title:'T',citations:[],kind:'richtext',text:'a',scene:scene()})).code,'invalid_request');
  RESULT.fail_closed=true;
});

test('an agent raises a permission request and approval actually widens the grant',async t=>{
  const f=await fixture(t),source=await f.ingest('Source.'),r=await f.recipient([source],['search','read_source','create_document','request_permission']);
  const requestId=randomUUID();
  const raised=await r.call({action:'request_permission',op_id:requestId,need:'revise_document',reason:'Need to update the plan after the budget change.'});
  assert.equal(raised.ok,true,JSON.stringify(raised));
  assert.equal(raised.request.state,'pending');
  assert.equal(raised.verb_needed,'revise_document');
  // The agent is told approval is still required; it must not assume success.
  assert.match(raised.instruction,/approve/i);
  assert.equal((await r.call({action:'revise_document',op_id:randomUUID(),document_id:randomUUID(),expected_revision:0,title:'T',kind:'richtext',text:'x'})).code,'permission_denied');

  const shown=await f.owner('list_permission_requests',{recipient_id:r.recipient_id});
  assert.equal(shown.requests.length,1);
  assert.equal(shown.requests[0].need,'revise_document');
  const current=await f.owner('list',{});
  const record=current.recipients.find(x=>x.recipient_id===r.recipient_id);
  const approved=await f.owner('approve_permission',{recipient_id:r.recipient_id,request_id:requestId,expected_generation:record.generation});
  assert.ok(approved.grant.verbs.includes('revise_document'),JSON.stringify(approved.grant));
  assert.equal(approved.permission_requests[0].state,'approved');
  // The widened verb is usable, and only on this live grant.
  assert.equal((await r.call({action:'revise_document',op_id:randomUUID(),document_id:randomUUID(),expected_revision:0,title:'T',kind:'richtext',text:'x'})).code!=='permission_denied',true);
  RESULT.permission=true;
});

test('permission decisions are one-shot, fenced and cannot cross workspaces',async t=>{
  const f=await fixture(t),source=await f.ingest('Source.'),r=await f.recipient([source],['search','read_source','create_document','request_permission']);
  const requestId=randomUUID();
  await r.call({action:'request_permission',op_id:requestId,need:'read_document',reason:'Need to read the existing plan document.'});
  // A stale generation is refused, so an old dialog cannot approve a re-prepared channel.
  assert.equal((await f.ownerTry('approve_permission',{recipient_id:r.recipient_id,request_id:requestId,expected_generation:99})).code,'stale_resource');
  const record=(await f.owner('list',{})).recipients.find(x=>x.recipient_id===r.recipient_id);
  assert.equal((await f.ownerTry('approve_permission',{recipient_id:r.recipient_id,request_id:requestId},other)).code,'permission_denied');
  await f.owner('approve_permission',{recipient_id:r.recipient_id,request_id:requestId,expected_generation:record.generation});
  // Re-deciding an already-approved request fails; decisions are not reversible.
  const after=(await f.owner('list',{})).recipients.find(x=>x.recipient_id===r.recipient_id);
  assert.equal((await f.ownerTry('deny_permission',{recipient_id:r.recipient_id,request_id:requestId,expected_generation:after.generation})).code,'invalid_request');
  assert.equal((await f.ownerTry('approve_permission',{recipient_id:r.recipient_id,request_id:randomUUID(),expected_generation:after.generation})).code,'invalid_request');
  RESULT.decisions_fenced=true;
});

test('a capability with no delegated implementation grants nothing',async t=>{
  const f=await fixture(t),source=await f.ingest('Source.'),r=await f.recipient([source],['search','read_source','create_document','request_permission']);
  const raised=await r.call({action:'request_permission',op_id:randomUUID(),need:'query_data',reason:'Need to total supplier cost from the manifest CSV.'});
  assert.equal(raised.verb_needed,null,'no delegated verb exists for query execution');
  // The agent is pointed at the supported surface instead of a dead end.
  assert.match(raised.instruction,/Data workbench/);
  const record=(await f.owner('list',{})).recipients.find(x=>x.recipient_id===r.recipient_id);
  const approved=await f.owner('approve_permission',{recipient_id:r.recipient_id,request_id:raised.request.op_id,expected_generation:record.generation});
  assert.deepEqual(approved.grant.verbs,['search','read_source','create_document','request_permission']);
  RESULT.honest_limits=true;
});

test('describe reports granted and available verbs honestly',async t=>{
  const f=await fixture(t),source=await f.ingest('Source.'),r=await f.recipient([source],['search','create_document']);
  const described=await r.call({action:'describe'});
  assert.deepEqual(described.actions,['search','create_document']);
  assert.ok(described.available_verbs.includes('revise_document'),'advertises what approval can unlock');
  assert.equal(described.open.available,false);
  assert.match(described.open.reason,/owner/i);
  RESULT.describe=true;
});

test('read and disclosure budgets stay bounded',async t=>{
  const f=await fixture(t),source=await f.ingest('x'.repeat(50000)),r=await f.recipient([source]);
  const created=await r.call({action:'create_document',op_id:randomUUID(),title:'Board',citations:[],kind:'scene',scene:scene()});
  // A scene larger than the contract bound is refused before any write.
  const big=scene().replace('"gridSize":20','"gridSize":20,"pad":'+'"0",'.repeat(180000)+'"done":1');
  assert.ok(big.length>524288,`scene should exceed the bound, got ${big.length}`);
  // Refused on size before any write: the channel budget and the document bound.
  const refused=await r.call({action:'create_document',op_id:randomUUID(),title:'Too big',citations:[],kind:'scene',scene:big});
  assert.ok(['invalid_request','limit_exceeded'].includes(refused.code),JSON.stringify(refused));
  assert.equal((await f.documents.dispatch({action:'list',workspace_id:ws})).documents.length,1,'no partial write');
  const limited=await r.call({action:'read_document',document_id:created.document_id,length:16});
  assert.equal(limited.result.truncated,true);
  assert.equal(limited.result.text.length,16);
  assert.equal(limited.result.total_characters>16,true);
  RESULT.bounded=true;
});

const RESULT={};
test.after(()=>{if(Object.keys(RESULT).length)console.log('content verb coverage:',JSON.stringify(RESULT));});