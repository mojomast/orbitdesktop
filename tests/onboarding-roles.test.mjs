import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_DEFINITIONS,
  MINIMAL_ROLE_IDS,
  defaultSetupMode,
  roleIds,
  providerOptions,
  validateRoles,
  budgetRows,
  roleRows,
  overrideRole,
  clearRoleOverride,
  minimalComponents,
} from '../src/onboarding-roles.ts';

const local = { id: 'local', kind: 'openai-compatible', label: 'Local models' };
const router = { id: 'router', kind: 'router', label: 'Token router', baseUrl: 'https://router.example/v1', routerType: 'hosted' };
const roles = {
  setup: { provider: 'local', model: 'small' },
  chat: { provider: 'local', model: 'large' },
  workers: { provider: 'local', model: 'small' },
  summarize: { provider: 'local', model: 'small' },
};

function config(overrides = {}) {
  return {
    schemaVersion: 1,
    providerMode: 'direct',
    components: { core: true, pi: false, opencode: false, hermes: false, bundlebees: false, workerPairing: false, colab: false, router: false, apps: [] },
    providers: [local],
    roles,
    router: { enabled: false, mode: 'builtin', engine: 'bifrost', bind: 'internal', port: 8080, virtualKeys: [] },
    ...overrides,
  };
}

test('the first-run path defaults to Minimal install and every role has a definition', () => {
  assert.equal(defaultSetupMode(), 'minimal');
  assert.deepEqual(MINIMAL_ROLE_IDS, ['setup', 'chat', 'workers', 'summarize']);
  for (const role of MINIMAL_ROLE_IDS) {
    const definition = ROLE_DEFINITIONS.find(entry => entry.id === role);
    assert.ok(definition, `${role} is defined`);
    assert.equal(typeof definition.label, 'string');
  }
  assert.equal(ROLE_DEFINITIONS.find(entry => entry.id === 'setup').required, true);
  assert.equal(ROLE_DEFINITIONS.find(entry => entry.id === 'chat').required, true);
});

test('role rows include optional roles only when the config has them', () => {
  assert.deepEqual(roleIds(config()), ['setup', 'chat', 'workers', 'summarize']);
  const extended = config({ roles: { ...roles, compaction: { provider: 'local', model: 'small' }, vision: { provider: 'local', model: 'large' } } });
  assert.deepEqual(roleIds(extended), ['setup', 'chat', 'workers', 'summarize', 'compaction', 'vision']);
});

test('provider options show the router only when it is active, and work in router mode', () => {
  assert.deepEqual(providerOptions(config()).map(option => option.id), ['local']);
  const routerOn = config({
    providerMode: 'router',
    components: { ...config().components, router: true },
    providers: [local, router],
    router: { ...config().router, enabled: true, mode: 'external', external: { baseUrl: 'https://router.example/v1' } },
  });
  assert.deepEqual(providerOptions(routerOn).map(option => option.id), ['local', 'router']);
  assert.equal(providerOptions(routerOn).find(option => option.id === 'router').active, true);
  const routerOff = config({ providers: [local, router] });
  assert.equal(providerOptions(routerOff).some(option => option.id === 'router'), false);
});

test('role validation requires setup and chat and rejects unknown providers or empty models', () => {
  assert.equal(validateRoles(config(), roles).ok, true);
  const missing = validateRoles(config(), { ...roles, setup: { provider: '', model: '' }, chat: { provider: '', model: '' } });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(message => /setup/i.test(message)));
  assert.ok(missing.errors.some(message => /chat/i.test(message)));

  const unknown = validateRoles(config(), { ...roles, chat: { provider: 'missing', model: 'large' } });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.some(message => /unknown provider/i.test(message)));

  const noModel = validateRoles(config(), { ...roles, workers: { provider: 'local', model: '' } });
  assert.equal(noModel.ok, false);
  assert.ok(noModel.errors.some(message => /model/i.test(message)));

  const routerProviderWhenOff = validateRoles(config(), { ...roles, chat: { provider: 'router', model: 'auto' } });
  assert.equal(routerProviderWhenOff.ok, false);
});

test('router roles accept the router provider and expose default budgets only when it is enabled', () => {
  const routerOn = config({
    providerMode: 'router',
    components: { ...config().components, router: true },
    providers: [local, router],
    router: { ...config().router, enabled: true, mode: 'builtin', bind: 'loopback', port: 8080 },
  });
  const routed = Object.fromEntries(Object.entries(roles).map(([role]) => [role, { provider: 'router', model: 'auto' }]));
  assert.equal(validateRoles(routerOn, routed).ok, true);
  assert.deepEqual(budgetRows(config()), []);
  const budgets = budgetRows(routerOn);
  assert.deepEqual(budgets.map(entry => [entry.role, entry.usd, entry.reset]), [
    ['setup', 2, '1d'],
    ['chat', 10, '1mo'],
    ['workers', 20, '1mo'],
    ['summarize', 2, '1mo'],
  ]);
});

test('minimal rows inherit the default model and an override wins only for one role', () => {
  const minimal = config({ mode: 'minimal', defaultModel: { provider: 'local', model: 'small' }, roles: {} });
  const inherited = roleRows(minimal);
  assert.equal(inherited.length, 4);
  for (const row of inherited) {
    assert.equal(row.inherits, true, row.role);
    assert.deepEqual({ provider: row.provider, model: row.model }, { provider: 'local', model: 'small' });
  }
  const overridden = overrideRole(minimal.roles, 'chat', 'local', 'large');
  const rows = roleRows({ ...minimal, roles: overridden });
  assert.equal(rows.find(row => row.role === 'chat').inherits, false);
  assert.equal(rows.find(row => row.role === 'chat').model, 'large');
  for (const row of rows.filter(entry => entry.role !== 'chat')) assert.equal(row.inherits, true);
  const cleared = clearRoleOverride(overridden, 'chat');
  assert.equal(roleRows({ ...minimal, roles: cleared }).find(row => row.role === 'chat').inherits, true);
});

test('minimal component suggestions keep exactly core plus one matching first agent and router off', () => {
  assert.deepEqual(minimalComponents('opencode-free'), {
    core: true, pi: false, opencode: true, hermes: false, bundlebees: false, workerPairing: false, colab: false, apps: [], router: false,
  });
  assert.equal(minimalComponents('pi').pi, true);
  assert.equal(minimalComponents('opencode-free').opencode, true);
  const generic = minimalComponents('openai-compatible');
  assert.deepEqual(Object.entries(generic).filter(([key, value]) => key !== 'apps' && value === true).map(([key]) => key), ['core']);
  assert.deepEqual(generic.apps, []);
  assert.equal(generic.router, false);
});
