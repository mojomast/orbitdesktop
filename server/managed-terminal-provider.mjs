import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

// Internal, opt-in lifecycle infrastructure. Tokens are continuity metadata, not
// authentication against another process running as this OS user.
const exec = promisify(execFile);
const codes = new Set(['invalid_request', 'conflict', 'unavailable', 'provider_error', 'timeout', 'busy']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const token = /^[A-Za-z0-9_-]{32,128}$/;
const pane = /^%[0-9]{1,20}$/;
const randomToken = () => randomBytes(32).toString('hex');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const same = (a, b) => a !== null && b !== null && Object.keys(a).every((key) => a[key] === b[key]);
const diagnostics = new WeakMap();
const format = '#{session_name}|#{session_id}|#{pane_id}|#{pid}|#{pane_pid}|#{@orbit_managed_epoch}|#{@orbit_managed_shell}|#{@orbit_managed_session_epoch}';

export const MANAGED_TERMINAL_DEFAULTS = Object.freeze({
  shell: '/bin/bash', envAllowlist: Object.freeze({}), timeoutMs: 1000,
  maxConcurrent: 8, maxOutputBytes: 4096, removeDirectoryOnDispose: false,
});

export class ManagedTerminalProviderError extends Error {
  constructor(code) {
    const category = codes.has(code) ? code : 'provider_error';
    super(`Managed terminal provider: ${category}`);
    this.name = 'ManagedTerminalProviderError';
    this.code = category;
  }
}

function fail(code) { throw new ManagedTerminalProviderError(code); }

function record(value, allowed) {
  if (!value || typeof value !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_request');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || (allowed && !allowed.includes(key)) ||
        !Object.hasOwn(descriptors[key], 'value')) fail('invalid_request');
    copy[key] = descriptors[key].value;
  }
  return copy;
}

function requestName(request, keys = ['sessionName']) {
  const copy = record(request, keys);
  if (!matches(copy.sessionName, identifier)) fail('invalid_request');
  return copy;
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    fail('provider_error');
  }
}

export class ManagedTerminalProvider {
  #config;
  #socketPath;
  #lockPath;
  #started = false;
  #disposed = false;
  #lockToken = null;
  #serverEpoch = null;
  #serverPid = null;
  #serverKernel = null;
  #ledger = new Map();
  #generation = 0;
  #outstanding = 0;
  #tail = Promise.resolve();

  constructor(options) {
    const supplied = record(options, ['directory', 'socket', 'shell', 'cwd', 'envAllowlist',
      'timeoutMs', 'maxConcurrent', 'maxOutputBytes', 'removeDirectoryOnDispose']);
    const config = { ...MANAGED_TERMINAL_DEFAULTS, ...supplied };
    if (!Object.hasOwn(supplied, 'cwd')) config.cwd = config.directory;
    for (const key of ['directory', 'cwd', 'shell']) {
      if (!matches(config[key], /^\/[^\0]*$/)) fail('invalid_request');
    }
    if (!matches(config.socket, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/) ||
        config.socket === 'orbit-persistent') fail('invalid_request');
    for (const [key, min, max] of [['timeoutMs', 1, 5000], ['maxConcurrent', 1, 16], ['maxOutputBytes', 256, 65536]]) {
      if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) fail('invalid_request');
    }
    if (typeof config.removeDirectoryOnDispose !== 'boolean') fail('invalid_request');
    config.envAllowlist = record(config.envAllowlist);
    for (const [key, value] of Object.entries(config.envAllowlist)) {
      if (!key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')) fail('invalid_request');
      // An allowlist cannot redirect this provider to another namespace or attach
      // through an inherited TMUX address. Reject rather than silently override.
      if (key === 'TMUX' || (key === 'TMUX_TMPDIR' && value !== config.directory)) fail('invalid_request');
    }
    config.envAllowlist = Object.freeze(config.envAllowlist);
    this.#config = Object.freeze(config);
    this.#socketPath = path.join(config.directory, `tmux-${process.getuid()}`, config.socket);
    this.#lockPath = path.join(config.directory, 'managed-provider.lock');
  }

  get started() { return this.#started; }
  get socket() { return this.#config.socket; }
  get serverEpoch() { return this.#serverEpoch; }

  static async create(options) {
    const provider = new ManagedTerminalProvider(options);
    await provider.start();
    return provider;
  }

  #serialized(work) {
    const result = this.#tail.then(work).catch((error) => {
      if (error instanceof ManagedTerminalProviderError) throw error;
      fail('provider_error');
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  #sanitizeEnv() {
    return { PATH: process.env.PATH || '/usr/bin:/bin', HOME: this.#config.directory,
      TMUX_TMPDIR: this.#config.directory, SHELL: this.#config.shell, LC_ALL: 'C',
      TERM: 'xterm-256color', ...this.#config.envAllowlist };
  }

  async #tmux(args, { signal, timeoutMs = this.#config.timeoutMs } = {}) {
    try {
      const { stdout } = await exec('/usr/bin/tmux', ['-L', this.socket, '-f', '/dev/null', ...args], {
        cwd: this.#config.cwd, env: this.#sanitizeEnv(), timeout: timeoutMs,
        maxBuffer: this.#config.maxOutputBytes, signal, killSignal: 'SIGKILL', windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const mapped = new ManagedTerminalProviderError(
        signal?.aborted || error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR' ||
        (error.killed && error.signal === 'SIGKILL') ? 'timeout' : 'provider_error');
      // Keep diagnostics private, out of Error properties/messages/causes.
      diagnostics.set(mapped, { code: error.code, stderr: error.stderr });
      throw mapped;
    }
  }

  #isAbsentError(error) {
    const diagnostic = diagnostics.get(error);
    if (diagnostic?.code !== 1 || typeof diagnostic.stderr !== 'string') return false;
    const text = diagnostic.stderr.trim();
    return text === `no server running on ${this.#socketPath}` ||
      text === `error connecting to ${this.#socketPath} (No such file or directory)` ||
      /^can't find (?:session|pane|window): [^\r\n]+$/.test(text);
  }

  async start() {
    return this.#serialized(async () => {
      if (this.#disposed) fail('unavailable');
      if (this.#started) return this;
      try {
        const directory = await lstat(this.#config.directory);
        if (!directory.isDirectory() || directory.uid !== process.getuid() ||
            (directory.mode & 0o077) !== 0) fail('invalid_request');
      }
      catch { fail('invalid_request'); }
      if ((await readdir(this.#config.directory)).some(name => name !== `tmux-${process.getuid()}`)) fail('conflict');
      if (await exists(this.#socketPath) || await exists(this.#lockPath)) fail('conflict');
      try {
        if ((await readdir(path.dirname(this.#socketPath))).length) fail('conflict');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await this.#tmux(['list-sessions']); fail('conflict'); }
      catch (error) { if (!this.#isAbsentError(error)) throw error; }
      const lockToken = randomToken();
      try {
        await writeFile(this.#lockPath, JSON.stringify({ token: lockToken, socket: this.socket, pid: process.pid }), { flag: 'wx' });
      } catch (error) { fail(error.code === 'EEXIST' ? 'conflict' : 'provider_error'); }
      this.#lockToken = lockToken;
      this.#started = true;
      this.#serverEpoch = null;
      this.#ledger = new Map();
      return this;
    });
  }

  #invalidateAll() { this.#ledger.clear(); this.#generation++; }
  invalidate() { this.#invalidateAll(); }
  #drop(name, entry) { if (this.#ledger.get(name) === entry) this.#ledger.delete(name); }

  // Recheck the marker on the SAME tmux command queue as the destructive action.
  // A read in one client followed by kill in another is vulnerable to a server
  // restart/target replacement in between (even when the earlier read was valid).
  async #killMarkedServer(epoch, timeoutMs = this.#config.timeoutMs) {
    if (!matches(epoch, token)) return false;
    const result = await this.#tmux(['if-shell', '-F', `#{==:#{@orbit_managed_epoch},${epoch}}`,
      'kill-server', 'display-message -p managed-not-owned'], { timeoutMs });
    return !result.includes('managed-not-owned');
  }

  async #killMarkedSession(identity) {
    const checks = [
      ['pid', identity.serverPid], ['pane_pid', identity.shellPid],
      ['session_id', identity.sessionId], ['pane_id', identity.paneId],
      ['@orbit_managed_epoch', identity.serverEpoch],
      ['@orbit_managed_shell', identity.shell],
      ['@orbit_managed_session_epoch', identity.sessionEpoch],
    ].map(([key, value]) => `#{==:#{${key}},${value}}`);
    const condition = checks.reduce((a, b) => `#{&&:${a},${b}}`);
    const result = await this.#tmux(['if-shell', '-F', '-t', identity.paneId, condition,
      `kill-session -t ${identity.sessionId}`, 'display-message -p managed-not-owned']);
    return !result.includes('managed-not-owned');
  }

  async #probe(target, options) {
    let text;
    try { text = await this.#tmux(['display-message', '-p', '-t', target, format], options); }
    catch (error) { if (this.#isAbsentError(error)) return null; throw error; }
    const fields = text.replace(/\n$/, '').split('|');
    const [sessionName, sessionId, paneId, serverPid, shellPid, serverEpoch, shell, sessionEpoch] = fields;
    if (fields.length === 8 && (sessionName === '' || paneId === '')) return null;
    if (fields.length !== 8 || !matches(sessionName, identifier) || !matches(sessionId, /^\$[0-9]{1,20}$/) ||
        !matches(paneId, pane) || (pane.test(target) && paneId !== target) ||
        !matches(serverPid, /^\d+$/) || !matches(shellPid, /^\d+$/) ||
        ![serverEpoch, shell, sessionEpoch].every((value) => value === '' || matches(value, token))) {
      this.#invalidateAll();
      fail('provider_error');
    }
    return { sessionName, sessionId, paneId, serverPid, shellPid, serverEpoch, shell, sessionEpoch };
  }

  async #kernelIdentity(serverPid, shellPid, signal) {
    try {
      const [server, shell, boot] = await Promise.all([
        readFile(`/proc/${serverPid}/stat`, { encoding: 'utf8', signal }),
        readFile(`/proc/${shellPid}/stat`, { encoding: 'utf8', signal }),
        readFile('/proc/sys/kernel/random/boot_id', { encoding: 'utf8', signal }),
      ]);
      const starttime = (text) => {
        if (text.lastIndexOf(')') < 0) return null;
        const value = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
        return matches(value, /^\d+$/) && BigInt(value) > 0n ? value : null;
      };
      const serverStarttime = starttime(server);
      const shellStarttime = starttime(shell);
      const bootId = boot.trim();
      if (!serverStarttime || !shellStarttime || !/^[a-f0-9-]{36}$/.test(bootId)) return null;
      return { bootId, serverStarttime, shellStarttime };
    } catch { return null; }
  }

  async createSession(request) {
    const { sessionName } = requestName(request);
    return this.#serialized(async () => {
      if (!this.#started || this.#disposed) fail('unavailable');
      if (this.#ledger.has(sessionName)) fail('conflict');
      let justStarted = false;
      try { await this.#tmux(['list-sessions']); }
      catch (error) {
        if (!this.#isAbsentError(error)) throw error;
        this.#serverEpoch = randomToken();
        this.#invalidateAll();
        this.#serverPid = null;
        this.#serverKernel = null;
        justStarted = true;
      }
      if (!justStarted) {
        const epoch = (await this.#tmux(['show-options', '-gqv', '@orbit_managed_epoch'])).trim();
        if (!matches(epoch, token) || epoch !== this.#serverEpoch) fail('conflict');
      }
      const generation = this.#generation;
      const shellInstance = randomToken();
      const epoch = this.#serverEpoch;
      let created = false;
      let owned = null;
      try {
        await this.#tmux(['new-session', '-d', '-s', sessionName, '-c', this.#config.cwd, this.#config.shell]);
        created = true;
        if (justStarted) await this.#tmux(['set-option', '-g', '@orbit_managed_epoch', epoch]);
        // tmux 3.5a set-option does not accept =name (unlike display-message).
        // Resolve the exact selector first, then write only through its $N ID.
        const initial = await this.#probe(`=${sessionName}:0.0`);
        if (!initial || initial.sessionName !== sessionName || initial.serverEpoch !== epoch) fail('unavailable');
        await this.#tmux(['set-option', '-t', initial.sessionId, '@orbit_managed_shell', shellInstance]);
        await this.#tmux(['set-option', '-t', initial.sessionId, '@orbit_managed_session_epoch', epoch]);
        const p1 = await this.#probe(`=${sessionName}:0.0`);
        const kernel = p1 && await this.#kernelIdentity(p1.serverPid, p1.shellPid);
        const p2 = p1 && await this.#probe(p1.paneId);
        if (!same(p1, p2) || !kernel || p1.sessionName !== sessionName ||
            p1.sessionId !== initial.sessionId || p1.paneId !== initial.paneId ||
            p1.serverPid !== initial.serverPid || p1.shellPid !== initial.shellPid ||
            p1.serverEpoch !== epoch || p1.shell !== shellInstance || p1.sessionEpoch !== epoch) fail('unavailable');
        owned = { serverEpoch: epoch, shellInstance, sessionId: p1.sessionId, paneId: p1.paneId,
          serverPid: p1.serverPid, shellPid: p1.shellPid, ...kernel };
        this.#serverPid = p1.serverPid;
        this.#serverKernel = kernel;
        if (generation !== this.#generation) fail('unavailable');
        this.#ledger.set(sessionName, owned);
        return Object.freeze({ sessionName, serverEpoch: epoch, sessionId: p1.sessionId, paneId: p1.paneId, shellInstance });
      } catch (error) {
        if (created) {
          try {
            // A name may have been replaced since new-session. Missing proof is
            // a reason to leave cleanup to the operator, never to kill by name.
            const p = await this.#probe(owned?.paneId || `=${sessionName}:0.0`);
            if (p && p.sessionName === sessionName && p.serverEpoch === epoch &&
                p.shell === shellInstance && p.sessionEpoch === epoch &&
                (!owned || (p.sessionId === owned.sessionId && p.serverPid === owned.serverPid))) {
              await this.#killMarkedSession(p);
            }
          } catch { /* best effort, preserving the original typed failure */ }
        }
        // An earlier absent-server check is not ownership proof: another client
        // can win the startup race. Clean up only after our unpredictable epoch
        // was installed. A missing marker leaves uncertain residue for explicit
        // operator cleanup, rather than risking a foreign server's termination.
        if (justStarted) {
          try {
            const observed = (await this.#tmux(['show-options', '-gqv', '@orbit_managed_epoch'],
              { timeoutMs: 2000 })).trim();
            if (observed === epoch) {
              await this.#killMarkedServer(epoch, 2000);
            }
          } catch { /* uncertain ownership or already gone: never force cleanup */ }
        }
        throw error;
      }
    });
  }

  async inspectExact(request) {
    const { sessionName, signal } = requestName(request, ['sessionName', 'signal']);
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid_request');
    if (!this.#started || this.#disposed) return null;
    const entry = this.#ledger.get(sessionName);
    if (!entry) return null;
    if (this.#outstanding >= this.#config.maxConcurrent) fail('busy');
    this.#outstanding++;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const deadline = performance.now() + this.#config.timeoutMs;
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    const check = () => { if (combined.aborted || performance.now() >= deadline) fail('timeout'); };
    const probe = async () => {
      check();
      const value = await this.#probe(entry.paneId, { signal: combined,
        timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) });
      check();
      if (value && value.serverEpoch !== this.#serverEpoch) this.#invalidateAll();
      return value;
    };
    try {
      const p1 = await probe();
      if (!p1) { this.#drop(sessionName, entry); return null; }
      const k1 = await this.#kernelIdentity(p1.serverPid, p1.shellPid, combined);
      check();
      if (!k1) { this.#drop(sessionName, entry); return null; }
      const p2 = await probe();
      if (!same(p1, p2)) { this.#drop(sessionName, entry); return null; }
      const k2 = await this.#kernelIdentity(p2.serverPid, p2.shellPid, combined);
      check();
      if (!same(k1, k2) || p1.sessionName !== sessionName || p1.sessionId !== entry.sessionId ||
          p1.paneId !== entry.paneId || p1.serverEpoch !== entry.serverEpoch ||
          entry.serverEpoch !== this.#serverEpoch || p1.shell !== entry.shellInstance ||
          p1.sessionEpoch !== this.#serverEpoch || p1.serverPid !== entry.serverPid ||
          p1.shellPid !== entry.shellPid || !same(k1, entry)) {
        this.#drop(sessionName, entry);
        return null;
      }
      if (!this.#started || this.#disposed || this.#ledger.get(sessionName) !== entry) return null;
      return Object.freeze({ serverEpoch: entry.serverEpoch, sessionId: entry.sessionId,
        paneId: entry.paneId, shellInstance: entry.shellInstance });
    } catch (error) {
      this.#drop(sessionName, entry);
      if (error instanceof ManagedTerminalProviderError) throw error;
      fail('provider_error');
    } finally { clearTimeout(timer); this.#outstanding--; }
  }

  async closeSession(request) {
    const { sessionName } = requestName(request);
    return this.#serialized(async () => {
      if (!this.#started || this.#disposed || !this.#ledger.has(sessionName)) fail('unavailable');
      const entry = this.#ledger.get(sessionName);
      // Verify before mutation: the name alone does not authorize cleanup.
      const current = await this.inspectExact({ sessionName });
      this.#drop(sessionName, entry);
      if (!current) return false;
      try {
        return await this.#killMarkedSession({ ...entry, shell: entry.shellInstance,
          sessionEpoch: entry.serverEpoch });
      }
      catch (error) { if (this.#isAbsentError(error)) return false; throw error; }
    });
  }

  async dispose() {
    return this.#serialized(async () => {
      if (this.#disposed) return;
      this.#disposed = true;
      this.#started = false;
      this.#invalidateAll();
      try {
        if (this.#serverPid && this.#serverEpoch) {
          const pid = (await this.#tmux(['display-message', '-p', '#{pid}'])).trim();
          const epoch = (await this.#tmux(['show-options', '-gqv', '@orbit_managed_epoch'])).trim();
          const kernel = await this.#kernelIdentity(pid, pid);
          if (pid === this.#serverPid && epoch === this.#serverEpoch && kernel &&
              kernel.bootId === this.#serverKernel?.bootId &&
               kernel.serverStarttime === this.#serverKernel?.serverStarttime) await this.#killMarkedServer(this.#serverEpoch);
        }
      } catch { /* uncertain ownership or unavailable server: never force cleanup */ }
      let releasedLock = false;
      if (this.#lockToken) {
        try {
          const lock = JSON.parse(await readFile(this.#lockPath, 'utf8'));
          if (lock.token === this.#lockToken) {
            await unlink(this.#lockPath);
            releasedLock = true;
          }
        } catch { /* absent, changed or inaccessible lock is not ours to remove */ }
      }
      this.#lockToken = null;
      this.#serverEpoch = null;
      if (releasedLock && this.#config.removeDirectoryOnDispose) {
        try { await rmdir(this.#config.directory); } catch { /* only remove an empty directory */ }
      }
    });
  }
}
