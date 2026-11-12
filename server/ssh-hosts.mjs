import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createHostKey,
  defaultExec,
  ensureInstallKey,
  minimalEnv,
  publicKey,
  safeInstallId,
} from './ssh-keys.mjs';
import { sshAlias, validateHostId, writeSshConfig } from './ssh-config.mjs';

/**
 * Orbit's SSH host registry.
 *
 * Actions are local state changes plus system OpenSSH spawns with an argv array,
 * an explicit environment and a timeout. Host keys are verified first-use: a
 * scan reports the fingerprint, the owner confirms it, and only then is the
 * alias pinned in Orbit's own known_hosts. A changed key marks the host
 * `key-changed` and blocks every remote action until the owner re-verifies.
 *
 * UNTESTED: the tailcat ProxyCommand transport and remote authorized_keys
 * cleanup on remove. Both are marked in docs/HOSTS.md and the UI.
 */

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USER = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;
const TAILCAT_ADDR = /^[A-Za-z0-9._:@/+=-]{1,4096}$/;
const TRANSPORTS = new Set(['direct', 'proxyJump', 'tailscale', 'tailcat', 'cloudflare']);
const AUTH_KINDS = new Set(['orbit-key', 'host-key', 'imported', 'certificate', 'tailscale-ssh']);
const PERMISSION_LEVELS = new Set(['none', 'read', 'deploy', 'admin']);
const PERMISSION_KEYS = new Set(['setup', 'pi', 'opencode', 'hermes', 'bundlebees']);

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(value, allowed, label) {
  if (!object(value)) throw new Error(`Invalid SSH ${label}.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown field in SSH ${label}.`);
  }
}

function safeText(value, label, { max = 200, required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return '';
    throw new Error(`SSH ${label} is required.`);
  }
  if (typeof value !== 'string') throw new Error(`Invalid SSH ${label}.`);
  const text = value.trim();
  if (required && !text) throw new Error(`SSH ${label} is required.`);
  if (/[\r\n\0]/.test(value) || text.length > max) throw new Error(`Invalid SSH ${label}.`);
  return text;
}

function safeList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new Error(`Invalid SSH ${label}.`);
  return value.map(item => safeText(item, label, { max: 32 }));
}

function safePort(value, fallback = 22) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && !/^\d{1,5}$/.test(value.trim())) throw new Error('Invalid SSH port.');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port.');
  return port;
}

function validateHostName(value) {
  if (typeof value !== 'string') throw new Error('Invalid SSH address.');
  if (IPV6.test(value) && value.includes(':')) return value;
  if (!HOSTNAME.test(value) || value.includes('..')) throw new Error('Invalid SSH address.');
  return value;
}

/** Parse `user@host[:port]`, bracketed IPv6 and plain host forms. */
export function parseAddress(input) {
  if (typeof input !== 'string') throw new Error('SSH address is required.');
  const raw = input.trim();
  if (!raw || /\s/.test(raw) || raw.includes('\0')) throw new Error('Invalid SSH address.');
  if (raw.startsWith('-')) throw new Error('Invalid SSH address.');
  let user = 'orbit';
  let authority = raw;
  const at = raw.indexOf('@');
  if (at >= 0) {
    if (raw.indexOf('@', at + 1) !== -1) throw new Error('Invalid SSH address.');
    user = raw.slice(0, at);
    authority = raw.slice(at + 1);
    if (!USER.test(user)) throw new Error('Invalid SSH user.');
  }
  if (!authority) throw new Error('Invalid SSH address.');
  let host;
  let port = 22;
  if (authority.startsWith('[')) {
    const match = authority.match(/^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/);
    if (!match) throw new Error('Invalid SSH address.');
    host = match[1];
    if (match[2] !== undefined) port = safePort(match[2]);
  } else {
    const colons = (authority.match(/:/g) || []).length;
    if (colons === 1) {
      const [name, rawPort] = authority.split(':');
      host = name;
      if (!/^\d{1,5}$/.test(rawPort)) throw new Error('Invalid SSH port.');
      port = safePort(rawPort);
    } else if (colons > 1) {
      host = authority;
    } else {
      host = authority;
    }
  }
  validateHostName(host);
  return { user, host, port };
}

/** True only for the OpenSSH "host key changed" class of failure. */
export function isHostKeyChanged(text) {
  const value = String(text || '');
  if (!value) return false;
  if (/No (?:[A-Za-z0-9-]+ )?host key is known/i.test(value)) return false;
  return /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed|host key .* has changed|Host key verification failed/i.test(value);
}

function atomicPrivateWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
  fs.chmodSync(file, 0o600);
}

function refPath(runtimeDir, ref, label) {
  if (!object(ref) || typeof ref.file !== 'string') throw new Error(`SSH ${label} reference is required.`);
  const rel = ref.file;
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !rel.startsWith('ssh/')) {
    throw new Error(`SSH ${label} reference must stay inside the runtime ssh directory.`);
  }
  return path.join(runtimeDir, rel);
}

export function createSshHosts({ runtimeDir, config, exec, log, saveConfig, now = () => new Date() } = {}) {
  if (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir)) throw new Error('SSH hosts require an absolute runtime directory.');
  const root = path.resolve(runtimeDir);
  if (!object(config)) throw new Error('Orbit configuration is required.');
  if (!Array.isArray(config.hosts)) config.hosts = [];
  if (!object(config.components)) config.components = {};
  config.components.hosts = true;
  if (!object(config.ssh)) config.ssh = {};
  if (config.ssh.rotationDays === undefined) config.ssh.rotationDays = 90;
  if (config.ssh.ca === undefined) config.ssh.ca = { enabled: false };
  const run = exec || ((file, args, options = {}) => defaultExec(file, args, {
    ...options,
    env: options.env || minimalEnv(root),
    cwd: options.cwd || root,
  }));
  const pending = new Map();
  let installIdCache;

  const iso = () => new Date(now()).toISOString();

  function save() {
    if (typeof saveConfig === 'function') saveConfig(config);
  }

  function logEvent(message, meta) {
    try { log?.(message, meta); } catch {}
  }

  function sanitize(error) {
    const text = String(error?.stderr || error?.stdout || error?.message || 'command failed');
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  function audit(hostId, entry) {
    try {
      const dir = path.join(root, 'audit', 'hosts');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, `${validateHostId(hostId)}.jsonl`);
      fs.appendFileSync(file, `${JSON.stringify({ time: iso(), hostId, ...entry })}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch {}
  }

  function installId() {
    if (installIdCache) return installIdCache;
    const configured = config.installId;
    if (configured !== undefined) {
      installIdCache = safeInstallId(String(configured));
      return installIdCache;
    }
    const file = path.join(root, 'ssh', 'install-id');
    try {
      installIdCache = safeInstallId(fs.readFileSync(file, 'utf8').trim());
      return installIdCache;
    } catch {}
    const fromKey = String(config.ssh.defaultKey?.publicKey || '').match(/ orbit-([A-Za-z0-9._-]{1,64})$/);
    if (fromKey && HOST_ID.test(fromKey[1])) {
      installIdCache = fromKey[1];
      return installIdCache;
    }
    installIdCache = randomBytes(9).toString('hex');
    atomicPrivateWrite(file, `${installIdCache}\n`);
    return installIdCache;
  }

  async function ensureDefaultKey() {
    if (config.ssh.defaultKey) return config.ssh.defaultKey;
    config.ssh.defaultKey = await ensureInstallKey({ runtimeDir: root, installId: installId(), exec: run });
    save();
    return config.ssh.defaultKey;
  }

  function requireHost(hostId) {
    validateHostId(hostId);
    const host = config.hosts.find(item => item.id === hostId);
    if (!host) throw new Error('Unknown SSH host.');
    return host;
  }

  function view(host) {
    return { ...JSON.parse(JSON.stringify(host)), alias: sshAlias(host.id) };
  }

  function normalizeTransport(value, hostId) {
    const transport = value === undefined ? { kind: 'direct' } : value;
    rejectUnknown(transport, new Set(['kind', 'jumpHostId', 'tailcatAddrRef', 'cloudflareHostname']), 'transport');
    const kind = transport.kind || 'direct';
    if (!TRANSPORTS.has(kind)) throw new Error('Unsupported SSH transport.');
    if (kind === 'proxyJump') {
      const jumpId = validateHostId(transport.jumpHostId);
      if (jumpId === hostId) throw new Error('An SSH host cannot jump through itself.');
      if (!config.hosts.some(item => item.id === jumpId)) throw new Error('The SSH jump host is not managed by Orbit.');
      return { kind, jumpHostId: jumpId, tailcatAddrRef: null, cloudflareHostname: null };
    }
    if (kind === 'tailcat') {
      const file = refPath(root, transport.tailcatAddrRef, 'tailcat address');
      let stat;
      try { stat = fs.lstatSync(file); } catch { throw new Error('SSH tailcat address reference file is missing.'); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024) {
        throw new Error('SSH tailcat address reference must be a 0600 regular file.');
      }
      const address = fs.readFileSync(file, 'utf8').trim();
      if (!address || !TAILCAT_ADDR.test(address)) throw new Error('SSH tailcat address reference is empty or malformed.');
      return { kind, jumpHostId: null, tailcatAddrRef: { file: transport.tailcatAddrRef.file }, cloudflareHostname: null };
    }
    if (kind === 'cloudflare') {
      const hostname = transport.cloudflareHostname ? safeText(transport.cloudflareHostname, 'cloudflare hostname', { max: 253 }) : null;
      if (hostname) validateHostName(hostname);
      return { kind, jumpHostId: null, tailcatAddrRef: null, cloudflareHostname: hostname };
    }
    return { kind, jumpHostId: null, tailcatAddrRef: null, cloudflareHostname: null };
  }

  function normalizeHost(host) {
    if (!object(host)) throw new Error('SSH host is required.');
    rejectUnknown(host, new Set(['id', 'label', 'address', 'port', 'user', 'tags', 'roles', 'transport', 'auth', 'privilege', 'permissions', 'hostKey']), 'host');
    if (host.hostKey !== undefined && host.hostKey !== null) throw new Error('Host keys must be verified with scan and confirm.');
    const id = validateHostId(host.id);
    const parsed = parseAddress(safeText(host.address, 'address', { max: 300 }));
    const user = host.user === undefined ? parsed.user : safeText(host.user, 'user', { max: 32 });
    if (!USER.test(user)) throw new Error('Invalid SSH user.');
    const port = safePort(host.port, parsed.port);
    const transport = normalizeTransport(host.transport, id);
    const authInput = host.auth === undefined ? { kind: 'orbit-key', keyId: 'orbit-default' } : host.auth;
    rejectUnknown(authInput, new Set(['kind', 'keyId']), 'auth');
    const kind = authInput.kind || 'orbit-key';
    if (!AUTH_KINDS.has(kind)) throw new Error('Unsupported SSH authentication kind.');
    let keyId = authInput.keyId;
    if (kind === 'host-key') {
      if (keyId !== undefined && keyId !== `orbit-host-${id}`) throw new Error('Invalid per-host key id.');
      keyId = `orbit-host-${id}`;
    } else if (kind === 'orbit-key') {
      keyId = keyId === undefined ? 'orbit-default' : String(keyId);
      if (!KEY_ID.test(keyId)) throw new Error('Invalid SSH key id.');
    } else if (keyId !== undefined) {
      keyId = safeText(keyId, 'key id', { max: 64 });
      if (!KEY_ID.test(keyId)) throw new Error('Invalid SSH key id.');
    }
    const privilegeInput = host.privilege === undefined ? {} : host.privilege;
    rejectUnknown(privilegeInput, new Set(['sudo', 'docker', 'forcedCommand', 'terminal']), 'privilege');
    const sudo = privilegeInput.sudo ?? 'none';
    const docker = privilegeInput.docker ?? 'none';
    if (!['none', 'scoped', 'full'].includes(sudo)) throw new Error('Invalid sudo privilege.');
    if (!['group', 'rootless', 'none'].includes(docker)) throw new Error('Invalid docker privilege.');
    if (privilegeInput.forcedCommand !== undefined && typeof privilegeInput.forcedCommand !== 'boolean') throw new Error('Invalid forced-command flag.');
    if (privilegeInput.terminal !== undefined && typeof privilegeInput.terminal !== 'boolean') throw new Error('Invalid terminal flag.');
    const permissions = {
      setup: 'deploy',
      pi: 'none',
      opencode: 'none',
      hermes: 'none',
      bundlebees: 'deploy',
    };
    if (host.permissions !== undefined) {
      rejectUnknown(host.permissions, PERMISSION_KEYS, 'permissions');
      for (const [key, value] of Object.entries(host.permissions)) {
        if (!PERMISSION_LEVELS.has(value)) throw new Error('Invalid SSH permission level.');
        permissions[key] = value;
      }
    }
    return {
      id,
      label: host.label === undefined ? '' : safeText(host.label, 'label', { max: 80, required: false }),
      address: parsed.host,
      port,
      user,
      tags: safeList(host.tags, 'tag'),
      roles: safeList(host.roles, 'role'),
      transport,
      auth: keyId === undefined ? { kind } : { kind, keyId },
      privilege: {
        sudo,
        docker,
        forcedCommand: privilegeInput.forcedCommand === true,
        terminal: privilegeInput.terminal === true,
      },
      permissions,
    };
  }

  function hostPublicKey(host) {
    const keyId = host.auth?.kind === 'host-key' ? host.auth.keyId : (host.auth?.keyId || 'orbit-default');
    try {
      return publicKey({ runtimeDir: root, keyId });
    } catch {
      const fallback = config.ssh.defaultKey?.publicKey;
      if (typeof fallback === 'string' && fallback.startsWith('ssh-')) return fallback;
      throw new Error('Orbit SSH public key is unavailable.');
    }
  }

  function authorizedKeysLine(host) {
    return `restrict,pty ${hostPublicKey(host)}`;
  }

  function pendingFile(hostId) {
    return path.join(root, 'ssh', 'pending', `${validateHostId(hostId)}.json`);
  }

  function readPending(hostId) {
    if (pending.has(hostId)) return pending.get(hostId);
    try {
      const parsed = JSON.parse(fs.readFileSync(pendingFile(hostId), 'utf8'));
      if (parsed && typeof parsed.fingerprint === 'string') {
        pending.set(hostId, parsed);
        return parsed;
      }
    } catch {}
    return null;
  }

  function clearPending(hostId) {
    pending.delete(hostId);
    try { fs.rmSync(pendingFile(hostId), { force: true }); } catch {}
  }

  function knownHostsName(alias, port) {
    return port === 22 ? alias : `[${alias}]:${port}`;
  }

  function aliasMatches(first, alias) {
    return first === alias || first.startsWith(`[${alias}]:`);
  }

  function writeKnownHosts(alias, port, publicKeyLine) {
    const file = path.join(root, 'ssh', 'known_hosts');
    const parts = String(publicKeyLine).trim().split(/\s+/);
    if (parts.length < 2) throw new Error('Invalid host public key.');
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {}
    lines = lines.filter(line => line.trim() && !aliasMatches(line.trim().split(/\s+/)[0], alias));
    lines.push(`${knownHostsName(alias, port)} ${parts[0]} ${parts[1]}`);
    atomicPrivateWrite(file, `${lines.join('\n')}\n`);
  }

  function removeKnownHosts(alias) {
    const file = path.join(root, 'ssh', 'known_hosts');
    let lines;
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      return false;
    }
    const kept = lines.filter(line => !line.trim() || !aliasMatches(line.trim().split(/\s+/)[0], alias));
    if (kept.length === lines.length) return false;
    atomicPrivateWrite(file, `${kept.filter(line => line.trim()).join('\n')}\n`);
    return true;
  }

  function writeConfig() {
    return writeSshConfig(config.hosts, { runtimeDir: root });
  }

  async function add(input) {
    const host = normalizeHost(input);
    const existing = config.hosts.find(item => item.id === host.id);
    if (existing && existing.status?.state !== 'revoked') throw new Error('An SSH host with that id already exists.');
    await ensureDefaultKey();
    if (host.auth.kind === 'host-key') {
      const info = await createHostKey({ runtimeDir: root, hostId: host.id, installId: installId(), exec: run });
      host.auth = { kind: 'host-key', keyId: info.id };
    }
    const record = {
      ...host,
      hostKey: null,
      docker: { context: `orbit-${host.id}` },
      status: { state: 'unreachable', lastSeen: null },
    };
    const baseHosts = existing ? config.hosts.filter(item => item.id !== host.id) : config.hosts;
    const next = [...baseHosts, record];
    writeSshConfig(next, { runtimeDir: root });
    config.hosts = next;
    save();
    audit(host.id, { action: 'add', ok: true });
    logEvent('ssh-host-added', { hostId: host.id });
    return { ...view(record), installId: installId(), authorizedKeysLine: authorizedKeysLine(record) };
  }

  async function scanHostKey(hostId) {
    const host = requireHost(hostId);
    if (host.status?.state === 'revoked') throw new Error('SSH host is revoked.');
    const args = ['-T', '5', '-t', 'ed25519'];
    if (host.port !== 22) args.push('-p', String(host.port));
    args.push(host.address);
    let result;
    try {
      result = await run('ssh-keyscan', args, { timeout: 12000, env: minimalEnv(root), cwd: root });
    } catch (error) {
      host.status = { state: 'unreachable', lastSeen: host.status?.lastSeen ?? null, lastError: sanitize(error) };
      save();
      audit(hostId, { action: 'scan-host-key', ok: false });
      throw new Error('Could not read the host key.');
    }
    const line = String(result.stdout || '').split(/\r?\n/).find(item => {
      if (!item || item.trimStart().startsWith('#')) return false;
      const parts = item.trim().split(/\s+/);
      return parts.length >= 3 && parts[1] === 'ssh-ed25519' && /^[A-Za-z0-9+/=]+$/.test(parts[2]);
    });
    if (!line) {
      host.status = { state: 'unreachable', lastSeen: host.status?.lastSeen ?? null, lastError: 'No ed25519 host key was returned.' };
      save();
      audit(hostId, { action: 'scan-host-key', ok: false });
      throw new Error('No ed25519 host key was returned.');
    }
    const parts = line.trim().split(/\s+/);
    const publicKeyLine = `${parts[1]} ${parts[2]}`;
    const scannedAt = iso();
    const record = {
      fingerprint: fingerprintOf(publicKeyLine),
      algorithm: parts[1],
      publicKey: publicKeyLine,
      scannedAt,
    };
    pending.set(hostId, record);
    atomicPrivateWrite(pendingFile(hostId), JSON.stringify(record));
    audit(hostId, { action: 'scan-host-key', ok: true });
    logEvent('ssh-host-key-scanned', { hostId });
    return { hostId, ...record };
  }

  function fingerprintOf(publicKeyLine) {
    // Keep the fingerprint derivation in one place without importing private key
    // material: SHA256 over the OpenSSH wire blob exactly as ssh-keygen does.
    const parts = String(publicKeyLine).trim().split(/\s+/);
    const blob = Buffer.from(parts[1] || '', 'base64');
    if (!blob.length) throw new Error('Invalid host public key.');
    return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  }

  async function confirmPin(hostId, fingerprint) {
    const host = requireHost(hostId);
    if (host.status?.state === 'revoked') throw new Error('SSH host is revoked.');
    const scanned = readPending(hostId);
    if (!scanned) throw new Error('Scan the host key before confirming the fingerprint.');
    const given = String(fingerprint || '').trim();
    if (!given || given !== scanned.fingerprint) throw new Error('Host key fingerprint does not match what Orbit scanned.');
    host.hostKey = {
      fingerprints: [scanned.fingerprint],
      pinnedAt: iso(),
      verifiedBy: 'bootstrap-fingerprint',
    };
    delete host.status.lastError;
    host.status = { state: 'verified', lastSeen: host.status?.lastSeen ?? null };
    writeKnownHosts(sshAlias(hostId), host.port, scanned.publicKey);
    clearPending(hostId);
    writeConfig();
    save();
    audit(hostId, { action: 'confirm-pin', ok: true });
    logEvent('ssh-host-key-pinned', { hostId });
    return view(host);
  }

  async function test(hostId) {
    const host = requireHost(hostId);
    if (host.status?.state === 'revoked') return { ok: false, reason: 'revoked', error: 'This SSH host is revoked.' };
    if (host.status?.state === 'key-changed') return { ok: false, reason: 'key-changed', error: 'The host key changed. Re-verify before any action.' };
    if (!Array.isArray(host.hostKey?.fingerprints) || host.hostKey.fingerprints.length === 0) {
      return { ok: false, reason: 'unverified', error: 'Scan and confirm the host key first.' };
    }
    const configFile = writeConfig();
    const alias = sshAlias(hostId);
    const started = Date.now();
    try {
      await run('ssh', ['-F', configFile, alias, 'true'], { timeout: 20000, env: minimalEnv(root), cwd: root });
    } catch (error) {
      const text = `${error?.stderr || ''} ${error?.stdout || ''} ${error?.message || ''}`;
      const durationMs = Date.now() - started;
      if (isHostKeyChanged(text)) {
        host.status = { state: 'key-changed', lastSeen: host.status?.lastSeen ?? null, lastError: 'Host key changed.' };
        save();
        audit(hostId, { action: 'test', ok: false, exitCode: error?.code ?? null, durationMs, reason: 'key-changed' });
        logEvent('ssh-host-key-changed', { hostId });
        return { ok: false, reason: 'key-changed', error: 'The host key changed. Re-verify before any action.' };
      }
      const message = sanitize(error);
      host.status = { state: 'unreachable', lastSeen: host.status?.lastSeen ?? null, lastError: message };
      save();
      audit(hostId, { action: 'test', ok: false, exitCode: error?.code ?? null, durationMs, reason: 'unreachable' });
      return { ok: false, reason: 'unreachable', error: message };
    }
    const preflight = {};
    const commands = {
      arch: ['uname', '-m'],
      disk: ['df', '-h', '/'],
      docker: ['docker', '--version'],
      compose: ['docker', 'compose', 'version'],
      sudo: ['sudo', '-n', '-l'],
      date: ['date', '-u', '+%Y-%m-%dT%H:%M:%SZ'],
    };
    for (const [key, command] of Object.entries(commands)) {
      try {
        const result = await run('ssh', ['-F', configFile, alias, ...command], { timeout: 10000, env: minimalEnv(root), cwd: root });
        preflight[key] = String(result.stdout || '').trim().slice(0, 2000);
      } catch (error) {
        preflight[key] = `error: ${sanitize(error)}`;
      }
    }
    const durationMs = Date.now() - started;
    host.status = { state: 'verified', lastSeen: iso() };
    delete host.status.lastError;
    save();
    audit(hostId, { action: 'test', ok: true, exitCode: 0, durationMs });
    logEvent('ssh-host-tested', { hostId });
    return { ok: true, hostId, alias, fingerprint: host.hostKey.fingerprints[0], preflight };
  }

  async function revoke(hostId) {
    const host = requireHost(hostId);
    const line = authorizedKeysLine(host);
    let controlMasterClosed = false;
    const configFile = path.join(root, 'ssh', 'config');
    try {
      await run('ssh', ['-O', 'exit', '-F', configFile, sshAlias(hostId)], { timeout: 5000, env: minimalEnv(root), cwd: root });
      controlMasterClosed = true;
    } catch {}
    const knownHostsRemoved = removeKnownHosts(sshAlias(hostId));
    clearPending(hostId);
    let perHostKeyDeleted = false;
    if (host.auth?.kind === 'host-key' || String(host.auth?.keyId || '').startsWith('orbit-host-')) {
      const keyId = host.auth?.keyId || `orbit-host-${hostId}`;
      if (KEY_ID.test(keyId)) {
        for (const suffix of ['', '.pub']) {
          try {
            fs.rmSync(path.join(root, 'ssh', 'keys', `${keyId}${suffix}`), { force: true });
            perHostKeyDeleted = true;
          } catch {}
        }
      }
    }
    host.status = { state: 'revoked', lastSeen: host.status?.lastSeen ?? null };
    writeConfig();
    save();
    audit(hostId, { action: 'revoke', ok: true });
    logEvent('ssh-host-revoked', { hostId });
    return {
      hostId,
      state: 'revoked',
      authorizedKeysLine: line,
      knownHostsRemoved,
      controlMasterClosed,
      perHostKeyDeleted,
    };
  }

  async function remove(hostId, { cleanup = false } = {}) {
    const host = requireHost(hostId);
    const result = { attempted: false, ok: null };
    if (cleanup) {
      result.attempted = true;
      // UNTESTED: remote authorized_keys and sudoers cleanup. The command is a
      // fixed argv array; only the validated install marker is interpolated.
      const script = `h=$(getent passwd orbit | cut -d: -f6); f="$h/.ssh/authorized_keys"; if [ -n "$h" ] && [ -f "$f" ]; then t="$f.orbit-tmp"; grep -vF "orbit-${installId()}" "$f" > "$t" || true; cat "$t" > "$f"; rm -f "$t"; chmod 600 "$f"; fi; rm -f /etc/sudoers.d/orbit`;
      const remote = ["sudo", "-n", "sh", "-c", `'${script}'`];
      try {
        await run('ssh', ['-F', path.join(root, 'ssh', 'config'), sshAlias(host.id), ...remote], { timeout: 30000, env: minimalEnv(root), cwd: root });
        result.ok = true;
      } catch (error) {
        result.ok = false;
        result.error = sanitize(error);
      }
      audit(host.id, { action: 'cleanup', ok: result.ok === true });
    }
    const revoked = await revoke(hostId);
    return { removed: true, cleanup: result, ...revoked };
  }

  function status(hostId) {
    if (hostId !== undefined) {
      const host = config.hosts.find(item => item.id === hostId);
      return host ? view(host) : null;
    }
    return {
      installId: installId(),
      configPath: path.join(root, 'ssh', 'config'),
      knownHostsPath: path.join(root, 'ssh', 'known_hosts'),
      defaultKey: config.ssh.defaultKey || null,
      hosts: config.hosts.map(view),
    };
  }

  async function importFromSshConfig(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('SSH config text is required.');
    if (text.length > 256 * 1024) throw new Error('SSH config text is too large.');
    const aliases = [];
    const sanitized = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z]+)(?:\s+|=)(.*)$/);
      if (!match) continue;
      const keyword = match[1].toLowerCase();
      if (keyword === 'match' || keyword === 'include' || keyword === 'localcommand' || keyword === 'proxycommand' || keyword === 'permitlocalcommand') continue;
      if (keyword === 'host') {
        const alias = match[2].trim().split(/\s+/).find(item => item && !item.includes('*') && !item.includes('?') && !item.startsWith('!'));
        if (alias) aliases.push(alias);
        sanitized.push(line);
        continue;
      }
      if (keyword === 'hostname' || keyword === 'user' || keyword === 'port' || keyword === 'proxyjump' || keyword === 'identityfile') {
        sanitized.push(line);
      }
    }
    if (!aliases.length) return [];
    const dir = path.join(root, 'ssh', 'tmp');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const temp = path.join(dir, `import-${process.pid}-${randomBytes(8).toString('hex')}.conf`);
    const imported = [];
    try {
      fs.writeFileSync(temp, `${sanitized.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
      for (const alias of aliases) {
        const result = await run('ssh', ['-G', '-F', temp, alias], { timeout: 10000, env: minimalEnv(root), cwd: root });
        const values = {};
        for (const line of String(result.stdout || '').split(/\r?\n/)) {
          const space = line.indexOf(' ');
          if (space <= 0) continue;
          const key = line.slice(0, space).toLowerCase();
          const value = line.slice(space + 1).trim();
          if (!(key in values)) values[key] = value;
        }
        imported.push({
          alias,
          hostName: values.hostname || '',
          user: values.user || '',
          port: safePort(values.port, 22),
          proxyJump: values.proxyjump && values.proxyjump !== 'none' ? values.proxyjump : null,
          identityFile: values.identityfile && values.identityfile !== 'none' ? values.identityfile : null,
        });
      }
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
    return imported;
  }

  return {
    parseAddress,
    importFromSshConfig,
    add,
    scanHostKey,
    confirmPin,
    test,
    status,
    revoke,
    remove,
    list: () => config.hosts.map(view),
    authorizedKeysLine: hostId => authorizedKeysLine(requireHost(hostId)),
    installId,
  };
}
