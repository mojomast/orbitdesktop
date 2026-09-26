// Independent moving-target regression for the merged patch provider. A reviewed,
// approved patch preview captures the source base; the owner then changes the
// original project. Exporting the reviewed patch must refuse (the target moved) and
// must not revert the owner's change or create an artifact.
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
import {createWorkbenchWorkflow} from '../server/workbench-workflow.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-moving-'),projectRoot=path.join(root,'source');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'.gitignore'),'math.js\n');
  fs.writeFileSync(path.join(projectRoot,'.gitattributes'),'*.js -diff\n');
  fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum = (a,b) => a - b;\n');
  const gitEnv={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',HOME:root};
  const git=(...args)=>execFileSync('/usr/bin/git',['-C',projectRoot,...args],{env:gitEnv,encoding:'utf8'});
  git('init','-q');git('add','.gitattributes');
  git('-c','user.email=fixture@example.invalid','-c','user.name=Fixture','commit','-q','-m','initial');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Moving target',identity:opened.identity});opened.close();
  const execution=createWorkbenchExecution({store,records,data}),workflow=createWorkbenchWorkflow({store,records,data,execution});
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=(action,fields={})=>execution.dispatch({action,workspace_id,project_id:project.id,...fields});
  const flow=(action,fields={})=>workflow.dispatch({action,workspace_id,project_id:project.id,...fields});
  return {root,projectRoot,store,workspace_id,project,data,call,flow};
}

async function reviewedCandidate(f){
  const {task}=await f.call('task_create',{title:'Repair sum',acceptance_statement:'sum returns addition',check_definition_id:'host-regression',profile_id:'default',session_id:'fixture'});
  const issued=await f.call('candidate_preview',{task_id:task.id}),{candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:issued.preview_id,preview_digest:issued.preview.digest});
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:file.file.hash,content:'export const sum = (a,b) => a + b;\n'});
  const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  const run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  assert.equal(run.evidence.verdict,'pass');
  const current=await f.call('candidate_get',{candidate_id:candidate.id});
  const {review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  return {task,candidate,review};
}

test('a source change after patch_preview refuses export and preserves the owner change',async t=>{
  const f=fixture(t),{task,candidate,review}=await reviewedCandidate(f);
  const selection={task_id:task.id,candidate_id:candidate.id,review_id:review.id};
  const preview=await f.flow('patch_preview',selection);
  assert.equal(preview.format,'git-unified-diff');
  assert.equal(preview.roundtrip.verified,true,'the reviewed patch round-trips against the captured base');
  // The owner changes the original project after review, before export.
  const ownerBytes='export const sum = (a,b) => a - b; // owner moved the target\n';
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),ownerBytes);
  const before=fs.readFileSync(path.join(f.projectRoot,'math.js'));
  await assert.rejects(
    f.flow('patch_export',{...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id:randomUUID()}),
    {code:'stale_resource'},
    'export must refuse once the captured source target moved');
  assert.equal(f.data.list('patches',f.workspace_id,f.project.id).length,0,'no artifact is created for a moved target');
  assert.deepEqual(fs.readFileSync(path.join(f.projectRoot,'math.js')),before,'the owner change is not reverted');
});
