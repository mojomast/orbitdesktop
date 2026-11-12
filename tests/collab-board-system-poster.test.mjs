// Local workers post board updates as the 'local-workers' system identity; members-only --as stays enforced for everyone else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollabBoard, SYSTEM_POSTERS } from '../server/collab-board.mjs';
import { BOARD_POSTER } from '../server/local-workers.mjs';

function board() {
  const calls = [];
  const g = { id: 'g1', name: 'Comfyrizz build', members: [{ id: 'hermes' }, { id: 'pipi' }] };
  const groups = () => ({ find: (id) => (id === g.id ? g : null), boardOf: () => ({ workspace: '11111111-1111-1111-1111-111111111111', projectId: 'p1' }), linkBoard() {} });
  const collab = () => async (req) => {
    calls.push(req);
    const task = { id: req.task_id || 't1', title: 'x', status: req.status || 'todo', owner: '', checkins: [] };
    return { project: { id: 'p1' }, entry: task.id, tasks: [task] };
  };
  const cb = createCollabBoard({ runtimeRoot: mkdtempSync(path.join(os.tmpdir(), 'cb-')), collab, groups, workspace: () => '11111111-1111-1111-1111-111111111111' });
  return { cb, calls };
}

test('the adapter posts as a system identity the board accepts', async () => {
  assert.equal(BOARD_POSTER, 'local-workers');
  assert.ok(SYSTEM_POSTERS.has(BOARD_POSTER));
  const { cb, calls } = board();
  await cb.op({ group: 'g1', op: 'update', entry: 't1', status: 'doing', note: 'MR.INDIA: running', by: BOARD_POSTER });
  assert.equal(calls.at(-1).by, 'local-workers');
});

test('members still post as themselves; non-members are still refused', async () => {
  const { cb } = board();
  await cb.op({ group: 'g1', op: 'update', entry: 't1', status: 'doing', by: 'hermes' });
  for (const by of ['MR.INDIA', 'local-worker', 'Local-Workers', 'orbit']) {
    await assert.rejects(cb.op({ group: 'g1', op: 'update', entry: 't1', status: 'doing', by }), /must be your @handle/);
  }
});
