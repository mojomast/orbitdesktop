// Approved acceptance tests for contract OA2-artifact-auth (written first: RED). Fixes review findings S2, S6, S7.
// S2: ownership is derived on the server from a per-attempt capability that `create` returns exactly once; the
//     coordinator name in a request body is only a label. The ledger keeps only the capability's sha256.
// S6: the launcher result body is size-limited while it streams, before anything is persisted.
// S7: an artifact needs both the launcher-declared source.repo_rev and the coordinator-pinned source_rev.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { createLocalWorkersRoute } from '../server/local-workers-route.mjs';

const KEY = 'k'.repeat(48);
const TOKEN = 't'.repeat(64);
const SRC = 'a'.repeat(40);
const DIFF = 'diff --git a/x.py b/x.py\nnew file mode 100644\n--- /dev/null\n+++ b/x.py\n@@ -0,0 +1 @@\n+VALUE = 2\n';
const sha = (s) => createHash('sha256').update(s).digest('hex');

const manifest = (id, over = {}) => ({
  schema: 'orbit.local-worker.result/v1', attempt_id: id,
  source: { project: 'demo', repo_rev: SRC, model: 'deepseek-v4.1-flash', launcher: '0.1.15' },
  observed: { run_id: 'run-1', local_base_rev: SRC, status: 'completed', stop_reason: 'end_turn', tool_calls: 3, files: [] },
  patch: { diff: DIFF, files: [{ path: 'x.py' }] }, ...over,
});

async function fakeLauncher() {
  const attempts = {}; let resultBytes = 0;
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/v1/attempts') {
      const b = JSON.parse(body); attempts[b.attempt_id] = { state: 'succeeded', result: manifest(b.attempt_id) };
      return send(201, { attempt_id: b.attempt_id, state: 'running', run_id: 'run-1' });
    }
    if (u.pathname === '/v1/config') return send(404, {});
    const m = u.pathname.match(/^\/v1\/attempts\/([^/]+)(\/events|\/result|\/cancel)?$/);
    const a = m && attempts[m[1]]; if (!a) return send(404, { error: 'unknown' });
    if (m[2] === '/events') return send(200, { events: [], cursor: 0 });
    if (m[2] === '/result') {
      if (a.stream) { // a huge body sent in chunks without Content-Length, honouring backpressure
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"schema":"orbit.local-worker.result/v1","pad":"');
        const chunk = 'x'.repeat(64 * 1024);
        for (let i = 0; i < a.stream; i++) {
          if (res.destroyed || res.socket?.destroyed) return;
          resultBytes += chunk.length;
          if (!res.write(chunk)) {
            const go = await new Promise((r) => { res.once('drain', () => r(true)); res.once('close', () => r(false)); });
            if (!go) return;
          }
        }
        return res.end('"}');
      }
      return send(200, typeof a.result === 'function' ? a.result(m[1]) : a.result);
    }
    return send(200, { attempt_id: m[1], state: a.state, detail: a.state });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { attempts, sent: () => resultBytes, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

async function rig(fn, envExtra = {}) {
  const L = await fakeLauncher();
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'orbit-artifact-auth-'));
  writeFileSync(path.join(runtimeRoot, 'collab-board.key'), KEY);
  const tokenFile = path.join(runtimeRoot, 'launcher.token'); writeFileSync(tokenFile, TOKEN);
  const logs = [];
  const env = { ORBIT_LOCAL_WORKERS_URL: L.url, ORBIT_LOCAL_WORKERS_TOKEN_FILE: tokenFile, ORBIT_LOCAL_WORKERS_POLL_MS: '3600000', ORBIT_LOCAL_WORKERS_MAX: '10', ...envExtra };
  const route = createLocalWorkersRoute({ runtimeRoot, port: 1, env, log: (...m) => logs.push(m.join(' ')) });
  const srv = http.createServer((req, res) => route.handle(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (body, key = KEY) => {
    const r = await fetch(base, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text(); return { status: r.status, text, json: JSON.parse(text) };
  };
  const create = async (over = {}) => {
    const c = await call({ op: 'create', task_id: 't_' + Math.random().toString(16).slice(2), group: 'g', coordinator: 'MR.INDIA', brief: { objective: 'x', source_rev: SRC, assigned_files: ['x.py'], ...over } });
    assert.equal(c.status, 201, c.text); return c;
  };
  const finish = async () => { await call({ op: 'tick' }); await call({ op: 'tick' }); };
  const dir = path.join(runtimeRoot, 'local-workers');
  try { await fn({ L, call, create, finish, logs, dir, runtimeRoot }); }
  finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); await L.close(); rmSync(runtimeRoot, { recursive: true, force: true }); }
}

test('S2-AC-001 create returns a per-attempt artifact capability exactly once; only its sha256 is stored', () => rig(async ({ create, call, finish, dir, logs }) => {
  const c = await create();
  const cap = c.json.artifact_capability;
  assert.match(cap, /^[A-Za-z0-9_-]{43}$/);
  await finish();
  const id = c.json.attempt_id;
  for (const r of [await call({ op: 'get', attempt_id: id }), await call({ op: 'list' })]) {
    assert.ok(!r.text.includes(cap), 'capability must not be listed');
    assert.ok(!r.text.includes('capability_sha256'), 'capability hash must not be listed');
  }
  const ledgerText = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json')).map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n')
    + (existsSync(path.join(dir, '..', 'local-workers.json')) ? readFileSync(path.join(dir, '..', 'local-workers.json'), 'utf8') : '');
  assert.ok(!ledgerText.includes(cap), 'raw capability must not be persisted');
  assert.ok(!logs.join('\n').includes(cap), 'capability must not be logged');
  const ok = await call({ op: 'artifact', attempt_id: id, capability: cap });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.patch, DIFF);
}));

test('S2-AC-002 a valid shared key plus an impersonated coordinator name cannot read another attempt', () => rig(async ({ create, call, finish }) => {
  const mine = await create(); const theirs = await create();
  await finish();
  // Same coordinator name, shared key, but the capability of a different attempt.
  const cross = await call({ op: 'artifact', attempt_id: theirs.json.attempt_id, coordinator: 'MR.INDIA', capability: mine.json.artifact_capability });
  assert.equal(cross.status, 403); assert.equal(cross.json.code, 'not_owner'); assert.ok(!cross.text.includes('VALUE = 2'));
  const nameOnly = await call({ op: 'artifact', attempt_id: theirs.json.attempt_id, coordinator: 'MR.INDIA' });
  assert.equal(nameOnly.status, 403); assert.equal(nameOnly.json.code, 'capability_required');
  const ok = await call({ op: 'artifact', attempt_id: theirs.json.attempt_id, coordinator: 'ANY-LABEL', capability: theirs.json.artifact_capability });
  assert.equal(ok.status, 200, 'the coordinator name is a label, not authority');
  // Even after the owner's first read (pinned), a name-only request is still refused.
  const after = await call({ op: 'artifact', attempt_id: theirs.json.attempt_id, coordinator: 'MR.INDIA' });
  assert.equal(after.status, 403); assert.equal(after.json.code, 'capability_required'); assert.ok(!after.text.includes('VALUE = 2'));
}));

test('S6-AC-003 an oversized launcher result is refused while streaming and never persisted', () => rig(async ({ L, create, call, finish, dir }) => {
  const c = await create(); const id = c.json.attempt_id;
  L.attempts[id].stream = 1024; // 64 MiB body, no Content-Length
  await finish();
  await new Promise((r) => setTimeout(r, 200));
  // Socket buffers may absorb a few MiB; reading the whole 64 MiB means the limit was not enforced while streaming.
  assert.ok(L.sent() < 32 * 1024 * 1024, `Orbit must stop reading once over the limit (sent ${L.sent()})`);
  assert.ok(!existsSync(path.join(dir, `${id}.result.json`)), 'nothing may be persisted');
  const r = await call({ op: 'artifact', attempt_id: id, capability: c.json.artifact_capability });
  assert.equal(r.status, 413, r.text); assert.equal(r.json.code, 'artifact_oversized');
}, { ORBIT_WORKER_ARTIFACT_MAX_BYTES: '65536' }));

test('S7-AC-004 an artifact needs both the launcher-declared and the coordinator-pinned revision', () => rig(async ({ L, create, call, finish }) => {
  const noDeclared = await create();
  L.attempts[noDeclared.json.attempt_id].result = (i) => manifest(i, { source: { project: 'demo', model: 'm' } });
  const noPinned = await create({ source_rev: undefined });
  await finish();
  const a = await call({ op: 'artifact', attempt_id: noDeclared.json.attempt_id, capability: noDeclared.json.artifact_capability });
  assert.equal(a.status, 409, a.text); assert.equal(a.json.code, 'revision_missing');
  const b = await call({ op: 'artifact', attempt_id: noPinned.json.attempt_id, capability: noPinned.json.artifact_capability });
  assert.equal(b.status, 409, b.text); assert.equal(b.json.code, 'revision_missing');
}));

test('S2-AC-005 attempts created before capabilities existed are refused (fail closed)', () => rig(async ({ create, call, finish, runtimeRoot }) => {
  const c = await create(); await finish();
  const id = c.json.attempt_id;
  // Simulate a pre-OA2 ledger entry: strip the stored capability hash wherever the ledger keeps it.
  const { readdirSync: ls } = await import('node:fs');
  const files = [path.join(runtimeRoot, 'local-workers.json'), ...ls(path.join(runtimeRoot, 'local-workers')).map((f) => path.join(runtimeRoot, 'local-workers', f))].filter((f) => existsSync(f) && f.endsWith('.json') && !f.endsWith('.result.json'));
  let stripped = false;
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    if (t.includes('capability_sha256')) { writeFileSync(f, t.replace(/"capability_sha256":\s*"[0-9a-f]{64}",?/g, '')); stripped = true; }
  }
  assert.ok(stripped, 'the ledger must store capability_sha256');
  // The route reads the ledger at start-up; a fresh route on the same runtime sees the legacy entry.
  const route2 = createLocalWorkersRoute({ runtimeRoot, port: 1, env: { ORBIT_LOCAL_WORKERS_URL: 'http://127.0.0.1:9', ORBIT_LOCAL_WORKERS_POLL_MS: '3600000', ORBIT_LOCAL_WORKERS_TOKEN_FILE: path.join(runtimeRoot, 'launcher.token') }, log: () => {} });
  const srv = http.createServer((req, res) => route2.handle(req, res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'artifact', attempt_id: id, capability: c.json.artifact_capability }) });
    const j = await r.json();
    assert.equal(r.status, 403); assert.equal(j.code, 'capability_required');
  } finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); }
}));
