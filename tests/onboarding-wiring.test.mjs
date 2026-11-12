import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createOrbitSetup, OPENAI_COMPAT_PROVIDER } from '../server/onboarding-wiring.mjs';
import { buildMinimalConfig } from '../server/orbit-config.mjs';
import { isGatewayProvider, providerLabel } from '../server/agent-providers.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SENTINEL = 'sk-orbit-wiring-SENTINEL-4c1d9e';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wiring-'));
  const home = path.join(root, 'home');
  const runtime = path.join(root, 'runtime');
  const bin = path.join(root, 'bin');
  for (const dir of [home, runtime, bin]) fs.mkdirSync(dir, { recursive: true });
  // A fake docker on PATH records any invocation: the router must never run.
  const marker = path.join(root, 'docker-called');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho called >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  const port = await freePort();
  const token = `orbit-wiring-${process.pid}-${'y'.repeat(28)}`;
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], {
    cwd: repo,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: os.tmpdir(), PORT: String(port), ORBIT_TOKEN: token, ORBIT_RUNTIME_DIR: runtime, ORBIT_AGENT_DISCOVERY: 'off', PI_HARNESS_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(4000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw Error(logs || 'server exited');
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    await delay(50);
  }
  const bodies = [];
  const call = async (method, pathname, body, headers = {}) => {
    const response = await fetch(base + pathname, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    bodies.push(text);
    let data = {};
    try { data = JSON.parse(text); } catch { data = {}; }
    return { status: response.status, data };
  };
  return { base, call, bodies, logs: () => logs, marker, runtime };
}

test('fresh boot: first run, owner-only setup routes, minimal install end to end, no key leaks, no router', { timeout: 60000 }, async t => {
  const app = await boot(t);

  const state = await app.call('GET', '/api/onboarding/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.firstRun, true);
  assert.equal(state.data.config.router.enabled, false);
  assert.equal(state.data.mode, 'custom');

  // Owner token required; a cross-origin request is refused even with it.
  assert.equal((await fetch(`${app.base}/api/onboarding/state`)).status, 401);
  assert.equal((await app.call('GET', '/api/onboarding/state', undefined, { Origin: 'http://evil.example' })).status, 403);

  // Minimal install: one provider, one key, one model for every role.
  const added = await app.call('POST', '/api/onboarding/providers', { provider: { id: 'local', kind: 'openai-compatible', label: 'Local models', baseUrl: 'http://127.0.0.1:9/v1' } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const keyed = await app.call('POST', '/api/onboarding/providers/local/key', { key: SENTINEL });
  assert.equal(keyed.status, 200, JSON.stringify(keyed.data));
  const minimal = buildMinimalConfig({ provider: { id: 'local', kind: 'openai-compatible', label: 'Local models', baseUrl: 'http://127.0.0.1:9/v1' }, model: 'small-model' });
  const applied = await app.call('POST', '/api/onboarding/apply', { mode: 'minimal', defaultModel: minimal.defaultModel, components: minimal.components });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));

  const after = await app.call('GET', '/api/onboarding/state');
  assert.equal(after.data.firstRun, false);
  assert.equal(after.data.mode, 'minimal');
  for (const role of ['setup', 'chat', 'workers', 'summarize']) assert.deepEqual(after.data.roles[role], { provider: 'local', model: 'small-model' }, role);
  assert.equal(after.data.setupAgent, true);
  const setup = await app.call('GET', '/api/onboarding/setup-agent');
  assert.equal(setup.data.request.agent.model, 'small-model');
  assert.ok(Array.isArray(setup.data.request.checklist));

  // Settings is the same document, and hosts answer for the owner.
  const settings = await app.call('GET', '/api/settings/roles');
  assert.equal(settings.status, 200);
  const hosts = await app.call('POST', '/api/hosts', { action: 'list' });
  assert.equal(hosts.status, 200);
  assert.deepEqual(hosts.data.hosts, []);

  // The key never appears in responses, logs, the config file or the setup request.
  for (const text of app.bodies) assert.equal(text.includes(SENTINEL), false);
  assert.equal(app.logs().includes(SENTINEL), false);
  assert.equal(fs.readFileSync(path.join(app.runtime, 'orbit-config.json'), 'utf8').includes(SENTINEL), false);
  assert.equal(fs.readFileSync(path.join(app.runtime, 'setup-agent', 'request.json'), 'utf8').includes(SENTINEL), false);
  assert.equal(fs.statSync(path.join(app.runtime, 'keys', 'local.key')).mode & 0o777, 0o600);
  // Router off: docker was never invoked.
  assert.equal(fs.existsSync(app.marker), false);
});

test('a chat role on an OpenAI-compatible provider becomes one gateway agent profile', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wiring-unit-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const started = [];
  const setup = createOrbitSetup({
    runtimeDir,
    env: {},
    startGateway: async options => { started.push(options); return { url: 'http://127.0.0.1:1', token: 'gateway-token' }; },
  });
  assert.deepEqual(await setup.agentProfiles(), [], 'nothing configured: no agents');
  setup.store.save(buildMinimalConfig({ provider: { id: 'local', kind: 'openai-compatible', label: 'Local models', baseUrl: 'http://127.0.0.1:9/v1' }, model: 'small-model' }));
  setup.store.setKey('local', SENTINEL);
  const profiles = await setup.agentProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].provider, OPENAI_COMPAT_PROVIDER);
  assert.match(profiles[0].label, /Local models · small-model/);
  assert.equal(started[0].model, 'small-model');
  assert.equal(started[0].baseUrl, 'http://127.0.0.1:9/v1');
  assert.ok(path.isAbsolute(started[0].apiKeyFile));
  assert.equal(JSON.stringify(started).includes(SENTINEL), false, 'the key is passed by file path only');
  assert.equal(isGatewayProvider(OPENAI_COMPAT_PROVIDER), true);
  assert.equal(providerLabel(OPENAI_COMPAT_PROVIDER), 'OpenAI-compatible');
  assert.equal(isGatewayProvider('hermes'), false);
});

test('OpenCode free chat is not wrapped in the OpenAI-compatible gateway', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wiring-unit-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  let calls = 0;
  const setup = createOrbitSetup({ runtimeDir, env: {}, startGateway: async () => { calls++; return { url: 'x', token: 'y' }; } });
  setup.store.save(buildMinimalConfig({ provider: { id: 'opencode', kind: 'opencode-free', label: 'OpenCode free' }, model: 'deepseek-v4.1-flash-free' }));
  assert.deepEqual(await setup.agentProfiles(), []);
  assert.equal(calls, 0);
});

function fakeReq(method, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { method, headers: {}, async *[Symbol.asyncIterator]() { if (text) yield text; } };
}
function fakeRes() {
  return { status: 0, body: '', writeHead(status) { this.status = status; }, end(text) { this.body = String(text ?? ''); } };
}
async function hostCall(setup, body) {
  const res = fakeRes();
  await setup.handle(fakeReq('POST', body), res, new URL('http://127.0.0.1/api/hosts'));
  return { status: res.status, data: JSON.parse(res.body || '{}') };
}

test('host permissions: every agent starts at none, deploy needs explicit confirmation, every change is audited', async t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-wiring-perm-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  // A host record as the SSH host module stores it (no network is touched here).
  fs.writeFileSync(path.join(runtimeDir, 'orbit-hosts.json'), JSON.stringify({ hosts: [{ id: 'build-01', label: 'Build', address: 'build.example.test', port: 22, user: 'orbit' }] }), { mode: 0o600 });
  const setup = createOrbitSetup({ runtimeDir, env: {}, startGateway: async () => ({ url: 'x', token: 'y' }) });

  const refused = await hostCall(setup, { action: 'permissions', hostId: 'build-01', permissions: { setup: 'deploy' } });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  const read = await hostCall(setup, { action: 'permissions', hostId: 'build-01', permissions: { 'my-agent-2': 'read' } });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  const granted = await hostCall(setup, { action: 'permissions', hostId: 'build-01', permissions: { 'my-agent-2': 'read', setup: 'deploy' }, confirm: true });
  assert.equal(granted.status, 200, JSON.stringify(granted.data));
  assert.equal((await hostCall(setup, { action: 'permissions', hostId: 'build-01', permissions: { 'Bad Agent': 'read' } })).status, 400);

  const audit = await hostCall(setup, { action: 'audit', hostId: 'build-01' });
  const changes = (audit.data.records ?? audit.data.entries ?? []).filter(entry => entry.status === 'permission').map(entry => entry.argv.slice(1).join(' '));
  assert.deepEqual(changes, ['my-agent-2 none read', 'setup none deploy']);
});
