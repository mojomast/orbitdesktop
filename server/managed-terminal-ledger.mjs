import { lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { paneIdFromSessionName, isIdentifier, TOKEN_PATTERN } from './managed-terminal-contract.mjs';

export class ManagedTerminalLedgerError extends Error {
  constructor(code) { super(`Managed terminal ledger: ${code}`); this.name = 'ManagedTerminalLedgerError'; this.code = code; }
}
const fail = code => { throw new ManagedTerminalLedgerError(code); };

// Durable marker that the private ledger directory was initialized. Its presence
// with a missing ledger file means the ledger was lost (fail closed); its absence
// with a missing ledger file means a fresh install.
export const LEDGER_SENTINEL_SUFFIX = '.initialized';
export function privateDirectory(directory) {
  try {
    const s = lstatSync(directory);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) fail('invalid_request');
  } catch { fail('invalid_request'); }
}
export function readPrivateJSON(file) {
  try {
    const s = lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > 4 * 1024 * 1024) fail('provider_error');
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value === null) fail('provider_error');
    return value;
  } catch (e) { if (e.code === 'ENOENT') return null; fail('provider_error'); }
}
export function writePrivateJSON(file, value) {
  privateDirectory(path.dirname(file));
  const temp = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file);
    fd = openSync(path.dirname(file), 'r'); fsyncSync(fd); closeSync(fd); fd = undefined;
  } catch { fail('provider_error'); }
  finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
}
const keys = ['version', 'sessionName', 'workspaceId', 'mode', 'serverEpoch', 'shellInstance', 'sessionId', 'paneId', 'serverPid', 'shellPid', 'bootId', 'serverStarttime', 'shellStarttime', 'adoptedAt'];
function validate(e) {
  if (!e || Object.getPrototypeOf(e) !== Object.prototype || Reflect.ownKeys(e).length !== keys.length ||
      keys.some(k => !Object.hasOwn(e, k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(e, k), 'value'))) fail('provider_error');
  const match = (k, re) => typeof e[k] === 'string' && re.test(e[k]);
  if (e.version !== 1 || e.mode !== 'attach' || !paneIdFromSessionName(e.sessionName) || !isIdentifier(e.workspaceId) ||
      !match('serverEpoch', TOKEN_PATTERN) || !match('shellInstance', TOKEN_PATTERN) ||
      !match('sessionId', /^\$\d{1,20}$/) || !match('paneId', /^%\d{1,20}$/) ||
      !['serverPid', 'shellPid', 'serverStarttime', 'shellStarttime'].every(k => match(k, /^[1-9]\d{0,19}$/)) ||
      !match('bootId', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) ||
      !Number.isSafeInteger(e.adoptedAt) || e.adoptedAt < 0) fail('provider_error');
  return Object.freeze({ ...e });
}
export class ManagedTerminalIdentityLedger {
  #file; #sentinelPath; #entries = new Map(); #loaded = false; #lost = false;
  constructor({ directory, filename = 'identity-ledger.json' }) {
    privateDirectory(directory);
    if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(filename)) fail('invalid_request');
    this.#file = path.join(directory, filename);
    this.#sentinelPath = path.join(directory, filename + LEDGER_SENTINEL_SUFFIX);
  }
  get loaded() { return this.#loaded; }
  // True when this private directory was initialized before but the ledger file is
  // now missing. This distinguishes a lost ledger from a fresh install so callers
  // can fail closed instead of treating every old pane as unmanaged.
  get lost() { return this.#lost; }
  async load() {
    if (this.#loaded) return this;
    const data = readPrivateJSON(this.#file);
    if (data === null) {
      if (readPrivateJSON(this.#sentinelPath) !== null) { this.#lost = true; fail('unavailable'); }
      // Fresh install: persist BOTH an empty ledger and a durable initialized
      // sentinel. Without the empty ledger file, the next restart would see a
      // sentinel with no ledger and misread an untouched fresh install as loss.
      writePrivateJSON(this.#file, []);
      writePrivateJSON(this.#sentinelPath, { version: 1, createdAt: Date.now() });
    } else {
      if (!Array.isArray(data)) fail('provider_error');
      const entries = new Map();
      for (const value of data) { const e = validate(value); if (entries.has(e.sessionName)) fail('provider_error'); entries.set(e.sessionName, e); }
      this.#entries = entries;
      // Upgrade/repair: a present ledger is itself proof of prior initialization.
      if (readPrivateJSON(this.#sentinelPath) === null) writePrivateJSON(this.#sentinelPath, { version: 1, createdAt: Date.now() });
    }
    this.#loaded = true; return this;
  }
  #ready() { if (!this.#loaded) fail('unavailable'); }
  get(sessionName) { this.#ready(); const e = this.#entries.get(sessionName); return e ? Object.freeze({ ...e }) : null; }
  list() { this.#ready(); return Object.freeze([...this.#entries.values()].map(e => Object.freeze({ ...e }))); }
  get size() { this.#ready(); return this.#entries.size; }
  async put(value) { this.#ready(); const e = validate(value); const next = new Map(this.#entries); next.set(e.sessionName, e); writePrivateJSON(this.#file, [...next.values()]); this.#entries = next; }
  async remove(name) { this.#ready(); const next = new Map(this.#entries); next.delete(name); writePrivateJSON(this.#file, [...next.values()]); this.#entries = next; }
}
