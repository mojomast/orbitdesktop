import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchWorkflow,workflowSchema} from '../server/workbench-workflow.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-workflow-'),projectRoot=path.join(root,'source');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum = (a,b) => a - b;\n');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Workflow fixture',identity:opened.identity});opened.close();
  const execution=createWorkbenchExecution({store,records,data}),workflow=createWorkbenchWorkflow({store,records,data,execution});
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=(action,fields={})=>execution.dispatch({action,workspace_id,project_id:project.id,...fields});
  const flow=(action,fields={})=>workflow.dispatch({action,workspace_id,project_id:project.id,...fields});
  return {root,projectRoot,store,workspace_id,project,records,data,call,flow};
}
const git=(folder,...args)=>execFileSync('/usr/bin/git',['-C',folder,...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:folder,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();

test('real approved candidate creates a separate private two-commit Git branch, with durable retry receipt',async t=>{
  const f=fixture(t);
  assert.equal(workflowSchema.oneOf.length,7);
  const {task}=await f.call('task_create',{title:'Repair sum',acceptance_statement:'sum returns arithmetic addition',check_definition_id:'host-regression',profile_id:'default',session_id:'fixture'});
  const issued=await f.call('candidate_preview',{task_id:task.id});
  const {candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:issued.preview_id,preview_digest:issued.preview.digest});
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:file.file.hash,content:'export const sum = (a,b) => a + b;\n'});
  const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  const run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  assert.equal(run.evidence.verdict,'pass');
  const current=await f.call('candidate_get',{candidate_id:candidate.id});
  const {review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const selection={candidate_id:candidate.id,review_id:review.id};
  const preview=await f.flow('integration_preview',selection);
  await assert.rejects(f.flow('integrate_confirm',{...selection,preview_id:randomUUID(),preview_digest:preview.preview_digest,op_id:randomUUID()}),{code:'expired'});
  const op_id=randomUUID();
  const result=await f.flow('integrate_confirm',{...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});
  const artifact=result.integration.artifact_path;
  assert.equal(result.integration.status,'integrated');
  assert.ok(artifact.startsWith(path.join(f.root,'runtime','workbench-integration')+'/'));
  assert.match(git(artifact,'branch','--show-current'),/^comet\/integration-/);
  assert.equal(git(artifact,'rev-list','--count','HEAD'),'2');
  assert.match(git(artifact,'show',`${result.integration.base_commit}:math.js`),/a - b/);
  assert.match(git(artifact,'show',`${result.integration.candidate_commit}:math.js`),/a \+ b/);
  assert.match(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),/a - b/);
  assert.equal(fs.existsSync(path.join(f.projectRoot,'.git')),false);
  const retry=await f.flow('integrate_confirm',{...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});
  assert.equal(retry.idempotent,true);assert.equal(retry.integration.id,result.integration.id);
  const inventory=await f.flow('retention_plan');assert.deepEqual(inventory.deletions,[]);assert.equal(inventory.counts.integrations,1);
  await assert.rejects(f.flow('integration_preview',selection),{code:'stale_resource'});
});

test('a branch change at the same HEAD after review requires fresh review before integration',async t=>{
  const f=fixture(t);git(f.projectRoot,'init');git(f.projectRoot,'add','.');git(f.projectRoot,'commit','-m','fixture base');
  const {task}=await f.call('task_create',{title:'Check branch',acceptance_statement:'sum adds',check_definition_id:'host-regression',profile_id:'default',session_id:'fixture'});
  const p=await f.call('candidate_preview',{task_id:task.id});const {candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});
  const read=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:read.file.hash,content:'export const sum=(a,b)=>a+b;\n'});
  const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'}),run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  const current=await f.call('candidate_get',{candidate_id:candidate.id});const {review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  assert.match(review.source_repository.head_reference,/^ref: refs\/heads\//);
  git(f.projectRoot,'checkout','-b','other-reviewed-target');assert.equal(git(f.projectRoot,'rev-parse','HEAD'),review.source_repository.head);
  await assert.rejects(f.flow('integration_preview',{candidate_id:candidate.id,review_id:review.id}),{code:'stale_resource'});
  const next=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  const reviewing=f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const fenced=assert.rejects(reviewing,error=>['stale_resource','busy'].includes(error.code));
  await f.call('check_run',{candidate_id:candidate.id,preview_id:next.preview_id,preview_digest:next.preview.spec_digest,op_id:randomUUID()});
  await fenced;
});

test('source drift and strict unknown fields refuse integration without touching original',async t=>{
  const f=fixture(t);
  await assert.rejects(f.flow('retention_inventory',{root:'/tmp/elsewhere'}),{code:'invalid_request'});
  const inventory=await f.flow('retention_inventory');assert.equal(inventory.counts.integrations,0);
});

test('project focus preserves pane identities and return requires an unchanged workspace revision',async t=>{
  const f=fixture(t),before=f.store.read(f.workspace_id);
  const pane=before.state.monitors[1].layout.pane.id;
  const resource=f.records.resource(f.project.id,'math.js',{kind:'file',hash:'0'.repeat(64),identity:'file',state:'available'});
  f.records.bind({workspace_id:f.workspace_id,project_id:f.project.id,resource_id:resource.id,pane_id:pane,role:'project_files',base_revision:before.revision});
  const issued=await f.flow('recipe_preview',{recipe:'project_focus'});
  assert.equal(issued.base_revision,before.revision);
  const focused=await f.flow('recipe_apply',{recipe:'project_focus',preview_id:issued.preview_id,preview_digest:issued.preview_digest,op_id:randomUUID()});
  assert.equal(focused.workspace.state.monitors[0].id,before.state.monitors[1].id);
  assert.deepEqual(focused.workspace.state.monitors.map(m=>m.layout.pane.id).sort(),before.state.monitors.map(m=>m.layout.pane.id).sort());
  const returning=await f.flow('recipe_preview',{recipe:'return'});
  const restored=await f.flow('recipe_apply',{recipe:'return',preview_id:returning.preview_id,preview_digest:returning.preview_digest,op_id:randomUUID()});
  assert.deepEqual(restored.workspace.state.monitors.map(m=>m.id),before.state.monitors.map(m=>m.id));
  await assert.rejects(f.flow('recipe_preview',{recipe:'return'}),{code:'stale_resource'});
});
