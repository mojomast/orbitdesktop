import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DATA_ENGINE_FILES, createDataEngineAssets } from '../server/data-engine-assets.mjs';
import { provisionDataEngine } from '../scripts/provision_data_engine.mjs';
const fixtureRoot = process.env.ORBIT_DUCKDB_EXTENSIONS_ROOT || '/tmp/opencode/orbit-duckdb-extensions';
const fixture = kind => path.join(fixtureRoot, 'v1.4.3', 'wasm_eh', DATA_ENGINE_FILES[kind].file);
const withRoot = async run => { const root = fs.mkdtempSync('/tmp/opencode/orbit-data-assets-'); try { await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } };

test('provisioning rejects wrong/oversized bytes and symlinks; URLs are fixed', async () => withRoot(async root => {
  await assert.rejects(provisionDataEngine({ extensionsRoot: root, fetchFile: async url => {
    assert.equal(url, 'https://extensions.duckdb.org/v1.4.3/wasm_eh/json.duckdb_extension.wasm');
    return new Response('wrong bytes');
  } }), /checksum mismatch/);
  await assert.rejects(provisionDataEngine({ extensionsRoot: root, fetchFile: async () => new Response(new Uint8Array(DATA_ENGINE_FILES.json.bytes + 1)) }), /too large/);
  const destination = path.join(root, 'v1.4.3/wasm_eh/json.duckdb_extension.wasm');
  fs.writeFileSync(destination, 'changed');
  await assert.rejects(provisionDataEngine({ extensionsRoot: root, fetchFile: () => { throw Error('must not fetch'); } }), /refusing replacement/);
  fs.unlinkSync(destination); fs.symlinkSync(path.join(root, 'absent'), destination);
  await assert.rejects(provisionDataEngine({ extensionsRoot: root }), /symlink/);
  fs.unlinkSync(destination);
  fs.symlinkSync(root, path.join(root, 'linked'));
  await assert.rejects(provisionDataEngine({ extensionsRoot: path.join(root, 'linked') }), /symlink/);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), []);
}));

test('real pinned assets provision atomically, reverify offline, and serve verified HTTP bytes', { skip: !Object.keys(DATA_ENGINE_FILES).every(k => fs.existsSync(fixture(k))) && 'Provision pinned fixtures or set ORBIT_DUCKDB_EXTENSIONS_ROOT' }, async () => withRoot(async root => {
  const urls = [];
  const report = await provisionDataEngine({ extensionsRoot: root, fetchFile: async url => {
    urls.push(url); const kind = url.includes('/json.') ? 'json' : 'parquet';
    return new Response(fs.readFileSync(fixture(kind)));
  } });
  assert.equal(urls.length, 2);
  assert.ok(report.files.every(f => !f.existing));
  const offline = await provisionDataEngine({ extensionsRoot: root, fetchFile: () => { throw Error('Offline verification must not fetch'); } });
  assert.ok(offline.files.every(f => f.existing));
  assert.equal(fs.statSync(path.join(root, 'v1.4.3/wasm_eh/json.duckdb_extension.wasm')).mode & 0o777, 0o600);
  const assets = createDataEngineAssets({ extensionsRoot: root });
  const server = http.createServer((req, res) => assets.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [kind, expected] of Object.entries(DATA_ENGINE_FILES)) {
      const url = origin + '/vendor/duckdb/v1.4.3/wasm_eh/' + expected.file;
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/wasm');
      assert.match(response.headers.get('cache-control'), /immutable/);
      assert.match(response.headers.get('content-security-policy'), /wasm-unsafe-eval/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(fixture(kind)));
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal(head.headers.get('content-length'), String(expected.bytes));
      assert.equal((await fetch(origin + `/vendor/duckdb/v1.4.3/wasm_eh/${kind}.wasm`)).status, 200);
      assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    }
    const pinned = path.join(root, 'v1.4.3/wasm_eh/json.duckdb_extension.wasm');
    const extraLink = path.join(root, 'hardlinked-json'); fs.linkSync(pinned, extraLink);
    assert.equal((await fetch(origin + '/vendor/duckdb/v1.4.3/wasm_eh/json.wasm')).status, 503);
    fs.unlinkSync(extraLink);
    // Deterministically grow a real file immediately after the descriptor's
    // initial fstat. Assert the reader stops at its pinned length + sentinel.
    const stat = fs.fstatSync, read = fs.readSync;
    let grew = false, readBytes = 0;
    try {
      fs.fstatSync = (...args) => {
        const result = stat(...args);
        if (!grew && result.size === DATA_ENGINE_FILES.json.bytes) { grew = true; fs.appendFileSync(pinned, Buffer.alloc(DATA_ENGINE_FILES.json.bytes * 2)); }
        return result;
      };
      fs.readSync = (...args) => { const count = read(...args); readBytes += count; return count; };
      assert.equal(assets.status().extensions.json, 'invalid');
      // status also reads Parquet; subtract that known bounded read.
      assert.ok(readBytes <= DATA_ENGINE_FILES.json.bytes + 1 + DATA_ENGINE_FILES.parquet.bytes);
      assert.equal(grew, true);
    } finally { fs.fstatSync = stat; fs.readSync = read; fs.copyFileSync(fixture('json'), pinned); }
    assert.equal((await fetch(origin + '/vendor/duckdb/v1.4.3/wasm_eh/not-allowed.wasm')).status, 404);
    const file = path.join(root, 'v1.4.3/wasm_eh/json.duckdb_extension.wasm');
    const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
    assert.equal((await fetch(origin + '/vendor/duckdb/v1.4.3/wasm_eh/json.wasm')).status, 503);
    assert.equal(assets.status().extensions.json, 'invalid');
    fs.unlinkSync(file);
    assert.equal((await fetch(origin + '/vendor/duckdb/v1.4.3/wasm_eh/json.wasm')).status, 404);
    assert.equal(assets.status().extensions.json, 'missing');
    fs.symlinkSync(fixture('json'), file);
    assert.equal((await fetch(origin + '/vendor/duckdb/v1.4.3/wasm_eh/json.wasm')).status, 503);
    const status = await (await fetch(origin + '/vendor/duckdb/v1.4.3/status')).json();
    assert.equal(status.extensions.json, 'invalid'); assert.equal(status.csv, 'ready');
  } finally { await new Promise(resolve => server.close(resolve)); }
}));
