import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/**
 * Internal, process-local identity prerequisite; intentionally unused by routes.
 * This is neither a grant nor permission to read, attach, create or control a PTY.
 * Nothing is persisted. A new registry always starts with a fresh random epoch.
 *
 * Trusted integration code constructs one registry with authenticated ownerId,
 * workspaceId and a canonical providerId (the same ID for the same namespace in
 * every registrar). These identifiers are not inferred from a layout pane.
 * register({sessionName}) explicitly binds an EXISTING exact terminal and returns
 * a frozen binding. lookup(binding) revalidates all provider identity fields and
 * returns that binding or null when unknown, revoked, foreign, missing or changed.
 * Invalid input and operational failure throw TerminalResourceRegistryError.
 * revoke(binding)/unregister(binding) synchronously remove an exact binding;
 * invalidate() synchronously fences all bindings AND pending registrations and
 * rotates registryEpoch. Replacement requires this explicit lifecycle first.
 * A stale asynchronous completion cannot restore a removed binding.
 *
 * Adapter contract: inspectExact({sessionName, signal}) asynchronously returns
 * exactly {serverEpoch, sessionId, paneId, shellInstance}, or null for absent or
 * uncertain identity. It must inspect only the exact existing target, without
 * creation, attachment, output capture, metadata mutation or enumeration. Its
 * serverEpoch and shellInstance are trusted provider-issued random tokens (at
 * least 128 bits of entropy), never PID/time/counter-derived proofs. It verifies
 * BOTH on EVERY call, rotates on server/shell replacement (including respawn),
 * and returns null or throws whenever lifecycle continuity cannot be proved.
 * Session/pane IDs alone do not establish continuity. Tokens cannot be copied to
 * a replacement or silently overwritten by another registrar. The adapter must
 * bound any subprocess output and honor cancellation where possible.
 *
 * There is deliberately NO real tmux integration: LocalHostProvider and ordinary
 * tmux PID/timestamp metadata cannot satisfy this contract. Validation can check
 * token shape, not entropy or honesty of trusted adapter code. This module does
 * not sandbox a blocking adapter or provide cross-process registrar coordination.
 * Module-local reservations reject independent registrars for the same canonical
 * provider/session; another process requires a future exclusive provider broker.
 *
 * Defaults: 1s inspection deadline, four outstanding inspections, no work queue.
 * Hard configurable caps: 5s and 16. A timed-out adapter keeps its concurrency
 * slot until it actually settles, so ignoring abort cannot grow outstanding work.
 * Invalidation does not reset those slots. Callers must not persist bindings in
 * layouts, checkpoints, receipts or logs; they are internal identity metadata.
 */

const ERROR_CODES = new Set([
  'invalid_request', 'conflict', 'unavailable', 'provider_error', 'timeout', 'busy',
]);
const claims = new Map();
const scopeKeys = ['ownerId', 'workspaceId', 'providerId'];
const identityKeys = ['serverEpoch', 'sessionId', 'paneId', 'shellInstance'];
const bindingKeys = [...scopeKeys, 'registryEpoch', 'bindingToken', 'sessionName', ...identityKeys];
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const token = /^[A-Za-z0-9_-]{32,128}$/;
const randomToken = () => randomBytes(32).toString('hex');

export class TerminalResourceRegistryError extends Error {
  constructor(code) {
    const category = ERROR_CODES.has(code) ? code : 'provider_error';
    super(`Terminal resource registry: ${category}`);
    this.name = 'TerminalResourceRegistryError';
    this.code = category;
  }
}

function fail(code) { throw new TerminalResourceRegistryError(code); }

// Reject extras, accessors, symbols and exotic objects; take a detached snapshot
// before any await. No caller mutation can change the scope of in-flight work.
function record(value, keys) {
  if (!value || typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_request');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) fail('invalid_request');
  const copy = {};
  for (const key of keys) {
    if (!Object.hasOwn(descriptors[key], 'value')) fail('invalid_request');
    copy[key] = descriptors[key].value;
  }
  return copy;
}

function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }

function validateIdentity(value) {
  const identity = record(value, identityKeys);
  if (!matches(identity.serverEpoch, token) || !matches(identity.shellInstance, token) ||
      !matches(identity.sessionId, /^\$[0-9]{1,20}$/) ||
      !matches(identity.paneId, /^%[0-9]{1,20}$/)) fail('invalid_request');
  return identity;
}

function validateBinding(value) {
  const binding = record(value, bindingKeys);
  for (const key of [...scopeKeys, 'sessionName']) {
    if (!matches(binding[key], identifier)) fail('invalid_request');
  }
  for (const key of ['registryEpoch', 'bindingToken']) {
    if (!matches(binding[key], /^[a-f0-9]{64}$/)) fail('invalid_request');
  }
  validateIdentity(Object.fromEntries(identityKeys.map((key) => [key, binding[key]])));
  return binding;
}

export class TerminalResourceRegistry {
  #scope;
  #inspectExact;
  #timeoutMs;
  #maxConcurrent;
  #outstanding = 0;
  #epoch = randomToken();
  #entries = new Map();

  constructor(options) {
    if (!options || typeof options !== 'object') fail('invalid_request');
    const defaults = { timeoutMs: 1000, maxConcurrent: 4 };
    // Validate options without invoking getters during defaulting.
    const keys = Reflect.ownKeys(options);
    const allowed = [...scopeKeys, 'adapter', 'timeoutMs', 'maxConcurrent'];
    if (keys.some((key) => !allowed.includes(key))) fail('invalid_request');
    const supplied = record(options, keys);
    const config = { ...defaults, ...supplied };
    for (const key of scopeKeys) if (!matches(config[key], identifier)) fail('invalid_request');
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 5000 ||
        !Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 16 ||
        !config.adapter || typeof config.adapter.inspectExact !== 'function') fail('invalid_request');
    this.#scope = Object.freeze(Object.fromEntries(scopeKeys.map((key) => [key, config[key]])));
    this.#inspectExact = config.adapter.inspectExact.bind(config.adapter);
    this.#timeoutMs = config.timeoutMs;
    this.#maxConcurrent = config.maxConcurrent;
  }

  get registryEpoch() { return this.#epoch; }

  #claimKey(sessionName) { return JSON.stringify([this.#scope.providerId, sessionName]); }

  #current(entry) {
    return entry.epoch === this.#epoch && this.#entries.get(entry.sessionName) === entry &&
      claims.get(entry.claimKey) === entry;
  }

  #remove(entry) {
    if (this.#entries.get(entry.sessionName) === entry) this.#entries.delete(entry.sessionName);
    if (claims.get(entry.claimKey) === entry) claims.delete(entry.claimKey);
  }

  async #inspect(sessionName) {
    if (this.#outstanding >= this.#maxConcurrent) fail('busy');
    this.#outstanding++;
    const controller = new AbortController();
    const deadline = performance.now() + this.#timeoutMs;
    let timer;
    const work = Promise.resolve().then(() => this.#inspectExact({ sessionName, signal: controller.signal }));
    // Handle rejection even when the deadline wins; never retain raw provider errors.
    const inspected = work.then((value) => {
      if (value === null) return null;
      try { return validateIdentity(value); } catch { fail('provider_error'); }
    }, () => fail('provider_error')).finally(() => { this.#outstanding--; });
    try {
      const value = await Promise.race([
        inspected,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new TerminalResourceRegistryError('timeout'));
            controller.abort();
          }, this.#timeoutMs);
        }),
      ]);
      if (performance.now() >= deadline) {
        controller.abort();
        fail('timeout');
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  }

  async register(request) {
    const { sessionName } = record(request, ['sessionName']);
    if (!matches(sessionName, identifier)) fail('invalid_request');
    const claimKey = this.#claimKey(sessionName);
    if (claims.has(claimKey)) fail('conflict');
    const entry = { sessionName, claimKey, epoch: this.#epoch, binding: null };
    // Reserve synchronously BEFORE inspection, including between registrars.
    claims.set(claimKey, entry);
    this.#entries.set(sessionName, entry);
    try {
      const identity = await this.#inspect(sessionName);
      if (!this.#current(entry) || !identity) fail('unavailable');
      entry.binding = Object.freeze({
        ...this.#scope, registryEpoch: this.#epoch, bindingToken: randomToken(), sessionName, ...identity,
      });
      return entry.binding;
    } catch (error) {
      this.#remove(entry);
      throw error;
    }
  }

  #find(binding) {
    if (scopeKeys.some((key) => binding[key] !== this.#scope[key]) || binding.registryEpoch !== this.#epoch) return null;
    const entry = this.#entries.get(binding.sessionName);
    return entry?.binding && this.#current(entry) &&
      bindingKeys.every((key) => entry.binding[key] === binding[key]) ? entry : null;
  }

  async lookup(value) {
    const binding = validateBinding(value);
    const entry = this.#find(binding);
    if (!entry) return null;
    let identity;
    try {
      identity = await this.#inspect(entry.sessionName);
    } catch (error) {
      // Uncertainty invalidates the old incarnation permanently. Capacity denial
      // has not inspected the provider and is not evidence of continuity loss.
      if (error.code !== 'busy') this.#remove(entry);
      throw error;
    }
    if (!this.#current(entry)) return null;
    if (!identity || identityKeys.some((key) => identity[key] !== entry.binding[key])) {
      this.#remove(entry);
      return null;
    }
    // Final synchronous fence is the lookup decision, not a future-use grant.
    return entry.binding;
  }

  revoke(value) {
    const entry = this.#find(validateBinding(value));
    if (!entry) return false;
    this.#remove(entry);
    return true;
  }

  unregister(binding) { return this.revoke(binding); }

  invalidate() {
    for (const entry of this.#entries.values()) this.#remove(entry);
    this.#epoch = randomToken();
  }
}
