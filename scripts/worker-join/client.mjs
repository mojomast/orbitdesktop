// Standalone, dependency-free local worker client. The only task it can perform
// is to hash this module. No coordinator-controlled filename or executable.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

export const protocol = 'orbit.worker-join/1';
export const route = '/api/local-workers';
const scopes = ['presence', 'verify-client','sum-brief'];
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const proof = (verifier, id, nonce, origin) => createHmac('sha256', Buffer.from(verifier, 'hex')).update(`${protocol}:${id}:${nonce}:${origin}`).digest('hex');
const refused = code => Object.assign(new Error(code), { code });
function installedDigest() {
  const fd = openSync(new URL(import.meta.url),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw refused('unsafe_client_file');
    const data = Buffer.alloc(65537); let offset = 0;
    while (offset < data.length) {
      const n = readSync(fd,data,offset,data.length-offset,null);
      if (!n) break;
      offset += n;
    }
    if (offset !== stat.size) throw refused('unsafe_client_file');
    return hash(data.subarray(0,offset));
  } finally { closeSync(fd); }
}
const portPattern = /^(https?):\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
export function validateOwnedEndpoint(value, kind) {
  const match = typeof value === 'string' && portPattern.exec(value);
  if (!match || match[0] !== value || Number(match[3]) > 65535 || match[1] !== (kind === 'https' ? 'https' : 'http')) throw refused('invalid_owned_endpoint');
  return value;
}

// Fixed method and destination path, no DNS/proxy environment, redirect or
// response-supplied URL. A timeout covers both connection and body transfer.
function request(origin, body, token, agent) {
  const tls = origin.startsWith('https:');
  validateOwnedEndpoint(origin, tls ? 'https' : 'loopback');
  return new Promise((resolve, reject) => {
    const req = (tls ? https : http).request(origin + route, { method: 'POST', agent: agent ?? false,
      ...(tls ? { rejectUnauthorized: true } : {}), headers: { Host: origin.split('//')[1], 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      let length = 0; const chunks = [];
      res.on('error', () => reject(refused('unreachable')));
      res.on('data', chunk => {
        length += chunk.length;
        if (length > 8192) req.destroy(refused('invalid_response')); else chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) {
            const safe = ['credential_denied','pairing_denied','scope_denied','task_unavailable'];
            return reject(refused(safe.includes(data?.error) ? data.error : 'request_refused'));
          }
          if (length > 8192 || data?.protocol !== protocol) throw refused('invalid_response');
          resolve(data);
        } catch { reject(refused('invalid_response')); }
      });
    });
    const timer = setTimeout(() => req.destroy(refused('timeout')), 2500);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(refused('unreachable')));
    req.end(JSON.stringify(body));
  });
}

// The QR is data, never permission to contact a machine. Only caller-supplied
// exact owned endpoints are eligible. A probe discloses no code or token.
export async function selectTransport(invite, owned, { only, agent } = {}) {
  if (invite?.protocol !== protocol || !/^wjp_[\w-]{43}$/.test(invite.code) || !/^[a-f0-9]{32}$/.test(invite.workerId) || !Number.isSafeInteger(invite.expiresAt) || invite.expiresAt <= Date.now() ||
      Object.keys(invite).some(k => !['protocol','code','workerId','expiresAt','orbitUrl'].includes(k))) throw refused('invalid_invitation');
  if (invite.orbitUrl !== undefined) validateOwnedEndpoint(invite.orbitUrl,invite.orbitUrl?.startsWith?.('https:') ? 'https' : 'loopback');
  if (!owned || typeof owned !== 'object' || Array.isArray(owned) || Object.keys(owned).some(k => !['https','loopback'].includes(k))) throw refused('invalid_owned_endpoint');
  if (only !== undefined && !['https','loopback','tailcat','mesh'].includes(only)) throw refused('invalid_transport');
  for (const [kind, endpoint] of Object.entries(owned)) validateOwnedEndpoint(endpoint, kind);
  const observations = [];
  for (const kind of ['https','loopback','tailcat','mesh']) {
    let status;
    if (only !== undefined && only !== kind) status = 'override_skipped';
    else if (kind === 'tailcat' || kind === 'mesh') status = 'native_adapter_unavailable';
    else if (!owned[kind]) status = 'no_owned_endpoint';
    else {
      const nonce = randomBytes(24).toString('hex');
      try {
        const res = await request(owned[kind], { op: 'probe', workerId: invite.workerId, nonce }, undefined, agent);
        const want = Buffer.from(proof(hash(invite.code), invite.workerId, nonce, owned[kind]));
        const got = Buffer.from(typeof res.proof === 'string' ? res.proof : '');
        if (got.length !== want.length || !timingSafeEqual(want, got)) throw refused('wrong_coordinator');
        observations.push({ kind, status: 'selected' });
        return { kind, origin: owned[kind], observations };
      } catch { status = 'probe_failed'; }
    }
    observations.push({ kind, status });
  }
  throw Object.assign(refused('no_verified_transport'), { observations });
}

export async function join(invite, owned, options) {
  const transport = await selectTransport(invite, owned, options);
  const origin = transport.origin;
  const post = (body, token) => request(origin, body, token, options?.agent);
  const result = await post({ op: 'pair', workerId: invite.workerId, code: invite.code });
  if (result.workerId !== invite.workerId || !/^wjt_[\w-]{43}$/.test(result.token) || !Array.isArray(result.scopes) || !result.scopes.every(s => scopes.includes(s))) throw refused('invalid_response');
  let token = result.token;
  return Object.freeze({ workerId: invite.workerId, transport, scopes: Object.freeze([...result.scopes]), expiresAt: result.expiresAt,
    heartbeat: () => post({ op: 'heartbeat', platform: process.platform, arch: process.arch }, token),
    async refresh() {
      const next = await post({ op: 'refresh' }, token);
      if (!/^wjt_[\w-]{43}$/.test(next.token) || next.workerId !== invite.workerId) throw refused('invalid_response');
      token = next.token; return next.expiresAt;
    },
    claim: () => post({ op: 'claim' }, token),
    claimBrief: () => post({op:'claim-brief'},token),
    statusBrief: attemptId => post({op:'status-brief',attemptId},token),
    reportBrief: ({attemptId,sourceRev,a,b,kind}) => {
      if(kind!=='sum-v1'||![a,b].every(x=>Number.isInteger(x)&&x>=0&&x<=1000))throw refused('invalid_brief');
      return post({op:'report-brief',attemptId,sourceRev,total:a+b},token);
    },
    async report(taskId) {
      return post({ op: 'report', taskId, sha256: installedDigest() }, token);
    },
  });
}

// The invitation is read on stdin, never an argv secret or a URL. Only an
// explicit --https or --loopback value authorizes one exact endpoint per kind.
async function main(args) {
  const owned = {}; let only, once = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--once') once = true;
    else if (args[i] === '--only') only = args[++i];
    else if (args[i] === '--https' || args[i] === '--loopback') {
      const kind = args[i].slice(2);
      if (Object.hasOwn(owned,kind)) throw refused('duplicate_endpoint');
      owned[kind] = validateOwnedEndpoint(args[++i],kind);
    } else throw refused('invalid_arguments');
  }
  if (!Object.keys(owned).length) throw refused('explicit_owned_endpoint_required');
  let size = 0; const input = [];
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 4096) throw refused('invalid_invitation'); input.push(chunk);
  }
  let invite;
  try { invite = JSON.parse(Buffer.concat(input).toString('utf8')); } catch { throw refused('invalid_invitation'); }
  const session = await join(invite,owned,{ only });
  console.log(JSON.stringify({ workerId: session.workerId, observations: session.transport.observations }));
  let expiresAt = session.expiresAt;
  do {
    if (Date.now() >= expiresAt) throw refused('credential_denied');
    // An uncertain refresh is not replayed: the old credential may have been consumed.
    if (Date.now() + 30_000 >= expiresAt) expiresAt = await session.refresh();
    try {
      if (session.scopes.includes('presence')) await session.heartbeat();
      if (session.scopes.includes('sum-brief')) { const {brief}=await session.claimBrief(); if(brief)await session.reportBrief(brief); }
      if (session.scopes.includes('verify-client')) {
        const { task } = await session.claim();
        if (task?.kind === 'hash-installed-client') await session.report(task.taskId);
      }
    } catch (error) { if (once || error.code !== 'unreachable') throw error; }
    if (!once) await pause(5000);
  } while (!once);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch(err => {
    console.error(JSON.stringify({ error: err.code || 'join_failed', observations: err.observations,
      next: 'Check the exact owned numeric loopback endpoint; obtain a fresh invitation if pairing was consumed.' }));
    process.exitCode = 1;
  });
}
