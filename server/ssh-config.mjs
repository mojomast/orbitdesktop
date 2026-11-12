import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Render the Orbit-owned OpenSSH client config.
 *
 * Every connection uses `ssh -F <runtime>/ssh/config`; Orbit never reads the
 * owner's ~/.ssh/config. The file is owner-only (0600) and written atomically.
 * Host key verification is always strict after the verified first-use pin.
 */

export const SSH_ALIAS_PREFIX = 'orbit-';
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TRANSPORTS = new Set(['direct', 'proxyJump', 'tailscale', 'tailcat', 'cloudflare']);
const TAILCAT_ADDR = /^[A-Za-z0-9._:@/+=-]{1,4096}$/;

export function validateHostId(value) {
  if (typeof value !== 'string' || !HOST_ID.test(value)) throw new Error('Invalid SSH host id.');
  return value;
}

export function sshAlias(hostId) {
  return `${SSH_ALIAS_PREFIX}${validateHostId(hostId)}`;
}

export function resolveRuntimeDir(runtimeDir) {
  if (typeof runtimeDir !== 'string' || !runtimeDir.trim() || !path.isAbsolute(runtimeDir)) {
    throw new Error('SSH config requires an absolute runtime directory.');
  }
  return path.resolve(runtimeDir);
}

function oneLine(value, name) {
  if (typeof value !== 'string') throw new Error(`SSH ${name} is required.`);
  const text = value.trim();
  if (!text) throw new Error(`SSH ${name} is required.`);
  if (/[\r\n\0]/.test(text)) throw new Error(`SSH ${name} contains invalid characters.`);
  return text;
}

function quote(value) {
  const text = oneLine(value, 'value');
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quotePath(value) {
  return quote(String(value).replaceAll('%', '%%'));
}

function validateKeyId(value) {
  if (typeof value !== 'string' || !KEY_ID.test(value)) throw new Error('Invalid SSH key id.');
  return value;
}

function keyFileFor(host, runtimeDir) {
  const auth = host.auth && typeof host.auth === 'object' ? host.auth : {};
  if (auth.kind === 'tailscale-ssh') return null;
  const keyId = auth.kind === 'host-key'
    ? `orbit-host-${validateHostId(host.id)}`
    : validateKeyId(auth.keyId || 'orbit-default');
  return path.join(runtimeDir, 'ssh', 'keys', keyId);
}

function readSecretRef(runtimeDir, ref, label) {
  if (!ref || typeof ref !== 'object' || typeof ref.file !== 'string') throw new Error(`SSH ${label} reference is missing.`);
  const rel = ref.file;
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !rel.startsWith('ssh/')) {
    throw new Error(`SSH ${label} reference must stay inside the runtime ssh directory.`);
  }
  const file = path.join(runtimeDir, rel);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error(`SSH ${label} reference file is missing.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`SSH ${label} reference must be a 0600 regular file.`);
  }
  if (stat.size > 16 * 1024) throw new Error(`SSH ${label} reference is too large.`);
  const value = oneLine(fs.readFileSync(file, 'utf8'), label);
  if (label === 'tailcat address' && !TAILCAT_ADDR.test(value)) throw new Error('SSH tailcat address contains unsupported characters.');
  return value;
}

function normalizeTransport(host, aliases) {
  const transport = host.transport && typeof host.transport === 'object' ? host.transport : { kind: 'direct' };
  const kind = transport.kind || 'direct';
  if (!TRANSPORTS.has(kind)) throw new Error('Unsupported SSH transport.');
  if (kind === 'proxyJump') {
    const jumpId = validateHostId(transport.jumpHostId);
    if (jumpId === host.id) throw new Error('An SSH host cannot jump through itself.');
    if (!aliases.has(jumpId)) throw new Error('The SSH jump host is not managed by Orbit.');
    return { kind, jumpAlias: `${SSH_ALIAS_PREFIX}${jumpId}` };
  }
  if (kind === 'cloudflare') {
    return { kind, hostname: transport.cloudflareHostname ? oneLine(transport.cloudflareHostname, 'cloudflare hostname') : null };
  }
  if (kind === 'tailcat') {
    return { kind, ref: transport.tailcatAddrRef || null };
  }
  return { kind };
}

function hostBlock(host, { runtimeDir, aliases }) {
  const id = validateHostId(host.id);
  const alias = `${SSH_ALIAS_PREFIX}${id}`;
  const address = oneLine(host.address, 'address');
  const user = oneLine(host.user || 'orbit', 'user');
  const port = host.port === undefined ? 22 : Number(host.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port.');
  const transport = normalizeTransport(host, aliases);
  const hostName = transport.kind === 'cloudflare' && transport.hostname ? transport.hostname : address;
  const identity = keyFileFor(host, runtimeDir);
  const lines = [
    `Host ${alias}`,
    `  HostName ${quote(hostName)}`,
    `  User ${quote(user)}`,
    `  Port ${port}`,
    `  HostKeyAlias ${alias}`,
    '  IdentitiesOnly yes',
    '  BatchMode yes',
    '  StrictHostKeyChecking yes',
    `  UserKnownHostsFile ${quotePath(path.join(runtimeDir, 'ssh', 'known_hosts'))}`,
    '  GlobalKnownHostsFile /dev/null',
    '  UpdateHostKeys yes',
    '  ForwardAgent no',
    '  ControlMaster auto',
    `  ControlPath ${quote(path.join(runtimeDir, 'ssh', 'cm', '%C'))}`,
    '  ControlPersist 10m',
    '  ServerAliveInterval 15',
    '  ConnectTimeout 10',
  ];
  if (identity) lines.push(`  IdentityFile ${quotePath(identity)}`);
  if (transport.kind === 'proxyJump') {
    lines.push(`  ProxyJump ${transport.jumpAlias}`);
  } else if (transport.kind === 'cloudflare') {
    lines.push('  ProxyCommand cloudflared access ssh --hostname %h');
  } else if (transport.kind === 'tailcat') {
    const tailcatAddress = readSecretRef(runtimeDir, transport.ref, 'tailcat address');
    lines.push('  # tailcat ProxyCommand transport is UNTESTED; see docs/HOSTS.md.');
    lines.push(`  ProxyCommand tailcat connect ${quote(tailcatAddress.replaceAll('%', '%%'))}`);
  } else if (transport.kind === 'tailscale') {
    lines.push('  # Tailscale transport uses the MagicDNS name directly.');
  }
  return lines.join('\n');
}

/** Pure render. Reads only 0600 runtime refs, never the owner's HOME. */
export function renderSshConfig(hosts, { runtimeDir } = {}) {
  const root = resolveRuntimeDir(runtimeDir);
  if (!Array.isArray(hosts)) throw new Error('SSH hosts must be an array.');
  const active = hosts.filter(host => host && host.status?.state !== 'revoked');
  const aliases = new Set(active.map(host => validateHostId(host.id)));
  const blocks = active.map(host => hostBlock(host, { runtimeDir: root, aliases }));
  const header = [
    '# Generated by Orbit. Do not edit by hand.',
    '# All hosts pin an Orbit-owned known_hosts entry and require StrictHostKeyChecking yes.',
    '# Private keys and tailcat addresses stay in 0600 runtime files.',
  ].join('\n');
  return `${header}${blocks.length ? `\n\n${blocks.join('\n\n')}` : ''}\n`;
}

/** Atomically replace <runtime>/ssh/config with a 0600 file. */
export function writeSshConfig(hosts, { runtimeDir } = {}) {
  const root = resolveRuntimeDir(runtimeDir);
  const sshDir = path.join(root, 'ssh');
  const controlDir = path.join(sshDir, 'cm');
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(sshDir, 0o700);
  fs.chmodSync(controlDir, 0o700);
  const text = renderSshConfig(hosts, { runtimeDir: root });
  const target = path.join(sshDir, 'config');
  const temp = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
  fs.chmodSync(target, 0o600);
  return target;
}
