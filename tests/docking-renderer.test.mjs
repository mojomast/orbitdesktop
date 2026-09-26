import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockingRequested, dockingUnsupportedReason } from '../src/docking-renderer.ts';
import { dockviewToPlacement, prunePlacement } from '../src/docking-placement.ts';

test('explicit local query flag alone requests docking', () => {
  assert.equal(dockingRequested('?renderer=docking'), true);
  assert.equal(dockingRequested('?renderer=docking&x=1'), true);
  for (const query of ['', '?renderer=default', '?x=docking', '?renderer=Docking', '?renderer=docking-upgraded']) {
    assert.equal(dockingRequested(query), false, query);
  }
});

test('placement helpers keep live window ids separate from v1 geometry', () => {
  const serialized = { grid: { root: { type: 'leaf', data: { id: 'group', views: ['one', 'two'] } } } };
  const placement = dockviewToPlacement(serialized, 'two');
  assert.deepEqual(prunePlacement(placement, ['one']), { version: 1, layout: { type: 'group', windows: ['one'] }, floats: [], active: null });
});

test('fail closed when connected moves or windows are unavailable', () => {
  assert.match(dockingUnsupportedReason(undefined, false), /Element\.moveBefore/);
  assert.match(dockingUnsupportedReason(undefined, true), /window/);
  assert.match(dockingUnsupportedReason({ monitors: [] }, true), /window/);
});

test('reject duplicate and empty window ids without mutating the workspace', () => {
  const state = { monitors: [{ id: 'one' }, { id: 'one' }] };
  const before = structuredClone(state);
  assert.match(dockingUnsupportedReason(state, true), /duplicate/i);
  assert.deepEqual(state, before);
  assert.match(dockingUnsupportedReason({ monitors: [{ id: '  ' }] }, true), /nonempty/);
});

test('complex v1 state with plugin, spatial, and appearance metadata remains supported', () => {
  const state = {
    version: 1, selected: 'one', arc: 14, view: 'spatial',
    appearance: { accentColor: '#abcdef' }, sidebarHidden: true,
    plugins: [{ window: { id: 'plugin' } }],
    monitors: [{ id: 'one', layout: { type: 'split', axis: 'row', ratio: .5,
      first: { type: 'pane', pane: { id: 'a', kind: 'browser', url: '/apps/a/index.html' } },
      second: { type: 'pane', pane: { id: 'b', kind: 'agent', url: 'orbit://welcome' } } },
    spatial: { x: 1 } }, { id: 'two', layout: { type: 'pane', pane: { id: 'c', kind: 'terminal' } } }],
  };
  const before = structuredClone(state);
  assert.equal(dockingUnsupportedReason(state, true), null);
  assert.deepEqual(state, before);
});
