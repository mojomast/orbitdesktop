import { resolveRoles, switchToCustom } from './orbit-config.mjs';

/**
 * Owner apply/roles routes for the first-run wizard and Settings.
 *
 * The module is transport-shaped (handle(req, res, url)) so server/index.mjs can
 * mount it without this slice editing the shared entry point. Responses use the
 * masked config view from orbit-config.mjs; key values are never echoed, logged,
 * written to orbit-config.json or handed to the setup agent.
 */

const BODY_LIMIT = 65_536;
const COMPONENT_KEYS = Object.freeze(['core', 'pi', 'opencode', 'hermes', 'bundlebees', 'workerPairing', 'colab', 'router']);
const ROLE_KEYS = Object.freeze(['setup', 'chat', 'workers', 'summarize', 'compaction', 'vision']);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data ?? {}));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(statusError('Request body is too large.', 413));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return reject(statusError('Invalid JSON body.', 400));
      }
      if (!isPlainObject(parsed)) return reject(statusError('Request body must be a JSON object.', 400));
      resolve(parsed);
    });
    req.on('error', () => reject(statusError('Could not read the request body.', 400)));
  });
}

function normalisePath(raw) {
  let pathname = String(raw || '/');
  for (const prefix of ['/api/onboarding', '/onboarding']) {
    if (pathname === prefix) return '/';
    if (pathname.startsWith(`${prefix}/`)) {
      pathname = pathname.slice(prefix.length);
      break;
    }
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  return pathname.replace(/\/+$/, '') || '/';
}

function segments(pathname) {
  return pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { throw statusError('Invalid path.', 400); }
  });
}

function roleKeysFromBody(body) {
  if (isPlainObject(body.roles)) return body.roles;
  const picked = {};
  for (const role of ROLE_KEYS) {
    if (body[role] !== undefined) picked[role] = body[role];
  }
  return Object.keys(picked).length ? picked : null;
}

function normalizeRolePatch(config, roles) {
  const providers = new Map((config.providers ?? []).map(provider => [provider.id, provider]));
  const routerActive = Boolean(config.router?.enabled);
  const patch = {};
  for (const [role, raw] of Object.entries(roles)) {
    if (!ROLE_KEYS.includes(role)) throw statusError('Unknown role.', 400);
    if (!isPlainObject(raw)) throw statusError('Each role must be an object.', 400);
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!provider && !model) {
      // An empty pair clears an override so the role inherits defaultModel.
      patch[role] = { provider: '', model: '' };
      continue;
    }
    if (!provider || !model) throw statusError('A role needs both a provider and a model.', 400);
    if (model.length > 200) throw statusError('The model id is too long.', 400);
    const known = providers.get(provider);
    if (!known || (known.kind === 'router' && !routerActive)) throw statusError('Unknown provider for a role.', 400);
    patch[role] = { provider, model };
  }
  return patch;
}

function normalizeBudgets(config, value) {
  if (value === undefined) return null;
  if (!isPlainObject(value)) throw statusError('Budgets must be an object.', 400);
  const virtualKeys = (config.router?.virtualKeys ?? []).map(entry => ({ ...entry, budget: entry.budget ? { ...entry.budget } : undefined, rateLimit: entry.rateLimit ? { ...entry.rateLimit } : undefined }));
  const byRole = new Map(virtualKeys.map(entry => [entry.role, entry]));
  for (const [role, raw] of Object.entries(value)) {
    if (!ROLE_KEYS.includes(role)) throw statusError('Unknown router role.', 400);
    if (!isPlainObject(raw)) throw statusError('A role budget must be an object.', 400);
    const entry = byRole.get(role);
    if (!entry) continue;
    if (raw.usd !== undefined) {
      if (typeof raw.usd !== 'number' || !Number.isFinite(raw.usd) || raw.usd < 0) throw statusError('A budget must be a non-negative number.', 400);
      entry.budget = { ...(entry.budget ?? { reset: '1mo' }), usd: raw.usd };
    }
    if (raw.reset !== undefined) {
      if (typeof raw.reset !== 'string' || !/^\d+(m|h|d|w|mo)$/.test(raw.reset)) throw statusError('A budget reset interval is invalid.', 400);
      entry.budget = { ...(entry.budget ?? { usd: 0 }), reset: raw.reset };
    }
    if (isPlainObject(raw.rateLimit)) {
      const limit = { ...(entry.rateLimit ?? { requests: 600, tokens: 2_000_000, reset: '1h' }) };
      for (const key of ['requests', 'tokens']) {
        if (raw.rateLimit[key] !== undefined) {
          if (!Number.isInteger(raw.rateLimit[key]) || raw.rateLimit[key] < 0) throw statusError(`A rate limit ${key} value is invalid.`, 400);
          limit[key] = raw.rateLimit[key];
        }
      }
      if (raw.rateLimit.reset !== undefined) {
        if (typeof raw.rateLimit.reset !== 'string' || !/^\d+(m|h|d|w|mo)$/.test(raw.rateLimit.reset)) throw statusError('A rate limit reset interval is invalid.', 400);
        limit.reset = raw.rateLimit.reset;
      }
      entry.rateLimit = limit;
    }
  }
  return virtualKeys;
}

function stripKeyViews(document) {
  if (!isPlainObject(document) || !Array.isArray(document.providers)) return document;
  return {
    ...document,
    providers: document.providers.map(provider => {
      if (!isPlainObject(provider)) return provider;
      const { key, ...rest } = provider;
      void key;
      return rest;
    }),
  };
}

export function createOnboardingApply({ config, startSetupAgent, log = () => {}, routerSupervisor, now = () => new Date() } = {}) {
  if (!config || typeof config.load !== 'function' || typeof config.save !== 'function' || typeof config.view !== 'function') {
    throw Error('The onboarding apply routes need an Orbit configuration instance.');
  }

  function safeLog(message) {
    try { log(String(message).slice(0, 300)); } catch { /* logging must not change a request outcome */ }
  }

  function rolesPayload(current) {
    const view = config.view();
    return {
      ok: true,
      mode: current.mode ?? 'custom',
      defaultModel: current.defaultModel ?? null,
      roles: resolveRoles(current),
      stored: current.roles,
      providerMode: current.providerMode,
      providers: view.providers,
      config: view,
    };
  }

  function applyPatch(current, body) {
    let next = { ...current };
    if (isPlainObject(body.config)) {
      return config.save(stripKeyViews(body.config));
    }
    if (body.mode !== undefined) {
      if (body.mode !== 'minimal' && body.mode !== 'custom') throw statusError('mode must be minimal or custom.', 400);
      if (body.mode === 'custom' && current.mode === 'minimal') next = switchToCustom(current);
      else next = { ...next, mode: body.mode };
    }
    if (body.defaultModel !== undefined) next = { ...next, defaultModel: body.defaultModel };
    if (body.mode === 'minimal' && !next.defaultModel) throw statusError('Minimal install needs one provider and one model.', 400);
    if (isPlainObject(body.components)) {
      next = { ...next, components: { ...next.components, ...body.components } };
      if (typeof body.components.router === 'boolean') {
        next.router = { ...next.router, enabled: body.components.router };
      }
    }
    if (next.router?.enabled && next.router.mode === 'builtin' && !(next.router.upstreams?.length)) {
      next = {
        ...next,
        router: {
          ...next.router,
          upstreams: (next.providers ?? [])
            .filter(provider => !['router', 'opencode-free', 'pi'].includes(provider.kind))
            .map(provider => ({ providerId: provider.id, weight: 1, models: ['*'] })),
        },
      };
    }
    return config.save(next);
  }

  async function startRouter(current) {
    if (!current.router?.enabled) return { enabled: false, health: 'disabled' };
    if (!routerSupervisor) return { enabled: true, health: 'unknown' };
    try {
      if (typeof routerSupervisor.enable === 'function') await routerSupervisor.enable(current);
      if (typeof routerSupervisor.health === 'function') {
        const health = await routerSupervisor.health();
        if (health && health.ok === false) throw statusError('The token router did not become healthy.', 502);
      }
      if (typeof routerSupervisor.issueVirtualKeys === 'function') routerSupervisor.issueVirtualKeys();
      safeLog('Token router enabled for applied setup.');
      return { enabled: true, health: 'healthy' };
    } catch (error) {
      safeLog('Token router could not be enabled.');
      if (error?.status) throw error;
      throw statusError('The token router could not be enabled.', 502);
    }
  }

  async function apply(body = {}) {
    let current = config.load();
    if (isPlainObject(body.config) || body.mode !== undefined || body.defaultModel !== undefined || isPlainObject(body.components)) {
      current = applyPatch(current, body);
    }
    const installState = { ...(current.installState ?? {}) };
    for (const key of COMPONENT_KEYS) installState[key] = current.components[key] ? 'pending' : 'skipped';
    installState.apps = Array.isArray(current.components.apps) && current.components.apps.length ? 'pending' : 'skipped';
    current = config.save({ ...current, appliedAt: now().toISOString(), installState });
    const router = await startRouter(current);
    const resolved = resolveRoles(current);
    const view = config.view();
    // The setup agent sees masked provider status and effective roles only.
    const setupConfig = { ...view, roles: resolved };
    let setupAgent = { started: false };
    if (typeof startSetupAgent === 'function') {
      try {
        await startSetupAgent(setupConfig);
        setupAgent = { started: true };
      } catch {
        safeLog('The setup agent could not be started.');
        setupAgent = { started: false, error: 'The setup agent could not be started.' };
      }
    }
    safeLog(`Applied setup for ${current.mode === 'minimal' ? 'minimal' : 'custom'} mode.`);
    return {
      ok: true,
      applied: true,
      config: view,
      installState,
      roles: resolved,
      router,
      setupAgent,
    };
  }

  async function putRoles(body) {
    const current = config.load();
    let next = current;
    if (body.mode !== undefined || body.defaultModel !== undefined || isPlainObject(body.components)) {
      next = applyPatch(next, {
        ...(body.mode !== undefined ? { mode: body.mode } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
        ...(isPlainObject(body.components) ? { components: body.components } : {}),
      });
    }
    const roles = roleKeysFromBody(body);
    if (roles) {
      const patch = normalizeRolePatch(next, roles);
      next = config.save({ ...next, roles: { ...next.roles, ...patch } });
    }
    const budgets = normalizeBudgets(next, body.budgets);
    if (budgets) {
      next = config.save({ ...next, router: { ...next.router, virtualKeys: budgets } });
    }
    if (!roles && body.mode === undefined && body.defaultModel === undefined && body.budgets === undefined) {
      throw statusError('No role changes were supplied.', 400);
    }
    safeLog('Saved role mapping.');
    return rolesPayload(next);
  }

  async function dispatch(req, res, url) {
    const method = String(req.method || 'GET').toUpperCase();
    const parts = segments(normalisePath(url?.pathname ?? url ?? '/'));
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};
    if (parts.length === 1 && parts[0] === 'apply' && method === 'POST') {
      return json(res, 200, await apply(body));
    }
    if (parts.length === 1 && parts[0] === 'roles') {
      if (method === 'GET') return json(res, 200, rolesPayload(config.load()));
      if (method === 'PUT' || method === 'POST') return json(res, 200, await putRoles(body));
    }
    if (parts.length === 2 && parts[0] === 'router' && parts[1] === 'rotate' && method === 'POST') {
      const current = config.load();
      if (!current.router.enabled) throw statusError('The token router is not enabled.', 400);
      if (!routerSupervisor || typeof routerSupervisor.rotateKey !== 'function') throw statusError('Router key rotation is unavailable.', 400);
      const roles = typeof body.role === 'string' ? [body.role] : ['setup', 'chat', 'workers', 'summarize'];
      const rotated = [];
      for (const role of roles) {
        routerSupervisor.rotateKey(role);
        rotated.push(role);
      }
      safeLog('Rotated router virtual keys.');
      return json(res, 200, { ok: true, rotated });
    }
    if (parts.length === 0) return json(res, 405, { ok: false, error: 'Method not allowed.' });
    return json(res, 404, { ok: false, error: 'Not found.' });
  }

  async function handle(req, res, url) {
    try {
      await dispatch(req, res, url);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const message = status >= 500 ? 'Request failed.' : (typeof error?.message === 'string' ? error.message : 'Request failed.');
      json(res, status, { ok: false, error: message });
    }
  }

  return { handle, apply, getRoles: () => rolesPayload(config.load()), putRoles };
}
