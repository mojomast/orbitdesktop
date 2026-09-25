import test from 'node:test';
import assert from 'node:assert/strict';
import { initial, validate } from '../src/model.ts';
import { applyOperation } from '../src/workspace-ops.ts';

test('per-window opacity validates, round-trips and preserves unrelated windows and pane identities', () => {
  const state = initial();
  const changed = applyOperation(state, {action:'update_window', window_id:state.monitors[0].id, opacity:0.65});
  assert.equal(changed.monitors[0].opacity, 0.65);
  assert.equal(state.monitors[0].opacity, undefined);
  assert.deepEqual(changed.monitors[0].layout, state.monitors[0].layout);
  assert.deepEqual(changed.monitors.slice(1), state.monitors.slice(1));
  assert.equal(validate(JSON.parse(JSON.stringify(changed))).monitors[0].opacity, 0.65);
  for (const opacity of [0, 0.19, 1.01, NaN, Infinity, '0.8', null]) {
    assert.throws(() => applyOperation(state, {action:'update_window', window_id:state.monitors[0].id, opacity}));
  }
});
