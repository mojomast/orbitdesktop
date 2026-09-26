import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchExecution,createExecutionGate} from '../server/workbench-execution.mjs';
import {createWorkbenchEnvironments} from '../server/workbench-environments.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

function fixture(t,{dependency=false,source}={}){
  const root=fs.mkdtempSync('/tmp/opencode/wb-loop-'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum=(a,b)=>a-b;');
  let pkg={name:'fixture-project',version:'1.0.0',type:'module'};
  if(dependency){
    const pack=path.join(root,'pack'),library=path.join(pack,'package');fs.mkdirSync(library,{recursive:true});
    fs.writeFileSync(path.join(library,'package.json'),JSON.stringify({name:'fixture-lib',version:'1.0.0',main:'index.js',scripts:{install:'exit 99'}}));
    fs.writeFileSync(path.join(library,'index.js'),'module.exports=41;');
    fs.mkdirSync(path.join(projectRoot,'vendor'));
    const tarball=path.join(projectRoot,'vendor/library.tgz');
    assert.equal(spawnSync('/usr/bin/tar',['-czf',tarball,'-C',pack,'package']).status,0);
    pkg={...pkg,dependencies:{'fixture-lib':'file:vendor/library.tgz'}};
    const lock={name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:pkg.version,dependencies:pkg.dependencies},'node_modules/fixture-lib':{version:'1.0.0',resolved:'file:vendor/library.tgz',integrity:`sha512-${createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}`}}};
    fs.writeFileSync(path.join(projectRoot,'package-lock.json'),JSON.stringify(lock));
  }
  fs.writeFileSync(path.join(projectRoot,'package.json'),JSON.stringify(pkg));
  fs.writeFileSync(path.join(projectRoot,'proof.test.mjs'),source??(dependency?"import test from 'node:test';import assert from 'node:assert/strict';import value from 'fixture-lib';import {sum} from './math.js';test('dependency sum',()=>assert.equal(sum(value,1),42));":"import test from 'node:test';test('actual',()=>{});"));
  const store=new SqliteWorkspaceStore(path.join(root,'private')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(projectRoot),project=records.register(workspace_id,{root:projectRoot,name:'Loop fixture',identity:opened.identity});opened.close();
  const gate=createExecutionGate(),environments=createWorkbenchEnvironments({store,records,data,gate}),execution=createWorkbenchExecution({store,records,data,gate,environments});
  const base={workspace_id,project_id:project.id},call=(action,fields={})=>execution.dispatch({action,...base,...fields}),env=(action,fields={})=>environments.dispatch({action,...base,...fields});
  const prepare=async(required_checks)=>{
    const {task}=await call('task_create',{title:'Loop',acceptance_statement:'Required checks pass',check_definition_id:'node-test',...(required_checks?{required_checks}:{}),profile_id:'default',session_id:'fixture'});
    const p=await call('candidate_preview',{task_id:task.id});const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});return {task,candidate};
  };
  const request=async(candidate_id,definition_id='node-test',execution_profile_id)=>{const p=await call('check_preview',{candidate_id,definition_id,...(execution_profile_id?{execution_profile_id}:{})});return {candidate_id,preview_id:p.preview_id,preview_digest:p.preview.spec_digest,op_id:randomUUID()};};
  const readyProfile=async candidate_id=>{const p=await env('profile_preview',{candidate_id,required_inputs:['package.json','package-lock.json','vendor/library.tgz']});const approved=await env('profile_approve',{preview_id:p.preview_id,preview_digest:p.preview_digest});return env('environment_prepare',{profile_id:approved.id});};
  const attach=async(task,candidate,profile)=>{const p=await call('task_acceptance_preview',{task_id:task.id,candidate_id:candidate.id,expected_acceptance_digest:task.acceptance_digest,required_checks:[{definition_id:'node-test',execution_profile_id:profile.id}]});return call('task_acceptance_approve',{task_id:task.id,candidate_id:candidate.id,preview_id:p.preview_id,preview_digest:p.preview.digest});};
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,projectRoot,store,records,data,gate,environments,execution,base,call,env,prepare,request,readyProfile,attach};
}
async function settled(f,id){for(let i=0;i<500;i++){const value=await f.call('job_get',{job_id:id});if(value.job.ended_at)return value;await new Promise(r=>setTimeout(r,10));}assert.fail('job did not settle');}
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`:JSON.stringify(value);
const reviewDigest=(task,candidate,evidence)=>createHash('sha256').update(stable({version:1,candidate_id:candidate.id,candidate_hash:candidate.hash,acceptance_digest:task.acceptance_digest,evidence:evidence.map(({id,artifact_hash,verdict})=>({id,artifact_hash,verdict})).sort((a,b)=>a.id.localeCompare(b.id))})).digest('hex');

test('actual offline dependency producer -> explicit acceptance -> measured fail -> COW repair -> pass',async t=>{
  const f=fixture(t,{dependency:true}),{task,candidate}=await f.prepare(),profile=await f.readyProfile(candidate.id);
  const approved=await f.attach(task,candidate,profile);assert.equal(approved.task.acceptance_version,2);
  const first=await f.call('check_run',await f.request(candidate.id,'node-test',profile.id));assert.equal(first.evidence.verdict,'fail');assert.equal(first.evidence.execution_profile_id,profile.id);
  assert.equal(first.evidence.test_results.valid,true);assert.equal(first.evidence.test_results.tests,1);assert.equal(first.evidence.test_results.failed,1,'the dependency imported and the substantive arithmetic assertion failed');
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  const edited=await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:file.file.hash,content:'export const sum=(a,b)=>a+b;'});
  const second=await f.call('check_run',await f.request(edited.candidate.id,'node-test',profile.id));assert.equal(second.evidence.verdict,'pass');assert.equal(second.evidence.environment.dependency_hash,profile.prepared.dependency_hash);
  assert.equal(second.evidence.execution_observation.source_before,edited.candidate.hash);assert.equal(second.evidence.execution_observation.source_after,edited.candidate.hash);
  assert.equal(fs.existsSync(path.join(f.projectRoot,'node_modules')),false);
});
test('multiple required definitions need latest passing evidence from every required check',async t=>{
  const f=fixture(t),{task,candidate}=await f.prepare([{definition_id:'node-test'},{definition_id:'host-regression'}]);
  const first=await f.call('check_run',await f.request(candidate.id));assert.equal(first.evidence.verdict,'pass');
  const get=()=>f.call('candidate_get',{candidate_id:candidate.id});
  await assert.rejects(f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[first.evidence.id],decision:'approved',expected_identity:reviewDigest(task,candidate,[first.evidence])}),{code:'stale_resource'});
  assert.equal((await f.call('check_run',await f.request(candidate.id,'host-regression'))).evidence.verdict,'fail');
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:file.file.hash,content:'export const sum=(a,b)=>a+b;'});
  const node=await f.call('check_run',await f.request(candidate.id)),host=await f.call('check_run',await f.request(candidate.id,'host-regression'));
  const review=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[node.evidence.id,host.evidence.id],decision:'approved',expected_identity:(await get()).review_identity});assert.equal(review.review.decision,'approved');
});
test('check_start returns durable admission before execution, settles independently and replays only its receipt',async t=>{
  const f=fixture(t,{source:"import test from 'node:test';test('slow',async()=>{await new Promise(r=>setTimeout(r,400));});"}),{candidate}=await f.prepare(),request=await f.request(candidate.id);
  const admission=await f.call('check_start',request);assert.equal(admission.accepted,true);assert.equal(admission.job.status,'starting');assert.equal(admission.job.pid,null);
  assert.equal(f.data.get('jobs',f.base.workspace_id,f.base.project_id,admission.job.id).id,admission.job.id);
  const retry=await f.call('check_start',request);assert.equal(retry.job.id,admission.job.id);assert.equal(retry.idempotent,true);
  const result=await settled(f,admission.job.id);assert.equal(result.evidence[0].verdict,'pass');assert.equal(f.gate.busy('job'),false);
});

for(const [name,operation] of [
  ['view source mutation',"fs.writeFileSync('math.js','export const sum=()=>0;');"],
  ['dependency mutation',"fs.writeFileSync('node_modules/fixture-lib/index.js','module.exports=0;');"],
  ['excluded output injection',"fs.mkdirSync('dist');fs.writeFileSync('dist/generated.js','hidden');"],
  ['new source injection',"fs.writeFileSync('unexpected.mjs','export default 0;');"],
])test(`${name} makes a zero-exit profiled run inconclusive`,async t=>{
  const f=fixture(t,{dependency:true,source:`import test from 'node:test';import fs from 'node:fs';test('mutate',()=>{${operation}});`});
  const {task,candidate}=await f.prepare(),profile=await f.readyProfile(candidate.id);await f.attach(task,candidate,profile);
  const result=await f.call('check_run',await f.request(candidate.id));assert.equal(result.evidence.exit_code,0);assert.equal(result.evidence.verdict,'inconclusive');
  assert.equal(result.evidence.execution_observation.source_after,candidate.hash);assert.equal(result.evidence.execution_observation.view_source_after,null);assert.equal(result.evidence.execution_observation.verified_view,false);
  assert.equal((await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'})).file.text,'export const sum=(a,b)=>a-b;');
  assert.equal(fs.readFileSync(path.join(profile.prepared.dependency_root,'fixture-lib/index.js'),'utf8'),'module.exports=41;');
});
test('tampered prepared dependencies invalidate an issued check before any job admission',async t=>{
  const f=fixture(t,{dependency:true}),{task,candidate}=await f.prepare(),profile=await f.readyProfile(candidate.id);await f.attach(task,candidate,profile);
  const request=await f.request(candidate.id);fs.writeFileSync(path.join(profile.prepared.dependency_root,'fixture-lib/index.js'),'module.exports=99;');
  await assert.rejects(f.call('check_start',request),{code:'stale_resource'});
  assert.equal(f.data.list('jobs',f.base.workspace_id,f.base.project_id).length,0);assert.equal(f.gate.busy('job'),false);
});
test('profile selection requires explicit acceptance and changes its version, invalidates evidence but preserves historical retry',async t=>{
  const f=fixture(t,{dependency:true,source:"import test from 'node:test';test('actual',()=>{});"}),{task,candidate}=await f.prepare(),request=await f.request(candidate.id);
  const first=await f.call('check_run',request),raw=f.data.get('evidence',f.base.workspace_id,f.base.project_id,first.evidence.id),profile=await f.readyProfile(candidate.id);
  await assert.rejects(f.request(candidate.id,'node-test',profile.id),{code:'stale_resource'});
  const approved=await f.attach(task,candidate,profile);assert.notEqual(approved.task.acceptance_digest,task.acceptance_digest);assert.equal(approved.task.acceptance_version,2);
  assert.deepEqual(f.data.get('evidence',f.base.workspace_id,f.base.project_id,first.evidence.id),raw);
  assert.equal((await f.call('execution_state')).evidence[0].superseded,true);
  assert.equal((await f.call('check_start',request)).job.id,first.job.id);
  const fresh=await f.request(candidate.id);await assert.rejects(f.call('check_start',{...fresh,op_id:request.op_id}),{code:'stale_resource'});
  const next=await f.call('check_run',fresh);assert.equal(next.evidence.verdict,'pass');assert.equal(next.evidence.execution_profile_id,profile.id);
});
test('acceptance approval binds exact candidate and refuses a changed candidate without replacing prior acceptance',async t=>{
  const f=fixture(t),{task,candidate}=await f.prepare();
  const p=await f.call('task_acceptance_preview',{task_id:task.id,candidate_id:candidate.id,expected_acceptance_digest:task.acceptance_digest,required_checks:[{definition_id:'node-test'},{definition_id:'host-regression'}]});
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:file.file.hash,content:'export const sum=(a,b)=>a+b;'});
  await assert.rejects(f.call('task_acceptance_approve',{task_id:task.id,candidate_id:candidate.id,preview_id:p.preview_id,preview_digest:p.preview.digest}),{code:'stale_resource'});
  assert.equal(f.data.get('tasks',f.base.workspace_id,f.base.project_id,task.id).acceptance_digest,task.acceptance_digest);
});
test('duplicate required definitions and oversized required check sets fail strict admission',async t=>{
  const f=fixture(t);
  await assert.rejects(f.prepare([{definition_id:'node-test'},{definition_id:'node-test'}]),{code:'invalid_request'});
  await assert.rejects(f.prepare(Array.from({length:9},()=>({definition_id:'node-test'}))),{code:'invalid_request'});
});
test('background finalization failure remains pending and DB-only retry finalizes without a second spawn',async t=>{
  const f=fixture(t),{candidate}=await f.prepare(),request=await f.request(candidate.id),create=f.data.create.bind(f.data);
  f.data.create=(kind,...args)=>{if(kind==='evidence')throw Error('storage fault');return create(kind,...args);};
  const start=await f.call('check_start',request),pending=await settled(f,start.job.id);assert.equal(pending.job.status,'finalization_pending');assert.equal(pending.evidence.length,0);
  assert.equal(f.gate.busy('job'),false);assert.equal((await f.call('check_start',request)).job.id,start.job.id);
  f.data.create=create;const recovered=await f.call('job_finalize_retry',{job_id:start.job.id});assert.equal(recovered.evidence.verdict,'pass');
  assert.equal(f.data.list('jobs',f.base.workspace_id,f.base.project_id).length,1);
});
test('accepted job reserves candidate mutation and acceptance changes before its child is spawned',async t=>{
  const f=fixture(t,{source:"import test from 'node:test';test('slow',async()=>{await new Promise(r=>setTimeout(r,150));});"}),{task,candidate}=await f.prepare();
  const request=await f.request(candidate.id),start=await f.call('check_start',request);
  await assert.rejects(f.call('candidate_apply',{candidate_id:candidate.id,expected_candidate_hash:candidate.hash,changes:[{op:'create',path:'new.txt',expected_hash:null,content:'blocked'}]}),{code:'busy'});
  await assert.rejects(f.call('task_acceptance_preview',{task_id:task.id,candidate_id:candidate.id,expected_acceptance_digest:task.acceptance_digest,required_checks:[{definition_id:'host-regression'}]}),{code:'busy'});
  assert.equal((await settled(f,start.job.id)).evidence[0].verdict,'pass');
});
test('multi-check review rejects a matching historical identity after one required check regresses',async t=>{
  const f=fixture(t),marker=path.join(f.root,'ran');fs.writeFileSync(path.join(f.projectRoot,'math.js'),'export const sum=(a,b)=>a+b;');
  fs.writeFileSync(path.join(f.projectRoot,'proof.test.mjs'),`import test from 'node:test';import fs from 'node:fs';test('real flaky assertion',()=>{if(fs.existsSync(${JSON.stringify(marker)}))throw Error('regressed');fs.writeFileSync(${JSON.stringify(marker)},'ran');});`);
  const {task,candidate}=await f.prepare([{definition_id:'node-test'},{definition_id:'host-regression'}]);
  const node=await f.call('check_run',await f.request(candidate.id)),host=await f.call('check_run',await f.request(candidate.id,'host-regression'));
  assert.equal(node.evidence.verdict,'pass');assert.equal(host.evidence.verdict,'pass');
  const identity=reviewDigest(task,candidate,[node.evidence,host.evidence]);assert.equal((await f.call('candidate_get',{candidate_id:candidate.id})).review_identity,identity);
  assert.equal((await f.call('check_run',await f.request(candidate.id))).evidence.verdict,'fail');
  await assert.rejects(f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[node.evidence.id,host.evidence.id],decision:'approved',expected_identity:identity}),{code:'stale_resource'});
});
test('profile is reusable across source repair but changed dependency inputs require fresh owner acceptance',async t=>{
  const f=fixture(t,{dependency:true}),{task,candidate}=await f.prepare(),profile=await f.readyProfile(candidate.id);await f.attach(task,candidate,profile);
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'package-lock.json'});
  await f.call('candidate_edit',{candidate_id:candidate.id,path:'package-lock.json',expected_hash:file.file.hash,content:file.file.text+'\n'});
  await assert.rejects(f.request(candidate.id),{code:'stale_resource'});assert.equal(f.data.list('jobs',f.base.workspace_id,f.base.project_id).length,0);
});
