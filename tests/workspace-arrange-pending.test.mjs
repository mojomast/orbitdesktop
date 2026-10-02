import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePendingArrangement, storePendingArrangement, pendingArrangementKey } from '../src/workspace-arrange-pending.ts';
const workspace = crypto.randomUUID();
const command = { action: 'layout_apply', workspace_id: workspace, base_revision: 7,
  operation_id: crypto.randomUUID(), intent: 'Focus existing window', operations: [{ action: 'select', window_id: 'existing-pane' }] };

test('retained envelope round trips the exact command without preview state', () => {
  const map = new Map();
  const storage = { setItem: (key, value) => map.set(key, value), getItem: key => map.get(key) ?? null };
  storePendingArrangement(storage, command);
  assert.deepEqual(parsePendingArrangement(map.get(pendingArrangementKey(workspace)), workspace), command);
  assert.equal(map.size, 1);
});
test('corrupt, oversized, foreign and non-layout commands fail closed', () => {
  for (const value of [{ ...command, workspace_id: crypto.randomUUID() }, { ...command, operation_id: '' },
    { ...command, base_revision: -1 }, { ...command, state: {} }, { ...command, operations: [{ action: 'close_window', window_id: 'existing-pane' }] },
    { ...command, operations: [{ action: 'select', window_id: 'existing-pane', unexpected: true }] }])
    assert.throws(() => parsePendingArrangement(JSON.stringify(value), workspace));
  assert.throws(() => parsePendingArrangement('{', workspace));
  assert.throws(() => parsePendingArrangement(' '.repeat(64001), workspace));
});
test('unavailable or non-retaining storage prevents dispatch preparation', () => {
  assert.throws(() => storePendingArrangement({ setItem() { throw Error('quota'); } }, command), /quota/);
  assert.throws(() => storePendingArrangement({ setItem() {}, getItem() { return null; } }, command), /nothing was dispatched/);
});
