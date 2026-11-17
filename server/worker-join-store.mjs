import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CLIENT_SHA256 } from './worker-join-artifact.mjs';

export const PAIR_MS = 15 * 60_000;
export const TOKEN_MS = 5 * 60_000;
export const SESSION_MS = 60 * 60_000;
export class JoinError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function fail(status, code) { throw new JoinError(status, code); }
const id = () => randomBytes(16).toString('hex');
const secret = prefix => prefix + randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const protocol = 'orbit.worker-join/1';
const validId = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const knownScopes = ['presence','verify-client','sum-brief'];
export const ownerOps = new Set(['invite','inventory','revoke','queue-verification','review-verification']);
const fields = {
  invite: ['label','scopes'], inventory: [], revoke: ['workerId'], 'queue-verification': ['workerId'], 'review-verification': ['taskId'],
  probe: ['workerId','nonce'], pair: ['workerId','code'], heartbeat: ['platform','arch'], refresh: [], claim: [], report: ['taskId','sha256'],
  'claim-brief': [], 'status-brief':['attemptId'], 'report-brief':['attemptId','sourceRev','total'],
};
function validate(b) {
  if (!b || typeof b.op !== 'string' || !Object.hasOwn(fields, b.op) ||
      Object.keys(b).length !== fields[b.op].length + 1 || !fields[b.op].every(k => Object.hasOwn(b,k))) fail(400,'invalid_request');
  if (('workerId' in b && !validId(b.workerId)) || ('taskId' in b && !validId(b.taskId))) fail(400,'invalid_request');
  if (b.op === 'invite' && (typeof b.label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,47}$/.test(b.label) ||
      !Array.isArray(b.scopes) || !b.scopes.length || b.scopes.length > knownScopes.length || new Set(b.scopes).size !== b.scopes.length || !b.scopes.every(s => knownScopes.includes(s)))) fail(400,'invalid_request');
  if ('attemptId' in b && (typeof b.attemptId!=='string'||!/^att_[a-f0-9]{16}$/.test(b.attemptId))) fail(400,'invalid_request');
  if (b.op==='report-brief' && (typeof b.sourceRev!=='string'||!/^([a-f0-9]{40})$/.test(b.sourceRev)||!Number.isInteger(b.total)|| b.total<0||b.total>2000)) fail(400,'invalid_request');
  if (b.op === 'heartbeat' && (!['linux','darwin','win32'].includes(b.platform) || !['arm64','x64','arm','ia32','riscv64'].includes(b.arch))) fail(400,'invalid_request');
  if (b.op === 'probe' && (typeof b.nonce !== 'string' || !/^[0-9a-f]{48}$/.test(b.nonce))) fail(400,'invalid_request');
  if (b.op === 'report' && (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256))) fail(400,'invalid_request');
}

// Authority lives in one private DB, not an in-memory session/tunnel. Every
// read/modify/write (including credential checks) serializes across processes.
export function openWorkerJoinStore(runtimeRoot, now = Date.now) {
  const dir = path.join(runtimeRoot, 'worker-join');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ds = fs.lstatSync(dir);
  if (!ds.isDirectory() || ds.mode & 0o077 || ds.uid !== process.getuid?.()) throw Error('private worker-join directory required');
  const file = path.join(dir,'registry.sqlite');
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.mode & 0o077 || st.uid !== ds.uid) throw Error('unsafe worker-join registry');
  } finally { fs.closeSync(fd); }
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON'); db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS workers (
      workerId TEXT PRIMARY KEY, label TEXT NOT NULL, scopes TEXT NOT NULL,
      issuedAt INTEGER NOT NULL, inviteUntil INTEGER NOT NULL, inviteHash TEXT, pairedAt INTEGER,
      tokenHash TEXT UNIQUE, tokenUntil INTEGER, revokedAt INTEGER, lastSeen INTEGER, platform TEXT, arch TEXT);
      CREATE TABLE IF NOT EXISTS tasks (taskId TEXT PRIMARY KEY, workerId TEXT NOT NULL REFERENCES workers,
      expectedSha256 TEXT NOT NULL, observedSha256 TEXT, state TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open ON tasks(workerId) WHERE state IN ('queued','claimed','reported');
      CREATE TABLE IF NOT EXISTS sum_briefs(attemptId TEXT PRIMARY KEY,workerId TEXT NOT NULL REFERENCES workers,
        sourceRev TEXT NOT NULL, a INTEGER NOT NULL CHECK(a BETWEEN 0 AND 1000), b INTEGER NOT NULL CHECK(b BETWEEN 0 AND 1000),
        state TEXT NOT NULL CHECK(state IN ('queued','claimed','reported','quarantined','accepted','rejected')), total INTEGER, waveCommit TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_brief ON sum_briefs(workerId) WHERE state IN ('queued','claimed','reported');`);
  } catch (error) { db.close(); throw error; }
  const query = s => db.prepare(s);
  const worker = wid => query('SELECT * FROM workers WHERE workerId=?').get(wid);
  function status(w, t) {
    if (w.revokedAt !== null) return 'revoked';
    if (w.pairedAt === null) return t < w.inviteUntil ? 'invited' : 'expired';
    return t < w.tokenUntil ? 'paired' : 'expired';
  }
  function rotate(w, t, until) {
    const token = secret('wjt_'), expiresAt = Math.min(t + TOKEN_MS, until);
    query('UPDATE workers SET tokenHash=?,tokenUntil=? WHERE workerId=?').run(hash(token),expiresAt,w.workerId);
    return { workerId: w.workerId, token, expiresAt, scopes: JSON.parse(w.scopes), refresh: { path: '/api/local-workers', op: 'refresh' } };
  }
  const transact = db.transaction((b, bearer, owner, orbitUrl) => {
    validate(b);
    const t = now();
    if (ownerOps.has(b.op)) {
      if (owner !== true) fail(403,'owner_required');
      if (b.op === 'inventory') {
        const workers = query('SELECT workerId,label,scopes,issuedAt,inviteUntil,pairedAt,tokenUntil,revokedAt,lastSeen,platform,arch FROM workers ORDER BY issuedAt,workerId').all();
        return { workers: workers.map(w => ({ ...w, scopes: JSON.parse(w.scopes), state: status(w,t) })),
          briefs: query('SELECT attemptId,workerId,sourceRev,state,waveCommit FROM sum_briefs ORDER BY rowid DESC LIMIT 256').all(),
          tasks: query('SELECT taskId,workerId,expectedSha256,observedSha256,state,createdAt FROM tasks ORDER BY createdAt,taskId').all() };
      }
      if (b.op === 'invite') {
        if (query('SELECT count(*) AS n FROM workers').get().n >= 256) fail(409,'inventory_full');
        const workerId = id(), code = secret('wjp_'), expiresAt = t + PAIR_MS;
        query('INSERT INTO workers(workerId,label,scopes,issuedAt,inviteUntil,inviteHash) VALUES(?,?,?,?,?,?)').run(workerId,b.label,JSON.stringify(b.scopes),t,expiresAt,hash(code));
        return { protocol, workerId, code, expiresAt, orbitUrl };
      }
      if (b.op === 'review-verification') {
        const task = query('SELECT * FROM tasks WHERE taskId=?').get(b.taskId);
        if (!task || task.state !== 'reported' || status(worker(task.workerId),t) !== 'paired') fail(409,'task_unavailable');
        const state = task.expectedSha256 === task.observedSha256 ? 'digest_matched' : 'digest_mismatch';
        query('UPDATE tasks SET state=? WHERE taskId=?').run(state,b.taskId);
        return { taskId: b.taskId, state };
      }
      const w = worker(b.workerId);
      if (!w) fail(404,'unknown_worker');
      if (b.op === 'revoke') {
        query('UPDATE workers SET revokedAt=COALESCE(revokedAt,?),inviteHash=NULL,tokenHash=NULL WHERE workerId=?').run(t,b.workerId);
        const n = query("UPDATE tasks SET state='quarantined' WHERE workerId=? AND state IN ('queued','claimed','reported')").run(b.workerId).changes;
        const briefs=query("UPDATE sum_briefs SET state='quarantined' WHERE workerId=? AND state IN ('queued','claimed','reported')").run(b.workerId).changes;
        return { workerId: b.workerId, state: 'revoked', quarantined: n+briefs };
      }
      if (status(w,t) !== 'paired' || !JSON.parse(w.scopes).includes('verify-client')) fail(409,'worker_unavailable');
      if (query('SELECT count(*) AS n FROM tasks').get().n >= 1024) fail(409,'inventory_full');
      if (query("SELECT 1 FROM tasks WHERE workerId=? AND state IN ('queued','claimed','reported')").get(w.workerId)) fail(409,'task_pending');
      const taskId = id();
      query("INSERT INTO tasks(taskId,workerId,expectedSha256,state,createdAt) VALUES(?,?,?,'queued',?)").run(taskId,w.workerId,CLIENT_SHA256,t);
      return { taskId, state: 'queued' };
    }
    if (b.op === 'probe' || b.op === 'pair') {
      const w = worker(b.workerId);
      if (!w || !w.inviteHash || status(w,t) !== 'invited') fail(401,'pairing_denied');
      if (b.op === 'probe') return { proof: createHmac('sha256',Buffer.from(w.inviteHash,'hex')).update(`${protocol}:${w.workerId}:${b.nonce}:${orbitUrl}`).digest('hex') };
      if (typeof b.code !== 'string' || !/^wjp_[\w-]{43}$/.test(b.code) || hash(b.code) !== w.inviteHash) fail(401,'pairing_denied');
      query('UPDATE workers SET inviteHash=NULL,pairedAt=?,lastSeen=? WHERE workerId=?').run(t,t,w.workerId);
      return rotate(w,t,t + SESSION_MS);
    }
    const w = typeof bearer === 'string' && /^wjt_[\w-]{43}$/.test(bearer) && query('SELECT * FROM workers WHERE tokenHash=?').get(hash(bearer));
    if (!w || status(w,t) !== 'paired') fail(401,'credential_denied');
    if (b.op === 'refresh') return rotate(w,t,w.pairedAt + SESSION_MS);
    if (['claim-brief','status-brief','report-brief'].includes(b.op)) {
      if(!JSON.parse(w.scopes).includes('sum-brief')) fail(403,'scope_denied');
      if(b.op==='claim-brief') {
        const brief=query("SELECT attemptId,sourceRev,a,b FROM sum_briefs WHERE workerId=? AND state IN ('queued','claimed')").get(w.workerId);
        if(!brief)return {brief:null};
        query("UPDATE sum_briefs SET state='claimed' WHERE attemptId=?").run(brief.attemptId);return {brief:{...brief,kind:'sum-v1'}};
      }
      if(b.op==='status-brief'){
        const brief=query('SELECT attemptId,state,waveCommit FROM sum_briefs WHERE workerId=? AND attemptId=?').get(w.workerId,b.attemptId);
        if(!brief)fail(404,'task_unavailable');return {brief};
      }
      if(!query("UPDATE sum_briefs SET total=?,state='reported' WHERE workerId=? AND attemptId=? AND sourceRev=? AND state='claimed'").run(b.total,w.workerId,b.attemptId,b.sourceRev).changes) fail(409,'task_unavailable');
      return {attemptId:b.attemptId,state:'reported'};
    }
    if (!JSON.parse(w.scopes).includes(b.op === 'heartbeat' ? 'presence' : 'verify-client')) fail(403,'scope_denied');
    if (b.op === 'heartbeat') {
      query('UPDATE workers SET lastSeen=?,platform=?,arch=? WHERE workerId=?').run(t,b.platform,b.arch,w.workerId);
      return { workerId: w.workerId, observedAt: t };
    }
    if (b.op === 'claim') {
      const task = query("SELECT taskId FROM tasks WHERE workerId=? AND state IN ('queued','claimed')").get(w.workerId);
      if (!task) return { task: null };
      query("UPDATE tasks SET state='claimed' WHERE taskId=?").run(task.taskId);
      return { task: { taskId: task.taskId, kind: 'hash-installed-client' } };
    }
    if (!query("UPDATE tasks SET state='reported',observedSha256=? WHERE workerId=? AND taskId=? AND state='claimed'").run(b.sha256,w.workerId,b.taskId).changes) fail(409,'task_unavailable');
    return { taskId: b.taskId, state: 'reported' };
  });
  return { dispatch: (...args) => transact.immediate(...args), close: () => db.close() };
}
