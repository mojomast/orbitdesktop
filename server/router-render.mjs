/**
 * Pure renderers for the opt-in built-in token router.
 *
 * These functions never touch the filesystem, the network or process
 * environment. Upstream provider keys are represented only as `env.<NAME>`
 * references; the supervisor writes the actual values to a private router.env.
 *
 * `config` is either the router section of orbit-config.json or a full
 * orbit-config object (`{ components, router, roles }`). `keyNames` maps a
 * provider id to the environment variable name that holds its key. It accepts
 * either `{ upstreams: { providerId: 'NAME' } }` or a flat
 * `{ providerId: 'NAME' }` object, and a Map.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const DEFAULT_VIRTUAL_KEYS = Object.freeze([
  Object.freeze({
    role: 'setup',
    allowedModels: ['*'],
    budget: { usd: 2, reset: '1d' },
    rateLimit: { requests: 60, tokens: 200000, reset: '1h' },
    expiresAt: null,
  }),
  Object.freeze({
    role: 'chat',
    allowedModels: ['*'],
    budget: { usd: 10, reset: '1M' },
    rateLimit: { requests: 600, tokens: 2000000, reset: '1h' },
    expiresAt: null,
  }),
  Object.freeze({
    role: 'workers',
    allowedModels: ['*'],
    budget: { usd: 20, reset: '1M' },
    rateLimit: { requests: 600, tokens: 2000000, reset: '1h' },
    expiresAt: null,
  }),
  Object.freeze({
    role: 'summarize',
    allowedModels: ['*'],
    budget: { usd: 2, reset: '1M' },
    rateLimit: { requests: 300, tokens: 1000000, reset: '1h' },
    expiresAt: null,
  }),
]);

function routerSection(config) {
  if (config && typeof config === 'object' && config.router && typeof config.router === 'object') {
    return config.router;
  }
  return config && typeof config === 'object' ? config : {};
}

function envFragment(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UPSTREAM';
}

function upstreamEnvName(providerId) {
  return `ROUTER_UPSTREAM_${envFragment(providerId)}_KEY`;
}

function keyNameFor(keyNames, providerId) {
  if (keyNames instanceof Map) {
    const mapped = keyNames.get(providerId);
    if (typeof mapped === 'string' && ENV_NAME.test(mapped)) return mapped;
  } else if (keyNames && typeof keyNames === 'object') {
    const nested = keyNames.upstreams;
    if (nested && typeof nested === 'object' && typeof nested[providerId] === 'string' && ENV_NAME.test(nested[providerId])) {
      return nested[providerId];
    }
    if (typeof keyNames[providerId] === 'string' && ENV_NAME.test(keyNames[providerId])) {
      return keyNames[providerId];
    }
  }
  return upstreamEnvName(providerId);
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::1' || host === '::') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function parseBaseUrl(value, providerId) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw Error(`Router upstream ${providerId} has an invalid base URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Error(`Router upstream ${providerId} must use http or https.`);
  }
  if (url.username || url.password) {
    throw Error(`Router upstream ${providerId} must not embed credentials.`);
  }
  return url;
}

function upstreamEntries(config) {
  const list = Array.isArray(config.upstreams) ? config.upstreams : [];
  const entries = [];
  for (const upstream of list) {
    if (!upstream || typeof upstream !== 'object') continue;
    const providerId = String(upstream.providerId ?? upstream.id ?? '').trim();
    if (!PROVIDER_ID.test(providerId)) {
      throw Error('Router upstream has an invalid provider id.');
    }
    const baseUrl = typeof upstream.baseUrl === 'string' ? upstream.baseUrl.trim() : '';
    let url = null;
    if (baseUrl) url = parseBaseUrl(baseUrl, providerId);
    const privateNetwork = url ? isPrivateHost(url.hostname) : false;
    const allowPrivate = upstream.allowPrivateNetwork ?? config.allowPrivateNetwork ?? false;
    if (privateNetwork && allowPrivate !== true) continue;
    entries.push({
      providerId,
      url,
      baseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : '',
      privateNetwork,
      allowPrivate: allowPrivate === true,
      weight: Number.isFinite(upstream.weight) && upstream.weight > 0 ? upstream.weight : 1,
      models: Array.isArray(upstream.models) && upstream.models.length ? upstream.models.map(String) : ['*'],
      type: typeof upstream.type === 'string' && upstream.type ? upstream.type : (url ? 'custom' : 'openai'),
    });
  }
  return entries;
}

function virtualKeyEntries(config) {
  const configured = Array.isArray(config.virtualKeys) ? config.virtualKeys : [];
  const list = configured.length ? configured : DEFAULT_VIRTUAL_KEYS;
  return list.map(source => {
    const role = String(source?.role ?? '').trim();
    if (!ROLE_ID.test(role)) throw Error('Router virtual key has an invalid role.');
    const entry = {
      id: role,
      name: role,
      allowed_models: Array.isArray(source.allowedModels) && source.allowedModels.length
        ? source.allowedModels.map(String)
        : ['*'],
      expires_at: source.expiresAt ?? null,
    };
    if (source.budget && typeof source.budget === 'object') {
      const usd = Number(source.budget.usd);
      if (Number.isFinite(usd) && usd >= 0) {
        entry.budget = { max_limit: usd, reset_duration: String(source.budget.reset ?? '1M') };
      }
    }
    if (source.rateLimit && typeof source.rateLimit === 'object') {
      const rate = {};
      for (const field of ['requests', 'tokens']) {
        const value = Number(source.rateLimit[field]);
        if (Number.isFinite(value) && value >= 0) rate[field] = value;
      }
      if (Object.keys(rate).length) {
        rate.reset_duration = String(source.rateLimit.reset ?? '1h');
        entry.rate_limit = rate;
      }
    }
    return entry;
  });
}

function fallbackEntries(config) {
  const list = Array.isArray(config.fallbacks) ? config.fallbacks : [];
  return list
    .filter(fallback => fallback && typeof fallback === 'object' && typeof fallback.model === 'string' && fallback.model.trim())
    .map(fallback => ({
      model: fallback.model.trim(),
      fallback_models: Array.isArray(fallback.then) ? fallback.then.map(String) : [],
    }));
}

/** Bifrost file-only config: no config store, env-referenced keys, VKs per role. */
export function renderBifrostConfig(config = {}, keyNames = {}) {
  const router = routerSection(config);
  const providers = {};
  for (const upstream of upstreamEntries(router)) {
    const envName = keyNameFor(keyNames, upstream.providerId);
    const entry = {
      type: upstream.type,
      weight: upstream.weight,
      keys: [{ name: `${upstream.providerId}-primary`, value: `env.${envName}` }],
      models: upstream.models.slice(),
    };
    if (upstream.baseUrl) {
      entry.base_provider_type = 'openai';
      entry.network_config = {
        base_url: upstream.baseUrl,
        allow_private_network: upstream.allowPrivate === true,
      };
    } else if (upstream.allowPrivate) {
      entry.network_config = { allow_private_network: true };
    }
    providers[upstream.providerId] = entry;
  }

  return {
    config_store: { enabled: false },
    encryption_key: 'env.BIFROST_ENCRYPTION_KEY',
    management: {
      enabled: true,
      auth: { enabled: true, token: 'env.BIFROST_SETUP_TOKEN' },
      ui: { enabled: false },
    },
    logging: {
      enabled: false,
      content_logging: router.contentLogging === true,
    },
    drop_excess_requests: true,
    providers,
    virtual_keys: virtualKeyEntries(router),
    fallbacks: fallbackEntries(router),
  };
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

/** LiteLLM proxy YAML: environment references only, never inline key values. */
export function renderLiteLLMConfig(config = {}, keyNames = {}) {
  const router = routerSection(config);
  const lines = [
    '# Generated by Orbit for the opt-in built-in token router.',
    '# Every credential is read from the environment; no key value is stored here.',
    'model_list:',
  ];
  const upstreams = upstreamEntries(router);
  for (const upstream of upstreams) {
    const envName = keyNameFor(keyNames, upstream.providerId);
    for (const model of upstream.models) {
      const qualified = model === '*' ? `${upstream.providerId}/*` : `${upstream.providerId}/${model}`;
      lines.push(`  - model_name: ${yamlString(model === '*' ? qualified : model)}`);
      lines.push('    litellm_params:');
      lines.push(`      model: ${yamlString(qualified)}`);
      lines.push(`      api_key: ${yamlString(`os.environ/${envName}`)}`);
      if (upstream.baseUrl) lines.push(`      api_base: ${yamlString(upstream.baseUrl)}`);
    }
  }
  lines.push('general_settings:');
  lines.push(`  master_key: ${yamlString('os.environ/LITELLM_MASTER_KEY')}`);
  lines.push(`  salt_key: ${yamlString('os.environ/LITELLM_SALT_KEY')}`);
  lines.push('  disable_env_credential_login: true');
  const fallbacks = fallbackEntries(router);
  if (fallbacks.length) {
    lines.push('router_settings:');
    lines.push('  fallbacks:');
    for (const fallback of fallbacks) {
      lines.push(`    - ${JSON.stringify([fallback.model, ...fallback.fallback_models])}`);
    }
  }
  lines.push('litellm_settings:');
  lines.push('  drop_params: true');
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the private router.env. Values must be single-line; an invalid name or
 * a newline/NUL in a value fails closed instead of injecting an env entry.
 */
export function renderRouterEnv({ upstreamKeys = {}, generated = {} } = {}) {
  const values = new Map();
  for (const source of [generated, upstreamKeys]) {
    if (!source || typeof source !== 'object') continue;
    for (const [name, rawValue] of Object.entries(source)) {
      const key = String(name);
      if (!ENV_NAME.test(key)) throw Error('Invalid router environment variable name.');
      const value = String(rawValue ?? '');
      if (value.includes('\n') || value.includes('\r') || value.includes('\0')) {
        throw Error('Invalid router environment variable value.');
      }
      values.set(key, value);
    }
  }
  const names = [...values.keys()].sort();
  return names.length ? `${names.map(name => `${name}=${values.get(name)}`).join('\n')}\n` : '';
}
