import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchLive,projectWorkbenchEvent} from '../server/workbench-live.mjs';
import {createWorkbenchLiveHandler} from '../server/workbench-live-route.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {validateLiveItem,validateWorkbenchLive,LIVE_LIMITS} from '../contracts/workbench-live-v1.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';

function fixture(t,{withLive=true,execution,native,gate}={}){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-live-');
  const store=new SqliteWorkspaceStore(root);
  const workspace=randomUUID();
  store.commit(commandIdentity({workspace_id:workspace,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id:workspace,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const records=new WorkbenchStore(store);
  const project=records.register(workspace,{root:path.join(root,'project'),name:'Synthetic',identity:'synthetic'});
  const data=new WorkbenchData(store);
  const live=withLive?createWorkbenchLive({store,records,data,execution,native,gate}):null;
  t.after(()=>{try{live?.close();}catch{}store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,store,workspace,project,records,data,live};
}

test('contract request schema is strict over the four read-only actions',()=>{
  const base={workspace_id:randomUUID(),project_id:randomUUID()};
  assert.equal(validateWorkbenchLive({action:'page',...base}),true);
  assert.equal(validateWorkbenchLive({action:'stream',...base,after_sequence:0,limit:10}),true);
  assert.equal(validateWorkbenchLive({action:'detail',...base,reference:{kind:'candidate',id:randomUUID()}}),true);
  assert.equal(validateWorkbenchLive({action:'tail',...base,job_id:randomUUID()}),true);
  assert.equal(validateWorkbenchLive({action:'run',...base}),false,'execution actions are not admitted');
  assert.equal(validateWorkbenchLive({action:'page',...base,extra:1}),false,'unknown fields fail closed');
  assert.equal(validateWorkbenchLive({action:'detail',...base}),false,'detail requires a reference');
  assert.equal(validateWorkbenchLive({action:'detail',...base,reference:{kind:'normal-tool',id:randomUUID()}}),false,'normal-tool is not a workbench live reference');
});

test('observer projects committed create/update revisions and items satisfy the live contract',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  f.live.subscribe(()=>{throw Error('observer must not fail authoritative work');});
  const task=f.data.create('tasks',{...scope,title:'Repair synthetic sum',acceptance:{},acceptance_version:1,status:'open'});
  const updated=f.data.update('tasks',f.workspace,f.project.id,task.id,task.revision,{status:'candidate_ready'});
  assert.equal(updated.revision,2);
  assert.equal(f.data.get('tasks',f.workspace,f.project.id,task.id).revision,2);
  const page=f.live.page({workspace_id:f.workspace,project_id:f.project.id});
  assert.equal(page.version,1);
  assert.equal(page.reset_required,false);
  assert.equal(page.project_generation,f.project.generation);
  assert.deepEqual(page.events.map(event=>event.sequence),[1,2]);
  assert.deepEqual(page.events.map(event=>event.id),[`tasks:${task.id}:1`,`tasks:${task.id}:2`]);
  assert.equal(page.events[0].kind,'task');
  assert.equal(page.events[0].category,'agent');
  assert.equal(page.events[0].status,'ready');
  assert.equal(page.events[0].authority,'human');
  assert.equal(page.events[0].summary,'Task Repair synthetic sum');
  assert.equal(page.after_sequence,2);
  for(const event of page.events)assert.equal(validateLiveItem(event),true,`live item contract ${JSON.stringify(event)}`);
  assert.equal(projectWorkbenchEvent('tasks',updated,{phase:'update'}).status,'ready');
});

test('observer errors are isolated and a rolled-back transaction never fabricates a transition',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const task=f.data.create('tasks',{...scope,title:'Rollback probe',status:'open'});
  const before=f.live.page({workspace_id:f.workspace,project_id:f.project.id}).after_sequence;
  assert.throws(()=>f.data.db.transaction(()=>{
    f.data.update('tasks',f.workspace,f.project.id,task.id,task.revision,{status:'candidate_ready'});
    throw Object.assign(Error('rollback'),{code:'stale_resource'});
  }).immediate(),{code:'stale_resource'});
  await Promise.resolve();
  const page=f.live.page({workspace_id:f.workspace,project_id:f.project.id});
  assert.equal(page.after_sequence,before);
  assert.equal(f.data.get('tasks',f.workspace,f.project.id,task.id).status,'open');
});

test('a rolled-back deferred revision reused by a different payload never emits the rolled-back payload',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const task=f.data.create('tasks',{...scope,title:'Original',status:'open'});
  assert.throws(()=>f.data.db.transaction(()=>{
    f.data.update('tasks',f.workspace,f.project.id,task.id,1,{title:'ROLLED_BACK_PAYLOAD'});
    throw Object.assign(Error('rollback'),{code:'stale_resource'});
  }).immediate(),{code:'stale_resource'});
  // Same record id and revision are reused by a real write before the deferred
  // microtask flush; revision equality alone would have surfaced the stale payload.
  f.data.update('tasks',f.workspace,f.project.id,task.id,1,{title:'COMMITTED_PAYLOAD'});
  await Promise.resolve();
  const events=f.live.page(scope).events.filter(event=>event.kind==='task');
  const json=JSON.stringify(events);
  assert.ok(!json.includes('ROLLED_BACK_PAYLOAD'),'rolled-back payload must never be projected');
  assert.ok(events.some(event=>event.summary==='Task COMMITTED_PAYLOAD'));
  assert.equal(f.data.get('tasks',f.workspace,f.project.id,task.id).title,'COMMITTED_PAYLOAD');
});

test('a committed nested transaction surfaces only provable current state, never fabricated intermediates',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const grant=f.data.create('grants',{...scope,status:'approved',calls_used:0});
  f.data.db.transaction(()=>{
    f.data.update('grants',f.workspace,f.project.id,grant.id,1,{status:'starting'});
    f.data.update('grants',f.workspace,f.project.id,grant.id,2,{status:'running',runtime_status:'running'});
  }).immediate();
  return Promise.resolve().then(()=>{
    const events=f.live.page(scope).events.filter(event=>event.kind==='grant');
    // The top-level create is exact; the savepoint writes collapse to one
    // current-state snapshot for revision 3. Intermediate rev2 is not claimed.
    assert.deepEqual(events.map(event=>event.id),[`grants:${grant.id}:1`,`grants:${grant.id}:3`]);
    const snapshot=events.at(-1);
    assert.equal(snapshot.authority,'observed');
    assert.ok(snapshot.fields.some(field=>field.label==='observed'&&field.value==='reconciled_snapshot'));
    assert.equal(f.data.get('grants',f.workspace,f.project.id,grant.id).status,'running');
  });
});

test('unsubscribe and close stop delivering notifications without failing authoritative writes',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  let count=0;
  const off=f.live.subscribe(()=>{count++;});
  f.data.create('tasks',{...scope,title:'one',status:'open'});
  assert.equal(count,1);
  off();
  f.data.create('tasks',{...scope,title:'two',status:'open'});
  assert.equal(count,1);
  f.live.close();
  assert.doesNotThrow(()=>f.data.create('tasks',{...scope,title:'three',status:'open'}));
  assert.equal(count,1);
});

test('projection lives in a separate private database and does not bump the workspace schema',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  f.data.create('tasks',{...scope,title:'Separate',status:'open'});
  assert.equal(f.store.db.pragma('user_version',{simple:true}),8);
  assert.equal(f.live.filename,path.join(f.root,'workbench-live.sqlite'));
  assert.ok(fs.existsSync(f.live.filename));
  const projection=new Database(f.live.filename,{readonly:true});
  try{
    assert.equal(projection.prepare('SELECT count(*) n FROM live_events').get().n,1);
    assert.ok(!projection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().some(row=>row.name==='workspaces'));
  }finally{projection.close();}
});

test('page exposes bounded lane and snapshot metrics without prose or raw arguments',t=>{
  const gate={status:()=>({agent:true,job:false,legacy:{enabled:false,active:0,uncertain:0,pending:1},quarantines:[]})};
  const f=fixture(t,{gate}),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[{path:'math.js',hash:'b'.repeat(64),bytes:4,state:'modified',text:'SECRET_SOURCE'}],total_bytes:4,status:'approved'});
  f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candidate.id});
  f.data.create('grants',{...scope,attempt_id:randomUUID(),status:'running',runtime_status:'running',calls_used:1,provenance:{version:1,initiated_by:{kind:'native_agent'},authorized_by:{kind:'owner_grant'},recorded_by:{kind:'comet_service'}}});
  const page=f.live.page({workspace_id:f.workspace,project_id:f.project.id});
  assert.deepEqual(page.lane,{agent_busy:true,job_busy:false,unknown:false});
  assert.equal(page.snapshot.candidates,1);
  assert.equal(page.snapshot.active_jobs,1);
  assert.equal(page.snapshot.active_grants,1);
  assert.equal(page.snapshot.latest_candidate.id,candidate.id);
  assert.equal(page.snapshot.latest_job.definition_id,'node-test');
  const json=JSON.stringify(page.snapshot);
  assert.ok(!json.includes('SECRET_SOURCE'));
  assert.ok(!json.includes('math.js'));
});

test('attempt scope filters before limiting and cursor progresses across interleaved records safely',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attempt=f.data.create('attempts',{...scope,status:'created',candidate_id:candidate.id,candidate_hash:candidate.hash});
  const grant=f.data.create('grants',{...scope,attempt_id:attempt.id,status:'approved',calls_used:0});
  f.data.update('grants',f.workspace,f.project.id,grant.id,grant.revision,{status:'running',runtime_status:'running'});
  const call=f.data.create('toolcalls',{...scope,attempt_id:attempt.id,grant_id:grant.id,action:'inspect',status:'started'});
  f.data.update('toolcalls',f.workspace,f.project.id,call.id,call.revision,{status:'completed'});
  f.data.create('reviews',{...scope,decision:'approved',evidence_ids:[]});

  const all=f.live.page({workspace_id:f.workspace,project_id:f.project.id,limit:100});
  assert.ok(all.events.length>=6);
  const attemptPage=f.live.page({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id});
  // The candidate is candidate-bound to this attempt and appears, but stays
  // observed (never attributed to the agent from an owner write).
  assert.deepEqual(attemptPage.events.map(event=>event.kind),['candidate','attempt','grant','grant','toolcall','toolcall']);
  assert.equal(attemptPage.events.find(event=>event.kind==='candidate').authority,'observed');
  const firstHalf=f.live.page({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,limit:2});
  assert.equal(firstHalf.events.length,2);
  assert.equal(firstHalf.has_more,true);
  const secondHalf=f.live.page({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,limit:2,after_sequence:firstHalf.after_sequence});
  assert.equal(secondHalf.events.length,2);
  assert.ok(firstHalf.after_sequence<secondHalf.events[0].sequence);
  assert.ok(secondHalf.events.every(event=>event.kind==='toolcall'||event.kind==='grant'));
});

test('reconcile backfills missing projection keys as observed current-state snapshots, not fabricated transitions',t=>{
  const f=fixture(t,{withLive:false}),scope={workspace_id:f.workspace,project_id:f.project.id};
  const task=f.data.create('tasks',{...scope,title:'Pre-existing',status:'checked',acceptance_version:1});
  f.data.update('tasks',f.workspace,f.project.id,task.id,1,{status:'accepted'});
  const live=createWorkbenchLive({store:f.store,records:f.records,data:f.data});
  t.after(()=>live.close());
  const page=live.page({workspace_id:f.workspace,project_id:f.project.id});
  assert.equal(page.events.length,1);
  assert.equal(page.events[0].id,`tasks:${task.id}:2`);
  assert.equal(page.events[0].authority,'observed');
  const rows=new Database(live.filename,{readonly:true});
  try{
    const stored=rows.prepare('SELECT phase,event_json FROM live_events').all();
    assert.equal(stored.length,1);
    assert.equal(stored[0].phase,'snapshot');
    assert.equal(live.reconcile().added,0);
    assert.equal(rows.prepare('SELECT count(*) n FROM live_events').get().n,1,'no fabricated intermediate rows');
  }finally{rows.close();}
});

test('fresh filtered scope with a non-matching project prefix does not reset',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attempt=f.data.create('attempts',{...scope,status:'created',candidate_id:candidate.id,candidate_hash:candidate.hash});
  f.data.create('grants',{...scope,attempt_id:attempt.id,status:'approved',calls_used:0});
  const fresh=f.live.page({...scope,attempt_id:attempt.id,after_sequence:0});
  assert.equal(fresh.reset_required,false);
  assert.ok(fresh.events.length>0);
});

test('retention floor and future cursors set reset_required',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  for(let i=0;i<LIVE_LIMITS.retainedPerAttempt+5;i++)f.data.create('annotations',{...scope,kind:`note-${i}`});
  const page=f.live.page({...scope,after_sequence:5});
  assert.equal(page.events.length,LIVE_LIMITS.page);
  assert.equal(page.events[0].sequence,6,'oldest five rows are pruned');
  // A stale cursor replays the oldest retained page (not an empty page) so the
  // retained timeline can still be reconstructed, then paginates normally.
  const floorReset=f.live.page({...scope,after_sequence:3});
  assert.equal(floorReset.reset_required,true);
  assert.equal(floorReset.events[0].sequence,6);
  assert.equal(floorReset.events.length,LIVE_LIMITS.page);
  assert.equal(floorReset.after_sequence,6+LIVE_LIMITS.page-1);
  assert.equal(floorReset.has_more,true);
  const resume=f.live.page({...scope,after_sequence:LIVE_LIMITS.retainedPerAttempt+4});
  assert.equal(resume.reset_required,false);
  assert.deepEqual(resume.events.map(event=>event.sequence),[LIVE_LIMITS.retainedPerAttempt+5]);
  const future=f.live.page({...scope,after_sequence:99999});
  assert.equal(future.reset_required,true);
  assert.equal(future.events[0].sequence,6);
});

test('authority distinguishes producers and confirmation state',()=>{
  const base={id:randomUUID(),revision:1,version:1};
  const auth=(kind,record,phase='update')=>projectWorkbenchEvent(kind,{...base,...record},{phase}).authority;
  assert.equal(auth('evidence',{verdict:'pass'}),'recorder','structured evidence is recorder-produced');
  assert.equal(auth('evidence',{verdict:'pass'},'snapshot'),'recorder','bootstrapped evidence stays recorder-authoritative');
  assert.equal(auth('jobs',{status:'running'}),'observed','a running check is observed, not asserted by the recorder');
  assert.equal(auth('jobs',{status:'completed'},'snapshot'),'observed');
  assert.equal(auth('toolcalls',{status:'started'}),'agent','the agent requested the tool');
  assert.equal(auth('toolcalls',{status:'completed'}),'observed','tool completion is observed');
  assert.equal(auth('toolcalls',{status:'failed'}),'observed');
  assert.equal(auth('grants',{status:'approved'}),'human');
  assert.equal(auth('grants',{status:'stop_requested'}),'human','a stop request is a human request');
  assert.equal(auth('grants',{status:'stopped'}),'observed','a confirmed stop is observed');
  assert.equal(auth('results',{availability:'available'}),'observed');
  assert.equal(auth('patches',{status:'verified'}),'recorder');
  assert.equal(auth('patches',{status:'verifying'}),'observed');
  // Snapshot labelling is explicit for current-state observations.
  const snap=projectWorkbenchEvent('jobs',{...base,status:'running'},{phase:'snapshot'});
  assert.ok(snap.fields.some(field=>field.label==='observed'&&field.value==='reconciled_snapshot'));
  assert.equal(projectWorkbenchEvent('tasks',{...base,status:'open'},{phase:'update'}).status,'ready');
  assert.equal(projectWorkbenchEvent('grants',{...base,status:'cancel_requested'},{phase:'update'}).status,'waiting','a cancel request is not a confirmed cancel');
  const revoked=projectWorkbenchEvent('evidence',{...base,verdict:'inconclusive',revoked:true},{phase:'update'});
  assert.equal(revoked.category,'warnings');
  assert.equal(revoked.status,'unknown');
});

test('native provenance and candidate binding place jobs, evidence and candidates in the selected attempt',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attempt=f.data.create('attempts',{...scope,status:'created',candidate_id:candidate.id,candidate_hash:candidate.hash});
  const grantId=randomUUID();
  const provenance={version:1,initiated_by:{kind:'native_agent',attempt_id:attempt.id,grant_id:grantId,run_id:randomUUID(),tool_call_id:randomUUID()},authorized_by:{kind:'owner_grant',grant_id:grantId,authority_generation:randomUUID()},recorded_by:{kind:'comet_service',component:'workbench-check-recorder'}};
  const job=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candidate.id,provenance});
  assert.equal(f.data.get('jobs',f.workspace,f.project.id,job.id).attempt_id,undefined,'job has no direct attempt_id');
  const attemptEvents=f.live.page({...scope,attempt_id:attempt.id}).events;
  assert.ok(attemptEvents.some(event=>event.id===`jobs:${job.id}:1`),'native job joins the attempt timeline via provenance');
  assert.ok(attemptEvents.some(event=>event.kind==='candidate'),'candidate-bound record appears in the attempt timeline');
  assert.ok(attemptEvents.every(event=>event.kind==='candidate'?event.authority==='observed':true));
});

test('attempt scope validates existence and current generation',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attempt=f.data.create('attempts',{...scope,status:'created',project_generation:f.project.generation,candidate_id:candidate.id,candidate_hash:candidate.hash});
  assert.throws(()=>f.live.page({...scope,attempt_id:randomUUID()}),{code:'permission_denied'});
  assert.deepEqual(f.live.authorize({...scope,attempt_id:attempt.id}),{project_generation:f.project.generation,attempt_id:attempt.id,attempt_generation:f.project.generation});
  f.records.revoke(f.workspace,f.project.id,f.project.generation);
  f.records.register(f.workspace,{root:path.join(f.root,'project'),name:'Synthetic',identity:'synthetic'});
  assert.throws(()=>f.live.page({...scope,attempt_id:attempt.id}),{code:'stale_resource'});
  assert.throws(()=>f.live.authorize({...scope,attempt_id:attempt.id}),{code:'stale_resource'});
});

test('attempt snapshot reports only its own candidate, never another task candidate',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candA=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[{path:'a.js',hash:'1'.repeat(64),bytes:1,state:'modified'}],total_bytes:1,status:'approved'});
  const candB=f.data.create('candidates',{...scope,generation:1,hash:'b'.repeat(64),files:[{path:'b.js',hash:'2'.repeat(64),bytes:1,state:'modified'}],total_bytes:1,status:'approved'});
  const attemptA=f.data.create('attempts',{...scope,status:'created',candidate_id:candA.id,candidate_hash:candA.hash});
  f.data.create('attempts',{...scope,status:'created',candidate_id:candB.id,candidate_hash:candB.hash});
  const jobA=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.create('jobs',{...scope,status:'running',definition_id:'host-regression',candidate_id:candB.id});
  const snap=f.live.snapshot({...scope,attempt_id:attemptA.id});
  assert.equal(snap.scope,'attempt');
  assert.equal(snap.candidate.id,candA.id);
  assert.equal(snap.job.candidate_id,candA.id);
  assert.equal(snap.latest_candidate,undefined,'attempt snapshot does not report a project-wide latest candidate');
  assert.equal(snap.candidate.files,1);
  const projectSnap=f.live.snapshot(scope);
  assert.equal(projectSnap.scope,'project');
  assert.equal(projectSnap.latest_candidate.id,candB.id);
});

test('projection database and sidecars are private regular files that reject links',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  f.data.create('tasks',{...scope,title:'Private',status:'open'});
  assert.equal(fs.statSync(f.live.filename).mode&0o777,0o600);
  for(const sidecar of [`${f.live.filename}-wal`,`${f.live.filename}-shm`])if(fs.existsSync(sidecar))assert.equal(fs.statSync(sidecar).mode&0o777,0o600,sidecar);

  // A symlinked or hardlinked projection path is refused rather than followed.
  const linked=fixture(t,{withLive:false});
  const target=path.join(linked.root,'elsewhere.sqlite');fs.writeFileSync(target,'');
  fs.symlinkSync(target,path.join(linked.root,'workbench-live.sqlite'));
  assert.throws(()=>createWorkbenchLive({store:linked.store,records:linked.records,data:linked.data}),{code:'permission_denied'});

  const hard=fixture(t,{withLive:false});
  const hardTarget=path.join(hard.root,'hard.sqlite');fs.writeFileSync(hardTarget,'');
  fs.linkSync(hardTarget,path.join(hard.root,'workbench-live.sqlite'));
  assert.throws(()=>createWorkbenchLive({store:hard.store,records:hard.records,data:hard.data}),{code:'permission_denied'});
});

test('detail returns whitelisted metadata only and an exact-generation candidate diff, never a substituted snapshot',async t=>{
  const otherId=randomUUID(),resultId=randomUUID();let attemptId=null,candidateId=null;
  const gen1Files=[{path:'math.js',hash:'1'.repeat(64),bytes:12,state:'modified'}];
  const gen2Files=[{path:'math.js',hash:'1'.repeat(64),bytes:12,state:'modified'},{path:'sum.js',hash:'2'.repeat(64),bytes:5,state:'created'}];
  const execution={dispatch:async body=>{
    if(body.action==='candidate_version_get'){
      if(body.generation===1&&body.candidate_hash==='a'.repeat(64))return {candidate:{id:body.candidate_id,generation:1,hash:body.candidate_hash,files:gen1Files,total_bytes:12,limited:false}};
      if(body.generation===2&&body.candidate_hash==='b'.repeat(64))return {candidate:{id:body.candidate_id,generation:2,hash:body.candidate_hash,files:gen2Files,total_bytes:17,limited:false}};
      throw Object.assign(Error('stale_resource'),{code:'stale_resource'});
    }
    if(body.action==='candidate_version_read'){
      if(body.generation===2&&body.path==='sum.js')return {file:{path:'sum.js',hash:'2'.repeat(64),bytes:5,binary:false,text:'export const sum=(a,b)=>a+b;'}};
      throw Object.assign(Error('stale_resource'),{code:'stale_resource'});
    }
    throw Object.assign(Error('unsupported'),{code:'unsupported'});
  }};
  const native={dispatch:async body=>{if(body.action==='result_get')return {result:{id:body.result_id,attempt_id:attemptId,availability:'available',hermes_completed:true,frame_hash:'e'.repeat(64),received_at:1,retained_until:2,candidate_id:candidateId,candidate_generation:2,candidate_hash:'b'.repeat(64),provenance:{version:1},text:'SECRET_REASONING'}};throw Object.assign(Error('unsupported'),{code:'unsupported'});}};
  const f=fixture(t,{execution,native}),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:2,hash:'b'.repeat(64),files:gen2Files,root_history:[{root:'/private/retained/gen1',generation:1,hash:'a'.repeat(64)}],total_bytes:17,status:'approved'});
  candidateId=candidate.id;
  const attempt=f.data.create('attempts',{...scope,status:'created',candidate_id:candidateId,candidate_hash:'b'.repeat(64)});
  attemptId=attempt.id;

  const toolcall=f.data.create('toolcalls',{...scope,attempt_id:attempt.id,grant_id:randomUUID(),action:'job_start',status:'completed',args_digest:'1'.repeat(64),result_digest:'2'.repeat(64),args:{secret:'SENTINEL_ARGS'}});
  const tool=await f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'toolcall',id:toolcall.id}});
  assert.equal(tool.mode,'metadata');
  assert.equal(tool.not_diff,true);
  assert.ok(!JSON.stringify(tool).includes('SENTINEL_ARGS'));
  assert.equal(tool.fields.args_digest,'1'.repeat(64));

  const evidence=f.data.create('evidence',{...scope,verdict:'pass',exit_code:0,log_path:'/private/secret/output.log',log_bytes:10,log_hash:'3'.repeat(64),artifact_hash:'4'.repeat(64),candidate_id:candidateId,candidate_hash_after:'b'.repeat(64)});
  const observed=await f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'evidence',id:evidence.id}});
  assert.equal(observed.mode,'evidence_record');
  assert.ok(!JSON.stringify(observed).includes('/private/secret'));

  // Exact retained-generation comparison, sourced from the committed candidate.
  const diff=await f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'candidate',id:candidateId,candidate_id:candidateId,generation:2,hash:'b'.repeat(64)}});
  assert.equal(diff.mode,'candidate_generation_diff');
  assert.equal(diff.available,true);
  assert.equal(diff.not_diff,false);
  assert.equal(diff.changed_files,1);
  assert.equal(diff.files[0].path,'sum.js');
  assert.equal(diff.files[0].new_hash,'2'.repeat(64));
  assert.equal(diff.files[0].new_text,'export const sum=(a,b)=>a+b;');

  // Absent exact generation/hash: refuse; current content is never substituted.
  const absent=await f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'candidate',id:candidateId,candidate_id:candidateId}});
  assert.equal(absent.available,false);
  assert.equal(absent.reason,'exact_generation_required');
  assert.equal(absent.not_diff,true);

  // A requested generation with no retained prior is a typed unavailability.
  const missing=await f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'candidate',id:candidateId,candidate_id:candidateId,generation:9,hash:'9'.repeat(64)}});
  assert.equal(missing.available,false);
  assert.equal(missing.reason,'historical_diff_unavailable');
  assert.equal(missing.not_diff,true);

  const result=await f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'result',id:resultId}});
  assert.equal(result.mode,'result_receipt');
  assert.ok(!JSON.stringify(result).includes('SECRET_REASONING'));
  assert.equal(result.fields.availability,'available');

  // A reference that belongs to the project but not this attempt must fail closed.
  const foreign=f.data.create('toolcalls',{...scope,attempt_id:otherId,grant_id:randomUUID(),action:'inspect',status:'completed'});
  await assert.rejects(()=>f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'toolcall',id:foreign.id}}),{code:'permission_denied'});

  // No source bytes ever enter durable/page events.
  assert.ok(!JSON.stringify(f.live.page({...scope,attempt_id:attempt.id}).events).includes('a+b'));
});

test('revoked project and superseded generation hard-fence reads and streams',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,project_generation:f.project.generation,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attempt=f.data.create('attempts',{...scope,status:'created',candidate_id:candidate.id,candidate_hash:candidate.hash});
  f.records.revoke(f.workspace,f.project.id,f.project.generation);
  assert.throws(()=>f.live.page(scope),{code:'permission_denied'});
  await assert.rejects(()=>f.live.detail({...scope,reference:{kind:'candidate',id:candidate.id}}),{code:'permission_denied'});
  assert.throws(()=>f.live.tail({...scope,job_id:randomUUID()}),{code:'permission_denied'});
  // Re-registration reactivates the project with a new generation; old-generation references stay fenced.
  const reactivated=f.records.register(f.workspace,{root:path.join(f.root,'project'),name:'Synthetic',identity:'synthetic'});
  assert.notEqual(reactivated.generation,f.project.generation);
  await assert.rejects(()=>f.live.detail({...scope,attempt_id:attempt.id,reference:{kind:'candidate',id:candidate.id}}),{code:'stale_resource'});
});

test('tail resolves only the job recorded artifact reference and never cross-discloses',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candA=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const candB=f.data.create('candidates',{...scope,generation:1,hash:'b'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attemptA=f.data.create('attempts',{...scope,status:'created',candidate_id:candA.id,candidate_hash:candA.hash});
  const attemptB=f.data.create('attempts',{...scope,status:'created',candidate_id:candB.id,candidate_hash:candB.hash});
  const jobA=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  const jobB=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candB.id});
  // Missing private reference fails closed; nothing is scanned or guessed.
  const unresolved=f.live.tail({...scope,job_id:jobA.id});
  assert.equal(unresolved.available,false);
  assert.equal(unresolved.reason,'unresolved');
  assert.equal(unresolved.verified,false);

  const dirA=path.join(f.live.artifactRoot,'check-alpha');fs.mkdirSync(dirA,{recursive:true,mode:0o700});
  const dirB=path.join(f.live.artifactRoot,'check-bravo');fs.mkdirSync(dirB,{recursive:true,mode:0o700});
  const decoy=path.join(f.live.artifactRoot,'check-decoy');fs.mkdirSync(decoy,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(dirA,'output.log'),'ALPHA_ONLY',{mode:0o600});
  fs.writeFileSync(path.join(dirB,'output.log'),'BRAVO_ONLY',{mode:0o600});
  fs.writeFileSync(path.join(decoy,'output.log'),'DECOY_SENTINEL',{mode:0o600});
  f.data.update('jobs',f.workspace,f.project.id,jobA.id,1,{artifact_log_path:path.join(dirA,'output.log'),artifact_dir:dirA});
  f.data.update('jobs',f.workspace,f.project.id,jobB.id,1,{artifact_log_path:path.join(dirB,'output.log'),artifact_dir:dirB});

  const a=f.live.tail({...scope,attempt_id:attemptA.id,job_id:jobA.id});
  assert.equal(a.available,true);
  assert.match(a.text,/ALPHA_ONLY/);
  assert.ok(!a.text.includes('BRAVO_ONLY')&&!a.text.includes('DECOY_SENTINEL'));
  const b=f.live.tail({...scope,attempt_id:attemptB.id,job_id:jobB.id});
  assert.match(b.text,/BRAVO_ONLY/);
  assert.ok(!b.text.includes('ALPHA_ONLY')&&!b.text.includes('DECOY_SENTINEL'));
  // A job may not be tailed through another attempt even in the same project.
  assert.throws(()=>f.live.tail({...scope,attempt_id:attemptA.id,job_id:jobB.id}),{code:'permission_denied'});

  // A recorded path outside the trusted artifact root is refused, not escaped.
  const outside=path.join(f.root,'outside','output.log');fs.mkdirSync(path.dirname(outside),{recursive:true});fs.writeFileSync(outside,'ESCAPE_SENTINEL');
  const escaped=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.update('jobs',f.workspace,f.project.id,escaped.id,1,{artifact_log_path:outside,artifact_dir:path.dirname(outside)});
  const refused=f.live.tail({...scope,job_id:escaped.id});
  assert.equal(refused.available,false);
  assert.equal(refused.reason,'outside_artifact_root');
  assert.ok(!JSON.stringify(refused).includes('ESCAPE_SENTINEL'));

  // Cap and unverified labelling.
  const dirCap=path.join(f.live.artifactRoot,'check-cap');fs.mkdirSync(dirCap,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(dirCap,'output.log'),'x'.repeat(20000),{mode:0o600});
  const capJob=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.update('jobs',f.workspace,f.project.id,capJob.id,1,{artifact_log_path:path.join(dirCap,'output.log'),artifact_dir:dirCap});
  const cap=f.live.tail({...scope,job_id:capJob.id});
  assert.equal(cap.cap_bytes,LIVE_LIMITS.tailBytes);
  assert.equal(Buffer.byteLength(cap.text),LIVE_LIMITS.tailBytes);
  assert.equal(cap.truncated,true);
  assert.equal(cap.verified,false);
  assert.match(cap.note,/Unverified tail/);
  assert.throws(()=>f.live.tail({...scope,job_id:f.workspace}),{code:'permission_denied'});
});

test('public job projections never expose private artifact coordinates',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const dir=path.join(f.live.artifactRoot,'check-private');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(dir,'output.log'),'PRIVATE_BYTES',{mode:0o600});
  const job=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:randomUUID()});
  f.data.update('jobs',f.workspace,f.project.id,job.id,1,{artifact_log_path:path.join(dir,'output.log'),artifact_dir:dir});
  const execution=createWorkbenchExecution({store:f.store,records:f.records,data:f.data,gate:createWorkbenchGate()});
  t.after(()=>execution.close());
  const fetched=await execution.dispatch({action:'job_get',workspace_id:f.workspace,project_id:f.project.id,job_id:job.id});
  assert.equal(fetched.job.artifact_log_path,undefined);
  assert.equal(fetched.job.artifact_dir,undefined);
  const state=await execution.dispatch({action:'execution_state',workspace_id:f.workspace,project_id:f.project.id});
  assert.ok(!JSON.stringify(state).includes('artifact_log_path')&&!JSON.stringify(state).includes('check-private'));
});

async function startRoute(t,{live,heartbeatMs=40,token='owner-secret-token'}={}){
  let handler;
  const server=http.createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  handler=createWorkbenchLiveHandler({token,port,devOrigins:[],live,heartbeatMs,reply:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {port,token,origin:`http://127.0.0.1:${port}`};
}
const parseFrames=buffer=>buffer.split('\n\n').filter(block=>block.trim());
const frameName=frame=>/^event: (\w+)/.exec(frame)?.[1]??null;

test('route enforces owner bearer, allowed origin and strict body',async t=>{
  const f=fixture(t),route=await startRoute(t,{live:f.live}),url=`${route.origin}/api/workbench/live`;
  const body=JSON.stringify({action:'page',workspace_id:f.workspace,project_id:f.project.id});
  assert.equal((await fetch(url,{method:'POST',headers:{Origin:route.origin,'Content-Type':'application/json'},body})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${route.token}`,Origin:'http://evil.example','Content-Type':'application/json'},body})).status,403);
  assert.equal((await fetch(url,{method:'GET',headers:{Authorization:`Bearer ${route.token}`,Origin:route.origin}})).status,405);
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${route.token}`,Origin:route.origin,'Content-Type':'application/json'},body:JSON.stringify({action:'page',workspace_id:f.workspace,project_id:f.project.id,extra:true})})).status,400);
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${route.token}`,Origin:route.origin,'Content-Type':'application/json'},body:JSON.stringify({action:'run',workspace_id:f.workspace,project_id:f.project.id})})).status,400);
  f.data.create('tasks',{workspace_id:f.workspace,project_id:f.project.id,title:'Route',status:'open'});
  const ok=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${route.token}`,Origin:route.origin,'Content-Type':'application/json'},body});
  assert.equal(ok.status,200);
  const page=await ok.json();
  assert.equal(page.ok,true);
  assert.equal(page.version,1);
  assert.ok(page.events.length>=1);
});

test('stream emits page/heartbeat frames and a contentless fenced frame on revocation',async t=>{
  const f=fixture(t),route=await startRoute(t,{live:f.live,heartbeatMs:40});
  const controller=new AbortController();
  const response=await fetch(`${route.origin}/api/workbench/live`,{method:'POST',headers:{Authorization:`Bearer ${route.token}`,Origin:route.origin,'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({action:'stream',workspace_id:f.workspace,project_id:f.project.id}),signal:controller.signal});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  const readUntil=async predicate=>{
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      const {value,done}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});
      if(predicate(buffer))return true;
    }
    return false;
  };
  const streamed=f.data.create('tasks',{workspace_id:f.workspace,project_id:f.project.id,title:'Streamed',status:'open'});
  f.data.update('tasks',f.workspace,f.project.id,streamed.id,streamed.revision,{status:'candidate_ready'});
  assert.equal(await readUntil(text=>/event: page/.test(text)&&text.includes('candidate_ready')),true,'record-driven page frame arrives without whole-state polling');
  assert.equal(await readUntil(text=>/event: heartbeat/.test(text)),true,'heartbeat frame arrives while idle');
  f.records.revoke(f.workspace,f.project.id,f.records.project(f.workspace,f.project.id).generation);
  assert.equal(await readUntil(text=>/event: fenced/.test(text)),true,'revocation fences the stream');
  controller.abort();
  const frames=parseFrames(buffer);
  assert.ok(frames.some(frame=>frameName(frame)==='page'));
  assert.ok(frames.some(frame=>frameName(frame)==='heartbeat'));
  const fenced=frames.find(frame=>frameName(frame)==='fenced');
  assert.ok(fenced);
  assert.equal(fenced.includes('data: {}'),true,'fenced frame carries no contents');
});
