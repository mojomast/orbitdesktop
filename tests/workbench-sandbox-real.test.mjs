import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWorkbenchSandboxProvider} from '../server/workbench-sandbox-provider.mjs';
import {runCheck} from '../server/workbench-checks.mjs';

test('operator-gated real rootless runsc transports FD3 and cleans the runtime', {skip:process.env.ORBIT_TEST_GVISOR_REAL!=='1'},async t=>{
  const root=fs.mkdtempSync('/tmp/opencode/orbit-gvisor-real-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=path.join(root,'sandbox'),artifacts=path.join(root,'workbench-execution'),candidate=path.join(artifacts,'candidate');
  fs.mkdirSync(state,{mode:0o700});fs.mkdirSync(candidate,{recursive:true,mode:0o700});
  const provider=createWorkbenchSandboxProvider({root:state}),snapshot=provider.describe();
  assert.equal(snapshot.available,true,JSON.stringify(snapshot));
  fs.writeFileSync(path.join(candidate,'fixture.test.mjs'),`import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; test("isolated small fixture",()=>{assert.equal(process.version,${JSON.stringify(snapshot.guest_node_version)}); assert.equal(2+3,5); assert.equal(fs.existsSync("/var/run/docker.sock"),false); assert.throws(()=>fs.writeFileSync("/workspace/write-denied","no"));});\n`);
  const result=await runCheck({execution_backend:'gvisor',provider,provider_identity:snapshot.provider_identity,definition_id:'node-test',required_test_files:['fixture.test.mjs'],candidate_root:candidate,workspace_id:randomUUID(),project_id:randomUUID(),job_id:randomUUID(),artifact_root:artifacts,rehash:()=>({hash:'fixed-readonly-fixture'}),spawn_record:()=>{}});
  assert.equal(result.verdict,'pass',JSON.stringify(result));assert.equal(result.test_results.valid,true);assert.equal(result.test_results.tests,1);assert.equal(result.process_survival_unknown,false);
  assert.equal(provider.describe().available,true);assert.equal(fs.existsSync(path.join(candidate,'write-denied')),false);
});
