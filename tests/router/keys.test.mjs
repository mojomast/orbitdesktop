import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOrbitConfig } from '../../server/orbit-config.mjs';
import { createRouterSupervisor } from '../../server/router-supervisor.mjs';

function fixture(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-prepare-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const store = createOrbitConfig({ runtimeDir, env: {} });
  const doc = store.load();
  doc.components.router = doc.router.enabled = true;
  doc.router.upstreams = [{ providerId: 'chosen', weight: 1 }];
  doc.providers = ['chosen', 'other'].map(id => ({ id, kind: 'openai-compatible', label: id, baseUrl: `https://${id}.invalid/v1` }));
  for (const role of Object.keys(doc.roles)) doc.roles[role] = { provider: 'router', model: 'chosen/model' };
  store.save(doc);
  store.setKey('chosen', 'chosen-fixture-only'); store.setKey('other', 'unrelated-fixture-only');
  const supervisor = createRouterSupervisor({ runtimeDir, config: store.load(), exec: assert.fail, fetchImpl: assert.fail });
  const status = supervisor.prepareBuiltin();
  return { store, status, doc: store.load(), dir: runtimeDir };
}

test('upstream_keys_stay_in_a_0600_generated_env_file', t => {
  const { dir, status } = fixture(t);
  const file = path.join(dir, 'router/router.env');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^ROUTER_UPSTREAM_CHOSEN_KEY=chosen-fixture-only$/m);
  assert.ok(!text.includes('unrelated-fixture-only'));
  assert.equal(status.enabled, false);
  for (const file of ['.env', 'orbit-config.json', 'router/data/config.json']) assert.doesNotMatch(fs.readFileSync(path.join(dir,file),'utf8'), /fixture-only/);
});

test('agents_see_only_the_router_base_url_and_virtual_key', t => {
  const { dir, store, doc } = fixture(t);
  const agents = store.toRegistryConfig().agents;
  assert.equal(agents.length, 4);
  assert.equal(new Set(agents.map(a => fs.readFileSync(a.apiKeyFile,'utf8'))).size, 4);
  for (const a of agents) {
    assert.equal(a.baseUrl, 'http://router:8080/v1');
    assert.equal(a.apiKeyFile, path.join(dir,'keys',`router-vk-${a.id}.key`));
    assert.doesNotMatch(fs.readFileSync(a.apiKeyFile,'utf8'), /fixture-only/);
  }
  doc.router.virtualKeys[0].keyRef.file = 'chosen.key';
  assert.throws(() => store.save(doc), /own role/);
});
