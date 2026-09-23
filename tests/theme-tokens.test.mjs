import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initial} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';
import {themeColors} from '../src/theme-tokens.ts';
test('theme token overrides validate and reset without replacing panes',()=>{
 const state=initial();const patch={theme:'xp',controlRadius:4,titlebarHeight:40,uiFont:'classic'};
 for(const key of themeColors)patch[key]='#123456';
 const next=applyOperation(state,{action:'patch_appearance',patch});assert.deepEqual(next.monitors,state.monitors);
 const reset=applyOperation(next,{action:'reset_appearance',keys:Object.keys(patch)});assert.deepEqual(reset.appearance,{});
});
test('theme input rejects CSS injection, unknown styles and invalid sizes atomically',()=>{
 const state=initial();const before=structuredClone(state);
 for(const patch of [{theme:'evil'},{surfaceColor:'url(https://example.com)'},{buttonColor:'#fff'},{controlRadius:25},{titlebarHeight:Infinity},{uiFont:'url(x)'}])assert.throws(()=>applyOperation(state,{action:'patch_appearance',patch}));
 assert.deepEqual(state,before);
});
