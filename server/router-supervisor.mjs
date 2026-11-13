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
import { renderBifrostConfig, renderLiteLLMConfig, renderRouterEnv } from './router-render.mjs';

const DEFAULT_BIFROST_IMAGE = 'maximhq/bifrost:v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8';
const DEFAULT_LITELLM_IMAGE = 'litellm/litellm:v1.108.6-lts@sha256:c64fe10f82a1f77906f88574f954317c50f67c617e0c97b70ac8fc61b74d3ec3';
const PINNED_IMAGE = /@sha256:[a-f0-9]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readSecret(file) {
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
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* already private */ }
    temporary += 1;
    const staging = path.join(directory, `.${path.basename(file)}.${process.pid}.${temporary}.tmp`);
    fs.writeFileSync(staging, content, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(staging, 0o600); } catch { /* best effort */ }
    fs.renameSync(staging, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }

  function ensureDirs() {
    for (const directory of [keysDir(), routerDir(), dataDir()]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
    }
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
    const fallback = engineOf() === 'litellm' ? DEFAULT_LITELLM_IMAGE : DEFAULT_BIFROST_IMAGE;
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
      if (url.username || url.password) {
        throw Error('External router base URL must not embed credentials.');
      }
      return { engine: null, image: null, mode };
    }
    const engine = router.engine ?? 'bifrost';
    if (engine !== 'bifrost' && engine !== 'litellm') {
      throw Error('Router engine must be bifrost or litellm.');
    }
    const image = imageFor();
    if (!PINNED_IMAGE.test(image) || /:latest(?:$|@)/.test(image)) {
      throw Error('Router image must be pinned by digest and must not use latest.');
    }
    return { engine, image, mode };
  }

  function virtualKeyDefs() {
    return renderBifrostConfig(routerConfig(), {}).virtual_keys;
  }

  function collectUpstreamKeys() {
    const router = routerConfig();
    const values = {};
    const names = {};
    const used = new Set(['external-router.key']);
    const list = Array.isArray(router.upstreams) ? router.upstreams : [];
    for (const upstream of list) {
      if (!upstream || typeof upstream !== 'object') continue;
      const providerId = String(upstream.providerId ?? upstream.id ?? '').trim();
      if (!providerId) continue;
      const envName = upstreamEnvName(providerId);
      names[providerId] = envName;
      const file = safeKeyFile(upstream.keyRef?.file, `${providerId}.key`);
      used.add(file);
      const value = readSecret(path.join(keysDir(), file));
      if (value) values[envName] = value;
    }
    let files = [];
    try {
      files = fs.readdirSync(keysDir());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of files.sort()) {
      if (!name.endsWith('.key') || VIRTUAL_KEY_FILE.test(name) || used.has(name)) continue;
      const value = readSecret(path.join(keysDir(), name));
      if (!value) continue;
      const envName = upstreamEnvName(name.slice(0, -4));
      if (ENV_NAME.test(envName) && values[envName] === undefined) values[envName] = value;
    }
    return { values, names };
  }

  function randomToken(bytes) {
    const value = randomBytes(bytes);
    return Buffer.isBuffer(value) ? value.toString('base64url') : String(value);
  }

  function makeVirtualKey() {
    return `sk-bf-${randomToken(32)}`;
  }

  function composeEnv(image) {
    const env = { ...process.env, ORBIT_RUNTIME_DIR: runtimeDir };
    if (typeof image === 'string' && image) env.ORBIT_ROUTER_IMAGE = image;
    return env;
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
    const response = await fetchImpl(url, probeOptions(key));
    try { await response?.body?.cancel?.(); } catch { /* status is enough */ }
    return { ok: response?.ok === true, statusCode: response?.status ?? null, url };
  }

  async function enableBuiltin(validated) {
    const router = routerConfig();
    ensureDirs();
    const { values, names } = collectUpstreamKeys();
    const previous = parseEnv(readText(routerEnvPath()));
    const generated = {};
    if (validated.engine === 'litellm') {
      generated.LITELLM_MASTER_KEY = previous.LITELLM_MASTER_KEY || `sk-litellm-${randomToken(24)}`;
      generated.LITELLM_SALT_KEY = previous.LITELLM_SALT_KEY || randomToken(32);
    } else {
      generated.BIFROST_ENCRYPTION_KEY = previous.BIFROST_ENCRYPTION_KEY || randomToken(32);
      generated.BIFROST_SETUP_TOKEN = previous.BIFROST_SETUP_TOKEN || `bf-setup-${randomToken(24)}`;
    }

    if (validated.engine === 'litellm') {
      writePrivate(liteLLMConfigPath(), renderLiteLLMConfig(router, { upstreams: names }));
    } else {
      const rendered = renderBifrostConfig(router, { upstreams: names });
      writePrivate(bifrostConfigPath(), `${JSON.stringify(rendered, null, 2)}\n`);
    }
    writePrivate(routerEnvPath(), renderRouterEnv({ upstreamKeys: values, generated }));
    updateComposeProfile(true);

    try {
      await exec('docker', ['compose', '--profile', 'router', 'up', '-d', 'router'], {
        cwd: runtimeDir,
        env: composeEnv(validated.image),
      });
    } catch (error) {
      const message = redact(error?.message || 'Router start failed.');
      state.lastError = 'start_failed';
      safeLog(`router start failed: ${message}`);
      throw Error(message);
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
    issueVirtualKeys();
    safeLog('router enabled');
    return status();
  }

  async function enable() {
    const validated = validate();
    if (state.running) return status();
    if (validated.mode === 'external') {
      let probe;
      try {
        probe = await probeExternal();
      } catch (error) {
        const message = redact(error?.message || 'External router is unreachable.');
        state.lastError = 'unreachable';
        safeLog(`external router health failed: ${message}`);
        throw Error(message);
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
    return enableBuiltin(validated);
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
    if (modeOf() === 'builtin') {
      try {
        await exec('docker', ['compose', '--profile', 'router', 'down', 'router'], {
          cwd: runtimeDir,
          env: composeEnv(),
        });
      } catch (error) {
        safeLog(`router stop failed: ${redact(error?.message || '')}`);
      }
    }

    updateComposeProfile(false);
    for (const file of [routerEnvPath(), bifrostConfigPath(), liteLLMConfigPath()]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let names = [];
    try {
      names = fs.readdirSync(keysDir());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      if (!VIRTUAL_KEY_FILE.test(name)) continue;
      try { fs.unlinkSync(path.join(keysDir(), name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    ensureDirs();
    const issues = [];
    for (const definition of virtualKeyDefs()) {
      const role = definition.id;
      if (!ROLE_ID.test(role)) continue;
      const file = virtualKeyPath(role);
      if (!readSecret(file)) writePrivate(file, `${makeVirtualKey()}\n`);
      issues.push({ role, file: `router-vk-${role}.key`, keySet: true });
    }
    return issues;
  }

  function rotateKey(role) {
    if (typeof role !== 'string' || !ROLE_ID.test(role)) throw Error('Invalid router role.');
    if (!virtualKeyDefs().some(definition => definition.id === role)) {
      throw Error('Unknown router role.');
    }
    ensureDirs();
    writePrivate(virtualKeyPath(role), `${makeVirtualKey()}\n`);
    return { role, rotated: true };
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
      definitions = virtualKeyDefs();
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
      engine: engineOf(),
      image: imageFor(),
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
    const external = modeOf() === 'external';
    const base = external
      ? sanitizeExternalBase(routerConfig().external?.baseUrl)
      : `${baseUrl()}/v1`;
    const externalKeyFile = safeKeyFile(routerConfig().external?.keyRef?.file, 'external-router.key');
    const apiKeyFile = id => external ? externalKeyFile : `router-vk-${id}.key`;
    const entries = [];
    for (const [id, role] of Object.entries(rolesConfig())) {
      if (!role || role.provider !== 'router') continue;
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
    if (!entries.length) {
      for (const definition of virtualKeyDefs()) {
        const model = Array.isArray(definition.allowed_models) ? definition.allowed_models[0] : '';
        if (!model || model === '*') continue;
        entries.push({
          id: definition.id,
          kind: 'openai-compatible',
          baseUrl: base,
          apiKeyFile: apiKeyFile(definition.id),
          model,
        });
      }
    }
    return entries;
  }

  return {
    enable,
    disable,
    status,
    health,
    issueVirtualKeys,
    rotateKey,
    toRegistryEntries,
  };
}
