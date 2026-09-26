import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPlacement, validateDockingPlacement, prunePlacement, placementEqual,
  PLACEMENT_LIMITS, dockviewToPlacement, placementToDockview, ensurePlacementWindows } from '../src/docking-placement.ts';

const group = (...windows) => ({ type: 'group', windows });
const frame = { x: 32, y: 48, width: 600, height: 420 };
const place = (layout = group('a')) => ({ version: 1, layout, floats: [], active: 'a' });
const branch = (first, second, direction = 'horizontal', ratio = .4) => ({ type: 'branch', direction, ratio, first, second });

test('strict adjunct validation rejects foreign fields, versions, geometry, directions and ratios', () => {
  const invalid = [
    { ...place(), extra: 1 }, { ...place(), version: 2 },
    { ...place(), layout: { ...group('a'), extra: true } },
    { ...place(branch(group('a'), group('b'), 'diagonal')) },
    { ...place(branch(group('a'), group('b'), 'horizontal', 1)) },
    ...[NaN, Infinity, -1, 10001].map(x => ({ ...place(), floats: [{ windows: ['b'], frame: { ...frame, x } }] })),
    { ...place(), floats: [{ windows: ['b'], frame: { ...frame, width: 10 } }] },
  ];
  for (const value of invalid) assert.throws(() => validateDockingPlacement(value), { code: 'INVALID_PLACEMENT' });
});

test('duplicate ids, stale ids and excessive depth are rejected', () => {
  for (const value of [place(group('a', 'a')), place(branch(group('a'), group('a'))),
    { ...place(), floats: [{ windows: ['a'], frame }] },
    { ...place(), floats: [{ windows: ['b', 'b'], frame }] }]) {
    assert.throws(() => validateDockingPlacement(value), { code: 'INVALID_PLACEMENT' });
  }
  assert.throws(() => validateDockingPlacement(place(), { windowIds: ['b'] }), { code: 'INVALID_PLACEMENT' });
  let nested = group('a');
  for (let i = PLACEMENT_LIMITS.maxDepth; i >= 0; i--) nested = branch(nested, group(`b${i}`), i % 2 ? 'vertical' : 'horizontal');
  assert.throws(() => validateDockingPlacement(place(nested)), { code: 'INVALID_PLACEMENT' });
});

test('pruning collapses empty groups and branches and removes empty floats', () => {
  const input = { ...place(branch(group('gone'), branch(group('a'), group('stale'), 'vertical'))),
    floats: [{ windows: ['lost'], frame }, { windows: ['b', 'stale2'], frame }] };
  assert.deepEqual(prunePlacement(input, ['a', 'b']), { ...place(group('a')), floats: [{ windows: ['b'], frame }] });
  assert.deepEqual(prunePlacement(input, []), emptyPlacement());
  assert.ok(placementEqual(null, emptyPlacement()));
  assert.ok(placementEqual(place(), { active: 'a', floats: [], layout: group('a'), version: 1 }));
  assert.ok(!placementEqual(place(), place(group('b'))));
});

test('synthetic Dockview grid converts both ways with tab order, ratios, floats and active window', () => {
  const serialized = {
    grid: { orientation: 'HORIZONTAL', root: { type: 'branch', data: [
      { type: 'leaf', size: 350, data: { id: 'left', views: ['a', 'b'], activeView: 'b' } },
      { type: 'leaf', size: 650, data: { id: 'right', views: ['c'], activeView: 'c' } },
    ] } },
    floatingGroups: [{ data: { id: 'floating', views: ['d'] }, position: { left: 73, top: 84, width: 440, height: 300 } }],
    activeGroup: 'left',
  };
  const placement = dockviewToPlacement(serialized, 'b');
  assert.deepEqual(validateDockingPlacement(placement), placement);
  assert.equal(placement.layout.ratio, .35);
  assert.deepEqual(placement.floats[0].frame, { x: 73, y: 84, width: 440, height: 300 });
  const rebuilt = placementToDockview(placement, ['a', 'b', 'c', 'd'].map(id => ({ id, title: id })));
  assert.ok(placementEqual(dockviewToPlacement(rebuilt, 'b'), placement));
});

test('missing windows default docked and restored panels are always rendered', () => {
  // An entirely empty placement must not be rewritten into one forced group.
  assert.deepEqual(ensurePlacementWindows(emptyPlacement(), ['a', 'b']), emptyPlacement());
  // A populated placement gains any v1 window it does not reference (new/restored).
  assert.deepEqual(ensurePlacementWindows(place(group('a')), ['a', 'b', 'c']).layout, group('a', 'b', 'c'));
  const withFloat = { version: 1, layout: group('a'), floats: [{ windows: ['f'], frame }], active: 'f' };
  assert.deepEqual(ensurePlacementWindows(withFloat, ['a', 'f', 'b']).layout, group('a', 'b'));
  // Dockview must be told to render every panel, including inactive tabs, or
  // their live monitor element loses its placeholder on restore.
  const serialized = placementToDockview(place(group('a', 'b')), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(serialized.panels.a.renderer, 'always');
  assert.equal(serialized.panels.b.renderer, 'always');
  // Dockview requires a branch root even for a single docked group.
  assert.equal(serialized.grid.root.type, 'branch');
});

test('three collinear groups remain collinear with their ratios and independently active tabs', () => {
  const serialized={grid:{orientation:'HORIZONTAL',root:{type:'branch',data:[
    {type:'leaf',size:200,data:{id:'one',views:['a','b'],activeView:'b'}},
    {type:'leaf',size:300,data:{id:'two',views:['c','d'],activeView:'d'}},
    {type:'leaf',size:500,data:{id:'three',views:['e'],activeView:'e'}},
  ]}},activeGroup:'three'};
  const saved=validateDockingPlacement(dockviewToPlacement(serialized,'e'));
  assert.equal(saved.layout.direction,'horizontal');
  assert.equal(saved.layout.second.direction,'horizontal');
  assert.equal(saved.layout.first.active,'b');
  assert.equal(saved.layout.second.first.active,'d');
  const restored=placementToDockview(saved,['a','b','c','d','e'].map(id=>({id})));
  assert.equal(restored.grid.orientation,'HORIZONTAL');
  assert.equal(restored.grid.root.data.length,3);
  assert.deepEqual(restored.grid.root.data.map(node=>node.type),['leaf','leaf','leaf']);
  assert.deepEqual(restored.grid.root.data.map(node=>node.data.activeView),['b','d','e']);
  for(const [i,ratio] of [.2,.3,.5].entries())assert.ok(Math.abs(restored.grid.root.data[i].size/10000-ratio)<1e-10);
  assert.ok(placementEqual(dockviewToPlacement(restored,'e'),saved));
  assert.throws(()=>validateDockingPlacement({...place(),layout:{type:'group',windows:['a'],active:'b'}}));
});

test('pruning a nested branch preserves geometry direction without an artificial depth restriction',()=>{
  const original=place(branch(branch(group('a'),group('b'),'vertical'),group('gone'),'horizontal'));
  const pruned=prunePlacement(original,['a','b']);
  assert.equal(pruned.layout.direction,'vertical');
  assert.doesNotThrow(()=>validateDockingPlacement(pruned));
});

test('bounded wide grids do not become over-depth binary chains',()=>{
  const ids=Array.from({length:100},(_,i)=>'window-'+i);
  const saved=dockviewToPlacement({grid:{orientation:'HORIZONTAL',root:{type:'branch',data:ids.map(id=>({type:'leaf',size:100,data:{id,views:[id]}}))}}},ids[0]);
  assert.doesNotThrow(()=>validateDockingPlacement(saved));
  const restored=placementToDockview(saved,ids.map(id=>({id})));
  assert.equal(restored.grid.root.data.length,100);
  assert.ok(restored.grid.root.data.every(node=>node.type==='leaf' && Math.abs(node.size-100)<.001));
});
