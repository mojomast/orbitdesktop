import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initial,validate} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';
test('windows above eight validate and survive round trip and plugin enable',()=>{
 let state=initial();const ids=state.monitors.map(m=>m.id);
 for(let i=0;i<17;i++)state=applyOperation(state,{action:'add_window',kind:'browser'});
 assert.equal(state.monitors.length,20);
 assert.deepEqual(validate(JSON.parse(JSON.stringify(state))).monitors.slice(0,3).map(m=>m.id),ids);
 state=applyOperation(state,{action:'plugin_install',manifest:{apiVersion:1,id:'count-test',version:'1.0.0',title:'Test',entry:'/apps/test/index.html'}});
 state=applyOperation(state,{action:'plugin_enable',plugin_id:'count-test'});assert.equal(state.monitors.length,21);
});
