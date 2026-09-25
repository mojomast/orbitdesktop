import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initial } from '../src/model.ts';
import { createWorkspaceService } from '../server/workspace.mjs';

const token = `workspace-receipt-test-${randomUUID()}`;

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-workspace-receipts-'));
  const id = randomUUID();
  let service;
  const server = http.createServer((req, res) => service.handle(req, res, req.url === '/control'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const startService = () => createWorkspaceService({
    root, port, token, devOrigins: [],
    reply: (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  });
  service = startService();
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function request(body, { control = false, capability = token, workspaceId = id } = {}) {
    const response = await fetch(`${origin}${control ? '/control' : '/workspace'}`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }
  return { root, id, origin, request, get service() { return service; }, restart() { service.close(); service = startService(); } };
}

const apply = (base_revision, operation_id, operation, intent = 'receipt test mutation') => ({
  action: 'apply', base_revision, operation_id, intent,
  operations: [operation],
});

test('receipt commands require strict metadata and reject spoofed actors and unknown keys', async t => {
  const { id, request, service } = await setup(t);
  const synced = await request({ action: 'sync', state: initial() });
  assert.equal(synced.status, 200);
  const capability = service.store.read(id).capability;
  const base = apply(1, 'strict-meta-1', { action: 'sidebar', hidden: true });
  for (const invalid of [
    { ...base, actor: 'owner' },
    { ...base, unexpected: 'value' },
    { ...base, operation_id: 'bad key' },
    { ...base, intent: '' },
    { ...base, operation_id: undefined },
    { ...base, intent: undefined },
  ]) {
    assert.equal((await request(invalid, { control: true, capability })).status, 400);
  }
  assert.equal(service.store.read(id).revision, 1);
  assert.deepEqual((await request({ action: 'history' })).body.checkpoints, []);
});

test('same operation key and payload replays its exact response after a newer revision', async t => {
  const { id, request, service } = await setup(t);
  await request({ action: 'sync', state: initial() });
  const capability = service.store.read(id).capability;
  const command = apply(1, 'replay-exact-1', { action: 'sidebar', hidden: true });
  const first = await request(command, { control: true, capability });
  assert.equal(first.status, 200);
  const second = await request(apply(2, 'later-operation-1', { action: 'set_view', view: 'spatial' }), { control: true, capability });
  assert.equal(second.status, 200);
  assert.equal(second.body.revision, 3);
  const replay = await request(command, { control: true, capability });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal(service.store.read(id).revision, 3);
});

test('reusing an operation key with changed payload is rejected without mutation', async t => {
  const { id, request, service } = await setup(t);
  await request({ action: 'sync', state: initial() });
  const capability = service.store.read(id).capability;
  const first = apply(1, 'payload-identity-1', { action: 'sidebar', hidden: true });
  assert.equal((await request(first, { control: true, capability })).status, 200);
  const before = structuredClone(service.store.read(id));
  const changed = apply(1, 'payload-identity-1', { action: 'sidebar', hidden: false });
  const result = await request(changed, { control: true, capability });
  assert.equal(result.status, 409);
  assert.equal(result.body.category, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(service.store.read(id), before);
});

test('owner and controller have isolated receipt namespaces', async t => {
  const { id, request, service } = await setup(t);
  await request({ action: 'sync', state: initial() });
  const capability = service.store.read(id).capability;
  const key = 'actor-isolation-1';
  const ownerCommand = { action: 'sync', state: initial(), base_revision: 1, operation_id: key, intent: 'owner sync' };
  const ownerResult = await request(ownerCommand);
  assert.equal(ownerResult.status, 200);
  const controllerCommand = apply(2, key, { action: 'sidebar', hidden: true }, 'controller apply');
  const controllerResult = await request(controllerCommand, { control: true, capability });
  assert.equal(controllerResult.status, 200);
  const ownerReplay = await request(ownerCommand);
  const controllerReplay = await request(controllerCommand, { control: true, capability });
  assert.deepEqual(ownerReplay.body, ownerResult.body);
  assert.deepEqual(controllerReplay.body, controllerResult.body);
  assert.equal(service.store.read(id).revision, 3);
});

test('concurrent stale human and agent fetches allow one commit without lost changes', async t => {
  const { id, request, service } = await setup(t);
  await request({ action: 'sync', state: initial() });
  const capability = service.store.read(id).capability;
  const owner = {
    action: 'sync', state: { ...initial(), sidebarHidden: true }, base_revision: 1,
    operation_id: 'concurrent-owner-1', intent: 'owner state update',
  };
  const agent = apply(1, 'concurrent-agent-1', { action: 'set_view', view: 'spatial' });
  const results = await Promise.all([request(owner), request(agent, { control: true, capability })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const committed = results.find(result => result.status === 200);
  assert.equal(committed.body.revision, 2);
  assert.equal(service.store.read(id).revision, 2);
  const rejected = results.find(result => result.status === 409);
  assert.equal(rejected.body.category, 'REVISION_CONFLICT');
  const final = service.store.read(id).state;
  if (committed.body.state.sidebarHidden) assert.equal(final.sidebarHidden, true);
  else assert.equal(final.view, 'spatial');
});

test('restore and manual checkpoint mutations return durable receipts and save checkpoints', async t => {
  const { id, request, service } = await setup(t);
  await request({ action: 'sync', state: initial() });
  const capability = service.store.read(id).capability;
  const applied = await request(apply(1, 'checkpoint-source-1', { action: 'sidebar', hidden: true }), { control: true, capability });
  assert.equal(applied.status, 200);
  const beforeRestore = (await request({ action: 'history' })).body.checkpoints[0];
  const restore = {
    action: 'restore', checkpoint_id: beforeRestore.id, base_revision: 2, confirm: true,
    operation_id: 'restore-receipt-1', intent: 'restore to saved state',
  };
  const restored = await request(restore, { control: true, capability });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.command_receipt.operation_id, restore.operation_id);
  assert.equal(restored.body.state.sidebarHidden, undefined);
  const checkpoint = {
    action: 'checkpoint', label: 'Receipt checkpoint', base_revision: 3,
    operation_id: 'manual-checkpoint-1', intent: 'save manual point',
  };
  const saved = await request(checkpoint, { control: true, capability });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.command_receipt.operation_id, checkpoint.operation_id);
  const history = (await request({ action: 'history' })).body;
  assert.equal(history.checkpoints.length, 3);
  assert.ok(history.checkpoints.some(item => item.id === saved.body.checkpoint));
  assert.deepEqual((await request(restore, { control: true, capability })).body, restored.body);
  assert.deepEqual((await request(checkpoint, { control: true, capability })).body, saved.body);
});

test('invalid operation batch creates no receipt, checkpoint, or event', async t => {
  const { id, request, service } = await setup(t);
  await request({ action: 'sync', state: initial() });
  const capability = service.store.read(id).capability;
  const events = service.store.eventsAfter(0);
  const result = await request({
    action: 'apply', base_revision: 1, operation_id: 'invalid-batch-1', intent: 'invalid batch',
    operations: [{ action: 'sidebar', hidden: true }, { action: 'set_view', view: 'not-a-view' }],
  }, { control: true, capability });
  assert.equal(result.status, 400);
  assert.equal(service.store.read(id).revision, 1);
  assert.deepEqual((await request({ action: 'history' })).body.checkpoints, []);
  assert.deepEqual(service.store.eventsAfter(0), events);
  const retry = await request(apply(1, 'invalid-batch-1', { action: 'sidebar', hidden: true }), { control: true, capability });
  assert.equal(retry.status, 200, 'failed batch must not consume its operation key');
});

test('creation ID retries after service restart on the same SQLite database', async t => {
  const fixture = await setup(t);
  const creation = {
    action: 'sync', state: initial(), base_revision: 0,
    operation_id: 'creation-retry-1', intent: 'connect workspace',
  };
  const first = await fixture.request(creation);
  assert.equal(first.status, 200);
  fixture.restart();
  const replay = await fixture.request(creation);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);
  assert.equal(fixture.service.store.read(fixture.id).revision, 1);
  assert.equal(fixture.service.store.eventsAfter(0).length, 1);
});

test('a retried add_window keeps generated IDs and does not create a second resource',async t=>{
  const fixture=await setup(t);
  await fixture.request({action:'sync',state:initial()});
  const capability=fixture.service.read(fixture.id).capability;
  const command=apply(1,'create-window-once',{action:'add_window',kind:'browser',name:'Receipt-bound window'});
  const first=await fixture.request(command,{control:true,capability});
  assert.equal(first.status,200);assert.equal(first.body.state.monitors.length,4);
  fixture.restart();
  const replay=await fixture.request(command,{control:true,capability});
  assert.deepEqual(replay.body,first.body);
  assert.equal(fixture.service.read(fixture.id).state.monitors.length,4);
  assert.equal(fixture.service.store.checkpointList(fixture.id).length,1);
});

test('Unicode receipt intent and checkpoint labels keep schema-permitted characters intact',async t=>{
  const fixture=await setup(t);
  await fixture.request({action:'sync',state:initial()});
  const label='😀'.repeat(120);
  const result=await fixture.request({action:'checkpoint',base_revision:1,operation_id:'unicode-label',intent:'😀'.repeat(160),label});
  assert.equal(result.status,200);
  assert.equal(fixture.service.store.checkpointGet(fixture.id,result.body.checkpoint).label,label);
});
