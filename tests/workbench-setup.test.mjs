import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {captureProject} from '../server/project-files.mjs';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchNative} from '../server/workbench-native.mjs';
import {createWorkbenchSetup} from '../server/workbench-setup.mjs';
import {validateSetup,validateSetupProposal} from '../contracts/workbench-setup-v1.mjs';
import {HERMES_NATIVE_CONTRACT} from '../contracts/workbench-native-v1.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/wsetup-'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'sum.test.mjs'),"import test from 'node:test'; import assert from 'node:assert/strict'; test('sum',()=>assert.equal(1+1,2));\n");
  const store=new SqliteWorkspaceStore(path.join(root,'r')),workspace_id=randomUUID(),pane_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Setup fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const data=new WorkbenchData(store),records=new WorkbenchStore(store),opened=openProjectRoot(projectRoot),project=records.register(workspace_id,{root:projectRoot,name:'Setup fixture',identity:opened.identity});opened.close();
  const gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate});let starts=0,revision=1,generation=1;
  const hermes={readBinding:async()=>({trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'setup-session',binding_revision:revision,config_generation:generation,native_runtime:{kind:'local-pinned',commit:HERMES_NATIVE_CONTRACT.commit,model:'fixture',destination:'loopback configured model endpoint',configuration_hash:'0'.repeat(64)}}),startNative:async config=>{starts++;await config.authorize();return {completion:new Promise(()=>{})};},stopNative:async()=>{},quarantineNative:()=>{},acknowledgeNativeUnknown:()=>{}};
  const native=createWorkbenchNative({store,records,data,execution,hermes});
  const deps={store,records,data,execution,hermes,native,gate};let setup=createWorkbenchSetup(deps);
  const base={workspace_id,pane_id,expected_binding_revision:1},call=(action,fields={})=>setup.dispatch({...base,action,...fields});
  async function draft(){return (await call('draft',{op_id:randomUUID(),goal:'Make sum correct',project_id:project.id})).draft;}
  async function preview(d){return call('preview',{draft_id:d.id,op_id:randomUUID()});}
  async function prepare(){const d=await draft(),p=await preview(d);return (await call('prepare',{preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()})).draft;}
  async function launchPreview(d){return call('launch_preview',{draft_id:d.id,budget:{calls:4,checks:1,duration_ms:60000,repair_iterations:1}});}
  t.after(()=>{native.close();execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {...deps,root,projectRoot,project,base,call,draft,preview,prepare,launchPreview,get setup(){return setup;},restart:()=>setup=createWorkbenchSetup(deps),starts:()=>starts,bumpBinding:()=>revision++,bumpConfig:()=>generation++,rows:kind=>data.list(kind,workspace_id,project.id)};
}

test('strict separate contracts reject model authority and unsupported actions',()=>{
  const proposal={workspace_id:randomUUID(),op_id:randomUUID(),goal:'Improve tests'};
  assert.equal(validateSetupProposal(proposal),true);
  for(const field of ['pane_id','profile_id','session_id','actor','action','expected_binding_revision','preview_id'])assert.equal(validateSetupProposal({...proposal,[field]:randomUUID()}),false);
  assert.equal(validateSetup({...proposal,action:'draft',project_id:randomUUID(),pane_id:randomUUID(),expected_binding_revision:0}),true);
  assert.equal(validateSetup({...proposal,action:'start'}),false);
});

test('workspace proposal is bounded private metadata, available while busy, with exact-key conflict',async t=>{
  const f=fixture(t),release=f.gate.claim('agent','chat');
  f.hermes.readBinding=async()=>{throw Error('proposal must not resolve binding');};
  f.records.project=()=>{throw Error('proposal must not read project');};
  const request={workspace_id:f.base.workspace_id,op_id:randomUUID(),goal:'Private proposed goal',project_id:randomUUID()};
  const first=await f.setup.propose(request);f.restart();assert.deepEqual(await f.setup.propose(request),first);assert.deepEqual(Object.keys(first),['id']);
  await assert.rejects(f.setup.propose({...request,goal:'different'}),{code:'conflict'});
  assert.equal(JSON.stringify(f.store.read(f.base.workspace_id)).includes(request.goal),false);
  assert.equal(fs.statSync(path.join(f.store.root,'workbench-setup',`${f.base.workspace_id}.json`)).mode&0o777,0o600);release();
});

test('prepare creates real candidate and exact goal-only context without model/check execution; duplicate survives restart',async t=>{
  const f=fixture(t),body={op_id:randomUUID(),goal:'Repair sum',project_id:f.project.id};
  const d=(await f.call('draft',body)).draft;
  assert.deepEqual((await f.call('draft',body)).draft,d);
  await assert.rejects(f.call('draft',{...body,goal:'changed'}),{code:'conflict'});
  const p=await f.preview(d),req={preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  assert.equal(p.effects.execution,false);assert.equal(p.effects.disclosure,false);assert.deepEqual(p.check.required_test_files,['sum.test.mjs']);
  const prepared=await f.call('prepare',req);f.restart();assert.deepEqual(await f.call('prepare',req),prepared);
  for(const kind of ['tasks','candidates','attempts','contexts'])assert.equal(f.rows(kind).length,1);
  assert.equal(f.starts(),0);assert.equal(f.rows('jobs').length,0);assert.equal(f.rows('grants').length,0);
  assert.equal(fs.existsSync(path.join(f.rows('candidates')[0].root,'sum.test.mjs')),true);
  assert.deepEqual(JSON.parse(f.rows('contexts')[0].snapshot.text),{goal:'Repair sum',acceptance_statement:'Repair sum'});
  assert.equal(JSON.stringify(f.store.read(f.base.workspace_id)).includes('Repair sum'),false);
  await assert.rejects(f.call('prepare',{...req,preview_digest:'0'.repeat(64)}),{code:'conflict'});
});

test('lost intermediate step response resumes authoritative receipts, not duplicate records',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.preview(d),req={preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  const original=f.execution.setupStep;let fail=true;
  f.execution.setupStep=body=>{const r=original(body);if(body.step==='candidate'&&fail){fail=false;throw Object.assign(Error('lost response'),{code:'unavailable'});}return r;};
  await assert.rejects(f.call('prepare',req),{code:'unavailable'});assert.equal(f.rows('candidates').length,1);
  f.restart();const result=await f.call('prepare',req);assert.equal(result.draft.status,'prepared');
  for(const kind of ['tasks','candidates','attempts','contexts'])assert.equal(f.rows(kind).length,1);
});

test('partial SQLite failure rolls back candidate link and records, then safely resumes',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.preview(d),req={preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  const create=f.data.create.bind(f.data);let fail=true;
  f.data.create=(kind,fields)=>{if(kind==='attempts'&&fail){fail=false;throw Object.assign(Error('disk'),{code:'unavailable'});}return create(kind,fields);};
  await assert.rejects(f.call('prepare',req),{code:'unavailable'});assert.equal(f.rows('tasks').length,1);assert.equal(f.rows('candidates').length,1);assert.equal(f.rows('attempts').length,0);
  f.restart();assert.equal((await f.call('prepare',req)).draft.status,'prepared');assert.equal(f.rows('candidates').length,1);
});

for(const change of ['source','binding','config','project','policy'])test(`frozen setup refuses ${change} drift before effects`,async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.preview(d);
  if(change==='source')fs.appendFileSync(path.join(f.projectRoot,'sum.test.mjs'),'// changed\n');
  if(change==='binding')f.bumpBinding();
  if(change==='config')f.bumpConfig();
  if(change==='project')f.records.revoke(f.base.workspace_id,f.project.id,f.project.generation);
  if(change==='policy'){const read=f.store.read.bind(f.store);f.store.read=id=>({...read(id),recovery_policy:{held:false,generation:123}});}
  await assert.rejects(f.call('prepare',{preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()}));
  assert.equal(f.rows('tasks').length,0);assert.equal(f.starts(),0);
});

test('state shows current-bound drafts and project names only; unsupported checks fail closed',async t=>{
  const f=fixture(t);await f.draft();let state=await f.call('state');assert.equal(state.drafts.length,1);assert.deepEqual(state.projects,[{id:f.project.id,name:'Setup fixture'}]);
  f.bumpConfig();state=await f.call('state');assert.equal(state.drafts.length,0);
  for(const check_definition_id of ['host-regression','shell','unknown'])await assert.rejects(f.call('draft',{op_id:randomUUID(),goal:'Make tests pass',project_id:f.project.id,check_definition_id}),{code:'unsupported'});
  fs.unlinkSync(path.join(f.projectRoot,'sum.test.mjs'));
  await assert.rejects(f.call('draft',{op_id:randomUUID(),goal:'Make tests pass',project_id:f.project.id}),{code:'unsupported'});
});

test('only exact owner launch starts native; lost approve/start responses reconcile one grant and one call',async t=>{
  const f=fixture(t),d=await f.prepare(),p=await f.launchPreview(d),req={draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  assert.equal(f.starts(),0);
  const dispatch=f.native.dispatch;let loseApprove=true,loseStart=true;
  f.native.dispatch=async (body,options)=>{const r=await dispatch(body,options);if(body.action==='approve'&&loseApprove){loseApprove=false;throw Object.assign(Error('lost approval'),{code:'unavailable'});}if(body.action==='start'&&loseStart){loseStart=false;throw Object.assign(Error('lost start'),{code:'unavailable'});}return r;};
  await assert.rejects(f.call('launch',req),{code:'unavailable'});assert.equal(f.starts(),1);assert.equal(f.rows('grants').length,1);
  f.restart();const recovered=await f.call('launch',req);assert.equal(recovered.grant.status,'running');assert.equal(recovered.draft.grant_id,recovered.grant.id);
  assert.equal(f.starts(),1);assert.equal(f.rows('grants').length,1);
  await assert.rejects(f.call('launch',{...req,op_id:randomUUID()}),{code:'conflict'});
});

test('launch refuses busy lanes and never recreates unknown approval',async t=>{
  const f=fixture(t),d=await f.prepare(),release=f.gate.claim('agent','chat');
  await assert.rejects(f.launchPreview(d),{code:'busy'});release();
  const p=await f.launchPreview(d),req={draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  const dispatch=f.native.dispatch;let approves=0;
  f.native.dispatch=async (body,options)=>{if(body.action==='approve'){approves++;throw Object.assign(Error('unknown approval outcome'),{code:'unavailable'});}return dispatch(body,options);};
  await assert.rejects(f.call('launch',req),{code:'unavailable'});f.restart();await assert.rejects(f.call('launch',req),{code:'outcome_unknown'});assert.equal(approves,1);assert.equal(f.starts(),0);
  assert.equal((await f.call('state')).drafts[0].status,'launch_unknown');
});

test('three durable waiting intentions survive reload, quarantine and cancellation and require fresh owner review',async t=>{
  const f=fixture(t),drafts=[];for(let i=0;i<3;i++)drafts.push(await f.prepare());
  const release=f.gate.claim('agent','busy'),budget={calls:4,checks:1,duration_ms:60000};
  const requests=drafts.map(d=>({draft_id:d.id,op_id:randomUUID(),deadline:Date.now()+60000,budget})),intents=[];
  for(const request of requests)intents.push((await f.call('wait',request)).intent);
  f.restart();assert.deepEqual((await f.call('wait',requests[0])).intent,intents[0]);
  await assert.rejects(f.call('wait',{...requests[0],deadline:requests[0].deadline+1}),{code:'conflict'});
  let state=await f.call('state');assert.deepEqual(state.waiting_intents.map(i=>i.id),intents.map(i=>i.id));assert.deepEqual(state.waiting_intents.map(i=>i.position),[1,2,3]);assert.ok(state.waiting_intents.every(i=>i.state==='waiting_lane'));
  const cancel={intent_id:intents[1].id,op_id:randomUUID()};await f.call('wait_cancel',cancel);assert.equal(f.gate.busy('agent'),true);release();
  f.restart();state=await f.call('state');assert.deepEqual(state.waiting_intents.map(i=>i.state),['needs_review','cancelled','needs_review']);assert.equal(f.starts(),0);assert.equal(f.rows('grants').length,0);
  await f.launchPreview(drafts[0]);state=await f.call('state');assert.equal(state.waiting_intents[0].state,'reviewed');assert.equal(f.starts(),0);
  fs.appendFileSync(path.join(f.projectRoot,'sum.test.mjs'),'// source drift\n');
  state=await f.call('state');assert.equal(state.waiting_intents[2].state,'needs_review');assert.equal(state.waiting_intents[2].reason,'setup_source_or_policy_changed');
  await assert.rejects(f.launchPreview(drafts[2]),{code:'stale_resource'});assert.equal(f.starts(),0);
});

test('waiting deadline expiration never starts work or grants execution',async t=>{
  const f=fixture(t),d=await f.prepare();let time=Date.now();
  const setup=createWorkbenchSetup({...f,now:()=>time});
  const call=(action,fields={})=>setup.dispatch({...f.base,action,...fields});
  await call('wait',{draft_id:d.id,op_id:randomUUID(),deadline:time+1000,budget:{calls:2,checks:0,duration_ms:1000}});
  time+=1000;const state=await call('state');assert.equal(state.waiting_intents[0].state,'expired');assert.equal(f.starts(),0);assert.equal(f.rows('grants').length,0);
});

test('source drift after native preview refuses launch before approval or model dispatch',async t=>{
  const f=fixture(t),d=await f.prepare(),p=await f.launchPreview(d);
  fs.appendFileSync(path.join(f.projectRoot,'sum.test.mjs'),'// changed after launch review\n');
  await assert.rejects(f.call('launch',{draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()}),{code:'stale_resource'});
  assert.equal(f.rows('grants').length,0);assert.equal(f.starts(),0);
});

test('unconfigured native runtime refuses launch preview with a bounded actionable reason',async t=>{
  const f=fixture(t),d=await f.prepare();
  const setup=createWorkbenchSetup({...f,nativeConfigured:false});
  await assert.rejects(setup.dispatch({...f.base,action:'launch_preview',draft_id:d.id,budget:{calls:2,checks:0,duration_ms:1000}}),{code:'unavailable',reason:'native_runtime_unconfigured'});
  delete f.hermes.startNative;
  await assert.rejects(f.launchPreview(d),{code:'unavailable',reason:'native_runtime_unconfigured'});
  assert.equal(f.rows('grants').length,0);assert.equal(f.starts(),0);
});

test('manually changed acceptance cannot launch under the original goal-first draft',async t=>{
  const f=fixture(t),d=await f.prepare(),p=await f.launchPreview(d),task=f.rows('tasks')[0];
  f.data.update('tasks',f.base.workspace_id,f.project.id,task.id,task.revision,{title:'Different owner task'});
  await assert.rejects(f.call('launch',{draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()}),{code:'stale_resource',reason:'prepared_records_changed'});
  assert.equal(f.rows('grants').length,0);assert.equal(f.starts(),0);
});

test('uncertain start boundary cannot be replayed even if authoritative grant remains approved',async t=>{
  const f=fixture(t),d=await f.prepare(),p=await f.launchPreview(d),req={draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  const dispatch=f.native.dispatch;let starts=0;
  f.native.dispatch=async (body,options)=>{if(body.action==='start'){starts++;throw Object.assign(Error('connection lost before outcome known'),{code:'unavailable'});}return dispatch(body,options);};
  await assert.rejects(f.call('launch',req),{code:'unavailable'});f.restart();await assert.rejects(f.call('launch',req),{code:'outcome_unknown'});
  assert.equal(starts,1);assert.equal(f.rows('grants').length,1);assert.equal(f.rows('grants')[0].status,'approved');
});

test('saved grant identity reconciles authority rotation and definite non-start is not reported as launched',async t=>{
  const f=fixture(t),d=await f.prepare(),p=await f.launchPreview(d),req={draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  f.hermes.startNative=async()=>{throw Object.assign(Error('busy'),{code:'busy',native_outcome:'not_started'});};
  await assert.rejects(f.call('launch',req),{code:'busy'});
  let grant=f.rows('grants')[0];
  f.data.update('grants',f.base.workspace_id,f.project.id,grant.id,grant.revision,{authority_generation:randomUUID()});
  f.restart();const recovered=await f.call('launch',req);
  assert.equal(recovered.draft.status,'failed');assert.equal(recovered.draft.reason,'launch_not_started');assert.equal(recovered.grant.id,grant.id);
  assert.equal(f.rows('grants').length,1);
});

test('filesystem materialization crash intent fences rather than creating an unowned second copy',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.preview(d),req={preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  const original=f.execution.setupStep;let interrupted=true;
  f.execution.setupStep=args=>{
    if(args.step==='candidate'&&interrupted){
      interrupted=false;
      f.data.create('annotations',{workspace_id:f.base.workspace_id,project_id:f.project.id,kind:'setup_step',setup_id:args.setup_id,step:args.step,request_hash:args.request_hash,status:'materializing'});
      throw Object.assign(Error('simulated process loss after durable intent'),{code:'outcome_unknown'});
    }
    return original(args);
  };
  await assert.rejects(f.call('prepare',req),{code:'outcome_unknown'});f.restart();await assert.rejects(f.call('prepare',req),{code:'outcome_unknown',reason:'setup_candidate_materialization_unknown'});
  assert.equal(f.rows('tasks').length,1);assert.equal(f.rows('candidates').length,0);assert.equal(f.starts(),0);
});

test('candidate/task update failure retains one owned manifest and recovers the same tree after restart',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.preview(d),req={preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  const update=f.data.update.bind(f.data);let fail=true;
  f.data.update=(kind,w,project,id,revision,patch)=>{if(kind==='tasks'&&patch.candidate_id&&fail){fail=false;throw Object.assign(Error('task link failure'),{code:'unavailable'});}return update(kind,w,project,id,revision,patch);};
  await assert.rejects(f.call('prepare',req),{code:'unavailable'});
  assert.equal(f.rows('candidates').length,0);assert.equal(f.rows('tasks')[0].candidate_id,null);
  const parent=path.join(f.store.root,'workbench-execution','candidates'),retained=fs.readdirSync(parent).sort();assert.equal(retained.length,2);
  const intent=f.rows('annotations').find(r=>r.step==='candidate'),originalRoot=path.join(parent,intent.materialization.id),ino=fs.statSync(originalRoot).ino;
  f.restart();assert.equal((await f.call('prepare',req)).draft.status,'prepared');assert.equal(f.rows('candidates').length,1);
  assert.equal(f.rows('candidates')[0].root,originalRoot);assert.equal(fs.statSync(originalRoot).ino,ino);assert.deepEqual(fs.readdirSync(parent).sort(),retained);
  assert.equal(f.starts(),0);assert.equal(f.rows('jobs').length,0);
});

for(const tamper of ['bytes','manifest','missing_manifest','extra','source'])test(`interrupted setup recovery refuses ${tamper} without another copy`,async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.preview(d),req={preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  const create=f.data.create.bind(f.data);let fail=true;
  f.data.create=(kind,fields)=>{if(kind==='candidates'&&fail){fail=false;throw Object.assign(Error('crash before database publication'),{code:'unavailable'});}return create(kind,fields);};
  await assert.rejects(f.call('prepare',req),{code:'unavailable'});
  const intent=f.rows('annotations').find(r=>r.step==='candidate'),parent=path.join(f.store.root,'workbench-execution','candidates'),root=path.join(parent,intent.materialization.id),manifest=`${root}.setup.json`;
  if(tamper==='bytes')fs.appendFileSync(path.join(root,'sum.test.mjs'),'// tamper');
  if(tamper==='manifest'){const m=JSON.parse(fs.readFileSync(manifest));m.materialization.request_hash='0'.repeat(64);fs.writeFileSync(manifest,JSON.stringify(m));}
  if(tamper==='missing_manifest')fs.unlinkSync(manifest);
  if(tamper==='extra')fs.writeFileSync(path.join(root,'unrelated'),'leave intact');
  if(tamper==='source')fs.appendFileSync(path.join(f.projectRoot,'sum.test.mjs'),'// drift');
  const retained=fs.readdirSync(parent).sort();f.restart();await assert.rejects(f.call('prepare',req));
  assert.deepEqual(fs.readdirSync(parent).sort(),retained);assert.equal(f.rows('tasks').length,1);assert.equal(f.rows('candidates').length,0);assert.equal(f.starts(),0);
});

for(const boundary of ['intent','mid_copy','completed_manifest'])test(`real process exit at setup ${boundary} preserves one owned identity`,async t=>{
  const f=fixture(t),setup_id=randomUUID(),source_hash=captureProject(f.project).hash;
  const base={workspace_id:f.base.workspace_id,project_id:f.project.id};
  const {task}=f.execution.setupStep({setup_id,step:'task',request_hash:'1'.repeat(64),source_hash,body:{...base,title:'Crash fixture',acceptance_statement:'tests pass',check_definition_id:'node-test',profile_id:'fixture',session_id:'setup-session',pane_id:f.base.pane_id}});
  const args={setup_id,step:'candidate',request_hash:'2'.repeat(64),source_hash,body:{...base,task_id:task.id}};
  const program=`
    import fs from 'node:fs';
    import {SqliteWorkspaceStore} from './server/sqlite-workspace-store.mjs';
    import {WorkbenchStore} from './server/workbench-store.mjs';
    import {WorkbenchData} from './server/workbench-data.mjs';
    import {createWorkbenchExecution} from './server/workbench-execution.mjs';
    const store=new SqliteWorkspaceStore(${JSON.stringify(f.store.root)}),records=new WorkbenchStore(store),data=new WorkbenchData(store);
    const execution=createWorkbenchExecution({store,records,data}),create=data.create.bind(data),boundary=${JSON.stringify(boundary)};
    data.create=(kind,fields)=>{if(boundary==='completed_manifest'&&kind==='candidates')process.exit(71);const result=create(kind,fields);if(boundary==='intent'&&kind==='annotations'&&fields.step==='candidate')process.exit(71);return result;};
    if(boundary==='mid_copy'){const write=fs.writeFileSync;fs.writeFileSync=(fd,...rest)=>{const result=write(fd,...rest);if(typeof fd==='number'&&fs.readlinkSync('/proc/self/fd/'+fd).endsWith('/sum.test.mjs'))process.exit(71);return result;};}
    execution.setupStep(${JSON.stringify(args)});process.exit(72);
  `;
  const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',program],{cwd:process.cwd(),encoding:'utf8',timeout:10000});
  assert.equal(child.status,71,child.stderr);
  const intents=f.rows('annotations').filter(r=>r.step==='candidate');assert.equal(intents.length,1);assert.ok(intents[0].materialization.id);
  if(boundary==='completed_manifest'){
    const recovered=f.execution.setupStep(args);assert.equal(recovered.candidate.id,f.execution.setupStep(args).candidate.id);assert.equal(f.rows('candidates').length,1);
  }else assert.throws(()=>f.execution.setupStep(args),{code:'outcome_unknown'});
  assert.equal(f.rows('tasks').length,1);assert.equal(f.rows('annotations').filter(r=>r.step==='candidate').length,1);assert.equal(f.starts(),0);assert.equal(f.rows('jobs').length,0);
});

for(const boundary of ['binding','socket','runtime'])for(const change of ['source','policy'])test(`setup ${change} authorization survives the native ${boundary} async boundary`,async t=>{
  const f=fixture(t),d=await f.prepare(),p=await f.launchPreview(d);
  const dispatch=f.native.dispatch,readBinding=f.hermes.readBinding;
  let insideStart=false,bindingReads=0,workers=0,changed=false;
  const mutate=()=>{
    changed=true;
    if(change==='source')fs.appendFileSync(path.join(f.projectRoot,'sum.test.mjs'),'// changed during native admission\n');
    else {const read=f.store.read.bind(f.store);f.store.read=id=>({...read(id),recovery_policy:{held:true,generation:12}});}
  };
  f.native.dispatch=(body,options)=>{if(body.action==='start')insideStart=true;return dispatch(body,options);};
  f.hermes.readBinding=async args=>{
    const b=await readBinding(args);
    if(insideStart&&++bindingReads===(boundary==='binding'?1:3)&&boundary!=='runtime')mutate();
    return b;
  };
  f.hermes.startNative=async config=>{
    if(boundary==='runtime')mutate();
    try{await config.authorize();}catch(error){throw Object.assign(error,{native_outcome:'not_started'});}
    workers++;return {completion:new Promise(()=>{})};
  };
  await assert.rejects(f.call('launch',{draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()}));
  assert.equal(changed,true);assert.equal(workers,0);assert.equal(f.rows('grants').length,1);
  assert.notEqual(f.rows('grants')[0].status,'running');
});

test('native restart before launch rejects the lost preview without wedging a fresh owner review',async t=>{
  const f=fixture(t),d=await f.prepare(),p=await f.launchPreview(d);
  const request={draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  f.native.close();Object.assign(f.native,createWorkbenchNative(f));f.restart();
  await assert.rejects(f.call('launch',request),{code:'expired',native_approval_outcome:'not_created'});
  assert.equal(f.rows('grants').length,0);assert.equal(f.starts(),0);
  assert.equal((await f.call('state')).drafts[0].status,'prepared');
  f.restart();await assert.rejects(f.call('launch',request),{code:'expired'});
  const fresh=await f.launchPreview(d);
  const launched=await f.call('launch',{draft_id:d.id,preview_id:fresh.preview_id,preview_digest:fresh.preview_digest,op_id:randomUUID()});
  assert.equal(launched.draft.status,'launched');assert.equal(f.rows('grants').length,1);assert.equal(f.starts(),1);
});

test('completed prepare replay preserves launched lifecycle and grant identity across restart',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.preview(d);
  const request={preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()};
  const prepared=(await f.call('prepare',request)).draft,launch=await f.launchPreview(prepared);
  const started=await f.call('launch',{draft_id:d.id,preview_id:launch.preview_id,preview_digest:launch.preview_digest,op_id:randomUUID()});
  for(const restart of [false,true]){
    if(restart)f.restart();
    const result=await f.call('prepare',request);
    assert.equal(result.draft.status,'launched');assert.equal(result.draft.grant_id,started.grant.id);
  }
  for(const kind of ['tasks','candidates','attempts','contexts','grants'])assert.equal(f.rows(kind).length,1);
  assert.equal(f.starts(),1);
});

test('owner stop during the final setup binding lookup prevents runtime spawn and input delivery',async t=>{
  const f=fixture(t),d=await f.prepare(),p=await f.launchPreview(d);
  const readBinding=f.hermes.readBinding;
  let inRuntimeAuthorization=false,bindingReads=0,grantId,workers=0,inputDeliveries=0,stops=0;
  f.hermes.stopNative=async()=>{stops++;};
  f.hermes.readBinding=async args=>{
    const binding=await readBinding(args);
    // First lookup belongs to native authorize(active); the second is the
    // setup guard. The old code returned the pre-stop grant after this await.
    if(inRuntimeAuthorization&&++bindingReads===2){
      const stopped=await f.native.dispatch({action:'stop',workspace_id:f.base.workspace_id,project_id:f.project.id,grant_id:grantId});
      assert.equal(stopped.grant.status,'stop_requested');
    }
    return binding;
  };
  f.hermes.startNative=async config=>{
    grantId=config.scope.id;inRuntimeAuthorization=true;
    try{await config.authorize();}
    catch(error){throw Object.assign(error,{native_outcome:'not_started'});}
    finally{inRuntimeAuthorization=false;}
    workers++;inputDeliveries++;
    return {completion:new Promise(()=>{})};
  };
  await assert.rejects(f.call('launch',{draft_id:d.id,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()}));
  assert.equal(bindingReads,2);assert.equal(stops,1);
  assert.equal(workers,0);assert.equal(inputDeliveries,0);
  const grant=f.rows('grants')[0];assert.equal(grant.status,'stopped');assert.equal(grant.runtime_status,'not_started');
});
