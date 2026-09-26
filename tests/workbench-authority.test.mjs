import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData,WORKBENCH_RECORD_KINDS,workbenchExecutionSchemaSql} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {workbenchOwnerRoute} from '../server/workbench-owner-route.mjs';
import {createWorkbenchTerminalSource} from '../server/workbench-terminal-source.mjs';
import {createWorkbenchContext,workbenchContextRequests,workbenchContextSchema,CAPS,CONTEXT_POLICY} from '../server/workbench-context.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-authority-');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime'));
  function workspace(){const id=randomUUID();store.commit(commandIdentity({workspace_id:id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});return id;}
  const ws=workspace(),records=new WorkbenchStore(store),data=new WorkbenchData(store);
  function project(workspaceId=ws){const directory=path.join(root,randomUUID());fs.mkdirSync(directory);const opened=openProjectRoot(directory),identity=opened.identity;opened.close();return records.register(workspaceId,{root:directory,name:'Synthetic',identity});}
  const first=project();
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,store,ws,workspace,records,data,project,first};
}
const denied=(fn,code='permission_denied')=>assert.throws(fn,{code});

function routeHarness({dispatch=async()=>({result:1}),maxBytes}={}){
  const replies=[],calls=[];let implementation=dispatch;
  const route=workbenchOwnerRoute({token:'owner-private-token',port:4318,devOrigins:[],maxBytes,
    reply:(res,status,body)=>{replies.push({status,body});return body;},
    dispatch:async body=>{calls.push(body);return implementation(body);}});
  async function send({method='POST',host='127.0.0.1:4318',origin='http://127.0.0.1:4318',authorization='Bearer owner-private-token',chunks=[Buffer.from('{"action":"list"}')]}={}){
    const req={method,headers:{host,origin,...(authorization===null?{}:{authorization})},async *[Symbol.asyncIterator](){for(const chunk of chunks)yield chunk;}};
    const res={setHeader(){}};
    await route(req,res);return replies.at(-1);
  }
  return {send,calls,replies,setDispatch:fn=>{implementation=fn;}};
}

test('owner route authenticates exact host, origin and bearer before dispatch',async()=>{
  const h=routeHarness();assert.deepEqual(await h.send(),{status:200,body:{result:1,ok:true}});assert.equal(h.calls.length,1);
  for(const input of [{authorization:'Bearer wrong'},{authorization:null},{authorization:'Basic owner-private-token'},
    {authorization:'Bearer owner-private-token!'}, {authorization:'Bearer owner-private-toke'},
    {origin:'http://127.0.0.1:4318.evil'}, {host:'127.0.0.1:4318.evil'}]){
    assert.equal((await h.send(input)).status,403);assert.equal(h.calls.length,1);
  }
  assert.equal((await h.send({method:'GET'})).status,405);assert.equal(h.calls.length,1);
  for(const [host,origin] of [['localhost:4318','http://localhost:4318'],['[::1]:4318','http://[::1]:4318']])assert.equal((await h.send({host,origin})).status,200);
});

test('owner route enforces request and response byte caps and strict UTF-8',async()=>{
  const h=routeHarness({maxBytes:30});
  assert.deepEqual(await h.send({chunks:[Buffer.alloc(31,97)]}),{status:413,body:{ok:false,code:'limit_exceeded',error:'limit_exceeded'}});assert.equal(h.calls.length,0);
  const bytes=Buffer.from('{"text":"€"}');const split=bytes.indexOf(0xe2)+1;
  assert.equal((await h.send({chunks:[bytes.subarray(0,split),bytes.subarray(split)]})).status,200);
  assert.equal(h.calls.at(-1).text,'€');
  assert.deepEqual(await h.send({chunks:[Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d])]}),{status:400,body:{ok:false,code:'invalid_request',error:'invalid_request'}});
  assert.equal(h.calls.length,1);
  h.setDispatch(async()=>({large:'x'.repeat(2*1024*1024)}));assert.equal((await h.send()).status,413);
});

test('owner route maps errors without leaking messages or routine payload logs',async()=>{
  const h=routeHarness();
  for(const [code,status] of [['stale_resource',409],['busy',429],['unsupported',422]]){
    h.setDispatch(async()=>{throw Object.assign(Error('PRIVATE_ERROR'),{code});});
    assert.deepEqual(await h.send(),{status,body:{ok:false,code,error:code}});
  }
  h.setDispatch(async()=>{throw Error('PRIVATE_ERROR');});
  assert.deepEqual(await h.send(),{status:404,body:{ok:false,code:'unavailable',error:'unavailable'}});
  const sentinel=`private-${randomUUID()}`,logged=[];
  const originals=Object.fromEntries(['log','error','warn','info','debug'].map(key=>[key,console[key]]));
  try{
    for(const key of Object.keys(originals))console[key]=(...args)=>logged.push(args);
    h.setDispatch(async()=>{throw Error(sentinel);});
    const response=await h.send({chunks:[Buffer.from(JSON.stringify({private:sentinel}))]});
    assert.deepEqual(response,{status:404,body:{ok:false,code:'unavailable',error:'unavailable'}});
  }finally{Object.assign(console,originals);}
  assert.equal(logged.length,0);assert.ok(!JSON.stringify(h.replies).includes(sentinel));
});

test('context request schema rejects spoofed actors and invented execute/disclose actions before effects',async()=>{
  assert.equal(workbenchContextSchema.oneOf.length,Object.keys(workbenchContextRequests).length);
  for(const schema of Object.values(workbenchContextRequests))assert.equal(schema.additionalProperties,false);
  assert.ok(!('execute' in workbenchContextRequests));assert.ok(!('disclose' in workbenchContextRequests));
  let accesses=0;
  const context=createWorkbenchContext({store:{read(){accesses++;throw Error('store reached');}},records:{project(){accesses++;throw Error('records reached');}},
    data:{create(){accesses++;},get(){accesses++;},list(){accesses++;},update(){accesses++;}}});
  const base={action:'list',workspace_id:randomUUID(),project_id:randomUUID()};
  for(const key of ['actor','controller','capability','grant','text'])await assert.rejects(context.dispatch({...base,[key]:'spoof'}),{code:'invalid_request'});
  for(const action of ['execute','disclose'])await assert.rejects(context.dispatch({...base,action}),{code:'invalid_request'});
  assert.equal(accesses,0);
});

test('terminal source refuses every missing or mismatched authority before observe',async t=>{
  const f=fixture(t),pane=randomUUID(),leaseId=randomUUID(),resource=f.records.resource(f.first.id,`pane:${pane}`,{kind:'terminal',pane_id:pane,state:'linked_metadata_only'});
  const other=f.project(),file=f.records.resource(f.first.id,'file:readme',{kind:'file',path:'readme'});
  const broker={observeCalls:[],statusImpl:null,observeImpl:null,async status(){return this.statusImpl();},async observe(args){this.observeCalls.push(args);return this.observeImpl?this.observeImpl(args):{text:'$ whoami\nmojo\n',observed_at:1234};}};
  const normal=()=>({resources:[{pane_id:pane,workspace_id:f.ws,resource_id:resource.id}],leases:[{lease_id:leaseId,scope:'observe',state:'active',pane_id:pane,resource_id:resource.id}]});
  broker.statusImpl=normal;
  const source=createWorkbenchTerminalSource({store:f.store,records:f.records,broker});
  const args={workspace_id:f.ws,project_id:f.first.id,resource_id:resource.id,lease_id:leaseId};
  for(const change of [{project_id:other.id},{resource_id:randomUUID()},{resource_id:file.id},{lease_id:randomUUID()}]){
    await assert.rejects(source({...args,...change}),{code:'permission_denied'});assert.equal(broker.observeCalls.length,0);
  }
  for(const mutate of [s=>s.leases[0].state='revoked',s=>s.leases[0].state='expired',
    ...['control','model','write'].map(scope=>s=>s.leases[0].scope=scope),
    s=>s.leases[0].pane_id=randomUUID(),s=>s.leases[0].resource_id=randomUUID(),
    s=>s.resources=[],s=>s.resources[0].workspace_id=randomUUID()]){
    broker.statusImpl=()=>{const s=normal();mutate(s);return s;};
    await assert.rejects(source(args),{code:'permission_denied'});assert.equal(broker.observeCalls.length,0);
  }
  broker.statusImpl=normal;
  await assert.rejects(createWorkbenchTerminalSource({store:f.store,records:f.records,broker:null})(args),{code:'unavailable'});
  assert.equal(broker.observeCalls.length,0);
  const result=await source(args);
  assert.deepEqual(broker.observeCalls,[{workspaceId:f.ws,leaseId,baseRevision:f.store.read(f.ws).revision,lines:2000}]);
  assert.equal(result.text,'$ whoami\nmojo\n');assert.equal(result.hash,hash(result.text));assert.equal(result.resource_id,resource.id);
  assert.equal(result.captured_at,1234);assert.equal(result.truncated,true);assert.equal(result.provenance.kind,'terminal');
  assert.deepEqual(result.provenance.bounds,{max_lines:2000,max_bytes:65536});assert.match(result.provenance.note,/not disclosure consent/i);
  for(const text of ['x'.repeat(65536),'x'.repeat(65537),'€'.repeat(21846)]){
    broker.observeImpl=async()=>({text,observed_at:1234});
    if(Buffer.byteLength(text)<=65536)assert.equal((await source(args)).text,text);
    else await assert.rejects(source(args),{code:'limit_exceeded'});
  }
  const sentinel=`terminal-private-${randomUUID()}`,logged=[];const original=console.error;
  try{
    console.error=(...values)=>logged.push(values);
    broker.observeImpl=async()=>{f.records.revoke(f.ws,f.first.id,f.records.project(f.ws,f.first.id).generation);return {text:sentinel,observed_at:1234};};
    await assert.rejects(source(args),error=>{assert.ok(['permission_denied','stale_resource'].includes(error.code));assert.ok(!String(error).includes(sentinel));return true;});
  }finally{console.error=original;}
  assert.ok(!JSON.stringify(logged).includes(sentinel));
  assert.equal(broker.observeCalls.length,5);
  await assert.rejects(source(args),{code:'permission_denied'});assert.equal(broker.observeCalls.length,5);
});

test('serial gate fences lanes, legacy uncertainty and stale releases without approval APIs',()=>{
  const gate=createWorkbenchGate();assert.deepEqual(gate.status(),{agent:false,job:false,legacy:{enabled:false,active:0,uncertain:0,pending:0}});
  for(const name of ['approve','grant','disclose','release','reset'])assert.equal(gate[name],undefined);
  const agent=gate.claim('agent','a');denied(()=>gate.claim('agent','b'),'busy');const job=gate.claim('job','j');denied(()=>gate.claim('job','k'),'busy');
  denied(()=>gate.claim('legacy-agent','old'),'busy');assert.deepEqual([gate.status().agent,gate.status().job],[true,true]);
  agent();agent();const newer=gate.claim('agent','new');agent();denied(()=>gate.claim('agent','third'),'busy');newer();job();
  denied(()=>gate.claim('invalid','id'),'invalid_request');
  let legacy={enabled:false,active:0,uncertain:1,pending:2};gate.setLegacyStatus(()=>legacy);
  for(const lane of ['agent','job'])denied(()=>gate.claim(lane,'id'),'busy');
  assert.equal(gate.legacyStatus().pending,2);assert.equal(gate.status().legacy.uncertain,1);
  legacy={...legacy,uncertain:0,enabled:true};for(const lane of ['agent','job'])denied(()=>gate.claim(lane,'id'),'busy');
  legacy={...legacy,enabled:false,active:1};for(const lane of ['agent','job'])denied(()=>gate.claim(lane,'id'),'busy');
  const old=gate.claim('legacy-agent','old');assert.equal(gate.status().agent,true);old();old();
  legacy={...legacy,active:0};const running=gate.claim('job','job');denied(()=>gate.claim('legacy-agent','old'),'busy');running();
  assert.equal(gate.legacyStatus().pending,2);
});

test('SQLite data enforces scope, immutable identity, CAS, kind allow-list and isolation',t=>{
  const f=fixture(t),otherWs=f.workspace(),foreign=f.project(otherWs),sibling=f.project(),scope={workspace_id:f.ws,project_id:f.first.id};
  const record=f.data.create('tasks',{...scope,private:'private fact'});
  for(const [ws,project] of [[otherWs,foreign.id],[otherWs,f.first.id],[f.ws,sibling.id]]){
    denied(()=>f.data.get('tasks',ws,project,record.id));
    denied(()=>f.data.update('tasks',ws,project,record.id,1,{private:'stolen'}));
  }
  denied(()=>f.data.list('tasks',otherWs,f.first.id));
  assert.deepEqual(f.data.list('tasks',otherWs,foreign.id),[]);
  assert.deepEqual(f.data.list('tasks',f.ws,sibling.id),[]);
  f.data.create('tasks',{workspace_id:f.ws,project_id:sibling.id,private:'other'});
  assert.deepEqual(f.data.list('tasks',f.ws,f.first.id).map(row=>row.id),[record.id]);
  for(const field of ['id','version','revision','created_at','updated_at'])denied(()=>f.data.create('tasks',{...scope,[field]:'forged'}),'invalid_request');
  for(const field of ['id','version','revision','workspace_id','project_id','created_at','updated_at'])denied(()=>f.data.update('tasks',f.ws,f.first.id,record.id,1,{[field]:'forged'}),'invalid_request');
  denied(()=>f.data.update('tasks',f.ws,f.first.id,record.id,2,{private:'bad'}),'stale_resource');
  const updated=f.data.update('tasks',f.ws,f.first.id,record.id,1,{private:'changed'});
  assert.equal(updated.id,record.id);assert.equal(updated.revision,2);assert.equal(f.data.get('tasks',f.ws,f.first.id,record.id).private,'changed');
  for(const kind of ['grants','tasks; DROP TABLE workspaces']){
    assert.ok(!WORKBENCH_RECORD_KINDS.includes(kind));denied(()=>f.data.list(kind,f.ws,f.first.id),'invalid_request');
  }
  for(const kind of ['approvals','grants','previews','tokens','sessions']){
    assert.ok(!WORKBENCH_RECORD_KINDS.includes(kind));assert.doesNotMatch(workbenchExecutionSchemaSql,new RegExp(`CREATE TABLE[^;]*wb_${kind}\\b`,'i'));
  }
});

test('SQLite task count and byte caps fail closed without partial rows',t=>{
  const f=fixture(t),scope={workspace_id:f.ws,project_id:f.first.id};
  denied(()=>f.data.create('tasks',{...scope,body:'x'.repeat(512*1024)}),'limit_exceeded');
  const circular={};circular.self=circular;
  denied(()=>f.data.create('tasks',{...scope,body:circular}),'invalid_request');
  assert.equal(f.data.list('tasks',f.ws,f.first.id).length,0);
  for(let i=0;i<200;i++)f.data.create('tasks',{...scope,index:i});
  denied(()=>f.data.create('tasks',{...scope,index:200}),'limit_exceeded');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM wb_tasks WHERE project_id=?').get(f.first.id).n,200);
});

test('context metadata excludes private bytes; backup retains facts but never restores approval authority',async t=>{
  const f=fixture(t),sentinel=`PRIVATE_CONTEXT_${randomUUID()}`,file=path.join(f.first.root,'secret.txt');
  fs.writeFileSync(file,`${sentinel}\n`);
  const resource=f.records.resource(f.first.id,'file:secret.txt',{kind:'file',path:'secret.txt',hash:hash(fs.readFileSync(file)),bytes:fs.statSync(file).size,state:'available'});
  const pane=randomUUID(),recipient={pane_id:pane,profile_id:'default',session_id:'orbit-fixture',binding_revision:1,config_generation:'a'.repeat(64)};
  const bound={...recipient,trusted_host:true,sandbox:false,destination:{trust:'owner_configured_gateway',known:true}};
  const hermes={
    async readBinding(){return {...bound};},async prepareRecipient(){return {...bound};},async probe(){return {};},
    async prepareSubmission({input}){return {recipient:{...recipient},caps:{},payload:{input}};},
    async dispatchExact(){return {run_id:'run_fixture',status:'running'};},async submit(){return {run_id:'run_fixture',status:'running'};},
    async status(){return {status:'running',output:''};},async stop(){return {status:'stopping'};},panePending(){return false;},markPending(){},
  };
  const create=(store,data,records)=>createWorkbenchContext({store,data,records,hermes,gate:createWorkbenchGate()});
  const first=create(f.store,f.data,f.records),scope={workspace_id:f.ws,project_id:f.first.id};
  const captured=await first.dispatch({...scope,action:'capture',source:{kind:'file',resource_id:resource.id,start_line:1,end_line:1,expected_hash:hash(fs.readFileSync(file))}});
  assert.equal(captured.context.snapshot.text,undefined);assert.equal(captured.context.snapshot.hash,hash(sentinel));
  const listed=await first.dispatch({...scope,action:'list'});assert.equal(listed.contexts[0].snapshot.text,undefined);
  assert.ok(!JSON.stringify(captured).includes(sentinel));assert.ok(!JSON.stringify(listed).includes(sentinel));
  assert.ok(!JSON.stringify(f.store.read(f.ws)).includes(sentinel));
  for(const table of ['outbox','receipts','events','revisions','checkpoints']){
    if(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      for(const row of f.store.db.prepare(`SELECT * FROM ${table}`).all())assert.ok(!JSON.stringify(row).includes(sentinel));
  }
  const preview=await first.dispatch({...scope,action:'preview',context_id:captured.context.id,recipient:{pane_id:pane}});
  assert.equal(preview.text,sentinel);assert.equal(preview.policy,CONTEXT_POLICY);assert.ok(CAPS.previewTtlMs>0);
  const approval=await first.dispatch({...scope,action:'approve',preview_id:preview.preview_id});
  assert.ok(!JSON.stringify(approval).includes(sentinel));
  const second=create(f.store,new WorkbenchData(f.store),new WorkbenchStore(f.store));
  await assert.rejects(second.dispatch({...scope,action:'approve',preview_id:preview.preview_id}),{code:'expired'});
  await assert.rejects(second.dispatch({...scope,action:'share',preview_id:preview.preview_id,approval_id:approval.approval_id}),{code:'expired'});
  assert.equal((await second.dispatch({...scope,action:'list'})).contexts[0].id,captured.context.id);
  assert.equal(f.data.get('contexts',f.ws,f.first.id,captured.context.id).snapshot.text,sentinel);
  const backup=path.join(f.root,'backup.sqlite');await f.store.backup(backup);
  const copyRoot=path.join(f.root,'restored');fs.mkdirSync(copyRoot);fs.copyFileSync(backup,path.join(copyRoot,'workspace.sqlite'));
  const restored=new SqliteWorkspaceStore(copyRoot);
  try{
    const restoredData=new WorkbenchData(restored);
    assert.equal(restoredData.get('contexts',f.ws,f.first.id,captured.context.id).snapshot.text,sentinel);
    const fresh=create(restored,restoredData,new WorkbenchStore(restored));
    await assert.rejects(fresh.dispatch({...scope,action:'approve',preview_id:preview.preview_id}),{code:'expired'});
    await assert.rejects(fresh.dispatch({...scope,action:'share',preview_id:preview.preview_id,approval_id:approval.approval_id}),{code:'expired'});
  }finally{restored.close();}
  const shared=await first.dispatch({...scope,action:'share',preview_id:preview.preview_id,approval_id:approval.approval_id});
  assert.equal(shared.submission.input,undefined);
  assert.ok(!JSON.stringify(shared).includes(sentinel));
  assert.equal(f.data.list('submissions',f.ws,f.first.id)[0].input.includes(sentinel),true);
  assert.ok(!JSON.stringify(f.store.read(f.ws)).includes(sentinel));
  for(const table of ['outbox','receipts','events']){
    if(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      for(const row of f.store.db.prepare(`SELECT * FROM ${table}`).all())assert.ok(!JSON.stringify(row).includes(sentinel));
  }
});
