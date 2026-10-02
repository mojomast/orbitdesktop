import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import { initial, monitor, validate, leaves } from '../src/model.ts';
import { applyOperation } from '../src/workspace-ops.ts';
import { pluginSelector } from '../src/plugins.ts';
import { pluginUrl } from '../src/plugins.ts';

const manifest={apiVersion:1,id:'notes',title:'Notes',version:'1.0.0',entry:'/apps/notes-one/index.html'};
const op=(state,operation)=>applyOperation(state,operation);
function fixture(enabled=true){let s=op(initial(),{action:'plugin_install',manifest,config:{message:'original'}});if(enabled)s=op(s,{action:'plugin_enable',plugin_id:'notes'});return s;}
const duplicate=s=>op(s,{action:'plugin_duplicate',plugin_id:'notes'});

// Execute the pinned schema-11 implementation, rather than hand-forging stale
// URLs. The unchanged core factories supply real window/pane identities.
const archivedPlugins=execFileSync('git',['show','b404cf13e4a5a6aef197f7d12394648672061da2:src/plugins.ts'],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
const archivedJs=ts.transpile(archivedPlugins,{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}).replace(/^import .*\n/m,'').replaceAll('export function ','function ');
const schema11PluginOperation=new Function('monitor','leaves',archivedJs+'\nreturn pluginOperation;')(monitor,leaves);
function legacyFixture(history){
 let s=initial();
 const old=operation=>{schema11PluginOperation(s,operation);validate(s);};
 old({action:'plugin_install',manifest,config:{message:'original'}});
 old({action:'plugin_enable',plugin_id:'notes'});
 const window=s.plugins[0].window,app=leaves(window.layout)[0];
 s=op(s,{action:'split_pane',window_id:window.id,pane_id:app.id,kind:'terminal'});
 s=op(s,{action:'split_pane',window_id:window.id,pane_id:app.id,kind:'browser'});
 const unrelated=leaves(s.monitors.find(m=>m.id===window.id).layout).find(p=>p.kind==='browser'&&p.id!==app.id);
 s=op(s,{action:'set_pane',window_id:window.id,pane_id:unrelated.id,url:'https://unrelated.example/page'});
 old({action:'plugin_disable',plugin_id:'notes'});
 for(const operation of history)old({plugin_id:'notes',...operation});
 return s;
}

test('authentic schema-11 disabled configure/update histories retain identities, config and unrelated split panes',()=>{
 const histories=[
  [{action:'plugin_configure',config:{message:'saved while disabled',count:2}}],
  [{action:'plugin_update',manifest:{...manifest,version:'2.0.0',entry:'/apps/notes-two/index.html'}}],
  [{action:'plugin_patch_config',patch:{count:2}},{action:'plugin_update',manifest:{...manifest,version:'2.0.0',entry:'/apps/notes-two/index.html'}}],
 ];
 for(const history of histories){
  const s=legacyFixture(history),before=structuredClone(s),primary=s.plugins[0];
  const panes=leaves(primary.window.layout),app=panes.find(p=>p.url.startsWith('/apps/'));
  const otherPanes=panes.filter(p=>p.id!==app.id);
  assert.notEqual(app.url,pluginUrl(primary));
  for(const action of ['plugin_enable','plugin_configure','plugin_update','plugin_duplicate']){
   const config={...primary.config,message:'edited after upgrade'},updatedManifest={...primary.manifest,version:'3.0.0',entry:'/apps/notes-three/index.html'};
   let next=op(s,{action,plugin_id:'notes',...(action==='plugin_configure'?{config}:{}),...(action==='plugin_update'?{manifest:updatedManifest}:{})});
   assert.equal(next.plugins[0].window.id,primary.window.id);
   assert.deepEqual(leaves(next.plugins[0].window.layout).map(p=>p.id),panes.map(p=>p.id));
   assert.deepEqual(leaves(next.plugins[0].window.layout).filter(p=>p.id!==app.id),otherPanes);
   assert.deepEqual(next.plugins[0].config,action==='plugin_configure'?config:primary.config);
   if(action==='plugin_duplicate'){
    assert.deepEqual(next.plugins[0],primary);
    assert.deepEqual(next.plugins[1].config,primary.config);
    assert.notEqual(next.plugins[1].window.id,primary.window.id);
    assert.ok(next.plugins[1].instance_id);
    assert.equal(leaves(next.plugins[1].window.layout).length,1);
    assert.ok(!panes.some(p=>p.id===leaves(next.plugins[1].window.layout)[0].id));
   }else{
    if(action!=='plugin_enable')next=op(next,{action:'plugin_enable',plugin_id:'notes'});
    const live=next.monitors.find(m=>m.id===primary.window.id);
    assert.equal(leaves(live.layout).find(p=>p.id===app.id).url,pluginUrl(next.plugins[0]));
    assert.deepEqual(leaves(live.layout).filter(p=>p.id!==app.id),otherPanes);
   }
   assert.deepEqual(s,before,'operation must not mutate its input');
  }
 }
});

test('authentic disabled schema-11 backend changes retain a unique local surface without matching arbitrary HTTPS URLs',()=>{
 const connect=endpoint=>({action:'plugin_backend',endpoint,confirm_host_access:true});
 const update={action:'plugin_update',manifest:{...manifest,version:'2.0.0',entry:'/apps/notes-two/index.html'}};
 const histories=[
  [connect('https://old.example'),{action:'plugin_enable'},{action:'plugin_disable'},connect('https://new.example'),update],
  [{action:'plugin_configure',config:{message:'disabled'}},connect('https://old.example'),connect('https://new.example'),update],
 ];
 for(const history of histories)for(const disconnect of [false,true]){
  const s=legacyFixture([...history,...(disconnect?[connect(null)]:[])]),primary=s.plugins[0];
  const panes=leaves(primary.window.layout),app=panes.find(p=>p.url.startsWith('/apps/'));
  assert.ok(app,'old backend changes leave a historical local entry');
  for(const action of ['plugin_enable','plugin_configure','plugin_update','plugin_backend']){
   const next=op(s,{action,plugin_id:'notes',...(action==='plugin_configure'?{config:{...primary.config,count:3}}:{}),...(action==='plugin_update'?{manifest:{...primary.manifest,version:'3.0.0',entry:'/apps/notes-three/index.html'}}:{}),...(action==='plugin_backend'?{endpoint:'https://third.example',confirm_host_access:true}:{})});
   assert.equal(next.plugins[0].window.id,primary.window.id);
   assert.deepEqual(leaves(next.plugins[0].window.layout).map(p=>p.id),panes.map(p=>p.id));
   assert.deepEqual(leaves(next.plugins[0].window.layout).filter(p=>p.id!==app.id),panes.filter(p=>p.id!==app.id));
   assert.deepEqual(next.plugins[0].config,action==='plugin_configure'?{...primary.config,count:3}:primary.config);
   if(action==='plugin_enable')assert.equal(leaves(next.plugins[0].window.layout).find(p=>p.id===app.id).url,pluginUrl(next.plugins[0]));
  }
  if(disconnect){const next=duplicate(s);assert.deepEqual(next.plugins[0],primary);assert.deepEqual(next.plugins[1].config,primary.config);}
  else assert.throws(()=>duplicate(s),/Backend-connected/);
 }
});

test('legacy recovery rejects ambiguous local apps, malformed historical fragments and mismatched new instances',()=>{
 const s=legacyFixture([{action:'plugin_configure',config:{message:'disabled'}}]);
 const app=leaves(s.plugins[0].window.layout).find(p=>p.url.startsWith('/apps/'));
 for(const mutate of [
  x=>{leaves(x.plugins[0].window.layout).find(p=>p.kind==='browser'&&p.id!==app.id).url='/apps/another/index.html';},
  x=>{leaves(x.plugins[0].window.layout).find(p=>p.id===app.id).url='/apps/notes-one/index.html#orbit-config=invalid';},
  x=>{leaves(x.plugins[0].window.layout).find(p=>p.id===app.id).url='https://old.example/';x.plugins[0].backendEndpoint='https://new.example';},
 ]){
  const bad=structuredClone(s);mutate(bad);validate(bad);
  for(const action of ['plugin_enable','plugin_configure','plugin_update','plugin_duplicate'])assert.throws(()=>op(bad,{action,plugin_id:'notes',config:{},manifest}),/missing or ambiguous|Backend-connected/);
 }
 let instance=duplicate(fixture());instance=op(instance,{action:'plugin_disable',...pluginSelector(instance.plugins[1])});
 leaves(instance.plugins[1].window.layout)[0].url='/apps/notes-one/index.html#orbit-config='+encodeURIComponent(JSON.stringify({message:'historical'}));
 validate(instance);
 for(const action of ['plugin_enable','plugin_configure','plugin_duplicate'])assert.throws(()=>op(instance,{action,...pluginSelector(instance.plugins[1]),config:{}}),/missing or ambiguous/);
 assert.throws(()=>op(instance,{action:'plugin_update',plugin_id:'notes',manifest:{...manifest,version:'2.0.0'}}),/missing or ambiguous/);
});

test('an exact legacy surface takes precedence over unrelated split local apps and Welcome panes',()=>{
 for(const url of ['/apps/other/index.html','orbit://welcome']){
 let s=fixture();
 const primary=s.plugins[0],app=leaves(primary.window.layout)[0];
 s=op(s,{action:'split_pane',window_id:primary.window.id,pane_id:app.id,kind:'browser'});
 const live=s.monitors.find(m=>m.id===primary.window.id),other=leaves(live.layout).find(p=>p.id!==app.id);
 s=op(s,{action:'set_pane',window_id:primary.window.id,pane_id:other.id,url});
 const before=structuredClone(s),unrelated=leaves(s.monitors.find(m=>m.id===primary.window.id).layout).find(p=>p.id===other.id);
 for(const action of ['plugin_configure','plugin_update','plugin_duplicate']){
  const next=op(s,{action,plugin_id:'notes',...(action==='plugin_configure'?{config:{message:'changed'}}:{}),...(action==='plugin_update'?{manifest:{...manifest,version:'2.0.0',entry:'/apps/notes-two/index.html'}}:{})});
  const window=next.monitors.find(m=>m.id===primary.window.id);
  assert.deepEqual(leaves(window.layout).find(p=>p.id===other.id),unrelated);
  assert.deepEqual(leaves(window.layout).map(p=>p.id),leaves(live.layout).map(p=>p.id));
  assert.equal(window.id,primary.window.id);
  assert.equal(leaves(window.layout).find(p=>p.id===app.id).url,pluginUrl(next.plugins[0]));
  assert.deepEqual(next.plugins[0].config,action==='plugin_configure'?{message:'changed'}:primary.config);
  if(action==='plugin_duplicate'){
   assert.deepEqual(next.plugins[0],primary);
   assert.deepEqual(next.plugins[1].config,primary.config);
   assert.equal(leaves(next.plugins[1].window.layout).length,1);
  }
  assert.deepEqual(s,before);
 }
 }
});

test('a stale legacy app takes precedence over an unrelated Welcome pane',()=>{
 const s=legacyFixture([{action:'plugin_configure',config:{message:'disabled'}}]),primary=s.plugins[0];
 const app=leaves(primary.window.layout).find(p=>p.url.startsWith('/apps/'));
 const secondary=leaves(primary.window.layout).find(p=>p.kind==='browser'&&p.id!==app.id);
 secondary.url='orbit://welcome';validate(s);
 for(const action of ['plugin_enable','plugin_configure','plugin_update','plugin_duplicate']){
  const next=op(s,{action,plugin_id:'notes',config:primary.config,manifest:{...manifest,version:'2.0.0',entry:'/apps/notes-two/index.html'}});
  assert.deepEqual(leaves(next.plugins[0].window.layout).find(p=>p.id===secondary.id),secondary);
  if(action!=='plugin_duplicate')assert.equal(leaves(next.plugins[0].window.layout).find(p=>p.id===app.id).url,action==='plugin_enable'?pluginUrl(next.plugins[0]):next.plugins[0].manifest.entry);
 }
});

test('legacy checkpoints remain valid; duplication preserves original window and copies only public widget state',()=>{
 let s=fixture();const primary=s.plugins[0],window=s.monitors.find(m=>m.id===primary.window.id);
 s=op(s,{action:'split_pane',window_id:window.id,pane_id:leaves(window.layout)[0].id,kind:'terminal'});
 const before=structuredClone(s),copy=duplicate(s),p=copy.plugins[1];
 assert.deepEqual(copy.plugins[0],before.plugins[0]);
 assert.deepEqual(copy.monitors.slice(0,before.monitors.length),before.monitors);
 assert.equal(leaves(p.window.layout).length,1);assert.equal(leaves(p.window.layout)[0].kind,'browser');
 assert.notEqual(p.window.id,primary.window.id);assert.notEqual(leaves(p.window.layout)[0].id,leaves(window.layout)[0].id);
 assert.ok(p.instance_id);assert.deepEqual(p.config,primary.config);
 assert.deepEqual(validate(JSON.parse(JSON.stringify(before))),before);
 assert.deepEqual(validate(JSON.parse(JSON.stringify(copy))),copy);
});

test('per-instance configuration, window, enable and remove selectors never select a sibling',()=>{
 let s=duplicate(fixture()),copy=s.plugins[1],selector=pluginSelector(copy);
 s=op(s,{action:'plugin_patch_config',...selector,patch:{message:'copy'}});
 s=op(s,{action:'plugin_window',...selector,settings:{name:'Independent'}});
 assert.deepEqual(s.plugins[0].config,{message:'original'});assert.equal(s.plugins[0].window.name,'Notes');
 assert.deepEqual(s.plugins[1].config,{message:'copy'});assert.equal(s.plugins[1].window.name,'Independent');
 s=op(s,{action:'plugin_disable',instance_id:copy.instance_id});assert.equal(s.plugins[0].enabled,true);assert.equal(s.plugins[1].enabled,false);
 s=op(s,{action:'plugin_enable',...selector});assert.equal(s.plugins[1].enabled,true);
 s=op(s,{action:'plugin_remove',plugin_id:'notes'});assert.equal(s.plugins.length,1);assert.equal(s.plugins[0].instance_id,copy.instance_id);
 assert.throws(()=>op(s,{action:'plugin_disable',plugin_id:'notes'}),/Unknown or ambiguous/);
 assert.throws(()=>op(s,{action:'plugin_disable',instance_id:copy.instance_id,plugin_id:'other'}),/Unknown or ambiguous/);
 assert.throws(()=>op(s,{action:'plugin_disable',instance_id:'missing'}),/Unknown or ambiguous/);
});

test('definition updates include disabled siblings while retaining config and IDs',()=>{
 let s=duplicate(fixture());const identities=s.plugins.map(p=>({window:p.window.id,pane:leaves(p.window.layout)[0].id,config:p.config}));
 s=op(s,{action:'plugin_disable',...pluginSelector(s.plugins[1])});
 s=op(s,{action:'plugin_update',plugin_id:'notes',manifest:{...manifest,version:'2.0.0',entry:'/apps/notes-two/index.html'}});
 assert.deepEqual(s.plugins.map(p=>({window:p.window.id,pane:leaves(p.window.layout)[0].id,config:p.config})),identities);
 assert.ok(s.plugins.every(p=>p.manifest.version==='2.0.0'));
 s=op(s,{action:'plugin_enable',...pluginSelector(s.plugins[1])});assert.ok(leaves(s.plugins[1].window.layout)[0].url.startsWith('/apps/notes-two/'));
});

test('backend duplication and connection to multi-instance definitions fail closed',()=>{
 const s=op(fixture(),{action:'plugin_backend',plugin_id:'notes',endpoint:'https://service.example',confirm_host_access:true});
 assert.throws(()=>duplicate(s),/Backend-connected/);
 const multi=duplicate(fixture());assert.throws(()=>op(multi,{action:'plugin_backend',plugin_id:'notes',endpoint:'https://service.example',confirm_host_access:true}),/multiple instances/);
});

test('saved disabled window and instance ID collisions are rejected, including active non-plugin IDs',()=>{
 const s=duplicate(fixture(false));
 for(const mutate of [
  x=>x.plugins[1].instance_id=x.plugins[0].window.id,
  x=>x.plugins[1].instance_id=x.monitors[0].id,
  x=>x.plugins[1].window.layout.pane.id=x.plugins[0].window.layout.pane.id,
  x=>x.plugins[1].window.layout.pane.id=leaves(x.monitors[0].layout)[0].id,
  x=>delete x.plugins[1].instance_id,
  x=>x.plugins[1].manifest.version='2.0.0',
 ]){const bad=structuredClone(s);mutate(bad);assert.throws(()=>validate(bad));}
});

test('bounded duplicate count, ambiguous surfaces and close/re-enable saved settings',()=>{
 let s=fixture(false);for(let i=1;i<32;i++)s=duplicate(s);
 assert.equal(s.plugins.length,32);assert.throws(()=>duplicate(s),/Maximum 32/);
 s=fixture();const primary=s.plugins[0],win=s.monitors.find(m=>m.id===primary.window.id);
 s=op(s,{action:'update_window',window_id:win.id,name:'Edited live'});
 s=op(s,{action:'close_window',window_id:win.id});assert.equal(s.plugins[0].window.name,'Edited live');
 s=op(s,{action:'plugin_enable',plugin_id:'notes'});assert.equal(s.monitors.find(m=>m.id===win.id).name,'Edited live');
  s=op(s,{action:'split_pane',window_id:win.id,pane_id:leaves(win.layout)[0].id,kind:'browser'});
  const secondary=leaves(s.monitors.find(m=>m.id===win.id).layout).find(p=>p.id!==leaves(win.layout)[0].id);
  s=op(s,{action:'set_pane',window_id:win.id,pane_id:secondary.id,url:pluginUrl(s.plugins[0])});
  assert.throws(()=>duplicate(s),/ambiguous/);
});

test('schema defaults are effective public config; disabled required fields can be completed before activation',()=>{
 const configSchema={fields:[{key:'message',type:'string',required:true},{key:'count',type:'number',min:1,max:10,default:3}]};
 let s=op(initial(),{action:'plugin_install',manifest:{...manifest,configSchema}});
 assert.deepEqual(s.plugins[0].config,{});
 assert.throws(()=>op(s,{action:'plugin_enable',plugin_id:'notes'}),/Required/);
 assert.throws(()=>op(s,{action:'plugin_configure',plugin_id:'notes',config:{count:20}}),/at most/);
 s=op(s,{action:'plugin_patch_config',plugin_id:'notes',patch:{message:'complete'}});
 s=op(s,{action:'plugin_enable',plugin_id:'notes'});
 const effective=JSON.parse(decodeURIComponent(pluginUrl(s.plugins[0]).split('#orbit-config=')[1]));
 assert.deepEqual(effective,{count:3,message:'complete'});assert.deepEqual(s.plugins[0].config,{message:'complete'});
 assert.throws(()=>op(s,{action:'plugin_configure',plugin_id:'notes',config:{}}),/Required/);
 assert.throws(()=>op(s,{action:'plugin_patch_config',plugin_id:'notes',patch:{count:'3'}}),/number/);
 const forged=structuredClone(s);forged.plugins[0].enabled=false;delete forged.plugins[0].config.message;
 assert.throws(()=>validate(forged),/Required/,'active window is authoritative despite forged enabled=false');
});

test('authentic legacy disabled pane aliases remain readable, but activation cannot reuse a live pane identity',()=>{
 const s=fixture(false),legacy=s.plugins[0];
 legacy.window={...structuredClone(s.monitors[1]),id:legacy.window.id};
 const before=structuredClone(s);assert.deepEqual(validate(s),before);
 assert.throws(()=>op(s,{action:'plugin_enable',plugin_id:'notes'}),/duplicate identifier/);
 const copied=duplicate(s);assert.notEqual(leaves(copied.plugins[1].window.layout)[0].id,leaves(legacy.window.layout)[0].id);
 assert.deepEqual(copied.plugins[0],legacy);
});

test('schema definition updates validate all sibling configs atomically and update only effective defaults',()=>{
 let s=duplicate(fixture());s=op(s,{action:'plugin_patch_config',...pluginSelector(s.plugins[1]),patch:{count:9}});
 const before=structuredClone(s);
 assert.throws(()=>op(s,{action:'plugin_update',plugin_id:'notes',manifest:{...manifest,configSchema:{fields:[{key:'count',type:'number',max:5}]}}}),/at most/);
 assert.deepEqual(s,before);
 s=op(s,{action:'plugin_update',plugin_id:'notes',manifest:{...manifest,configSchema:{fields:[{key:'count',type:'number',max:10,default:2}]}}});
 assert.deepEqual(s.plugins.map(p=>p.config),before.plugins.map(p=>p.config));
 assert.deepEqual(s.plugins.map(p=>JSON.parse(decodeURIComponent(pluginUrl(p).split('#orbit-config=')[1])).count),[2,9]);
});
