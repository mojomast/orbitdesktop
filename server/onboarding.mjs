import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROUTER_IMAGES } from './orbit-config.mjs';
import { detectOpencode, OPENCODE_INSTALL_COMMAND } from './opencode-detect.mjs';

/**
 * Owner onboarding routes for the first-run wizard.
 *
 * The module is transport-shaped (handle(req, res, url)) so server/index.mjs can
 * mount it without this slice editing the shared entry point. Every response
 * that describes a provider passes through config.view(); only the model-list
 * fetch reads a key, and the key is never reflected in a response, an error or a
 * log line.
 */

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BODY_LIMIT = 65_536;
const FREE_MODELS_URL = 'https://opencode.ai/inference/v1/models';
const FREE_MODEL_PREFERENCE = Object.freeze([
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'minimax-m3.1-flash-free',
]);
const COMPONENT_KEYS = Object.freeze(['core', 'pi', 'opencode', 'hermes', 'bundlebees', 'workerPairing', 'colab', 'router']);
const MODEL_TIMEOUT_MS = 20_000;
const defaultExec = promisify(execFile);

function invokeExec(exec, command, args, options) {
  if (typeof exec !== 'function') return Promise.reject(new Error('exec unavailable'));
  if (exec.length >= 4) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value ?? {});
      };
      try {
        const returned = exec(command, args, options, (error, stdout, stderr) => {
          if (error) finish(error);
          else finish(null, { stdout, stderr });
        });
        if (returned && typeof returned.then === 'function') returned.then(value => finish(null, value), error => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }
  return Promise.resolve().then(() => exec(command, args, options));
}

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
  return pathname
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try { return decodeURIComponent(segment); } catch { throw statusError('Invalid path.', 400); }
    });
}

function stripSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : '';
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.models)) return data.models;
  return [];
}

function zeroPrice(row) {
  const price = row?.pricing?.prompt ?? row?.pricing?.input ?? row?.price?.prompt ?? row?.cost?.input ?? row?.price;
  if (price === 0) return true;
  if (typeof price === 'string' && price.trim() !== '' && Number(price) === 0) return true;
  return Number.isFinite(Number(price)) && price !== null && price !== '' && Number(price) === 0;
}

function defaultFreeModel(models) {
  const ids = models.map(model => model.id);
  return FREE_MODEL_PREFERENCE.find(id => ids.includes(id)) ?? ids[0];
}

async function parseResponseJson(response) {
  if (typeof response?.json === 'function') return response.json();
  if (typeof response?.text === 'function') {
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
  return {};
}

export function createOnboarding({
  config,
  fetchImpl = fetch,
  exec = defaultExec,
  which,
  exists,
  log = () => {},
  routerSupervisor,
  env = process.env,
  home = typeof env?.HOME === 'string' ? env.HOME : undefined,
} = {}) {
  if (!config || typeof config.load !== 'function' || typeof config.save !== 'function' || typeof config.view !== 'function') {
    throw Error('The onboarding routes need an Orbit configuration instance.');
  }

  function safeLog(message) {
    // Fixed, bounded text only. Error objects and provider responses are never
    // passed here because they may contain credentials or echoed request data.
    try { log(String(message).slice(0, 300)); } catch { /* a broken logger must not change a request outcome. */ }
  }

  function providersView(view) {
    return view.providers.map(provider => ({
      ...provider,
      active: provider.kind === 'router' ? view.router.enabled : true,
    }));
  }

  function statePayload(extra = {}) {
    const view = config.view();
    return { ok: true, config: view, providers: providersView(view), ...extra };
  }

  async function callSupervisor(method, current) {
    if (!routerSupervisor) return { applied: false };
    const functionNames = method === 'enable' ? ['enable', 'start']
      : method === 'disable' ? ['disable', 'stop']
      : method === 'apply' ? ['apply', 'configure', 'enable']
      : ['reconfigure', 'configure', 'apply', 'enable'];
    const fn = functionNames.map(name => routerSupervisor[name]).find(candidate => typeof candidate === 'function');
    if (!fn) return { applied: false };
    try {
      await fn.call(routerSupervisor, current);
      return { applied: true };
    } catch {
      safeLog(`Token router supervisor ${method} was unavailable.`);
      return { applied: false };
    }
  }

  function mergeRouter(current, patch) {
    const next = { ...current, ...patch };
    if (isPlainObject(patch.external)) next.external = { ...current.external, ...patch.external };
    return next;
  }

  async function putComponents(body) {
    const current = config.load();
    const explicitRouter = isPlainObject(body.router) ? body.router : {};
    let componentsPatch;
    if (isPlainObject(body.components)) componentsPatch = body.components;
    else componentsPatch = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'router'));
    if (!isPlainObject(componentsPatch)) throw statusError('Components must be an object.', 400);
    const before = current.router.enabled;
    const components = { ...current.components, ...componentsPatch };
    let router = mergeRouter(current.router, explicitRouter);
    if (typeof componentsPatch.router === 'boolean') router.enabled = componentsPatch.router;
    else if (typeof explicitRouter.enabled === 'boolean') router.enabled = explicitRouter.enabled;
    components.router = router.enabled;
    if (typeof explicitRouter.engine === 'string' && explicitRouter.image === undefined) router.image = ROUTER_IMAGES[explicitRouter.engine] ?? router.image;
    const next = config.save({ ...current, components, router });
    let supervisor = { applied: false };
    if (!before && next.router.enabled) supervisor = await callSupervisor('enable', next);
    else if (before && !next.router.enabled) supervisor = await callSupervisor('disable', next);
    else if (before && next.router.enabled && isPlainObject(body.router) && Object.keys(body.router).length) {
      supervisor = await callSupervisor('reconfigure', next);
    }
    return statePayload({ routerSupervisor: supervisor });
  }

  async function listProviders() {
    const view = config.view();
    return { ok: true, providers: providersView(view) };
  }

  async function createProvider(body) {
    const current = config.load();
    const input = isPlainObject(body.provider) ? body.provider : body;
    if (!isPlainObject(input)) throw statusError('Provider must be an object.', 400);
    const provider = { ...input };
    const existingIndex = current.providers.findIndex(entry => entry.id === provider.id);
    if (existingIndex >= 0 && provider.kind !== 'router') throw statusError('Provider already exists.', 409);
    const existing = existingIndex >= 0 ? current.providers[existingIndex] : null;

    let router = current.router;
    let components = current.components;
    const before = current.router.enabled;
    if (provider.kind === 'router') {
      if (!isPlainObject(body.router)) {
        router = {
          ...current.router,
          enabled: true,
          mode: 'external',
          external: { ...current.router.external, baseUrl: typeof provider.baseUrl === 'string' ? provider.baseUrl : current.router.external.baseUrl },
        };
      } else {
        router = mergeRouter(current.router, { ...body.router, enabled: true });
        if (!router.external?.baseUrl && typeof provider.baseUrl === 'string') {
          router.external = { ...router.external, baseUrl: provider.baseUrl };
        }
      }
      components = { ...current.components, router: true };
    }
    if (existing?.keyRef && provider.keyRef === undefined) {
      const sameExternalKey = provider.kind === 'router' && router.mode === 'external'
        && existing.keyRef.file === router.external?.keyRef?.file;
      if (provider.kind !== 'router' || router.mode !== 'external' || sameExternalKey) provider.keyRef = existing.keyRef;
    }

    const providers = [...current.providers];
    if (existingIndex >= 0) providers[existingIndex] = provider;
    else providers.push(provider);
    const next = config.save({ ...current, components, router, providers });
    let supervisor = { applied: false };
    if (provider.kind === 'router' && !before && next.router.enabled) supervisor = await callSupervisor('enable', next);
    const view = config.view();
    return { ok: true, provider: providersView(view).find(entry => entry.id === provider.id), config: view, providers: providersView(view), routerSupervisor: supervisor };
  }

  async function deleteProvider(providerId) {
    if (!ID_PATTERN.test(providerId)) throw statusError('Unknown provider.', 404);
    const current = config.load();
    const provider = current.providers.find(entry => entry.id === providerId);
    if (!provider) throw statusError('Unknown provider.', 404);
    try { config.clearKey(providerId); } catch { /* no stored key */ }
    const afterKey = config.load();
    const providers = afterKey.providers.filter(entry => entry.id !== providerId);
    const roles = { ...afterKey.roles };
    for (const role of Object.keys(roles)) {
      if (roles[role].provider === providerId) roles[role] = { provider: '', model: '' };
    }
    const router = {
      ...afterKey.router,
      upstreams: afterKey.router.upstreams.filter(upstream => upstream.providerId !== providerId),
    };
    let components = afterKey.components;
    if (provider.kind === 'router') {
      router.enabled = false;
      components = { ...afterKey.components, router: false };
    }
    const next = config.save({ ...afterKey, components, roles, router, providers });
    if (provider.kind === 'router' && !next.router.enabled) await callSupervisor('disable', next);
    const view = config.view();
    return { ok: true, removed: providerId, config: view, providers: providersView(view) };
  }

  async function clearProviderKey(providerId) {
    if (!ID_PATTERN.test(providerId)) throw statusError('Unknown provider.', 404);
    const current = config.load();
    if (!current.providers.some(provider => provider.id === providerId)) throw statusError('Unknown provider.', 404);
    try { config.clearKey(providerId); } catch { throw statusError('The key could not be cleared.', 400); }
    const view = config.view();
    return { ok: true, id: providerId, key: { set: false, masked: null }, provider: providersView(view).find(entry => entry.id === providerId), config: view, providers: providersView(view) };
  }

  async function setProviderKey(providerId, body) {
    if (!ID_PATTERN.test(providerId)) throw statusError('Unknown provider.', 404);
    const current = config.load();
    if (!current.providers.some(provider => provider.id === providerId)) throw statusError('Unknown provider.', 404);
    if (typeof body.key !== 'string' || !body.key) throw statusError('A non-empty key is required.', 400);
    let result;
    try {
      result = config.setKey(providerId, body.key);
    } catch {
      throw statusError('The key could not be stored.', 400);
    }
    const view = config.view();
    const provider = providersView(view).find(entry => entry.id === providerId);
    safeLog(`Stored key for provider ${providerId}.`);
    return { ok: true, id: providerId, key: result.key, provider: provider ?? { id: result.id, key: result.key }, config: view, providers: providersView(view) };
  }

  function providerBaseUrl(provider, current) {
    if (typeof provider.baseUrl === 'string' && provider.baseUrl.trim()) return stripSlash(provider.baseUrl.trim());
    if (provider.kind === 'openrouter') return 'https://openrouter.ai/api/v1';
    if (provider.kind === 'anthropic') return 'https://api.anthropic.com';
    if (provider.kind === 'opencode-free') return 'https://opencode.ai/inference/v1';
    if (provider.kind === 'router' && current.router.enabled && current.router.mode === 'builtin') return `http://127.0.0.1:${current.router.port}/v1`;
    return '';
  }

  function modelUrl(provider, baseUrl) {
    if (provider.kind === 'opencode-free') return FREE_MODELS_URL;
    if (provider.kind === 'anthropic') return baseUrl.endsWith('/v1') ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
    return `${baseUrl}/models`;
  }

  function modelHeaders(provider, key) {
    const headers = { Accept: 'application/json' };
    if (typeof key === 'string' && key) {
      if (provider.kind === 'anthropic') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.Authorization = `Bearer ${key}`;
      }
    }
    return headers;
  }

  function scrub(text, key) {
    let value = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
    if (key) value = value.split(key).join('[redacted]');
    return value;
  }

  function cleanModels(rows, provider, key) {
    const models = [];
    const seen = new Set();
    for (const row of rows) {
      const rawId = typeof row === 'string' ? row : (row?.id ?? row?.model ?? row?.name);
      if (typeof rawId !== 'string') continue;
      const id = scrub(rawId, key).slice(0, 200);
      if (!id || seen.has(id)) continue;
      if (provider.kind === 'opencode-free') {
        const free = id.endsWith('-free') || (typeof row === 'object' && zeroPrice(row));
        if (!free) continue;
      }
      seen.add(id);
      const label = scrub(typeof row?.display_name === 'string' ? row.display_name : typeof row?.name === 'string' ? row.name : id, key).slice(0, 200) || id;
      const note = scrub(row?.privacyNote ?? row?.privacy_note ?? provider.privacyNote ?? (provider.kind === 'opencode-free'
        ? 'Free OpenCode models are served only through the OpenCode client.'
        : ''), key).slice(0, 500);
      models.push({ id, label, ...(note ? { privacyNote: note } : {}) });
    }
    return models;
  }

  async function providerModels(providerId) {
    if (!ID_PATTERN.test(providerId)) throw statusError('Unknown provider.', 404);
    const current = config.load();
    const provider = current.providers.find(entry => entry.id === providerId);
    if (!provider) throw statusError('Unknown provider.', 404);
    const manual = () => ({ ok: true, providerId, models: [], manual: true });
    if (provider.kind === 'pi') return manual();
    if (provider.kind === 'router' && !current.router.enabled) return manual();
    const baseUrl = providerBaseUrl(provider, current);
    if (!baseUrl) return manual();
    const key = config.resolveKey(providerId);
    let response;
    try {
      response = await fetchImpl(modelUrl(provider, baseUrl), {
        method: 'GET',
        headers: modelHeaders(provider, key),
        redirect: 'error',
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(MODEL_TIMEOUT_MS) : undefined,
      });
      if (!response || response.ok !== true) throw new Error('model list rejected');
      const data = await parseResponseJson(response);
      let models = cleanModels(extractRows(data), provider, key);
      let preferred;
      if (provider.kind === 'opencode-free') {
        preferred = defaultFreeModel(models);
        models = models.slice().sort((a, b) => {
          const left = FREE_MODEL_PREFERENCE.indexOf(a.id);
          const right = FREE_MODEL_PREFERENCE.indexOf(b.id);
          if (left < 0 && right < 0) return 0;
          if (left < 0) return 1;
          if (right < 0) return -1;
          return left - right;
        });
      }
      return { ok: true, providerId, models, manual: false, ...(preferred ? { default: preferred } : {}) };
    } catch {
      // Never include the upstream error: it can echo an Authorization header or
      // a URL containing a key. The wizard offers manual entry instead.
      safeLog(`Model list unavailable for provider ${providerId}.`);
      return manual();
    } finally {
      try { await response?.body?.cancel?.(); } catch { /* response already consumed */ }
    }
  }

  async function opencodeState() {
    const detected = await detectOpencode({ which, exec, env, home, exists });
    return {
      ok: true,
      opencode: detected,
      command: OPENCODE_INSTALL_COMMAND.display,
      requiresConfirm: true,
      install: { command: OPENCODE_INSTALL_COMMAND.display, requiresConfirm: true },
    };
  }

  async function installOpencode(body) {
    if (body.confirm !== true) {
      return {
        status: 409,
        data: {
          ok: false,
          error: 'Confirmation required before installing OpenCode.',
          command: OPENCODE_INSTALL_COMMAND.display,
          requiresConfirm: true,
        },
      };
    }
    try {
      await invokeExec(exec, OPENCODE_INSTALL_COMMAND.command, [...OPENCODE_INSTALL_COMMAND.args], { timeout: 300_000, maxBuffer: 65_536 });
    } catch {
      safeLog('OpenCode install command failed.');
      return { status: 502, data: { ok: false, error: 'OpenCode install failed.', code: 'install_failed' } };
    }
    const current = config.load();
    config.save({ ...current, installState: { ...(current.installState || {}), opencode: 'installed' } });
    safeLog('OpenCode install command completed.');
    return {
      status: 200,
      data: {
        ok: true,
        installed: true,
        command: OPENCODE_INSTALL_COMMAND.display,
        opencode: await detectOpencode({ which, exec, env, home, exists }),
      },
    };
  }

  async function apply() {
    const current = config.load();
    const installState = { ...(current.installState || {}) };
    for (const key of COMPONENT_KEYS) installState[key] = current.components[key] ? 'pending' : 'skipped';
    installState.apps = Array.isArray(current.components.apps) && current.components.apps.length ? 'pending' : 'skipped';
    const next = config.save({ ...current, appliedAt: new Date().toISOString(), installState });
    const supervisor = next.router.enabled ? await callSupervisor('apply', next) : { applied: false };
    const view = config.view();
    return { ok: true, applied: true, config: view, providers: providersView(view), routerSupervisor: supervisor };
  }

  async function dispatch(req, res, url) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = normalisePath(url?.pathname ?? url ?? '/');
    const parts = segments(pathname);
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};

    if ((parts.length === 0 || (parts.length === 1 && parts[0] === 'state')) && method === 'GET') {
      return json(res, 200, statePayload());
    }
    if (parts.length === 1 && parts[0] === 'components' && method === 'PUT') {
      return json(res, 200, await putComponents(body));
    }
    if (parts.length === 1 && parts[0] === 'providers') {
      if (method === 'GET') return json(res, 200, await listProviders());
      if (method === 'POST') return json(res, 200, await createProvider(body));
    }
    if (parts.length === 2 && parts[0] === 'providers' && method === 'DELETE') {
      return json(res, 200, await deleteProvider(parts[1]));
    }
    if (parts.length === 3 && parts[0] === 'providers' && parts[2] === 'key') {
      if (method === 'POST') return json(res, 200, await setProviderKey(parts[1], body));
      if (method === 'DELETE') return json(res, 200, await clearProviderKey(parts[1]));
    }
    if (parts.length === 3 && parts[0] === 'providers' && parts[2] === 'models' && method === 'GET') {
      return json(res, 200, await providerModels(parts[1]));
    }
    if (parts.length === 1 && parts[0] === 'opencode' && method === 'GET') {
      return json(res, 200, await opencodeState());
    }
    if (parts.length === 2 && parts[0] === 'opencode' && parts[1] === 'install' && method === 'POST') {
      const result = await installOpencode(body);
      return json(res, result.status, result.data);
    }
    if (parts.length === 1 && parts[0] === 'apply' && method === 'POST') {
      return json(res, 200, await apply());
    }
    if (['GET', 'POST', 'PUT', 'DELETE'].includes(method) && parts.length === 0) return json(res, 405, { ok: false, error: 'Method not allowed.' });
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

  return { handle, state: () => statePayload(), providers: () => listProviders(), providerModels };
}
