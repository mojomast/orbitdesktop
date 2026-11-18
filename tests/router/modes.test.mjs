import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultOrbitConfig, ROUTER_IMAGES, validateOrbitConfig } from '../../server/orbit-config.mjs';
import { createRouterSupervisor } from '../../server/router-supervisor.mjs';

test('unavailable_local_modes_fail_closed_and_external_writes_no_local_router_state', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-router-modes-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const config = defaultOrbitConfig();
  config.components.router = config.router.enabled = true;
  const supervisor = createRouterSupervisor({ runtimeDir, config, exec: assert.fail, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://external.invalid/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer external-fixture-only');
    assert.equal(options.redirect, 'error');
    return { ok: true, status: 200 };
  }});
  config.router.engine = 'litellm';
  assert.throws(() => supervisor.prepareBuiltin(), /pinned engine/);
  config.router.image = ROUTER_IMAGES.litellm;
  await assert.rejects(supervisor.enable(), /unavailable/);
  assert.deepEqual(fs.readdirSync(runtimeDir), []);
  config.router.mode = 'external';
  config.router.external.baseUrl = 'https://external.invalid/v1';
  fs.mkdirSync(path.join(runtimeDir, 'keys'), {mode: 0o700});
  fs.writeFileSync(path.join(runtimeDir, 'keys/external-router.key'), 'external-fixture-only', {mode: 0o600});
  const status = await supervisor.enable();
  assert.deepEqual(status.virtualKeys, []);
  assert.deepEqual(supervisor.issueVirtualKeys(), []); // Settings apply hook
  assert.throws(() => supervisor.rotateKey('chat'), /external/);
  await supervisor.disable({ confirm: true });
  assert.deepEqual(fs.readdirSync(runtimeDir), ['keys']);
  assert.deepEqual(fs.readdirSync(path.join(runtimeDir, 'keys')), ['external-router.key']);
});

test('opencode_free_models_stay_direct', () => {
  const config = defaultOrbitConfig();
  config.providers.push({ id: 'zen', kind: 'opencode-free', label: 'OpenCode free' });
  config.roles.chat = { provider: 'zen', model: 'free-model' };
  assert.equal(validateOrbitConfig(config).roles.chat.provider, 'zen');
  config.router.upstreams = [{ providerId: 'zen', weight: 1 }];
  assert.throws(() => validateOrbitConfig(config), /cannot route OpenCode free/);
});
