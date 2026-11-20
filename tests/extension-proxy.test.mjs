// Unit tests for the generic, manifest-driven extension proxy.
// AC-001 (manifest module) and the fail-closed path checks from AC-004.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExtensionManifests, createExtensionProxy } from '../server/extension-proxy.mjs';

const proxy = over => ({
  upstream_env: 'ORBIT_EXT_TEST_UPSTREAM',
  default_upstream: 'http://127.0.0.1:8787',
  token_env: 'ORBIT_EXT_TEST_TOKEN',
  methods: ['GET', 'HEAD'],
  paths: ['/', '/snapshot'],
  allow_query: true,
  max_response_bytes: 1024,
  timeout_ms: 1000,
  ...over,
});
const manifest = over => ({
  id: 'demo',
  title: 'Demo Extension',
  version: 1,
  proxies: { snapshot: proxy() },
  ...over,
});

function writeTree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-extension-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, value] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }
  return root;
}

function loadQuiet(root) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { manifests: loadExtensionManifests(root), warnings };
  } finally {
    console.warn = original;
  }
}

function loadOne(t, value, directory = value.id) {
  const root = writeTree(t, { [`${directory}/orbit-extension.json`]: value });
  return loadQuiet(root);
}

test('loadExtensionManifests accepts a valid manifest and preserves its proxies', t => {
  const { manifests, warnings } = loadOne(t, manifest());
  assert.equal(warnings.length, 0);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].id, 'demo');
  assert.deepEqual(manifests[0].proxies.snapshot.methods, ['GET', 'HEAD']);
  assert.deepEqual(manifests[0].proxies.snapshot.paths, ['/', '/snapshot']);
});

test('loadExtensionManifests rejects bad ids, unknown keys, non-GET methods and id/dir mismatch', async t => {
  const cases = [
    ['bad id', manifest({ id: 'Bad_Id' }), 'Bad_Id', /Bad_Id/],
    ['unknown root key', { ...manifest(), extra: true }, 'demo', /demo/],
    ['unknown proxy key', manifest({ proxies: { snapshot: proxy({ extra: true }) } }), 'demo', /demo/],
    ['non-GET method', manifest({ proxies: { snapshot: proxy({ methods: ['POST'] }) } }), 'demo', /demo/],
    ['id/dir mismatch', manifest({ id: 'other' }), 'demo', /demo/],
    ['path without slash', manifest({ proxies: { snapshot: proxy({ paths: ['snapshot'] }) } }), 'demo', /demo/],
  ];
  for (const [name, value, directory, fileName] of cases) {
    const { manifests, warnings } = loadOne(t, value, directory);
    assert.deepEqual(manifests, [], name);
    assert.equal(warnings.length, 1, `${name} warns once`);
    assert.match(warnings[0], fileName, `${name} names the file`);
  }
});

test('loadExtensionManifests warning never echoes manifest values', t => {
  const secret = 'collector-super-secret-value';
  const root = writeTree(t, {
    'demo/orbit-extension.json': { ...manifest(), extra: secret },
  });
  const { manifests, warnings } = loadQuiet(root);
  assert.deepEqual(manifests, []);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(secret));
});

function ownerRequest({ method = 'GET', url, port, token, origin = true }) {
  return {
    method,
    url,
    headers: {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${token}`,
      ...(origin ? { origin: `http://127.0.0.1:${port}` } : {}),
    },
  };
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(data) {
      this.body = data === undefined ? '' : String(data);
      return this;
    },
  };
}

test('path checks refuse undeclared, traversal and malformed requests before any upstream call', async t => {
  const port = 4318;
  const token = 'owner-extension-test-token';
  const handler = createExtensionProxy({
    manifests: [manifest()],
    token,
    port,
    env: { ORBIT_EXT_TEST_TOKEN: 'collector-credential' },
  });

  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    throw Error('upstream must not be called');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const status = async (url, method = 'GET') => {
    const res = fakeResponse();
    await handler(ownerRequest({ method, url, port, token }), res);
    return res.status;
  };

  assert.equal(await status('/api/ext/missing/snapshot/snapshot'), 404, 'unknown extension');
  assert.equal(await status('/api/ext/demo/missing/snapshot'), 404, 'unknown proxy');
  assert.equal(await status('/api/ext/demo/snapshot/not-declared'), 404, 'undeclared path');
  assert.equal(await status('/api/ext/demo/snapshot/%2e%2e/snapshot'), 404, 'percent traversal');
  assert.equal(await status('/api/ext/demo/snapshot/..%2fsnapshot'), 404, 'encoded separator');
  assert.equal(await status('/api/ext/demo/snapshot//snapshot'), 404, 'double slash');
  assert.equal(await status('/api/ext/demo/snapshot/snapshot\\extra'), 404, 'backslash');
  assert.equal(await status('/api/ext/demo/snapshot/snapshot\u0000'), 404, 'control character');
  assert.equal(await status('/api/ext/demo/snapshot/snapshot', 'POST'), 405, 'method not declared');
  assert.equal(await status(`/api/ext/demo/snapshot/snapshot?${'a'.repeat(2049)}`), 404, 'query too long');
  assert.equal(upstreamCalls, 0, 'no malformed request reaches the upstream');
});

test('a proxy without allow_query refuses a query string', async t => {
  const port = 4318;
  const token = 'owner-extension-test-token';
  const handler = createExtensionProxy({
    manifests: [manifest({ proxies: { snapshot: proxy({ allow_query: false }) } })],
    token,
    port,
    env: { ORBIT_EXT_TEST_TOKEN: 'collector-credential' },
  });
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; throw Error('upstream must not be called'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const res = fakeResponse();
  await handler(ownerRequest({ url: '/api/ext/demo/snapshot/snapshot?x=1', port, token }), res);
  assert.equal(res.status, 404);
  assert.equal(upstreamCalls, 0);
});
