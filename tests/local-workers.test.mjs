import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createLocalWorkers, BOARD_COLUMN } from '../server/local-workers.mjs';

const TOKEN = 'a'.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeBoard = () => { const calls = []; return { calls, update: async (b) => { calls.push(b); } }; };
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(100); } throw new Error('timeout'); }

async function startLauncher(max = 1, dataDir = mkdtempSync(path.join(os.tmpdir(), 'lw-pc-')), extra = {}) {
  const port = extra.port || 20000 + Math.floor(Math.random() * 20000);
  writeFileSync(path.join(dataDir, 'orbit-api.token'), TOKEN);
  writeFileSync(path.join(dataDir, 'go.key'), 'fake-provider-key');
  const cfg = path.join(dataDir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ bind: '127.0.0.1', port, max_concurrent: max, data_dir: dataDir, backoff_s: [0.3], projects: { demo: {} }, ...extra }));
  const p = spawn('python3', ['pc-launcher/launcher.py', 'serve', '--config', cfg, '--backend', 'fake'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => p.stdout.once('data', res));
  return { url: `http://127.0.0.1:${port}`, dataDir, proc: p, stop: () => p.kill() };
}
function adapter(url, extra = {}) {
  const runtimeDir = extra.runtimeDir || mkdtempSync(path.join(os.tmpdir(), 'lw-orbit-'));
  const board = extra.board || fakeBoard();
  return { lw: createLocalWorkers({ runtimeDir, launcherUrl: url, launcherToken: TOKEN, board, maxConcurrent: extra.max || 1, timeoutMs: extra.timeoutMs || 3000 }), board, runtimeDir };
}
const done = (lw, id) => until(async () => { await lw.tick(); return ['succeeded', 'failed', 'cancelled', 'not_started'].includes(lw.get(id).state); });
const brief = (o = {}) => ({ objective: 'write out.txt', deliverables: ['out.txt'], acceptance: ['file exists'], ...o });

test('single attempt: dispatch, run, result manifest, board columns', async () => {
  const L = await startLauncher(1);
  try {
    const { lw, board } = adapter(L.url);
    const a = await lw.create({ taskId: 't1', group: 'g', brief: brief() });
    await done(lw, a.attempt_id);
    const r = lw.get(a.attempt_id);
    assert.equal(r.state, 'succeeded'); assert.ok(r.cua_run_id); assert.ok(r.result.ref); assert.equal(r.artifact_refs[0].path, 'out.txt');
    const m = JSON.parse(readFileSync(r.result.ref, 'utf8'));
    assert.equal(m.schema, 'orbit.local-worker.result/v1'); assert.ok(m.observed.files[0].sha256); assert.ok('worker_claims' in m);
    assert.equal(board.calls.at(-1).status, 'review');
    assert.equal(board.calls.at(-1).by, 'local-workers'); assert.match(board.calls.at(-1).note, /^MR\.INDIA: /);
    assert.ok(!JSON.stringify(r).includes('fake-provider-key') && !readFileSync(r.log_ref, 'utf8').includes('fake-provider-key'));
    await lw.review(a.attempt_id, { accepted: true }); assert.equal(board.calls.at(-1).status, 'done');
    // launcher restart with a result file on disk must still load cleanly (regression: result.json loaded as an attempt)
    L.stop(); await sleep(300);
    const L2 = await startLauncher(1, L.dataDir, { port: Number(new URL(L.url).port) });
    try {
      const h = await (await fetch(L2.url + '/v1/health', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
      assert.equal(h.ok, true); assert.equal(h.active, 0);
    } finally { L2.stop(); }
  } finally { L.stop(); }
});

test('two concurrent attempts run at once with cap 2', async () => {
  const L = await startLauncher(2);
  try {
    const { lw } = adapter(L.url, { max: 2 });
    const f = { fake: { delay: 1.5 } };
    const a = await lw.create({ taskId: 'a', group: 'g', brief: brief(f) });
    const b = await lw.create({ taskId: 'b', group: 'g', brief: brief(f) });
    await until(async () => { await lw.tick(); return ['running'].includes(lw.get(a.attempt_id).state) && lw.get(b.attempt_id).state === 'running'; });
    await done(lw, a.attempt_id); await done(lw, b.attempt_id);
    assert.equal(lw.get(b.attempt_id).state, 'succeeded');
  } finally { L.stop(); }
});

test('cap 3 is the ceiling: 4th waits, config above 3 clamps', async () => {
  const L = await startLauncher(5);
  try {
    const h = await (await fetch(L.url + '/v1/health', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
    assert.equal(h.max_concurrent, 3);
    const { lw } = adapter(L.url, { max: 9 }); assert.equal(lw.cap, 3);
    const ids = [];
    for (const t of ['1', '2', '3', '4']) ids.push((await lw.create({ taskId: t, group: 'g', brief: brief({ fake: { delay: 1.5 } }) })).attempt_id);
    assert.equal(lw.get(ids[3]).state, 'queued');
    for (const id of ids) await done(lw, id);
    assert.ok(ids.every((id) => lw.get(id).state === 'succeeded'));
  } finally { L.stop(); }
});

test('reload/reattach: adapter restart and launcher restart do not re-dispatch', async () => {
  let L = await startLauncher(1);
  const dataDir = L.dataDir;
  const { lw, runtimeDir } = adapter(L.url);
  const a = await lw.create({ taskId: 'r', group: 'g', brief: brief({ fake: { delay: 2 } }) });
  await until(async () => { await lw.tick(); return lw.get(a.attempt_id).state === 'running'; });
  L.stop(); await sleep(300);
  const port = new URL(L.url).port;
  L = await startLauncher(1, dataDir, { port: Number(port) });
  try {
    const { lw: lw2 } = adapter(L.url, { runtimeDir }); // fresh adapter from persisted ledger
    await lw2.reconcile();
    const st = await (await fetch(`${L.url}/v1/attempts/${a.attempt_id}`, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
    assert.equal(st.run_id, lw.get(a.attempt_id).cua_run_id); // same run id, not a new dispatch
    await done(lw2, a.attempt_id);
    assert.ok(['succeeded', 'failed'].includes(lw2.get(a.attempt_id).state));
  } finally { L.stop(); }
});

test('cancel stays cancel_requested until the launcher confirms', async () => {
  const L = await startLauncher(1);
  try {
    const { lw, board } = adapter(L.url);
    const a = await lw.create({ taskId: 'c', group: 'g', brief: brief({ fake: { delay: 30 } }) });
    await until(async () => { await lw.tick(); return lw.get(a.attempt_id).state === 'running'; });
    await lw.cancel(a.attempt_id);
    assert.ok(lw.get(a.attempt_id).history.some((h) => h.state === 'cancel_requested'));
    await until(async () => { await lw.tick(); return lw.get(a.attempt_id).state === 'cancelled'; });
    assert.equal(board.calls.at(-1).status, BOARD_COLUMN.cancelled);
  } finally { L.stop(); }
});

test('failure: start error and 429 backoff are visible and terminal', async () => {
  const L = await startLauncher(1);
  try {
    const { lw } = adapter(L.url);
    const a = await lw.create({ taskId: 'f', group: 'g', brief: brief({ fake: { fail_start: true } }) });
    await done(lw, a.attempt_id); assert.equal(lw.get(a.attempt_id).state, 'failed');
    const b = await lw.create({ taskId: 'rl', group: 'g', brief: brief({ fake: { rate_limit_first: 1 } }) });
    await done(lw, b.attempt_id);
    assert.equal(lw.get(b.attempt_id).state, 'succeeded');
    const ev = readFileSync(path.join(L.dataDir, 'attempts', `${b.attempt_id}.events.jsonl`), 'utf8');
    assert.match(ev, /"state": "backoff"/);
    const bad = await lw.create({ taskId: 'p', group: 'g', brief: brief({ project: 'not-authorized' }) });
    assert.equal(lw.get(bad.attempt_id).state, 'not_started');
  } finally { L.stop(); }
});

// ---- fake launcher for transport edge cases
function fakeLauncher() {
  const s = { attempts: {}, posts: 0, dropNextPostResponse: false, down: false };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      if (s.down) return req.socket.destroy();
      const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const m = req.url.match(/^\/v1\/attempts\/?([^/?]*)\/?([a-z]*)/);
      if (req.method === 'POST' && req.url === '/v1/attempts') {
        const b = JSON.parse(body); s.posts++;
        s.attempts[b.attempt_id] ??= { attempt_id: b.attempt_id, state: 'running', run_id: 'run-x', detail: 'running' };
        if (s.dropNextPostResponse) { s.dropNextPostResponse = false; return req.socket.destroy(); }
        return send(201, s.attempts[b.attempt_id]);
      }
      const a = m && s.attempts[m[1]]; if (!a) return send(404, { error: 'unknown' });
      if (m[2] === 'events') return send(200, { events: [], cursor: 0, state: a.state });
      if (m[2] === 'result') return send(409, {});
      if (m[2] === 'cancel') { a.state = 'cancel_requested'; return send(202, a); }
      return send(200, a);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ s, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

test('connection interruption: disconnected != failed, no duplicate dispatch on reconnect', async () => {
  const F = await fakeLauncher();
  try {
    const { lw } = adapter(F.url, { timeoutMs: 500 });
    const a = await lw.create({ taskId: 'n', group: 'g', brief: brief() });
    assert.equal(lw.get(a.attempt_id).state, 'running');
    F.s.down = true; await lw.tick();
    assert.equal(lw.get(a.attempt_id).state, 'disconnected');
    F.s.down = false; await lw.tick();
    assert.equal(lw.get(a.attempt_id).state, 'running'); assert.equal(F.s.posts, 1);
    F.s.attempts[a.attempt_id].state = 'succeeded'; await lw.tick();
    assert.equal(lw.get(a.attempt_id).state, 'succeeded');
  } finally { F.close(); }
});

test('uncertain outcome: lost POST response becomes outcome_unknown, then reconciles without re-sending', async () => {
  const F = await fakeLauncher();
  try {
    const { lw } = adapter(F.url, { timeoutMs: 500, max: 3 });
    F.s.dropNextPostResponse = true;
    const a = await lw.create({ taskId: 'u', group: 'g', brief: brief() });
    assert.equal(lw.get(a.attempt_id).state, 'outcome_unknown');
    await lw.reconcile();
    assert.equal(lw.get(a.attempt_id).state, 'running'); assert.equal(F.s.posts, 1);
    // and a never-received attempt reconciles to not_started
    F.s.down = true; const b = await lw.create({ taskId: 'u2', group: 'g', brief: brief() }); F.s.down = false;
    assert.equal(lw.get(b.attempt_id).state, 'outcome_unknown');
    await lw.reconcile(); assert.equal(lw.get(b.attempt_id).state, 'not_started');
  } finally { F.close(); }
});

test('superseded attempt cannot overwrite the newer one', async () => {
  const F = await fakeLauncher();
  try {
    const { lw, board } = adapter(F.url, { max: 3 });
    const a = await lw.create({ taskId: 's', group: 'g', brief: brief() });
    const b = await lw.create({ taskId: 's', group: 'g', brief: brief({ objective: 'v2' }) });
    assert.equal(lw.get(a.attempt_id).state, 'superseded');
    F.s.attempts[a.attempt_id].state = 'failed'; await lw.poll(a.attempt_id);
    assert.equal(lw.get(a.attempt_id).state, 'superseded');
    assert.ok(board.calls.every((c) => !c.note.includes(a.attempt_id) || c.status !== 'blocked'));
    assert.equal(lw.get(b.attempt_id).generation, 2);
  } finally { F.close(); }
});

test('real cua==0.5.0 SDK contract (no network, no Docker)', { skip: !process.env.PATH.split(':').some((d) => existsSync(path.join(d, 'uv'))) && 'uv not installed' }, async () => {
  const r = spawnSync('uv', ['run', '-q', '--python', '3.12', '--with', 'cua==0.5.0', 'python', 'pc-launcher/tests/test_sdk_contract.py'], { encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
});
