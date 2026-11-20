// Snapshot cache for extension proxies (opt-in per proxy: cache_ttl_ms + cache_stale_ms).
// A slow upstream (the observability collector computes each snapshot in ~10 s) must not make
// every owner read wait for a full recompute: fresh entries are served from memory, entries past
// the TTL are served stale while ONE background refresh runs, and nothing is cached that should
// not be (errors, queries, HEAD, unauthenticated requests). Auth is checked before the cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensionManifests, createExtensionProxy } from '../server/extension-proxy.mjs';

const PORT = 4318;
const TOKEN = 'owner-extension-test-token';
const COLLECTOR = 'collector-credential-cache-test';
const URL_ = '/api/ext/demo/snapshot/snapshot';

const proxy = over => ({
  upstream_env: 'ORBIT_EXT_TEST_UPSTREAM', default_upstream: 'http://127.0.0.1:8787', token_env: 'ORBIT_EXT_TEST_TOKEN',
  methods: ['GET', 'HEAD'], paths: ['/', '/snapshot'], allow_query: true, max_response_bytes: 4096, timeout_ms: 1000,
  cache_ttl_ms: 1000, cache_stale_ms: 5000, ...over,
});
const manifest = over => ({ id: 'demo', title: 'Demo Extension', version: 1, proxies: { snapshot: proxy() }, ...over });

function req({ method = 'GET', url = URL_, token = TOKEN, origin = true } = {}) {
  return { method, url, headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}`, ...(origin ? { origin: `http://127.0.0.1:${PORT}` } : {}) } };
}
function res() {
  return { status: 0, headers: {}, body: '', writeHead(s, h = {}) { this.status = s; this.headers = h; return this; }, end(d) { this.body = d === undefined ? '' : String(d); return this; } };
}
const tick = () => new Promise(r => setImmediate(r));

// Fake upstream: each call resolves when the test says so (or immediately), and counts calls.
function upstream(t) {
  const u = { calls: 0, pending: [], status: 200, auto: true, seenAuth: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    u.calls++; u.seenAuth.push(init.headers.authorization);
    const n = u.calls; const status = u.status;
    const make = () => new Response(JSON.stringify({ n }), { status, headers: { 'content-type': 'application/json' } });
    if (u.auto) return make();
    return new Promise((resolve, reject) => u.pending.push({ resolve: () => resolve(make()), reject }));
  };
  t.after(() => { globalThis.fetch = original; });
  return u;
}
function handler(over = {}, clock) {
  return createExtensionProxy({ manifests: [manifest({ proxies: { snapshot: proxy(over) } })], token: TOKEN, port: PORT,
    env: { ORBIT_EXT_TEST_TOKEN: COLLECTOR }, now: clock ? () => clock.t : undefined });
}
async function get(h, r = req()) { const out = res(); await h(r, out); return out; }

test('manifest accepts cache_ttl_ms/cache_stale_ms and rejects invalid values', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ext-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const load = value => {
    fs.rmSync(path.join(root, 'demo'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'demo'));
    fs.writeFileSync(path.join(root, 'demo/orbit-extension.json'), JSON.stringify(value));
    const warn = console.warn; console.warn = () => {};
    try { return loadExtensionManifests(root); } finally { console.warn = warn; }
  };
  assert.equal(load(manifest()).length, 1, 'valid cache settings load');
  assert.equal(load(manifest({ proxies: { snapshot: proxy({ cache_ttl_ms: undefined, cache_stale_ms: undefined }) } })).length, 1, 'cache is optional');
  for (const bad of [{ cache_ttl_ms: 0 }, { cache_ttl_ms: -1 }, { cache_ttl_ms: 1.5 }, { cache_ttl_ms: 600001 }, { cache_ttl_ms: '1000' },
    { cache_stale_ms: -1 }, { cache_stale_ms: 3600001 }, { cache_ttl_ms: undefined, cache_stale_ms: 1000 }]) {
    assert.deepEqual(load(manifest({ proxies: { snapshot: proxy(bad) } })), [], JSON.stringify(bad));
  }
});

test('fresh entries are served from memory without another upstream read', async t => {
  const u = upstream(t); const clock = { t: 1000 }; const h = handler({}, clock);
  const a = await get(h); assert.equal(a.status, 200); assert.equal(a.headers['X-Orbit-Cache'], 'miss');
  clock.t += 500;
  const b = await get(h); assert.equal(b.status, 200); assert.equal(b.body, a.body); assert.equal(b.headers['X-Orbit-Cache'], 'hit');
  assert.equal(b.headers['Cache-Control'], 'no-store'); assert.equal(b.headers['Content-Type'], 'application/json');
  assert.equal(u.calls, 1);
});

test('past the TTL the stale entry is served immediately while ONE background refresh runs', async t => {
  const u = upstream(t); const clock = { t: 1000 }; const h = handler({}, clock);
  await get(h); assert.equal(u.calls, 1);
  u.auto = false; clock.t += 1500;
  const s1 = await get(h); assert.equal(s1.headers['X-Orbit-Cache'], 'stale'); assert.equal(JSON.parse(s1.body).n, 1);
  const s2 = await get(h); assert.equal(s2.headers['X-Orbit-Cache'], 'stale');
  assert.equal(u.calls, 2, 'one refresh in flight, not one per reader');
  u.pending.shift().resolve(); await tick(); await tick();
  const f = await get(h); assert.equal(f.headers['X-Orbit-Cache'], 'hit'); assert.equal(JSON.parse(f.body).n, 2);
});

test('past TTL + stale window the entry is not served; the read waits for the upstream (fail-closed)', async t => {
  const u = upstream(t); const clock = { t: 1000 }; const h = handler({}, clock);
  await get(h); clock.t += 1000 + 5000 + 1;
  u.status = 503;
  const r = await get(h); assert.equal(r.status, 503); assert.equal(r.headers['X-Orbit-Cache'], 'miss');
  assert.equal(u.calls, 2);
});

test('concurrent cold reads share one upstream request', async t => {
  const u = upstream(t); u.auto = false; const h = handler({}, { t: 1 });
  const a = get(h); const b = get(h); await tick(); await tick();
  assert.equal(u.calls, 1);
  u.pending.shift().resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200); assert.equal(rb.status, 200); assert.equal(ra.body, rb.body);
});

test('a cold read that is abandoned still fills the cache for the next reader', async t => {
  const u = upstream(t); u.auto = false; const clock = { t: 1 }; const h = handler({}, clock);
  const first = get(h); await tick();
  u.pending.shift().resolve(); await first;
  const second = await get(h); assert.equal(second.headers['X-Orbit-Cache'], 'hit'); assert.equal(u.calls, 1);
});

test('errors, failed refreshes, queries and HEAD are never cached; a failed refresh keeps the last good entry', async t => {
  const u = upstream(t); const clock = { t: 1000 }; const h = handler({}, clock);
  u.status = 500; await get(h); await get(h); assert.equal(u.calls, 2, 'a 500 is not cached');
  u.status = 200; await get(h); assert.equal(u.calls, 3);
  await get(h, req({ url: URL_ + '?x=1' })); await get(h, req({ url: URL_ + '?x=1' })); assert.equal(u.calls, 5, 'queries bypass the cache');
  await get(h, req({ method: 'HEAD' })); assert.equal(u.calls, 6, 'HEAD bypasses the cache');
  clock.t += 1500; u.status = 502;
  const s = await get(h); assert.equal(s.headers['X-Orbit-Cache'], 'stale'); await tick(); await tick();
  assert.equal(u.calls, 7);
  const s2 = await get(h); assert.equal(s2.status, 200, 'last good entry still served inside the window');
});

test('auth and origin are checked before the cache: a cached entry is never served to a bad request', async t => {
  const u = upstream(t); const h = handler({}, { t: 1 });
  await get(h); assert.equal(u.calls, 1);
  assert.equal((await get(h, req({ token: 'wrong' }))).status, 403);
  assert.equal((await get(h, req({ origin: false, token: '' }))).status, 403);
  const foreign = req(); foreign.headers.origin = 'http://evil.example';
  assert.equal((await get(h, foreign)).status, 403);
  assert.equal(u.calls, 1);
});

test('the cached entry holds no credential and the upstream still gets only the collector credential', async t => {
  const u = upstream(t); const h = handler({}, { t: 1 });
  const a = await get(h); const b = await get(h);
  for (const r of [a, b]) { assert.ok(!JSON.stringify(r).includes(COLLECTOR)); assert.ok(!JSON.stringify(r).includes(TOKEN)); }
  assert.deepEqual(u.seenAuth, [`Bearer ${COLLECTOR}`]);
});

test('a proxy without cache settings behaves exactly as before (every read goes upstream)', async t => {
  const u = upstream(t); const h = handler({ cache_ttl_ms: undefined, cache_stale_ms: undefined }, { t: 1 });
  const a = await get(h); await get(h); assert.equal(u.calls, 2); assert.equal(a.headers['X-Orbit-Cache'], undefined);
});

test('the Observatory manifest opts its snapshot proxy into a short TTL with a bounded stale window', () => {
  const file = fileURLToPath(new URL('../extensions/rizzstack-observatory/orbit-extension.json', import.meta.url));
  const p = JSON.parse(fs.readFileSync(file, 'utf8')).proxies.snapshot;
  assert.ok(Number.isSafeInteger(p.cache_ttl_ms) && p.cache_ttl_ms > 0 && p.cache_ttl_ms <= 30000, 'short TTL');
  assert.ok(Number.isSafeInteger(p.cache_stale_ms) && p.cache_stale_ms >= 30000 && p.cache_stale_ms <= 300000, 'bounded stale window that covers the Hive 30 s period');
});
