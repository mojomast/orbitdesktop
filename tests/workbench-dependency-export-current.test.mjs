import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchEnvironments} from '../server/workbench-environments.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchWorkflow} from '../server/workbench-workflow.mjs';
import {captureProject,openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(root,...args)=>execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8'}).trim();
const scope=(root,source,t,registryCache)=>{
  const store=new SqliteWorkspaceStore(path.join(root,'runtime'));
  const workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(source);
  const project=records.register(workspace_id,{root:source,name:'Dependency artifact fixture',identity:opened.identity});opened.close();
  const base={workspace_id,project_id:project.id};
  const environments=createWorkbenchEnvironments({store,records,data,registryCache});
  const execution=createWorkbenchExecution({store,records,data,environments});
  const workflow=createWorkbenchWorkflow({store,records,data,execution});
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=(action,fields={})=>execution.dispatch({...base,action,...fields});
  const flow=(action,fields={})=>workflow.dispatch({...base,action,...fields});
  return {root,source,store,records,data,project,base,environments,execution,call,flow};
};

async function reviewed(f,repair,{profileInputs=['package.json','package-lock.json'],requiredChecks}={}){
  const {task}=await f.call('task_create',{title:'Repair dependency-backed test',acceptance_statement:'Pinned test suite passes with dependencies',check_definition_id:'node-test',profile_id:'default',session_id:'artifact-fixture'});
  const cp=await f.call('candidate_preview',{task_id:task.id});
  const {candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:cp.preview_id,preview_digest:cp.preview.digest});
  const profilePreview=await f.environments.dispatch({...f.base,action:'profile_preview',candidate_id:candidate.id,required_inputs:profileInputs});
  const profile=await f.environments.dispatch({...f.base,action:'profile_approve',preview_id:profilePreview.preview_id,preview_digest:profilePreview.preview_digest});
  const ready=await f.environments.dispatch({...f.base,action:'environment_prepare',profile_id:profile.id});
  assert.equal(ready.status,'ready');
  const {path:filename,content}=repair;
  const before=await f.call('candidate_read',{candidate_id:candidate.id,path:filename});
  await f.call('candidate_edit',{candidate_id:candidate.id,path:filename,expected_hash:before.file.hash,content});
  const acceptance=await f.call('task_acceptance_preview',{task_id:task.id,candidate_id:candidate.id,expected_acceptance_digest:task.acceptance_digest,required_checks:requiredChecks??[{definition_id:'node-test',execution_profile_id:profile.id}]});
  await f.call('task_acceptance_approve',{task_id:task.id,candidate_id:candidate.id,preview_id:acceptance.preview_id,preview_digest:acceptance.preview.digest});
  const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'node-test'});
  const run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  assert.equal(run.evidence.verdict,'pass',JSON.stringify(run.evidence));
  const current=await f.call('candidate_get',{candidate_id:candidate.id});
  const {review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const selection={task_id:task.id,candidate_id:candidate.id,review_id:review.id};
  const preview=await f.flow('patch_preview',selection);
  assert.equal(preview.roundtrip.verified,true);
  return {task,candidate,profile,ready,run,review,selection,preview};
}

function localFixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/orbit-export-local-'),library=path.join(root,'lib'),source=path.join(root,'source');
  fs.mkdirSync(library);fs.mkdirSync(path.join(source,'vendor'),{recursive:true});
  fs.writeFileSync(path.join(library,'package.json'),JSON.stringify({name:'export-fixture-lib',version:'1.0.0',main:'index.js'}));
  fs.writeFileSync(path.join(library,'index.js'),'module.exports = 41;\n');
  const npm=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
  const packed=spawnSync(process.execPath,[npm,'pack','--ignore-scripts','--offline','--pack-destination',root],{cwd:library,encoding:'utf8',env:{PATH:path.dirname(process.execPath),HOME:root,NPM_CONFIG_CACHE:path.join(root,'cache'),NPM_CONFIG_REGISTRY:'http://127.0.0.1:9/'}});
  assert.equal(packed.status,0,packed.stderr);
  const tarball=fs.readFileSync(path.join(root,'export-fixture-lib-1.0.0.tgz'));
  const dependencies={'export-fixture-lib':'file:vendor/export-fixture-lib-1.0.0.tgz'};
  const pkg={name:'export-artifact-fixture',version:'1.0.0',dependencies};
  const lock={name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:pkg.version,dependencies},'node_modules/export-fixture-lib':{version:'1.0.0',resolved:'file:vendor/export-fixture-lib-1.0.0.tgz',integrity:`sha512-${createHash('sha512').update(tarball).digest('base64')}`}}};
  const original='module.exports = require("export-fixture-lib") - 1;\n';
  const repair='module.exports = require("export-fixture-lib") + 1;\n';
  for(const [name,bytes] of Object.entries({'package.json':JSON.stringify(pkg),'package-lock.json':JSON.stringify(lock),'vendor/export-fixture-lib-1.0.0.tgz':tarball,'math.cjs':original,'math.test.cjs':'const test=require("node:test");const assert=require("node:assert/strict");test("dependency-backed repair",()=>assert.equal(require("./math.cjs"),42));\n'}))fs.writeFileSync(path.join(source,name),bytes);
  return {...scope(root,source,t),npm,original,repair,profileInputs:['package.json','package-lock.json','vendor/export-fixture-lib-1.0.0.tgz']};
}

const request=({selection,preview},op_id=randomUUID())=>({...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});
const countChecks=f=>fs.readdirSync(path.join(f.store.root,'workbench-execution')).filter(name=>name.startsWith('check-')).length;
const assertNoArtifact=async(f,op_id)=>{
  const list=await f.flow('patch_list',{op_id});
  for(const item of list.patches)assert.notEqual(item.status,'available');
};

test('dependency export checks a fresh patch-applied view and replays without another execution',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  assert.equal(state.run.evidence.test_results.tests,1);
  const prior=countChecks(f),priorJobs=f.data.list('jobs',f.base.workspace_id,f.base.project_id).length;
  const body=request(state),[first,concurrent]=await Promise.all([f.flow('patch_export',body),f.flow('patch_export',body)]);
  assert.equal(first.patch.status,'available');assert.equal(first.patch.id,concurrent.patch.id);
  assert.equal(first.patch.verification.status,'verified');
  const [result]=first.patch.verification.results;
  assert.equal(result.verdict,'pass');assert.equal(result.test_results.tests,1);
  assert.equal(result.execution_profile_id,state.profile.id);
  assert.deepEqual(result.execution_profile,state.run.evidence.execution_profile);
  assert.equal(result.execution_observation.source_before,first.patch.candidate_hash);
  assert.equal(result.execution_observation.source_after,first.patch.candidate_hash);
  assert.equal(result.execution_observation.dependency_before,state.ready.prepared.dependency_hash);
  assert.equal(result.execution_observation.dependency_after,state.ready.prepared.dependency_hash);
  assert.equal(result.execution_observation.verified_view,true);
  assert.equal(countChecks(f),prior+1,'artifact verification must execute its own check');
  assert.equal(f.data.list('jobs',f.base.workspace_id,f.base.project_id).length,priorJobs,'artifact checks must not create candidate jobs');
  const get=await f.flow('private_patch_get',{artifact_id:first.patch.id});
  assert.equal(hash(Buffer.from(get.patch)),first.patch.artifact_hash);
  const fresh=path.join(f.root,'fresh');fs.mkdirSync(fresh);
  for(const file of captureProject(f.project).files){const target=path.join(fresh,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file.bytes);}
  fs.writeFileSync(path.join(f.root,'retrieved.patch'),get.patch);
  execFileSync('/usr/bin/git',['-C',fresh,'apply','--check',path.join(f.root,'retrieved.patch')]);
  execFileSync('/usr/bin/git',['-C',fresh,'apply',path.join(f.root,'retrieved.patch')]);
  assert.equal(hash(fs.readFileSync(path.join(fresh,'math.cjs'))),hash(Buffer.from(f.repair)));
  assert.equal(hash(fs.readFileSync(path.join(fresh,'package-lock.json'))),hash(fs.readFileSync(path.join(f.source,'package-lock.json'))));
  const replay=await f.flow('patch_export',body);assert.equal(replay.idempotent,true);assert.equal(replay.patch.id,first.patch.id);
  assert.equal(countChecks(f),prior+1);
  await assert.rejects(f.flow('patch_export',{...body,task_id:randomUUID()}),{code:'conflict'});
  assert.equal(countChecks(f),prior+1);
});

test('tampered prepared dependency after preview refuses export without publishing or running artifact check',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  const prior=countChecks(f),body=request(state);
  fs.writeFileSync(path.join(state.ready.prepared.dependency_root,'export-fixture-lib','index.js'),'module.exports = 42;\n');
  await assert.rejects(f.flow('patch_export',body),{code:'stale_resource'});
  await assertNoArtifact(f,body.op_id);
  assert.equal(countChecks(f),prior);
});

test('a missing environment cannot turn passing unprofiled evidence into a dependency export',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  const prior=countChecks(f),body=request(state);
  const stored=f.data.get('profiles',f.base.workspace_id,f.base.project_id,state.profile.id);
  f.data.update('profiles',f.base.workspace_id,f.base.project_id,stored.id,stored.revision,{status:'failed',prepared:null});
  await assert.rejects(f.flow('patch_export',body),{code:'stale_resource'});
  await assertNoArtifact(f,body.op_id);
  assert.equal(countChecks(f),prior);
});

test('changed lock after review refuses export and preserves the original project',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  const prior=countChecks(f),body=request(state),lock=path.join(f.source,'package-lock.json'),original=fs.readFileSync(lock);
  try{
    fs.writeFileSync(lock,Buffer.concat([original,Buffer.from('\n')]));
    await assert.rejects(f.flow('patch_export',body),{code:'stale_resource'});
    await assertNoArtifact(f,body.op_id);
    assert.equal(countChecks(f),prior);
  }finally{fs.writeFileSync(lock,original);}
});

test('changed candidate after preview cannot replay old review or export a stale artifact',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  const prior=countChecks(f),body=request(state);
  const current=await f.call('candidate_read',{candidate_id:state.candidate.id,path:'math.cjs'});
  await f.call('candidate_edit',{candidate_id:state.candidate.id,path:'math.cjs',expected_hash:current.file.hash,content:'module.exports = 0;\n'});
  await assert.rejects(f.flow('patch_export',body),{code:'stale_resource'});
  await assertNoArtifact(f,body.op_id);
  assert.equal(countChecks(f),prior);
});

test('tampering the fresh patch-applied stage refuses publication despite passing candidate evidence',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  const prior=countChecks(f),body=request(state),verify=f.execution.verifyPatchArtifact;
  f.execution.verifyPatchArtifact=async input=>{
    fs.writeFileSync(path.join(input.stage_root,'math.cjs'),'module.exports = 0;\n');
    return verify(input);
  };
  await assert.rejects(f.flow('patch_export',body),{code:'stale_resource'});
  const [failed]=(await f.flow('patch_list',{op_id:body.op_id})).patches;
  assert.equal(failed.status,'preparation_failed');
  await assert.rejects(f.flow('private_patch_get',{artifact_id:failed.artifact_id}),{code:'permission_denied'});
  assert.equal(countChecks(f),prior);
});

test('toolchain identity drift after preview refuses export before executing artifact checks',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  const prior=countChecks(f),body=request(state);
  const stored=f.data.get('profiles',f.base.workspace_id,f.base.project_id,state.profile.id);
  f.data.update('profiles',f.base.workspace_id,f.base.project_id,stored.id,stored.revision,{toolchain_hash:'0'.repeat(64)});
  await assert.rejects(f.flow('patch_export',body),{code:'stale_resource'});
  await assertNoArtifact(f,body.op_id);
  assert.equal(countChecks(f),prior);
});

test('profile rebound to a foreign candidate cannot authorize artifact export',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  const prior=countChecks(f),body=request(state);
  const stored=f.data.get('profiles',f.base.workspace_id,f.base.project_id,state.profile.id);
  f.data.update('profiles',f.base.workspace_id,f.base.project_id,stored.id,stored.revision,{candidate_id:randomUUID()});
  await assert.rejects(f.flow('patch_export',body),{code:'stale_resource'});
  await assertNoArtifact(f,body.op_id);
  assert.equal(countChecks(f),prior);
});

test('acceptance revision after review invalidates old approval and preview',async t=>{
  const f=localFixture(t),state=await reviewed(f,{path:'math.cjs',content:f.repair},{profileInputs:f.profileInputs});
  const prior=countChecks(f),body=request(state);
  const task=f.data.get('tasks',f.base.workspace_id,f.base.project_id,state.task.id);
  const changed=await f.call('task_acceptance_preview',{task_id:state.task.id,candidate_id:state.candidate.id,expected_acceptance_digest:task.acceptance_digest,required_checks:[{definition_id:'node-test'}]});
  await f.call('task_acceptance_approve',{task_id:state.task.id,candidate_id:state.candidate.id,preview_id:changed.preview_id,preview_digest:changed.preview.digest});
  await assert.rejects(f.flow('patch_export',body),{code:'stale_resource'});
  await assertNoArtifact(f,body.op_id);
  assert.equal(countChecks(f),prior);
});

test('real RouteTok export independently verifies 293 tests and retrieved diff passes on a fresh base',{
  skip:!process.env.ORBIT_ROUTETOK_TEST_SOURCE||!process.env.ORBIT_ROUTETOK_TEST_CACHE||!process.env.ORBIT_ROUTETOK_REPAIR_EVIDENCE,timeout:300000,
},async t=>{
  const source=process.env.ORBIT_ROUTETOK_TEST_SOURCE,cache=process.env.ORBIT_ROUTETOK_TEST_CACHE;
  assert.equal(git(source,'rev-parse','HEAD'),'7e3a1fb024d62fcb0e2bfc994b7db3185bd41fac');
  assert.equal(git(source,'status','--porcelain'),'');
  const historical=JSON.parse(fs.readFileSync(process.env.ORBIT_ROUTETOK_REPAIR_EVIDENCE,'utf8'));
  const [change]=historical.patch_preview.changes;
  assert.equal(historical.patch_preview.changes.length,1);
  assert.equal(change.path,'src/net-address.ts');
  const root=fs.mkdtempSync('/tmp/opencode/orbit-export-routetok-');
  const temporary=path.join(root,'repaired');fs.mkdirSync(path.join(temporary,'src'),{recursive:true});
  const original=fs.readFileSync(path.join(source,change.path));assert.equal(hash(original),change.old_hash);
  fs.writeFileSync(path.join(temporary,change.path),original);
  const diffFile=path.join(root,'repair.patch');fs.writeFileSync(diffFile,historical.patch_preview.patch_text);
  execFileSync('/usr/bin/git',['-C',temporary,'apply','--check',diffFile]);
  execFileSync('/usr/bin/git',['-C',temporary,'apply',diffFile]);
  const repair=fs.readFileSync(path.join(temporary,change.path));assert.equal(hash(repair),change.new_hash);
  const f=scope(root,source,t,cache);
  const state=await reviewed(f,{path:change.path,content:repair.toString('utf8')});
  assert.equal(state.run.evidence.test_results.tests,293);
  assert.equal(state.run.evidence.test_results.covered_files.length,60);
  const prior=countChecks(f),body=request(state),exported=await f.flow('patch_export',body);
  assert.equal(exported.patch.status,'available');
  assert.equal(exported.patch.verification.status,'verified');
  assert.equal(countChecks(f),prior+1);
  const [result]=exported.patch.verification.results;
  assert.equal(result.execution_profile_id,state.profile.id);
  assert.deepEqual(result.execution_profile,state.run.evidence.execution_profile);
  assert.equal(result.execution_observation.source_before,exported.patch.candidate_hash);
  assert.equal(result.execution_observation.source_after,exported.patch.candidate_hash);
  assert.equal(result.execution_observation.dependency_before,state.ready.prepared.dependency_hash);
  assert.equal(result.execution_observation.dependency_after,state.ready.prepared.dependency_hash);
  assert.equal(result.execution_observation.verified_view,true);
  assert.equal(result.test_results.tests,293);assert.equal(result.test_results.passed,293);
  assert.equal(result.test_results.covered_files.length,60);
  assert.equal(result.test_results.complete,true);
  const downloaded=await f.flow('private_patch_get',{artifact_id:exported.patch.id});
  assert.equal(hash(Buffer.from(downloaded.patch)),exported.patch.artifact_hash);
  const fresh=path.join(root,'fresh-base');
  execFileSync('/usr/bin/git',['clone','--no-hardlinks','--quiet',source,fresh]);
  assert.equal(git(fresh,'rev-parse','HEAD'),git(source,'rev-parse','HEAD'));
  assert.equal(hash(fs.readFileSync(path.join(fresh,change.path))),change.old_hash);
  fs.writeFileSync(path.join(root,'export.patch'),downloaded.patch);
  execFileSync('/usr/bin/git',['-C',fresh,'apply','--check',path.join(root,'export.patch')]);
  execFileSync('/usr/bin/git',['-C',fresh,'apply',path.join(root,'export.patch')]);
  assert.equal(hash(fs.readFileSync(path.join(fresh,change.path))),change.new_hash);
  assert.equal(state.run.evidence.test_results.required_files.length,60);
  assert.ok(state.run.evidence.test_results.required_files.every(file=>fs.existsSync(path.join(fresh,file))));
  const npm=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
  const freshCache=path.join(root,'fresh-cache');fs.mkdirSync(freshCache);fs.cpSync(path.join(cache,'_cacache'),path.join(freshCache,'_cacache'),{recursive:true});
  const installed=spawnSync('/usr/bin/timeout',['--kill-after=5s','60s',process.execPath,npm,'ci','--include=dev','--ignore-scripts','--offline','--no-audit','--no-fund'],{cwd:fresh,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:root,NPM_CONFIG_CACHE:freshCache,NPM_CONFIG_REGISTRY:'http://127.0.0.1:9/',NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_GLOBALCONFIG:'/dev/null',NPM_CONFIG_UPDATE_NOTIFIER:'false'}});
  assert.equal(installed.status,0,installed.stderr);
  const retest=spawnSync('/usr/bin/timeout',['--kill-after=5s','90s',process.execPath,'--import',path.join(fresh,'node_modules','tsx','dist','loader.mjs'),'--test',...state.run.evidence.test_results.required_files],{cwd:fresh,encoding:'utf8',timeout:100000,maxBuffer:2*1024*1024,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root,NODE_OPTIONS:'',TSX_DISABLE_CACHE:'1'}});
  assert.equal(retest.status,0,retest.stderr.slice(-4000));
  assert.match(retest.stdout,/tests 293\b/);
  assert.match(retest.stdout,/pass 293\b/);
  assert.equal(git(source,'status','--porcelain'),'');
  assert.deepEqual(fs.readFileSync(path.join(source,change.path)),original);
  assert.equal(fs.existsSync(path.join(source,'node_modules')),false);
  console.log(JSON.stringify({current_artifact:exported.patch.id,artifact_check_count:result.test_results.tests,required_files:result.test_results.covered_files.length,artifact_hash:exported.patch.artifact_hash,source_head:git(fresh,'rev-parse','HEAD'),changed_file_hash:change.new_hash,fresh_retest:'293/293'}));
});
