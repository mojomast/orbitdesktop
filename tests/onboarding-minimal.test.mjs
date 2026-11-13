import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  buildMinimalConfig,
  defaultOrbitConfig,
  validateOrbitConfig,
  resolveRoles,
  switchToCustom,
  createOrbitConfig,
} from '../server/orbit-config.mjs';
import { createOnboardingApply } from '../server/onboarding-apply.mjs';
import { defaultSetupMode, minimalComponents, overrideRole, clearRoleOverride, roleRows } from '../src/onboarding-roles.ts';

const root = () => fs.mkdtempSync('/tmp/opencode/orbit-onboarding-minimal-');
const local = { id: 'local', kind: 'openai-compatible', label: 'Local models', baseUrl: 'http://127.0.0.1:8000/v1' };
const sentinel = 'sk-orbit-test-SENTINEL-minimal-77';
const ALL_ROLES = ['setup', 'chat', 'workers', 'summarize'];

function request({ method = 'GET', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  return req;
}

function response() {
  const out = {};
  return {
    out,
    res: {
      setHeader() {},
      writeHead(status, headers) { out.status = status; Object.assign(out, headers ?? {}); },
      end(value) { out.text = value === undefined ? '' : String(value); out.body = out.text ? JSON.parse(out.text) : undefined; },
    },
  };
}

test('minimal mode maps every role to the single chosen model and keeps custom mode unchanged', () => {
  const minimal = buildMinimalConfig({ provider: local, model: 'small' });
  const roles = resolveRoles(minimal);
  for (const role of ALL_ROLES) assert.deepEqual(roles[role], { provider: 'local', model: 'small' });
  assert.deepEqual(Object.keys(roles).sort(), [...ALL_ROLES].sort());
  assert.equal(minimal.mode, 'minimal');
  assert.deepEqual(minimal.defaultModel, { provider: 'local', model: 'small' });
  assert.equal(minimal.router.enabled, false);
  assert.equal(minimal.providerMode, 'direct');

  const customDoc = {
    ...defaultOrbitConfig(),
    providers: [local],
    roles: {
      setup: { provider: 'local', model: 'a' },
      chat: { provider: 'local', model: 'b' },
      workers: { provider: 'local', model: 'c' },
      summarize: { provider: 'local', model: 'd' },
    },
  };
  const custom = validateOrbitConfig(customDoc);
  assert.equal(Object.hasOwn(custom, 'mode'), false);
  assert.equal(Object.hasOwn(custom, 'defaultModel'), false);
  assert.deepEqual(resolveRoles(custom), customDoc.roles);
});

test('minimal components are exactly core plus one first agent with no optional apps or built-in router', () => {
  const opencode = buildMinimalConfig({ provider: { id: 'opencode', kind: 'opencode-free', label: 'OpenCode free', keyRef: { file: 'opencode.key' } }, model: 'free' });
  assert.deepEqual(opencode.components, { core: true, pi: false, opencode: true, hermes: false, bundlebees: false, workerPairing: false, colab: false, apps: [], router: false });
  assert.equal(opencode.router.enabled, false);
  const pi = buildMinimalConfig({ provider: { id: 'pi', kind: 'pi', label: 'Pi' }, model: 'pi-default' });
  assert.equal(pi.components.pi, true);
  assert.equal(pi.components.opencode, false);
  const generic = buildMinimalConfig({ provider: local, model: 'm' });
  assert.deepEqual(minimalComponents(local.kind), generic.components);
});

test('default first-run selection is Minimal and the minimal components helper is shared with the UI', () => {
  assert.equal(defaultSetupMode(), 'minimal');
  const source = fs.readFileSync(new URL('../src/onboarding.ts', import.meta.url), 'utf8');
  assert.match(source, /Minimal install/);
  assert.match(source, /Custom/);
  assert.match(source, /defaultSetupMode/);
  assert.match(source, /minimalComponents/);
  assert.match(source, /renderRolesStep/);
  assert.match(source, /renderReviewStep/);
  const settings = fs.readFileSync(new URL('../src/settings.ts', import.meta.url), 'utf8');
  assert.match(settings, /inherits default model/i);
  assert.match(settings, /mode: 'custom'|switchToCustom/);
  assert.match(settings, /routerSupervisor|disableRouter|confirm/);
  const css = fs.readFileSync(new URL('../src/settings.css', import.meta.url), 'utf8');
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /var\(--/);
  assert.equal(/background-image|url\(|<img/i.test(css), false);
  assert.equal(/#fff(?:fff)?\b/i.test(css), false);
});

test('a per-role override in Settings wins while other roles still inherit, and clearing falls back', () => {
  const minimal = buildMinimalConfig({ provider: local, model: 'small' });
  const overridden = validateOrbitConfig({ ...minimal, roles: overrideRole(minimal.roles, 'chat', 'local', 'large') });
  const roles = resolveRoles(overridden);
  assert.deepEqual(roles.chat, { provider: 'local', model: 'large' });
  for (const role of ['setup', 'workers', 'summarize']) assert.deepEqual(roles[role], { provider: 'local', model: 'small' });
  const rows = roleRows(overridden);
  assert.equal(rows.find(row => row.role === 'chat').inherits, false);
  assert.equal(rows.find(row => row.role === 'setup').inherits, true);
  const cleared = validateOrbitConfig({ ...overridden, roles: clearRoleOverride(overridden.roles, 'chat') });
  assert.deepEqual(resolveRoles(cleared).chat, { provider: 'local', model: 'small' });
});

test('switching Minimal to Custom materializes effective roles and keeps the mapping', () => {
  const minimal = buildMinimalConfig({ provider: local, model: 'small' });
  const custom = switchToCustom(minimal);
  assert.equal(custom.mode, 'custom');
  for (const role of ALL_ROLES) assert.deepEqual(custom.roles[role], { provider: 'local', model: 'small' });
  assert.deepEqual(resolveRoles(custom), resolveRoles(minimal));
});

test('the schema and validator reject minimal mode without defaultModel', () => {
  const base = buildMinimalConfig({ provider: local, model: 'm' });
  assert.throws(() => validateOrbitConfig({ ...base, defaultModel: undefined }), /defaultModel/);
  assert.throws(() => validateOrbitConfig({ ...base, defaultModel: { provider: 'missing', model: 'm' } }), /defaultModel/);
  const schema = JSON.parse(fs.readFileSync(new URL('../config/orbit-config.schema.json', import.meta.url), 'utf8'));
  const rule = schema.allOf.find(entry => entry.if?.properties?.mode?.const === 'minimal');
  assert.ok(rule.then.required.includes('defaultModel'));
  assert.deepEqual(schema.properties.mode.enum, ['minimal', 'custom']);
});

test('POST apply accepts a minimal config and the setup agent receives the resolved roles without key material', async t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  config.save({ ...defaultOrbitConfig(), providers: [local] });
  config.setKey('local', sentinel);
  const calls = [];
  const logs = [];
  const app = createOnboardingApply({ config, startSetupAgent: async value => calls.push(value), log: line => logs.push(String(line)) });
  const holder = response();
  await app.handle(request({
    method: 'POST',
    body: {
      mode: 'minimal',
      defaultModel: { provider: 'local', model: 'small' },
      components: minimalComponents(local.kind),
    },
  }), holder.res, new URL('/api/onboarding/apply', 'http://127.0.0.1'));
  assert.equal(holder.out.status, 200);
  const body = holder.out.body;
  assert.equal(body.ok, true);
  for (const role of ALL_ROLES) assert.deepEqual(body.roles[role], { provider: 'local', model: 'small' });
  assert.deepEqual(calls[0].roles, body.roles);
  assert.equal(JSON.stringify(body).includes(sentinel), false);
  assert.equal(JSON.stringify(calls[0]).includes(sentinel), false);
  assert.equal(JSON.stringify(logs).includes(sentinel), false);
  const text = fs.readFileSync(path.join(dir, 'orbit-config.json'), 'utf8');
  assert.equal(text.includes(sentinel), false);
  const saved = JSON.parse(text);
  assert.equal(saved.mode, 'minimal');
  assert.equal(saved.components.router, false);
  assert.equal(saved.components.opencode, false);
  assert.deepEqual(saved.components.apps, []);
});

test('minimal with an external router is allowed, but nothing local is started unless router is true', async t => {
  const external = buildMinimalConfig({ provider: { id: 'router', kind: 'router', label: 'Hosted router', baseUrl: 'https://router.example/v1', routerType: 'hosted' }, model: 'auto' });
  assert.equal(external.router.enabled, true);
  assert.equal(external.router.mode, 'external');
  for (const role of ALL_ROLES) assert.deepEqual(resolveRoles(external)[role], { provider: 'router', model: 'auto' });

  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  config.save(buildMinimalConfig({ provider: local, model: 'small' }));
  const calls = [];
  const supervisor = {
    async enable() { calls.push('enable'); },
    async health() { calls.push('health'); return { ok: true, status: 'healthy' }; },
    issueVirtualKeys() { calls.push('issueVirtualKeys'); },
  };
  const app = createOnboardingApply({ config, startSetupAgent: async () => {}, routerSupervisor: supervisor });
  const holder = response();
  await app.handle(request({ method: 'POST', body: {} }), holder.res, new URL('/api/onboarding/apply', 'http://127.0.0.1'));
  assert.equal(holder.out.body.ok, true);
  assert.deepEqual(calls, []);
  assert.equal(config.load().router.enabled, false);
});
