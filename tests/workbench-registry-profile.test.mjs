import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {registryTypeScriptProfile} from '../server/workbench-registry-profile.mjs';
import {createWorkbenchEnvironments} from '../server/workbench-environments.mjs';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

test('TypeScript registry profile restricts toolchain, URLs and lock identity',()=>{
  const pkg={scripts:{test:'tsx --test "test/**/*.test.ts"'},devDependencies:{'@types/node':'1',tsx:'1',typescript:'1'}};
  const lock={packages:{'':{devDependencies:pkg.devDependencies},'node_modules/tsx':{resolved:'https://registry.npmjs.org/tsx/-/tsx-1.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}}};
  assert.equal(registryTypeScriptProfile(pkg,lock).test_runtime,'tsx');
  for(const resolved of ['http://registry.npmjs.org/tsx/-/x.tgz','https://evil.test/x.tgz','https://registry.npmjs.org/x.tgz?token=x','file:evil.tgz']){
    const changed=structuredClone(lock);changed.packages['node_modules/tsx'].resolved=resolved;
    assert.throws(()=>registryTypeScriptProfile(pkg,changed),{code:'unsupported'});
  }
  assert.throws(()=>registryTypeScriptProfile({...pkg,scripts:{test:'sh arbitrary.sh'}},lock),{code:'unsupported'});
  assert.throws(()=>registryTypeScriptProfile({...pkg,dependencies:{other:'1'}},lock),{code:'unsupported'});
  assert.throws(()=>registryTypeScriptProfile({...pkg,devDependencies:{...pkg.devDependencies,other:'1'}},lock),{code:'unsupported'});
});

test('real RouteTok lock prepares offline in a private view and runs TypeScript with pinned dependencies',{
  skip:!process.env.ORBIT_ROUTETOK_TEST_SOURCE||!process.env.ORBIT_ROUTETOK_TEST_CACHE,timeout:120000,
},async t=>{
  const root=fs.mkdtempSync('/tmp/opencode/orbit-ts-profile-');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime'));t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const workspace_id=randomUUID();store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),source=process.env.ORBIT_ROUTETOK_TEST_SOURCE,opened=openProjectRoot(source);
  const project=records.register(workspace_id,{root:source,name:'Real RouteTok profile',identity:opened.identity});opened.close();
  const base={workspace_id,project_id:project.id};
  const env=createWorkbenchEnvironments({store,records,data,registryCache:process.env.ORBIT_ROUTETOK_TEST_CACHE});
  const execution=createWorkbenchExecution({store,records,data,environments:env});t.after(()=>execution.close());
  const call=(action,fields={})=>execution.dispatch({...base,action,...fields});
  const {task}=await call('task_create',{title:'Profile acceptance',acceptance_statement:'Unchanged real TypeScript suite executes',check_definition_id:'node-test',profile_id:'default',session_id:'profile-acceptance'});
  const cp=await call('candidate_preview',{task_id:task.id});const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:cp.preview_id,preview_digest:cp.preview.digest});
  const preview=await env.dispatch({...base,action:'profile_preview',candidate_id:candidate.id,required_inputs:['package.json','package-lock.json']});
  assert.equal(preview.registry.test_runtime,'tsx');assert.ok(preview.command.includes('--include=dev'));assert.equal(preview.network_policy,'offline_only');
  const profile=await env.dispatch({...base,action:'profile_approve',preview_id:preview.preview_id,preview_digest:preview.preview_digest});
  const ready=await env.dispatch({...base,action:'environment_prepare',profile_id:profile.id});assert.equal(ready.status,'ready');
  const view=env.createExecutionView({...base,profile_id:profile.id,candidate_id:candidate.id});
  const tests=candidate.files.map(x=>x.path).filter(x=>/^test\/.*\.test\.ts$/.test(x));assert.equal(tests.length,59);
  const acceptance=await call('task_acceptance_preview',{task_id:task.id,candidate_id:candidate.id,expected_acceptance_digest:task.acceptance_digest,required_checks:[{definition_id:'node-test',execution_profile_id:profile.id}]});
  await call('task_acceptance_approve',{task_id:task.id,candidate_id:candidate.id,preview_id:acceptance.preview_id,preview_digest:acceptance.preview.digest});
  const check=await call('check_preview',{candidate_id:candidate.id,definition_id:'node-test'});
  const run=await call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  assert.equal(run.evidence.verdict,'pass',JSON.stringify(run.evidence));assert.ok(run.evidence.test_results.tests>=288);assert.equal(run.evidence.test_results.complete,true);
  console.log(JSON.stringify({real_typescript_files:tests.length,verdict:run.evidence.verdict,tests:run.evidence.test_results.tests,environment:run.evidence.environment}));
  view.verify();assert.equal(fs.existsSync(path.join(source,'node_modules')),false);
  const executable=path.join(view.root,'node_modules','@esbuild','linux-x64','bin','esbuild');
  assert.ok(fs.statSync(executable).mode&0o100,'native compiler permission is retained');
  fs.chmodSync(executable,0o600);assert.throws(()=>view.verify(),{code:'stale_resource'},'executable-mode tampering changes dependency identity');
});
