import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,validate} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';
test('spatial text size persists independently and invalid sizes reject atomically',()=>{
 const s=initial(),before=structuredClone(s),id=s.selected;
 const next=applyOperation(s,{action:'update_window',window_id:id,spatialFontSize:60});
 assert.equal(next.monitors.find(m=>m.id===id).fontSize,19);
 assert.equal(next.monitors.find(m=>m.id===id).spatialFontSize,60);
 assert.deepEqual(validate(JSON.parse(JSON.stringify(next))),next);
 for(const size of [0,5,97,NaN,Infinity,'60']) assert.throws(()=>applyOperation(s,{action:'update_window',window_id:id,spatialFontSize:size}));
 assert.deepEqual(s,before);
});
