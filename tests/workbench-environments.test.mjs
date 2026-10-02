import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createWorkbenchEnvironments,environmentSchema} from '../server/workbench-environments.mjs';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createArtifactVerifier} from '../server/workbench-artifact-verification.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {captureProject} from '../server/project-files.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('offline locked file tarball dependency prepares privately and executes a test import',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-environment-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const library=path.join(tmp,'library');fs.mkdirSync(library);
  fs.writeFileSync(path.join(library,'package.json'),JSON.stringify({name:'fixture-lib',version:'1.0.0',main:'index.js',scripts:{install:'exit 99'}}));
  fs.writeFileSync(path.join(library,'index.js'),'module.exports = 41;\n');
  const packed=spawnSync(process.execPath,[path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js'),'pack','--ignore-scripts','--offline','--pack-destination',tmp],{cwd:library,encoding:'utf8',env:{PATH:path.dirname(process.execPath),HOME:tmp,NPM_CONFIG_CACHE:path.join(tmp,'cache'),NPM_CONFIG_REGISTRY:'http://127.0.0.1:9/'}});
  assert.equal(packed.status,0,packed.stderr);
  const tarball=fs.readFileSync(path.join(tmp,'fixture-lib-1.0.0.tgz'));
  const project=path.join(tmp,'project');fs.mkdirSync(path.join(project,'vendor'),{recursive:true});
  const pkg={name:'fixture-project',version:'1.0.0',dependencies:{'fixture-lib':'file:vendor/fixture-lib-1.0.0.tgz'}};
  const lock={name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:pkg.version,dependencies:pkg.dependencies},'node_modules/fixture-lib':{version:'1.0.0',resolved:'file:vendor/fixture-lib-1.0.0.tgz',integrity:`sha512-${createHash('sha512').update(tarball).digest('base64')}`}}};
  const sources={'package.json':JSON.stringify(pkg),'package-lock.json':JSON.stringify(lock),'vendor/fixture-lib-1.0.0.tgz':tarball,'fixture.test.cjs':'const assert=require("node:assert/strict");assert.equal(require("fixture-lib"),42);\n'};
  for(const [name,content] of Object.entries(sources)){fs.mkdirSync(path.dirname(path.join(project,name)),{recursive:true});fs.writeFileSync(path.join(project,name),content);}
  const store=new SqliteWorkspaceStore(path.join(tmp,'runtime')),workspace_id=randomUUID();
  t.after(()=>store.close());
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store);
  const opened=openProjectRoot(project),registered=records.register(workspace_id,{root:project,name:'Offline dependency fixture',identity:opened.identity});opened.close();
  const project_id=registered.id,env=createWorkbenchEnvironments({store,records,data}),execution=createWorkbenchExecution({store,records,data,environments:env});
  const call=(action,fields={})=>execution.dispatch({action,workspace_id,project_id,...fields});
  const {task}=await call('task_create',{title:'Repair failing import test',acceptance_statement:'dependency test passes',check_definition_id:'node-test',profile_id:'default',session_id:'fixture'});
  const candidatePreview=await call('candidate_preview',{task_id:task.id});
  const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:candidatePreview.preview_id,preview_digest:candidatePreview.preview.digest});
  const candidate_id=candidate.id;
  const base={workspace_id,project_id};
  assert.equal(environmentSchema.oneOf.length,4);
  const preview=await env.dispatch({...base,action:'profile_preview',candidate_id,required_inputs:['package.json','package-lock.json','vendor/fixture-lib-1.0.0.tgz']});
  assert.deepEqual(preview.command.slice(0,4),['/usr/bin/timeout','--kill-after=5s','60s',preview.toolchain.node]);
  const approved=await env.dispatch({...base,action:'profile_approve',preview_id:preview.preview_id,preview_digest:preview.preview_digest});
  const ready=await env.dispatch({...base,action:'environment_prepare',profile_id:approved.id});
  assert.equal(ready.status,'ready');assert.equal(ready.prepared.network_policy,'offline_only');
  assert.deepEqual(env.profileReadiness({...base,profile_id:approved.id,candidate_id}).identity,env.verifyProfile({...base,profile_id:approved.id,candidate_id}));
  assert.equal(env.profileReadiness({...base,profile_id:randomUUID(),candidate_id}).reason,'execution_profile_missing');
  const changeProfile=(fields,expected)=>{
    const original=data.get('profiles',workspace_id,project_id,approved.id);
    const changed=data.update('profiles',workspace_id,project_id,approved.id,original.revision,fields);
    try{
      assert.equal(env.profileReadiness({...base,profile_id:approved.id,candidate_id}).reason,expected);
      assert.throws(()=>env.verifyProfile({...base,profile_id:approved.id,candidate_id}));
    }finally{data.update('profiles',workspace_id,project_id,approved.id,changed.revision,Object.fromEntries(Object.keys(fields).map(key=>[key,original[key]])));}
  };
  for(const [key,value] of [['profile_id',randomUUID()],['profile_version',2],['lock_hash','0'.repeat(64)],['toolchain_hash','0'.repeat(64)],['node_path','/usr/bin/false'],['source_hash','invalid'],['network_policy','online'],['lifecycle_policy','scripts'],['dependency_root',project],['environment_identity','0'.repeat(64)]]){
    const profile=data.get('profiles',workspace_id,project_id,approved.id);
    changeProfile({prepared:{...profile.prepared,[key]:value}},'execution_profile_stale');
  }
  changeProfile({profile_version:2},'unsupported_profile_kind');
  changeProfile({registry:{kind:'unknown-profile'}},'unsupported_profile_kind');
  changeProfile({network_policy:'online'},'unsupported_profile_kind');
  changeProfile({lifecycle_policy:'run_scripts'},'unsupported_profile_kind');
  changeProfile({command:['/usr/bin/false']},'unsupported_profile_kind');
  changeProfile({toolchain:{node:'/usr/bin/false'}},'toolchain_changed');
  assert.equal(fs.existsSync(path.join(project,'node_modules')),false);
  // Unit approval boundary only: this fixture describes identity, never claims
  // or simulates guest execution. Real containment has its own gated test.
  let providerIdentity='a'.repeat(64);
  const sandboxProvider={kind:'gvisor',describe:()=>({available:true,kind:'gvisor',provider_identity:providerIdentity,guest_node_version:'v22.0.0',guest_node_sha256:'c'.repeat(64),platform:'systrap'})};
  const isolated=createWorkbenchEnvironments({store,records,data,sandboxProvider});
  const guestPreview=await isolated.dispatch({...base,action:'profile_preview',candidate_id,execution_backend:'gvisor',required_inputs:['package.json','package-lock.json','vendor/fixture-lib-1.0.0.tgz']});
  assert.equal(guestPreview.profile_version,2);assert.equal(guestPreview.check_toolchain.node,'/usr/local/bin/node');
  providerIdentity='b'.repeat(64);
  await assert.rejects(isolated.dispatch({...base,action:'profile_approve',preview_id:guestPreview.preview_id,preview_digest:guestPreview.preview_digest}),{code:'stale_resource'});
  providerIdentity='a'.repeat(64);
  const guestApproved=await isolated.dispatch({...base,action:'profile_approve',preview_id:guestPreview.preview_id,preview_digest:guestPreview.preview_digest});
  const guestReady=await isolated.dispatch({...base,action:'environment_prepare',profile_id:guestApproved.id});
  assert.equal(guestReady.prepared.execution_backend,'gvisor');assert.equal(guestReady.prepared.provider_identity,providerIdentity);
  assert.equal(isolated.verifyProfile({...base,profile_id:guestReady.id,candidate_id}).execution_backend,'gvisor');
  const guestView=isolated.createExecutionView({...base,profile_id:guestReady.id,candidate_id});assert.equal(guestView.provider,sandboxProvider);
  providerIdentity='b'.repeat(64);
  assert.equal(isolated.profileReadiness({...base,profile_id:guestReady.id,candidate_id}).reason,'sandbox_provider_changed');assert.throws(()=>guestView.verify(),{code:'stale_resource'});
  // Host factory cannot reinterpret the stored guest approval without its provider.
  assert.equal(env.profileReadiness({...base,profile_id:guestReady.id,candidate_id}).reason,'sandbox_provider_unavailable');
  providerIdentity='a'.repeat(64);guestView.dispose();
  const view=env.createExecutionView({...base,profile_id:approved.id,candidate_id});
  try{
    const first=spawnSync(process.execPath,['fixture.test.cjs'],{cwd:view.root,encoding:'utf8'});
    assert.notEqual(first.status,0,'the intentionally wrong assertion fails with the installed library');
    fs.writeFileSync(path.join(view.root,'fixture.test.cjs'),'const assert=require("node:assert/strict");assert.equal(require("fixture-lib"),41);\n');
    const repaired=spawnSync(process.execPath,['fixture.test.cjs'],{cwd:view.root,encoding:'utf8'});
    assert.equal(repaired.status,0,repaired.stderr);
    assert.equal(fs.readFileSync(path.join(project,'fixture.test.cjs'),'utf8'),sources['fixture.test.cjs']);
  }finally{view.dispose();}
  await assert.rejects(env.dispatch({...base,action:'profile_preview',candidate_id,required_inputs:['package.json','package-lock.json']}),{code:'unsupported'});
  const file=await call('candidate_read',{candidate_id,path:'fixture.test.cjs'});
  const fixedTest='const test=require("node:test");const assert=require("node:assert/strict");test("locked dependency",()=>assert.equal(require("fixture-lib"),41));\n';
  const edited=await call('candidate_edit',{candidate_id,path:'fixture.test.cjs',expected_hash:file.file.hash,content:fixedTest});
  assert.notEqual(edited.candidate.hash,candidate.hash);
  const repairedView=env.createExecutionView({...base,profile_id:approved.id,candidate_id});
  assert.equal(repairedView.prepared.source_hash,edited.candidate.hash);
  repairedView.dispose();
  const stage=path.join(store.root,'workbench-patches',`.verify-${randomUUID()}`,'roundtrip');
  fs.mkdirSync(path.join(stage,'.git'),{recursive:true});
  for(const item of edited.candidate.files){const dest=path.join(stage,item.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(project,item.path),dest);}
  fs.writeFileSync(path.join(stage,'fixture.test.cjs'),fixedTest);
  const staged_source={root:stage,files:edited.candidate.files.map(file=>({...file,mode:'100644'})),hash:edited.candidate.hash};
  const staged=env.createExecutionView({...base,profile_id:approved.id,candidate_id,staged_source});
  assert.equal(fs.readFileSync(path.join(staged.root,'fixture.test.cjs'),'utf8'),fs.readFileSync(path.join(stage,'fixture.test.cjs'),'utf8'));
  assert.equal(staged.verify().source_hash,edited.candidate.hash);
  const originalProfile=data.get('profiles',workspace_id,project_id,approved.id);
  const altered=data.update('profiles',workspace_id,project_id,approved.id,originalProfile.revision,{prepared:{...originalProfile.prepared,profile_version:2}});
  try{assert.throws(()=>staged.verify(),{code:'stale_resource'},'view rechecks the durable prepared profile after construction');}
  finally{data.update('profiles',workspace_id,project_id,approved.id,altered.revision,{prepared:originalProfile.prepared});}
  assert.equal(staged.verify().source_hash,edited.candidate.hash);
  const acceptance=await call('task_acceptance_preview',{task_id:task.id,candidate_id,expected_acceptance_digest:task.acceptance_digest,required_checks:[{definition_id:'node-test',execution_profile_id:approved.id}]});
  await call('task_acceptance_approve',{task_id:task.id,candidate_id,preview_id:acceptance.preview_id,preview_digest:acceptance.preview.digest});
  const spec=await call('check_preview',{candidate_id,definition_id:'node-test'});
  const checked=await call('check_run',{candidate_id,preview_id:spec.preview_id,preview_digest:spec.preview.spec_digest,op_id:randomUUID()});
  assert.equal(checked.evidence.verdict,'pass',JSON.stringify(checked.evidence));
  const current=await call('candidate_get',{candidate_id});
  const {review}=await call('review_decide',{candidate_id,evidence_ids:[checked.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const finalTask=data.get('tasks',workspace_id,project_id,task.id),source=captureProject(registered);
  const finalCandidate=data.get('candidates',workspace_id,project_id,candidate_id),patchRoot=path.join(store.root,'workbench-patches');
  const privatePatch=path.join(patchRoot,`${randomUUID()}.patch`);fs.writeFileSync(privatePatch,'verified patch',{mode:0o600});
  const receipt=data.create('patches',{...base,task_id:task.id,candidate_id,candidate_hash:finalCandidate.hash,candidate_generation:finalCandidate.generation,review_id:review.id,review_identity:review.review_identity,status:'preparing',artifact_hash:sha('verified patch'),bytes:14,private_root:privatePatch,source:{manifest_hash:source.hash,files:source.manifest.map(file=>({...file,mode:'100644'}))},candidate:{files:staged_source.files},review:{required_check_state:{acceptance_digest:finalTask.acceptance_digest}},roundtrip:{verified:true}});
  const verifier=createArtifactVerifier({store,records,data,gate:createWorkbenchGate(),environments:env,verifyCurrent:()=>{env.verifyProfile({...base,profile_id:approved.id,candidate_id});}});
  const verified=await verifier.verifyPatchArtifact({...base,artifact_id:receipt.id,stage_root:stage});
  assert.equal(verified.verification.status,'verified');
  const result=verified.verification.results[0];
  assert.equal(result.execution_profile_id,approved.id);
  assert.deepEqual(result.execution_profile,finalTask.acceptance.required_checks[0].execution_profile);
  assert.equal(result.execution_observation.verified_view,true);
  assert.equal(result.execution_observation.dependency_before,ready.prepared.dependency_hash);
  assert.equal(result.execution_observation.dependency_after,ready.prepared.dependency_hash);
  assert.deepEqual(result.execution_observation.allowed_outputs,[]);
  const {id:_id,revision:_revision,version:_version,created_at:_created,updated_at:_updated,...receiptFields}=receipt;
  const mismatched=data.create('patches',{...receiptFields,status:'preparing',verification:null});
  const wrongIdentity={...env,verifyProfile:args=>({...env.verifyProfile(args),dependency_hash:'0'.repeat(64)})};
  const wrongVerifier=createArtifactVerifier({store,records,data,gate:createWorkbenchGate(),environments:wrongIdentity,verifyCurrent:()=>{}});
  await assert.rejects(wrongVerifier.verifyPatchArtifact({...base,artifact_id:mismatched.id,stage_root:stage}),{code:'stale_resource'});
  assert.equal(data.get('patches',workspace_id,project_id,mismatched.id).status,'preparing');
  const pending=data.create('patches',{...receiptFields,status:'preparing',verification:null});
  const update=data.update.bind(data);let faulted=false;
  data.update=(kind,w,p,id,revision,fields)=>{
    if(!faulted&&kind==='patches'&&id===pending.id&&fields.status==='verified'){faulted=true;throw Object.assign(Error('finalization fault'),{code:'unavailable'});}
    return update(kind,w,p,id,revision,fields);
  };
  try{await assert.rejects(verifier.verifyPatchArtifact({...base,artifact_id:pending.id,stage_root:stage}),{code:'unavailable'});}finally{data.update=update;}
  assert.equal(faulted,true);
  const restartGate=createWorkbenchGate(),restarted=createArtifactVerifier({store,records,data,gate:restartGate,environments:env,verifyCurrent:()=>{env.verifyProfile({...base,profile_id:approved.id,candidate_id});}});
  const recovery=restarted.patchArtifactRecovery({...base,artifact_id:pending.id});assert.equal(recovery.recoverable,true);
  fs.rmSync(stage,{recursive:true});
  const replay=restarted.retryPatchArtifact({...base,artifact_id:pending.id,expected_digest:recovery.recovery_digest});
  assert.equal(replay.verification.status,'verified');assert.deepEqual(replay.verification.results[0].execution_profile,result.execution_profile);
  assert.equal(restarted.retryPatchArtifact({...base,artifact_id:pending.id,expected_digest:recovery.recovery_digest}).idempotent,true);
  restartGate.claim('job',randomUUID())();
  fs.mkdirSync(path.join(stage,'.git'),{recursive:true});fs.writeFileSync(path.join(stage,'fixture.test.cjs'),fixedTest);
  for(const item of edited.candidate.files)if(item.path!=='fixture.test.cjs'){const dest=path.join(stage,item.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(project,item.path),dest);}
  fs.chmodSync(path.join(stage,'fixture.test.cjs'),0o700);
  assert.throws(()=>staged.verify(),{code:'stale_resource'},'round-trip mode drift invalidates the view');
  fs.chmodSync(path.join(stage,'fixture.test.cjs'),0o600);
  fs.writeFileSync(path.join(stage,'fixture.test.cjs'),'changed after stage validation\n');
  assert.throws(()=>staged.verify(),{code:'stale_resource'});
  assert.throws(()=>env.createExecutionView({...base,profile_id:approved.id,candidate_id,staged_source:{...staged_source,root:project}}),{code:'permission_denied'});
  const beforeProfile=data.get('profiles',workspace_id,project_id,approved.id);
  const changed=data.update('profiles',workspace_id,project_id,approved.id,beforeProfile.revision,{toolchain_hash:'0'.repeat(64)});
  assert.equal(env.profileReadiness({...base,profile_id:approved.id,candidate_id}).reason,'toolchain_changed');
  data.update('profiles',workspace_id,project_id,approved.id,changed.revision,{toolchain_hash:beforeProfile.toolchain_hash});
  const installed=path.join(ready.prepared.dependency_root,'fixture-lib','index.js');
  fs.writeFileSync(installed,'module.exports = 0;\n');
  assert.equal(env.profileReadiness({...base,profile_id:approved.id,candidate_id}).reason,'execution_profile_stale');
  assert.throws(()=>env.createExecutionView({...base,profile_id:approved.id,candidate_id}),{code:'stale_resource'});
  fs.rmSync(ready.prepared.dependency_root,{recursive:true});
  assert.equal(env.profileReadiness({...base,profile_id:approved.id,candidate_id}).reason,'dependency_artifact_missing');
  await assert.rejects(env.dispatch({...base,action:'environment_prepare',profile_id:approved.id}),{code:'busy'});
});
