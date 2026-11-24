// Approved acceptance tests for the coordinator-only worker artifact API (contract OA1-artifact, written first: RED).
// Amended by OA2-artifact-auth: ownership is a per-attempt capability returned once by `create`; the rig sends
// the attempt's capability on artifact reads unless a test sets `capability` itself.
// POST /api/local-workers {op:'artifact', attempt_id, coordinator} returns the completed worker patch with its
// sha256, the coordinator's source_rev and launcher-observed metadata. Orbit computes the result path itself,
// refuses symlinks, oversized or malformed files and substituted artifacts, and never logs or lists raw patches.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync, existsSync } from 'node:fs';
import { createLocalWorkersRoute } from '../server/local-workers-route.mjs';

const KEY = 'k'.repeat(48);
const TOKEN = 't'.repeat(64);
const SRC = 'a'.repeat(40);
const DIFF = 'diff --git a/x.py b/x.py\nnew file mode 100644\n--- /dev/null\n+++ b/x.py\n@@ -0,0 +1 @@\n+VALUE = 2\n';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function manifest(id, over = {}) {
  return {
    schema: 'orbit.local-worker.result/v1', attempt_id: id,
    source: { project: 'demo', repo_rev: SRC, input_manifest_sha256: 'm'.repeat(64), model: 'deepseek-v4.1-flash', launcher: '0.1.15' },
    observed: { node: 'private-node-name', run_id: 'run-1', sandbox_id: 'local:x', workdir: '/home/cua/work/demo', local_base_rev: SRC,
      result_file: 'C:/Users/someone/attempts/x.result.json', status: 'completed', stop_reason: 'end_turn', tool_calls: 7,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, files: [{ path: 'x.py', sha256: 's'.repeat(64), change: 'added', in_assigned_scope: true }] },
    patch: { diff: DIFF, files: [{ path: 'x.py' }] },
    worker_claims: { summary: 'I verified everything', checks: [{ name: 'tests', passed: true }] },
    note: 'worker_claims are self-reported', ...over,
  };
}

// Minimal stand-in for the PC launcher's /v1 API. The test controls each attempt's state and result body.
async function fakeLauncher() {
  const attempts = {};
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/v1/attempts') {
      const b = JSON.parse(body); attempts[b.attempt_id] = { state: 'running', result: null, resultStatus: 404 };
      return send(201, { attempt_id: b.attempt_id, state: 'running', run_id: 'run-1', detail: 'running' });
    }
    if (u.pathname === '/v1/config') return send(404, {});
    const m = u.pathname.match(/^\/v1\/attempts\/([^/]+)(\/events|\/result|\/cancel)?$/);
    const a = m && attempts[m[1]]; if (!a) return send(404, { error: 'unknown' });
    if (m[2] === '/events') return send(200, { events: [], cursor: 0 });
    if (m[2] === '/result') return a.resultStatus === 200 ? send(200, a.result) : send(a.resultStatus, { error: 'no result' });
    return send(200, { attempt_id: m[1], state: a.state, detail: a.state });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { attempts, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

async function orbit(launcherUrl, envExtra = {}) {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'orbit-artifact-'));
  writeFileSync(path.join(runtimeRoot, 'collab-board.key'), KEY);
  const logs = [];
  const env = { ORBIT_LOCAL_WORKERS_URL: launcherUrl, ORBIT_LOCAL_WORKERS_POLL_MS: '3600000', ORBIT_LOCAL_WORKERS_MAX: '10', ...envExtra };
  const tokenFile = path.join(runtimeRoot, 'launcher.token'); writeFileSync(tokenFile, TOKEN); env.ORBIT_LOCAL_WORKERS_TOKEN_FILE = tokenFile;
  const route = createLocalWorkersRoute({ runtimeRoot, port: 1, env, log: (...m) => logs.push(m.join(' ')) });
  const srv = http.createServer((req, res) => route.handle(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const caps = new Map();
  const call = async (body, key = KEY) => {
    if (body && body.op === 'artifact' && !('capability' in body) && caps.has(body.attempt_id)) body = { ...body, capability: caps.get(body.attempt_id) };
    const r = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text(); return { status: r.status, text, json: JSON.parse(text) };
  };
  const dir = path.join(runtimeRoot, 'local-workers');
  return { route, call, caps, logs, dir, runtimeRoot, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

// Create an attempt through the real Orbit API and drive it to `state` on the fake launcher.
async function attempt(O, L, { state = 'succeeded', result, coordinator = 'MR.INDIA' } = {}) {
  const c = await O.call({ op: 'create', task_id: 't_' + Math.random().toString(16).slice(2), group: 'g', coordinator, brief: { objective: 'x', source_rev: SRC, assigned_files: ['x.py'] } });
  assert.equal(c.status, 201, c.text);
  const id = c.json.attempt_id;
  if (c.json.artifact_capability) O.caps.set(id, c.json.artifact_capability);
  L.attempts[id].state = state;
  if (result !== null) { L.attempts[id].result = typeof result === 'function' ? result(id) : (result || manifest(id)); L.attempts[id].resultStatus = 200; }
  await O.call({ op: 'tick' }); await O.call({ op: 'tick' });
  return id;
}

async function withRig(fn, envExtra) {
  const L = await fakeLauncher(); const O = await orbit(L.url, envExtra);
  try { await fn(O, L); } finally { await O.close(); await L.close(); rmSync(O.runtimeRoot, { recursive: true, force: true }); }
}

test('AC-001 succeeded attempt: patch, its sha256, coordinator source_rev and observed metadata are returned', () => withRig(async (O, L) => {
  const id = await attempt(O, L);
  const r = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 200, r.text);
  const a = r.json;
  assert.equal(a.artifact_version, 'orbit.worker-artifact/1');
  assert.equal(a.attempt_id, id);
  assert.equal(a.state, 'succeeded');
  assert.equal(a.source_rev, SRC); // from the coordinator's brief in Orbit's ledger, not from the worker
  assert.equal(a.patch, DIFF);
  assert.equal(a.patch_sha256, sha(DIFF));
  assert.match(a.result_sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.observed.local_base_rev, SRC);
  assert.equal(a.observed.tool_calls, 7);
  assert.deepEqual(a.observed.files.map((f) => f.path), ['x.py']);
  assert.deepEqual(a.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, source: 'launcher_reported' });
  assert.equal(a.model, 'deepseek-v4.1-flash');
  assert.equal(a.worker_claims_untrusted.summary, 'I verified everything');
  for (const leak of ['private-node-name', '/home/cua', 'C:/Users', 'result_file', 'workdir']) assert.ok(!r.text.includes(leak), leak);
}));

test('AC-002 only the coordinator key on loopback, and only the holder of the attempt capability, may read an artifact', () => withRig(async (O, L) => {
  const id = await attempt(O, L, { coordinator: 'MR.INDIA' });
  assert.equal((await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' }, 'wrong'.repeat(10))).status, 401);
  // Impersonation: the valid shared key plus the owner's coordinator NAME, but not its capability, must fail.
  const forged = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA', capability: 'x'.repeat(43) });
  assert.equal(forged.status, 403); assert.equal(forged.json.code, 'not_owner'); assert.ok(!forged.text.includes('VALUE = 2'));
  const none = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA', capability: undefined });
  assert.equal(none.status, 403); assert.equal(none.json.code, 'capability_required');
}));

test('AC-003 attempt ids are validated: traversal, unknown and malformed ids are refused', () => withRig(async (O) => {
  for (const bad of ['../ledger', 'att_../../collab-board', 'ledger', 'att_0123', '', null, 7]) {
    const r = await O.call({ op: 'artifact', attempt_id: bad, coordinator: 'MR.INDIA' });
    assert.equal(r.status, 400, String(bad)); assert.equal(r.json.code, 'invalid_attempt_id');
  }
  const r = await O.call({ op: 'artifact', attempt_id: 'att_0123456789abcdef', coordinator: 'MR.INDIA' });
  assert.equal(r.status, 404); assert.equal(r.json.code, 'unknown_attempt');
}));

test('AC-004 pending, disconnected and patchless states are explicit', () => withRig(async (O, L) => {
  const running = await attempt(O, L, { state: 'running', result: null });
  let r = await O.call({ op: 'artifact', attempt_id: running, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'result_pending'); assert.equal(r.json.state, 'running');
  O.route.lw.get(running).state = 'disconnected';
  r = await O.call({ op: 'artifact', attempt_id: running, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 503); assert.equal(r.json.code, 'worker_disconnected');
  const cancelled = await attempt(O, L, { state: 'cancelled', result: null });
  r = await O.call({ op: 'artifact', attempt_id: cancelled, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'no_result_for_state');
  const failed = await attempt(O, L, { state: 'failed', result: (i) => ({ ...manifest(i), patch: null }) });
  r = await O.call({ op: 'artifact', attempt_id: failed, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.state, 'failed'); assert.equal(r.json.patch, null); assert.equal(r.json.patch_sha256, null);
  
}));

test('AC-005 missing results are refetched once from the launcher (restart recovery); still-missing and unreachable are explicit', () => withRig(async (O, L) => {
  const id = await attempt(O, L);
  const file = path.join(O.dir, `${id}.result.json`);
  rmSync(file); // e.g. Orbit restarted after the state change but before the result was saved
  let r = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.patch_sha256, sha(DIFF)); assert.ok(existsSync(file));
  const id2 = await attempt(O, L);
  rmSync(path.join(O.dir, `${id2}.result.json`)); L.attempts[id2].resultStatus = 404;
  r = await O.call({ op: 'artifact', attempt_id: id2, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 404); assert.equal(r.json.code, 'result_missing');
  await L.close();
  r = await O.call({ op: 'artifact', attempt_id: id2, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 503); assert.equal(r.json.code, 'launcher_unreachable');
}));

test('AC-006 malformed, oversized and symlinked result files are refused', () => withRig(async (O, L) => {
  const a = await attempt(O, L); writeFileSync(path.join(O.dir, `${a}.result.json`), '{not json');
  let r = await O.call({ op: 'artifact', attempt_id: a, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 502); assert.equal(r.json.code, 'artifact_malformed');
  const b = await attempt(O, L, { result: (i) => ({ ...manifest(i), patch: { diff: 42 } }) });
  r = await O.call({ op: 'artifact', attempt_id: b, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 502); assert.equal(r.json.code, 'artifact_malformed');
  const c = await attempt(O, L); const cf = path.join(O.dir, `${c}.result.json`);
  const outside = path.join(O.runtimeRoot, 'collab-board.key'); rmSync(cf); symlinkSync(outside, cf);
  r = await O.call({ op: 'artifact', attempt_id: c, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'artifact_unsafe'); assert.ok(!r.text.includes(KEY));
}, { ORBIT_WORKER_ARTIFACT_MAX_BYTES: '1000000' }));

test('AC-006b oversized artifacts are refused before parsing', () => withRig(async (O, L) => {
  const big = (i) => ({ ...manifest(i), patch: { diff: DIFF + '+' + 'x'.repeat(5000) + '\n' } });
  const id = await attempt(O, L, { result: big });
  const r = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 413); assert.equal(r.json.code, 'artifact_oversized');
}, { ORBIT_WORKER_ARTIFACT_MAX_BYTES: '4096' }));

test('AC-007 artifacts are bound to their attempt and source_rev, and substitution after first read is refused', () => withRig(async (O, L) => {
  const wrongId = await attempt(O, L, { result: manifest('att_ffffffffffffffff') });
  let r = await O.call({ op: 'artifact', attempt_id: wrongId, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'artifact_mismatch');
  const wrongRev = await attempt(O, L, { result: (i) => ({ ...manifest(i), source: { repo_rev: 'b'.repeat(40) } }) });
  r = await O.call({ op: 'artifact', attempt_id: wrongRev, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'artifact_mismatch');
  const id = await attempt(O, L);
  const first = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
  const again = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
  assert.equal(first.status, 200); assert.equal(again.text, first.text); // idempotent
  const file = path.join(O.dir, `${id}.result.json`);
  const m = JSON.parse(readFileSync(file, 'utf8')); m.patch.diff = DIFF.replace('VALUE = 2', 'VALUE = 3'); writeFileSync(file, JSON.stringify(m));
  r = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'artifact_changed'); assert.ok(!r.text.includes('VALUE = 3'));
}));

test('AC-008 the first-read hash survives an Orbit restart (idempotent, substitution still detected)', async () => {
  const L = await fakeLauncher(); let O = await orbit(L.url);
  try {
    const id = await attempt(O, L);
    const first = await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
    await O.close();
    assert.equal(first.status, 200, first.text);
    const route = createLocalWorkersRoute({ runtimeRoot: O.runtimeRoot, port: 1, env: { ORBIT_LOCAL_WORKERS_URL: L.url, ORBIT_LOCAL_WORKERS_TOKEN_FILE: path.join(O.runtimeRoot, 'launcher.token'), ORBIT_LOCAL_WORKERS_POLL_MS: '3600000' } });
    const srv = http.createServer((q, s) => route.handle(q, s)); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const cap = O.caps.get(id); // the capability survives a restart only on the coordinator side
    const post = async (b) => { b = { capability: cap, ...b }; const r = await fetch(`http://127.0.0.1:${srv.address().port}`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: JSON.stringify(b) }); return { status: r.status, text: await r.text() }; };
    try {
      const again = await post({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
      assert.equal(again.status, 200); assert.equal(again.text, first.text);
      const file = path.join(O.dir, `${id}.result.json`);
      const m = JSON.parse(readFileSync(file, 'utf8')); m.patch.diff += '+extra\n'; writeFileSync(file, JSON.stringify(m));
      assert.equal((await post({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' })).status, 409);
    } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
  } finally { await L.close(); rmSync(O.runtimeRoot, { recursive: true, force: true }); }
});

test('AC-009 raw patches stay out of list/get responses and logs; result files are private', () => withRig(async (O, L) => {
  const id = await attempt(O, L);
  await O.call({ op: 'artifact', attempt_id: id, coordinator: 'MR.INDIA' });
  const g = await O.call({ op: 'get', attempt_id: id });
  const l = await O.call({ op: 'list' });
  for (const t of [g.text, l.text, O.logs.join('\n')]) { assert.ok(!t.includes('VALUE = 2')); assert.ok(!t.includes(O.dir)); }
  assert.equal(g.json.result.available, true);
  assert.equal(g.json.result.ref, undefined);
  assert.equal(statSync(path.join(O.dir, `${id}.result.json`)).mode & 0o077, 0);
}));
