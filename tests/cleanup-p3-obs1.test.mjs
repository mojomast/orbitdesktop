// Phase 3 Observatory move, step 1 (Kyle, 2:35 PM ET: "Observatory: go ahead with your best design").
// A generic, manifest-driven, owner-authenticated extension proxy: /api/ext/<extension>/<proxy>/<path>.
// The rizzstack-observatory extension declares one read-only proxy to its loopback snapshot collector.
// /obs-snapshot was kept until the replacement was verified live; OBS-3 removed it.
// AC-001: the proxy module and the observatory extension manifest exist and are well-formed.
// AC-002: requests without the owner token, with a wrong token or from another origin are refused before any upstream call.
// AC-003: an owner request reaches the upstream with only the server-side collector credential; the owner token, cookies and CORS never cross.
// AC-004: everything not declared is refused (fail-closed): unknown extension/proxy/path, methods, traversal, redirects, missing credential, non-loopback upstream.
// AC-005: superseded by OBS-3 (tests/cleanup-obs3-retire-legacy.test.mjs): /obs-snapshot is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boot} from './fixtures/local-orbit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = path.join(root, 'extensions/rizzstack-observatory/orbit-extension.json');
const COLLECTOR = 'collector-test-credential-0123456789abcdef';

async function stub(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({url: req.url, method: req.method, headers: req.headers}); handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {seen, origin: `http://127.0.0.1:${server.address().port}`};
}
const okHandler = (req, res) => {
  if (req.url === '/') { res.writeHead(302, {Location: 'http://127.0.0.1:1/elsewhere'}); return res.end(); }
  res.writeHead(200, {'Content-Type': 'application/json', 'Set-Cookie': 'upstream=1', 'Access-Control-Allow-Origin': '*'}); res.end(JSON.stringify({ok: true, path: req.url}));
};
const route = '/api/ext/rizzstack-observatory/snapshot';

test('AC-001 proxy module and observatory manifest exist', () => {
  assert.ok(fs.existsSync(path.join(root, 'server/extension-proxy.mjs')));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.id, 'rizzstack-observatory');
  const proxy = manifest.proxies?.snapshot;
  assert.ok(proxy, 'manifest declares the snapshot proxy');
  assert.deepEqual([...proxy.methods].sort(), ['GET', 'HEAD']);
  assert.equal(proxy.token_env, 'ORBIT_OBS_COLLECTOR_TOKEN');
  assert.deepEqual([...proxy.paths].sort(), ['/', '/snapshot']);
});

test('AC-002 unauthenticated, wrong-token and cross-origin requests never reach the upstream', async t => {
  const up = await stub(t, okHandler);
  const {base} = await boot(t, {ORBIT_EXT_OBSERVATORY_UPSTREAM: up.origin, ORBIT_OBS_COLLECTOR_TOKEN: COLLECTOR});
  for (const headers of [{}, {Authorization: 'Bearer wrong'}, {Authorization: 'Bearer wrong', Origin: base}]) {
    const res = await fetch(base + route + '/snapshot', {headers}); await res.arrayBuffer();
    assert.equal(res.status, 403, JSON.stringify(Object.keys(headers)));
  }
  assert.equal(up.seen.length, 0, 'upstream must not be called');
});

test('AC-003 owner requests reach the upstream with only the collector credential', async t => {
  const up = await stub(t, okHandler);
  const {base, token} = await boot(t, {ORBIT_EXT_OBSERVATORY_UPSTREAM: up.origin, ORBIT_OBS_COLLECTOR_TOKEN: COLLECTOR});
  const crossOrigin = await fetch(base + route + '/snapshot', {headers: {Authorization: `Bearer ${token}`, Origin: 'http://evil.example'}}); await crossOrigin.arrayBuffer();
  assert.equal(crossOrigin.status, 403, 'a foreign Origin is refused even with the token');
  assert.equal(up.seen.length, 0);
  const res = await fetch(base + route + '/snapshot', {headers: {Authorization: `Bearer ${token}`, Origin: base, Cookie: 'orbit=secret'}});
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, {ok: true, path: '/snapshot'});
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS grant');
  assert.equal(res.headers.get('set-cookie'), null, 'upstream cookies are not passed through');
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  assert.equal(up.seen.length, 1);
  const sent = up.seen[0].headers;
  assert.equal(sent.authorization, `Bearer ${COLLECTOR}`);
  assert.ok(!JSON.stringify(sent).includes(token), 'the Orbit owner token must never reach the upstream');
  assert.equal(sent.cookie, undefined);
});

test('AC-004 undeclared requests are refused (fail-closed)', async t => {
  const up = await stub(t, okHandler);
  const {base, token} = await boot(t, {ORBIT_EXT_OBSERVATORY_UPSTREAM: up.origin, ORBIT_OBS_COLLECTOR_TOKEN: COLLECTOR});
  const owner = {Authorization: `Bearer ${token}`, Origin: base};
  const get = async (p, method = 'GET') => { const r = await fetch(base + p, {method, headers: owner}); await r.arrayBuffer(); return r.status; };
  assert.equal(await get(route + '/not-declared'), 404);
  assert.equal(await get('/api/ext/no-such-extension/snapshot/snapshot'), 404);
  assert.equal(await get('/api/ext/rizzstack-observatory/no-such-proxy/snapshot'), 404);
  assert.equal(await get(route + '/%2e%2e/snapshot'), 404);
  assert.equal(await get(route + '/..%2fsnapshot'), 404);
  assert.equal(await get(route + '/snapshot', 'POST'), 405);
  assert.equal(await get(route + '/redirect'), 404, 'undeclared path is refused before the upstream');
  assert.equal(up.seen.length, 0);
  assert.equal(await get(route + '/'), 502, 'upstream redirects are not followed');
  assert.equal(up.seen.length, 1);
  const noCred = await boot(t, {ORBIT_EXT_OBSERVATORY_UPSTREAM: up.origin});
  const r1 = await fetch(noCred.base + route + '/snapshot', {headers: {Authorization: `Bearer ${noCred.token}`, Origin: noCred.base}}); await r1.arrayBuffer();
  assert.equal(r1.status, 503, 'missing collector credential is unavailable, not anonymous');
  up.seen.length = 0;
  const remote = await boot(t, {ORBIT_EXT_OBSERVATORY_UPSTREAM: 'http://example.com:8787', ORBIT_OBS_COLLECTOR_TOKEN: COLLECTOR});
  const r2 = await fetch(remote.base + route + '/snapshot', {headers: {Authorization: `Bearer ${remote.token}`, Origin: remote.base}}); await r2.arrayBuffer();
  assert.equal(r2.status, 503, 'a non-loopback upstream is refused');
  assert.equal(up.seen.length, 0);
});

test('AC-005 /obs-snapshot was removed once the replacement was verified (OBS-3)', () => {
  const index = fs.readFileSync(path.join(root, 'server/index.mjs'), 'utf8');
  assert.doesNotMatch(index, /serveObsSnapshot/);
  assert.doesNotMatch(index, /pathname\s*===\s*["']\/obs-snapshot/);
});
