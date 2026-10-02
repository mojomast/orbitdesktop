import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initial, leaves } from '../src/model.ts';
import { applyOperation } from '../src/workspace-ops.ts';
import { arrangementOperations, requireFreshPreview } from '../src/workspace-arrange-plan.ts';

test('selected-window grid stays bounded and retains all panes and unrelated windows', () => {
  const state = initial(), ids = state.monitors.slice(0, 2).map(m => m.id);
  const ops = arrangementOperations(state, ids, 'grid', 2, { width: 1000, height: 600 });
  const next = ops.reduce(applyOperation, state);
  assert.deepEqual(next.monitors.map(m => leaves(m.layout)), state.monitors.map(m => leaves(m.layout)));
  assert.deepEqual(next.monitors[2], state.monitors[2]);
  for (const m of next.monitors.slice(0, 2)) {
    assert.ok(m.frame.x >= 0 && m.frame.y >= 0);
    assert.ok(m.frame.x + m.frame.width <= 1000 && m.frame.y + m.frame.height <= 600);
  }
});
test('focus reuses one window; compare requires two; docking only selects', () => {
  const state = initial(), ids = state.monitors.map(m => m.id), size = { width: 900, height: 600 };
  const focused = arrangementOperations(state, [ids[1]], 'focus', 2, size).reduce(applyOperation, state);
  assert.equal(focused.selected, ids[1]);
  assert.equal(focused.monitors[1].frame.width, 900);
  assert.throws(() => arrangementOperations(state, ids, 'compare', 2, size), /exactly two/);
  assert.deepEqual(arrangementOperations(state, [ids[1]], 'focus', 2, size, true), [{ action: 'select', window_id: ids[1] }]);
  assert.throws(() => arrangementOperations(state, ids, 'grid', 2, size, true), /unavailable/);
  assert.throws(() => arrangementOperations(state, ids, 'grid', 3, { width: 600, height: 500 }), /too small/);
});
test('freshness fences revision, actual state and measured desktop changes', () => {
  const state = initial(), size = { width: 900, height: 600 };
  const preview = { base_revision: 8, before: structuredClone(state), viewport: size };
  assert.doesNotThrow(() => requireFreshPreview(preview, { revision: 8, state }, size));
  assert.throws(() => requireFreshPreview(preview, { revision: 9, state }, size), /Workspace changed/);
  assert.throws(() => requireFreshPreview(preview, { revision: 8, state: { ...state, selected: state.monitors[0].id } }, size), /Workspace changed/);
  assert.throws(() => requireFreshPreview(preview, { revision: 8, state }, { ...size, width: 899 }), /size changed/);
});
