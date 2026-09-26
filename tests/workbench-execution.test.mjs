import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {captureProject,openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchExecution,createExecutionGate} from '../server/workbench-execution.mjs';
import {removeCandidateWorkspace} from '../server/workbench-candidates.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const WRONG='export const sum = (a,b) => a - b;\n';
const RIGHT='export const sum = (a,b) => a + b;\n';
const SLOW_TEST="import test from 'node:test';\ntest('slow',async()=>{await new Promise(resolve=>setTimeout(resolve,4000));});\n";

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-execution-');
  const projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'math.js'),WRONG);
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID(),other=randomUUID();
  for(const id of [workspace_id,other])store.commit(commandIdentity({workspace_id:id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  let clock=1_000_000;const now=()=>clock;
  const data=new WorkbenchData(store,{now}),records=new WorkbenchStore(store);
  const opened=openProjectRoot(projectRoot);const project=records.register(workspace_id,{root:projectRoot,name:'Synthetic defect',identity:opened.identity});opened.close();
  const execution=createWorkbenchExecution({store,records,data,gate:createWorkbenchGate(),now});
  const call=(action,fields={})=>execution.dispatch({action,workspace_id,project_id:project.id,...fields});
  const rebuild=()=>createWorkbenchExecution({store,records,data,gate:createExecutionGate(),now});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,projectRoot,store,workspace_id,other,data,records,execution,call,rebuild,project,advance:()=>{clock+=1000;}};
}
async function prepare(f,{definition='host-regression',statement='sum(2,3)===5',title='Fix sum'}={}){
  const {task}=await f.call('task_create',{title,acceptance_statement:statement,check_definition_id:definition,profile_id:'default',session_id:'orbit-exec-fixture'});
  const preview=await f.call('candidate_preview',{task_id:task.id});
  const created=await f.call('candidate_create',{task_id:task.id,preview_id:preview.preview_id,preview_digest:preview.preview.digest});
  return {task,preview,created,candidate:created.candidate};
}
async function issueSpec(f,candidate_id,definition_id){
  const preview=await f.call('check_preview',{candidate_id,definition_id});
  return {preview,preview_id:preview.preview_id,spec_digest:preview.preview.spec_digest};
}
async function runCheck(f,candidate_id,definition_id){
  const issued=await issueSpec(f,candidate_id,definition_id);
  const result=await f.call('check_run',{candidate_id,preview_id:issued.preview_id,preview_digest:issued.spec_digest,op_id:randomUUID()});
  return {...result,...issued};
}
const privateCandidate=(f,id)=>f.data.get('candidates',f.workspace_id,f.project.id,id);

test('real wrong-sum defect: recorder fail -> exact repair -> pass -> human review (accept is not merge)',async t=>{
  const f=fixture(t);const {candidate}=await prepare(f);
  const read=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  assert.match(read.file.text,/a - b/);assert.equal(read.file.binary,false);
  const first=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  assert.equal(first.preview.candidate_hash,candidate.hash);assert.equal(first.preview.acceptance_version,1);
  assert.ok(first.preview_id);
  const job1=await f.call('check_run',{candidate_id:candidate.id,preview_id:first.preview_id,preview_digest:first.preview.spec_digest,op_id:randomUUID()});
  assert.equal(job1.evidence.verdict,'fail');assert.notEqual(job1.evidence.exit_code,0);
  assert.equal(job1.job.status,'failed');assert.equal(job1.job.candidate_hash,candidate.hash);
  assert.equal(job1.evidence.supervisor,'/usr/bin/timeout');
  const beforeEdit=await f.call('candidate_get',{candidate_id:candidate.id});
  await assert.rejects(f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[job1.evidence.id],decision:'approved',expected_identity:beforeEdit.review_identity}),{code:'stale_resource'});
  const edit=await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:read.file.hash,content:RIGHT});
  assert.equal(edit.candidate.generation,2);assert.notEqual(edit.candidate.hash,candidate.hash);
  assert.deepEqual(edit.superseded_evidence_ids,[job1.evidence.id]);
  await assert.rejects(f.call('check_run',{candidate_id:candidate.id,preview_id:first.preview_id,preview_digest:first.preview.spec_digest,op_id:randomUUID()}),{code:'stale_resource'});
  const second=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  assert.notEqual(second.preview.spec_digest,first.preview.spec_digest);
  const job2=await f.call('check_run',{candidate_id:candidate.id,preview_id:second.preview_id,preview_digest:second.preview.spec_digest,op_id:randomUUID()});
  assert.equal(job2.evidence.verdict,'pass');assert.equal(job2.evidence.exit_code,0);
  assert.equal(job2.evidence.candidate_hash_after,edit.candidate.hash);
  const ready=await f.call('candidate_get',{candidate_id:candidate.id});
  const review=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[job2.evidence.id],decision:'approved',expected_identity:ready.review_identity});
  assert.equal(review.review.decision,'approved');assert.equal(review.review.accept_is_merge,false);assert.equal(review.review.actor,'owner');
  const again=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[job2.evidence.id],decision:'approved',expected_identity:ready.review_identity});
  assert.equal(again.idempotent,true);
  const exportArtifact=await f.call('candidate_export',{candidate_id:candidate.id});
  assert.equal(exportArtifact.integration_supported,false);
  assert.match(exportArtifact.artifact.files.find(entry=>entry.path==='math.js').candidate_text,/a \+ b/);
  const state=await f.call('execution_state');
  assert.equal(state.reviews.length,1);assert.equal(state.tasks[0].status,'accepted');
  assert.ok(state.evidence.every(entry=>!Object.hasOwn(entry,'log_path')));
  assert.deepEqual(fs.readdirSync(f.projectRoot).sort(),['math.js']);
});

async function approvedPatch(t,{content=RIGHT}={}){
  const f=fixture(t),{candidate}=await prepare(f);
  const read=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  const changed=await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:read.file.hash,content});
  const checked=await runCheck(f,candidate.id,'host-regression');
  assert.equal(checked.evidence.verdict,'pass');
  const current=await f.call('candidate_get',{candidate_id:candidate.id});
  const {review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[checked.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const source=captureProject(f.project),privateRecord=privateCandidate(f,candidate.id);
  const privateRoot=path.join(f.store.root,'workbench-patches');fs.mkdirSync(privateRoot,{recursive:true});
  const stage=path.join(privateRoot,`.verify-${randomUUID()}`,'roundtrip');fs.mkdirSync(path.join(stage,'.git'),{recursive:true});
  fs.writeFileSync(path.join(stage,'math.js'),content);
  const privatePatch=path.join(privateRoot,`${randomUUID()}.patch`);fs.writeFileSync(privatePatch,'fixture patch');
  const patch=f.data.create('patches',{workspace_id:f.workspace_id,project_id:f.project.id,task_id:review.task_id,candidate_id:candidate.id,candidate_hash:changed.candidate.hash,candidate_generation:changed.candidate.generation,review_id:review.id,review_identity:review.review_identity,status:'preparing',artifact_hash:sha('fixture patch'),bytes:13,private_root:privatePatch,source:{manifest_hash:source.hash,files:source.manifest.map(file=>({...file,mode:'100644'}))},candidate:{files:privateRecord.files.map(file=>({path:file.path,hash:file.hash,bytes:file.bytes,mode:'100644'}))},review:{required_check_state:{acceptance_digest:current.candidate.acceptance_digest??f.data.get('tasks',f.workspace_id,f.project.id,review.task_id).acceptance_digest}},roundtrip:{verified:true}});
  return {f,patch,stage,privatePatch};
}

test('explicit patch artifact verification uses frozen checks without modifying candidate review evidence',async t=>{
  const {f,patch,stage,privatePatch}=await approvedPatch(t);
  const before=f.data.list('evidence',f.workspace_id,f.project.id);
  fs.writeFileSync(privatePatch,'altered patch');
  await assert.rejects(f.execution.verifyPatchArtifact({workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id,stage_root:stage}),{code:'stale_resource'});
  fs.writeFileSync(privatePatch,'fixture patch');
  fs.chmodSync(path.join(stage,'math.js'),0o700);
  await assert.rejects(f.execution.verifyPatchArtifact({workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id,stage_root:stage}),{code:'stale_resource'});
  assert.equal(f.data.get('patches',f.workspace_id,f.project.id,patch.id).status,'preparing');
  fs.chmodSync(path.join(stage,'math.js'),0o600);
  const result=await f.execution.verifyPatchArtifact({workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id,stage_root:stage});
  assert.equal(result.verification.status,'verified');assert.equal(result.verification.results.length,1);
  assert.equal(result.verification.results[0].verdict,'pass');
  assert.deepEqual(f.data.list('evidence',f.workspace_id,f.project.id),before);
  await assert.rejects(f.execution.verifyPatchArtifact({workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id,stage_root:stage}),{code:'stale_resource'});
});

test('known completed artifact result survives DB finalization fault and restarts with DB-only retry',async t=>{
  const {f,patch,stage}=await approvedPatch(t),scope={workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id};
  const original=f.data.update.bind(f.data);let injected=false;
  f.data.update=(kind,w,p,id,revision,fields)=>{
    if(!injected&&kind==='patches'&&id===patch.id&&fields.status==='verified'){injected=true;throw Object.assign(Error('fixture write fault'),{code:'unavailable'});}
    return original(kind,w,p,id,revision,fields);
  };
  try{await assert.rejects(f.execution.verifyPatchArtifact({...scope,stage_root:stage}),{code:'unavailable'});}
  finally{f.data.update=original;}
  assert.equal(injected,true);
  assert.equal(f.data.get('patches',f.workspace_id,f.project.id,patch.id).status,'verification_pending');
  const pendingRoot=path.join(f.store.root,'workbench-execution','patch-verification-pending');
  assert.ok(fs.existsSync(path.join(pendingRoot,`${patch.id}.json`)));
  const gate=createWorkbenchGate(),restarted=createWorkbenchExecution({store:f.store,records:f.records,data:f.data,gate});
  assert.throws(()=>gate.claim('job',randomUUID()),{code:'busy'});
  const state=restarted.patchArtifactRecovery(scope);assert.equal(state.recoverable,true);
  const before=fs.readdirSync(path.join(f.store.root,'workbench-execution')).filter(name=>name.startsWith('check-')).length;
  assert.throws(()=>restarted.retryPatchArtifact({...scope,expected_digest:'0'.repeat(64)}),{code:'stale_resource'});
  const result=restarted.retryPatchArtifact({...scope,expected_digest:state.recovery_digest});
  assert.equal(result.verification.status,'verified');assert.equal(result.replayed,true);
  assert.equal(result.idempotent,false);
  const repeated=restarted.retryPatchArtifact({...scope,expected_digest:state.recovery_digest});
  assert.equal(repeated.idempotent,true);assert.deepEqual(repeated.verification,result.verification);
  assert.throws(()=>restarted.retryPatchArtifact({...scope,expected_digest:'f'.repeat(64)}),{code:'stale_resource'});
  assert.throws(()=>restarted.retryPatchArtifact(scope),{code:'stale_resource'});
  assert.throws(()=>restarted.retryPatchArtifact({...scope,workspace_id:f.other,expected_digest:state.recovery_digest}),{code:'permission_denied'});
  const committed=f.data.get('patches',f.workspace_id,f.project.id,patch.id);
  f.data.update('patches',f.workspace_id,f.project.id,patch.id,committed.revision,{status:'available'});
  assert.equal(restarted.retryPatchArtifact({...scope,expected_digest:state.recovery_digest}).idempotent,true,'publisher promotion preserves the settled digest');
  const afterRestart=createWorkbenchExecution({store:f.store,records:f.records,data:f.data,gate:createWorkbenchGate()});
  assert.equal(afterRestart.retryPatchArtifact({...scope,expected_digest:state.recovery_digest}).idempotent,true,'a restart retains the exact processed digest');
  assert.equal(fs.readdirSync(path.join(f.store.root,'workbench-execution')).filter(name=>name.startsWith('check-')).length,before);
  assert.equal(gate.status().quarantines,undefined);gate.claim('job',randomUUID())();
  assert.equal(fs.existsSync(path.join(pendingRoot,`${patch.id}.json`)),false);
});

test('revoked project settles an observed patch journal without publishing or rerunning checks',async t=>{
  const {f,patch,stage}=await approvedPatch(t),scope={workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id};
  const original=f.data.update.bind(f.data);let injected=false;
  f.data.update=(kind,w,p,id,revision,fields)=>{
    if(!injected&&kind==='patches'&&id===patch.id&&fields.status==='verified'){injected=true;throw Object.assign(Error('fixture write fault'),{code:'unavailable'});}
    return original(kind,w,p,id,revision,fields);
  };
  try{await assert.rejects(f.execution.verifyPatchArtifact({...scope,stage_root:stage}),{code:'unavailable'});}finally{f.data.update=original;}
  f.records.revoke(f.workspace_id,f.project.id,f.project.generation);
  const gate=createWorkbenchGate(),restarted=createWorkbenchExecution({store:f.store,records:f.records,data:f.data,gate});
  assert.throws(()=>gate.claim('job',randomUUID()),{code:'busy'});
  const state=restarted.patchArtifactRecovery(scope),before=fs.readdirSync(path.join(f.store.root,'workbench-execution')).filter(name=>name.startsWith('check-')).length;
  assert.equal(state.recoverable,true);
  assert.throws(()=>restarted.retryPatchArtifact({...scope,expected_digest:'0'.repeat(64)}),{code:'stale_resource'});
  assert.throws(()=>gate.claim('job',randomUUID()),{code:'busy'});
  const result=restarted.retryPatchArtifact({...scope,expected_digest:state.recovery_digest});
  assert.equal(result.replayed,true);assert.equal(result.verification.status,'inconclusive');
  const replay=restarted.retryPatchArtifact({...scope,expected_digest:state.recovery_digest});
  assert.equal(replay.idempotent,true);assert.deepEqual(replay.verification,result.verification);
  const afterRestart=createWorkbenchExecution({store:f.store,records:f.records,data:f.data,gate:createWorkbenchGate()});
  assert.equal(afterRestart.retryPatchArtifact({...scope,expected_digest:state.recovery_digest}).idempotent,true);
  assert.throws(()=>restarted.retryPatchArtifact({...scope,expected_digest:'f'.repeat(64)}),{code:'stale_resource'});
  for(const forbidden of ['private_root','source','candidate','review','patch_text','text'])assert.equal(Object.hasOwn(replay,forbidden),false);
  assert.equal(f.data.get('patches',f.workspace_id,f.project.id,patch.id).status,'verification_failed');
  assert.equal(fs.readdirSync(path.join(f.store.root,'workbench-execution')).filter(name=>name.startsWith('check-')).length,before);
  gate.claim('job',randomUUID())();
  await assert.rejects(restarted.verifyPatchArtifact({...scope,stage_root:stage}),{code:'permission_denied'});
});

test('lost artifact journal after a child exit remains unknown until exact owner acknowledgment',async t=>{
  const {f,patch,stage}=await approvedPatch(t),scope={workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id};
  const original=fs.fsyncSync;let injected=false;
  fs.fsyncSync=fd=>{
    const target=fs.readlinkSync(`/proc/self/fd/${fd}`);
    if(!injected&&target.includes('patch-verification-pending')&&target.endsWith('.tmp')){injected=true;throw Object.assign(Error('journal fault'),{code:'EIO'});}
    return original(fd);
  };
  try{await assert.rejects(f.execution.verifyPatchArtifact({...scope,stage_root:stage}),{code:'EIO'});}
  finally{fs.fsyncSync=original;}
  assert.equal(injected,true);
  const state=f.execution.patchArtifactRecovery(scope);
  assert.equal(state.status,'outcome_unknown');assert.equal(state.recoverable,false);
  assert.throws(()=>f.execution.retryPatchArtifact({...scope,expected_digest:state.recovery_digest}),{code:'outcome_unknown'});
  assert.throws(()=>f.execution.acknowledgePatchArtifactUnknown({...scope,expected_digest:'0'.repeat(64),known_externally_terminated:true}),{code:'stale_resource'});
  assert.equal(f.execution.acknowledgePatchArtifactUnknown({...scope,expected_digest:state.recovery_digest,known_externally_terminated:true}).verification.status,'acknowledged_unknown');
});

test('revoked project unknown artifact requires digest-bound termination acknowledgment',async t=>{
  const {f,patch,stage}=await approvedPatch(t),scope={workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id};
  const original=fs.fsyncSync;let injected=false;
  fs.fsyncSync=fd=>{
    if(!injected&&fs.readlinkSync(`/proc/self/fd/${fd}`).includes('patch-verification-pending')&&fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('.tmp')){injected=true;throw Object.assign(Error('journal fault'),{code:'EIO'});}
    return original(fd);
  };
  try{await assert.rejects(f.execution.verifyPatchArtifact({...scope,stage_root:stage}),{code:'EIO'});}finally{fs.fsyncSync=original;}
  f.records.revoke(f.workspace_id,f.project.id,f.project.generation);
  const gate=createWorkbenchGate(),restarted=createWorkbenchExecution({store:f.store,records:f.records,data:f.data,gate});
  const state=restarted.patchArtifactRecovery(scope);assert.equal(state.status,'outcome_unknown');assert.equal(state.recoverable,false);
  assert.throws(()=>restarted.acknowledgePatchArtifactUnknown({...scope,expected_digest:'0'.repeat(64),known_externally_terminated:true}),{code:'stale_resource'});
  assert.throws(()=>gate.claim('job',randomUUID()),{code:'busy'});
  assert.equal(restarted.acknowledgePatchArtifactUnknown({...scope,expected_digest:state.recovery_digest,known_externally_terminated:true}).verification.status,'acknowledged_unknown');
  gate.claim('job',randomUUID())();
});

test('owner can cancel the internally owned artifact check and recorder settles a known failure',async t=>{
  const slow="await new Promise(resolve=>setTimeout(resolve,1800));\nexport const sum=(a,b)=>a+b;\n";
  const {f,patch,stage}=await approvedPatch(t,{content:slow}),scope={workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:patch.id};
  const running=f.execution.verifyPatchArtifact({...scope,stage_root:stage});
  let process;
  for(let i=0;i<200;i++){
    process=f.data.get('patches',f.workspace_id,f.project.id,patch.id).verification?.process;
    if(process?.pid)break;
    await sleep(10);
  }
  assert.ok(process?.pid);
  const pending=f.execution.patchArtifactRecovery(scope);
  assert.throws(()=>f.execution.acknowledgePatchArtifactUnknown({...scope,expected_digest:pending.recovery_digest,known_externally_terminated:true}),{code:'stale_resource'});
  f.records.revoke(f.workspace_id,f.project.id,f.project.generation);
  assert.equal(f.execution.cancelPatchArtifact(scope).requested,true);
  const result=await running;
  assert.equal(result.verification.status,'inconclusive');
  assert.equal(f.data.get('patches',f.workspace_id,f.project.id,patch.id).status,'verification_failed');
});

test('a restarted verifying patch receipt quarantines shared dispatch without rerunning checks',t=>{
  const f=fixture(t),artifact=f.data.create('patches',{workspace_id:f.workspace_id,project_id:f.project.id,status:'verifying',verification:{id:randomUUID(),status:'running',process:{job_id:randomUUID(),state:'starting'}}});
  const gate=createWorkbenchGate();
  const service=createWorkbenchExecution({store:f.store,records:f.records,data:f.data,gate});
  assert.throws(()=>gate.claim('job',randomUUID()),{code:'busy'});
  assert.throws(()=>gate.claim('agent',randomUUID()),{code:'busy'});
  assert.ok(gate.status().quarantines.includes(`patch-verification:${artifact.id}`));
  const current=f.data.get('patches',f.workspace_id,f.project.id,artifact.id);
  assert.equal(current.status,'outcome_unknown');
  const scope={workspace_id:f.workspace_id,project_id:f.project.id,artifact_id:artifact.id};
  const recovery=service.patchArtifactRecovery(scope);
  assert.equal(recovery.recoverable,false);assert.match(recovery.recovery_digest,/^[a-f0-9]{64}$/);
  assert.throws(()=>service.acknowledgePatchArtifactUnknown({...scope,expected_digest:'0'.repeat(64),known_externally_terminated:true}),{code:'stale_resource'});
  assert.throws(()=>service.acknowledgePatchArtifactUnknown({...scope,expected_digest:recovery.recovery_digest,known_externally_terminated:false}),{code:'stale_resource'});
  assert.equal(service.acknowledgePatchArtifactUnknown({...scope,expected_digest:recovery.recovery_digest,known_externally_terminated:true}).verification.status,'acknowledged_unknown');
  assert.equal(gate.status().quarantines,undefined);
  gate.claim('job',randomUUID())();
});

test('an approval is refused when the source target changed after candidate creation',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),RIGHT);
  const {candidate}=await prepare(f);
  const job=await runCheck(f,candidate.id,'host-regression');
  assert.equal(job.evidence.verdict,'pass');
  // The source target changes before the owner reviews; nothing is written back.
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),'export const sum = (a,b) => a * b;\n');
  const ready=await f.call('candidate_get',{candidate_id:candidate.id});
  assert.equal(ready.target_changed,true);
  await assert.rejects(f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[job.evidence.id],decision:'approved',expected_identity:ready.review_identity}),{code:'stale_resource'});
  const state=await f.call('execution_state');
  assert.equal(state.target_changed[candidate.id],true);
  const artifact=await f.call('candidate_export',{candidate_id:candidate.id});
  assert.equal(artifact.artifact.target_changed,true);
  assert.equal(artifact.artifact.files.find(entry=>entry.path==='math.js').source_state,'changed');
  assert.match(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),/a \* b/);
});

test('an out-of-band candidate edit after a passing check cannot be approved',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),RIGHT);
  const {candidate}=await prepare(f);
  const job=await runCheck(f,candidate.id,'host-regression');
  assert.equal(job.evidence.verdict,'pass');
  const ready=await f.call('candidate_get',{candidate_id:candidate.id});
  // The persisted hash still matches the evidence, but the actual private tree
  // was edited out of band; approval re-verifies the tree and refuses.
  fs.writeFileSync(path.join(privateCandidate(f,candidate.id).root,'math.js'),'export const sum = () => 999;\n');
  await assert.rejects(f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[job.evidence.id],decision:'approved',expected_identity:ready.review_identity}),{code:'stale_resource'});
});

test('close persists a cancellation request for an owned running process',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'slow.test.js'),SLOW_TEST);
  const {candidate}=await prepare(f,{definition:'node-test',statement:'slow',title:'Close'});
  const spec=await issueSpec(f,candidate.id,'node-test');
  const running=f.call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.spec_digest,op_id:randomUUID()});
  let job;
  for(let i=0;i<400;i++){const state=await f.call('execution_state');job=state.jobs.find(entry=>entry.status==='running');if(job)break;await sleep(10);}
  assert.ok(job?.pid,'expected a running job');
  f.execution.close();
  const persisted=f.data.get('jobs',f.workspace_id,f.project.id,job.id);
  assert.ok(['cancel_requested','outcome_unknown'].includes(persisted.status),persisted.status);
  await running;
  const final=f.data.get('jobs',f.workspace_id,f.project.id,job.id);
  assert.notEqual(final.status,'running');
  assert.ok(['cancelled','outcome_unknown'].includes(final.status),final.status);
});

test('issued previews are required and consumed once; a computed digest is not approval',async t=>{
  const f=fixture(t);const {task}=await prepare(f);
  const guess=sha('candidate');
  await assert.rejects(f.call('candidate_create',{task_id:task.id,preview_id:randomUUID(),preview_digest:guess}),{code:'expired'});
  const preview=await f.call('candidate_preview',{task_id:task.id});
  await assert.rejects(f.call('candidate_create',{task_id:task.id,preview_id:preview.preview_id,preview_digest:guess}),{code:'stale_resource'});
  // A missing preview_id is a schema failure, not an approval bypass.
  await assert.rejects(f.call('candidate_create',{task_id:task.id,preview_digest:preview.preview.digest}),{code:'invalid_request'});
  await f.call('candidate_create',{task_id:task.id,preview_id:preview.preview_id,preview_digest:preview.preview.digest});
  await assert.rejects(f.call('candidate_create',{task_id:task.id,preview_id:preview.preview_id,preview_digest:preview.preview.digest}),{code:'expired'});
});

test('stale base hashes, escaped paths and owner-pasted proposals fail closed',async t=>{
  const f=fixture(t);const {task,candidate}=await prepare(f);
  const read=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  await assert.rejects(f.call('candidate_read',{candidate_id:candidate.id,path:'../outside'}),{code:'unsupported'});
  await assert.rejects(f.call('candidate_edit',{candidate_id:candidate.id,path:'../math.js',expected_hash:read.file.hash,content:RIGHT}),{code:'unsupported'});
  await assert.rejects(f.call('candidate_edit',{candidate_id:candidate.id,path:'nope.js',expected_hash:read.file.hash,content:RIGHT}),{code:'unsupported'});
  await assert.rejects(f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:'0'.repeat(64),content:RIGHT}),{code:'stale_resource'});
  await assert.rejects(f.call('submission_create',{task_id:task.id,candidate_id:candidate.id,files:[{path:'math.js',content:RIGHT,base_hash:'0'.repeat(64)}]}),{code:'stale_resource'});
  const submission=await f.call('submission_create',{task_id:task.id,candidate_id:candidate.id,files:[{path:'math.js',content:RIGHT,base_hash:read.file.hash}]});
  assert.equal(submission.submission.kind,'patch_proposal');assert.equal(submission.submission.tool,'agent_tool_blocked');assert.equal(submission.submission.actual_isolation,false);
  await assert.rejects(f.execution.dispatch({action:'candidate_read',workspace_id:f.other,project_id:f.project.id,candidate_id:candidate.id,path:'math.js'}),{code:'permission_denied'});
  await assert.rejects(f.call('candidate_read',{candidate_id:randomUUID(),path:'math.js'}),{code:'permission_denied'});
  await assert.rejects(f.call('execution_state',{confirm:true}),{code:'invalid_request'});
});

test('a [WORKSHOP_DONE] marker is never verification; only measured exit status counts',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'defect.test.js'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('claimed done',()=>{console.log('[WORKSHOP_DONE]');assert.equal(1,2);});\n");
  const {candidate}=await prepare(f,{definition:'node-test',statement:'the candidate node tests pass',title:'Node test defect'});
  const job=await runCheck(f,candidate.id,'node-test');
  assert.equal(job.evidence.verdict,'fail');assert.notEqual(job.evidence.exit_code,0);
  assert.match(job.evidence.stdout_preview,/WORKSHOP_DONE/);
  const ready=await f.call('candidate_get',{candidate_id:candidate.id});
  await assert.rejects(f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[job.evidence.id],decision:'approved',expected_identity:ready.review_identity}),{code:'stale_resource'});
});

test('concurrent job dispatch is serialized; op_id is idempotent; evidence stays bounded',async t=>{
  const f=fixture(t);const {candidate}=await prepare(f);
  const spec=await issueSpec(f,candidate.id,'host-regression');
  const op=randomUUID();
  const first=f.call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.spec_digest,op_id:op});
  const other=await issueSpec(f,candidate.id,'host-regression');
  await assert.rejects(f.call('check_run',{candidate_id:candidate.id,preview_id:other.preview_id,preview_digest:other.spec_digest,op_id:randomUUID()}),{code:'busy'});
  const job=await first;assert.equal(job.evidence.verdict,'fail');
  const replay=await f.call('check_run',{candidate_id:candidate.id,preview_id:other.preview_id,preview_digest:other.spec_digest,op_id:op});
  assert.equal(replay.idempotent,true);assert.equal(replay.job.id,job.job.id);
  const state=await f.call('execution_state');
  assert.equal(state.jobs.length,1);assert.equal(state.active_count,0);
});

test('restart before or after the spawn records outcome_unknown, blocks new checks, and never replays blind',async t=>{
  const f=fixture(t);
  const common={workspace_id:f.workspace_id,project_id:f.project.id,task_id:randomUUID(),candidate_id:randomUUID(),candidate_hash:'a'.repeat(64),acceptance_version:1,acceptance_digest:'b'.repeat(64),definition_id:'host-regression',definition_digest:'c'.repeat(64),definition_hash:'c'.repeat(64),spec_digest:'d'.repeat(64),outcome_note:null,limits:{},actor:'owner'};
  const starting=f.data.create('jobs',{...common,op_id:randomUUID(),status:'starting',pid:null,pgid:null,process_start:null,started_at:null,ended_at:null,acknowledged:true});
  const running=f.data.create('jobs',{...common,op_id:randomUUID(),status:'running',pid:process.pid,pgid:process.pid,process_start:'12345',started_at:1,ended_at:null,acknowledged:true});
  const rebuilt=f.rebuild();
  const state=await rebuilt.dispatch({action:'execution_state',workspace_id:f.workspace_id,project_id:f.project.id});
  for(const id of [starting.id,running.id]){const job=state.jobs.find(entry=>entry.id===id);assert.equal(job.status,'outcome_unknown');assert.ok(job.ended_at);assert.ok(state.unknown_jobs[id]);}
  // Real workflow: a fresh check is blocked until the exact unknown is acknowledged.
  const {candidate}=await prepare(f);
  const spec=await issueSpec(f,candidate.id,'host-regression');
  await assert.rejects(f.call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.spec_digest,op_id:randomUUID()}),{code:'outcome_unknown'});
  const state2=await f.call('execution_state');
  await assert.rejects(f.call('job_acknowledge',{job_id:starting.id,digest:'0'.repeat(64)}),{code:'stale_resource'});
  await f.call('job_acknowledge',{job_id:starting.id,digest:state2.unknown_jobs[starting.id]});
  await assert.rejects(f.call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.spec_digest,op_id:randomUUID()}),{code:'outcome_unknown'});
  await f.call('job_acknowledge',{job_id:running.id,digest:state2.unknown_jobs[running.id]});
  const ok=await f.call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.spec_digest,op_id:randomUUID()});
  assert.equal(ok.evidence.verdict,'fail');
});

test('owner cancellation is identity-checked, requested then confirmed, and never overrides a real exit',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'slow.test.js'),SLOW_TEST);
  const {candidate}=await prepare(f,{definition:'node-test',statement:'slow candidate suite',title:'Slow suite'});
  const spec=await issueSpec(f,candidate.id,'node-test');
  const running=f.call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.spec_digest,op_id:randomUUID()});
  let job;
  for(let i=0;i<400;i++){const state=await f.call('execution_state');job=state.jobs.find(entry=>entry.status==='running');if(job)break;await sleep(10);}
  assert.ok(job?.pid,'expected a spawned running job');
  await assert.rejects(f.call('check_cancel',{job_id:job.id,expected_pid:job.pid,expected_started_at:'nope'}),{code:'unavailable'});
  const requested=await f.call('check_cancel',{job_id:job.id,expected_pid:job.pid,expected_started_at:job.process_start});
  assert.equal(requested.cancel_requested,true);assert.equal(requested.job.status,'cancel_requested');
  const outcome=await running;
  assert.equal(outcome.evidence.verdict,'inconclusive');assert.equal(outcome.job.status,'cancelled');assert.equal(outcome.job.cancel_confirmed,true);
});

test('revocation fences new grants and late results but preserves history and never kills a run',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'slow.test.js'),SLOW_TEST);
  const {candidate}=await prepare(f,{definition:'node-test',statement:'slow candidate suite',title:'Slow suite'});
  const spec=await issueSpec(f,candidate.id,'node-test');
  const running=f.call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.spec_digest,op_id:randomUUID()});
  const revocation=f.execution.onRevoke(f.project.id);
  assert.equal(revocation.cancelled,0);
  const outcome=await running;
  assert.equal(outcome.evidence.revoked,true);assert.equal(outcome.evidence.verdict,'inconclusive');
  assert.match(String(outcome.job.outcome_note),/revoked/i);
  f.records.revoke(f.workspace_id,f.project.id,f.project.generation);
  const state=await f.call('execution_state');
  assert.equal(state.revoked,true);assert.equal(state.jobs.length,1);
  await assert.rejects(f.call('task_create',{title:'new',acceptance_statement:'x',check_definition_id:'host-regression',profile_id:'default',session_id:'orbit-exec-fixture'}),{code:'permission_denied'});
  await assert.rejects(f.call('context_source',{job_id:outcome.job.id}),{code:'permission_denied'});
  const got=await f.call('job_get',{job_id:outcome.job.id});assert.equal(got.job.status,'inconclusive');
});

test('context source is an exact, bounded, hash-verifiable job projection',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),RIGHT);
  const {candidate}=await prepare(f);
  const job=await runCheck(f,candidate.id,'host-regression');
  assert.equal(job.evidence.verdict,'pass');
  const direct=await f.execution.contextSource({workspace_id:f.workspace_id,project_id:f.project.id,job_id:job.job.id});
  assert.equal(sha(direct.text),direct.hash);
  assert.equal(direct.resource_id,job.job.id);assert.equal(direct.provenance.verdict,'pass');
  const viaDispatch=await f.call('context_source',{job_id:job.job.id});
  assert.equal(viaDispatch.context.hash,direct.hash);
});

test('an injected untracked candidate file invalidates the identity and refuses the check',async t=>{
  const f=fixture(t);const {candidate}=await prepare(f);
  const privateRecord=privateCandidate(f,candidate.id);
  fs.writeFileSync(path.join(privateRecord.root,'injected.test.js'),"import test from 'node:test';\ntest('injected',()=>{});\n");
  const spec=await issueSpec(f,candidate.id,'host-regression');
  await assert.rejects(f.call('check_run',{candidate_id:candidate.id,preview_id:spec.preview_id,preview_digest:spec.spec_digest,op_id:randomUUID()}),{code:'stale_resource'});
  // Deleting a recorded file is also detected (candidate edit refuses a missing path).
  await assert.rejects(f.call('candidate_edit',{candidate_id:candidate.id,path:'missing.js',expected_hash:'0'.repeat(64),content:'x'}),{code:'unsupported'});
});

test('output floods are capped; context source reports truncation, not a full replay',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'flood.test.js'),"import test from 'node:test';\ntest('flood',()=>{let s='';for(let i=0;i<2000;i++)s+='x'.repeat(4096)+'\\n';process.stdout.write(s);});\n");
  const {candidate}=await prepare(f,{definition:'node-test',statement:'flood suite',title:'Flood'});
  const job=await runCheck(f,candidate.id,'node-test');
  assert.equal(job.evidence.verdict,'pass');
  assert.ok(job.evidence.log_bytes<=262144,job.evidence.log_bytes);
  assert.ok(job.evidence.stdout_preview.length<=16384);
  assert.ok(JSON.stringify(job).length<64*1024);
  const context=await f.execution.contextSource({workspace_id:f.workspace_id,project_id:f.project.id,job_id:job.job.id});
  assert.equal(context.truncated,true);
  assert.equal(context.provenance.definition_id,'node-test');
  assert.match(context.provenance.interleaving,/not fully replayed/);
});

test('a descendant holding the child pipes cannot hang the recorder',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.projectRoot,'pipe.test.js'),"import test from 'node:test';\nimport {spawn} from 'node:child_process';\ntest('spawn descendant',()=>{spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'inherit',detached:true}).unref();});\n");
  const {candidate}=await prepare(f,{definition:'node-test',statement:'pipe suite',title:'Pipe'});
  const started=Date.now();
  const job=await runCheck(f,candidate.id,'node-test');
  assert.ok(Date.now()-started<20000);
  assert.equal(typeof job.evidence.process_survival_unknown,'boolean');
});

test('a surviving descendant is marked process_survival_unknown and never a pass',async t=>{
  const f=fixture(t);
  // The descendant is NOT detached, so it stays in the spawned process group and
  // outlives the leader; it must never be signalled by an unverified PGID.
  fs.writeFileSync(path.join(f.projectRoot,'orphan.test.js'),"import test from 'node:test';\nimport {spawn} from 'node:child_process';\ntest('orphan',()=>{spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'ignore'}).unref();});\n");
  const {candidate}=await prepare(f,{definition:'node-test',statement:'orphan suite',title:'Orphan'});
  const job=await runCheck(f,candidate.id,'node-test');
  assert.equal(job.evidence.process_survival_unknown,true);
  assert.equal(job.evidence.verdict,'inconclusive');
  assert.equal(job.job.cancel_confirmed,false);
});

test('candidate cap and persist failure never orphan a private copy',async t=>{
  const f=fixture(t);const {task}=await prepare(f);
  const directory=path.join(f.store.root,'workbench-execution','candidates');
  const count=()=>fs.readdirSync(directory).length;
  const before=count();
  // Persist failure after materialization removes only the new copy.
  const original=f.data.create.bind(f.data);let failNext=true;
  f.data.create=(kind,...rest)=>{if(kind==='candidates'&&failNext){failNext=false;throw Object.assign(Error('disk full'),{code:'unavailable'});}return original(kind,...rest);};
  const preview=await f.call('candidate_preview',{task_id:task.id});
  await assert.rejects(f.call('candidate_create',{task_id:task.id,preview_id:preview.preview_id,preview_digest:preview.preview.digest}),{code:'unavailable'});
  assert.equal(count(),before,'no orphan candidate copy after persist failure');
  f.data.create=original;
  // The durable cap is enforced before any filesystem materialization.
  const existing=f.data.list('candidates',f.workspace_id,f.project.id).length;
  for(let i=existing;i<200;i++)f.data.create('candidates',{workspace_id:f.workspace_id,project_id:f.project.id,task_id:task.id});
  const preview2=await f.call('candidate_preview',{task_id:task.id});
  await assert.rejects(f.call('candidate_create',{task_id:task.id,preview_id:preview2.preview_id,preview_digest:preview2.preview.digest}),{code:'limit_exceeded'});
  assert.equal(count(),before,'cap rejection must not materialize a copy');
});

test('candidate disposal is bounded and does not stall on a wide injected tree',async t=>{
  const f=fixture(t);const {candidate}=await prepare(f);
  const root=privateCandidate(f,candidate.id).root;
  for(let i=0;i<3000;i++)fs.writeFileSync(path.join(root,`wide-${i}.txt`),'x');
  const started=Date.now();
  removeCandidateWorkspace(f.store,privateCandidate(f,candidate.id));
  assert.ok(Date.now()-started<5000,`disposal took ${Date.now()-started}ms`);
});

test('candidate preview is deterministic and re-observation rejects a changed source',async t=>{
  const f=fixture(t);const {task,preview}=await prepare(f,{title:'Deterministic'});
  const again=await f.call('candidate_preview',{task_id:task.id});
  assert.equal(again.preview.digest,preview.preview.digest);
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),RIGHT);
  await assert.rejects(f.call('candidate_create',{task_id:task.id,preview_id:again.preview_id,preview_digest:again.preview.digest}),{code:'stale_resource'});
});
