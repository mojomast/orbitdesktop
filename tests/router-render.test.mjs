// Renderers are pure: no filesystem, network or environment access. These
// tests pin the exact shapes the supervisor and the coordinator rely on.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderBifrostConfig,
  renderLiteLLMConfig,
  renderRouterEnv,
} from '../server/router-render.mjs';

const SENTINEL = 'sk-test-UPSTREAM-SENTINEL-9f3a';

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    mode: 'builtin',
    engine: 'bifrost',
    bind: 'internal',
    port: 8080,
    contentLogging: false,
    allowPrivateNetwork: false,
    upstreams: [
      { providerId: 'openrouter', weight: 2, models: ['deepseek/deepseek-chat'] },
      {
        providerId: 'local',
        weight: 1,
        models: ['llama3'],
        keyRef: { file: 'local.key' },
        type: 'custom',
        baseUrl: 'http://10.0.0.5:11434/v1',
        allowPrivateNetwork: true,
      },
    ],
    fallbacks: [{ model: 'deepseek/deepseek-chat', then: ['local/llama3'] }],
    virtualKeys: [
      {
        role: 'setup',
        allowedModels: ['*'],
        budget: { usd: 2, reset: '1d' },
        rateLimit: { requests: 60, tokens: 200000, reset: '1h' },
        expiresAt: null,
      },
      {
        role: 'chat',
        allowedModels: ['deepseek/deepseek-chat'],
        budget: { usd: 10, reset: '1M' },
        rateLimit: { requests: 600, tokens: 2000000, reset: '1h' },
        expiresAt: null,
      },
      {
        role: 'workers',
        allowedModels: ['deepseek/deepseek-chat'],
        budget: { usd: 20, reset: '1M' },
        rateLimit: { requests: 600, tokens: 2000000, reset: '1h' },
        expiresAt: null,
      },
      {
        role: 'summarize',
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
    ...overrides,
  };
}

const keyNames = {
  upstreams: {
    openrouter: 'OPENROUTER_API_KEY',
    local: 'LOCAL_LLM_KEY',
  },
};

test('bifrost config is file-only, file-managed and references keys only through env', () => {
  const config = renderBifrostConfig(baseConfig(), keyNames);

  assert.equal(config.config_store.enabled, false);
  assert.equal(config.encryption_key, 'env.BIFROST_ENCRYPTION_KEY');
  assert.equal(config.management.enabled, true);
  assert.equal(config.management.auth.enabled, true);
  assert.match(String(config.management.auth.token), /^env\.[A-Z0-9_]+$/);
  assert.equal(config.logging.enabled, false);
  assert.equal(config.logging.content_logging, false);
  assert.equal(config.drop_excess_requests, true);

  assert.equal(config.providers.openrouter.weight, 2);
  assert.deepEqual(config.providers.openrouter.models, ['deepseek/deepseek-chat']);
  assert.equal(config.providers.openrouter.keys[0].value, 'env.OPENROUTER_API_KEY');

  assert.equal(config.providers.local.base_provider_type, 'openai');
  assert.equal(config.providers.local.network_config.base_url, 'http://10.0.0.5:11434/v1');
  assert.equal(config.providers.local.network_config.allow_private_network, true);

  assert.equal(config.virtual_keys.length, 4);
  for (const key of config.virtual_keys) {
    assert.ok(['setup', 'chat', 'workers', 'summarize'].includes(key.id));
    assert.ok(Array.isArray(key.allowed_models));
    assert.equal(typeof key.budget.max_limit, 'number');
    assert.equal(typeof key.budget.reset_duration, 'string');
    assert.equal(typeof key.rate_limit.requests, 'number');
  }
  const workers = config.virtual_keys.find(key => key.id === 'workers');
  assert.equal(workers.budget.max_limit, 20);
  assert.equal(workers.budget.reset_duration, '1M');
  assert.equal(workers.rate_limit.tokens, 2000000);

  assert.deepEqual(config.fallbacks, [
    { model: 'deepseek/deepseek-chat', fallback_models: ['local/llama3'] },
  ]);

  assert.ok(!JSON.stringify(config).includes(SENTINEL));
  assert.ok(!JSON.stringify(config).includes('api_key'));
});

test('bifrost blocks a private-network upstream unless that provider allows it', () => {
  const blocked = renderBifrostConfig(
    baseConfig({
      upstreams: [
        {
          providerId: 'local',
          models: ['llama3'],
          type: 'custom',
          baseUrl: 'http://192.168.1.20:8000/v1',
        },
      ],
    }),
    {},
  );
  assert.equal(blocked.providers.local, undefined);

  const allowed = renderBifrostConfig(
    baseConfig({
      upstreams: [
        {
          providerId: 'local',
          models: ['llama3'],
          type: 'custom',
          baseUrl: 'http://192.168.1.20:8000/v1',
          allowPrivateNetwork: true,
        },
      ],
    }),
    {},
  );
  assert.equal(allowed.providers.local.network_config.allow_private_network, true);
  assert.equal(allowed.providers.local.network_config.base_url, 'http://192.168.1.20:8000/v1');
});

test('bifrost renders one default virtual key per role with the documented budgets', () => {
  const config = renderBifrostConfig(baseConfig({ virtualKeys: [] }), {});
  assert.equal(config.virtual_keys.length, 4);
  const byRole = Object.fromEntries(config.virtual_keys.map(key => [key.id, key]));
  assert.equal(byRole.setup.budget.max_limit, 2);
  assert.equal(byRole.setup.budget.reset_duration, '1d');
  assert.equal(byRole.chat.budget.max_limit, 10);
  assert.equal(byRole.chat.budget.reset_duration, '1M');
  assert.equal(byRole.workers.budget.max_limit, 20);
  assert.equal(byRole.workers.budget.reset_duration, '1M');
  assert.equal(byRole.summarize.budget.max_limit, 2);
  assert.equal(byRole.summarize.budget.reset_duration, '1M');
});

test('litellm render is YAML with env references only and no inline secrets', () => {
  const yaml = renderLiteLLMConfig(baseConfig(), keyNames);
  assert.equal(typeof yaml, 'string');
  assert.match(yaml, /os\.environ\/OPENROUTER_API_KEY/);
  assert.match(yaml, /os\.environ\/LOCAL_LLM_KEY/);
  assert.match(yaml, /master_key:\s*["']?os\.environ\/LITELLM_MASTER_KEY/);
  assert.match(yaml, /salt_key:\s*["']?os\.environ\/LITELLM_SALT_KEY/);
  assert.match(yaml, /disable_env_credential_login:\s*true/);
  assert.match(yaml, /model_list:/);
  assert.ok(!yaml.includes(SENTINEL));
  assert.ok(!/sk-[A-Za-z0-9_-]{8,}/.test(yaml));
  assert.ok(!yaml.includes('latest'));
});

test('router env is newline-safe KEY=VALUE and rejects injection', () => {
  const text = renderRouterEnv({
    upstreamKeys: { OPENROUTER_API_KEY: SENTINEL },
    generated: {
      BIFROST_ENCRYPTION_KEY: 'enc-value',
      BIFROST_SETUP_TOKEN: 'setup-value',
    },
  });
  assert.match(text, new RegExp(`^OPENROUTER_API_KEY=${SENTINEL}$`, 'm'));
  assert.match(text, /^BIFROST_ENCRYPTION_KEY=enc-value$/m);
  assert.match(text, /^BIFROST_SETUP_TOKEN=setup-value$/m);
  assert.ok(text.endsWith('\n'));

  assert.throws(() => renderRouterEnv({ upstreamKeys: { A_KEY: 'x\ny' } }));
  assert.throws(() => renderRouterEnv({ upstreamKeys: { A_KEY: 'x\u0000y' } }));
  assert.throws(() => renderRouterEnv({ upstreamKeys: { 'BAD NAME': 'x' } }));
  assert.throws(() => renderRouterEnv({ upstreamKeys: { A_KEY: 'x\r\ny' } }));
});
