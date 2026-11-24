// Approved acceptance tests for W0-3 (written first: RED). Orbit marks and counts creates that skipped bundlebees preflight.
// AC-001 a create with no risk tier is forwarded (warn-only default) and marked ungated with reason no_risk_tier.
// AC-002 a create with a risk tier and an ok preflight is not marked.
// AC-003 the ungated_creates counter increments and is in the list response.
// AC-004 with ORBIT_LOCAL_WORKERS_REQUIRE_PREFLIGHT=1 an ungated create is refused with 422 preflight_required and never reaches the launcher.
// AC-005 any other flag value stays warn-only.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createLocalWorkersRoute } from '../server/local-workers-route.mjs';

const KEY = 'k'.repeat(48);
const TOKEN = 't'.repeat(64);
const SRC = 'a'.repeat(40);
const DIFF = 'diff --git a/x.py b/x.py\nnew file mode 100644\n--- /dev/null\n+++ b/x.py\n@@ -0,0 +1 @@\n+VALUE = 2\n';
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
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'orbit-preflight-'));
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
  const create = async (over = {}) => call({ op: 'create', task_id: 't_' + Math.random().toString(16).slice(2), group: 'g', coordinator: 'MR.INDIA', brief: { objective: 'x', source_rev: SRC, assigned_files: ['x.py'], ...over } });
  const finish = async () => { await call({ op: 'tick' }); await call({ op: 'tick' }); };
  const dir = path.join(runtimeRoot, 'local-workers');
  try { await fn({ L, call, create, finish, logs, dir, runtimeRoot }); }
  finally { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); await L.close(); rmSync(runtimeRoot, { recursive: true, force: true }); }
}


const GATED = { risk: { tier: 'medium' }, preflight: { ok: true, tier: 'medium', floor: 'medium', reasons: [], acdd_mode: 'legacy' } };
const launcherCalls = (L) => Object.keys(L.attempts).length;

describe('preflight', () => {
  test('marks_missing_tier', () => rig(async ({ L, create, call }) => {
    const c = await create({ preflight: GATED.preflight });
    assert.equal(c.status, 201, c.text);
    assert.equal(c.json.ungated, true);
    assert.deepEqual(c.json.ungated_reasons, ['no_risk_tier']);
    assert.equal(launcherCalls(L), 1, 'warn-only still forwards');
    const g = await call({ op: 'get', attempt_id: c.json.attempt_id });
    assert.equal(g.json.ungated, true);
    assert.deepEqual(g.json.ungated_reasons, ['no_risk_tier']);
    const both = await create();
    assert.equal(both.status, 201, both.text);
    assert.deepEqual(both.json.ungated_reasons, ['no_risk_tier', 'no_preflight']);
    const noPre = await create({ risk: { tier: 'low' } });
    assert.deepEqual(noPre.json.ungated_reasons, ['no_preflight']);
    const refused = await create({ risk: { tier: 'low' }, preflight: { ok: false, code: 'risk_tier_below_floor' } });
    assert.deepEqual(refused.json.ungated_reasons, ['no_preflight'], 'a failed preflight is not a preflight');
  }));

  test('clean_create_unmarked', () => rig(async ({ create, call }) => {
    const c = await create(GATED);
    assert.equal(c.status, 201, c.text);
    assert.ok(!c.json.ungated, c.text);
    assert.ok(!c.json.ungated_reasons || c.json.ungated_reasons.length === 0);
    const g = await call({ op: 'get', attempt_id: c.json.attempt_id });
    assert.ok(!g.json.ungated);
  }));

  test('counter_exposed', () => rig(async ({ create, call, logs }) => {
    let l = await call({ op: 'list' });
    assert.equal(l.json.ungated_creates, 0);
    await create(GATED);
    await create();
    await create({ risk: { tier: 'low' } });
    l = await call({ op: 'list' });
    assert.equal(l.json.ungated_creates, 2);
    assert.ok(!logs.join('\n').includes('"objective"'), 'brief contents must not be logged');
  }));

  test('require_mode_refuses', () => rig(async ({ L, create, call }) => {
    const c = await create({ risk: { tier: 'low' } });
    assert.equal(c.status, 422, c.text);
    assert.equal(c.json.code, 'preflight_required');
    assert.ok(c.json.error && c.json.fix, c.text);
    assert.equal(launcherCalls(L), 0, 'refused create must not reach the launcher');
    const ok = await create(GATED);
    assert.equal(ok.status, 201, ok.text);
    assert.equal(launcherCalls(L), 1);
    const l = await call({ op: 'list' });
    assert.equal(l.json.ungated_creates, 1, 'refused ungated creates are still counted');
  }, { ORBIT_LOCAL_WORKERS_REQUIRE_PREFLIGHT: '1' }));

  test('other_values_warn_only', async () => {
    for (const v of ['0', 'true', 'yes', '', ' 1']) {
      await rig(async ({ L, create }) => {
        const c = await create();
        assert.equal(c.status, 201, `flag=${JSON.stringify(v)} ${c.text}`);
        assert.equal(c.json.ungated, true);
        assert.equal(launcherCalls(L), 1);
      }, { ORBIT_LOCAL_WORKERS_REQUIRE_PREFLIGHT: v });
    }
  });
});
