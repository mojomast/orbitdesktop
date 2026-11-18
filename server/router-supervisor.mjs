/**
 * Opt-in built-in token router supervisor.
 *
 * Nothing runs, listens or renders unless the owner has set
 * `router.enabled: true` (and `components.router: true`). The composition root
 * injects `exec`, `fetchImpl`, `now`, `log` and `randomBytes`, so this module is
 * hermetic and testable without Docker or a network.
 *
 * Secrets never leave their private files: upstream keys are copied into a 0600
 * router.env, virtual keys live in 0600 per-role files, and status/log output is
 * redacted and metadata-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderBifrostConfig, renderRouterEnv, roleEnvName, virtualKeyEntries } from './router-render.mjs';
import { ROUTER_IMAGES } from './orbit-config.mjs';
import { roleFileBound } from './router-litellm-policy.mjs';

const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VIRTUAL_KEY_FILE = /^router-vk-.+\.key$/;

function envFragment(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UPSTREAM';
}

function upstreamEnvName(providerId) {
  return `ROUTER_UPSTREAM_${envFragment(providerId)}_KEY`;
}

function redact(value) {
  let text = String(value ?? '');
  text = text.replace(/sk-[A-Za-z0-9_-]{4,}/g, '[redacted]');
  text = text.replace(/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]');
  text = text.replace(/(x-api-key\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]');
  text = text.replace(/(x-bf-vk\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]');
  return text;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeKeyFile(value, fallback) {
  const name = typeof value === 'string' && value ? value : fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.includes('..')) {
    throw Error('Router key file name is invalid.');
  }
  return name;
}

function readText(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 2_097_152) throw Error('Invalid router configuration file.');
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readSecret(file) {
  const dir = fs.lstatSync(path.dirname(file), { throwIfNoEntry: false });
  if (dir && !dir.isDirectory()) throw Error('Router keys require a private directory.');
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile() || st.size > 65536 || (st.mode & 0o077)) throw Error('Router key must be a private regular file.');
  const text = readText(file);
  const value = typeof text === 'string' ? text.trim() : '';
  return value || null;
}

function parseEnv(text) {
  const values = {};
  if (!text) return values;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function sanitizeExternalBase(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '');
}

// Shared by Compose preparation and the separate operator-only host launcher:
// the latter must compare the prepared engine config to the current Orbit doc.
export function builtinRouterPlan(config) {
  const router = config.router ?? config;
  const upstreams = (router.upstreams ?? []).map(upstream => {
    const provider = (config.providers ?? []).find(p => p.id === upstream.providerId);
    if (!provider || !['openai-compatible', 'openrouter', 'anthropic'].includes(provider.kind)) throw Error('Unsupported router upstream.');
    return { ...upstream, keyRef: provider.keyRef, baseUrl: provider.baseUrl, type: provider.kind === 'openai-compatible' ? 'custom' : provider.kind, envName: upstreamEnvName(provider.id) };
  });
  if (new Set(upstreams.map(p => p.envName)).size !== upstreams.length) throw Error('Router upstream environment names must be distinct.');
  return { upstreams, rendered: renderBifrostConfig({ ...router, upstreams }) };
}

export function createRouterSupervisor({
  runtimeDir,
  config,
  exec,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log = () => {},
  randomBytes = crypto.randomBytes,
} = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir) {
    throw Error('A runtime directory is required for the router supervisor.');
  }

  const routerConfig = () => (
    config && typeof config === 'object' && config.router && typeof config.router === 'object'
      ? config.router
      : (config && typeof config === 'object' ? config : {})
  );
  const rolesConfig = () => (
    config && typeof config === 'object' && config.roles && typeof config.roles === 'object'
      ? config.roles
      : {}
  );

  const state = {
    running: false,
    health: 'disabled',
    startedAt: null,
    lastError: null,
  };
  let temporary = 0;

  const keysDir = () => path.join(runtimeDir, 'keys');
  const routerDir = () => path.join(runtimeDir, 'router');
  const dataDir = () => path.join(routerDir(), 'data');
  const routerEnvPath = () => path.join(routerDir(), 'router.env');
  const bifrostConfigPath = () => path.join(dataDir(), 'config.json');
  const liteLLMConfigPath = () => path.join(dataDir(), 'config.yaml');
  const runtimeEnvPath = () => path.join(runtimeDir, '.env');
  const virtualKeyPath = role => path.join(keysDir(), `router-vk-${role}.key`);

  function safeLog(message) {
    try {
      log(redact(message));
    } catch {
      /* a logger must never break router lifecycle */
    }
  }

  function writePrivate(file, content) {
    const directory = path.dirname(file);
    privateDir(directory);
    temporary += 1;
    const staging = path.join(directory, `.${path.basename(file)}.${process.pid}.${temporary}.tmp`);
    fs.writeFileSync(staging, content, { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(staging, file); } finally { fs.rmSync(staging, { force: true }); }
  }

  function privateDir(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw Error('Invalid private router directory.');
    fs.chmodSync(directory, 0o700);
  }

  function ensureDirs() {
    for (const directory of [runtimeDir, keysDir(), routerDir(), dataDir()]) privateDir(directory);
  }

  function modeOf() {
    return routerConfig().mode === 'external' ? 'external' : 'builtin';
  }

  function engineOf() {
    const engine = routerConfig().engine;
    return engine === 'litellm' ? 'litellm' : 'bifrost';
  }

  function imageFor() {
    const configured = typeof routerConfig().image === 'string' ? routerConfig().image.trim() : '';
    const fallback = ROUTER_IMAGES[engineOf()];
    return configured || fallback;
  }

  function routerPort() {
    const port = Number(routerConfig().port);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8080;
  }

  function baseUrl() {
    if (modeOf() === 'external') {
      const raw = typeof routerConfig().external?.baseUrl === 'string'
        ? routerConfig().external.baseUrl.trim().replace(/\/+$/, '')
        : '';
      return raw;
    }
    const host = routerConfig().bind === 'loopback' ? '127.0.0.1' : 'router';
    return `http://${host}:${routerPort()}`;
  }

  function sanitizedBaseUrl() {
    if (modeOf() === 'external') return sanitizeExternalBase(routerConfig().external?.baseUrl);
    return baseUrl();
  }

  function externalKeyPath() {
    return path.join(keysDir(), safeKeyFile(routerConfig().external?.keyRef?.file, 'external-router.key'));
  }

  function validate() {
    const components = config && typeof config === 'object' ? config.components : null;
    const declared = components && typeof components === 'object' ? components.router : undefined;
    const enabled = typeof config?.router?.enabled === 'boolean' ? config.router.enabled : undefined;
    if (typeof declared === 'boolean' && typeof enabled === 'boolean' && declared !== enabled) {
      throw Error('Router component and router.enabled must agree.');
    }
    const router = routerConfig();
    if (router.enabled !== true) throw Error('Router is disabled in configuration.');
    const mode = router.mode ?? 'builtin';
    if (mode !== 'builtin' && mode !== 'external') {
      throw Error('Router mode must be builtin or external.');
    }
    if (mode === 'external') {
      const raw = router.external?.baseUrl;
      if (typeof raw !== 'string' || !raw.trim()) throw Error('External router needs a base URL.');
      let url;
      try {
        url = new URL(raw.trim());
      } catch {
        throw Error('External router base URL is invalid.');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw Error('External router must use http or https.');
      }
      if (url.username || url.password || url.search || url.hash) {
        throw Error('External router base URL must not embed credentials.');
      }
      if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('External router requires HTTPS outside loopback.');
      return { engine: null, image: null, mode };
    }
    const engine = router.engine ?? 'bifrost';
    if (engine !== 'bifrost' && engine !== 'litellm') {
      throw Error('Router engine must be bifrost or litellm.');
    }
    const image = imageFor();
    if (image !== ROUTER_IMAGES[engine]) throw Error('Router image does not match the pinned engine.');
    return { engine, image, mode };
  }

  function virtualKeyDefs() {
    return virtualKeyEntries(routerConfig());
  }

  function collectUpstreamKeys(upstreams) {
    const values = {};
    for (const {providerId, keyRef} of upstreams) {
      const envName = upstreamEnvName(providerId);
      if (keyRef?.env) throw Error('Built-in router upstreams require private file references.');
      if (!keyRef) continue;
      const file = safeKeyFile(keyRef.file);
      if (VIRTUAL_KEY_FILE.test(file) || file === path.basename(externalKeyPath())) throw Error('Router upstream requires a separate provider key.');
      const value = readSecret(path.join(keysDir(), file));
      if (!value) throw Error('Configured router upstream key file is missing.');
      values[envName] = value;
    }
    return values;
  }

  function randomToken(bytes) {
    const value = randomBytes(bytes);
    return Buffer.isBuffer(value) ? value.toString('base64url') : String(value);
  }

  function makeVirtualKey() {
    return `sk-bf-${randomToken(32)}`;
  }

  function composeEnv() {
    return { ORBIT_RUNTIME_DIR: path.resolve(runtimeDir), PATH: process.env.PATH };
  }

  function composeArgs(...args) {
    return ['compose', '-f', fileURLToPath(new URL('../docker-compose.yml', import.meta.url)), '--profile', 'router', ...args];
  }

  function updateComposeProfile(enabled) {
    const file = runtimeEnvPath();
    const existing = readText(file);
    const lines = existing ? existing.replace(/\n$/, '').split('\n') : [];
    const profiles = [];
    const kept = [];
    for (const line of lines) {
      const match = /^\s*COMPOSE_PROFILES\s*=\s*(.*)$/.exec(line);
      if (!match) {
        kept.push(line);
        continue;
      }
      for (const profile of match[1].split(',').map(value => value.trim()).filter(Boolean)) {
        if (profile !== 'router') profiles.push(profile);
      }
    }
    if (enabled) profiles.push('router');
    const unique = [...new Set(profiles)];
    if (unique.length) kept.push(`COMPOSE_PROFILES=${unique.join(',')}`);
    if (!enabled && existing === null && unique.length === 0) return;
    writePrivate(file, kept.length ? `${kept.join('\n')}\n` : '');
  }

  function probeOptions(key) {
    const headers = { accept: 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const options = { method: 'GET', headers, redirect: 'error' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(5000);
    }
    return options;
  }

  async function waitForBuiltinHealth() {
    const router = routerConfig();
    const url = `${baseUrl()}/health`;
    const timeout = Number.isFinite(Number(router.healthTimeoutMs)) ? Number(router.healthTimeoutMs) : 30000;
    const poll = Math.max(1, Number.isFinite(Number(router.healthPollMs)) ? Number(router.healthPollMs) : 250);
    const deadline = now() + Math.max(0, timeout);
    let statusCode = null;
    for (;;) {
      try {
        const response = await fetchImpl(url, probeOptions(null));
        statusCode = response?.status ?? null;
        if (response?.ok) return { ok: true, statusCode, url };
        try { await response?.body?.cancel?.(); } catch { /* status is enough */ }
      } catch {
        statusCode = null;
      }
      if (now() >= deadline) return { ok: false, statusCode, url };
      await delay(Math.min(poll, Math.max(1, deadline - now())));
    }
  }

  async function probeExternal() {
    const url = `${baseUrl()}/models`;
    const key = readSecret(externalKeyPath());
    if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('Missing external router key.');
    const response = await fetchImpl(url, probeOptions(key));
    try { await response?.body?.cancel?.(); } catch { /* status is enough */ }
    return { ok: response?.ok === true, statusCode: response?.status ?? null, url };
  }

  function prepareBuiltin() {
    const validated = validate();
    if (validated.mode !== 'builtin') throw Error('External routers have no local configuration.');
    if (validated.engine !== 'bifrost') throw Error('Automatic LiteLLM installation is unavailable. Use the operator issuer with a provisioned proxy, or External.');
    if (fs.existsSync(path.join(routerDir(), 'host-run'))) throw Error('Stop the foreground router before reconfiguration.');
    const { upstreams, rendered } = builtinRouterPlan(config);
    ensureDirs();
    if (fs.readdirSync(keysDir()).some(file => /^\.litellm-issue-/.test(file))) throw Error('Reconcile LiteLLM role credentials before switching built-in engines.');
    const values = collectUpstreamKeys(upstreams.filter(upstream => Object.hasOwn(rendered.providers, upstream.providerId)));
    const previous = parseEnv(readText(routerEnvPath()));
    const generated = {
      BIFROST_ENCRYPTION_KEY: previous.BIFROST_ENCRYPTION_KEY || randomToken(32),
      BIFROST_SETUP_TOKEN: previous.BIFROST_SETUP_TOKEN || randomToken(24),
      BIFROST_ADMIN_PASSWORD: previous.BIFROST_ADMIN_PASSWORD || randomToken(32),
    };
    for (const { id } of rendered.governance.virtual_keys) {
      const key = readSecret(virtualKeyPath(id)) || makeVirtualKey();
      if (!/^sk-bf-[A-Za-z0-9_-]{43}$/.test(key)) throw Error('Unexpected existing built-in role credential.');
      generated[roleEnvName(id)] = key;
      writePrivate(virtualKeyPath(id), `${key}\n`);
    }
    writePrivate(bifrostConfigPath(), `${JSON.stringify(rendered, null, 2)}\n`);
    writePrivate(routerEnvPath(), renderRouterEnv({ upstreamKeys: values, generated }));
    updateComposeProfile(true);
    return status();
  }

  async function enableBuiltin() {
    prepareBuiltin();
    if (typeof exec !== 'function') throw Error('Router configuration prepared; host launch requires an explicit operator command.');
    try {
      await exec('docker', composeArgs('up', '-d', 'router'), {
        cwd: runtimeDir,
        env: composeEnv(),
      });
    } catch {
      state.lastError = 'start_failed';
      safeLog('Router start failed.');
      throw Error('Router start failed.');
    }

    const health = await waitForBuiltinHealth();
    if (!health.ok) {
      state.health = 'unhealthy';
      state.lastError = 'unhealthy';
      safeLog('router did not become healthy in time');
      throw Error('Router did not become healthy in time.');
    }

    state.running = true;
    state.health = 'healthy';
    state.startedAt = now();
    state.lastError = null;
    safeLog('router enabled');
    return status();
  }

  async function enable() {
    const validated = validate();
    if (validated.mode === 'external' && fs.existsSync(routerEnvPath())) throw Error('Disable the prepared built-in router before switching to external.');
    if (state.running && validated.mode === 'builtin') throw Error('Disable the active router before reconfiguration.');
    if (validated.mode === 'external') {
      let probe;
      try {
        probe = await probeExternal();
      } catch {
        state.lastError = 'unreachable';
        safeLog('External router health check failed.');
        throw Error('External router health check failed. Check the endpoint and its key.');
      }
      if (!probe.ok) {
        state.health = 'unhealthy';
        state.lastError = 'unhealthy';
        safeLog('external router did not answer its models endpoint');
        throw Error('External router did not answer its models endpoint.');
      }
      state.running = true;
      state.health = 'healthy';
      state.startedAt = now();
      state.lastError = null;
      safeLog('external router enabled');
      return status();
    }
    return enableBuiltin();
  }

  function markDisabled() {
    try {
      if (!config || typeof config !== 'object') return;
      if (config.router && typeof config.router === 'object') config.router.enabled = false;
      if (config.components && typeof config.components === 'object') config.components.router = false;
      if (!config.router && typeof config.enabled === 'boolean') config.enabled = false;
    } catch {
      /* a frozen configuration still leaves the runtime disabled */
    }
  }

  async function disable(options = {}) {
    if (options?.confirm !== true) {
      throw Error('Disabling the router requires confirm: true.');
    }
    if (fs.existsSync(path.join(routerDir(), 'host-run'))) throw Error('Stop the foreground router before disabling it.');
    const prepared = fs.existsSync(routerEnvPath());
    if (typeof exec === 'function' && prepared) {
      try {
        await exec('docker', composeArgs('down', 'router'), {
          cwd: runtimeDir,
          env: composeEnv(),
        });
      } catch {
        throw Error('Router stop failed; generated state retained.');
      }
    }

    if (prepared || modeOf() === 'builtin') {
      updateComposeProfile(false);
      for (const file of [routerEnvPath(), bifrostConfigPath(), liteLLMConfigPath()]) {
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (fs.existsSync(keysDir())) {
        if (!fs.lstatSync(keysDir()).isDirectory()) throw Error('Invalid router key directory.');
        for (const name of fs.readdirSync(keysDir()).filter(name => VIRTUAL_KEY_FILE.test(name))) {
          fs.unlinkSync(path.join(keysDir(), name));
        }
      }
    }

    state.running = false;
    state.health = 'disabled';
    state.startedAt = null;
    state.lastError = null;
    markDisabled();
    safeLog('router disabled');
    return status();
  }

  function issueVirtualKeys() {
    if (validate().mode === 'external') return [];
    return status().virtualKeys.map(({ role, keySet }) => ({ role, file: `router-vk-${role}.key`, keySet }));
  }

  function rotateKey(role) {
    if (validate().mode !== 'builtin') throw Error('Rotate the external key at the external provider.');
    if (typeof role !== 'string' || !ROLE_ID.test(role)) throw Error('Invalid router role.');
    if (!virtualKeyDefs().some(definition => definition.id === role)) {
      throw Error('Unknown router role.');
    }
    throw Error('Online rotation requires a host launcher to reload and verify the router.');
  }

  async function health() {
    if (!state.running) {
      return { ok: false, status: 'disabled', statusCode: null };
    }
    try {
      const probe = modeOf() === 'external' ? await probeExternal() : await waitForBuiltinHealth();
      state.health = probe.ok ? 'healthy' : 'unhealthy';
      return { ok: probe.ok, status: state.health, statusCode: probe.statusCode ?? null };
    } catch {
      state.health = 'unhealthy';
      return { ok: false, status: 'unhealthy', statusCode: null };
    }
  }

  function status() {
    let definitions = [];
    try {
      definitions = modeOf() === 'external' ? [] : virtualKeyDefs();
    } catch {
      definitions = [];
    }
    let base = '';
    try {
      base = sanitizedBaseUrl();
    } catch {
      base = '';
    }
    return {
      enabled: state.running,
      configured: routerConfig().enabled === true,
      mode: modeOf(),
      engine: modeOf() === 'external' ? null : engineOf(),
      image: modeOf() === 'external' ? null : imageFor(),
      bind: routerConfig().bind === 'loopback' ? 'loopback' : 'internal',
      port: routerPort(),
      health: state.running ? state.health : 'disabled',
      baseUrl: base,
      virtualKeys: definitions.map(definition => ({
        role: definition.id,
        allowedModels: definition.allowed_models,
        budget: definition.budget ?? null,
        rateLimit: definition.rate_limit ?? null,
        expiresAt: definition.expires_at ?? null,
        keySet: fs.existsSync(virtualKeyPath(definition.id)),
      })),
      ...(modeOf() === 'external' ? { external: { baseUrl: base } } : {}),
    };
  }

  function toRegistryEntries() {
    if (!routerConfig().enabled) return [];
    const external = modeOf() === 'external';
    const base = external
      ? sanitizeExternalBase(routerConfig().external?.baseUrl)
      : `${baseUrl()}/v1`;
    const externalKeyFile = safeKeyFile(routerConfig().external?.keyRef?.file, 'external-router.key');
    const apiKeyFile = id => external ? externalKeyFile : `router-vk-${id}.key`;
    const entries = [];
    for (const [id, role] of Object.entries(rolesConfig())) {
      if (!role || role.provider !== 'router') continue;
      if (!external && !roleFileBound(runtimeDir, routerConfig(), id, role)) continue;
      const model = typeof role.model === 'string' ? role.model.trim() : '';
      if (!model) continue;
      entries.push({
        id,
        kind: 'openai-compatible',
        baseUrl: base,
        apiKeyFile: apiKeyFile(id),
        model,
      });
    }
    return entries;
  }

  return {
    prepareBuiltin,
    enable,
    disable,
    status,
    health,
    issueVirtualKeys,
    rotateKey,
    toRegistryEntries,
  };
}
