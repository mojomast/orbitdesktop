import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GATEWAY_PROVIDERS } from './agent-providers.mjs';

const WILDCARDS = new Set(['0.0.0.0', '::', '[::]']);
const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Client dial address. A wildcard bind is not a destination; use loopback on this machine. */
export function connectHostFor(host) {
  const trimmed = String(host || '').trim();
  if (!trimmed || WILDCARDS.has(trimmed)) return '127.0.0.1';
  return trimmed;
}

function readPrivate(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function parseEnvFile(text) {
  const values = {};
  if (typeof text !== 'string') return values;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

/** Indent-based scalar maps only. Enough for Hermes gateway and model blocks. */
export function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  if (typeof text !== 'string') return root;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();
    if (line.startsWith('- ')) continue;
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).node;
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) continue;
    let value = match[2].replace(/\s+#.*$/, '').trim();
    if (!value) {
      const child = {};
      parent[match[1]] = child;
      stack.push({ indent, node: child });
    } else {
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      parent[match[1]] = value;
    }
  }
  return root;
}

function dig(node, keys) {
  let current = node;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function flag(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return undefined;
}

function portOf(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function httpOrigin(scheme, host, port) {
  if (!['http', 'https'].includes(scheme)) return null;
  if (typeof host !== 'string' || !/^[A-Za-z0-9.:-]{1,253}$/.test(host)) return null;
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${scheme}://${authority}:${port}`;
}

function modelId(value) {
  return typeof value === 'string' && MODEL_ID.test(value.trim()) ? value.trim() : undefined;
}

function hermesHome(env, home) {
  if (home) return home;
  if (typeof env.HERMES_HOME === 'string' && path.isAbsolute(env.HERMES_HOME.trim())) return env.HERMES_HOME.trim();
  return path.join(os.homedir(), '.hermes');
}

/**
 * Reuse the Hermes deployment's API server. The server already holds the model
 * provider (for example opencode-go / deepseek-v4.1-flash). Orbit reads only the
 * API server bind and API_SERVER_KEY — never a second model-vendor key.
 * Explicit HERMES_API_URL / HERMES_API_KEY / HERMES_PROFILES_JSON skip this.
 */
export function discoverHermesGateway({ env = process.env, home, readFile = readPrivate } = {}) {
  const root = hermesHome(env, home);
  const fileEnv = parseEnvFile(readFile(path.join(root, '.env')) || '');
  const yaml = parseSimpleYaml(readFile(path.join(root, 'config.yaml')) || '');
  const yamlBlock = [dig(yaml, ['gateway', 'api_server']), dig(yaml, ['gateway', 'platforms', 'api_server']), dig(yaml, ['platforms', 'api_server'])].find(block => block && typeof block === 'object') || {};
  const pick = key => {
    if (typeof env[key] === 'string' && env[key].trim()) return env[key].trim();
    if (typeof fileEnv[key] === 'string' && fileEnv[key].trim()) return fileEnv[key].trim();
    return undefined;
  };
  const enabled = flag(pick('API_SERVER_ENABLED')) ?? flag(yamlBlock.enabled);
  if (enabled === false) return null;
  const apiKey = pick('API_SERVER_KEY') || (typeof yamlBlock.key === 'string' ? yamlBlock.key.trim() : '');
  if (!apiKey) return null;
  const host = connectHostFor(pick('API_SERVER_HOST') || yamlBlock.host || '127.0.0.1');
  const port = portOf(pick('API_SERVER_PORT') || yamlBlock.port) || 8642;
  const apiUrl = httpOrigin('http', host, port);
  if (!apiUrl) return null;
  const modelBlock = dig(yaml, ['model']) || {};
  const model = modelId(pick('API_SERVER_MODEL_NAME') || yamlBlock.model_name || modelBlock.default);
  const modelProvider = modelId(modelBlock.provider);
  const source = env.API_SERVER_KEY ? 'environment' : fileEnv.API_SERVER_KEY ? 'hermes-env' : 'hermes-config';
  return { apiUrl, apiKey, ...(model ? { model } : {}), ...(modelProvider ? { modelProvider } : {}), source, label: model ? `Hermes · ${model}` : 'Hermes' };
}

function grokRoots(env, home) {
  const roots = [];
  const push = value => {
    if (typeof value === 'string' && path.isAbsolute(value.trim()) && !roots.includes(value.trim())) roots.push(value.trim());
  };
  push(env.SAND_DATA_ROOT);
  push(env.GROK_BOT_AGENT_DATA_DIR);
  if (typeof env.SAND_USER_DATA_DIR === 'string' && path.isAbsolute(env.SAND_USER_DATA_DIR.trim())) push(path.join(env.SAND_USER_DATA_DIR.trim(), 'sand-data'));
  push('/home/box/agent-data');
  push('/home/box/sand-data');
  push(path.join(home, '.grokbot', 'agent-data'));
  push(path.join(home, 'sand-data'));
  push(path.join(home, 'Library', 'Application Support', 'Grok Bot', 'agent-data'));
  return roots;
}

function readGatewayFile(text) {
  if (!text) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const port = portOf(parsed.port);
  if (!port) return null;
  const scheme = parsed.scheme === 'https' ? 'https' : 'http';
  const host = typeof parsed.host === 'string' && parsed.host.trim() ? parsed.host.trim() : '127.0.0.1';
  const token = typeof parsed.token === 'string' && parsed.token.trim() ? parsed.token.trim() : undefined;
  return { port, scheme, host, token };
}

function readHostModel(text) {
  if (!text) return undefined;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  return modelId(parsed?.agentDefaultModel?.modelId);
}

function parseGatewayUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const scheme = url.protocol === 'https:' ? 'https' : 'http';
  const host = connectHostFor(url.hostname);
  const port = portOf(url.port) || (scheme === 'https' ? 443 : 80);
  const apiUrl = httpOrigin(scheme, host, port);
  return apiUrl ? { apiUrl } : null;
}

/**
 * Grok Bot host gateway on this computer. The host already has inference;
 * Orbit uses its gateway token the way it uses Hermes API_SERVER_KEY.
 * Looks at SAND_DATA_ROOT, GROK_BOT_AGENT_DATA_DIR, /home/box/agent-data,
 * /home/box/sand-data, and ~/.grokbot/agent-data. gateway.json supplies port,
 * bind and token. GROK_BOT_API_URL / GROK_BOT_API_KEY / GROK_BOT_MODEL are the
 * fallback when those files are not readable.
 */
export function discoverGrokGateway({ env = process.env, home = os.homedir(), readFile = readPrivate } = {}) {
  let file = null;
  let settingsModel;
  for (const root of grokRoots(env, home)) {
    if (!file) file = readGatewayFile(readFile(path.join(root, 'gateway.json')));
    if (!settingsModel) settingsModel = readHostModel(readFile(path.join(root, 'settings.json')));
    if (file && settingsModel) break;
  }
  const urlRaw = [env.GROK_BOT_API_URL, env.GROKBOT_GATEWAY_URL, env.SAND_GATEWAY_URL].map(value => typeof value === 'string' ? value.trim() : '').find(Boolean);
  const fromUrl = urlRaw ? parseGatewayUrl(urlRaw) : null;
  if (urlRaw && !fromUrl) return null;
  let apiUrl = fromUrl?.apiUrl || null;
  if (!apiUrl && file) apiUrl = httpOrigin(file.scheme, connectHostFor(typeof env.SAND_GATEWAY_BIND_HOST === 'string' && env.SAND_GATEWAY_BIND_HOST.trim() ? env.SAND_GATEWAY_BIND_HOST.trim() : file.host), portOf(env.SAND_HOST_PORT) || file.port);
  if (!apiUrl && portOf(env.SAND_HOST_PORT)) apiUrl = httpOrigin('http', connectHostFor(typeof env.SAND_GATEWAY_BIND_HOST === 'string' && env.SAND_GATEWAY_BIND_HOST.trim() ? env.SAND_GATEWAY_BIND_HOST.trim() : '127.0.0.1'), portOf(env.SAND_HOST_PORT));
  const token = [env.GROK_BOT_API_KEY, env.GROKBOT_GATEWAY_TOKEN, env.SAND_GATEWAY_TOKEN].map(value => typeof value === 'string' ? value.trim() : '').find(Boolean) || file?.token;
  if (!apiUrl || !token) return null;
  const modelRaw = [env.GROK_BOT_MODEL, env.SAND_XAI_MODEL].map(value => typeof value === 'string' ? value.trim() : '').find(Boolean);
  const model = modelId(modelRaw) || settingsModel;
  return {
    id: 'grok',
    label: 'Grok Bot',
    provider: 'grok',
    apiUrl,
    apiKey: token,
    ...(model ? { model } : {}),
    source: fromUrl ? 'environment' : 'gateway.json',
  };
}

function defaultIsExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Pi harness binary on this computer. `PI_BIN` wins when it is an absolute
 * path; otherwise PATH and the usual per-user bin directories are searched. A
 * relative PI_BIN is refused because it would resolve against the server's
 * working directory instead of the owner's shell.
 */
function findPiBinary(env, home, isExecutable) {
  const explicit = typeof env.PI_BIN === 'string' ? env.PI_BIN.trim() : '';
  if (explicit) return path.isAbsolute(explicit) && isExecutable(explicit) ? explicit : null;
  const candidates = [];
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    candidates.push(path.join(dir, 'pi'));
  }
  candidates.push(path.join(home, '.local', 'bin', 'pi'), path.join(home, 'bin', 'pi'), '/usr/local/bin/pi', '/opt/homebrew/bin/pi');
  for (const candidate of candidates) if (isExecutable(candidate)) return candidate;
  return null;
}

/**
 * Pi harness discovery. Two shapes, in order:
 *
 * 1. An external Pi gateway: `PI_GATEWAY_URL` plus `PI_GATEWAY_TOKEN`. Orbit
 *    dials it the way it dials the Grok Bot host gateway.
 * 2. A binary on this computer: Orbit hosts the gateway itself on a loopback
 *    port and keeps the token in memory (see server/index.mjs).
 *
 * No model credential is read from another application. Pi authenticates itself
 * through its own configuration or environment.
 */
export function discoverPiHarness({ env = process.env, home = os.homedir(), isExecutable = defaultIsExecutable } = {}) {
  const urlRaw = [env.PI_GATEWAY_URL].map(value => (typeof value === 'string' ? value.trim() : '')).find(Boolean);
  const fromUrl = urlRaw ? parseGatewayUrl(urlRaw) : null;
  if (urlRaw && !fromUrl) return null;
  const token = [env.PI_GATEWAY_TOKEN, env.PI_API_KEY].map(value => (typeof value === 'string' ? value.trim() : '')).find(Boolean);
  const labelRaw = typeof env.PI_LABEL === 'string' ? env.PI_LABEL.trim() : '';
  const label = labelRaw && labelRaw.length <= 200 && !/[\x00-\x1f\x7f]/.test(labelRaw) ? labelRaw : 'Pi';
  if (fromUrl) {
    if (!token) return null;
    return { id: 'pi', label, provider: 'pi', apiUrl: fromUrl.apiUrl, apiKey: token, source: 'environment', external: true };
  }
  if (flag(env.PI_HARNESS_DISABLED) === true) return null;
  const binary = findPiBinary(env, home, isExecutable);
  if (!binary) return null;
  const model = modelId(env.PI_MODEL);
  return { id: 'pi', label, provider: 'pi', source: 'pi-harness', binary, managed: true, ...(model ? { model } : {}) };
}

export function discoverAgentBackends(options = {}) {
  const env = options.env || process.env;
  const explicitHermes = Boolean(env.HERMES_API_URL || env.HERMES_API_KEY || env.HERMES_PROFILES_JSON);
  return {
    hermes: explicitHermes ? null : discoverHermesGateway(options),
    grok: discoverGrokGateway(options),
    pi: discoverPiHarness(options),
  };
}

/** Drop secrets before logging. */
export function publicBackendSummary(backend) {
  if (!backend) return null;
  return {
    id: backend.id,
    label: backend.label,
    provider: backend.provider,
    apiUrl: backend.apiUrl,
    source: backend.source,
    ...(backend.model ? { model: backend.model } : {}),
    ...(backend.modelProvider ? { modelProvider: backend.modelProvider } : {}),
    hasKey: Boolean(backend.apiKey),
  };
}

/** Append discovered gateway providers without changing the Hermes profile schema. */
export function attachProviders(catalog, additional = []) {
  const extras = new Map();
  const added = [];
  for (const entry of additional) {
    if (!entry || !GATEWAY_PROVIDERS.includes(entry.provider) || extras.has(entry.id) || catalog.get(entry.id)) continue;
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id)) continue;
    if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 200 || /[\x00-\x1f\x7f]/.test(entry.label)) continue;
    if (typeof entry.apiUrl !== 'string' || typeof entry.apiKey !== 'string' || !entry.apiKey.trim()) continue;
    let url;
    try { url = new URL(entry.apiUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) continue;
    const provider = entry.provider;
    const profile = Object.freeze({
      id: entry.id,
      label: entry.label,
      provider,
      apiUrl: url.origin,
      apiKey: entry.apiKey,
      ...(modelId(entry.model) ? { model: modelId(entry.model) } : {}),
      legacy: false,
    });
    extras.set(profile.id, profile);
    added.push(Object.freeze({ id: profile.id, label: profile.label, provider }));
  }
  if (!added.length) return catalog;
  const list = Object.freeze([...catalog.list, ...added]);
  return Object.freeze({
    list,
    defaultId: catalog.defaultId,
    get(id) { return extras.get(id) || catalog.get(id); },
    resolveRun(id) { return extras.has(id) ? null : catalog.resolveRun(id); },
    runPath(id) { return extras.has(id) ? null : catalog.runPath(id); },
  });
}
