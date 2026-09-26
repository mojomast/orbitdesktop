import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDockingSync} from '../src/docking-sync.ts';

const placement = active => ({version:1,layout:{type:'group',windows:['a','b']},floats:[],active});
function fixture(savePlacement) {
  const timers = new Map(), applied=[], statuses=[]; let next=0;
  const sync = createDockingSync({applyPlacement:p=>applied.push(p),savePlacement,reload:async()=>{},status:s=>statuses.push(s),
    setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});
  const tick=async()=>{const scheduled=[...timers.values()];timers.clear();for(const fn of scheduled)fn();await new Promise(resolve=>setImmediate(resolve));};
  return {sync,tick,timers,applied,statuses};
}
test('docking changes arriving during a save are persisted without another user gesture',async()=>{
  let release; const sent=[];
  const f=fixture(async p=>{sent.push(p);if(sent.length===1)await new Promise(resolve=>{release=resolve;});return {placement_revision:sent.length};});
  f.sync.hydrate(placement('a'),0);
  f.sync.local(placement('b')); await f.tick();
  f.sync.local(placement('a')); await f.tick();
  release(); await new Promise(resolve=>setImmediate(resolve));
  await f.tick();
  assert.deepEqual(sent,[placement('b'),placement('a')]);
  f.sync.dispose();
});
test('hydration never saves defaults, failed saves do not busy-loop, and remote replacement cancels queued edits',async()=>{
  let saves=0;
  const f=fixture(async()=>{saves++;return {ok:false};});
  f.sync.local(placement('b'));await f.tick();assert.equal(saves,0);
  f.sync.hydrate(placement('a'),0);await f.tick();assert.equal(saves,0);
  f.sync.local(placement('b'));await f.tick();assert.equal(saves,1);assert.equal(f.timers.size,0);
  f.sync.remote(placement('a'),2);await f.tick();assert.equal(saves,1);
  assert.match(f.statuses.at(-1),/Remote docking/);
  f.sync.dispose();
});
