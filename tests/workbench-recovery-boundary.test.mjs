import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchWorkflow} from '../server/workbench-workflow.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-recovery-boundary-'),source=path.join(root,'source');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'math.js'),'export const sum=(a,b)=>a-b;\n');
  fs.writeFileSync(path.join(source,'math.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from './math.js';\ntest('sum',()=>assert.equal(sum(2,3),5));\n");
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Recovery fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),gate=createWorkbenchGate(),opened=openProjectRoot(source);
  const project=records.register(workspace_id,{root:source,name:'Recovery fixture',identity:opened.identity});opened.close();
  const execution=createWorkbenchExecution({store,records,data,gate}),workflow=createWorkbenchWorkflow({store,records,data,execution}),base={workspace_id,project_id:project.id};
  const call=(action,fields={})=>execution.dispatch({...base,action,...fields});
  const flow=(action,fields={})=>workflow.dispatch({...base,action,...fields});
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,source,store,records,data,gate,project,execution,base,call,flow};
}

async function admitted(f){
  const {task}=await f.call('task_create',{title:'Repair sum',acceptance_statement:'sum adds inputs',check_definition_id:'node-test',profile_id:'default',session_id:'recovery-fixture'});
  const issued=await f.call('candidate_preview',{task_id:task.id}),{candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:issued.preview_id,preview_digest:issued.preview.digest});
  const read=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:read.file.hash,content:'export const sum=(a,b)=>a+b;\n'});
  const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'node-test'}),run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  assert.equal(run.evidence.verdict,'pass');
  const current=await f.call('candidate_get',{candidate_id:candidate.id}),{review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const selection={task_id:task.id,candidate_id:candidate.id,review_id:review.id},preview=await f.flow('patch_preview',selection);
  const request={...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id:randomUUID()};
  const update=f.data.update.bind(f.data);let fault=false;
  f.data.update=(kind,...args)=>{
    if(!fault&&kind==='patches'&&args[4]?.status==='verified'){fault=true;throw Object.assign(Error('one DB commit fault'),{code:'unavailable'});}
    return update(kind,...args);
  };
  try{await assert.rejects(f.flow('patch_export',request),{code:'unavailable'});}finally{f.data.update=update;}
  assert.equal(fault,true);
  const [summary]=(await f.flow('patch_list',{op_id:request.op_id})).patches;
  assert.equal(summary.status,'verification_pending');assert.equal(summary.recovery.recoverable,true);
  return {summary,digest:summary.recovery.recovery_digest,request};
}

const noPrivateFields=reply=>{
  for(const key of ['private_root','source','candidate','review','changes','exclusions','roundtrip','op_id','patch_text','patch'])assert.equal(Object.hasOwn(reply.patch,key),false,`historical reply exposed ${key}`);
};

test('actual provider and verifier replay committed owner retry without another check or broadening scope',async t=>{
  const f=fixture(t),{summary,digest,request}=await admitted(f),body={artifact_id:summary.artifact_id,expected_digest:digest};
  assert.throws(()=>f.gate.claim('job',randomUUID()),{code:'busy'});
  const before=fs.readdirSync(path.join(f.store.root,'workbench-execution')).filter(name=>name.startsWith('check-')).length;
  await assert.rejects(f.flow('patch_finalize_retry',{...body,expected_digest:'f'.repeat(64)}),{code:'stale_resource'});
  const committed=await f.flow('patch_finalize_retry',body);assert.equal(committed.patch.status,'available');assert.equal(committed.idempotent,false);
  // The first HTTP reply is dropped by the owner; resend its exact request.
  const replay=await f.flow('patch_finalize_retry',body);assert.equal(replay.idempotent,true);assert.equal(replay.patch.status,'available');
  assert.equal(replay.patch.verification.id,committed.patch.verification.id);
  assert.equal(fs.readdirSync(path.join(f.store.root,'workbench-execution')).filter(name=>name.startsWith('check-')).length,before);
  await assert.rejects(f.flow('patch_finalize_retry',{...body,expected_digest:'f'.repeat(64)}),{code:'stale_resource'});
  await assert.rejects(f.flow('patch_finalize_retry',{...body,artifact_id:randomUUID()}),{code:'permission_denied'});
  f.gate.claim('job',randomUUID())();
  f.records.revoke(f.base.workspace_id,f.project.id,f.project.generation);
  await assert.rejects(f.flow('private_patch_get',{artifact_id:summary.artifact_id}),{code:'permission_denied'});
  const historical=await f.flow('patch_finalize_retry',body);assert.equal(historical.idempotent,true);assert.equal(historical.patch.status,'available');noPrivateFields(historical);
  const opened=openProjectRoot(f.source),again=f.records.register(f.base.workspace_id,{root:f.source,name:'Recovery fixture',identity:opened.identity});opened.close();
  assert.ok(again.generation>f.project.generation);
  await assert.rejects(f.flow('private_patch_get',{artifact_id:summary.artifact_id}),{code:'stale_resource'});
  await assert.rejects(f.flow('patch_export',request),{code:'stale_resource'});
  await assert.rejects(f.flow('patch_finalize_retry',body),{code:'stale_resource'});
});

test('revoked project retry commits only inconclusive metadata and its lost reply remains replayable',async t=>{
  const f=fixture(t),{summary,digest}=await admitted(f),body={artifact_id:summary.artifact_id,expected_digest:digest};
  f.records.revoke(f.base.workspace_id,f.project.id,f.project.generation);
  assert.throws(()=>f.gate.claim('job',randomUUID()),{code:'busy'});
  const committed=await f.flow('patch_finalize_retry',body);assert.equal(committed.patch.status,'verification_failed');assert.equal(committed.patch.verification_status,'inconclusive');noPrivateFields(committed);
  const replay=await f.flow('patch_finalize_retry',body);assert.equal(replay.idempotent,true);assert.deepEqual(replay.patch,committed.patch);noPrivateFields(replay);
  await assert.rejects(f.flow('patch_finalize_retry',{...body,expected_digest:'f'.repeat(64)}),{code:'stale_resource'});
  f.gate.claim('job',randomUUID())();
  await assert.rejects(f.flow('private_patch_get',{artifact_id:summary.artifact_id}),{code:'permission_denied'});
});
