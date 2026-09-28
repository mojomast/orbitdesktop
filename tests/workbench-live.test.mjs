import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomUUID,createHash,createHmac} from 'node:crypto';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchLive,projectWorkbenchEvent} from '../server/workbench-live.mjs';
import {createWorkbenchLiveHandler} from '../server/workbench-live-route.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {createWorkbenchNative} from '../server/workbench-native.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {HERMES_NATIVE_CONTRACT} from '../contracts/workbench-native-v1.mjs';
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

test('historical review detail resolves only its recorded hash in server-retained history',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,project_generation:f.project.generation,generation:3,hash:'c'.repeat(64),root_history:[{generation:1,hash:'a'.repeat(64)},{generation:2,hash:'b'.repeat(64)}]});
  const review=f.data.create('reviews',{...scope,project_generation:f.project.generation,candidate_id:candidate.id,candidate_hash:'b'.repeat(64),decision:'approved',evidence_ids:[]});
  const request={...scope,reference:{kind:'review',id:review.id}};
  const result=await f.live.detail(request);
  assert.deepEqual(result.candidate_reference,{kind:'candidate',id:candidate.id,generation:2,hash:'b'.repeat(64)});
  f.data.update('candidates',f.workspace,f.project.id,candidate.id,candidate.revision,{root_history:[]});
  const missing=await f.live.detail(request);
  assert.equal(missing.candidate_reference,undefined,'never resolve to current generation 3');
  assert.equal(missing.verified,false);
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
  assert.equal(f.store.db.pragma('user_version',{simple:true}),9);
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
  // The owner candidate create predates the attempt and cannot be proven to it,
  // so it stays project-scoped rather than being borrowed by the attempt.
  assert.deepEqual(attemptPage.events.map(event=>event.kind),['attempt','grant','grant','toolcall','toolcall']);
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

test('a retained project cursor continues while a sibling attempt-bucket gap is advertised incomplete',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  for(let i=0;i<5;i++)f.data.create('annotations',{...scope,kind:`n${i}`});
  assert.equal(f.live.page({...scope,after_sequence:0,limit:2}).projection_incomplete,false);
  // Simulate a pruned attempt bucket without 2000 rows of churn.
  const writer=new Database(f.live.filename);
  try{writer.prepare('INSERT INTO live_floors(workspace_id,project_id,attempt_key,floor) VALUES(?,?,?,?) ON CONFLICT(workspace_id,project_id,attempt_key) DO UPDATE SET floor=excluded.floor').run(f.workspace,f.project.id,'attempt-x',3);}finally{writer.close();}
  const page=f.live.page({...scope,after_sequence:0,limit:2});
  assert.equal(page.reset_required,false,'a retained cursor must not reset because another bucket pruned');
  assert.equal(page.projection_incomplete,true,'the sibling bucket gap is still advertised');
  assert.equal(page.events[0].sequence,1);
});

test('mixed-bucket project pages drain with strictly increasing cursors and no repeated reset',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  for(let i=0;i<100;i++)f.data.create('annotations',{...scope,kind:`n${i}`});
  const writer=new Database(f.live.filename);
  try{
    const template=writer.prepare('SELECT event_json FROM live_events WHERE workspace_id=? AND project_id=? ORDER BY seq LIMIT 1').get(f.workspace,f.project.id).event_json;
    const insert=writer.prepare('INSERT INTO live_events(seq,workspace_id,project_id,attempt_id,kind,record_id,revision,phase,project_generation,at,event_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    for(let i=0;i<10;i++)insert.run(5001+i,f.workspace,f.project.id,'attempt-x','annotations',randomUUID(),1,'snapshot',null,1,template);
    writer.prepare('INSERT INTO live_floors(workspace_id,project_id,attempt_key,floor) VALUES(?,?,?,?)').run(f.workspace,f.project.id,'attempt-x',5000);
  }finally{writer.close();}
  let cursor=0,resets=0,seen=0,guard=0;const seqs=[];
  for(;;){
    const page=f.live.page({...scope,after_sequence:cursor,limit:2});
    if(page.reset_required)resets++;
    assert.ok(page.after_sequence>=cursor,'cursor never moves backwards');
    for(const event of page.events)seqs.push(event.sequence);
    cursor=page.after_sequence;seen+=page.events.length;
    if(!page.has_more)break;
    if(++guard>500)throw new Error('paging did not terminate');
  }
  assert.equal(resets,0,'retained cursors must not reset repeatedly on a sibling-bucket floor');
  assert.equal(seen,110);
  assert.equal(new Set(seqs).size,110,'no page replays already-delivered rows');
  for(let i=1;i<seqs.length;i++)assert.ok(seqs[i]>seqs[i-1],'ordered, strictly increasing sequence');
  assert.equal(f.live.page({...scope,after_sequence:0,limit:2}).projection_incomplete,true,'gap advertised while below the pruned floor');
  assert.equal(f.live.page({...scope,after_sequence:5001,limit:2}).projection_incomplete,false,'past the floor the scope is complete again');
});

test('a stale project cursor below the oldest retained row resets exactly once then continues',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  for(let i=0;i<100;i++)f.data.create('annotations',{...scope,kind:`n${i}`});
  const writer=new Database(f.live.filename);
  try{writer.prepare('DELETE FROM live_events WHERE workspace_id=? AND project_id=? AND seq<=50').run(f.workspace,f.project.id);writer.prepare('INSERT INTO live_floors(workspace_id,project_id,attempt_key,floor) VALUES(?,?,?,?)').run(f.workspace,f.project.id,'',50);}finally{writer.close();}
  const first=f.live.page({...scope,after_sequence:0,limit:2});
  assert.equal(first.reset_required,true);
  assert.equal(first.projection_incomplete,true);
  assert.equal(first.events[0].sequence,51,'reset replays from the oldest retained row');
  const second=f.live.page({...scope,after_sequence:first.after_sequence,limit:2});
  assert.equal(second.reset_required,false,'the retained cursor continues without resetting again');
  assert.equal(second.events[0].sequence,first.after_sequence+1);
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
  assert.equal(floorReset.projection_incomplete,true);
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
  assert.equal(auth('patches',{status:'available',verification:{status:'verified'}}),'recorder','verified artifact is recorder-authoritative');
  assert.equal(auth('patches',{status:'available',verification:{status:'verifying'}}),'observed');
  assert.equal(auth('patches',{status:'preparing'}),'observed');
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
  // An owner candidate create with no proven native mutation stays related and
  // is not borrowed into the attempt timeline.
  const candidateEvent=f.live.page(scope).events.find(event=>event.kind==='candidate');
  assert.ok(candidateEvent.fields.some(field=>field.label==='origin'&&field.value==='related_snapshot'));
});

test('an unproven or shared candidate generation is never attributed to an attempt and fails closed in detail',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attemptA=f.data.create('attempts',{...scope,status:'created',candidate_id:candidate.id,candidate_hash:candidate.hash});
  f.data.create('attempts',{...scope,status:'created',candidate_id:candidate.id,candidate_hash:candidate.hash});
  const review=f.data.create('reviews',{...scope,candidate_id:candidate.id,candidate_hash:candidate.hash,decision:'approved',evidence_ids:[]});
  const attemptEvents=f.live.page({...scope,attempt_id:attemptA.id}).events;
  assert.ok(!attemptEvents.some(event=>event.reference?.id===review.id),'shared candidate review is not attributed to one attempt');
  await assert.rejects(()=>f.live.detail({...scope,attempt_id:attemptA.id,reference:{kind:'review',id:review.id}}),{code:'permission_denied'});
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
   const jobA=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id,provenance:{initiated_by:{kind:'native_agent',attempt_id:attemptA.id}}});
   f.data.create('jobs',{...scope,status:'running',definition_id:'host-regression',candidate_id:candB.id});
   const anotherAttempt=f.data.create('attempts',{...scope,status:'created',candidate_id:candA.id,candidate_hash:candA.hash});
   f.data.create('jobs',{...scope,status:'failed',definition_id:'node-test',candidate_id:candA.id,provenance:{initiated_by:{kind:'native_agent',attempt_id:anotherAttempt.id}}});
   f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id,provenance:{initiated_by:{kind:'owner_action'}}});
   const grant=f.data.create('grants',{...scope,attempt_id:attemptA.id,candidate_id:candA.id,status:'running',calls_used:8,checks_used:1,repairs_used:1,budget:{calls:24,checks:3,duration_ms:180000,repair_iterations:2},started_at:Date.now(),recipient:{native_runtime:{model:'deepseek-flash'}}});
  const snap=f.live.snapshot({...scope,attempt_id:attemptA.id});
  assert.equal(snap.scope,'attempt');
  assert.equal(snap.candidate.id,candA.id);
   assert.equal(snap.job.candidate_id,candA.id);
   assert.equal(snap.job.id,jobA.id,'another attempt or owner check cannot replace the current worker job');
   assert.equal(snap.attempt_jobs,1);
   assert.deepEqual(snap.grant.budget,grant.budget);
   assert.equal(snap.grant.model,'deepseek-flash');assert.equal(snap.grant.repairs_used,1);
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
  assert.equal(tool.verified,false,'a recorded tool call is metadata, not verification');
  assert.ok(!JSON.stringify(tool).includes('SENTINEL_ARGS'));
  assert.equal(tool.fields.args_digest,'1'.repeat(64));

  const evidence=f.data.create('evidence',{...scope,verdict:'pass',exit_code:0,log_path:'/private/secret/output.log',log_bytes:10,log_hash:'3'.repeat(64),artifact_hash:'4'.repeat(64),candidate_id:candidateId,candidate_hash_after:'b'.repeat(64)});
  const observed=await f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'evidence',id:evidence.id}});
  assert.equal(observed.mode,'evidence_record');
  assert.equal(observed.verified,true,'structured evidence is recorder-authoritative');
  assert.ok(!JSON.stringify(observed).includes('/private/secret'));

  // Exact retained-generation comparison, sourced from the committed candidate.
  const diff=await f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'candidate',id:candidateId,candidate_id:candidateId,generation:2,hash:'b'.repeat(64)}});
  assert.equal(diff.mode,'candidate_generation_diff');
  assert.equal(diff.available,true);
  assert.equal(diff.not_diff,false);
  assert.equal(diff.exact,true);
  assert.equal(diff.verified,false,'an exact comparison is not recorder evidence');
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
  assert.equal(result.verified,false,'a host-recorded receipt is not a check verification');
  assert.ok(!JSON.stringify(result).includes('SECRET_REASONING'));
  assert.equal(result.fields.availability,'available');

  // A reference that belongs to the project but not this attempt must fail closed.
  const foreign=f.data.create('toolcalls',{...scope,attempt_id:otherId,grant_id:randomUUID(),action:'inspect',status:'completed'});
  await assert.rejects(()=>f.live.detail({workspace_id:f.workspace,project_id:f.project.id,attempt_id:attempt.id,reference:{kind:'toolcall',id:foreign.id}}),{code:'permission_denied'});

  // No source bytes ever enter durable/page events.
  assert.ok(!JSON.stringify(f.live.page({...scope,attempt_id:attempt.id}).events).includes('a+b'));
  // A later attempt can advance the same candidate without stealing the old
  // attempt's exact retained-generation reference.
  f.data.create('toolcalls',{...scope,attempt_id:attempt.id,grant_id:randomUUID(),candidate_id:candidateId,action:'candidate_patch',status:'completed',result_candidate:{id:candidateId,generation:2,hash:'b'.repeat(64)}});
  const newer=f.data.create('attempts',{...scope,status:'created',candidate_id:candidateId,candidate_hash:'c'.repeat(64)});
  f.data.update('candidates',f.workspace,f.project.id,candidateId,candidate.revision,{generation:3,hash:'c'.repeat(64),root_history:[...candidate.root_history,{root:'/private/retained/gen2',generation:2,hash:'b'.repeat(64)}]});
  const historical=await f.live.detail({...scope,attempt_id:attempt.id,reference:{kind:'candidate',id:candidateId,generation:2,hash:'b'.repeat(64)}});
  assert.equal(historical.available,true);assert.equal(historical.to.generation,2);
  await assert.rejects(f.live.detail({...scope,attempt_id:newer.id,reference:{kind:'candidate',id:candidateId,generation:2,hash:'b'.repeat(64)}}),{code:'permission_denied'});
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

const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('tail anchors to the recorded log identity and never cross-discloses',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const mk=(name,body)=>{const dir=path.join(f.live.artifactRoot,name);fs.mkdirSync(dir,{recursive:true,mode:0o700});const log=path.join(dir,'output.log');fs.writeFileSync(log,body,{mode:0o600});return {dir,log,identity:identityFor(log)};};
  const candA=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const candB=f.data.create('candidates',{...scope,generation:1,hash:'b'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attemptA=f.data.create('attempts',{...scope,status:'created',candidate_id:candA.id,candidate_hash:candA.hash});
  const attemptB=f.data.create('attempts',{...scope,status:'created',candidate_id:candB.id,candidate_hash:candB.hash});
  const jobA=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  const jobB=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candB.id});
  // Missing private identity fails closed; nothing is scanned or guessed.
  const unresolved=f.live.tail({...scope,job_id:jobA.id});
  assert.equal(unresolved.available,false);
  assert.equal(unresolved.reason,'unresolved');
  assert.equal(unresolved.verified,false);

  const a0=mk('check-alpha','ALPHA_ONLY'),b0=mk('check-bravo','BRAVO_ONLY'),decoy=mk('check-decoy','DECOY_SENTINEL');
  f.data.update('jobs',f.workspace,f.project.id,jobA.id,1,{artifact_log_path:a0.log,artifact_dir:a0.dir,artifact_log_identity:a0.identity});
  f.data.update('jobs',f.workspace,f.project.id,jobB.id,1,{artifact_log_path:b0.log,artifact_dir:b0.dir,artifact_log_identity:b0.identity});

  const a=f.live.tail({...scope,attempt_id:attemptA.id,job_id:jobA.id});
  assert.equal(a.available,true);
  assert.match(a.text,/ALPHA_ONLY/);
  assert.ok(!a.text.includes('BRAVO_ONLY')&&!a.text.includes('DECOY_SENTINEL'));
  const b=f.live.tail({...scope,attempt_id:attemptB.id,job_id:jobB.id});
  assert.match(b.text,/BRAVO_ONLY/);
  assert.ok(!b.text.includes('ALPHA_ONLY')&&!b.text.includes('DECOY_SENTINEL'));
  // A job may not be tailed through another attempt even in the same project.
  assert.throws(()=>f.live.tail({...scope,attempt_id:attemptA.id,job_id:jobB.id}),{code:'permission_denied'});

  // Path substitution: identity path pointing at another check dir while the
  // recorded parent inode is not that dir is refused, never read.
  const substituted=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.update('jobs',f.workspace,f.project.id,substituted.id,1,{artifact_log_path:b0.log,artifact_dir:b0.dir,artifact_log_identity:{...a0.identity,path:b0.log}});
  const substitutedTail=f.live.tail({...scope,job_id:substituted.id});
  assert.equal(substitutedTail.available,false);
  assert.match(substitutedTail.reason,/artifact_dir_replaced|replaced_log|unreadable/);
  assert.ok(!JSON.stringify(substitutedTail).includes('BRAVO_ONLY'));

  // Outside the trusted artifact root.
  const outside=path.join(f.root,'outside','output.log');fs.mkdirSync(path.dirname(outside),{recursive:true});fs.writeFileSync(outside,'ESCAPE_SENTINEL');
  const escaped=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.update('jobs',f.workspace,f.project.id,escaped.id,1,{artifact_log_path:outside,artifact_dir:path.dirname(outside),artifact_log_identity:{...a0.identity,path:outside}});
  const refused=f.live.tail({...scope,job_id:escaped.id});
  assert.equal(refused.available,false);
  assert.equal(refused.reason,'outside_artifact_root');
  assert.ok(!JSON.stringify(refused).includes('ESCAPE_SENTINEL'));

  // Deterministic replacement: preserve the original inode by renaming it away,
  // then recreate the recorded path. CI runners can reuse the freed inode, so
  // identity is pinned to the immutable creation identity (birthtimeNs), not
  // dev/ino alone.
  const replaced=mk('check-replaced','ORIGINAL_BYTES');
  const replacedJob=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.update('jobs',f.workspace,f.project.id,replacedJob.id,1,{artifact_log_path:replaced.log,artifact_dir:replaced.dir,artifact_log_identity:replaced.identity});
  const originalBirth=fs.statSync(replaced.log,{bigint:true}).birthtimeNs;
  fs.renameSync(replaced.log,`${replaced.log}.original`);
  fs.writeFileSync(replaced.log,'REPLACEMENT_BYTES',{mode:0o600});
  let replacementBirth=fs.statSync(replaced.log,{bigint:true}).birthtimeNs;
  for(let attempt=0;attempt<20&&replacementBirth===originalBirth;attempt++){await tick(5);fs.rmSync(replaced.log);fs.writeFileSync(replaced.log,'REPLACEMENT_BYTES',{mode:0o600});replacementBirth=fs.statSync(replaced.log,{bigint:true}).birthtimeNs;}
  assert.notEqual(replacementBirth,originalBirth,'recreated file must have a distinct creation identity');
  const replacedTail=f.live.tail({...scope,job_id:replacedJob.id});
  assert.equal(replacedTail.available,false);
  assert.match(replacedTail.reason,/replaced_log|replaced_during_read|unreadable/);
  assert.ok(!JSON.stringify(replacedTail).includes('REPLACEMENT_BYTES'));

  // Same dev/ino with a different creation identity is refused: proves
  // birthtime pinning even when the kernel reuses the inode.
  const pinned=mk('check-pinned','PINNED_BYTES');
  const pinnedJob=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  const forgedBirth={...pinned.identity,birthtime_ns:String(BigInt(pinned.identity.birthtime_ns)+1n)};
  f.data.update('jobs',f.workspace,f.project.id,pinnedJob.id,1,{artifact_log_path:pinned.log,artifact_dir:pinned.dir,artifact_log_identity:forgedBirth});
  const forgedTail=f.live.tail({...scope,job_id:pinnedJob.id});
  assert.equal(forgedTail.available,false);
  assert.equal(forgedTail.reason,'replaced_log');
  assert.ok(!JSON.stringify(forgedTail).includes('PINNED_BYTES'));

  // A historical identity without birthtime fails closed and is never read.
  const legacyJob=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  const legacyIdentity={path:pinned.log,dev:pinned.identity.dev,ino:pinned.identity.ino,dir_dev:pinned.identity.dir_dev,dir_ino:pinned.identity.dir_ino,root_dev:pinned.identity.root_dev,root_ino:pinned.identity.root_ino};
  f.data.update('jobs',f.workspace,f.project.id,legacyJob.id,1,{artifact_log_path:pinned.log,artifact_dir:pinned.dir,artifact_log_identity:legacyIdentity});
  const legacyTail=f.live.tail({...scope,job_id:legacyJob.id});
  assert.equal(legacyTail.available,false);
  assert.equal(legacyTail.reason,'untrusted_identity');
  assert.ok(!JSON.stringify(legacyTail).includes('PINNED_BYTES'));

  // Symlinked log is refused by O_NOFOLLOW.
  const linked=mk('check-linked','LINK_TARGET_BYTES');
  const linkedJob=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.update('jobs',f.workspace,f.project.id,linkedJob.id,1,{artifact_log_path:linked.log,artifact_dir:linked.dir,artifact_log_identity:linked.identity});
  const target=mk('check-target-dir','TARGET_SECRET');
  fs.unlinkSync(linked.log);fs.symlinkSync(target.log,linked.log);
  const linkedTail=f.live.tail({...scope,job_id:linkedJob.id});
  assert.equal(linkedTail.available,false);
  assert.ok(!JSON.stringify(linkedTail).includes('TARGET_SECRET'));

  // Symlinked parent directory is refused (O_DIRECTORY|O_NOFOLLOW anchor).
  const parent=mk('check-parent','PARENT_SECRET');
  const parentJob=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.update('jobs',f.workspace,f.project.id,parentJob.id,1,{artifact_log_path:parent.log,artifact_dir:parent.dir,artifact_log_identity:parent.identity});
  const elsewhere=mk('check-elsewhere','ELSEWHERE_SECRET');
  fs.rmSync(parent.dir,{recursive:true});fs.symlinkSync(elsewhere.dir,parent.dir);
  const parentTail=f.live.tail({...scope,job_id:parentJob.id});
  assert.equal(parentTail.available,false);
  assert.ok(!JSON.stringify(parentTail).includes('ELSEWHERE_SECRET'));

  // Cap and unverified labelling.
  const cap=mk('check-cap','x'.repeat(20000));
  const capJob=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:candA.id});
  f.data.update('jobs',f.workspace,f.project.id,capJob.id,1,{artifact_log_path:cap.log,artifact_dir:cap.dir,artifact_log_identity:cap.identity});
  const capTail=f.live.tail({...scope,job_id:capJob.id});
  assert.equal(capTail.cap_bytes,LIVE_LIMITS.tailBytes);
  assert.equal(Buffer.byteLength(capTail.text),LIVE_LIMITS.tailBytes);
  assert.equal(capTail.truncated,true);
  assert.equal(capTail.verified,false);
  assert.match(capTail.note,/Unverified tail/);
  assert.throws(()=>f.live.tail({...scope,job_id:f.workspace}),{code:'permission_denied'});
});

test('public job projections never expose private artifact coordinates',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const dir=path.join(f.live.artifactRoot,'check-private');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const log=path.join(dir,'output.log');fs.writeFileSync(log,'PRIVATE_BYTES',{mode:0o600});
  const job=f.data.create('jobs',{...scope,status:'running',definition_id:'node-test',candidate_id:randomUUID()});
  f.data.update('jobs',f.workspace,f.project.id,job.id,1,{artifact_log_path:log,artifact_dir:dir,artifact_log_identity:identityFor(log)});
  const execution=createWorkbenchExecution({store:f.store,records:f.records,data:f.data,gate:createWorkbenchGate()});
  t.after(()=>execution.close());
  const fetched=await execution.dispatch({action:'job_get',workspace_id:f.workspace,project_id:f.project.id,job_id:job.id});
  assert.equal(fetched.job.artifact_log_path,undefined);
  assert.equal(fetched.job.artifact_dir,undefined);
  assert.equal(fetched.job.artifact_log_identity,undefined);
  const state=await execution.dispatch({action:'execution_state',workspace_id:f.workspace,project_id:f.project.id});
  assert.ok(!JSON.stringify(state).includes('artifact_log_identity')&&!JSON.stringify(state).includes('check-private'));
});

// Trusted kernel identity for a private check log, as the recorder records it:
// dev/ino plus the immutable Linux creation identity (birthtimeNs) for the log
// and both parent directories, serialized as decimal strings.
function identityFor(logPath){
  const stat=fs.statSync(logPath,{bigint:true}),dir=path.dirname(logPath),dirStat=fs.statSync(dir,{bigint:true}),rootStat=fs.statSync(path.dirname(dir),{bigint:true});
  return {path:logPath,dev:String(stat.dev),ino:String(stat.ino),birthtime_ns:String(stat.birthtimeNs),dir_dev:String(dirStat.dev),dir_ino:String(dirStat.ino),dir_birthtime_ns:String(dirStat.birthtimeNs),root_dev:String(rootStat.dev),root_ino:String(rootStat.ino),root_birthtime_ns:String(rootStat.birthtimeNs)};
}

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

const WRONG_SUM='export const sum = (a,b) => a - b;\n';
const RIGHT_SUM='export const sum = (a,b) => a + b;\n';
function privateCall(channel,args,sequence=1,secret=channel.secret){
  const raw=JSON.stringify(args),mac=createHmac('sha256',secret).update(`${sequence}\n${raw}`).digest('hex');
  return new Promise((resolve,reject)=>{const req=http.request({socketPath:channel.socket,path:'/tool',method:'POST',headers:{'content-type':'application/json','x-orbit-grant':channel.grant_id,'x-orbit-sequence':String(sequence),'x-orbit-mac':mac}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(text)}));});req.on('error',reject);req.end(raw);});
}
function nativeFixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-live-native-');
  const projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'math.js'),WRONG_SUM);
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID(),pane_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Live native fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const data=new WorkbenchData(store),records=new WorkbenchStore(store);
  const opened=openProjectRoot(projectRoot),project=records.register(workspace_id,{root:projectRoot,name:'Live native',identity:opened.identity});opened.close();
  const gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate});
  const base={workspace_id,project_id:project.id};
  let channel=null;
  const hermes={quarantineNative:()=>true,acknowledgeNativeUnknown:()=>true,readBinding:async()=>({trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'native-fixture',config_generation:1,binding_revision:1,native_runtime:{kind:'local-pinned',commit:HERMES_NATIVE_CONTRACT.commit,model:'fixture',destination:'loopback configured model endpoint',configuration_hash:'0'.repeat(64)}}),startNative:async config=>{await config.authorize();channel=config.channel;return {completion:new Promise(()=>{})};},stopNative:async()=>({requested:true})};
  const native=createWorkbenchNative({store,records,data,execution,hermes});
  const live=createWorkbenchLive({store,records,data,gate,execution,native});
  t.after(()=>{live.close();native.close();execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,store,data,records,execution,native,live,base,getChannel:()=>channel,pane_id};
}
test('a real native candidate_patch records safe target/result and attributes the committed generation to its attempt',async t=>{
  const f=nativeFixture(t);
  const {task}=await f.execution.dispatch({...f.base,action:'task_create',title:'Repair a sum',acceptance_statement:'sum adds',check_definition_id:'host-regression',profile_id:'fixture',session_id:'native-fixture',pane_id:f.pane_id});
  const preview=await f.execution.dispatch({...f.base,action:'candidate_preview',task_id:task.id});
  const {candidate}=await f.execution.dispatch({...f.base,action:'candidate_create',task_id:task.id,preview_id:preview.preview_id,preview_digest:preview.preview.digest});
  const {attempt}=await f.execution.dispatch({...f.base,action:'attempt_create',task_id:task.id,candidate_id:candidate.id,profile_id:'fixture',session_id:'native-fixture',pane_id:f.pane_id});
  const grantPreview=await f.native.dispatch({...f.base,action:'preview',attempt_id:attempt.id,context_ids:[],budget:{calls:15,checks:1,duration_ms:90000}});
  const {grant}=await f.native.dispatch({...f.base,action:'approve',preview_id:grantPreview.preview_id,preview_digest:grantPreview.preview_digest});
  await f.native.dispatch({...f.base,action:'start',grant_id:grant.id});
  const channel=f.getChannel();
  assert.ok(channel,'native start handed the private channel');
  const fileHash=candidate.files.find(file=>file.path==='math.js').hash;
  const patched=await privateCall(channel,{action:'candidate_patch',expected_candidate_hash:candidate.hash,changes:[{op:'change',path:'math.js',expected_hash:fileHash,content:RIGHT_SUM}]});
  assert.equal(patched.ok,true,JSON.stringify(patched));
  const call=f.data.list('toolcalls',f.base.workspace_id,f.base.project_id).find(entry=>entry.action==='candidate_patch');
  assert.equal(call.status,'completed');
  assert.match(call.safe_target,/math\.js/,'safe request target is the whitelisted path, not raw arguments');
  assert.equal(call.result_candidate.id,candidate.id);
  assert.equal(call.result_candidate.generation,2);
  assert.ok(call.result_candidate.hash&&call.result_candidate.hash!==candidate.hash);
  const updatedCandidate=f.data.get('candidates',f.base.workspace_id,f.base.project_id,candidate.id);
  const newFileHash=updatedCandidate.files.find(file=>file.path==='math.js').hash;
  assert.deepEqual(call.result_changes,[{path:'math.js',op:'change',old_hash:fileHash,new_hash:newFileHash}]);
  assert.ok(!JSON.stringify(call).includes('a + b'),'no raw source content in the toolcall record');
  const page=f.live.page({...f.base,attempt_id:attempt.id});
  const mutation=page.events.find(event=>event.kind==='candidate'&&event.reference?.generation===2);
  assert.ok(mutation,'committed candidate generation is attributed to its attempt');
  assert.equal(mutation.authority,'observed');
  const toolEvent=page.events.find(event=>event.kind==='toolcall'&&event.reference?.candidate_id);
  assert.ok(toolEvent,'completed toolcall is projected');
  assert.equal(toolEvent.reference.candidate_id,candidate.id,'toolcall references the exact applied candidate generation');
  assert.equal(toolEvent.reference.generation,2);
  assert.equal(toolEvent.reference.hash,call.result_candidate.hash);
  assert.equal(toolEvent.fields.find(field=>field.label==='changed_files').value,1);
  assert.equal(toolEvent.fields.find(field=>field.label==='first_path').value,'math.js');
  assert.equal(toolEvent.fields.find(field=>field.label==='first_old').value,fileHash);
  assert.ok(toolEvent.target&&/math\.js/.test(toolEvent.target),'toolcall event exposes only the safe target');
  assert.ok(!JSON.stringify(page.events).includes('a + b'),'no source bytes in durable live events');
  const detail=await f.live.detail({...f.base,attempt_id:attempt.id,reference:{kind:'toolcall',id:call.id}});
  assert.equal(detail.verified,false);
  assert.equal(detail.changes[0].path,'math.js');
  assert.equal(detail.changes[0].old_hash,fileHash);
  assert.equal(detail.changes[0].new_hash,newFileHash);
  assert.equal(detail.result_candidate.generation,2);
  assert.ok(!JSON.stringify(detail).includes('a + b'),'per-file detail carries hashes only, never source');
});

test('recorder evidence counts are bounded and ordered, and raw output/args/model text never enter events',t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:1,hash:'a'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attempt=f.data.create('attempts',{...scope,status:'created',candidate_id:candidate.id,candidate_hash:candidate.hash});
  const job=f.data.create('jobs',{...scope,status:'completed',definition_id:'node-test',candidate_id:candidate.id,provenance:{version:1,initiated_by:{kind:'native_agent',attempt_id:attempt.id,grant_id:randomUUID()},authorized_by:{kind:'owner_grant'},recorded_by:{kind:'comet_service'}}});
  const files=Array.from({length:3},(_,index)=>`t${index}.test.mjs`);
  const evidence=f.data.create('evidence',{...scope,verdict:'pass',job_id:job.id,candidate_id:candidate.id,candidate_hash_after:candidate.hash,stdout_preview:'MODEL_CLAIM_59_OF_59',stderr_preview:'RAW_STDERR',command:{executable:'/usr/bin/node',args:['SECRET_ARG']},test_results:{version:1,valid:true,success:true,tests:60,passed:60,failed:0,skipped:0,todo:0,suites:0,required_files:files,covered_files:files,complete:true}});
  const event=f.live.page({...scope,attempt_id:attempt.id}).events.find(entry=>entry.reference?.id===evidence.id);
  assert.ok(event);
  assert.equal(event.authority,'recorder');
  assert.deepEqual(event.fields.slice(0,8).map(field=>field.label),['passed','tests','covered_files','required_files','failed','skipped','todo','complete']);
  const value=label=>event.fields.find(field=>field.label===label)?.value;
  assert.equal(value('passed'),60);assert.equal(value('tests'),60);assert.equal(value('covered_files'),3);assert.equal(value('required_files'),3);assert.equal(value('failed'),0);assert.equal(value('todo'),0);assert.equal(value('complete'),1);
  const json=JSON.stringify(f.live.page({...scope,attempt_id:attempt.id}));
  assert.ok(!json.includes('MODEL_CLAIM_59_OF_59')&&!json.includes('RAW_STDERR')&&!json.includes('SECRET_ARG'),'no raw output, args or model text in events');
});

test('a recorder-verified artifact is recorder-authoritative with bounded per-check counts',async t=>{
  const f=fixture(t),scope={workspace_id:f.workspace,project_id:f.project.id};
  const candidate=f.data.create('candidates',{...scope,generation:2,hash:'b'.repeat(64),files:[],total_bytes:0,status:'approved'});
  const attempt=f.data.create('attempts',{...scope,status:'created',candidate_id:candidate.id,candidate_hash:'b'.repeat(64)});
  const patch=f.data.create('patches',{...scope,status:'available',candidate_id:candidate.id,candidate_hash:candidate.hash,candidate_generation:2,artifact_hash:'c'.repeat(64),bytes:123,format:'git-unified-diff',verification:{version:1,id:randomUUID(),status:'verified',artifact_id:randomUUID(),candidate_id:candidate.id,candidate_hash:candidate.hash,candidate_generation:2,results:[{definition_id:'node-test',verdict:'pass',test_results:{version:1,tests:60,passed:60,failed:0,skipped:0,todo:0,required_files:['a'],covered_files:['a'],complete:true}}]}});
  const event=f.live.page({...scope,attempt_id:attempt.id}).events.find(entry=>entry.reference?.id===patch.id);
  assert.ok(event);
  assert.equal(event.authority,'recorder');
  const value=label=>event.fields.find(field=>field.label===label)?.value;
  assert.equal(value('verified_checks'),1);assert.equal(value('passed'),60);assert.equal(value('tests'),60);
  const detail=await f.live.detail({...scope,attempt_id:attempt.id,reference:{kind:'artifact',id:patch.id}});
  assert.equal(detail.verified,true);
  assert.equal(detail.fields.verification_status,'verified');
  assert.equal(detail.fields.verified_checks,1);
  assert.equal(detail.checks[0].test_results.passed,60);
  assert.equal(detail.checks[0].test_results.covered_files,1);
});

test('a real recorded check writes a birthtime identity and tail reads it, refusing replacement',async t=>{
  const root=fs.mkdtempSync('/tmp/opencode/workbench-live-check-'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum = (a,b) => a - b;\n');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Check tail fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const data=new WorkbenchData(store),records=new WorkbenchStore(store);
  const opened=openProjectRoot(projectRoot),project=records.register(workspace_id,{root:projectRoot,name:'Check tail',identity:opened.identity});opened.close();
  const gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate});
  const live=createWorkbenchLive({store,records,data,gate,execution});
  t.after(()=>{live.close();execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const base={workspace_id,project_id:project.id},call=(action,fields={})=>execution.dispatch({...base,action,...fields});
  const {task}=await call('task_create',{title:'Fix sum',acceptance_statement:'sum adds',check_definition_id:'host-regression',profile_id:'fixture',session_id:'sess'});
  const preview=await call('candidate_preview',{task_id:task.id});
  const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:preview.preview_id,preview_digest:preview.preview.digest});
  const spec=await call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  await call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.preview.spec_digest,op_id:randomUUID()});
  const job=data.list('jobs',workspace_id,project.id).at(-1);
  assert.ok(job.artifact_log_identity&&job.artifact_log_identity.birthtime_ns,'recorder persisted a private creation identity');
  assert.ok(BigInt(job.artifact_log_identity.birthtime_ns)>0n,'birthtime identity is positive');
  const tailed=live.tail({...base,job_id:job.id});
  assert.equal(tailed.available,true);
  assert.equal(tailed.verified,false);
  assert.match(tailed.note,/Unverified tail/);
  const logPath=job.artifact_log_identity.path;
  fs.renameSync(logPath,`${logPath}.original`);
  fs.writeFileSync(logPath,'REPLACED_CHECK_OUTPUT',{mode:0o600});
  const replaced=live.tail({...base,job_id:job.id});
  assert.equal(replaced.available,false);
  assert.ok(!JSON.stringify(replaced).includes('REPLACED_CHECK_OUTPUT'));
});
