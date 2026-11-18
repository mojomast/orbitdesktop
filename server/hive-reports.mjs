// No discovery, directory listing, retained packets or background refresh. The
// only writer is an independently enrolled operator publication process.
import {constants as F} from 'node:fs';
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
