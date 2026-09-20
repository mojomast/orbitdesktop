import {test} from 'node:test';import assert from 'node:assert/strict';
import {initial,leaves} from '../src/model.ts';import {applyOperation as apply} from '../src/workspace-ops.ts';
function installed(){return apply(initial(),{action:'plugin_install',manifest:{apiVersion:1,id:'notes',version:'1.0.0',title:'Notes',entry:'/apps/notes/index.html'},config:{title:'Keep',message:'old'}});}
test('partial plugin configuration preserves existing fields and rejects invalid values',()=>{
 const s=installed();const next=apply(s,{action:'plugin_patch_config',plugin_id:'notes',patch:{message:'new'}});assert.deepEqual(next.plugins[0].config,{title:'Keep',message:'new'});assert.equal(s.plugins[0].config.message,'old');assert.throws(()=>apply(s,{action:'plugin_patch_config',plugin_id:'notes',patch:{bad:[]}}));
});
test('disabled plugin window customization persists on enable and configuration preserves split terminal identity',()=>{
 let s=apply(installed(),{action:'plugin_window',plugin_id:'notes',settings:{name:'Personal notes',fontSize:12,diagonal:60}});
 assert.equal(s.plugins[0].enabled,false);s=apply(s,{action:'plugin_enable',plugin_id:'notes'});const win=s.plugins[0].window.id;const pane=leaves(s.monitors[3].layout)[0].id;
 s=apply(s,{action:'split_pane',window_id:win,pane_id:pane,kind:'terminal'});const terminal=leaves(s.monitors[3].layout)[1];
 s=apply(s,{action:'plugin_patch_config',plugin_id:'notes',patch:{message:'updated'}});const m=s.monitors.find(m=>m.id===win);assert.equal(m.name,'Personal notes');assert.equal(m.fontSize,12);assert.deepEqual(leaves(m.layout)[1],terminal);assert.match(leaves(m.layout)[0].url,/updated/);
 assert.throws(()=>apply(s,{action:'plugin_window',plugin_id:'notes',settings:{fontSize:-1}}));assert.throws(()=>apply(s,{action:'plugin_window',plugin_id:'notes',settings:{id:'hijack'}}));
});
