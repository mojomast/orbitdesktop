import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createOrbitConfig, defaultOrbitConfig } from '../server/orbit-config.mjs';
import { createOnboardingApply } from '../server/onboarding-apply.mjs';

const sentinel = 'sk-orbit-test-SENTINEL-apply-42';
const root = () => fs.mkdtempSync('/tmp/opencode/orbit-onboarding-apply-');
const local = { id: 'local', kind: 'openai-compatible', label: 'Local models', baseUrl: 'http://127.0.0.1:8000/v1' };
const fourRoles = {
  setup: { provider: 'local', model: 'small' },
  chat: { provider: 'local', model: 'large' },
  workers: { provider: 'local', model: 'small' },
  summarize: { provider: 'local', model: 'small' },
};

function request({ method = 'GET', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function response() {
  const out = { status: undefined, headers: {}, text: '' };
  return {
    out,
    res: {
      setHeader(key, value) { out.headers[key.toLowerCase()] = value; },
      writeHead(status, headers) { out.status = status; Object.assign(out.headers, headers ?? {}); },
      end(value) { out.text = value === undefined ? '' : String(value); out.body = out.text ? JSON.parse(out.text) : undefined; },
    },
  };
}

function harness(t, options = {}) {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  const setupCalls = [];
  const logs = [];
  const supervisorCalls = [];
  const supervisor = options.supervisor === null ? undefined : {
    async enable(value) { supervisorCalls.push({ method: 'enable', config: value }); },
    async health() { supervisorCalls.push({ method: 'health' }); return { ok: true, status: 'healthy' }; },
    issueVirtualKeys() { supervisorCalls.push({ method: 'issueVirtualKeys' }); return [{ role: 'setup', keySet: true }]; },
    rotateKey(role) { supervisorCalls.push({ method: 'rotateKey', role }); return { role, rotated: true }; },
    async disable(options) { supervisorCalls.push({ method: 'disable', options }); },
  };
  const app = createOnboardingApply({
    config,
    startSetupAgent: async value => { setupCalls.push(value); return { ok: true }; },
    log: value => logs.push(String(value)),
    routerSupervisor: supervisor,
  });
  async function call(method, pathname, body) {
    const holder = response();
    await app.handle(request({ method, body }), holder.res, new URL(pathname, 'http://127.0.0.1'));
    return { ...(holder.out.body ?? {}), status: holder.out.status };
  }
  return { dir, config, app, call, setupCalls, logs, supervisorCalls };
}

function assertNoSecret(value, label) {
  assert.equal(JSON.stringify(value).includes(sentinel), false, `${label} leaked the sentinel key`);
}

test('default install is direct and router-off: apply starts no router and no key material', async t => {
  const h = harness(t);
  const loaded = h.config.load();
  assert.equal(loaded.components.router, false);
  assert.equal(loaded.router.enabled, false);
  assert.equal(loaded.providerMode, 'direct');
  const applied = await h.call('POST', '/api/onboarding/apply', {});
  assert.equal(applied.ok, true);
  assert.match(applied.config.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(applied.config.installState.core, 'pending');
  assert.equal(applied.config.installState.router, 'skipped');
  assert.deepEqual(h.supervisorCalls, []);
  assert.equal(h.setupCalls.length, 1);
  assertNoSecret(applied, 'default apply');
  assertNoSecret(h.setupCalls[0], 'setup agent config');
});

test('custom apply persists choices, starts the setup agent with resolved roles and keeps keys out of everything', async t => {
  const h = harness(t);
  const saved = h.config.save({ ...defaultOrbitConfig(), providers: [local], roles: fourRoles });
  h.config.setKey('local', sentinel);
  const applied = await h.call('POST', '/api/onboarding/apply', {});
  assert.equal(applied.ok, true);
  const installState = applied.config.installState;
  assert.equal(installState.core, 'pending');
  assert.equal(installState.opencode, 'skipped');
  assert.equal(h.setupCalls.length, 1);
  for (const role of ['setup', 'chat', 'workers', 'summarize']) assert.deepEqual(h.setupCalls[0].roles[role], fourRoles[role]);
  assertNoSecret(applied, 'custom apply');
  assertNoSecret(h.setupCalls[0], 'custom setup config');
  assertNoSecret(h.logs, 'custom apply logs');
  const text = fs.readFileSync(path.join(h.dir, 'orbit-config.json'), 'utf8');
  assert.equal(text.includes(sentinel), false);
  assert.equal(fs.statSync(path.join(h.dir, 'keys', 'local.key')).mode & 0o777, 0o600);
  assert.equal(saved.providerMode, 'direct');
});

test('minimal apply maps every role to the one model and installs only core plus one first agent', async t => {
  const h = harness(t);
  h.config.save({ ...defaultOrbitConfig(), providers: [local] });
  h.config.setKey('local', sentinel);
  const applied = await h.call('POST', '/api/onboarding/apply', {
    mode: 'minimal',
    defaultModel: { provider: 'local', model: 'qwen-small' },
    components: { core: true, pi: false, opencode: false, hermes: false, bundlebees: false, workerPairing: false, colab: false, router: false, apps: [] },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.config.mode, 'minimal');
  assert.deepEqual(applied.config.defaultModel, { provider: 'local', model: 'qwen-small' });
  assert.equal(applied.config.components.router, false);
  assert.equal(applied.config.providerMode, 'direct');
  for (const role of ['setup', 'chat', 'workers', 'summarize']) assert.deepEqual(applied.roles[role], { provider: 'local', model: 'qwen-small' });
  for (const role of ['setup', 'chat', 'workers', 'summarize']) assert.deepEqual(h.setupCalls[0].roles[role], { provider: 'local', model: 'qwen-small' });
  assert.deepEqual(h.supervisorCalls, []);
  assertNoSecret(applied, 'minimal apply');
  assertNoSecret(h.setupCalls[0], 'minimal setup config');
  const text = fs.readFileSync(path.join(h.dir, 'orbit-config.json'), 'utf8');
  assert.equal(text.includes(sentinel), false);
});

test('GET and PUT roles validate provider ids and models and round-trip Settings edits', async t => {
  const h = harness(t);
  h.config.save({ ...defaultOrbitConfig(), mode: 'minimal', defaultModel: { provider: 'local', model: 'small' }, providers: [local], roles: {} });
  const initial = await h.call('GET', '/api/onboarding/roles');
  assert.equal(initial.ok, true);
  assert.equal(initial.mode, 'minimal');
  for (const role of ['setup', 'chat', 'workers', 'summarize']) assert.deepEqual(initial.roles[role], { provider: 'local', model: 'small' });

  const badProvider = await h.call('PUT', '/api/onboarding/roles', { roles: { chat: { provider: 'missing', model: 'large' } } });
  assert.equal(badProvider.status, 400);
  assert.equal(badProvider.ok, false);
  assertNoSecret(badProvider, 'invalid role provider');

  const badModel = await h.call('PUT', '/api/onboarding/roles', { roles: { chat: { provider: 'local', model: '' } } });
  assert.equal(badModel.status, 400);

  const override = await h.call('PUT', '/api/onboarding/roles', { roles: { chat: { provider: 'local', model: 'large' } } });
  assert.equal(override.ok, true);
  assert.deepEqual(override.roles.chat, { provider: 'local', model: 'large' });
  assert.deepEqual(override.roles.setup, { provider: 'local', model: 'small' });

  const cleared = await h.call('PUT', '/api/onboarding/roles', { roles: { chat: { provider: '', model: '' } } });
  assert.deepEqual(cleared.roles.chat, { provider: 'local', model: 'small' });

  const custom = await h.call('PUT', '/api/onboarding/roles', { mode: 'custom' });
  assert.equal(custom.mode, 'custom');
  assert.equal(custom.stored.chat.model, 'small');
  assert.deepEqual(custom.roles, initial.roles);
});

test('router-on apply enables the router, waits for health, issues virtual keys and wires agents', async t => {
  const h = harness(t);
  h.config.save({
    ...defaultOrbitConfig(),
    components: { ...defaultOrbitConfig().components, router: true },
    providers: [local, { id: 'router', kind: 'router', label: 'Built-in token router', baseUrl: 'http://127.0.0.1:8080/v1', routerType: 'self-hosted' }],
    roles: Object.fromEntries(Object.entries(fourRoles).map(([role]) => [role, { provider: 'router', model: 'auto' }])),
    router: { ...defaultOrbitConfig().router, enabled: true, mode: 'builtin', bind: 'loopback', port: 8080 },
  });
  h.config.setKey('local', sentinel);
  const applied = await h.call('POST', '/api/onboarding/apply', {});
  assert.equal(applied.ok, true);
  assert.deepEqual(h.supervisorCalls.map(call => call.method), ['enable', 'health', 'issueVirtualKeys']);
  assert.equal(h.setupCalls.length, 1);
  assert.equal(applied.router.health, 'healthy');
  const budget = await h.call('PUT', '/api/onboarding/roles', { budgets: { chat: { usd: 12, reset: '1mo', rateLimit: { requests: 500, tokens: 1000000, reset: '1h' } } } });
  assert.equal(budget.ok, true);
  const chatKey = budget.config.router.virtualKeys.find(entry => entry.role === 'chat');
  assert.equal(chatKey.budget.usd, 12);
  assert.equal(chatKey.rateLimit.requests, 500);
  const rotated = await h.call('POST', '/api/onboarding/router/rotate', { role: 'chat' });
  assert.deepEqual(rotated.rotated, ['chat']);
  assert.equal(h.supervisorCalls.at(-1).method, 'rotateKey');
  assertNoSecret(rotated, 'router rotate');
  assertNoSecret(applied, 'router apply');
  assertNoSecret(h.logs, 'router apply logs');
});

test('router-off apply never touches the supervisor even when an inactive router provider is stored', async t => {
  const h = harness(t);
  h.config.save({
    ...defaultOrbitConfig(),
    providers: [local, { id: 'router', kind: 'router', label: 'Stored router', baseUrl: 'https://router.example/v1', routerType: 'hosted' }],
    roles: fourRoles,
  });
  const applied = await h.call('POST', '/api/onboarding/apply', {});
  assert.equal(applied.ok, true);
  assert.deepEqual(h.supervisorCalls, []);
  assert.equal(applied.config.components.router, false);
  assert.equal(applied.config.router.enabled, false);
});
