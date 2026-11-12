import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createOrbitConfig,
  validateOrbitConfig,
  defaultOrbitConfig,
  resolveRoles,
  buildMinimalConfig,
  switchToCustom,
  MINIMAL_ROLES,
} from '../server/orbit-config.mjs';

const root = () => fs.mkdtempSync('/tmp/opencode/orbit-config-minimal-');
const sentinel = 'sk-orbit-test-SENTINEL-min7';
const local = { id: 'local', kind: 'openai-compatible', label: 'Local models', baseUrl: 'http://127.0.0.1:8000/v1' };
const ALL_FOUR = ['setup', 'chat', 'workers', 'summarize'];

test('minimal mode maps every role to the one chosen model', () => {
  const config = buildMinimalConfig({ provider: local, model: 'qwen-small' });
  assert.equal(config.mode, 'minimal');
  assert.deepEqual(config.defaultModel, { provider: 'local', model: 'qwen-small' });
  const roles = resolveRoles(config);
  assert.deepEqual(Object.keys(roles).sort(), [...ALL_FOUR].sort());
  for (const role of ALL_FOUR) assert.deepEqual(roles[role], { provider: 'local', model: 'qwen-small' }, role);
  assert.deepEqual(MINIMAL_ROLES, ALL_FOUR);
});

test('minimal mode also fills optional roles when they are present', () => {
  const config = validateOrbitConfig({
    ...buildMinimalConfig({ provider: local, model: 'm' }),
    roles: { compaction: { provider: '', model: '' }, vision: { provider: '', model: '' } },
  });
  const roles = resolveRoles(config);
  for (const role of [...ALL_FOUR, 'compaction', 'vision']) assert.deepEqual(roles[role], { provider: 'local', model: 'm' }, role);
});

test('minimal components: core plus exactly one first agent, router off, no optional apps', () => {
  const free = buildMinimalConfig({ provider: { id: 'opencode', kind: 'opencode-free', label: 'OpenCode free' }, model: 'deepseek-v4.1-flash-free' });
  assert.deepEqual(free.components, { core: true, pi: false, opencode: true, hermes: false, bundlebees: false, workerPairing: false, colab: false, apps: [], router: false });
  assert.equal(free.router.enabled, false);
  assert.equal(free.providerMode, 'direct');
  const pi = buildMinimalConfig({ provider: { id: 'pi', kind: 'pi', label: 'Pi' }, model: 'pi-default' });
  assert.equal(pi.components.pi, true);
  assert.equal(pi.components.opencode, false);
  const generic = buildMinimalConfig({ provider: local, model: 'm' });
  const enabled = Object.entries(generic.components).filter(([key, value]) => key !== 'apps' && value === true).map(([key]) => key);
  assert.deepEqual(enabled, ['core']);
  assert.deepEqual(generic.components.apps, []);
});

test('minimal with an external router uses it for every role and starts nothing locally', () => {
  const config = buildMinimalConfig({ provider: { id: 'router', kind: 'router', label: 'Hosted router', baseUrl: 'https://router.example.com/v1', routerType: 'hosted' }, model: 'auto' });
  assert.equal(config.router.mode, 'external');
  assert.equal(config.router.enabled, true);
  assert.equal(config.router.external.baseUrl, 'https://router.example.com/v1');
  assert.equal(config.providerMode, 'router');
  for (const role of ALL_FOUR) assert.deepEqual(resolveRoles(config)[role], { provider: 'router', model: 'auto' });
});

test('minimal rejects the built-in router, a missing default model and unknown providers', () => {
  const base = buildMinimalConfig({ provider: local, model: 'm' });
  assert.throws(() => validateOrbitConfig({ ...base, defaultModel: undefined }), /defaultModel/);
  assert.throws(() => validateOrbitConfig({ ...base, defaultModel: { provider: 'local', model: '' } }), /defaultModel/);
  assert.throws(() => validateOrbitConfig({ ...base, defaultModel: { provider: 'nope', model: 'm' } }), /defaultModel/);
  assert.throws(() => validateOrbitConfig({ ...base, mode: 'tiny' }), /mode/);
  const builtin = { ...base, components: { ...base.components, router: true }, router: { ...base.router, enabled: true, mode: 'builtin' } };
  assert.throws(() => validateOrbitConfig(builtin), /built-in router/);
  assert.throws(() => buildMinimalConfig({ provider: local, model: '' }), /model/);
});

test('a per-role override wins while the other roles still inherit, and clearing it falls back', () => {
  const base = buildMinimalConfig({ provider: local, model: 'small' });
  const overridden = validateOrbitConfig({ ...base, roles: { ...base.roles, chat: { provider: 'local', model: 'large' } } });
  const roles = resolveRoles(overridden);
  assert.deepEqual(roles.chat, { provider: 'local', model: 'large' });
  for (const role of ['setup', 'workers', 'summarize']) assert.deepEqual(roles[role], { provider: 'local', model: 'small' });
  const cleared = validateOrbitConfig({ ...overridden, roles: { ...overridden.roles, chat: { provider: '', model: '' } } });
  assert.deepEqual(resolveRoles(cleared).chat, { provider: 'local', model: 'small' });
});

test('switching minimal to custom materializes the effective roles', () => {
  const base = buildMinimalConfig({ provider: local, model: 'small' });
  const custom = switchToCustom(validateOrbitConfig({ ...base, roles: { ...base.roles, workers: { provider: 'local', model: 'big' } } }));
  assert.equal(custom.mode, 'custom');
  assert.equal(custom.roles.setup.model, 'small');
  assert.equal(custom.roles.workers.model, 'big');
  assert.deepEqual(resolveRoles(custom), { ...resolveRoles(base), workers: { provider: 'local', model: 'big' } });
});

test('custom mode is unchanged: no mode field is added and roles resolve exactly as stored', () => {
  const doc = {
    ...defaultOrbitConfig(),
    providers: [local],
    roles: {
      setup: { provider: 'local', model: 'a' },
      chat: { provider: 'local', model: 'b' },
      workers: { provider: 'local', model: 'c' },
      summarize: { provider: '', model: '' },
    },
  };
  const normalized = validateOrbitConfig(doc);
  assert.equal(Object.hasOwn(normalized, 'mode'), false);
  assert.equal(Object.hasOwn(normalized, 'defaultModel'), false);
  assert.deepEqual(normalized.roles, doc.roles);
  const roles = resolveRoles(normalized);
  assert.deepEqual(roles.setup, { provider: 'local', model: 'a' });
  assert.deepEqual(roles.summarize, { provider: '', model: '' });
  const explicit = validateOrbitConfig({ ...doc, mode: 'custom' });
  assert.equal(explicit.mode, 'custom');
  assert.deepEqual(explicit.roles, doc.roles);
});

test('minimal configs persist privately, keep keys out of the file and feed every role to the registry', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrbitConfig({ runtimeDir: dir, env: {} });
  store.save(buildMinimalConfig({ provider: local, model: 'qwen-small' }));
  store.setKey('local', sentinel);
  const text = fs.readFileSync(store.configFile, 'utf8');
  assert.equal(text.includes(sentinel), false);
  const saved = JSON.parse(text);
  assert.equal(saved.mode, 'minimal');
  assert.deepEqual(saved.defaultModel, { provider: 'local', model: 'qwen-small' });
  const agents = store.toRegistryConfig().agents;
  assert.deepEqual(agents.map(agent => agent.id), ALL_FOUR);
  for (const agent of agents) assert.equal(agent.model, 'qwen-small');
  assert.equal(JSON.stringify(agents).includes(sentinel), false);
  assert.equal(JSON.stringify(store.view()).includes(sentinel), false);
});

test('published schema documents mode and defaultModel', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../config/orbit-config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.mode.enum, ['minimal', 'custom']);
  assert.equal(schema.properties.mode.default, 'custom');
  assert.deepEqual(schema.properties.defaultModel.$ref, '#/$defs/role');
  const rule = schema.allOf.find(entry => entry.if?.properties?.mode?.const === 'minimal');
  assert.ok(rule, 'minimal requires defaultModel');
  assert.ok(rule.then.required.includes('defaultModel'));
});
