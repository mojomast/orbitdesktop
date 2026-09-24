import {test} from 'node:test';
import assert from 'node:assert/strict';
import {themes,themePatch} from '../src/themes.ts';
import {initial} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';
test('all theme presets install wallpaper and preserve viewport, layout and plugins',()=>{
 for(const theme of themes){const state=initial();state.appearance={wallpaper:'/apps/example/wall.png',fullViewport:true,sidebarWidth:240};const next=applyOperation(state,{action:'patch_appearance',patch:themePatch(theme.name)});assert.deepEqual(next.monitors,state.monitors);assert.deepEqual(next.plugins,state.plugins);assert.equal(next.appearance.wallpaper,themePatch(theme.name).wallpaper);assert.match(next.appearance.wallpaper,/^\/wallpapers\/[a-z]+\.svg$/);assert.equal(next.appearance.fullViewport,true);assert.equal(next.appearance.sidebarWidth,240);assert.equal(next.appearance.accentColor,theme.accentColor);assert.equal(state.appearance.background,undefined);}
 assert.throws(()=>themePatch('unknown'));
});
