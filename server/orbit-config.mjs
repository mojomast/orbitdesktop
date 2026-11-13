import defaultFs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Orbit's single owner-facing configuration document.
 *
 * This module is deliberately self-contained: other slices (onboarding, the
 * router supervisor and the agent registry) read it through this API instead of
 * inventing their own files. Secrets never enter orbit-config.json. Provider
 * keys live in <runtime>/keys/<name>.key (0600, directory 0700) and the
 * document only ever carries a keyRef. API-facing callers use view(), which
 * masks the value; only server-side code may call resolveKey().
 */

export const ORBIT_CONFIG_SCHEMA_VERSION = 1;

export const ROUTER_IMAGES = Object.freeze({
  bifrost: 'maximhq/bifrost:v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8',
  litellm: 'litellm/litellm:v1.108.6-lts@sha256:c64fe10f82a1f77906f88574f954317c50f67c617e0c97b70ac8fc61b74d3ec3',
});

export const DEFAULT_ROLE_BUDGETS = Object.freeze({
  setup: Object.freeze({ usd: 2, reset: '1d' }),
  chat: Object.freeze({ usd: 10, reset: '1mo' }),
  workers: Object.freeze({ usd: 20, reset: '1mo' }),
  summarize: Object.freeze({ usd: 2, reset: '1mo' }),
});

export const MINIMAL_ROLES = Object.freeze(['setup', 'chat', 'workers', 'summarize']);
const SETUP_MODES = Object.freeze(['minimal', 'custom']);
const ROUTER_ROLES = Object.freeze(['setup', 'chat', 'workers', 'summarize', 'compaction', 'vision']);
const REQUIRED_ROLES = Object.freeze(['setup', 'chat', 'workers', 'summarize']);
const COMPONENTS = Object.freeze(['core', 'pi', 'opencode', 'hermes', 'bundlebees', 'workerPairing', 'colab', 'router']);
const PROVIDER_KINDS = Object.freeze(['opencode-free', 'openai-compatible', 'openrouter', 'anthropic', 'pi', 'router']);
const INSTALL_STATES = Object.freeze(['pending', 'installed', 'failed', 'skipped']);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,96}\.key$/;
const TOP_LEVEL = new Set(['schemaVersion', 'mode', 'defaultModel', 'providerMode', 'components', 'providers', 'roles', 'router', 'appliedAt', 'installState']);
const PROVIDER_FIELDS = new Set(['id', 'kind', 'label', 'baseUrl', 'keyRef', 'privacyNote', 'routerType']);
const ROLE_FIELDS = new Set(['provider', 'model']);
const ROUTER_FIELDS = new Set(['enabled', 'mode', 'engine', 'image', 'bind', 'port', 'contentLogging', 'allowPrivateNetwork', 'upstreams', 'fallbacks', 'virtualKeys', 'external']);
const EXTERNAL_FIELDS = new Set(['baseUrl', 'keyRef']);
const UPSTREAM_FIELDS = new Set(['providerId', 'weight', 'models']);
const FALLBACK_FIELDS = new Set(['model', 'then']);
const VIRTUAL_KEY_FIELDS = new Set(['role', 'keyRef', 'allowedModels', 'budget', 'rateLimit', 'expiresAt']);
const BUDGET_FIELDS = new Set(['usd', 'reset']);
const RATE_LIMIT_FIELDS = new Set(['requests', 'tokens', 'reset']);

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(detail) {
  // Field paths and fixed reasons only; never a value, so a pasted secret cannot
  // be echoed back through a validation error.
  const error = new Error(`Invalid Orbit configuration: ${detail}`);
  error.status = 400;
  return error;
}

function rejectUnknown(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw invalid(`${where} contains an unknown field.`);
  }
}

function isIsoDate(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return true;
}

function defaultVirtualKeys() {
  return ROUTER_ROLES.filter(role => Object.hasOwn(DEFAULT_ROLE_BUDGETS, role)).map(role => ({
    role,
    keyRef: { file: `router-vk-${role}.key` },
    allowedModels: ['*'],
    budget: { ...DEFAULT_ROLE_BUDGETS[role] },
    rateLimit: { requests: 600, tokens: 2_000_000, reset: '1h' },
    expiresAt: null,
  }));
}

export function defaultOrbitConfig() {
  return {
    schemaVersion: ORBIT_CONFIG_SCHEMA_VERSION,
    providerMode: 'direct',
    components: {
      core: true,
      pi: false,
      opencode: false,
      hermes: false,
      bundlebees: false,
      workerPairing: false,
      colab: false,
      apps: [],
      router: false,
    },
    providers: [],
    roles: {
      setup: { provider: '', model: '' },
      chat: { provider: '', model: '' },
      workers: { provider: '', model: '' },
      summarize: { provider: '', model: '' },
    },
    router: {
      enabled: false,
      mode: 'builtin',
      engine: 'bifrost',
      image: ROUTER_IMAGES.bifrost,
      bind: 'internal',
      port: 8080,
      contentLogging: false,
      allowPrivateNetwork: false,
      upstreams: [],
      fallbacks: [],
      virtualKeys: defaultVirtualKeys(),
      external: { baseUrl: '', keyRef: { file: 'external-router.key' } },
    },
  };
}

function normalizeKeyRef(value, where, { fileOnly = false } = {}) {
  if (!isPlainObject(value)) throw invalid(`${where} must be an object.`);
  const keys = Object.keys(value);
  if (keys.length !== 1) throw invalid(`${where} must contain exactly one of file or env.`);
  if (keys[0] === 'file') {
    if (typeof value.file !== 'string' || !KEY_FILE_PATTERN.test(value.file)) throw invalid(`${where}.file is not a safe key file name.`);
    return { file: value.file };
  }
  if (keys[0] === 'env' && !fileOnly) {
    if (typeof value.env !== 'string' || !ENV_PATTERN.test(value.env)) throw invalid(`${where}.env is not an environment variable name.`);
    return { env: value.env };
  }
  throw invalid(`${where} must reference a key file${fileOnly ? '' : ' or environment variable'}.`);
}

function normalizeComponents(value) {
  const base = defaultOrbitConfig().components;
  if (value === undefined) return base;
  if (!isPlainObject(value)) throw invalid('components must be an object.');
  rejectUnknown(value, new Set([...COMPONENTS, 'apps']), 'components');
  const result = { ...base };
  for (const key of COMPONENTS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') throw invalid(`components.${key} must be a boolean.`);
    result[key] = value[key];
  }
  if (result.core !== true) throw invalid('components.core is required.');
  if (value.apps !== undefined) {
    if (!Array.isArray(value.apps) || value.apps.length > 128) throw invalid('components.apps must be an array.');
    result.apps = value.apps.map((id, index) => {
      if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw invalid(`components.apps[${index}] is not a valid app id.`);
      return id;
    });
  }
  return result;
}

function normalizeProvider(value, index) {
  const where = `providers[${index}]`;
  if (!isPlainObject(value)) throw invalid(`${where} must be an object.`);
  rejectUnknown(value, PROVIDER_FIELDS, where);
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) throw invalid(`${where}.id is not a valid provider id.`);
  if (!PROVIDER_KINDS.includes(value.kind)) throw invalid(`${where}.kind is not a supported provider kind.`);
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80) throw invalid(`${where}.label must be a short non-empty string.`);
  const result = { id: value.id, kind: value.kind, label: value.label.trim() };
  if (value.baseUrl !== undefined) {
    if (!isHttpUrl(value.baseUrl)) throw invalid(`${where}.baseUrl must be an http or https URL without credentials, query or fragment.`);
    result.baseUrl = value.baseUrl.trim();
  }
  if (value.keyRef !== undefined) result.keyRef = normalizeKeyRef(value.keyRef, `${where}.keyRef`);
  if (value.privacyNote !== undefined) {
    if (typeof value.privacyNote !== 'string' || value.privacyNote.length > 500) throw invalid(`${where}.privacyNote must be a short string.`);
    result.privacyNote = value.privacyNote;
  }
  if (value.kind === 'router') {
    if (!result.baseUrl) throw invalid(`${where}.baseUrl is required for a router provider.`);
    if (value.routerType !== 'hosted' && value.routerType !== 'self-hosted') throw invalid(`${where}.routerType must be hosted or self-hosted.`);
    result.routerType = value.routerType;
  } else {
    if (value.routerType !== undefined) throw invalid(`${where}.routerType is only valid for a router provider.`);
  }
  return result;
}

function normalizeStringList(value, where, max = 64) {
  if (!Array.isArray(value) || value.length > max) throw invalid(`${where} must be an array of at most ${max} strings.`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim() || item.length > 200) throw invalid(`${where}[${index}] is not a short non-empty string.`);
    return item.trim();
  });
}

function normalizeRouter(value) {
  const base = defaultOrbitConfig().router;
  if (value === undefined) return base;
  if (!isPlainObject(value)) throw invalid('router must be an object.');
  rejectUnknown(value, ROUTER_FIELDS, 'router');
  const result = clone(base);
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') throw invalid('router.enabled must be a boolean.');
    result.enabled = value.enabled;
  }
  if (value.mode !== undefined) {
    if (value.mode !== 'builtin' && value.mode !== 'external') throw invalid('router.mode must be builtin or external.');
    result.mode = value.mode;
  }
  if (value.engine !== undefined) {
    if (value.engine !== 'bifrost' && value.engine !== 'litellm') throw invalid('router.engine must be bifrost or litellm.');
    result.engine = value.engine;
    if (value.image === undefined) result.image = ROUTER_IMAGES[value.engine];
  }
  if (value.image !== undefined) {
    if (typeof value.image !== 'string' || !value.image.trim() || value.image.length > 300) throw invalid('router.image must be a pinned image reference.');
    if (/(^|[:/])latest(@|$)/i.test(value.image)) throw invalid('router.image must never use the latest tag.');
    result.image = value.image.trim();
  }
  if (value.bind !== undefined) {
    if (value.bind !== 'internal' && value.bind !== 'loopback') throw invalid('router.bind must be internal or loopback.');
    result.bind = value.bind;
  }
  if (value.port !== undefined) {
    if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) throw invalid('router.port must be an integer port.');
    result.port = value.port;
  }
  for (const key of ['contentLogging', 'allowPrivateNetwork']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') throw invalid(`router.${key} must be a boolean.`);
    result[key] = value[key];
  }
  if (value.upstreams !== undefined) {
    if (!Array.isArray(value.upstreams) || value.upstreams.length > 64) throw invalid('router.upstreams must be an array.');
    result.upstreams = value.upstreams.map((entry, index) => {
      const where = `router.upstreams[${index}]`;
      if (!isPlainObject(entry)) throw invalid(`${where} must be an object.`);
      rejectUnknown(entry, UPSTREAM_FIELDS, where);
      if (typeof entry.providerId !== 'string' || !ID_PATTERN.test(entry.providerId)) throw invalid(`${where}.providerId is not a valid provider id.`);
      if (typeof entry.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight < 0) throw invalid(`${where}.weight must be a non-negative number.`);
      return {
        providerId: entry.providerId,
        weight: entry.weight,
        models: entry.models === undefined ? ['*'] : normalizeStringList(entry.models, `${where}.models`),
      };
    });
  }
  if (value.fallbacks !== undefined) {
    if (!Array.isArray(value.fallbacks) || value.fallbacks.length > 64) throw invalid('router.fallbacks must be an array.');
    result.fallbacks = value.fallbacks.map((entry, index) => {
      const where = `router.fallbacks[${index}]`;
      if (!isPlainObject(entry)) throw invalid(`${where} must be an object.`);
      rejectUnknown(entry, FALLBACK_FIELDS, where);
      if (typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 200) throw invalid(`${where}.model must be a short non-empty string.`);
      return { model: entry.model.trim(), then: normalizeStringList(entry.then ?? [], `${where}.then`) };
    });
  }
  if (value.virtualKeys !== undefined) {
    if (!Array.isArray(value.virtualKeys) || value.virtualKeys.length > 32) throw invalid('router.virtualKeys must be an array.');
    result.virtualKeys = value.virtualKeys.map((entry, index) => {
      const where = `router.virtualKeys[${index}]`;
      if (!isPlainObject(entry)) throw invalid(`${where} must be an object.`);
      rejectUnknown(entry, VIRTUAL_KEY_FIELDS, where);
      if (typeof entry.role !== 'string' || !ID_PATTERN.test(entry.role)) throw invalid(`${where}.role is not a valid role id.`);
      const keyRef = normalizeKeyRef(entry.keyRef, `${where}.keyRef`, { fileOnly: true });
      const allowedModels = entry.allowedModels === undefined ? ['*'] : normalizeStringList(entry.allowedModels, `${where}.allowedModels`);
      const budgetValue = entry.budget ?? DEFAULT_ROLE_BUDGETS[entry.role] ?? { usd: 0, reset: '1mo' };
      if (!isPlainObject(budgetValue)) throw invalid(`${where}.budget must be an object.`);
      rejectUnknown(budgetValue, BUDGET_FIELDS, `${where}.budget`);
      if (typeof budgetValue.usd !== 'number' || !Number.isFinite(budgetValue.usd) || budgetValue.usd < 0) throw invalid(`${where}.budget.usd must be a non-negative number.`);
      if (typeof budgetValue.reset !== 'string' || !/^\d+(m|h|d|w|mo)$/.test(budgetValue.reset)) throw invalid(`${where}.budget.reset is not a supported interval.`);
      const limitValue = entry.rateLimit ?? { requests: 600, tokens: 2_000_000, reset: '1h' };
      if (!isPlainObject(limitValue)) throw invalid(`${where}.rateLimit must be an object.`);
      rejectUnknown(limitValue, RATE_LIMIT_FIELDS, `${where}.rateLimit`);
      for (const key of ['requests', 'tokens']) {
        if (limitValue[key] !== undefined && (!Number.isInteger(limitValue[key]) || limitValue[key] < 0)) throw invalid(`${where}.rateLimit.${key} must be a non-negative integer.`);
      }
      if (typeof limitValue.reset !== 'string' || !/^\d+(m|h|d|w|mo)$/.test(limitValue.reset)) throw invalid(`${where}.rateLimit.reset is not a supported interval.`);
      if (entry.expiresAt !== null && entry.expiresAt !== undefined && !isIsoDate(entry.expiresAt)) throw invalid(`${where}.expiresAt must be null or an ISO date.`);
      return {
        role: entry.role,
        keyRef,
        allowedModels,
        budget: { usd: budgetValue.usd, reset: budgetValue.reset },
        rateLimit: {
          requests: limitValue.requests ?? 600,
          tokens: limitValue.tokens ?? 2_000_000,
          reset: limitValue.reset,
        },
        expiresAt: entry.expiresAt ?? null,
      };
    });
  }
  if (value.external !== undefined) {
    const external = value.external;
    if (!isPlainObject(external)) throw invalid('router.external must be an object.');
    rejectUnknown(external, EXTERNAL_FIELDS, 'router.external');
    const next = { ...result.external };
    if (external.baseUrl !== undefined) {
      if (typeof external.baseUrl !== 'string' || (external.baseUrl && !isHttpUrl(external.baseUrl))) throw invalid('router.external.baseUrl must be an http or https URL.');
      next.baseUrl = external.baseUrl.trim();
    }
    if (external.keyRef !== undefined) next.keyRef = normalizeKeyRef(external.keyRef, 'router.external.keyRef', { fileOnly: true });
    result.external = next;
  }
  if (result.enabled && result.mode === 'external' && !result.external.baseUrl) throw invalid('router.external.baseUrl is required when the external router is enabled.');
  return result;
}

function normalizeRoles(value) {
  const base = defaultOrbitConfig().roles;
  if (value === undefined) return base;
  if (!isPlainObject(value)) throw invalid('roles must be an object.');
  const allowed = new Set([...REQUIRED_ROLES, 'compaction', 'vision']);
  rejectUnknown(value, allowed, 'roles');
  const result = clone(base);
  for (const role of allowed) {
    if (value[role] === undefined) continue;
    const entry = value[role];
    if (!isPlainObject(entry)) throw invalid(`roles.${role} must be an object.`);
    rejectUnknown(entry, ROLE_FIELDS, `roles.${role}`);
    if (typeof entry.provider !== 'string' || (entry.provider && !ID_PATTERN.test(entry.provider))) throw invalid(`roles.${role}.provider is not a valid provider id.`);
    if (typeof entry.model !== 'string' || entry.model.length > 200) throw invalid(`roles.${role}.model must be a short string.`);
    result[role] = { provider: entry.provider, model: entry.model };
  }
  return result;
}

/**
 * Validate and return a normalized copy. This intentionally implements the
 * documented JSON Schema subset (types, required fields, enums, patterns and a
 * closed top-level object) plus the cross-field router/role rules. It is also
 * the module that writes the document, so a caller cannot bypass it.
 */
export function validateOrbitConfig(value) {
  if (!isPlainObject(value)) throw invalid('the document must be an object.');
  rejectUnknown(value, TOP_LEVEL, 'the document');
  if (value.schemaVersion !== ORBIT_CONFIG_SCHEMA_VERSION) throw invalid(`schemaVersion must be ${ORBIT_CONFIG_SCHEMA_VERSION}.`);
  if (value.components === undefined) throw invalid('components is required.');
  const components = normalizeComponents(value.components);
  const providers = value.providers === undefined ? [] : value.providers;
  if (!Array.isArray(providers) || providers.length > 64) throw invalid('providers must be an array of at most 64 entries.');
  const normalizedProviders = providers.map(normalizeProvider);
  const seen = new Set();
  for (const provider of normalizedProviders) {
    if (seen.has(provider.id)) throw invalid('Provider ids must be unique.');
    seen.add(provider.id);
  }
  const router = normalizeRouter(value.router);
  if (components.router !== router.enabled) throw invalid('components.router and router.enabled must agree.');
  if (value.providerMode !== undefined && value.providerMode !== 'direct' && value.providerMode !== 'router') throw invalid('providerMode must be direct or router.');
  const roles = normalizeRoles(value.roles);
  const installState = value.installState === undefined ? undefined : value.installState;
  if (installState !== undefined) {
    if (!isPlainObject(installState)) throw invalid('installState must be an object.');
    for (const [key, state] of Object.entries(installState)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(key) || !INSTALL_STATES.includes(state)) throw invalid('installState has an invalid component or state.');
    }
  }
  if (value.appliedAt !== undefined && !isIsoDate(value.appliedAt)) throw invalid('appliedAt must be an ISO date.');

  let routerProviders = normalizedProviders.filter(provider => provider.kind === 'router');
  if (router.enabled) {
    if (routerProviders.length > 1) throw invalid('Only one provider of kind router is allowed; exactly one active router is required.');
    if (routerProviders.length === 1 && routerProviders[0].id !== 'router') throw invalid('The token router provider must have id router.');
    if (routerProviders.length === 0) {
      const baseUrl = router.mode === 'external'
        ? router.external.baseUrl
        : `http://${router.bind === 'loopback' ? '127.0.0.1' : 'router'}:${router.port}/v1`;
      const created = normalizeProvider({
        id: 'router',
        kind: 'router',
        label: 'Token router',
        baseUrl,
        routerType: router.mode === 'external' && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(baseUrl) ? 'hosted' : 'self-hosted',
      }, normalizedProviders.length);
      normalizedProviders.push(created);
      if (normalizedProviders.length > 64) throw invalid('providers must be an array of at most 64 entries.');
      routerProviders = [created];
    } else if (router.mode === 'builtin') {
      const provider = routerProviders[0];
      provider.baseUrl = `http://${router.bind === 'loopback' ? '127.0.0.1' : 'router'}:${router.port}/v1`;
    } else if (router.mode === 'external') {
      routerProviders[0].baseUrl = router.external.baseUrl;
    }
  } else if (routerProviders.length > 1) {
    throw invalid('Only one provider of kind router is allowed; exactly one active router is required.');
  }

  const providerIds = new Set(normalizedProviders.map(provider => provider.id));
  if (value.mode !== undefined && !SETUP_MODES.includes(value.mode)) throw invalid('mode must be minimal or custom.');
  let defaultModel;
  if (value.defaultModel !== undefined) {
    const entry = value.defaultModel;
    if (!isPlainObject(entry)) throw invalid('defaultModel must be an object.');
    rejectUnknown(entry, ROLE_FIELDS, 'defaultModel');
    if (typeof entry.provider !== 'string' || !ID_PATTERN.test(entry.provider)) throw invalid('defaultModel.provider is not a valid provider id.');
    if (typeof entry.model !== 'string' || !entry.model.trim() || entry.model.length > 200) throw invalid('defaultModel.model must be a non-empty short string.');
    if (!providerIds.has(entry.provider)) throw invalid('defaultModel.provider does not reference a configured provider.');
    defaultModel = { provider: entry.provider, model: entry.model };
  }
  if (value.mode === 'minimal') {
    if (!defaultModel) throw invalid('Minimal install requires defaultModel (one provider and one model for every role).');
    if (router.enabled && router.mode !== 'external') throw invalid('Minimal install never runs the built-in router; choose Custom to install it.');
  }
  for (const role of Object.keys(roles)) {
    const entry = roles[role];
    if (entry.provider && !providerIds.has(entry.provider)) throw invalid(`roles.${role}.provider does not reference a configured provider.`);
  }
  // Stored but inactive router providers still need valid upstream references.
  for (const [index, upstream] of router.upstreams.entries()) {
    if (upstream.providerId === 'router') throw invalid(`router.upstreams[${index}] cannot reference the router itself.`);
    if (!providerIds.has(upstream.providerId)) throw invalid(`router.upstreams[${index}] references an unknown provider.`);
    if (normalizedProviders.find(provider => provider.id === upstream.providerId)?.kind === 'opencode-free') {
      throw invalid(`router.upstreams[${index}] cannot route OpenCode free models.`);
    }
  }

  const result = {
    schemaVersion: ORBIT_CONFIG_SCHEMA_VERSION,
    ...(value.mode !== undefined ? { mode: value.mode } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    providerMode: router.enabled ? 'router' : 'direct',
    components,
    providers: normalizedProviders,
    roles,
    router,
  };
  if (installState !== undefined) result.installState = installState;
  if (value.appliedAt !== undefined) result.appliedAt = value.appliedAt;
  return result;
}

/**
 * Effective { provider, model } for every role. A role with its own provider
 * and model wins; an empty role inherits defaultModel when one is set (always
 * in minimal mode). The four core roles are always returned; compaction and
 * vision only when present in roles. Custom configs without defaultModel
 * resolve exactly as stored.
 */
export function resolveRoles(config) {
  const roles = config?.roles ?? {};
  const fallback = config?.defaultModel?.provider && config?.defaultModel?.model ? config.defaultModel : null;
  const result = {};
  for (const role of [...MINIMAL_ROLES, 'compaction', 'vision']) {
    const entry = roles[role];
    if (entry === undefined && !MINIMAL_ROLES.includes(role)) continue;
    if (entry?.provider && entry?.model) result[role] = { provider: entry.provider, model: entry.model };
    else if (fallback) result[role] = { provider: fallback.provider, model: fallback.model };
    else result[role] = { provider: entry?.provider ?? '', model: entry?.model ?? '' };
  }
  return result;
}

const MINIMAL_AGENT_COMPONENT = Object.freeze({ 'opencode-free': 'opencode', pi: 'pi' });

/**
 * One-click Minimal install: one provider (direct, or an external router) and
 * one model shared by every role. Components are core plus at most the one
 * first-agent adapter that matches the provider; never the built-in router,
 * bundlebees, worker pairing, Colab or optional apps.
 */
export function buildMinimalConfig({ provider, model, keyRef } = {}) {
  if (!isPlainObject(provider)) throw invalid('Minimal install needs one provider.');
  if (typeof model !== 'string' || !model.trim()) throw invalid('Minimal install needs one model.');
  const base = defaultOrbitConfig();
  const entry = { ...provider };
  if (keyRef !== undefined) entry.keyRef = keyRef;
  const doc = {
    ...base,
    mode: 'minimal',
    defaultModel: { provider: entry.id, model: model.trim() },
    providers: [entry],
  };
  const component = MINIMAL_AGENT_COMPONENT[entry.kind];
  if (component) doc.components = { ...doc.components, [component]: true };
  if (entry.kind === 'router') {
    const external = { baseUrl: entry.baseUrl ?? '', keyRef: entry.keyRef?.file ? { file: entry.keyRef.file } : { file: 'external-router.key' } };
    doc.components = { ...doc.components, router: true };
    doc.router = { ...doc.router, enabled: true, mode: 'external', external };
  }
  return validateOrbitConfig(doc);
}

/** Leave minimal mode, writing the effective roles out so nothing changes. */
export function switchToCustom(config) {
  const roles = resolveRoles(config);
  const next = { ...clone(config), mode: 'custom', roles };
  return validateOrbitConfig(next);
}

function maskKey(value) {
  if (typeof value !== 'string' || !value) return null;
  if (value.length < 8) return 'set';
  const tail = value.slice(-4);
  return `${value.startsWith('sk-') ? 'sk-' : ''}…${tail}`;
}

function safeKeyFile(name) {
  return typeof name === 'string' && KEY_FILE_PATTERN.test(name) && !name.includes('/') && !name.includes('\\') && name !== '..';
}

export function createOrbitConfig({ runtimeDir, env = process.env, fs = defaultFs } = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir.trim()) throw Error('Orbit configuration needs a runtime directory.');
  const runtime = path.resolve(runtimeDir);
  const override = env?.ORBIT_CONFIG_FILE;
  if (override !== undefined) {
    if (typeof override !== 'string' || !path.isAbsolute(override)) throw Error('ORBIT_CONFIG_FILE must be an absolute path.');
  }
  const configFile = override ? path.resolve(override) : path.join(runtime, 'orbit-config.json');
  const keysDir = path.join(runtime, 'keys');
  const environment = env ?? {};

  function ensureDirectory(directory, mode, chmodExisting = true) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Orbit runtime path is not a private directory.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(directory, { recursive: true, mode });
    }
    if (chmodExisting) {
      try { fs.chmodSync(directory, mode); } catch { /* Existing mounts may refuse chmod; file modes still apply. */ }
    }
  }

  function atomicWrite(file, text, parentMode = 0o700) {
    ensureDirectory(path.dirname(file), parentMode, false);
    const temporary = path.join(path.dirname(file), `.orbit-write-${process.pid}-${randomUUID()}`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try { fs.chmodSync(temporary, 0o600); } catch { /* mode was set at open */ }
      fs.renameSync(temporary, file);
      try { fs.chmodSync(file, 0o600); } catch { /* mode was set at open */ }
      try {
        const directoryFd = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch { /* Directory fsync is unavailable on some platforms. */ }
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }

  function readDocument() {
    let text;
    try {
      const stat = fs.lstatSync(configFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw invalid('the configuration file is not a private regular file.');
      text = fs.readFileSync(configFile, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return defaultOrbitConfig();
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid('the configuration file is not valid JSON.');
    }
    return validateOrbitConfig(parsed);
  }

  function load() {
    return readDocument();
  }

  function save(next) {
    const normalized = validateOrbitConfig(next);
    atomicWrite(configFile, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  function effectiveKeyRef(provider, config) {
    if (provider?.keyRef) return provider.keyRef;
    if (provider?.kind === 'router' && config?.router?.enabled && config.router.mode === 'external') {
      return config.router.external?.keyRef ?? null;
    }
    return null;
  }

  function readKeyValue(provider, config) {
    const keyRef = effectiveKeyRef(provider, config);
    if (!keyRef) return null;
    if (keyRef.env) {
      const value = environment[keyRef.env];
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    }
    if (!safeKeyFile(keyRef.file)) return null;
    const file = path.join(keysDir, keyRef.file);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) return null;
      const text = fs.readFileSync(file, 'utf8').trim();
      return text || null;
    } catch {
      return null;
    }
  }

  function keyView(provider, config) {
    const value = readKeyValue(provider, config);
    return value ? { set: true, masked: maskKey(value) } : { set: false, masked: null };
  }

  function view() {
    const config = load();
    return {
      ...config,
      providers: config.providers.map(provider => ({ ...provider, key: keyView(provider, config) })),
    };
  }

  function providerById(config, providerId) {
    return config.providers.find(provider => provider.id === providerId) ?? null;
  }

  function setKey(providerId, value) {
    if (typeof providerId !== 'string' || !ID_PATTERN.test(providerId)) throw Error('Unknown provider.');
    if (typeof value !== 'string' || !value || value.length > 16_384 || value.includes('\u0000')) throw Error('A non-empty API key is required.');
    const config = load();
    const provider = providerById(config, providerId);
    if (!provider) throw Error('Unknown provider.');
    ensureDirectory(runtime, 0o700);
    ensureDirectory(keysDir, 0o700);
    let file = `${providerId}.key`;
    if (provider.kind === 'router' && config.router.enabled && config.router.mode === 'external') {
      file = config.router.external?.keyRef?.file ?? 'external-router.key';
      config.router.external = { ...config.router.external, keyRef: { file } };
    }
    const keyFile = path.join(keysDir, file);
    atomicWrite(keyFile, value);
    provider.keyRef = { file };
    try {
      save(config);
    } catch (error) {
      try { fs.rmSync(keyFile, { force: true }); } catch { /* best effort */ }
      throw error;
    }
    return { id: providerId, key: { set: true, masked: maskKey(value) } };
  }

  function clearKey(providerId) {
    if (typeof providerId !== 'string' || !ID_PATTERN.test(providerId)) throw Error('Unknown provider.');
    const config = load();
    const provider = providerById(config, providerId);
    if (!provider) throw Error('Unknown provider.');
    const files = new Set();
    if (provider.keyRef?.file && safeKeyFile(provider.keyRef.file)) files.add(provider.keyRef.file);
    if (provider.kind === 'router' && config.router.mode === 'external' && safeKeyFile(config.router.external?.keyRef?.file)) {
      files.add(config.router.external.keyRef.file);
    }
    for (const file of files) {
      try { fs.rmSync(path.join(keysDir, file), { force: true }); } catch { /* key already gone */ }
    }
    delete provider.keyRef;
    save(config);
    return { id: providerId, key: { set: false, masked: null } };
  }

  function resolveKey(providerId) {
    if (typeof providerId !== 'string' || !ID_PATTERN.test(providerId)) return null;
    const config = readDocument();
    return readKeyValue(providerById(config, providerId), config);
  }

  function toRegistryConfig() {
    const config = load();
    const byId = new Map(config.providers.map(provider => [provider.id, provider]));
    const agents = [];
    const effective = resolveRoles(config);
    for (const role of [...REQUIRED_ROLES, 'compaction', 'vision']) {
      const mapping = effective[role];
      if (!mapping?.provider || !mapping.model) continue;
      const provider = byId.get(mapping.provider);
      if (!provider) continue;
      if (provider.kind === 'router' && !config.router.enabled) continue;
      const agent = {
        id: role,
        kind: provider.kind,
        label: provider.label,
        baseUrl: provider.baseUrl ?? '',
        model: mapping.model,
      };
      if (provider.kind === 'router' && config.router.enabled) {
        const file = config.router.mode === 'external'
          ? config.router.external?.keyRef?.file
          : (config.router.virtualKeys.find(entry => entry.role === role)?.keyRef?.file ?? `router-vk-${role}.key`);
        if (file && safeKeyFile(file)) agent.apiKeyFile = path.join(keysDir, file);
      } else if (provider.keyRef?.file && safeKeyFile(provider.keyRef.file)) {
        agent.apiKeyFile = path.join(keysDir, provider.keyRef.file);
      } else if (provider.keyRef?.env) {
        agent.apiKeyEnv = provider.keyRef.env;
      }
      agents.push(agent);
    }
    return { agents };
  }

  return {
    runtimeDir: runtime,
    configFile,
    keysDir,
    load,
    save,
    view,
    setKey,
    clearKey,
    resolveKey,
    toRegistryConfig,
    maskKey,
  };
}
