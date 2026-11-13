import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Agent adapter registry.
 *
 * Orbit can start with no agent at all. A provider is an optional adapter:
 * Hermes, Grok Bot and Pi are discovered built-ins; anything else is registered
 * in `agents.json` (or ORBIT_AGENTS_FILE) by id. Definitions never contain a
 * credential. A key is referenced by environment-variable name or by a key-file
 * name only, and the registry refuses inline secret fields outright.
 */

export const AGENT_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const AGENT_CAPABILITY_KEYS = Object.freeze([
  'compact',
  'modelSwitch',
  'contextMeter',
  'approvals',
  'streaming',
]);

const KIND = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEY_FILE = /^[A-Za-z0-9._-]{1,128}$/;
const CONTROL = /[\x00-\x1f\x7f]/;

const ALLOWED_KEYS = new Set([
  'id',
  'label',
  'mark',
  'kind',
  'capabilities',
  'configured',
  'configHint',
  'apiKeyEnv',
  'apiKeyFile',
  'tokenEnv',
  'tokenFile',
  'keyEnv',
  'keyFile',
]);

// Inline credentials are a configuration error, not a feature. These names are
// refused even though the allow-list above would already reject most of them.
const SECRET_KEYS = new Set([
  'apikey',
  'api_key',
  'apisecret',
  'api_secret',
  'secret',
  'token',
  'password',
  'passwd',
  'key',
  'authorization',
  'credential',
  'credentials',
]);

const EMPTY_CAPABILITIES = Object.freeze(Object.fromEntries(
  AGENT_CAPABILITY_KEYS.map(key => [key, false]),
));

export const BUILTIN_AGENT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'hermes',
    label: 'Hermes',
    mark: 'H',
    kind: 'hermes',
    capabilities: Object.freeze({
      compact: true,
      modelSwitch: true,
      contextMeter: true,
      approvals: true,
      streaming: true,
    }),
    configured: false,
    configHint: 'Configure HERMES_API_URL and HERMES_API_KEY, or run a discoverable Hermes API server.',
  }),
  Object.freeze({
    id: 'grok',
    label: 'Grok Bot',
    mark: 'G',
    kind: 'grok',
    capabilities: Object.freeze({
      compact: true,
      modelSwitch: false,
      contextMeter: true,
      approvals: true,
      streaming: true,
    }),
    configured: false,
    configHint: 'Set GROK_BOT_API_URL and GROK_BOT_API_KEY, or install a Grok Bot host gateway.',
  }),
  Object.freeze({
    id: 'pi',
    label: 'Pi',
    mark: 'P',
    kind: 'pi',
    capabilities: Object.freeze({
      compact: true,
      modelSwitch: true,
      contextMeter: true,
      approvals: false,
      streaming: true,
    }),
    configured: false,
    configHint: 'Set PI_GATEWAY_URL and PI_GATEWAY_TOKEN, or install the Pi harness on this computer.',
  }),
]);

function invalid(reason) {
  throw new Error(`Invalid agent provider definition: ${reason}.`);
}

function invalidConfig() {
  throw new Error('Invalid agent configuration.');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(definition) {
  return {
    ...definition,
    capabilities: { ...definition.capabilities },
  };
}

function normalizeSecretKey(key) {
  return String(key).replace(/[-_]/g, '').toLowerCase();
}

function validateKeyReference(value, field) {
  if (field.endsWith('Env')) {
    if (typeof value !== 'string' || !ENV_NAME.test(value)) invalid(`${field} must be an environment-variable name`);
    return value;
  }
  if (typeof value !== 'string' || !KEY_FILE.test(value) || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    invalid(`${field} must be a key-file name, not a path`);
  }
  return value;
}

/** Validate one adapter definition and return a normalized copy. No value is echoed in errors. */
export function validateAgentDefinition(value) {
  if (!isPlainObject(value)) invalid('definition must be an object');
  for (const key of Object.keys(value)) {
    if (SECRET_KEYS.has(normalizeSecretKey(key))) {
      invalid('inline secrets are not allowed; reference an environment name or key-file name');
    }
    if (!ALLOWED_KEYS.has(key)) invalid(`unknown field ${key}`);
  }

  if (typeof value.id !== 'string' || !AGENT_PROVIDER_ID.test(value.id)) invalid('id');
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80 || CONTROL.test(value.label)) invalid('label');
  if (typeof value.mark !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,2}$/u.test(value.mark)) invalid('mark');
  if (typeof value.kind !== 'string' || !KIND.test(value.kind)) invalid('kind');
  if (typeof value.configured !== 'boolean') invalid('configured');
  if (typeof value.configHint !== 'string' || value.configHint.length > 400 || CONTROL.test(value.configHint)) invalid('configHint');
  if (!isPlainObject(value.capabilities)) invalid('capabilities');

  const capabilities = {};
  for (const key of Object.keys(value.capabilities)) {
    if (!AGENT_CAPABILITY_KEYS.includes(key)) invalid(`unknown capability ${key}`);
    if (typeof value.capabilities[key] !== 'boolean') invalid(`capability ${key}`);
    capabilities[key] = value.capabilities[key];
  }
  for (const key of AGENT_CAPABILITY_KEYS) {
    if (capabilities[key] === undefined) capabilities[key] = false;
  }

  const definition = {
    id: value.id,
    label: value.label,
    mark: value.mark,
    kind: value.kind,
    capabilities: Object.freeze(capabilities),
    configured: value.configured,
    configHint: value.configHint,
  };
  for (const field of ['apiKeyEnv', 'apiKeyFile', 'tokenEnv', 'tokenFile', 'keyEnv', 'keyFile']) {
    if (value[field] !== undefined) definition[field] = validateKeyReference(value[field], field);
  }
  return Object.freeze(definition);
}

/** Parse JSON or an already-decoded agents configuration. */
export function parseAgentConfig(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      invalidConfig();
    }
  }
  if (parsed === undefined || parsed === null) invalidConfig();
  if (Array.isArray(parsed)) return parsed.map(validateAgentDefinition);
  if (!isPlainObject(parsed)) invalidConfig();
  for (const key of Object.keys(parsed)) {
    if (!['version', 'agents'].includes(key)) invalidConfig();
  }
  if (parsed.version !== undefined && parsed.version !== 1) invalidConfig();
  if (!Array.isArray(parsed.agents)) invalidConfig();
  return parsed.agents.map(validateAgentDefinition);
}

/** <runtime>/agents.json unless ORBIT_AGENTS_FILE names an absolute file. */
export function agentConfigPath({ env = process.env, runtimeDir } = {}) {
  const explicit = typeof env?.ORBIT_AGENTS_FILE === 'string' ? env.ORBIT_AGENTS_FILE.trim() : '';
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('Invalid agent configuration: ORBIT_AGENTS_FILE must be an absolute path.');
    return path.resolve(explicit);
  }
  const root = runtimeDir || env?.ORBIT_RUNTIME_DIR || fileURLToPath(new URL('../.runtime/', import.meta.url));
  return path.join(path.resolve(root), 'agents.json');
}

function loadConfigFile(file, readFile) {
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    invalidConfig();
  }
  return parseAgentConfig(String(text));
}

/** Built-in adapters, marked configured only for providers discovery actually found. */
export function builtinAgentDefinitions({ discovered } = {}) {
  return BUILTIN_AGENT_DEFINITIONS.map(definition => {
    const found = Array.isArray(discovered)
      ? discovered.includes(definition.id)
      : Boolean(discovered && discovered[definition.id]);
    return validateAgentDefinition({ ...definition, capabilities: { ...definition.capabilities }, configured: found });
  });
}

export function createAgentRegistry({
  builtins = builtinAgentDefinitions(),
  config,
  configPath,
  env = process.env,
  runtimeDir,
  readFile = fs.readFileSync,
} = {}) {
  if (!Array.isArray(builtins)) invalidConfig();
  const definitions = new Map();
  for (const definition of builtins) {
    const normalized = validateAgentDefinition(definition);
    definitions.set(normalized.id, normalized);
  }

  const entries = config !== undefined
    ? parseAgentConfig(config)
    : loadConfigFile(configPath || agentConfigPath({ env, runtimeDir }), readFile);
  for (const definition of entries) definitions.set(definition.id, definition);

  const publicDefinition = definition => clone(definition);
  const describeUnknown = id => ({
    id: typeof id === 'string' && AGENT_PROVIDER_ID.test(id) ? id : 'unknown',
    label: 'Unconfigured adapter',
    mark: '?',
    kind: 'unknown',
    capabilities: { ...EMPTY_CAPABILITIES },
    configured: false,
    configHint: 'No adapter is registered for this id.',
    state: 'unconfigured',
  });

  function list() {
    return [...definitions.values()].map(publicDefinition);
  }

  function get(id) {
    if (typeof id !== 'string') return null;
    const definition = definitions.get(id);
    return definition ? publicDefinition(definition) : null;
  }

  function describe(id) {
    const definition = get(id);
    if (!definition) return describeUnknown(id);
    return { ...definition, state: definition.configured ? 'configured' : 'unconfigured' };
  }

  function register(definition) {
    const normalized = validateAgentDefinition(definition);
    definitions.set(normalized.id, normalized);
    return publicDefinition(normalized);
  }

  /** A direct, public zero/ready projection for health and setup surfaces. */
  function summary() {
    const all = list();
    const configured = all.filter(definition => definition.configured);
    return {
      state: configured.length ? 'ready' : 'no-agents-configured',
      message: configured.length
        ? ''
        : 'No agents configured. Add an adapter in agents.json or configure an agent environment.',
      total: all.length,
      configured: configured.map(({ id, label, mark, kind }) => ({ id, label, mark, kind })),
      agents: all,
    };
  }

  return {
    list,
    get,
    register,
    describe,
    summary,
  };
}
