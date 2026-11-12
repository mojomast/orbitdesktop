import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOrbitConfig, ROUTER_IMAGES, DEFAULT_ROLE_BUDGETS } from '../server/orbit-config.mjs';

const sentinel = 'sk-orbit-test-SENTINEL-9f3a';
const root = () => fs.mkdtempSync('/tmp/opencode/orbit-config-');

function provider(overrides = {}) {
  return {
    id: 'local',
    kind: 'openai-compatible',
    label: 'Local models',
    baseUrl: 'http://127.0.0.1:8000/v1',
    privacyNote: 'Runs on this machine.',
    ...overrides,
  };
}

test('defaults are a valid first-run document: core only, direct providers, router off', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  const loaded = config.load();
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.components.core, true);
  assert.equal(loaded.components.router, false);
  assert.equal(loaded.providerMode, 'direct');
  assert.equal(loaded.router.enabled, false);
  assert.equal(loaded.router.engine, 'bifrost');
  assert.equal(loaded.router.image, ROUTER_IMAGES.bifrost);
  assert.equal(loaded.router.image.includes('latest'), false);
  assert.equal(loaded.router.external.baseUrl, '');
  assert.deepEqual(loaded.providers, []);
  assert.equal(loaded.roles.setup.provider, '');
  assert.deepEqual(DEFAULT_ROLE_BUDGETS.setup, { usd: 2, reset: '1d' });
  assert.deepEqual(loaded.router.virtualKeys.map(key => key.role), ['setup', 'chat', 'workers', 'summarize']);
  assert.equal(fs.existsSync(path.join(dir, 'orbit-config.json')), false);
});

test('save is atomic, private and round-trips through load/view', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  const next = {
    ...config.load(),
    components: { ...config.load().components, pi: true, apps: ['focus-timer'] },
    providers: [provider()],
    roles: {
      setup: { provider: 'local', model: 'small' },
      chat: { provider: 'local', model: 'large' },
      workers: { provider: 'local', model: 'large' },
      summarize: { provider: 'local', model: 'small' },
    },
  };
  const saved = config.save(next);
  assert.equal(saved.components.pi, true);
  const file = path.join(dir, 'orbit-config.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(config.load(), saved);
  const view = config.view();
  assert.deepEqual(view.providers[0].key, { set: false, masked: null });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).components.pi, true);
});

test('schema subset rejects wrong types, enums, unknown fields, IDs and keyRef shapes', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  const base = config.load();
  for (const bad of [
    { ...base, schemaVersion: 2 },
    { ...base, components: { core: 'yes' } },
    { ...base, components: { core: true, unknown: true } },
    { ...base, components: { core: true, apps: [1] } },
    { ...base, providers: [{ ...provider(), id: 'Bad ID' }] },
    { ...base, providers: [{ ...provider(), kind: 'mystery' }] },
    { ...base, providers: [{ ...provider(), baseUrl: 'file:///tmp/key' }] },
    { ...base, providers: [{ ...provider(), unexpected: 'x' }] },
    { ...base, providers: [{ ...provider(), keyRef: { file: '../escape.key' } }] },
    { ...base, providers: [{ ...provider(), keyRef: { file: 'a.key', env: 'A_KEY' } }] },
    { ...base, providers: [{ ...provider(), keyRef: { env: 'lower-case' } }] },
    { ...base, appliedAt: 'yesterday' },
    { ...base, installState: { core: 'done' } },
    { ...base, roles: { ...base.roles, setup: { provider: 'missing', model: 'm' } } },
    { ...base, router: { ...base.router, port: 70000 } },
    { ...base, router: { ...base.router, engine: 'other' } },
    { ...base, router: { ...base.router, image: 'maximhq/bifrost:latest' } },
  ]) {
    assert.throws(() => config.save(bad), /Invalid Orbit configuration/, JSON.stringify(bad));
  }
});

test('router rules: components and enabled agree, mode requires exactly one router provider', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  const base = config.load();
  assert.throws(
    () => config.save({ ...base, components: { ...base.components, router: true }, router: { ...base.router, enabled: false } }),
    /router/i,
  );
  assert.throws(
    () => config.save({ ...base, components: { ...base.components, router: false }, router: { ...base.router, enabled: true } }),
    /router/i,
  );
  assert.throws(
    () => config.save({
      ...base,
      components: { ...base.components, router: false },
      providers: [{ id: 'router', kind: 'router', label: 'Router', routerType: 'hosted' }],
    }),
    /baseUrl/i,
  );
  assert.throws(
    () => config.save({
      ...base,
      components: { ...base.components, router: true },
      router: { ...base.router, enabled: true, mode: 'builtin' },
      providers: [
        { id: 'router', kind: 'router', label: 'Router', baseUrl: 'http://127.0.0.1:8080/v1', routerType: 'self-hosted' },
        { id: 'other', kind: 'router', label: 'Other', baseUrl: 'http://127.0.0.1:8081/v1', routerType: 'self-hosted' },
      ],
    }),
    /exactly one/i,
  );

  const enabled = config.save({
    ...base,
    components: { ...base.components, router: true },
    router: { ...base.router, enabled: true, mode: 'builtin', engine: 'bifrost', bind: 'loopback', port: 8080 },
  });
  assert.equal(enabled.providerMode, 'router');
  assert.equal(enabled.router.enabled, true);
  assert.equal(enabled.providers.filter(item => item.kind === 'router').length, 1);
  assert.equal(enabled.providers[0].id, 'router');

  const direct = config.save({ ...enabled, components: { ...enabled.components, router: false }, router: { ...enabled.router, enabled: false } });
  assert.equal(direct.providerMode, 'direct');
  assert.equal(direct.router.enabled, false);
  const again = config.save({ ...direct, components: { ...direct.components, router: true }, router: { ...direct.router, enabled: true, mode: 'builtin' } });
  assert.equal(again.providerMode, 'router');
  assert.equal(again.router.enabled, true);
});

test('external router round-trips with one key reference and no secret value', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  const base = config.load();
  const saved = config.save({
    ...base,
    components: { ...base.components, router: true },
    router: {
      ...base.router,
      enabled: true,
      mode: 'external',
      external: { baseUrl: 'https://router.example/v1', keyRef: { file: 'external-router.key' } },
    },
    providers: [{ id: 'router', kind: 'router', label: 'External router', routerType: 'hosted', baseUrl: 'https://router.example/v1' }],
  });
  assert.equal(saved.router.mode, 'external');
  assert.equal(saved.router.external.baseUrl, 'https://router.example/v1');
  assert.equal(saved.providers[0].id, 'router');
  assert.ok(!JSON.stringify(saved).includes(sentinel));
});

test('keys live in 0600 files under a 0700 directory, never in the config file', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: {} });
  const base = config.load();
  config.save({
    ...base,
    providers: [provider()],
    roles: { ...base.roles, chat: { provider: 'local', model: 'large' } },
  });
  const result = config.setKey('local', sentinel);
  assert.deepEqual(result, { id: 'local', key: { set: true, masked: 'sk-…9f3a' } });
  const keysDir = path.join(dir, 'keys');
  const keyFile = path.join(keysDir, 'local.key');
  assert.equal(fs.statSync(keysDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), sentinel);
  assert.ok(!fs.readFileSync(path.join(dir, 'orbit-config.json'), 'utf8').includes(sentinel));
  const loaded = config.load();
  assert.deepEqual(loaded.providers[0].keyRef, { file: 'local.key' });
  const view = config.view();
  assert.equal(view.providers[0].key.set, true);
  assert.equal(view.providers[0].key.masked, 'sk-…9f3a');
  assert.ok(!JSON.stringify(view).includes(sentinel));
  assert.equal(config.resolveKey('local'), sentinel);
  assert.deepEqual(config.toRegistryConfig().agents[0], {
    id: 'chat',
    kind: 'openai-compatible',
    label: 'Local models',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'large',
    apiKeyFile: keyFile,
  });
  assert.ok(!JSON.stringify(config.toRegistryConfig()).includes(sentinel));
  config.clearKey('local');
  assert.equal(fs.existsSync(keyFile), false);
  assert.equal(config.view().providers[0].key.set, false);
  assert.equal(config.resolveKey('local'), null);
});

test('environment key references resolve server-side and stay masked in views', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: { PROVIDER_SECRET: sentinel } });
  const base = config.load();
  config.save({ ...base, providers: [provider({ keyRef: { env: 'PROVIDER_SECRET' } })] });
  assert.equal(config.resolveKey('local'), sentinel);
  const view = config.view();
  assert.deepEqual(view.providers[0].key, { set: true, masked: 'sk-…9f3a' });
  assert.ok(!JSON.stringify(view).includes(sentinel));
  assert.deepEqual(config.toRegistryConfig().agents, []);
  config.clearKey('local');
  assert.equal(config.load().providers[0].keyRef, undefined);
});

test('toRegistryConfig exposes one agent per chosen role with the correct key source', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = createOrbitConfig({ runtimeDir: dir, env: { WORKER_TOKEN: sentinel } });
  const base = config.load();
  const saved = config.save({
    ...base,
    components: { ...base.components, router: true },
    router: { ...base.router, enabled: true, mode: 'builtin', engine: 'bifrost', bind: 'loopback', port: 8080 },
    providers: [
      provider({ id: 'worker-endpoint', kind: 'openai-compatible', label: 'Worker', baseUrl: 'http://127.0.0.1:9000/v1', keyRef: { env: 'WORKER_TOKEN' } }),
    ],
    roles: {
      setup: { provider: 'router', model: 'setup-model' },
      chat: { provider: 'router', model: 'chat-model' },
      workers: { provider: 'worker-endpoint', model: 'worker-model' },
      summarize: { provider: 'router', model: 'summary-model' },
    },
  });
  assert.ok(saved.providers.some(item => item.id === 'router'));
  const registry = config.toRegistryConfig();
  assert.deepEqual(registry.agents.map(agent => agent.id), ['setup', 'chat', 'workers', 'summarize']);
  assert.equal(registry.agents[0].baseUrl.includes('127.0.0.1:8080'), true);
  assert.equal(registry.agents[0].apiKeyFile, path.join(dir, 'keys', 'router-vk-setup.key'));
  assert.deepEqual(registry.agents[2], {
    id: 'workers',
    kind: 'openai-compatible',
    label: 'Worker',
    baseUrl: 'http://127.0.0.1:9000/v1',
    model: 'worker-model',
    apiKeyEnv: 'WORKER_TOKEN',
  });
  assert.ok(!JSON.stringify(registry).includes(sentinel));
});

test('ORBIT_CONFIG_FILE override must be absolute and stays outside the key directory rules', t => {
  const dir = root();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => createOrbitConfig({ runtimeDir: dir, env: { ORBIT_CONFIG_FILE: 'relative.json' } }), /absolute/i);
  const custom = path.join(dir, 'nested', 'custom-config.json');
  const config = createOrbitConfig({ runtimeDir: dir, env: { ORBIT_CONFIG_FILE: custom } });
  config.save(config.load());
  assert.equal(fs.statSync(custom).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(dir, 'orbit-config.json')), false);
});

test('published schema is draft 2020-12 and describes the opt-in router', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../config/orbit-config.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.$defs.components.required.includes('core'), true);
  assert.equal(schema.$defs.components.properties.router.default, false);
  assert.equal(schema.$defs.router.properties.enabled.default, false);
  assert.equal(schema.$defs.router.properties.engine.default, 'bifrost');
  assert.deepEqual(schema.$defs.router.properties.engine.enum, ['bifrost', 'litellm']);
  assert.equal(schema.$defs.provider.properties.kind.enum.includes('router'), true);
});
