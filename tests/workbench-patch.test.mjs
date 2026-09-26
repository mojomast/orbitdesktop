import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchWorkflow} from '../server/workbench-workflow.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

function fixture(t,{controlHeavy=false}={}){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-patch-'),projectRoot=path.join(root,'source');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'.gitignore'),'math.js\n');
  fs.writeFileSync(path.join(projectRoot,'.gitattributes'),'*.js -diff\n');
  fs.writeFileSync(path.join(projectRoot,'.env'),'owner-private fixture\n');
  fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum = (a,b) => a - b;\n');
  fs.writeFileSync(path.join(projectRoot,'math.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from './math.js';\ntest('sum adds inputs',()=>{assert.equal(sum(2,3),5);assert.equal(sum(-1,1),0);});\n");
  if(controlHeavy)fs.writeFileSync(path.join(projectRoot,'data.txt'),'\u0001'.repeat(190000));
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Patch fixture',identity:opened.identity});opened.close();
  // This fallback lets the provider be exercised before the authoritative Sol
  // migration is integrated; final tests use the real private patches table.
  const patchRecords=[];
  if(!data.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_patches'").get()){
    const create=data.create.bind(data),list=data.list.bind(data),update=data.update.bind(data);
    data.create=(kind,fields)=>{if(kind!=='patches')return create(kind,fields);const record={...structuredClone(fields),id:randomUUID(),version:1,revision:1,created_at:Date.now(),updated_at:Date.now()};patchRecords.push(record);return record;};
    data.list=(kind,...args)=>kind==='patches'?patchRecords:list(kind,...args);
    data.update=(kind,workspace,projectId,id,revision,patch)=>{if(kind!=='patches')return update(kind,workspace,projectId,id,revision,patch);const record=patchRecords.find(item=>item.id===id);if(!record||record.revision!==revision)throw Object.assign(Error('stale_resource'),{code:'stale_resource'});Object.assign(record,structuredClone(patch),{revision:revision+1,updated_at:Date.now()});return record;};
  }
  const execution=createWorkbenchExecution({store,records,data}),workflow=createWorkbenchWorkflow({store,records,data,execution});
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=(action,fields={})=>execution.dispatch({action,workspace_id,project_id:project.id,...fields});
  const flow=(action,fields={})=>workflow.dispatch({action,workspace_id,project_id:project.id,...fields});
  return {root,projectRoot,store,workspace_id,project,data,execution,call,flow};
}

async function reviewedCandidate(f,{executableAddition=false,executableDeletion=false}={}){
  if(executableDeletion){fs.writeFileSync(path.join(f.projectRoot,'tool.sh'),'#!/bin/sh\necho owner\n',{mode:0o700});fs.chmodSync(path.join(f.projectRoot,'tool.sh'),0o700);}
  const {task}=await f.call('task_create',{title:'Repair sum',acceptance_statement:'sum returns arithmetic addition',check_definition_id:'host-regression',required_checks:[{definition_id:'node-test'},{definition_id:'host-regression'}],profile_id:'default',session_id:'fixture'});
  const issued=await f.call('candidate_preview',{task_id:task.id}),created=await f.call('candidate_create',{task_id:task.id,preview_id:issued.preview_id,preview_digest:issued.preview.digest});let candidate=created.candidate;
  if(executableAddition){await f.call('candidate_apply',{candidate_id:candidate.id,expected_candidate_hash:candidate.hash,changes:[{op:'create',path:'new-tool.sh',expected_hash:null,content:'#!/bin/sh\necho candidate\n'}]});candidate=(await f.call('candidate_get',{candidate_id:candidate.id})).candidate;}
  if(executableDeletion){const record=f.data.get('candidates',f.workspace_id,f.project.id,candidate.id),entry=record.files.find(item=>item.path==='tool.sh');await f.call('candidate_apply',{candidate_id:candidate.id,expected_candidate_hash:candidate.hash,changes:[{op:'delete',path:'tool.sh',expected_hash:entry.hash}]});candidate=(await f.call('candidate_get',{candidate_id:candidate.id})).candidate;}
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:file.file.hash,content:'export const sum = (a,b) => a + b;\n'});
  if(fs.existsSync(path.join(f.projectRoot,'data.txt'))){const large=await f.call('candidate_read',{candidate_id:candidate.id,path:'data.txt'});await f.call('candidate_edit',{candidate_id:candidate.id,path:'data.txt',expected_hash:large.file.hash,content:'\u0002'.repeat(190000)});}
  const evidence=[];for(const definition_id of ['node-test','host-regression']){const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id}),run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});assert.equal(run.evidence.verdict,'pass');evidence.push(run.evidence.id);}
  const current=await f.call('candidate_get',{candidate_id:candidate.id}),{review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:evidence,decision:'approved',expected_identity:current.review_identity});
  if(executableAddition){const record=f.data.get('candidates',f.workspace_id,f.project.id,candidate.id);fs.chmodSync(path.join(record.root,'new-tool.sh'),0o700);}
  return {task,candidate,review};
}

test('patch is an exact private unified diff, round-trips, and ignores Git ignore/attribute effects',async t=>{
  const f=fixture(t),{task,candidate,review}=await reviewedCandidate(f),selection={task_id:task.id,candidate_id:candidate.id,review_id:review.id};
  const preview=await f.flow('patch_preview',selection);
  assert.equal(preview.format,'git-unified-diff');assert.equal(preview.roundtrip.verified,true);assert.equal(preview.roundtrip.unrelated_unchanged,true);
  assert.deepEqual(preview.changes.map(item=>item.path),['math.js']);
  assert.ok(preview.exclusions.some(item=>item.path==='.env'));assert.ok(!preview.changes.some(item=>item.path==='.env'));
  const op_id=randomUUID(),request={...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id},[exported,concurrent]=await Promise.all([f.flow('patch_export',request),f.flow('patch_export',request)]);
  assert.equal(concurrent.patch.id,exported.patch.id);assert.equal(f.data.list('patches',f.workspace_id,f.project.id).length,1);
  assert.equal(exported.patch.status,'available');assert.equal(exported.patch.roundtrip.verified,true);
  assert.equal(exported.patch.verification.status,'verified');assert.deepEqual(exported.patch.verification.results.map(item=>item.definition_id),['node-test','host-regression']);assert.ok(exported.patch.verification.results.every(item=>item.verdict==='pass'));
  for(const privateField of ['private_root','op_id','revision','process','pid','pgid','artifact_root','stage_root'])assert.equal(Object.hasOwn(exported.patch,privateField),false);
  const downloaded=await f.flow('private_patch_get',{artifact_id:exported.patch.id});
  assert.match(downloaded.patch,/^--- a\/math\.js/m);assert.match(downloaded.patch,/\+.*a \+ b/);
  assert.equal(downloaded.receipt.verification.status,'verified');assert.equal(Object.hasOwn(downloaded.receipt,'private_root'),false);
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),'export const sum = (a,b) => a - b;\n');
  assert.equal((await f.flow('patch_export',request)).idempotent,true);
  const verified=f.data.get('patches',f.workspace_id,f.project.id,exported.patch.id),runsBefore=f.data.list('jobs',f.workspace_id,f.project.id).length;
  f.data.update('patches',f.workspace_id,f.project.id,verified.id,verified.revision,{status:'verified'});
  const promoted=await f.flow('patch_export',request);
  assert.equal(promoted.patch.status,'available');assert.equal(promoted.patch.verification.id,verified.verification.id);assert.equal(f.data.list('jobs',f.workspace_id,f.project.id).length,runsBefore);
  await assert.rejects(f.flow('patch_export',{...selection,task_id:randomUUID(),preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id}),{code:'conflict'});
});

test('unsupported source/candidate mode changes fail closed',async t=>{
  const f=fixture(t);fs.chmodSync(path.join(f.projectRoot,'math.js'),0o755);const {task,candidate,review}=await reviewedCandidate(f);
  await assert.rejects(f.flow('patch_preview',{task_id:task.id,candidate_id:candidate.id,review_id:review.id}),{code:'unsupported'});
  assert.equal(f.data.list('patches',f.workspace_id,f.project.id).length,0);
});

test('executable additions and deletions refuse patch materialization rather than losing mode bits',async t=>{
  const added=fixture(t),add=await reviewedCandidate(added,{executableAddition:true});
  const addedRecord=added.data.get('candidates',added.workspace_id,added.project.id,add.candidate.id);assert.ok(addedRecord.files.some(file=>file.path==='new-tool.sh'));
  await assert.rejects(added.flow('patch_preview',{task_id:add.task.id,candidate_id:add.candidate.id,review_id:add.review.id}),{code:'unsupported'});
  const deleted=fixture(t),remove=await reviewedCandidate(deleted,{executableDeletion:true});
  await assert.rejects(deleted.flow('patch_preview',{task_id:remove.task.id,candidate_id:remove.candidate.id,review_id:remove.review.id}),{code:'unsupported'});
});

test('unknown artifact-check outcomes remain durable and cannot be converted to preparation failure',async t=>{
  const f=fixture(t),{task,candidate,review}=await reviewedCandidate(f),selection={task_id:task.id,candidate_id:candidate.id,review_id:review.id};
  const preview=await f.flow('patch_preview',selection),request={...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id:randomUUID()};
  const verify=f.execution.verifyPatchArtifact;
  f.execution.verifyPatchArtifact=async({artifact_id})=>{
    const record=f.data.get('patches',f.workspace_id,f.project.id,artifact_id),verification={version:1,id:randomUUID(),artifact_id,artifact_hash:record.artifact_hash,status:'outcome_unknown',results:[]};
    const updated=f.data.update('patches',f.workspace_id,f.project.id,artifact_id,record.revision,{status:'verifying',verification});
    return {verification:updated.verification};
  };
  try{
    const response=await f.flow('patch_export',request);assert.equal(response.patch.status,'verifying');assert.equal(response.patch.verification.status,'outcome_unknown');
    assert.equal((await f.flow('patch_export',request)).patch.verification.status,'outcome_unknown');
    await assert.rejects(f.flow('private_patch_get',{artifact_id:response.patch.id}),{code:'permission_denied'});
    const pending=(await f.flow('patch_list')).patches[0];assert.equal(pending.recovery.recoverable,false);
    const acknowledged=await f.flow('patch_acknowledge_unknown',{artifact_id:pending.id,expected_digest:pending.recovery.recovery_digest,known_externally_terminated:true});
    assert.equal(acknowledged.patch.status,'verification_failed');assert.equal(acknowledged.patch.verification.status,'acknowledged_unknown');
  }finally{f.execution.verifyPatchArtifact=verify;}
});

test('recorded artifact-check journals finalize after reload without launching checks again',async t=>{
  const f=fixture(t),{task,candidate,review}=await reviewedCandidate(f),selection={task_id:task.id,candidate_id:candidate.id,review_id:review.id};
  const preview=await f.flow('patch_preview',selection),request={...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id:randomUUID()},update=f.data.update.bind(f.data);
  f.data.update=(kind,...args)=>{if(kind==='patches'&&args[4]?.status==='verified')throw Error('simulated SQLite finalization failure');return update(kind,...args);};
  await assert.rejects(f.flow('patch_export',request));
  f.data.update=update;
  let listed=await f.flow('patch_list');assert.equal(listed.patches.length,1);let patch=listed.patches[0];
  assert.equal(patch.status,'verification_pending');assert.equal(patch.recovery.recoverable,true);assert.equal(patch.recovery.process_owned,false);
  const jobsBefore=f.data.list('jobs',f.workspace_id,f.project.id).length,verificationId=patch.verification.id;
  const recovered=await f.flow('patch_finalize_retry',{artifact_id:patch.id,expected_digest:patch.recovery.recovery_digest});
  assert.equal(recovered.patch.status,'available');assert.equal(recovered.patch.verification.id,verificationId);
  assert.equal(f.data.list('jobs',f.workspace_id,f.project.id).length,jobsBefore);
  listed=await f.flow('patch_list');patch=listed.patches[0];assert.equal(patch.status,'available');
  assert.equal((await f.flow('private_patch_get',{artifact_id:patch.id})).receipt.verification.status,'verified');
});

test('JSON-escaped private patch responses over the route cap are refused before artifact creation',async t=>{
  const f=fixture(t,{controlHeavy:true}),{task,candidate,review}=await reviewedCandidate(f);
  await assert.rejects(f.flow('patch_preview',{task_id:task.id,candidate_id:candidate.id,review_id:review.id}),{code:'limit_exceeded'});
  assert.equal(f.data.list('patches',f.workspace_id,f.project.id).length,0);
});
