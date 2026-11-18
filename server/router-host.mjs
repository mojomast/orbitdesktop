// Trusted foreground operator integration. Deliberately not imported by any
// route, setup agent, worker, or server startup path. No download or discovery.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { once } from 'node:events';
import { validateOrbitConfig, resolveRoles } from './orbit-config.mjs';
import { builtinRouterPlan } from './router-supervisor.mjs';

const KB = 1024, MB = KB * KB;
const binaryLimit = 512 * MB;
const privateFile = 0o077, trustedFile = 0o022;
const fail = reason => { throw Error(reason); };

export function checkPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p || fs.realpathSync(p) !== p) fail('A canonical absolute path without symlinks is required.');
  for (let d = path.dirname(p); d !== '/'; d = path.dirname(d)) {
    const s = fs.lstatSync(d);
    // Sticky shared ancestors (e.g. /tmp) cannot replace an owned child.
    const systemTmp = d === '/tmp' && (s.mode & 0o1000);
    if (!s.isDirectory() || (!systemTmp && ((s.mode & trustedFile) || ![0, process.getuid()].includes(s.uid)))) fail('Untrusted path to router input.');
  }
}

function checkedFd(p, maxBytes, { executable = false, privateMode = false } = {}) {
  checkPath(p);
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const st = fs.fstatSync(fd);
  if (!st.isFile() || ![0, process.getuid()].includes(st.uid) || st.nlink !== 1 ||
      (st.mode & (privateMode ? privateFile : trustedFile)) || st.size <= 0 || st.size > maxBytes ||
      (executable && (!(st.mode & 0o111) || (st.mode & 0o6000)))) {
    fs.closeSync(fd); fail('Invalid router input ownership, permissions, type or size.');
  }
  return fd;
}

export function privateText(file, limit) {
  const fd = checkedFd(file, limit, { privateMode: true });
  try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
}

export function privateDirectory(d) {
  checkPath(d);
  const st = fs.lstatSync(d);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & privateFile)) fail('Router runtime must be owner-private.');
}

function launchInputs(runtimeDir) {
  const routerDir = path.join(runtimeDir, 'router'), keysDir = path.join(runtimeDir, 'keys');
  for (const d of [runtimeDir, keysDir, routerDir, path.join(routerDir, 'data')]) privateDirectory(d);
  const config = validateOrbitConfig(JSON.parse(privateText(path.join(runtimeDir, 'orbit-config.json'), MB)));
  const {router} = config;
  if (!config.components.router || !router.enabled || router.mode !== 'builtin' || router.engine !== 'bifrost' || router.bind !== 'loopback') fail('Explicit built-in Bifrost loopback configuration is required.');
  const { rendered, upstreams } = builtinRouterPlan(config);
  const prepared = JSON.parse(privateText(path.join(routerDir, 'data/config.json'), MB));
  if (!isDeepStrictEqual(prepared, JSON.parse(JSON.stringify(rendered)))) fail('Prepared governance or provider configuration is stale.');
  if (!upstreams.length || upstreams.length !== Object.keys(rendered.providers).length) fail('Missing or blocked upstream.');
  if (!Object.values(resolveRoles(config)).some(mapping => mapping.provider === 'router' && mapping.model)) fail('No role is assigned to this router.');

  const env = Object.create(null);
  for (const line of privateText(path.join(routerDir, 'router.env'), 2 * MB).trimEnd().split('\n')) {
    const m = /^([A-Z][A-Z_0-9]*)=([^\r\n\0]+)$/.exec(line);
    if (!m || Object.hasOwn(env, m[1])) fail('Invalid router environment file.');
    env[m[1]] = m[2];
  }
  const allowed = new Set(['BIFROST_ENCRYPTION_KEY', 'BIFROST_SETUP_TOKEN', 'BIFROST_ADMIN_PASSWORD']);
  const distinct = new Set();
  for (const name of allowed) {
    if (!env[name] || env[name].length < 24 || distinct.has(env[name])) fail('Missing or aliased management credential.');
    distinct.add(env[name]);
  }
  for (const { id, value } of rendered.governance.virtual_keys) {
    const name = value.slice(4);
    const token = privateText(path.join(keysDir, `router-vk-${id}.key`), 256).trim();
    if (!/^sk-bf-[A-Za-z0-9_-]{43}$/.test(token) || env[name] !== token || distinct.has(token)) fail('Invalid role credential binding.');
    distinct.add(token); allowed.add(name);
  }
  for (const {keyRef, envName} of upstreams) {
    if (!keyRef?.file) fail('Host launch requires selected upstreams with explicit key files.');
    const key = privateText(path.join(keysDir, keyRef.file), 64 * KB).trim();
    if (env[envName] !== key || distinct.has(key)) fail('Invalid upstream credential binding.');
    allowed.add(envName);
  }
  if (Object.keys(env).some(name => !allowed.has(name))) fail('Unexpected router environment entry.');
  return { rendered, port: router.port, env };
}

// Hash precisely the bytes that will execute. Neither pathname re-resolution
// nor a modification of the originally approved file can substitute new bytes.
function snapshotBinary(binary, destination, expected) {
  const fd = checkedFd(binary, binaryLimit, { executable: true });
  const hash = createHash('sha256');
  try {
    const magic = Buffer.alloc(4);
    if (fs.readSync(fd, magic, 0, magic.length, 0) !== 4 || !magic.equals(Buffer.from([0x7f, 69, 76, 70]))) fail('Host launcher requires a Linux ELF binary.');
    const out = fs.openSync(destination, 'wx', 0o500);
    try {
      const chunk = Buffer.allocUnsafe(MB);
      let n, total = 0;
      while ((n = fs.readSync(fd, chunk, 0, chunk.length)) > 0) {
        if ((total += n) > binaryLimit) fail('Binary exceeds size bound.');
        const bytes = chunk.subarray(0, n);
        fs.writeFileSync(out, bytes); hash.update(bytes);
      }
    } finally { fs.closeSync(out); }
  } finally { fs.closeSync(fd); }
  if (hash.digest('hex') !== expected) fail('Binary checksum does not match the operator manifest.');
}

export async function startHostRouter({ manifestFile, runtimeDir, confirmStart } = {}) {
  if (confirmStart !== true || process.platform !== 'linux') fail('Explicit Linux foreground start is required.');
  privateDirectory(runtimeDir);
  if (manifestFile === runtimeDir || manifestFile?.startsWith(runtimeDir + '/')) fail('Use a separate operator manifest outside the runtime.');
  const manifest = JSON.parse(privateText(manifestFile, 4096));
  if (!isDeepStrictEqual(Object.keys(manifest).sort(), ['binary', 'engine', 'runtimeDir', 'sha256', 'version']) ||
      manifest.engine !== 'bifrost' || manifest.version !== '2.5.1' || manifest.runtimeDir !== runtimeDir ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || typeof manifest.binary !== 'string' || manifest.binary.startsWith(runtimeDir + '/')) fail('Unsupported operator manifest.');
  const routerDir = path.join(runtimeDir, 'router');
  privateDirectory(routerDir);
  const run = path.join(routerDir, 'host-run');
  fs.mkdirSync(run, { mode: 0o700 }); // single owner; refuse stale/foreign runs
  const cleanup = () => fs.rmSync(run, {recursive: true, force: true});
  try {
    const bin = path.join(run, 'bifrost'), data = path.join(run, 'data');
    snapshotBinary(manifest.binary, bin, manifest.sha256);
    const { rendered, env, port } = launchInputs(runtimeDir);
    fs.mkdirSync(data, {mode: 0o700});
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(rendered), {mode: 0o600, flag: 'wx'});
    const child = spawn(bin, ['-host', '127.0.0.1', '-port', String(port), '-app-dir', data], {
      cwd: run, env: { ...env, HOME: run }, stdio: 'ignore', shell: false,
    });
    // Track the actual ChildProcess, never a PID loaded from disk. "spawn" is
    // not a health assertion; no request is sent to the router by this command.
    const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }));
    closed.catch(() => {}); // spawn failure is handled below
    await once(child, 'spawn');
    const done = closed.finally(cleanup);
    let stopping = false;
    return { done, stop() {
      if (!stopping && child.exitCode === null && child.signalCode === null) {
        stopping = true;
        child.kill('SIGTERM');
        const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
        timer.unref(); done.then(() => clearTimeout(timer), () => clearTimeout(timer));
      }
      return done;
    } };
  } catch (error) { cleanup(); throw error; }
}
