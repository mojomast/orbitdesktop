import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Orbit-owned SSH key material.
 *
 * The private key never leaves this module: callers receive a relative `keyRef`
 * and public material only. The system `ssh-keygen` generates keys under
 * `<runtime>/ssh/keys` (directory 0700, private file 0600). No Node SSH library
 * is involved, and the process environment is explicit and minimal.
 */

export const DEFAULT_KEY_ID = 'orbit-default';
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INSTALL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Absolute runtime path, never the caller's real HOME. */
export function resolveRuntime(runtimeDir) {
  if (typeof runtimeDir !== 'string' || !runtimeDir.trim() || !path.isAbsolute(runtimeDir)) {
    throw new Error('SSH requires an absolute runtime directory.');
  }
  return path.resolve(runtimeDir);
}

/** Explicit environment for every OpenSSH spawn: no tokens, no agent socket. */
export function minimalEnv(runtimeDir) {
  const root = resolveRuntime(runtimeDir);
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: root,
    LANG: 'C',
    LC_ALL: 'C',
  };
}

/**
 * Default argv-array executor. `args` is always an array so no caller ever
 * builds a shell string. The caller supplies the timeout and environment.
 */
export function defaultExec(file, args, options = {}) {
  if (typeof file !== 'string' || !Array.isArray(args)) throw new Error('SSH commands require an argv array.');
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      timeout: options.timeout ?? 15000,
      env: options.env || { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      cwd: options.cwd,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function safeInstallId(value) {
  if (typeof value !== 'string' || !INSTALL_ID.test(value)) throw new Error('Invalid Orbit install id.');
  return value;
}

function safeKeyId(value) {
  if (typeof value !== 'string' || !KEY_ID.test(value)) throw new Error('Invalid SSH key id.');
  return value;
}

function keyDirectory(runtimeDir) {
  return path.join(resolveRuntime(runtimeDir), 'ssh', 'keys');
}

function keyPath(runtimeDir, keyId) {
  return path.join(keyDirectory(runtimeDir), safeKeyId(keyId));
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatOrNull(dir);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Orbit SSH key directory is not safe.');
  fs.chmodSync(dir, 0o700);
}

function ensureDirs(runtimeDir) {
  const sshDir = path.join(resolveRuntime(runtimeDir), 'ssh');
  const dir = keyDirectory(runtimeDir);
  ensurePrivateDir(sshDir);
  ensurePrivateDir(dir);
  return dir;
}

function assertPrivateFile(file) {
  const stat = lstatOrNull(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Orbit SSH private key is not a safe regular file.');
  return stat;
}

function readPublicFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error('Orbit SSH public key is missing.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new Error('Orbit SSH public key is not a regular file.');
  }
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-[a-z0-9-]+) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/.test(text)) {
    throw new Error('Orbit SSH public key is malformed.');
  }
  return text;
}

/** SHA256 fingerprint of an OpenSSH public key line, computed without ssh-keygen. */
export function fingerprintFromPublicKey(text) {
  if (typeof text !== 'string') throw new Error('SSH public key is required.');
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2 || !/^[a-z0-9-]+$/.test(parts[0])) throw new Error('SSH public key is malformed.');
  let blob;
  try {
    blob = Buffer.from(parts[1], 'base64');
  } catch {
    throw new Error('SSH public key is malformed.');
  }
  if (blob.length === 0) throw new Error('SSH public key is malformed.');
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Create the one install key once. Re-running on an existing key is a no-op, so
 * callers can safely retry. The result contains public material and a relative
 * reference only.
 */
export async function ensureInstallKey({ runtimeDir, installId, exec = defaultExec } = {}) {
  const root = resolveRuntime(runtimeDir);
  const id = safeInstallId(installId);
  ensureDirs(root);
  const keyId = DEFAULT_KEY_ID;
  const privateFile = keyPath(root, keyId);
  const publicFile = `${privateFile}.pub`;
  const comment = `orbit-${id}`;
  if (!lstatOrNull(privateFile)) {
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', privateFile], {
      timeout: 20000,
      env: minimalEnv(root),
      cwd: root,
    });
  }
  assertPrivateFile(privateFile);
  if (!lstatOrNull(publicFile)) throw new Error('ssh-keygen did not create the Orbit public key.');
  fs.chmodSync(privateFile, 0o600);
  ensureDirs(root);
  const publicText = readPublicFile(publicFile);
  return {
    id: keyId,
    type: 'ed25519',
    keyRef: { file: `ssh/keys/${keyId}` },
    publicKey: publicText,
    fingerprint: fingerprintFromPublicKey(publicText),
    createdAt: fs.statSync(privateFile).mtime.toISOString(),
  };
}

/** Public half of a managed key. Never returns private material. */
export function publicKey({ runtimeDir, keyId = DEFAULT_KEY_ID } = {}) {
  const root = resolveRuntime(runtimeDir);
  return readPublicFile(`${keyPath(root, keyId)}.pub`);
}

/** SHA256 fingerprint of a managed key. */
export function fingerprint({ runtimeDir, keyId = DEFAULT_KEY_ID } = {}) {
  return fingerprintFromPublicKey(publicKey({ runtimeDir, keyId }));
}

/** Optional per-host key for blast-radius isolation. */
export async function createHostKey({ runtimeDir, hostId, installId, exec = defaultExec } = {}) {
  const root = resolveRuntime(runtimeDir);
  if (typeof hostId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(hostId)) throw new Error('Invalid host id.');
  const id = safeInstallId(installId);
  ensureDirs(root);
  const keyId = `orbit-host-${hostId}`;
  const privateFile = keyPath(root, keyId);
  const publicFile = `${privateFile}.pub`;
  if (!lstatOrNull(privateFile)) {
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `orbit-${id}`, '-f', privateFile], {
      timeout: 20000,
      env: minimalEnv(root),
      cwd: root,
    });
  }
  assertPrivateFile(privateFile);
  if (!lstatOrNull(publicFile)) throw new Error('ssh-keygen did not create the host public key.');
  fs.chmodSync(privateFile, 0o600);
  const publicText = readPublicFile(publicFile);
  return {
    id: keyId,
    type: 'ed25519',
    keyRef: { file: `ssh/keys/${keyId}` },
    publicKey: publicText,
    fingerprint: fingerprintFromPublicKey(publicText),
    createdAt: fs.statSync(privateFile).mtime.toISOString(),
  };
}

/**
 * Rotation is a plan, not an action. Callers show the result and generate a new
 * key through an explicit reviewed flow.
 */
export function rotatePlan({ createdAt, rotationDays = 90, now = Date.now() } = {}) {
  const created = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  const current = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(created) || !Number.isFinite(current)) throw new Error('Invalid rotation dates.');
  if (!Number.isInteger(rotationDays) || rotationDays < 1 || rotationDays > 3650) throw new Error('Invalid rotation interval.');
  const rotateAt = created + rotationDays * 86400000;
  return {
    due: current >= rotateAt,
    ageDays: Math.max(0, Math.floor((current - created) / 86400000)),
    remainingDays: Math.max(0, Math.ceil((rotateAt - current) / 86400000)),
    rotateBy: new Date(rotateAt).toISOString(),
  };
}
