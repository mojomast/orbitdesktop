// No discovery, directory listing, retained packets or background refresh. The
// writers are an independently enrolled operator publication process and, once
// at Orbit startup, observeLocalRelease's revision-only release.json.
import {spawnSync} from 'node:child_process';
import {constants as F, existsSync, lstatSync, mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import {acceptedHosts, allowedRequest, tokenMatches} from './security.mjs';

export const HIVE_REPORTS_ROUTE = '/api/rizzstack/hive/reports';
const empty = () => ({version: 'hive.reports/1', queue: null, release: null, labels: null});
const LIMIT = 64 * 1024, RESPONSE_LIMIT = 200 * 1024, PERIOD = 30_000, DEADLINE = 3_000;
const refuse = () => { throw Error('unavailable'); };
const reports = {
  queue: {limit: LIMIT, validate: async input => (await import('../apps/rizzstack-hive/queue-provider.js')).validateQueue(input)},
  release: {limit: 16 * 1024, validate: async input => (await import('../apps/rizzstack-hive/release-provider.js')).validateRelease(input)},
  labels: {limit: LIMIT, validate: async input => (await import('../apps/rizzstack-hive/public-labels.js')).validateLabels(input)},
};

function components(dir) {
  if (typeof dir !== 'string' || dir.length > 4095 || !dir.startsWith('/')) return null;
  const parts = dir.slice(1).split('/');
  return parts.length <= 32 && parts.every(p => p !== '.' && p !== '..' &&
    p.length > 0 && p.length <= 255 && !/[^a-zA-Z0-9_. -]/.test(p)) ? parts : null;
}

// Preflight the bounded UTF-8 document *before* JSON.parse can discard duplicate
// names. Native JSON.parse still checks the complete grammar. All three schemas
// use integer counters only; don't round a decimal, exponent or oversized int.
function parsePacket(bytes, credential) {
  const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  const tokens = /[ \t\r\n]+|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"([ \t\r\n]*:)?|[[\]{},:]|true|false|null|-?(?:0|[1-9][0-9]*)/gy;
  const stack = [];
  let count = 0;
  while (tokens.lastIndex < text.length) {
    const m = tokens.exec(text);
    if (!m || ++count > 16_384) refuse();
    const t = m[0];
    if (t === '{' || t === '[') {
      if (stack.length >= 16) refuse();
      stack.push(t === '{' ? new Set() : null);
    } else if (t === '}' || t === ']') {
      if (!stack.length) refuse();
      stack.pop();
    } else if (t.startsWith('"')) {
      const value = JSON.parse(m[1] ? t.slice(0, -m[1].length) : t);
      if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || value.includes(credential)) refuse();
      if (m[1]) {
        const keys = stack.at(-1);
        if (!keys || keys.has(value) || ['constructor','prototype','__proto__'].includes(value)) refuse();
        keys.add(value);
      }
    } else if (/^[-0-9]/.test(t) && (!Number.isSafeInteger(Number(t)) || t === '-0')) refuse();
  }
  return JSON.parse(text);
}

const procFd = handle => `/proc/self/fd/${handle.fd}`;
const statOptions = {bigint: true};
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid &&
    a.gid === b.gid && a.nlink === b.nlink && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}
async function mount(handle) {
  // O_PATH descriptors have only a small kernel-generated fdinfo record.
  const info = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'ascii');
  return /^mnt_id:\s*(\d+)$/m.exec(info)?.[1] ?? refuse();
}

async function observe(parts, credential, until) {
  const result = empty(), handles = [], dirs = [], observed = [];
  const budget = () => { if (performance.now() >= until) refuse(); };
  const own = async (name, flags) => {
    budget();
    const handle = await fs.open(name, flags);
    handles.push(handle);
    return handle;
  };
  try {
    // Linux O_PATH pins a name without opening devices or blocking on FIFOs.
    // procfs gives Node an openat equivalent for each already-pinned parent.
    // On unsupported systems never fall back to a path-based read.
    if (process.platform !== 'linux' || !['x64','arm64'].includes(process.arch) ||
        !F.O_NOFOLLOW || !F.O_DIRECTORY || !F.O_NONBLOCK || (await fs.statfs('/proc/self/fd')).type !== 0x9fa0) return result;
    const uid = BigInt(process.geteuid());
    const pin = 0o10000000 | F.O_NOFOLLOW; // O_PATH on the supported Linux ABIs
    let path = '/', name = '/', parent, rootMount;
    for (let i = 0; i <= parts.length; i++) {
      const handle = await own(name, pin | F.O_DIRECTORY);
      const st = await handle.stat(statOptions);
      if (!st.isDirectory() || (st.uid !== uid && st.uid !== 0n) || (st.mode & 0o022n)) refuse();
      if (i === parts.length && (st.uid !== uid || ![0o500n, 0o700n].includes(st.mode & 0o7777n))) refuse();
      const id = await mount(handle);
      rootMount ??= id;
      if (id !== rootMount || await fs.readlink(procFd(handle)) !== path) refuse();
      dirs.push({name, st});
      parent = handle;
      if (i < parts.length) {
        path = (i === 0 ? '/' : path + '/') + parts[i];
        name = procFd(parent) + '/' + parts[i];
      }
    }
    for (const [key, {limit, validate}] of Object.entries(reports)) {
      budget();
      try {
        const file = `${key}.json`, entry = `${procFd(parent)}/${file}`;
        const handle = await own(entry, pin), st = await handle.stat(statOptions);
        if (!st.isFile() || st.nlink !== 1n || st.uid !== uid ||
            ![0o400n, 0o600n].includes(st.mode & 0o7777n) || st.size <= 0n || st.size > BigInt(limit) ||
            await mount(handle) !== rootMount || await fs.readlink(procFd(handle)) !== `${path}/${file}`) continue;
        // Only this kernel-owned fd link may be followed. A rename of the
        // operator's file cannot redirect the data open to a different inode.
        const fd = await own(procFd(handle), F.O_RDONLY | F.O_NONBLOCK | F.O_NOATIME);
        if (!same(st, await fd.stat(statOptions))) continue;
        budget();
        const bytes = Buffer.alloc(Number(st.size));
        if ((await fd.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length || !same(st, await fd.stat(statOptions))) continue;
        budget();
        const packet = parsePacket(bytes, credential);
        if (await validate(packet) !== true) continue;
        const json = JSON.stringify(packet);
        if (json.includes(credential) || Buffer.byteLength(json) > limit) continue;
        observed.push({key, entry, st, packet});
      } catch { /* This fixed field stays unavailable. No payloads or paths in errors. */ }
    }
    for (const {key, entry, st, packet} of observed) {
      try { if (same(st, await fs.lstat(entry, statOptions))) result[key] = packet; } catch { /* replaced */ }
    }
    // Re-check all pinned names before releasing any result. Parent renames,
    // permission/owner changes and in-place writes invalidate the observation.
    for (const {name, st} of dirs) if (!same(st, await fs.lstat(name, statOptions))) refuse();
    budget();
    const json = JSON.stringify(result);
    return Buffer.byteLength(json) <= RESPONSE_LIMIT && !json.includes(credential) ? result : empty();
  } catch { return empty(); }
  finally { await Promise.allSettled(handles.map(h => h.close())); }
}

export function createHiveReportsRoute({dir, token, port, devOrigins = [], reply}) {
  const parts = components(dir);
  let active = false, next = -Infinity;
  return async (req, res) => {
    const h = req.headers, auth = h.authorization;
    const originOk = allowedRequest(req, port, devOrigins) ||
      (req.method === 'GET' && h.origin === undefined && h['sec-fetch-site'] === 'same-origin' && acceptedHosts(port, devOrigins).hosts.has(h.host));
    if (!originOk || h.origin === 'null' || h['sec-fetch-site'] === 'cross-site') return reply(res, 403, empty());
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token)) return reply(res, 401, empty());
    if (req.method !== 'GET') return reply(res, 405, empty());
    if (req.url !== HIVE_REPORTS_ROUTE || h['transfer-encoding'] !== undefined ||
        (h['content-length'] !== undefined && h['content-length'] !== '0')) return reply(res, 400, empty());
    if (!parts) return reply(res, 200, empty());
    const now = performance.now();
    if (active || now < next) return reply(res, 429, empty());
    active = true;
    next = now + PERIOD;
    let timer;
    try {
      // A stalled kernel read keeps the single I/O slot until cleanup actually
      // finishes. The HTTP deadline must never permit unlimited detached work.
      const work = observe(parts, token, now + DEADLINE).finally(() => { active = false; });
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(empty()), DEADLINE); });
      return reply(res, 200, await Promise.race([work, timeout]));
    } finally { clearTimeout(timer); }
  };
}

// A revision-only observation (scripts/hive_release_read.py --local) has no PR
// or check-run evidence. Only such a file is ever replaced; an operator-published
// report (or anything unreadable) is left exactly as it is.
function localObservation(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 16 * 1024) return false;
    const value = JSON.parse(readFileSync(file, {encoding: 'utf8', flag: F.O_RDONLY | F.O_NOFOLLOW}));
    return value?.schema === 'hive-release-read/1' && Array.isArray(value.repos) && value.repos.length > 0 &&
      value.repos.every(r => Array.isArray(r?.prs) && r.prs.length === 0 && r.main?.checks === null);
  } catch { return false; }
}

// Optional ORBIT_HIVE_RELEASE_CHECKOUTS="bundlebees=/abs/path,workflow=/abs/path"
// names the checkouts a deployment actually runs when they are not next to the
// Orbit checkout. Anything malformed refuses the whole observation (null).
const RELEASE_REPOS = new Set(['workflow', 'bundlebees', 'hyvv', 'orbitdesktop']);
export function releaseCheckouts(value) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || value.length > 4096) return null;
  const items = value.split(',').map(item => item.trim());
  const seen = new Set();
  for (const item of items) {
    const at = item.indexOf('='), name = item.slice(0, at), where = item.slice(at + 1);
    if (at < 1 || !RELEASE_REPOS.has(name) || seen.has(name) || !path.isAbsolute(where) ||
        path.normalize(where) !== where || /[\u0000-\u001f]/.test(where)) return null;
    seen.add(name);
  }
  return items;
}

// Startup-only, read-only release observation of this deployment's own Git
// checkouts. Returns 'off' | 'kept' | 'written' | 'failed'. No network, no git
// writes, no credentials in the child environment.
export function observeLocalRelease({dir, repoRoot, env = {}, spawn = spawnSync} = {}) {
  if (!components(dir) || env.ORBIT_HIVE_RELEASE_AUTO === '0' || typeof repoRoot !== 'string') return 'off';
  const target = path.join(dir, 'release.json');
  if (existsSync(target) && !localObservation(target)) return 'kept';
  try {
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const producer = path.join(repoRoot, 'scripts', 'hive_release_read.py');
    if (!existsSync(producer)) return 'failed';
    const checkouts = releaseCheckouts(env.ORBIT_HIVE_RELEASE_CHECKOUTS);
    if (!checkouts) return 'failed';
    const run = spawn(env.ORBIT_PYTHON || 'python3',
      [producer, '--staging-dir', dir, '--local', '--deployment-root', repoRoot, ...checkouts.flatMap(c => ['--repo', c])],
      {cwd: repoRoot, timeout: 20_000, stdio: 'ignore',
        env: {PATH: env.PATH || '/usr/bin:/bin', HOME: env.HOME || '/nonexistent', PYTHONDONTWRITEBYTECODE: '1'}});
    return run.error || run.status !== 0 ? 'failed' : 'written';
  } catch { return 'failed'; }
}
