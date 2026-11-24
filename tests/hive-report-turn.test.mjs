import test from 'node:test';
import assert from 'node:assert/strict';
import {reportTurns} from '../src/hive-report-turn.ts';

test('enrolled panes take bounded turns despite aligned polls; a withdrawn pane cannot block the queue',()=>{
  const t=reportTurns(30000),a=Symbol(),b=Symbol(),c=Symbol();
  assert.equal(t.delay(a,0),0);
  assert.equal(t.delay(b,2),29998);
  assert.ok(t.delay(a,30000)>0);
  assert.equal(t.delay(b,30000),0);
  assert.ok(t.delay(c,30001)>0);t.leave(a);
  assert.ok(t.delay(b,60000)>0);assert.equal(t.delay(c,60000),0);
  assert.equal(t.delay(c,130000),0); // crashed waiters eventually expire
});
