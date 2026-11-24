// OBS-3 (Kyle, Nov 19 2026 9:37 PM ET "go ahead"): close /obs-snapshot.
// The legacy route was unauthenticated and injected the collector credential
// (reachable at the public origin). The standalone Observatory pane now reads
// through the trusted Orbit host, which uses the owner-authenticated extension
// proxy; the pane never holds a credential.
// AC-001 /obs-snapshot and every sub-path are 404 (GET/HEAD, with or without the owner bearer) and never reach the collector.
// AC-002 no unauthenticated request to any Observatory/collector path returns collector data.
// AC-003 the legacy handler and its credential plumbing are gone from the server; the app no longer names /obs-snapshot.
// AC-004 the host serves snapshots only to the exact reviewed Observatory entry, over the paired port, with the owner bearer.
// AC-005 the pane pairs with its host and reads only through that port.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {boot} from './fixtures/local-orbit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const COLLECTOR = 'collector-test-credential-0123456789abcdef';
const MARKER = 'collector-data-marker-7f3a';

async function collector(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({url: req.url, auth: req.headers.authorization || ''});
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({schema: 'rizzstack.observability/snapshot/1', marker: MARKER}));
  });
  // Prefer the legacy route's fixed upstream port so a surviving /obs-snapshot
  // handler would really reach this collector (RED on the old server).
  await new Promise((resolve, reject) => {
    server.once('error', error => error.code === 'EADDRINUSE' ? server.listen(0, '127.0.0.1', resolve) : reject(error));
    server.listen(8787, '127.0.0.1', resolve);
  });
  if (server.address().port !== 8787) t.diagnostic('port 8787 busy: legacy-upstream reachability not exercised');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {seen, origin: `http://127.0.0.1:${server.address().port}`};
}

test('AC-001 /obs-snapshot is gone: 404 for every sub-path and method, collector never called', async t => {
  const up = await collector(t);
  const {base, token} = await boot(t, {ORBIT_EXT_OBSERVATORY_UPSTREAM: up.origin, ORBIT_OBS_COLLECTOR_TOKEN: COLLECTOR});
  for (const p of ['/obs-snapshot', '/obs-snapshot/', '/obs-snapshot/snapshot', '/obs-snapshot/snapshot?x=1', '/obs-snapshot/healthz'])
    for (const method of ['GET', 'HEAD'])
      for (const headers of [{}, {Authorization: `Bearer ${token}`, Origin: base}]) {
        const res = await fetch(base + p, {method, headers});
        const body = await res.text();
        assert.equal(res.status, 404, `${method} ${p}`);
        assert.ok(!body.includes(MARKER));
        assert.equal(res.headers.get('access-control-allow-origin'), null);
      }
  assert.equal(up.seen.length, 0, 'the collector must not be called');
});

test('AC-002 no unauthenticated path returns collector data', async t => {
  const up = await collector(t);
  const {base, token} = await boot(t, {ORBIT_EXT_OBSERVATORY_UPSTREAM: up.origin, ORBIT_OBS_COLLECTOR_TOKEN: COLLECTOR});
  const paths = ['/obs-snapshot/snapshot', '/api/ext/rizzstack-observatory/snapshot/snapshot', '/api/ext/rizzstack-observatory/snapshot/',
    '/api/ext/rizzstack-observatory/snapshot', '/api/rizzstack/hive/reports', '/snapshot', '/api/obs-snapshot', '/', '/api/health'];
  const variants = [{}, {Origin: base}, {Referer: base + '/', 'Sec-Fetch-Site': 'same-origin'}, {Authorization: 'Bearer wrong', Origin: base},
    {Origin: 'null'}, {Origin: 'https://evil.example', Authorization: `Bearer ${token}`}];
  for (const p of paths) for (const headers of variants) {
    const res = await fetch(base + p, {headers});
    const body = await res.text();
    assert.ok(!body.includes(MARKER), `${p} ${JSON.stringify(headers)} returned collector data (${res.status})`);
    assert.ok(!body.includes(COLLECTOR));
  }
  assert.equal(up.seen.length, 0, 'no unauthenticated request reached the collector');
  // Positive control: the owner path still works and the collector gets only its own bearer.
  const ok = await fetch(base + '/api/ext/rizzstack-observatory/snapshot/snapshot', {headers: {Authorization: `Bearer ${token}`, Origin: base}});
  assert.equal(ok.status, 200);
  assert.ok((await ok.text()).includes(MARKER));
  assert.deepEqual(up.seen.map(s => s.auth), [`Bearer ${COLLECTOR}`]);
});

test('AC-003 the legacy handler is removed and the app no longer names it', () => {
  const index = fs.readFileSync(path.join(root, 'server/index.mjs'), 'utf8');
  assert.doesNotMatch(index, /serveObsSnapshot|OBS_UPSTREAM|OBS_TOKEN|pathname\s*===\s*["']\/obs-snapshot/);
  const app = fs.readFileSync(path.join(root, 'apps/rizzstack-observatory/app.js'), 'utf8');
  assert.doesNotMatch(app, /\/obs-snapshot/);
  assert.match(fs.readFileSync(path.join(root, 'src/panes.ts'), 'utf8'), /bindObservatoryHost\(frame,u,\(\)=>sessionToken\)/);
});

test('AC-004 the trusted entry is exactly the publisher output for the reviewed bundle', () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-entry-'));
  try {
    const manifest = JSON.parse(execFileSync('python3', ['scripts/plugin_publish.py', 'apps/rizzstack-observatory',
      '--id', 'rizzstack-observatory', '--version', '1.0.0', '--title', 'Rizzstack Observatory', '--runtime', runtime], {cwd: root, encoding: 'utf8'}));
    const source = fs.readFileSync(path.join(root, 'src/observatory-host.ts'), 'utf8');
    assert.equal(source.match(/OBSERVATORY_ENTRY = '([^']+)'/)?.[1], manifest.entry,
      'review the static bundle and explicitly update the trusted entry after a change');
  } finally { fs.rmSync(runtime, {recursive: true, force: true}); }
});

// Run the real host module in a browser-like sandbox; only fetch, window and the frame are fakes.
function host({responses = [], token = 'owner-token-1'} = {}) {
  const exports = {}, listeners = new Map(), calls = [];
  let now = 0, credential = token;
  const contentWindow = {};
  const frame = {isConnected: true, contentWindow, sandbox: {value: ''}, src: ''};
  const context = vm.createContext({exports, crypto: {randomUUID}, TextDecoder, AbortController, Number, JSON, Error, Promise,
    setTimeout: () => 1, clearTimeout: () => {}, performance: {now: () => now}, location: {origin: 'https://orbit.example'},
    window: {addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n)},
    fetch: async (url, init) => {
      calls.push({url, init});
      const next = responses.shift() || {status: 500};
      const text = next.body === undefined ? '' : JSON.stringify(next.body);
      return new Response(text, {status: next.status, headers: {'Content-Type': 'application/json'}});
    }});
  const source = fs.readFileSync(path.join(root, 'src/observatory-host.ts'), 'utf8');
  vm.runInContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, context);
  return {exports, listeners, calls, frame, contentWindow, advance: ms => { now += ms; }, setToken: v => { credential = v; },
    bind: url => exports.bindObservatoryHost(frame, new URL(url), () => credential)};
}
function pair(h) {
  const nonce = /#orbit-observatory-document=(.+)$/.exec(h.frame.src)[1];
  const replies = [];
  const port = {postMessage: m => replies.push(m), close() {}, onmessage: null};
  h.listeners.get('message')({source: h.contentWindow, origin: 'null', data: {type: 'orbit-observatory-ready', document: nonce}, ports: [port]});
  return {port, replies, ask: async id => { port.onmessage({data: {type: 'snapshot-request', id}}); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); }};
}

test('AC-004 only the exact reviewed entry is bound; others get nothing', () => {
  const h = host();
  const entry = h.exports.OBSERVATORY_ENTRY;
  for (const url of ['https://orbit.example/apps/rizzstack-observatory/index.html',
    'https://orbit.example/apps/rizzstack-observatory-000000000000000000000000/index.html',
    'https://evil.example' + entry]) {
    h.bind(url);
    assert.equal(h.listeners.size, 0, url);
  }
  h.bind('https://orbit.example' + entry);
  assert.equal(h.frame.sandbox.value, 'allow-scripts');
  assert.match(h.frame.src, new RegExp('^https://orbit\\.example' + entry.replace(/[.]/g, '\\.') + '#orbit-observatory-document=[0-9a-f-]{36}$'));
});

test('AC-004 the host reads through the owner proxy and answers only its paired port', async () => {
  const h = host({responses: [{status: 200, body: {schema: 'rizzstack.observability/snapshot/1', marker: MARKER}}, {status: 401}]});
  h.bind('https://orbit.example' + h.exports.OBSERVATORY_ENTRY);
  const message = h.listeners.get('message');
  const stray = {postMessage() { throw Error('stray port used'); }, close() {}};
  message({source: {}, origin: 'null', data: {type: 'orbit-observatory-ready', document: 'x'}, ports: [stray]});
  message({source: h.contentWindow, origin: 'https://orbit.example', data: {type: 'orbit-observatory-ready'}, ports: [stray]});
  const p = pair(h);
  message({source: h.contentWindow, origin: 'null', data: {type: 'orbit-observatory-ready', document: 'again'}, ports: [stray]});
  await p.ask(1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/ext/rizzstack-observatory/snapshot/snapshot');
  assert.equal(h.calls[0].init.headers.Authorization, 'Bearer owner-token-1');
  assert.equal(h.calls[0].init.credentials, 'omit');
  assert.equal(p.replies[0].ok, true);
  assert.equal(p.replies[0].snapshot.marker, MARKER);
  await p.ask(2);
  assert.equal(p.replies[1].status, 'busy', 'reads are throttled');
  h.advance(6000);
  await p.ask(3);
  assert.deepEqual({...p.replies[2]}, {type: 'snapshot', id: 3, ok: false, status: 'unauthorized'});
  h.setToken('');
  h.advance(6000);
  await p.ask(4);
  assert.equal(p.replies[3].status, 'unauthorized');
  assert.equal(h.calls.length, 2, 'no read without an owner session');
});

test('AC-004 a snapshot echoing the owner credential is refused', async () => {
  const h = host({responses: [{status: 200, body: {leak: 'owner-token-1'}}]});
  h.bind('https://orbit.example' + h.exports.OBSERVATORY_ENTRY);
  const p = pair(h);
  await p.ask(1);
  assert.equal(p.replies[0].ok, false);
  assert.equal(p.replies[0].snapshot, undefined);
});

test('AC-005 the pane pairs with its host and loads only through the port', async () => {
  const context = vm.createContext({MessageChannel, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Array, Object, Error, Promise, Map, Set, RegExp, URL, encodeURIComponent, decodeURIComponent});
  context.window = context; context.global = context;
  vm.runInContext(fs.readFileSync(path.join(root, 'apps/rizzstack-observatory/app.js'), 'utf8'), context);
  const api = context.RizzstackObservatory;
  const id = randomUUID();
  assert.equal(api.hostPairing('#orbit-observatory-document=' + id), id);
  for (const bad of ['', '#orbit-config=%7B%7D', '#orbit-observatory-document=nope', '#orbit-observatory-document=' + id + 'x']) assert.equal(api.hostPairing(bad), null);
  let ready;
  const parentWindow = {postMessage: (data, origin, ports) => { ready = {data, origin, port: ports[0]}; }};
  const source = api.createHostSource({pairing: id, parentWindow, targetOrigin: 'https://orbit.example'});
  assert.equal(ready.data.type, 'orbit-observatory-ready');
  assert.equal(ready.data.document, id);
  assert.equal(ready.origin, 'https://orbit.example');
  ready.port.onmessage = ({data}) => {
    if (data.type !== 'snapshot-request') return;
    ready.port.postMessage(data.id === 1 ? {type: 'snapshot', id: 1, ok: true, snapshot: {schema: 'rizzstack.observability/snapshot/1', fleet: []}}
      : {type: 'snapshot', id: data.id, ok: false, status: 'unauthorized'});
  };
  const loaded = await api.loadSnapshot({hostSource: source, url: null});
  assert.equal(loaded.snapshot.schemaOk, true);
  await assert.rejects(api.loadSnapshot({hostSource: source}), /unauthorized/);
  ready.port.close();
});
