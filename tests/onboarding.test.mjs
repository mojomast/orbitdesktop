import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createOrbitConfig } from '../server/orbit-config.mjs';
import { createOnboarding } from '../server/onboarding.mjs';

const sentinel = 'sk-orbit-test-SENTINEL-9f3a';
const root = () => fs.mkdtempSync('/tmp/opencode/orbit-onboarding-');

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

function fakeFetch(handler) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  }
  return { fetchImpl, calls };
}

function okJson(data) {
  return { ok: true, status: 200, async json() { return data; }, async text() { return JSON.stringify(data); } };
}

function harness(t, overrides = {}) {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: '/nonexistent', HOME: path.join(dir, 'home'), ...(overrides.env || {}) };
  const config = createOrbitConfig({ runtimeDir: dir, env });
  const logs = [];
  const execCalls = [];
  const supervisorCalls = [];
  const fetch = fakeFetch(overrides.fetch ? overrides.fetch : () => okJson({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
  const onboarding = createOnboarding({
    config,
    fetchImpl: fetch.fetchImpl,
    exec: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return { stdout: overrides.execStdout ?? '1.2.3\n', stderr: '' };
    },
    which: overrides.which ?? (() => null),
    exists: overrides.exists ?? (() => false),
    log: value => logs.push(value),
    env,
    routerSupervisor: {
      calls: supervisorCalls,
      async enable(value) { supervisorCalls.push({ method: 'enable', config: value }); },
      async disable() { supervisorCalls.push({ method: 'disable' }); },
      async apply(value) { supervisorCalls.push({ method: 'apply', config: value }); },
    },
  });
  async function call(method, pathname, body) {
    const holder = response();
    await onboarding.handle(request({ method, body }), holder.res, new URL(pathname, 'http://127.0.0.1'));
    return { ...(holder.out.body ?? {}), status: holder.out.status };
  }
  return { dir, config, onboarding, call, logs, execCalls, supervisorCalls, fetch };
}

function assertNoSecret(value, label) {
  assert.equal(JSON.stringify(value).includes(sentinel), false, `${label} leaked the sentinel key`);
}

async function addProvider(env, provider = {}) {
  return env.call('POST', '/api/onboarding/providers', {
    id: 'local',
    kind: 'openai-compatible',
    label: 'Local models',
    baseUrl: 'http://127.0.0.1:8000/v1',
    ...provider,
  });
}

test('first-run state is direct, router off, key-free and starts no router process', async t => {
  const h = harness(t);
  const state = await h.call('GET', '/api/onboarding/state');
  assert.equal(state.ok, true);
  assert.equal(state.config.providerMode, 'direct');
  assert.equal(state.config.components.router, false);
  assert.equal(state.config.router.enabled, false);
  assert.deepEqual(state.providers, []);
  assert.equal(h.supervisorCalls.length, 0);
  assertNoSecret(state, 'state');
  assert.equal(h.config.load().router.enabled, false);
});

test('components are editable, the router toggle is opt-in, and the supervisor is only called on a real transition', async t => {
  const h = harness(t);
  const initial = await h.call('PUT', '/api/onboarding/components', { components: { pi: true, opencode: true } });
  assert.equal(initial.config.components.pi, true);
  assert.equal(initial.config.components.opencode, true);
  assert.equal(initial.config.components.router, false);
  assert.equal(h.supervisorCalls.length, 0);

  const enabled = await h.call('PUT', '/api/onboarding/components', { components: { router: true }, router: { engine: 'bifrost' } });
  assert.equal(enabled.config.components.router, true);
  assert.equal(enabled.config.router.enabled, true);
  assert.equal(enabled.config.providerMode, 'router');
  assert.equal(enabled.providers.some(provider => provider.id === 'router' && provider.kind === 'router'), true);
  assert.equal(h.supervisorCalls.at(-1).method, 'enable');

  const disabled = await h.call('PUT', '/api/onboarding/components', { components: { router: false } });
  assert.equal(disabled.config.components.router, false);
  assert.equal(disabled.config.router.enabled, false);
  assert.equal(h.supervisorCalls.at(-1).method, 'disable');
  assert.equal(h.config.load().router.enabled, false);
  assertNoSecret(enabled, 'components');
});

test('provider CRUD masks keys in every response and never writes the key into config', async t => {
  const h = harness(t);
  const added = await addProvider(h);
  assert.equal(added.ok, true);
  assert.deepEqual(added.provider.key, { set: false, masked: null });
  assertNoSecret(added, 'provider create');

  const keyed = await h.call('POST', '/api/onboarding/providers/local/key', { key: sentinel });
  assert.equal(keyed.ok, true);
  assert.deepEqual(keyed.provider.key, { set: true, masked: 'sk-…9f3a' });
  assertNoSecret(keyed, 'key response');

  const state = await h.call('GET', '/api/onboarding/state');
  assert.deepEqual(state.providers[0].key, { set: true, masked: 'sk-…9f3a' });
  assertNoSecret(state, 'state after key');

  const providers = await h.call('GET', '/api/onboarding/providers');
  assertNoSecret(providers, 'provider list');

  const configText = fs.readFileSync(path.join(h.dir, 'orbit-config.json'), 'utf8');
  assert.equal(configText.includes(sentinel), false);
  assert.equal(fs.statSync(path.join(h.dir, 'keys', 'local.key')).mode & 0o777, 0o600);

  const deleted = await h.call('DELETE', '/api/onboarding/providers/local');
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.providers, []);
  assert.equal(fs.existsSync(path.join(h.dir, 'keys', 'local.key')), false);
  assert.equal(h.logs.some(line => String(line).includes(sentinel)), false);
});

test('provider input errors do not echo a sentinel key', async t => {
  const h = harness(t);
  const bad = await h.call('POST', '/api/onboarding/providers', {
    id: 'local',
    kind: 'openai-compatible',
    label: 'Local',
    baseUrl: 'http://127.0.0.1:8000/v1',
    apiKey: sentinel,
  });
  assert.equal(bad.ok, false);
  assertNoSecret(bad, 'invalid provider');
  const badKey = await h.call('POST', '/api/onboarding/providers/local/key', { key: sentinel });
  assert.equal(badKey.ok, false);
  assertNoSecret(badKey, 'key for missing provider');
  assert.equal(h.logs.some(line => String(line).includes(sentinel)), false);
});

test('model list uses the provider key server-side, returns only safe metadata, and falls back to manual', async t => {
  const h = harness(t, {
    fetch: () => okJson({ data: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b' }] }),
  });
  await addProvider(h);
  await h.call('POST', '/api/onboarding/providers/local/key', { key: sentinel });
  const result = await h.call('GET', '/api/onboarding/providers/local/models');
  assert.equal(result.ok, true);
  assert.equal(result.manual, false);
  assert.deepEqual(result.models.map(model => model.id), ['model-a', 'model-b']);
  assert.equal(h.fetch.calls[0].url, 'http://127.0.0.1:8000/v1/models');
  assert.equal(String(h.fetch.calls[0].init.headers.Authorization).includes(sentinel), true);
  assertNoSecret(result, 'models');
  assert.equal(h.logs.some(line => String(line).includes(sentinel)), false);

  const failing = harness(t, {
    fetch: () => { throw new Error(`upstream rejected ${sentinel}`); },
  });
  await addProvider(failing);
  await failing.call('POST', '/api/onboarding/providers/local/key', { key: sentinel });
  const fallback = await failing.call('GET', '/api/onboarding/providers/local/models');
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.models, []);
  assert.equal(fallback.manual, true);
  assertNoSecret(fallback, 'model fallback');
  assert.equal(failing.logs.some(line => String(line).includes(sentinel)), false);
});

test('anthropic uses /v1/models and opencode-free keeps only free or zero-priced models with a privacy note', async t => {
  const h = harness(t, {
    fetch: (url) => {
      if (url.includes('anthropic')) return okJson({ data: [{ id: 'claude-test', display_name: 'Claude Test' }] });
      return okJson({ data: [
        { id: 'paid-model', pricing: { prompt: '0.12' } },
        { id: 'glm-5.3-flash-free' },
        { id: 'alpha-free' },
        { id: 'deepseek-v4.1-flash-free' },
        { id: 'zero-priced', pricing: { prompt: 0 } },
        { id: 'minimax-m3.1-flash-free' },
      ] });
    },
  });
  await addProvider(h, { id: 'claude', kind: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.test' });
  const anthropic = await h.call('GET', '/api/onboarding/providers/claude/models');
  assert.equal(h.fetch.calls[0].url, 'https://api.anthropic.test/v1/models');
  assert.deepEqual(anthropic.models.map(model => model.id), ['claude-test']);

  await addProvider(h, { id: 'opencode-free', kind: 'opencode-free', label: 'OpenCode free', baseUrl: 'https://opencode.ai/inference/v1' });
  const free = await h.call('GET', '/api/onboarding/providers/opencode-free/models');
  assert.equal(h.fetch.calls[1].url, 'https://opencode.ai/inference/v1/models');
  assert.deepEqual(free.models.map(model => model.id), [
    'deepseek-v4.1-flash-free',
    'glm-5.3-flash-free',
    'minimax-m3.1-flash-free',
    'alpha-free',
    'zero-priced',
  ]);
  assert.equal(free.default, 'deepseek-v4.1-flash-free');
  assert.equal(typeof free.models[0].privacyNote, 'string');
  assertNoSecret(free, 'free models');
});

test('router paths: built-in and external models come from the router, with keys only on the server', async t => {
  const h = harness(t, {
    fetch: () => okJson({ data: [{ id: 'router-model' }] }),
  });
  const enabled = await h.call('PUT', '/api/onboarding/components', { components: { router: true }, router: { mode: 'builtin', engine: 'bifrost', bind: 'loopback', port: 8080 } });
  assert.equal(enabled.config.router.mode, 'builtin');
  await h.call('POST', '/api/onboarding/providers/router/key', { key: sentinel });
  const builtin = await h.call('GET', '/api/onboarding/providers/router/models');
  assert.equal(builtin.ok, true);
  assert.equal(builtin.manual, false);
  assert.equal(builtin.models[0].id, 'router-model');
  assert.equal(h.fetch.calls[0].url, 'http://127.0.0.1:8080/v1/models');
  assertNoSecret(builtin, 'builtin router models');

  const external = await h.call('POST', '/api/onboarding/providers', {
    provider: { id: 'router', kind: 'router', label: 'External router', routerType: 'hosted', baseUrl: 'https://router.example/v1' },
    router: { mode: 'external', external: { baseUrl: 'https://router.example/v1' } },
  });
  assert.equal(external.ok, true);
  assert.equal(external.config.router.mode, 'external');
  await h.call('POST', '/api/onboarding/providers/router/key', { key: sentinel });
  assert.equal(fs.existsSync(path.join(h.dir, 'keys', 'external-router.key')), true);
  const remote = await h.call('GET', '/api/onboarding/providers/router/models');
  assert.equal(h.fetch.calls.at(-1).url, 'https://router.example/v1/models');
  assertNoSecret(remote, 'external router models');
  assert.equal(h.logs.some(line => String(line).includes(sentinel)), false);
});

test('direct and router modes switch back and forth through the components route', async t => {
  const h = harness(t);
  const direct = await h.call('GET', '/api/onboarding/state');
  assert.equal(direct.config.providerMode, 'direct');
  const router = await h.call('PUT', '/api/onboarding/components', { components: { router: true }, router: { mode: 'builtin', engine: 'bifrost' } });
  assert.equal(router.config.providerMode, 'router');
  const back = await h.call('PUT', '/api/onboarding/components', { components: { router: false } });
  assert.equal(back.config.providerMode, 'direct');
  const again = await h.call('PUT', '/api/onboarding/components', { components: { router: true }, router: { mode: 'builtin', engine: 'bifrost' } });
  assert.equal(again.config.providerMode, 'router');
  assert.equal(again.config.router.enabled, true);
});

test('OpenCode detection and install requires an explicit confirmation before running npm', async t => {
  const h = harness(t);
  const detected = await h.call('GET', '/api/onboarding/opencode');
  assert.equal(detected.ok, true);
  assert.equal(detected.opencode.installed, false);
  assert.deepEqual(detected.install, { command: 'npm i -g opencode-ai', requiresConfirm: true });
  const refused = await h.call('POST', '/api/onboarding/opencode/install', { confirm: false });
  assert.equal(refused.ok, false);
  assert.equal(refused.requiresConfirm, true);
  assert.equal(h.execCalls.length, 0);

  const installed = await h.call('POST', '/api/onboarding/opencode/install', { confirm: true });
  assert.equal(installed.ok, true);
  assert.equal(installed.installed, true);
  assert.equal(h.execCalls.length, 1);
  assert.equal(h.execCalls[0].command, 'npm');
  assert.deepEqual(h.execCalls[0].args, ['i', '-g', 'opencode-ai']);

  const present = harness(t, { which: () => '/usr/bin/true' });
  const found = await present.call('GET', '/api/onboarding/opencode');
  assert.equal(found.opencode.installed, true);
  assert.equal(found.opencode.path, '/usr/bin/true');
  assert.equal(found.opencode.version, '1.2.3');
});

test('apply records the review result without installing anything itself', async t => {
  const h = harness(t);
  await h.call('PUT', '/api/onboarding/components', { components: { opencode: true } });
  const applied = await h.call('POST', '/api/onboarding/apply', {});
  assert.equal(applied.ok, true);
  assert.match(applied.config.appliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(applied.config.installState.core, 'pending');
  assert.equal(applied.config.installState.opencode, 'pending');
  assert.equal(applied.config.installState.router, 'skipped');
  assert.equal(h.supervisorCalls.some(call => call.method === 'enable'), false);
});

test('wizard shell exports its hooks and uses only dark theme tokens, with no images', () => {
  const source = fs.readFileSync(new URL('../src/onboarding.ts', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/onboarding.css', import.meta.url), 'utf8');
  assert.match(source, /export function mountOnboarding\s*\(/);
  assert.match(source, /export function renderRolesStep\s*\(/);
  assert.match(source, /export function renderReviewStep\s*\(/);
  assert.match(source, /ProviderMode|providerMode/);
  assert.match(source, /Token router \(optional, off\)/);
  assert.match(source, /Direct providers/);
  assert.match(source, /Built-in router/);
  assert.match(source, /External router/);
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /var\(--lime/);
  assert.equal(/background-image|url\(|<img/i.test(css), false);
  assert.equal(/#fff(?:fff)?\b/i.test(css), false);
});
