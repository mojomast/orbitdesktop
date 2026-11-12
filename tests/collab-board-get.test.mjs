// collab-board op get: full entry detail for the Orbit Control Plane connector.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollab } from '../server/collab.mjs';
import { createCollabBoard } from '../server/collab-board.mjs';

const WS = '12345678-1234-4234-9234-123456789abc';
const GID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('collab-board op get returns full entry detail: spec, priority, file scope, deps, history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-get-'));
  const gateways = new Proxy({}, { get: () => async () => { throw new Error('no turns'); } });
  const collab = createCollab({ directory: path.join(dir, 'collab'), gateways, advanceIntervalMs: 60000 });
  const operate = body => new Promise((resolve, reject) => collab.handle((_r, status, obj) => (status >= 400 ? reject(Object.assign(new Error(obj.error), { status })) : resolve(obj)), {}, body));
  const group = { id: GID, name: 'zz', members: [{ id: 'hermes' }] };
  const groups = { find: id => (id === GID ? group : null), boardOf: () => group.board || null, linkBoard: (_id, link) => { group.board = link; } };
  const board = createCollabBoard({ runtimeRoot: dir, collab: () => operate, groups: () => groups, workspace: () => WS });
  try {
    const spec = 'Do the thing\n\nProject: orbit\nPriority: P2\nFile scope: src/a.mjs, src/b.mjs\nDepends on: t_x';
    const made = await board.op({ group: GID, op: 'new', title: 'Hooked', spec, by: 'local-workers' });
    await board.op({ group: GID, op: 'update', entry: made.entry.id, status: 'doing', note: 'started', by: 'hermes' });
    const { entry } = await board.op({ group: GID, op: 'get', entry: made.entry.id });
    assert.match(entry.spec, /^Do the thing/);
    assert.equal(entry.priority, 2);
    assert.equal(entry.project, 'orbit');
    assert.deepEqual(entry.fileScope, ['src/a.mjs', 'src/b.mjs']);
    assert.deepEqual(entry.dependsOn, ['t_x']);
    assert.ok(entry.history.length >= 1 && entry.history.every(e => e.taskId === made.entry.id));
    await assert.rejects(board.op({ group: GID, op: 'get', entry: 'nope' }), /No such board entry/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
