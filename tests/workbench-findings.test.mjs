import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchExecution,createExecutionGate} from '../server/workbench-execution.mjs';
import {parseTestResults} from '../server/workbench-checks.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

function fixture(t,source="import test from 'node:test'; test('real',()=>{});"){
  const root=fs.mkdtempSync('/tmp/opencode/wb-findings-'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'proof.test.mjs'),source);
  fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum=(a,b)=>a+b;');
  const store=new SqliteWorkspaceStore(path.join(root,'private')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Fixture',identity:opened.identity});opened.close();
  const gate=createExecutionGate();let execution=createWorkbenchExecution({store,records,data,gate});
  const call=(action,fields={})=>execution.dispatch({action,workspace_id,project_id:project.id,...fields});
  const prepare=async(definition='node-test')=>{
    const {task}=await call('task_create',{title:'Fixture',acceptance_statement:'Run required tests',check_definition_id:definition,profile_id:'default',session_id:'fixture'});
    const p=await call('candidate_preview',{task_id:task.id});
    return (await call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest})).candidate;
  };
  const request=async(candidate,definition='node-test')=>{const p=await call('check_preview',{candidate_id:candidate.id,definition_id:definition});return {candidate_id:candidate.id,preview_id:p.preview_id,preview_digest:p.preview.spec_digest,op_id:randomUUID()};};
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {store,data,records,project,projectRoot,workspace_id,gate,call,prepare,request,get execution(){return execution;},restart(){execution.close();execution=createWorkbenchExecution({store,records,data,gate:createExecutionGate()});}};
}

test('B: zero-exit empty node test file must not pass',async t=>{
  const f=fixture(t,'console.log("fake tests 1 pass 1");');const c=await f.prepare();
  const result=await f.call('check_run',await f.request(c));assert.notEqual(result.evidence.verdict,'pass');
});
test('C: op_id replay with changed candidate conflicts',async t=>{
  const f=fixture(t),c=await f.prepare(),request=await f.request(c);await f.call('check_run',request);
  const other=await f.prepare();await assert.rejects(f.call('check_run',{...request,candidate_id:other.id}),{code:'stale_resource'});
});
test('D: re-registration fences old result and permits new generation before and after restart',async t=>{
  const f=fixture(t,"import test from 'node:test';test('slow',async()=>{await new Promise(r=>setTimeout(r,250));});"),c=await f.prepare();
  const running=f.call('check_run',await f.request(c));
  f.records.revoke(f.workspace_id,f.project.id,f.project.generation);f.execution.onRevoke(f.project.id);
  const opened=openProjectRoot(f.projectRoot);f.records.register(f.workspace_id,{root:f.projectRoot,name:'Fixture',identity:opened.identity});opened.close();
  assert.equal((await running).evidence.verdict,'inconclusive');
  const fresh=await f.prepare();assert.equal((await f.call('check_run',await f.request(fresh))).evidence.verdict,'pass');
  f.restart();const newer=await f.prepare();assert.equal((await f.call('check_run',await f.request(newer))).evidence.verdict,'pass');
});
test('E: evidence persistence failure leaves recoverable pending result and releases settled process lane',async t=>{
  const f=fixture(t),c=await f.prepare(),request=await f.request(c),create=f.data.create.bind(f.data);
  f.data.create=(kind,...args)=>{if(kind==='evidence')throw Error('injected storage failure');return create(kind,...args);};
  await f.call('check_run',request).catch(()=>{});
  const state=await f.call('execution_state');assert.equal(state.jobs[0].status,'finalization_pending');assert.equal(f.gate.busy('job'),false);
  f.data.create=create;
  const result=await f.call('job_finalize_retry',{job_id:state.jobs[0].id});assert.equal(result.evidence.verdict,'pass');
  const again=await f.call('job_finalize_retry',{job_id:state.jobs[0].id});assert.equal(again.evidence.id,result.evidence.id);
  assert.equal(f.data.list('jobs',f.workspace_id,f.project.id).length,1);
});

for(const [name,source] of [
  ['all skipped',"import test from 'node:test';test.skip('skip',()=>{});"],
  ['all TODO',"import test from 'node:test';test.todo('todo');"],
  ['empty suite',"import {describe} from 'node:test';describe('empty',()=>{});"],
  ['early zero exit',"process.exit(0);"],
  ['stdout protocol spoof','console.log(JSON.stringify({version:1,type:"end",tests:99,passed:99}));'],
])test(`B: ${name} is never passing evidence`,async t=>{
  const f=fixture(t,source),c=await f.prepare();const result=await f.call('check_run',await f.request(c));
  assert.notEqual(result.evidence.verdict,'pass');
});
test('B: structured runner counts actual tests once, excludes suites and separates candidate stdout',async t=>{
  const f=fixture(t,"import {test,describe} from 'node:test';describe('suite',()=>{test('one',()=>console.log('tests 9000 pass 9000'));test('two',()=>{});test.skip('skip',()=>{});});"),c=await f.prepare();
  const result=await f.call('check_run',await f.request(c));assert.equal(result.evidence.verdict,'pass');
  assert.equal(result.evidence.test_results.tests,3);assert.equal(result.evidence.test_results.passed,2);assert.equal(result.evidence.test_results.suites,1);
  assert.match(result.evidence.stdout_preview,/tests 9000/);
});
test('B: immutable task discovery refuses removal before check preview',async t=>{
  const f=fixture(t);const {task}=await f.call('task_create',{title:'Pinned',acceptance_statement:'Keep required tests',check_definition_id:'node-test',profile_id:'default',session_id:'fixture'});
  assert.deepEqual(task.acceptance.required_test_files,['proof.test.mjs']);
  fs.unlinkSync(path.join(f.projectRoot,'proof.test.mjs'));
  const p=await f.call('candidate_preview',{task_id:task.id});
  const {candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});
  await assert.rejects(f.request(candidate),{code:'stale_resource'});
});
test('B: a passing file cannot mask a second empty required file',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.projectRoot,'empty.test.mjs'),'console.log("nothing ran");');
  const c=await f.prepare(),result=await f.call('check_run',await f.request(c));
  assert.notEqual(result.evidence.verdict,'pass');assert.equal(result.evidence.test_results.complete,false);
});
test('B: missing, malformed, truncated and duplicate structured protocol cannot pass',()=>{
  for(const text of ['', '{}\n', '{broken\n', JSON.stringify({version:1,sequence:0,type:'start',files:['proof.test.mjs']}), '{"version":1,"sequence":0,"type":"end"}\n'])assert.equal(parseTestResults(Buffer.from(text),['proof.test.mjs']).success,false);
});
test('C: historical exact retry survives candidate edits, preserves fresh preview and conflicts on changed digest',async t=>{
  const f=fixture(t),c=await f.prepare(),request=await f.request(c),first=await f.call('check_run',request);
  const read=await f.call('candidate_read',{candidate_id:c.id,path:'math.js'});
  const edited=await f.call('candidate_edit',{candidate_id:c.id,path:'math.js',expected_hash:read.file.hash,content:'export const sum=(a,b)=>b+a;'});
  const fresh=await f.request(edited.candidate);
  const replay=await f.call('check_run',{...request,preview_id:fresh.preview_id});assert.equal(replay.job.id,first.job.id);assert.equal(replay.idempotent,true);
  await assert.rejects(f.call('check_run',{...fresh,op_id:request.op_id}),{code:'stale_resource'});
  assert.equal((await f.call('check_run',fresh)).evidence.verdict,'pass');
});
test('E: task-update failure rolls back evidence and job together, recovery across restart never respawns',async t=>{
  const f=fixture(t),c=await f.prepare(),request=await f.request(c),update=f.data.update.bind(f.data);
  f.data.update=(kind,...args)=>{if(kind==='tasks')throw Error('task write failure');return update(kind,...args);};
  const pending=await f.call('check_run',request);assert.equal(pending.job.status,'finalization_pending');
  assert.equal(f.data.list('evidence',f.workspace_id,f.project.id).length,0);
  assert.equal((await f.call('check_run',request)).job.id,pending.job.id);
  f.data.update=update;f.restart();
  const result=await f.call('job_finalize_retry',{job_id:pending.job.id});assert.equal(result.evidence.verdict,'pass');
  assert.equal(f.data.list('jobs',f.workspace_id,f.project.id).length,1);
});
test('E: pending-guard SQLite failure journals observed result privately and survives restart',async t=>{
  const f=fixture(t),c=await f.prepare(),request=await f.request(c),update=f.data.update.bind(f.data);
  f.data.update=(kind,...args)=>{if(kind==='jobs'&&args.at(-1).status==='finalization_pending')throw Error('pending write failure');return update(kind,...args);};
  const pending=await f.call('check_run',request);assert.equal(pending.finalization_pending,true);assert.equal(f.execution.health().healthy,false);
  const journal=path.join(f.store.root,'workbench-execution','pending',pending.job.id+'.json');assert.equal(fs.statSync(journal).mode&0o777,0o600);
  assert.equal(f.gate.busy('job'),false);
  const fresh=await f.request(c);await assert.rejects(f.call('check_run',fresh),{code:'unavailable'});
  f.data.update=update;f.restart();
  const result=await f.call('job_finalize_retry',{job_id:pending.job.id});assert.equal(result.evidence.verdict,'pass');assert.equal(fs.existsSync(journal),false);
  assert.equal(f.data.list('jobs',f.workspace_id,f.project.id).length,1);
});
test('E: durable starting-record failure never spawns and leaves admission usable',async t=>{
  const f=fixture(t),c=await f.prepare(),request=await f.request(c),create=f.data.create.bind(f.data);
  f.data.create=(kind,...args)=>{if(kind==='jobs')throw Error('starting write failure');return create(kind,...args);};
  await assert.rejects(f.call('check_run',request),/starting write failure/);assert.equal(f.gate.busy('job'),false);assert.equal(f.execution.activeChecks(),0);
  f.data.create=create;assert.equal(f.data.list('jobs',f.workspace_id,f.project.id).length,0);
  assert.equal((await f.call('check_run',await f.request(c))).evidence.verdict,'pass');
});
test('E: spawn-record failure is observed, settled, never passes or silently duplicates',async t=>{
  const f=fixture(t,"import test from 'node:test';test('slow',async()=>{await new Promise(r=>setTimeout(r,500));});"),c=await f.prepare(),request=await f.request(c),update=f.data.update.bind(f.data);
  f.data.update=(kind,...args)=>{if(kind==='jobs'&&args.at(-1).status==='running')throw Error('spawn write failure');return update(kind,...args);};
  const result=await f.call('check_run',request);assert.notEqual(result.evidence.verdict,'pass');assert.equal(result.evidence.spawn_error,'spawn_record_failed');
  assert.equal(f.execution.activeChecks(),0);assert.equal(f.gate.busy('job'),false);
  assert.equal((await f.call('check_run',request)).job.id,result.job.id);assert.equal(f.data.list('jobs',f.workspace_id,f.project.id).length,1);
});
test('candidate mutation is refused while a real child is in flight',async t=>{
  const f=fixture(t,"import test from 'node:test';test('slow',async()=>{await new Promise(r=>setTimeout(r,200));});"),c=await f.prepare(),request=await f.request(c);
  const read=await f.call('candidate_read',{candidate_id:c.id,path:'math.js'}),running=f.call('check_run',request);
  await assert.rejects(f.call('candidate_edit',{candidate_id:c.id,path:'math.js',expected_hash:read.file.hash,content:'export const sum=()=>0;'}),{code:'busy'});
  await assert.rejects(f.call('candidate_apply',{candidate_id:c.id,expected_candidate_hash:c.hash,changes:[{op:'delete',path:'math.js',expected_hash:read.file.hash}]}),{code:'busy'});
  assert.equal((await running).evidence.verdict,'pass');
});
test('candidate_apply atomically publishes create/change/delete, retains historical root and runs exact new tree',async t=>{
  const f=fixture(t),c=await f.prepare();const before=f.data.get('candidates',f.workspace_id,f.project.id,c.id);
  const first=await f.call('check_run',await f.request(c));
  const immutable=f.data.get('evidence',f.workspace_id,f.project.id,first.evidence.id);
  const result=await f.call('candidate_apply',{candidate_id:c.id,expected_candidate_hash:c.hash,changes:[
    {op:'create',path:'nested/new.bin',expected_hash:null,content_base64:'AAEC'},
    {op:'delete',path:'math.js',expected_hash:c.files.find(file=>file.path==='math.js').hash},
    {op:'change',path:'proof.test.mjs',expected_hash:c.files.find(file=>file.path==='proof.test.mjs').hash,content:"import test from 'node:test';test('new',()=>{});"},
  ]});
  const after=f.data.get('candidates',f.workspace_id,f.project.id,c.id);
  assert.notEqual(after.root,before.root);assert.equal(after.root_history[0].root,before.root);assert.equal(fs.existsSync(path.join(before.root,'math.js')),true);
  assert.equal(fs.existsSync(path.join(after.root,'math.js')),false);assert.deepEqual(fs.readFileSync(path.join(after.root,'nested/new.bin')),Buffer.from([0,1,2]));
  assert.equal(Object.hasOwn(result.candidate,'root_history'),false);assert.equal(Object.hasOwn(result.candidate,'root'),false);
  assert.deepEqual(f.data.get('evidence',f.workspace_id,f.project.id,first.evidence.id),immutable);
  assert.equal(f.data.list('annotations',f.workspace_id,f.project.id).filter(entry=>entry.evidence_id===immutable.id).length,1);
  assert.equal((await f.call('execution_state')).evidence.find(entry=>entry.id===immutable.id).superseded,true);
  assert.equal((await f.call('check_run',await f.request(result.candidate))).evidence.verdict,'pass');
  await assert.rejects(f.call('candidate_apply',{candidate_id:c.id,expected_candidate_hash:c.hash,changes:[{op:'create',path:'stale.txt',expected_hash:null,content:'stale'}]}),{code:'stale_resource'});
});
test('candidate_apply rolls back SQLite pointer and removes only failed staged copy on persistence fault',async t=>{
  const f=fixture(t),c=await f.prepare(),before=f.data.get('candidates',f.workspace_id,f.project.id,c.id),update=f.data.update.bind(f.data);
  const directory=path.dirname(before.root),roots=fs.readdirSync(directory).sort();
  f.data.update=(kind,...args)=>{if(kind==='candidates')throw Error('candidate write failure');return update(kind,...args);};
  await assert.rejects(f.call('candidate_apply',{candidate_id:c.id,expected_candidate_hash:c.hash,changes:[{op:'create',path:'new.txt',expected_hash:null,content:'new'}]}),/candidate write failure/);
  assert.equal(f.data.get('candidates',f.workspace_id,f.project.id,c.id).root,before.root);assert.deepEqual(fs.readdirSync(directory).sort(),roots);
  f.data.update=update;
  assert.equal((await f.call('check_run',await f.request(c))).evidence.verdict,'pass');
});
test('candidate_apply cannot remove pinned tests or smuggle conflicting binary/text payloads',async t=>{
  const f=fixture(t),c=await f.prepare();
  await assert.rejects(f.call('candidate_apply',{candidate_id:c.id,expected_candidate_hash:c.hash,changes:[{op:'delete',path:'proof.test.mjs',expected_hash:c.files.find(file=>file.path==='proof.test.mjs').hash}]}),{code:'stale_resource'});
  await assert.rejects(f.call('candidate_apply',{candidate_id:c.id,expected_candidate_hash:c.hash,changes:[{op:'create',path:'new.txt',expected_hash:null,content:'text',content_base64:'AA=='}]}),{code:'invalid_request'});
  assert.equal((await f.call('check_run',await f.request(c))).evidence.verdict,'pass');
});
test('review cannot cherry-pick an older pass after the latest required check failed',async t=>{
  const f=fixture(t),marker=path.join(path.dirname(f.projectRoot),'ran-once');
  fs.writeFileSync(path.join(f.projectRoot,'proof.test.mjs'),`import test from 'node:test';import fs from 'node:fs';test('flaky',()=>{if(fs.existsSync(${JSON.stringify(marker)}))throw Error('second run fails');fs.writeFileSync(${JSON.stringify(marker)},'ran');});`);
  const c=await f.prepare(),first=await f.call('check_run',await f.request(c));assert.equal(first.evidence.verdict,'pass');
  const ready=await f.call('candidate_get',{candidate_id:c.id});
  assert.equal((await f.call('check_run',await f.request(c))).evidence.verdict,'fail');
  await assert.rejects(f.call('review_decide',{candidate_id:c.id,evidence_ids:[first.evidence.id],decision:'approved',expected_identity:ready.review_identity}),{code:'stale_resource'});
});
