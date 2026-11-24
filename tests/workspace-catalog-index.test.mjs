// RED for wave A slice T2b: `describe catalog=true` returns an index, and one
// operation's schema only on request. Today it returns every operation schema
// plus all $defs (~10.4k tokens) and the result stays in the chat transcript.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {initial} from '../src/model.ts';
import {createWorkspaceService} from '../server/workspace.mjs';
import {contract} from '../contracts/workspace-v1.mjs';

async function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-catalog-')), token = randomUUID(), id = randomUUID();
  let svc;
  const server = http.createServer((req, res) => svc.handle(req, res, req.url === '/control'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  svc = createWorkspaceService({root, port: server.address().port, token, devOrigins: [], reply: (res, status, body) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); }});
  t.after(async () => { await new Promise(resolve => server.close(resolve)); svc.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const request = async body => {
    const response = await fetch(origin + '/workspace', {method: 'POST', headers: {Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({workspace_id: id, ...body})});
    return {status: response.status, body: await response.json()};
  };
  assert.equal((await request({action: 'sync', state: initial()})).status, 200);
  return request;
}

const names = Object.keys(contract.operations).sort();

test('catalog=true is an index of operation names', async t => {
  const request = await harness(t);
  const {status, body} = await request({action: 'describe', catalog: true});
  assert.equal(status, 200);
  assert.deepEqual(body.catalog.operations, names);
  assert.equal(Object.hasOwn(body.catalog, '$defs'), false);
  assert.equal(body.catalog.version, contract.version);
  assert.deepEqual(body.catalog.limits, contract.limits);
  assert.ok(JSON.stringify(body.catalog).length < 4000, `index is ${JSON.stringify(body.catalog).length} chars`);
});

test('catalog_operation returns one schema and only the $defs it references', async t => {
  const request = await harness(t);
  const {status, body} = await request({action: 'describe', catalog_operation: 'layout_panes'});
  assert.equal(status, 200);
  assert.deepEqual(body.catalog.operation, {name: 'layout_panes', ...contract.operations.layout_panes});
  const refs = new Set([...JSON.stringify(contract.operations.layout_panes).matchAll(/#\/\$defs\/([A-Za-z0-9_]+)/g)].map(m => m[1]));
  for (const key of Object.keys(body.catalog.$defs || {})) assert.ok(contract.schema.$defs[key], key);
  for (const key of refs) assert.ok(Object.hasOwn(body.catalog.$defs, key), `missing referenced $def ${key}`);
  assert.ok(Object.keys(body.catalog.$defs).length < Object.keys(contract.schema.$defs).length);
});

test('an unknown operation is refused', async t => {
  const request = await harness(t);
  const {status} = await request({action: 'describe', catalog_operation: 'no_such_operation'});
  assert.equal(status, 400);
});
