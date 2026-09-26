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
  return {root,projectRoot,store,workspace_id,project,data,call,flow};
}

async function reviewedCandidate(f){
  const {task}=await f.call('task_create',{title:'Repair sum',acceptance_statement:'sum returns arithmetic addition',check_definition_id:'host-regression',profile_id:'default',session_id:'fixture'});
  const issued=await f.call('candidate_preview',{task_id:task.id}),{candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:issued.preview_id,preview_digest:issued.preview.digest});
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:file.file.hash,content:'export const sum = (a,b) => a + b;\n'});
  if(fs.existsSync(path.join(f.projectRoot,'data.txt'))){const large=await f.call('candidate_read',{candidate_id:candidate.id,path:'data.txt'});await f.call('candidate_edit',{candidate_id:candidate.id,path:'data.txt',expected_hash:large.file.hash,content:'\u0002'.repeat(190000)});}
  const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'}),run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  assert.equal(run.evidence.verdict,'pass');
  const current=await f.call('candidate_get',{candidate_id:candidate.id}),{review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  return {task,candidate,review};
}

test('patch is an exact private unified diff, round-trips, and ignores Git ignore/attribute effects',async t=>{
  const f=fixture(t),{task,candidate,review}=await reviewedCandidate(f),selection={task_id:task.id,candidate_id:candidate.id,review_id:review.id};
  const preview=await f.flow('patch_preview',selection);
  assert.equal(preview.format,'git-unified-diff');assert.equal(preview.roundtrip.verified,true);assert.equal(preview.roundtrip.unrelated_unchanged,true);
  assert.deepEqual(preview.changes.map(item=>item.path),['math.js']);
  assert.ok(preview.exclusions.some(item=>item.path==='.env'));assert.ok(!preview.changes.some(item=>item.path==='.env'));
  const op_id=randomUUID(),exported=await f.flow('patch_export',{...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});
  assert.equal(exported.patch.status,'available');assert.equal(exported.patch.roundtrip.verified,true);
  const downloaded=await f.flow('private_patch_get',{artifact_id:exported.patch.id});
  assert.match(downloaded.patch,/^--- a\/math\.js/m);assert.match(downloaded.patch,/\+.*a \+ b/);
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),'export const sum = (a,b) => a - b;\n');
  assert.equal((await f.flow('patch_export',{...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id})).idempotent,true);
});

test('unsupported source/candidate mode changes fail closed',async t=>{
  const f=fixture(t);fs.chmodSync(path.join(f.projectRoot,'math.js'),0o755);const {task,candidate,review}=await reviewedCandidate(f);
  await assert.rejects(f.flow('patch_preview',{task_id:task.id,candidate_id:candidate.id,review_id:review.id}),{code:'unsupported'});
  assert.equal(f.data.list('patches',f.workspace_id,f.project.id).length,0);
});

test('JSON-escaped private patch responses over the route cap are refused before artifact creation',async t=>{
  const f=fixture(t,{controlHeavy:true}),{task,candidate,review}=await reviewedCandidate(f);
  await assert.rejects(f.flow('patch_preview',{task_id:task.id,candidate_id:candidate.id,review_id:review.id}),{code:'limit_exceeded'});
  assert.equal(f.data.list('patches',f.workspace_id,f.project.id).length,0);
});
