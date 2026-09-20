import {test} from 'node:test';import assert from 'node:assert/strict';
import {initial} from '../src/model.ts';import {applyOperation} from '../src/workspace-ops.ts';
const manifest={apiVersion:1,id:'notes',version:'1.0.0',title:'Notes',entry:'/apps/notes-v1/index.html'};
const op=(s,action,rest={})=>applyOperation(s,{action,plugin_id:'notes',...rest});
test('plugin install, enable, configure, update, disable and remove preserve core panes',()=>{
 const start=initial();let s=op(start,'plugin_install',{manifest});assert.equal(s.monitors.length,3);assert.equal(start.plugins,undefined);
 s=op(s,'plugin_enable');const window=s.plugins[0].window.id;assert.equal(s.monitors.length,4);
 s=op(s,'plugin_configure',{config:{message:'hello'}});assert.equal(s.monitors.length,4);assert.equal(s.plugins[0].window.id,window);assert.match(s.monitors[3].layout.pane.url,/hello/);
 s=op(s,'plugin_update',{manifest:{...manifest,version:'2.0.0',entry:'/apps/notes-v2/index.html'}});assert.match(s.monitors[3].layout.pane.url,/notes-v2/);
 s=op(s,'plugin_disable');assert.equal(s.monitors.length,3);s=op(s,'plugin_enable');assert.equal(s.monitors[3].id,window);
 s=op(s,'plugin_disable_all');assert.deepEqual(s.monitors,start.monitors);s=op(s,'plugin_remove');assert.equal(s.plugins.length,0);
});
test('plugin validation rejects unsupported permissions, code URLs, config and duplicates atomically',()=>{
 for(const m of [{...manifest,entry:'javascript:alert(1)'},{...manifest,entry:'/apps/../index.html'},{...manifest,permissions:['shell']},{...manifest,apiVersion:2}])assert.throws(()=>op(initial(),'plugin_install',{manifest:m}));
 const s=op(initial(),'plugin_install',{manifest});assert.throws(()=>op(s,'plugin_install',{manifest}));assert.throws(()=>op(s,'plugin_configure',{config:{nested:{x:1}}}));assert.equal(s.plugins[0].enabled,false);
});
