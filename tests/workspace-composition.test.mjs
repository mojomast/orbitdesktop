import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createWorkspaceService } from '../server/workspace.mjs';
import { initial } from '../src/model.ts';

function fixture(t) {
  const root = fs.mkdtempSync('/tmp/opencode/orbit-composition-');
  const workspace_id = randomUUID(), token = 'composition-fixture', port = 4317;
  const service = createWorkspaceService({ token, port, root, reply(res, status, body) { res.status = status; res.end(JSON.stringify(body)); } });
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function call(body, { control = false, recovery = false, credential = token } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify({ workspace_id, ...body }))]);
    req.method = 'POST'; req.headers = { authorization: `Bearer ${credential}`, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    return await new Promise((resolve, reject) => {
      const res = { status: 0, end(value) { resolve({ status: this.status, body: JSON.parse(value) }); } };
      service.handle(req, res, control, recovery).catch(reject);
    });
  }
  return { service, workspace_id, call };
}

test('owner layout preview is read-only, restricted to existing layout and apply is fenced and replayable', async t => {
  const f = fixture(t), state = initial();
  assert.equal((await f.call({ action: 'sync', state })).status, 200);
  const before = f.service.read(f.workspace_id);
  const operations = [{ action: 'arrange_windows', width: 1200, height: 800, columns: 2 }];
  const preview = await f.call({ action: 'layout_preview', base_revision: 1, operations });
  assert.equal(preview.status, 200); assert.equal(preview.body.preview, true);
  assert.deepEqual(f.service.read(f.workspace_id), before);
  const request = { action: 'layout_apply', base_revision: 1, operations, operation_id: randomUUID(), intent: 'Arrange existing windows' };
  const committed = await f.call(request);
  assert.equal(committed.status, 200); assert.equal(committed.body.revision, 2);
  assert.deepEqual(committed.body.state.monitors.map(m => m.id), state.monitors.map(m => m.id));
  assert.deepEqual((await f.call(request)).body, committed.body);
  assert.equal((await f.call({ ...request, operation_id: randomUUID() })).status, 409);
  for (const op of [{ action: 'close_window', window_id: state.monitors[0].id }, { action: 'plugin_disable_all' }, { action: 'set_workspace', state }, { action: 'update_window', window_id: state.monitors[0].id, name: 'Disallowed field' }]) {
    assert.equal((await f.call({ action: 'layout_apply', base_revision: 2, operations: [op] })).status, 400);
  }
  assert.equal((await f.call({ action: 'layout_preview', base_revision: 2, operations }, { credential: 'wrong' })).status, 403);
  assert.equal((await f.call({ action: 'layout_preview', base_revision: 2, operations }, { control: true, credential: before.capability })).status, 403);
  assert.equal((await f.call({ action: 'layout_preview', base_revision: 2, operations }, { recovery: true })).status, 403);
});

test('checkpoint comparison is scoped, bounded metadata and cannot mutate or bypass stale restore checks', async t => {
  const f = fixture(t), state = initial();
  await f.call({ action: 'sync', state });
  const saved = await f.call({ action: 'checkpoint', base_revision: 1, label: 'Before rename' });
  const next = structuredClone(state); next.monitors[0].name = 'Changed title'; next.appearance = { background: '#123456' };
  next.monitors[0].layout.pane.url = 'https://example.invalid/private-url';
  await f.call({ action: 'sync', base_revision: 1, state: next });
  const before = f.service.read(f.workspace_id), checkpointCount = f.service.store.checkpointList(f.workspace_id).length;
  const request = { action: 'checkpoint_preview', base_revision: 2, checkpoint_id: saved.body.checkpoint };
  const preview = await f.call(request);
  assert.equal(preview.status, 200); assert.equal(preview.body.checkpoint.id, saved.body.checkpoint);
  assert.ok(preview.body.changes.some(c => c.target === 'window' && c.fields.includes('name')));
  assert.ok(preview.body.changes.some(c => c.label === 'Appearance'));
  assert.ok(preview.body.changes.some(c => c.target === 'pane' && c.fields.includes('url')));
  assert.ok(!JSON.stringify(preview.body).includes('private-url'));
  assert.deepEqual(f.service.read(f.workspace_id), before);
  assert.equal(f.service.store.checkpointList(f.workspace_id).length, checkpointCount);
  assert.equal((await f.call({ ...request, base_revision: 1 })).status, 409);
  assert.equal((await f.call(request, { credential: 'wrong' })).status, 403);
  assert.equal((await f.call(request, { recovery: true })).status, 403);
  const other = randomUUID(); await f.call({ workspace_id: other, action: 'sync', state });
  assert.notEqual((await f.call({ ...request, workspace_id: other, base_revision: 1 })).status, 200);
  const later = structuredClone(next); later.arc = 4;
  await f.call({ action: 'sync', base_revision: 2, state: later });
  assert.equal((await f.call({ action: 'restore', checkpoint_id: saved.body.checkpoint, base_revision: preview.body.base_revision, confirm: true })).status, 409);
});
