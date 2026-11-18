import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOrbitConfig, ROUTER_IMAGES } from '../../server/orbit-config.mjs';
import { issueLiteLLMRole, liteLLMRolePlan } from '../../server/router-litellm-issue.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-issue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime'); fs.mkdirSync(runtimeDir, { mode: 0o700 });
  const store = createOrbitConfig({runtimeDir, env:{}}), c = store.load();
  c.components.router = c.router.enabled = true;
  Object.assign(c.router, { engine:'litellm', image:ROUTER_IMAGES.litellm, bind:'loopback', port:4000 });
  c.roles.workers = {provider:'router',model:'local/model'};
  const role = c.router.virtualKeys.find(k => k.role === 'workers');
  role.budget.reset = '30d'; role.rateLimit = {requests:10,tokens:1000,reset:'1m'};
  store.save(c);
  const plan = liteLLMRolePlan(runtimeDir,'workers');
  const manifestFile = path.join(root,'manifest.json'), masterKeyFile = path.join(root,'master');
  fs.writeFileSync(masterKeyFile,'management-fixture-only',{mode:0o600});
  fs.writeFileSync(manifestFile, JSON.stringify({baseUrl:plan.baseUrl,runtimeDir,masterKeyFile,socketPath:path.join(root,'admin.sock')}), {mode:0o600});
  return {store,plan,options:{runtimeDir,manifestFile,role:'workers',confirmPolicy:plan.policySha256},keys:path.join(runtimeDir,'keys')};
}

test('one consent-bound inference-only LiteLLM role issuance; management credential and response stay out of registry and receipts', async t=>{
  const {plan, options, store, keys} = setup(t);
  let calls=0;
  const issuedFixture = 'sk-'+randomBytes(24).toString('hex');
  const post = async (_socket, master, req) => {
    calls++; assert.equal(master,'management-fixture-only');
    assert.deepEqual(req,{key_alias:req.key_alias,key_type:'llm_api',models:['local/model'],max_budget:20,budget_duration:'30d',rpm_limit:10,tpm_limit:1000});
    return {...req,allowed_routes:['llm_api_routes'],key:issuedFixture};
  };
  await assert.rejects(issueLiteLLMRole({...options,confirmPolicy:undefined,post}),/approval/);
  assert.equal(calls,0);
  const result = await issueLiteLLMRole({...options,post});
  const file = store.toRegistryConfig().agents.find(a=>a.id==='workers').apiKeyFile;
  assert.equal(fs.readFileSync(file,'utf8').trim(),issuedFixture);
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
  const evidence = JSON.stringify([result,plan,store.toRegistryConfig()])+fs.readFileSync(path.join(keys,'.litellm-issue-workers.json'),'utf8');
  assert.ok(!evidence.includes(issuedFixture) && !evidence.includes('management-fixture-only'));
  await assert.rejects(issueLiteLLMRole({...options,post}),/exists/); assert.equal(calls,1);
  const config=store.load(); config.router.port=4001; store.save(config);
  assert.ok(!store.toRegistryConfig().agents.some(a=>a.id==='workers'));
  config.router.port=4000; store.save(config);
  fs.writeFileSync(file,'different-fixture');
  assert.ok(!store.toRegistryConfig().agents.some(a=>a.id==='workers'));
});

test('broader than approved grant is never delivered; uncertain remote action cannot be replayed', async t=>{
  const {options, keys, store} = setup(t);
  const post = async (_socket, _master, req) => ({...req,models:[],allowed_routes:['management_routes'],key:'sk-untrusted-response'});
  await assert.rejects(issueLiteLLMRole({...options,post}),/Unconfirmed/);
  assert.ok(!fs.existsSync(path.join(keys,'router-vk-workers.key')));
  assert.ok(fs.existsSync(path.join(keys,'.litellm-issue-workers.pending')));
  await assert.rejects(issueLiteLLMRole({...options,post:assert.fail}),/EEXIST/);
  const c=store.load(); c.router.virtualKeys.find(k=>k.role==='workers').rateLimit.reset='1h'; store.save(c);
  assert.throws(()=>liteLLMRolePlan(options.runtimeDir,'workers'),/per-minute/);
});
