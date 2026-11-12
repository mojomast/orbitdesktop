// Hermetic supervisor tests: every filesystem path is a temporary runtime and
// every external effect (exec, fetch, randomness, logging) is injected. No
// network, no Docker, no real HOME and no real tokens.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouterSupervisor } from '../server/router-supervisor.mjs';

const SENTINEL = 'sk-test-UPSTREAM-SENTINEL-9f3a';
const COMPOSE = path.resolve(fileURLToPath(new URL('../compose.router.yml', import.meta.url)));

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-router-test-'));
  fs.mkdirSync(path.join(root, 'keys'), { recursive: true, mode: 0o700 });
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function fakeExec() {
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: 0, stdout: '', stderr: '' };
  };
  exec.calls = calls;
  return exec;
}

function fakeFetch({ failures = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length <= failures) {
      return { ok: false, status: 503, async text() { return ''; }, async json() { return {}; } };
    }
    return { ok: true, status: 200, async text() { return 'ok'; }, async json() { return { data: [] }; } };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function fakeLog() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  log.lines = lines;
  return log;
}

function rng() {
  let counter = 0;
  return n => {
    counter += 1;
    return Buffer.alloc(n, counter);
  };
}

function routerConfig(overrides = {}) {
  const router = {
    enabled: true,
    mode: 'builtin',
    engine: 'bifrost',
    bind: 'internal',
    port: 8080,
    contentLogging: false,
    allowPrivateNetwork: false,
    upstreams: [
      { providerId: 'openrouter', weight: 1, models: ['deepseek/deepseek-chat'] },
    ],
    fallbacks: [],
    virtualKeys: [
      {
        role: 'setup',
        keyRef: { file: 'router-vk-setup.key' },
        allowedModels: ['*'],
        budget: { usd: 2, reset: '1d' },
        rateLimit: { requests: 60, tokens: 200000, reset: '1h' },
        expiresAt: null,
      },
      {
        role: 'chat',
        keyRef: { file: 'router-vk-chat.key' },
        allowedModels: ['deepseek/deepseek-chat'],
        budget: { usd: 10, reset: '1M' },
        rateLimit: { requests: 600, tokens: 2000000, reset: '1h' },
        expiresAt: null,
      },
      {
        role: 'workers',
        keyRef: { file: 'router-vk-workers.key' },
        allowedModels: ['deepseek/deepseek-chat'],
        budget: { usd: 20, reset: '1M' },
        rateLimit: { requests: 600, tokens: 2000000, reset: '1h' },
        expiresAt: null,
      },
      {
        role: 'summarize',
        keyRef: { file: 'router-vk-summarize.key' },
        allowedModels: ['deepseek/deepseek-chat'],
        budget: { usd: 2, reset: '1M' },
        rateLimit: { requests: 300, tokens: 1000000, reset: '1h' },
        expiresAt: null,
      },
    ],
    external: {
      baseUrl: 'https://router.example.invalid/api/v1',
      keyRef: { file: 'external-router.key' },
    },
    healthTimeoutMs: 200,
    healthPollMs: 1,
    ...overrides,
  };
  return {
    components: { router: router.enabled },
    router,
    roles: {
      setup: { provider: 'router', model: 'deepseek/deepseek-chat' },
      chat: { provider: 'router', model: 'deepseek/deepseek-chat' },
      workers: { provider: 'router', model: 'deepseek/deepseek-chat' },
      summarize: { provider: 'router', model: 'deepseek/deepseek-chat' },
    },
  };
}

function setup(config, overrides = {}) {
  const runtimeDir = overrides.runtimeDir ?? tempRuntime();
  const exec = overrides.exec ?? fakeExec();
  const fetchImpl = overrides.fetchImpl ?? fakeFetch();
  const log = overrides.log ?? fakeLog();
  const supervisor = createRouterSupervisor({
    runtimeDir,
    config,
    exec,
    fetchImpl,
    now: overrides.now ?? (() => Date.now()),
    log,
    randomBytes: overrides.randomBytes ?? rng(),
  });
  return { runtimeDir, exec, fetchImpl, log, supervisor };
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

test('the default config renders nothing and never execs', async () => {
  const runtimeDir = tempRuntime();
  const config = { components: { router: false }, router: { enabled: false } };
  const { exec, log, supervisor } = setup(config, { runtimeDir });
  try {
    await assert.rejects(() => supervisor.enable());
    assert.equal(exec.calls.length, 0);
    assert.equal(supervisor.status().enabled, false);
    assert.equal(supervisor.status().configured, false);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'router')), false);
    assert.equal(fs.existsSync(path.join(runtimeDir, '.env')), false);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'router.env')), false);
    assert.equal(log.lines.length, 0);
  } finally {
    cleanup(runtimeDir);
  }
});

test('a components/router disagreement fails closed before any effect', async () => {
  const runtimeDir = tempRuntime();
  const config = { components: { router: false }, router: { enabled: true, mode: 'builtin' } };
  const { exec, supervisor } = setup(config, { runtimeDir });
  try {
    await assert.rejects(() => supervisor.enable(), /agree/i);
    assert.equal(exec.calls.length, 0);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'router')), false);
  } finally {
    cleanup(runtimeDir);
  }
});

test('enable writes private files, the compose profile and the exact compose command', async () => {
  const runtimeDir = tempRuntime();
  const keyFile = path.join(runtimeDir, 'keys', 'openrouter.key');
  fs.writeFileSync(keyFile, `${SENTINEL}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(runtimeDir, '.env'), 'FOO=bar\n', { mode: 0o600 });

  const { exec, fetchImpl, log, supervisor } = setup(routerConfig(), { runtimeDir });
  try {
    assert.equal(fs.readFileSync(path.join(runtimeDir, '.env'), 'utf8').includes('COMPOSE_PROFILES'), false);

    await supervisor.enable();

    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].file, 'docker');
    assert.deepEqual(exec.calls[0].args, ['compose', '--profile', 'router', 'up', '-d', 'router']);
    assert.equal(exec.calls[0].options.env.ORBIT_RUNTIME_DIR, runtimeDir);
    assert.match(exec.calls[0].options.env.ORBIT_ROUTER_IMAGE, /@sha256:[a-f0-9]{64}$/);

    const envText = fs.readFileSync(path.join(runtimeDir, '.env'), 'utf8');
    assert.match(envText, /^FOO=bar$/m);
    assert.match(envText, /^COMPOSE_PROFILES=router$/m);
    assert.equal(mode(path.join(runtimeDir, '.env')), 0o600);

    const routerEnv = path.join(runtimeDir, 'router', 'router.env');
    const renderedConfig = path.join(runtimeDir, 'router', 'data', 'config.json');
    assert.equal(mode(routerEnv), 0o600);
    assert.equal(mode(path.dirname(routerEnv)), 0o700);
    assert.equal(mode(path.dirname(renderedConfig)), 0o700);
    assert.equal(mode(renderedConfig), 0o600);

    const upstreamOnly = fs.readFileSync(routerEnv, 'utf8');
    assert.ok(upstreamOnly.includes(SENTINEL));
    const configText = fs.readFileSync(renderedConfig, 'utf8');
    assert.ok(!configText.includes(SENTINEL));
    const statusText = JSON.stringify(supervisor.status());
    assert.ok(!statusText.includes(SENTINEL));
    assert.ok(!log.lines.join('\n').includes(SENTINEL));

    const rendered = JSON.parse(configText);
    assert.equal(rendered.virtual_keys.length, 4);

    for (const role of ['setup', 'chat', 'workers', 'summarize']) {
      const file = path.join(runtimeDir, 'keys', `router-vk-${role}.key`);
      assert.ok(fs.existsSync(file));
      assert.equal(mode(file), 0o600);
      const value = fs.readFileSync(file, 'utf8').trim();
      assert.match(value, /^sk-bf-[A-Za-z0-9_-]{20,}$/);
      assert.ok(!statusText.includes(value));
    }

    assert.equal(supervisor.status().health, 'healthy');
    assert.ok(fetchImpl.calls.length >= 1);
    assert.match(fetchImpl.calls[0].url, /\/health$/);
    assert.equal(supervisor.status().image.includes('@sha256:'), true);
  } finally {
    cleanup(runtimeDir);
  }
});

test('health is polled by the server until it succeeds', async () => {
  const runtimeDir = tempRuntime();
  const fetchImpl = fakeFetch({ failures: 2 });
  const { supervisor } = setup(routerConfig(), { runtimeDir, fetchImpl });
  try {
    await supervisor.enable();
    assert.equal(fetchImpl.calls.length, 3);
    for (const call of fetchImpl.calls) assert.match(call.url, /\/health$/);
    assert.equal(supervisor.status().health, 'healthy');
  } finally {
    cleanup(runtimeDir);
  }
});

test('disable refuses without confirmation, then removes generated state but keeps upstream keys', async () => {
  const runtimeDir = tempRuntime();
  const upstream = path.join(runtimeDir, 'keys', 'openrouter.key');
  fs.writeFileSync(upstream, `${SENTINEL}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(runtimeDir, '.env'), 'FOO=bar\n', { mode: 0o600 });

  const { exec, supervisor } = setup(routerConfig(), { runtimeDir });
  try {
    await supervisor.enable();
    const afterEnable = exec.calls.length;

    await assert.rejects(() => supervisor.disable());
    await assert.rejects(() => supervisor.disable({ confirm: false }));
    assert.equal(exec.calls.length, afterEnable);
    assert.ok(fs.existsSync(path.join(runtimeDir, 'router', 'router.env')));
    assert.ok(fs.existsSync(path.join(runtimeDir, 'keys', 'router-vk-chat.key')));

    await supervisor.disable({ confirm: true });

    const last = exec.calls.at(-1);
    assert.equal(last.file, 'docker');
    assert.deepEqual(last.args, ['compose', '--profile', 'router', 'down', 'router']);

    const envText = fs.readFileSync(path.join(runtimeDir, '.env'), 'utf8');
    assert.match(envText, /^FOO=bar$/m);
    assert.ok(!envText.includes('COMPOSE_PROFILES'));
    assert.equal(fs.existsSync(path.join(runtimeDir, 'router', 'router.env')), false);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'router', 'data', 'config.json')), false);
    for (const role of ['setup', 'chat', 'workers', 'summarize']) {
      assert.equal(fs.existsSync(path.join(runtimeDir, 'keys', `router-vk-${role}.key`)), false);
    }
    assert.equal(fs.readFileSync(upstream, 'utf8').trim(), SENTINEL);
    assert.equal(supervisor.status().enabled, false);
    assert.equal(supervisor.status().configured, false);
  } finally {
    cleanup(runtimeDir);
  }
});

test('external mode never execs and probes the upstream models endpoint with the key', async () => {
  const runtimeDir = tempRuntime();
  fs.writeFileSync(path.join(runtimeDir, 'keys', 'external-router.key'), `${SENTINEL}\n`, { mode: 0o600 });
  const fetchImpl = fakeFetch();
  const { exec, supervisor } = setup(
    routerConfig({ mode: 'external' }),
    { runtimeDir, fetchImpl },
  );
  try {
    await supervisor.enable();
    assert.equal(exec.calls.length, 0);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://router.example.invalid/api/v1/models');
    assert.equal(fetchImpl.calls[0].options.headers.Authorization, `Bearer ${SENTINEL}`);
    assert.equal(fs.existsSync(path.join(runtimeDir, '.env')), false);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'router')), false);
    assert.ok(!JSON.stringify(supervisor.status()).includes(SENTINEL));

    const entries = supervisor.toRegistryEntries();
    assert.equal(entries.length, 4);
    assert.equal(entries[0].baseUrl, 'https://router.example.invalid/api/v1');

    await supervisor.disable({ confirm: true });
    assert.equal(exec.calls.length, 0);
  } finally {
    cleanup(runtimeDir);
  }
});

test('registry entries describe each routed role without exposing key material', async () => {
  const runtimeDir = tempRuntime();
  const { supervisor } = setup(routerConfig(), { runtimeDir });
  try {
    const entries = supervisor.toRegistryEntries();
    assert.equal(entries.length, 4);
    for (const entry of entries) {
      assert.equal(entry.kind, 'openai-compatible');
      assert.match(entry.baseUrl, /^http:\/\/router:8080\/v1$/);
      assert.match(entry.apiKeyFile, /^router-vk-[a-z]+\.key$/);
      assert.equal(entry.model, 'deepseek/deepseek-chat');
      assert.ok(!JSON.stringify(entry).includes(SENTINEL));
      assert.ok(!JSON.stringify(entry).includes('sk-'));
    }

    const loopback = setup(routerConfig({ bind: 'loopback' }), { runtimeDir: tempRuntime() });
    try {
      for (const entry of loopback.supervisor.toRegistryEntries()) {
        assert.match(entry.baseUrl, /^http:\/\/127\.0\.0\.1:8080\/v1$/);
      }
    } finally {
      cleanup(loopback.runtimeDir);
    }
  } finally {
    cleanup(runtimeDir);
  }
});

test('rotateKey replaces one virtual key only and issueVirtualKeys is idempotent', async () => {
  const runtimeDir = tempRuntime();
  const { supervisor } = setup(routerConfig(), { runtimeDir });
  try {
    await supervisor.enable();
    const chatFile = path.join(runtimeDir, 'keys', 'router-vk-chat.key');
    const setupFile = path.join(runtimeDir, 'keys', 'router-vk-setup.key');
    const chatBefore = fs.readFileSync(chatFile, 'utf8');
    const setupBefore = fs.readFileSync(setupFile, 'utf8');

    const summary = supervisor.rotateKey('chat');
    assert.equal(summary.role, 'chat');
    assert.equal(summary.rotated, true);
    assert.notEqual(fs.readFileSync(chatFile, 'utf8'), chatBefore);
    assert.equal(fs.readFileSync(setupFile, 'utf8'), setupBefore);
    assert.equal(mode(chatFile), 0o600);

    const chatAfterRotate = fs.readFileSync(chatFile, 'utf8');
    const issues = supervisor.issueVirtualKeys();
    assert.equal(issues.length, 4);
    assert.equal(fs.readFileSync(chatFile, 'utf8'), chatAfterRotate);
    assert.equal(mode(chatFile), 0o600);
    assert.ok(!JSON.stringify(issues).includes(chatAfterRotate.trim()));
  } finally {
    cleanup(runtimeDir);
  }
});

test('failed starts and errors never leak key material through logs', async () => {
  const runtimeDir = tempRuntime();
  const exec = async () => {
    throw new Error(`Authorization: Bearer ${SENTINEL} x-api-key: ${SENTINEL} x-bf-vk: ${SENTINEL}`);
  };
  const log = fakeLog();
  const { supervisor } = setup(routerConfig(), { runtimeDir, exec, log });
  try {
    await assert.rejects(() => supervisor.enable());
    const joined = log.lines.join('\n');
    assert.ok(!joined.includes(SENTINEL));
    assert.ok(!joined.includes('sk-test'));
    assert.match(joined, /\[redacted\]/);
  } finally {
    cleanup(runtimeDir);
  }
});

test('both built-in engines resolve to digest-pinned images', () => {
  const bifrost = setup(routerConfig(), { runtimeDir: tempRuntime() });
  const litellm = setup(routerConfig({ engine: 'litellm' }), { runtimeDir: tempRuntime() });
  try {
    assert.match(bifrost.supervisor.status().image, /^maximhq\/bifrost:v2\.5\.1@sha256:[a-f0-9]{64}$/);
    assert.match(litellm.supervisor.status().image, /^litellm\/litellm:v1\.108\.6-lts@sha256:[a-f0-9]{64}$/);
    assert.ok(!/latest/.test(bifrost.supervisor.status().image));
    assert.ok(!/latest/.test(litellm.supervisor.status().image));
  } finally {
    cleanup(bifrost.runtimeDir);
    cleanup(litellm.runtimeDir);
  }
});

test('the compose file pins a digest and never uses latest', () => {
  const text = fs.readFileSync(COMPOSE, 'utf8');
  assert.match(text, /image:\s*\S+@sha256:[a-f0-9]{64}/);
  assert.ok(!/:\s*latest\b/.test(text));
  assert.match(text, /profiles:\s*\["router"\]/);
  assert.match(text, /read_only:\s*true/);
  assert.match(text, /cap_drop:\s*\[ALL\]/);
  assert.match(text, /no-new-privileges:true/);
  assert.match(text, /user:\s*"10001:10001"/);
  assert.match(text, /mem_limit:\s*512m/);
  assert.match(text, /GOMEMLIMIT:\s*450MiB/);
  assert.ok(!/healthcheck:/.test(text));
  assert.match(text, /#\s*ports:\s*\["127\.0\.0\.1:8080:8080"\]/);
  const uncommented = text.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.ok(!/^\s*ports:/m.test(uncommented));
});
