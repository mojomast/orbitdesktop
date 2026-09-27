import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

// Opt-in real-project reproduction. This loads the exact read-only deployment,
// but creates all records, dependencies, candidates and receipts in a new runtime.
const release=process.env.ORBIT_EXPORT_TEST_RELEASE;
const source=process.env.ORBIT_ROUTETOK_TEST_SOURCE;
const cache=process.env.ORBIT_ROUTETOK_TEST_CACHE;
const evidencePath=process.env.ORBIT_ROUTETOK_REPAIR_EVIDENCE;
const enabled=!!(release&&source&&cache&&evidencePath);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const deployed=name=>import(pathToFileURL(path.join(release,name)).href);

test('deployed verifier refuses export after a reviewed, passing real RouteTok dependency check',{
  skip:!enabled,timeout:240000,
},async t=>{
  assert.equal(fs.existsSync(path.join(source,'node_modules')),false);
  assert.equal(execFileSync('/usr/bin/git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),'7e3a1fb024d62fcb0e2bfc994b7db3185bd41fac');
  assert.equal(execFileSync('/usr/bin/git',['-C',source,'status','--porcelain'],{encoding:'utf8'}),'');
  const original=fs.readFileSync(path.join(source,'src/net-address.ts'));
  const historical=JSON.parse(fs.readFileSync(evidencePath,'utf8'));
  const [change]=historical.patch_preview.changes;
  assert.equal(historical.patch_preview.changes.length,1);
  assert.equal(change.path,'src/net-address.ts');
  assert.equal(sha(original),change.old_hash);

  const root=fs.mkdtempSync('/tmp/opencode/orbit-export-repro-');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const repairRoot=path.join(root,'repair');
  fs.mkdirSync(path.join(repairRoot,'src'),{recursive:true});
  fs.writeFileSync(path.join(repairRoot,change.path),original);
  const diffFile=path.join(root,'repair.patch');
  fs.writeFileSync(diffFile,historical.patch_preview.patch_text);
  execFileSync('/usr/bin/git',['-C',repairRoot,'apply','--check',diffFile]);
  execFileSync('/usr/bin/git',['-C',repairRoot,'apply',diffFile]);
  const repaired=fs.readFileSync(path.join(repairRoot,change.path));
  assert.equal(sha(repaired),change.new_hash);

  const [{SqliteWorkspaceStore},{WorkbenchStore},{WorkbenchData},{createWorkbenchEnvironments},{createWorkbenchExecution},{createWorkbenchWorkflow},{openProjectRoot},{initial},{commandIdentity}]=await Promise.all([
    deployed('server/sqlite-workspace-store.mjs'),deployed('server/workbench-store.mjs'),deployed('server/workbench-data.mjs'),
    deployed('server/workbench-environments.mjs'),deployed('server/workbench-execution.mjs'),deployed('server/workbench-workflow.mjs'),
    deployed('server/project-files.mjs'),deployed('src/model.ts'),deployed('server/command-identity.mjs'),
  ]);
  const store=new SqliteWorkspaceStore(path.join(root,'runtime'));
  t.after(()=>store.close());
  const workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(source);
  const project=records.register(workspace_id,{root:source,name:'Isolated RouteTok export reproduction',identity:opened.identity});opened.close();
  const scope={workspace_id,project_id:project.id};
  const environments=createWorkbenchEnvironments({store,records,data,registryCache:cache});
  const execution=createWorkbenchExecution({store,records,data,environments});
  t.after(()=>execution.close());
  const workflow=createWorkbenchWorkflow({store,records,data,execution});
  const call=(action,fields={})=>execution.dispatch({...scope,action,...fields});
  const flow=(action,fields={})=>workflow.dispatch({...scope,action,...fields});

  const {task}=await call('task_create',{title:'RouteTok dependency-backed artifact reproduction',acceptance_statement:'All 293 tests pass, including five regression tests',check_definition_id:'node-test',profile_id:'default',session_id:'isolated-export-repro'});
  const cp=await call('candidate_preview',{task_id:task.id});
  const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:cp.preview_id,preview_digest:cp.preview.digest});
  const profilePreview=await environments.dispatch({...scope,action:'profile_preview',candidate_id:candidate.id,required_inputs:['package.json','package-lock.json']});
  assert.equal(profilePreview.registry.test_runtime,'tsx');
  assert.equal(profilePreview.network_policy,'offline_only');
  const profile=await environments.dispatch({...scope,action:'profile_approve',preview_id:profilePreview.preview_id,preview_digest:profilePreview.preview_digest});
  const prepared=await environments.dispatch({...scope,action:'environment_prepare',profile_id:profile.id});
  assert.equal(prepared.status,'ready');
  const before=await call('candidate_read',{candidate_id:candidate.id,path:change.path});
  assert.equal(before.file.hash,change.old_hash);
  await call('candidate_edit',{candidate_id:candidate.id,path:change.path,expected_hash:before.file.hash,content:repaired.toString('utf8')});
  const acceptance=await call('task_acceptance_preview',{task_id:task.id,candidate_id:candidate.id,expected_acceptance_digest:task.acceptance_digest,required_checks:[{definition_id:'node-test',execution_profile_id:profile.id}]});
  await call('task_acceptance_approve',{task_id:task.id,candidate_id:candidate.id,preview_id:acceptance.preview_id,preview_digest:acceptance.preview.digest});
  const check=await call('check_preview',{candidate_id:candidate.id,definition_id:'node-test'});
  assert.equal(check.preview.execution_profile_id,profile.id);
  assert.equal(check.preview.required_test_files.length,60);
  const run=await call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  assert.equal(run.evidence.verdict,'pass',JSON.stringify(run.evidence));
  assert.equal(run.evidence.test_results.tests,293);
  assert.equal(run.evidence.test_results.passed,293);
  assert.equal(run.evidence.test_results.complete,true);
  assert.equal(run.evidence.test_results.covered_files.length,60);
  assert.equal(run.evidence.execution_profile_id,profile.id);
  const current=await call('candidate_get',{candidate_id:candidate.id});
  assert.equal(current.acceptance_complete,true);
  const {review}=await call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const selection={task_id:task.id,candidate_id:candidate.id,review_id:review.id};
  const preview=await flow('patch_preview',selection);
  assert.equal(preview.roundtrip.verified,true);
  assert.deepEqual(preview.changes.map(item=>item.path),[change.path]);
  const op_id=randomUUID();
  await assert.rejects(flow('patch_export',{...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id}),{code:'unsupported'});
  const [failed]=(await flow('patch_list',{op_id})).patches;
  assert.equal(failed.status,'preparation_failed');
  assert.equal(failed.verification_status,null);
  await assert.rejects(flow('private_patch_get',{artifact_id:failed.artifact_id}),{code:'permission_denied'});
  assert.equal(execFileSync('/usr/bin/git',['-C',source,'status','--porcelain'],{encoding:'utf8'}),'');
  assert.deepEqual(fs.readFileSync(path.join(source,change.path)),original);
  assert.equal(fs.existsSync(path.join(source,'node_modules')),false);
  console.log(JSON.stringify({release,source_commit:'7e3a1fb',prepared_profile:profile.id,required_files:check.preview.required_test_files.length,candidate_check:{verdict:run.evidence.verdict,tests:run.evidence.test_results.tests,covered_files:run.evidence.test_results.covered_files.length},review:'approved',patch_preview_roundtrip:preview.roundtrip.verified,export_error:'unsupported',receipt_status:failed.status,private_patch_get:'permission_denied'}));
});
