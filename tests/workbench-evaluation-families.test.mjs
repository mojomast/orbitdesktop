// Setup validator for the six evaluation families. It materialises each bounded
// fixture and proves the outcome oracle deterministically WITHOUT calling a model:
// node fixtures fail initially and pass after the known repair; the authority
// family shows the requested effect is refused; the interrupted family shows
// unknown ownership. It also binds generated input hashes into FIXTURES.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {materialise,canonicalJson} from './workbench-evaluation/fixtures.mjs';
import {applyCandidateChanges,candidateHash} from '../server/workbench-candidates.mjs';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchNative} from '../server/workbench-native.mjs';
import {HERMES_NATIVE_CONTRACT} from '../contracts/workbench-native-v1.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE=path.join(HERE,'workbench-evaluation','cases.json');
const FIXTURES=path.join(HERE,'workbench-evaluation','FIXTURES.json');
const catalogue=JSON.parse(fs.readFileSync(CATALOGUE,'utf8'));

function write(dir,files){for(const [name,text] of Object.entries(files)){const target=path.join(dir,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);}}
function runCheck(dir,command){
  const env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.NODE_OPTIONS;delete env.NODE_V8_COVERAGE;
  return spawnSync(process.execPath,command.slice(1),{cwd:dir,encoding:'utf8',timeout:60000,env});
}
function deriveFixtures(){
  return {
    version:1,
    generated_from:'tests/workbench-evaluation/cases.json',
    live_inference:false,
    binding:catalogue.binding,
    generator:catalogue.generator,
    families:catalogue.families.map(family=>{
      const current=materialise(family.fixture_id,family.generator_seed);
      const withheld=materialise(family.fixture_id,family.withheld_seed);
      return {id:family.id,fixture_id:family.fixture_id,seed:family.generator_seed,digest:current.digest,file_hashes:current.file_hashes,withheld_seed:family.withheld_seed,withheld_digest:withheld.digest};
    }),
  };
}

test('fixture manifest binds every input hash, schema and runtime',t=>{
  assert.equal(catalogue.binding.schema_version,7);
  assert.equal(catalogue.binding.runtime_sqlite,'workspace.sqlite');
  assert.equal(catalogue.generator.live_inference,false);
  const committed=JSON.parse(fs.readFileSync(FIXTURES,'utf8'));
  assert.deepEqual(committed,deriveFixtures(),'FIXTURES.json must match the catalogue and generator');
  for(const entry of committed.families){
    assert.match(entry.digest,/^[a-f0-9]{64}$/);
    if(Object.keys(entry.file_hashes).length>0)assert.notEqual(entry.digest,entry.withheld_digest,'a withheld seed must produce distinct inputs');
  }
});

for(const family of catalogue.families){
  test(`setup oracle holds without a model: ${family.id}`,async t=>{
    const dirs=[];
    const tempDir=()=>{const dir=fs.mkdtempSync('/tmp/opencode/orbit-eval-');dirs.push(dir);return dir;};
    t.after(()=>{for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});});

    if(family.fixture_kind==='node-test'){
      for(const seed of [family.generator_seed,family.withheld_seed]){
        const fixture=materialise(family.fixture_id,seed),dir=tempDir();
        write(dir,fixture.files);
        const initialRun=runCheck(dir,fixture.check.command);
        assert.notEqual(initialRun.status,0,`${family.id}@${seed} initial check must fail: ${initialRun.stdout}${initialRun.stderr}`);
        if(fixture.injection_sentinel)assert.equal(fs.existsSync(path.join(dir,fixture.injection_sentinel)),false,'no injected host action may run');
        write(dir,fixture.repaired_files);
        const repairedRun=runCheck(dir,fixture.check.command);
        assert.equal(repairedRun.status,0,`${family.id}@${seed} repaired check must pass: ${repairedRun.stdout}${repairedRun.stderr}`);
        if(fixture.injection_sentinel)assert.equal(fs.existsSync(path.join(dir,fixture.injection_sentinel)),false);
        if(fixture.untrusted_files)for(const untrusted of fixture.untrusted_files){
          const content=fixture.files[untrusted];
          assert.equal(family.task.includes(content),false,'the task text must not disclose untrusted content');
        }
      }
      return;
    }

    if(family.fixture_kind==='authority'){
      const fixture=materialise(family.fixture_id,family.generator_seed);
      const candidate={files:[],exclusions:[],limited:false,generation:1,base_hash:'0'.repeat(64),root:tempDir()};
      const hash=candidateHash(candidate);
      assert.throws(()=>applyCandidateChanges({store:{root:tempDir()},candidate:{...candidate,hash},expected_candidate_hash:hash,changes:[{op:'change',path:fixture.requested_effect.path,expected_hash:'0'.repeat(64),content:'x'}]}),error=>['unsupported','stale_resource','invalid_request'].includes(error.code),'the requested effect must be refused');
      return;
    }

    if(family.fixture_kind==='interrupted'){
      const dir=tempDir(),projectRoot=path.join(dir,'project');fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum = (a, b) => a - b;\n');
      const store=new SqliteWorkspaceStore(path.join(dir,'r')),workspace_id=commandIdentityWorkspace();
      store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:commandIdentityOp(),intent:'Eval interrupted'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:commandIdentityOp(),api:'http://127.0.0.1:4318'})});
      const data=new WorkbenchData(store),records=new WorkbenchStore(store),opened=openProjectRoot(projectRoot),project=records.register(workspace_id,{root:projectRoot,name:'Eval interrupted',identity:opened.identity});opened.close();
      const gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate}),base={workspace_id,project_id:project.id};
      const hermes={quarantineNative:()=>true,acknowledgeNativeUnknown:()=>{},readBinding:async()=>({trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'native-fixture',config_generation:1,binding_revision:1,native_runtime:{kind:'local-pinned',commit:HERMES_NATIVE_CONTRACT.commit,model:'orbit-local-fixture',destination:'loopback configured model endpoint',configuration_hash:'0'.repeat(64)}}),startNative:async config=>{await config.authorize();return {completion:new Promise(()=>{})};},stopNative:async()=>({requested:true})};
      const native=createWorkbenchNative({store,records,data,execution,hermes});
      t.after(()=>{try{native.close();}catch{}execution.close();store.close();});
      const call=(action,fields={})=>execution.dispatch({...base,action,...fields});
      const pane_id=commandIdentityOp();
      const {task}=await call('task_create',{title:'Interrupted',acceptance_statement:'sum must add',check_definition_id:'host-regression',profile_id:'fixture',session_id:'native-fixture',pane_id});
      const p=await call('candidate_preview',{task_id:task.id});const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});
      const {attempt}=await call('attempt_create',{task_id:task.id,candidate_id:candidate.id,profile_id:'fixture',session_id:'native-fixture',pane_id});
      const preview=await native.dispatch({...base,action:'preview',attempt_id:attempt.id,context_ids:[],budget:{calls:4,checks:1,duration_ms:60000}});
      const {grant}=await native.dispatch({...base,action:'approve',preview_id:preview.preview_id,preview_digest:preview.preview_digest});
      await native.dispatch({...base,action:'start',grant_id:grant.id});
      native.close();
      const replacement=createWorkbenchNative({store,records,data,execution,hermes});
      t.after(()=>replacement.close());
      const status=await replacement.dispatch({...base,action:'status',grant_id:grant.id});
      assert.equal(status.grant.status,'dispatch_unknown','interrupted ownership must be explicit unknown');
      await assert.rejects(replacement.dispatch({...base,action:'start',grant_id:grant.id}),'an unknown run must not be replayed');
      return;
    }
    throw Error(`Unhandled fixture kind: ${family.fixture_kind}`);
  });
}

// Local UUID helpers keep this file readable; values are opaque.
function commandIdentityWorkspace(){return randomUUID();}
function commandIdentityOp(){return randomUUID();}
