import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createAgentHandler} from '../server/agent.mjs';
import {createResourceDelegation} from '../server/resource-delegation.mjs';
import {createKnowledgeSearch} from '../server/knowledge-index.mjs';
import {createDocumentsService} from '../server/documents-store.mjs';
import {technologyOwnerRoute} from '../server/technology-owner-route.mjs';
const ws='11111111-1111-1111-1111-111111111111',pane='22222222-2222-2222-2222-222222222222',otherPane='33333333-3333-3333-3333-333333333333';
const session=`orbit-${randomUUID()}`,otherSession=`orbit-${randomUUID()}`,token='synthetic-normal-resource-token-'.repeat(2);
const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
const close=s=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();});
export async function normalFixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/normal-res-'),runs=new Map(),submissions=[];let counter=0,runReadHook=async()=>{};
  const gateway=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const url=req.url.replace(/^\/other/,'');const profile=req.url.startsWith('/other')?'other':'default';
    assert.equal(req.headers.authorization,`Bearer synthetic-${profile}-key`);
    if(url==='/v1/capabilities')return reply(res,200,{object:'hermes.api_server.capabilities',platform:'hermes-agent',runtime:{mode:'server_agent',tool_execution:'server'},features:{run_submission:true,run_status:true,run_stop:true}});
    if(url.includes('/messages'))return reply(res,200,{data:[{role:'user',content:'Earlier'},{role:'assistant',content:'Ready'}]});
    if(url.startsWith('/api/sessions/'))return reply(res,200,{id:decodeURIComponent(url.split('/')[3])});
    if(url==='/v1/runs'&&req.method==='POST'){
      const body=JSON.parse(raw),run_id=`run_resource_${++counter}`;submissions.push(body);
      runs.set(run_id,{run_id,session_id:body.session_id,status:'running',profile});return reply(res,202,{run_id,status:'running'});
    }
    const run=runs.get(url.split('/')[3]);if(!run||run.profile!==profile)return reply(res,404,{});await runReadHook();return reply(res,200,run);
  });await listen(gateway);
  let handler,grants,grantRoute;
  const host=http.createServer((req,res)=>req.url==='/api/resource-grants'?grantRoute(req,res):handler(req,res));await listen(host);
  const origin=`http://127.0.0.1:${host.address().port}`,gatewayOrigin=`http://127.0.0.1:${gateway.address().port}`;
  let panes=[pane,otherPane];
  const workspaceRead=()=>({state:{monitors:panes.map(id=>({layout:{type:'pane',pane:{id,kind:'agent'}}}))}});
  handler=createAgentHandler({token,port:host.address().port,devOrigins:[],reply,runtimeDirectory:root,workspaceRead,workspaceContext:()=>'',apiUrl:'',apiKey:'',profilesJson:JSON.stringify([{id:'default',label:'Main model',apiUrl:gatewayOrigin,apiKey:'synthetic-default-key'},{id:'other',label:'Other model',apiUrl:gatewayOrigin+'/other',apiKey:'synthetic-other-key'}]),onNormalAccepted:r=>grants.normalAccepted(r)});
  const knowledge=createKnowledgeSearch({root,workspaceRead}),documents=createDocumentsService({root,workspaceRead});
  grants=await createResourceDelegation({root,workspaceRead,knowledge,documents,normalBindings:handler.resourceBindings,normalProfiles:{default:'',other:'other'}});
  grantRoute=technologyOwnerRoute({token,port:host.address().port,devOrigins:[],reply,dispatch:b=>grants.dispatch(b)});
  t.after(async()=>{await grants.close();await knowledge.close();await close(host);await close(gateway);fs.rmSync(root,{recursive:true,force:true});});
  async function request(action,fields={},route='/api/agent'){
    const response=await fetch(origin+route,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:ws,...(route==='/api/agent'?{pane_id:pane,profile_id:'default',session_id:session,expected_binding_revision:0}:{}),action,...fields})});return {status:response.status,body:await response.json()};
  }
  assert.equal((await request('shared_chat',{initial:{session,messages:[]}})).status,200);
  assert.equal((await request('shared_chat',{pane_id:otherPane,session_id:otherSession,initial:{session:otherSession,messages:[]}})).status,200);
  const source=await knowledge.dispatch({action:'ingest_text',workspace_id:ws,kind:'owner_text',title:'Granted astronomy',text:'Mars has two moons.'});
  await knowledge.dispatch({action:'ingest_text',workspace_id:ws,kind:'owner_text',title:'Excluded private title',text:'SECRET OTHER SOURCE'});
  const owner=(action,fields={})=>request(action,fields,'/api/resource-grants');
  async function grant(pane_id=pane,expected_binding_revision=0){
    const prepared=await owner('prepare_normal',{pane_id,expected_binding_revision});assert.equal(prepared.status,200,JSON.stringify(prepared.body));
    const granted=await owner('grant',{recipient_id:prepared.body.recipient_id,source_ids:[source.source_id],verbs:['search','read_source','create_document']});assert.equal(granted.status,200);return prepared.body;
  }
  function channel(run_id,profile='default'){
    const filename=path.join(root,'resource-delegation','normal',profile,`${run_id}.json`);const c=JSON.parse(fs.readFileSync(filename));let sequence=100;
    return {filename,call(body){return new Promise((resolve,reject)=>{const raw=Buffer.from(JSON.stringify(body)),seq=String(++sequence),mac=createHmac('sha256',c.secret).update(`${seq}\n`).update(raw).digest('hex');const req=http.request({socketPath:c.socket,path:'/tool',method:'POST',headers:{'X-Orbit-Recipient':c.recipient_id,'X-Orbit-Sequence':seq,'X-Orbit-Mac':mac}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve(JSON.parse(text)));});req.on('error',reject);req.end(raw);});}};
  }
  return {root,origin,request,owner,grant,channel,runs,submissions,source,documents,handler,setRunReadHook:fn=>{runReadHook=fn;},removePane:()=>{panes=[otherPane];}};
}
test('Normal grant binds next accepted receipted run, not another session/run; revoke and switch fence effects',async t=>{
  const f=await normalFixture(t),grant=await f.grant();
  const listed=(await f.owner('list')).body;assert.equal(listed.normal_recipients.length,2);assert.equal(listed.recipients[0].state,'awaiting_next_normal_run');
  const other=await f.request('start',{pane_id:otherPane,session_id:otherSession,input:'Other conversation'});assert.equal(other.status,202);
  assert.ok(!fs.existsSync(path.join(f.root,'resource-delegation/normal/default',`${other.body.run_id}.json`)));
  const accepted=await f.request('start',{input:'Use granted astronomy to save a brief'});assert.equal(accepted.status,202,JSON.stringify(accepted.body));
  assert.ok(!JSON.stringify(f.submissions).includes('secret'));assert.ok(!JSON.stringify(f.submissions).includes('resource-delegation'));
  const channel=f.channel(accepted.body.run_id),found=await channel.call({action:'search',query:'Mars SECRET'});assert.equal(found.ok,true);assert.equal(found.result.results.length,1);assert.ok(!JSON.stringify(found).includes('Excluded private'));
  const request={action:'create_document',op_id:randomUUID(),title:'Normal brief',text:'Mars has two moons.',citations:[{source_id:f.source.source_id,content_sha256:f.source.content_sha256,char_start:0,char_end:19}]};
  const saved=await channel.call(request);assert.equal(saved.saved,true);assert.deepEqual(await channel.call(request),saved);
  f.runs.get(accepted.body.run_id).status='completed';
  assert.equal((await channel.call({action:'read_source',source_id:f.source.source_id})).code,'permission_denied');
  await f.request('status',{run_id:accepted.body.run_id});
  const switched=await f.request('select_session',{target_profile_id:'other',target_session_id:`orbit-${randomUUID()}`});assert.equal(switched.status,200,JSON.stringify(switched.body));
  f.runs.get(accepted.body.run_id).status='running';assert.equal((await channel.call(request)).code,'stale_resource');
  assert.equal((await f.owner('prepare_normal',{pane_id:pane,expected_binding_revision:0})).body.code,'stale_resource');
  await f.owner('revoke',{recipient_id:grant.recipient_id});assert.ok(!fs.existsSync(channel.filename));
  assert.equal((await f.documents.dispatch({action:'list',workspace_id:ws})).documents.length,1);
});
test('Normal receipt mismatch and pane disposal revoke authority before source disclosure',async t=>{
  const f=await normalFixture(t);await f.grant();const run=await f.request('start',{input:'Read'}),channel=f.channel(run.body.run_id);
  const shared=path.join(f.root,'shared-chats',`${ws}.${pane}.json`),binding=JSON.parse(fs.readFileSync(shared));
  const file=path.join(f.root,'ordinary-submissions',`${binding.ordinary_submission_id}.json`),record=JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file,JSON.stringify({...record,state:'submission_unknown'}));assert.equal((await channel.call({action:'describe'})).code,'permission_denied');
  fs.writeFileSync(file,JSON.stringify(record));f.removePane();assert.equal((await channel.call({action:'search',query:'Mars'})).ok,false);
});
test('a subsequent Normal turn in the same conversation cannot inherit the previous run grant',async t=>{
  const f=await normalFixture(t);await f.grant();const first=await f.request('start',{input:'First turn'}),channel=f.channel(first.body.run_id);
  assert.equal((await channel.call({action:'describe'})).ok,true);
  f.runs.get(first.body.run_id).status='completed';assert.equal((await f.request('status',{run_id:first.body.run_id})).status,200);
  const second=await f.request('start',{input:'Second turn without a new grant'});assert.equal(second.status,202);
  assert.ok(!fs.existsSync(path.join(f.root,'resource-delegation/normal/default',`${second.body.run_id}.json`)));
  f.runs.get(first.body.run_id).status='running'; // Even a stale upstream status cannot defeat the current receipt fence.
  assert.equal((await channel.call({action:'read_source',source_id:f.source.source_id})).code,'permission_denied');
});
test('revoking while gateway status authorization awaits prevents subsequent source disclosure',async t=>{
  const f=await normalFixture(t),grant=await f.grant(),accepted=await f.request('start',{input:'Read source'}),channel=f.channel(accepted.body.run_id);
  let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  f.setRunReadHook(async()=>{entered();await hold;});
  const reading=channel.call({action:'read_source',source_id:f.source.source_id});await ready;
  await f.owner('revoke',{recipient_id:grant.recipient_id});release();const result=await reading;
  assert.equal(result.code,'revoked');assert.equal(result.result,undefined);
});
test('actual pinned gateway context and registry execute Normal source-to-brief without a provider',{skip:!process.env.HERMES_PINNED_PYTHON||!process.env.HERMES_PINNED_SOURCE},async t=>{
  const f=await normalFixture(t);const grant=await f.grant();const accepted=await f.request('start',{input:'Cited brief'});assert.equal(accepted.status,202);
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.env.HERMES_PINNED_PYTHON,['tests/normal-resources-pinned.py'],{cwd:process.cwd(),env:{PATH:process.env.PATH,HOME:path.join(f.root,'home'),HERMES_HOME:path.join(f.root,'home'),PYTHONPATH:process.env.HERMES_PINNED_SOURCE,PYTHONDONTWRITEBYTECODE:'1'}});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err+out)));child.stdin.end(JSON.stringify({directory:path.join(f.root,'resource-delegation/normal/default'),run_id:accepted.body.run_id,session_id:session,source_id:f.source.source_id,other_session:otherSession,op_id:randomUUID()}));
  });
  assert.equal(result.saved.saved,true);assert.equal(result.saved.opened,false);assert.equal(result.concurrent_isolation,true);assert.equal(result.no_env_fallback,true);assert.equal(result.no_child_inheritance,true);
  const doc=await f.documents.dispatch({action:'read',workspace_id:ws,document_id:result.saved.document_id});assert.match(doc.data.content,/Mars has two moons/);assert.match(doc.data.content,new RegExp(f.source.source_id));
  const retained=f.channel(accepted.body.run_id);await f.owner('revoke',{recipient_id:grant.recipient_id});
  assert.equal((await retained.call({action:'read_source',source_id:f.source.source_id})).code,'revoked');
});
