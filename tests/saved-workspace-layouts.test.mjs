import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {initial,monitor} from '../src/model.ts';
import {emptyPlacement} from '../src/docking-placement.ts';
import {captureLayout,compileSavedLayout} from '../src/saved-workspace-layouts-plan.ts';
import {compileDockingGrid} from '../src/saved-workspace-layouts-grid.ts';
import {parsePendingSavedLayout,retainSavedLayout} from '../src/saved-workspace-layouts-pending.ts';
import {createWorkspaceLayouts} from '../server/workspace-layouts.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {tempRoot,removeRoot} from './fixtures/sqlite-store-helpers.mjs';
const viewport={width:1200,height:800};
function setup(t){const root=tempRoot('orbit-saved-layout-'),store=new SqliteWorkspaceStore(root),workspace_id=randomUUID();t.after(()=>{store.close();removeRoot(root);});const state=initial();state.monitors.forEach((m,i)=>m.frame={x:i*200,y:20,width:400,height:300,z:i});
  store.commit(commandIdentity({action:'sync',workspace_id,base_revision:0,operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state,capability:randomUUID()})});
  const service=createWorkspaceLayouts({store,root,token:'owner',port:4317,reply:(res,status,data)=>Object.assign(res,{status,data})});
  const api=(action,fields={})=>service.dispatch({workspace_id,action,...fields});return {root,store,workspace_id,state,service,api};}
test('durable named presets retain identities/content and unrelated current state; atomic geometry/placement receipt',t=>{
  const f=setup(t),{store,workspace_id,state,api}=f;const ids=state.monitors.map(m=>m.id),placement=compileDockingGrid(emptyPlacement(),ids,ids,2);
  store.commit(commandIdentity({workspace_id,action:'placement_save',base_revision:1,operation_id:randomUUID(),intent:'Dock'},'owner'),{placement});
  const saved=api('capture',{name:'Compare',viewport,base_revision:2});
  const file=path.join(f.root,'saved-workspace-layouts',workspace_id+'.json');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.ok(!fs.readFileSync(file,'utf8').includes('orbit://welcome'));
  const reopened=createWorkspaceLayouts({store,root:f.root,token:'owner',port:4317,reply:()=>{}});assert.equal(reopened.dispatch({workspace_id,action:'list'}).layouts[0].id,saved.layout_id);
  const extra=monitor(4,'browser');extra.frame={x:111,y:222,width:400,height:300,z:8};
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:2,operation_id:randomUUID(),intent:'New edits'},'owner'),{apply:r=>{r.state.monitors[0].layout.pane.url='https://example.org/current';r.state.monitors[0].name='Current name';r.state.monitors[0].fontSize=22;r.state.monitors[0].frame.x=900;r.state.monitors.push(extra);r.state.sidebarHidden=true;return r.state;}});
  const preview=api('preview',{layout_id:saved.layout_id,viewport});assert.equal(store.read(workspace_id).revision,3);assert.deepEqual(preview.missing,[]);
  const payload={layout:preview.layout,viewport,replacements:{},base_revision:3,operation_id:randomUUID(),intent:'Apply preset'};
  const result=api('apply',payload);assert.equal(result.revision,4);assert.equal(result.placement_revision,2);assert.ok(result.checkpoint_id);
  const after=store.read(workspace_id);assert.equal(after.state.monitors[0].frame.x,0);assert.equal(after.state.monitors[0].layout.pane.url,'https://example.org/current');assert.equal(after.state.monitors[0].fontSize,22);assert.equal(after.state.monitors[0].name,'Current name');assert.equal(after.state.sidebarHidden,true);assert.deepEqual(after.state.monitors[3],extra);assert.deepEqual(after.placement,placement);
  api('delete',{layout_id:saved.layout_id});assert.equal(api('apply',payload).replayed,true);assert.equal(store.read(workspace_id).revision,4);
  assert.throws(()=>api('apply',{...payload,operation_id:randomUUID()}),{category:'REVISION_CONFLICT'});
  assert.throws(()=>api('apply',{...payload,intent:'Changed'}),{category:'IDEMPOTENCY_CONFLICT'});
});
test('missing IDs are surfaced, names never bind; explicit replacements and scaled frames',()=>{
  const state=initial();state.monitors[0].frame={x:900,y:600,width:400,height:300,z:1};const saved=captureLayout(state,emptyPlacement(),viewport),gone=state.monitors.shift(),replacement=monitor(8);replacement.name=gone.name;state.monitors.push(replacement);
  const first=compileSavedLayout({state},saved,{width:600,height:400});assert.deepEqual(first.missing,[gone.id]);assert.equal(first.bindings[gone.id],undefined);
  const mapped=compileSavedLayout({state},saved,{width:600,height:400},{[gone.id]:replacement.id});assert.deepEqual(mapped.missing,[]);assert.equal(mapped.state.monitors.find(m=>m.id===replacement.id).frame.width,280);
  assert.throws(()=>compileSavedLayout({state},saved,viewport,{[saved.windows[1].id]:replacement.id}));
});
test('Docking Compare/Grid compiles and commits frames + placement in exactly one revision',t=>{
  const {api,store,workspace_id,state}=setup(t),ids=state.monitors.slice(0,2).map(m=>m.id),before=store.diagnostics();
  const preview=api('arrange_preview',{window_ids:ids,mode:'compare',columns:2,viewport,base_revision:1});assert.equal(store.read(workspace_id).revision,1);
  const result=api('apply',{layout:preview.layout,viewport,replacements:{},base_revision:1,operation_id:randomUUID(),intent:'Atomic docking compare'});
  assert.equal(result.revision,2);assert.equal(result.placement_revision,2);assert.equal(store.diagnostics().receipts,before.receipts+1);assert.equal(store.checkpointList(workspace_id).length,1);
  assert.equal(store.read(workspace_id).state.monitors[0].frame.width,596);assert.equal(store.read(workspace_id).placement.layout.direction,'horizontal');assert.equal(store.read(workspace_id).state.monitors[2].frame.x,400);
});
test('request strictness, owner origin/token, catalog bounds, rename/delete and recovery receipt fence',async t=>{
  const {api,service,store,workspace_id,state}=setup(t);assert.throws(()=>api('list',{actor:'owner'}));
  const req=Readable.from([JSON.stringify({action:'list',workspace_id})]);req.method='POST';req.headers={host:'127.0.0.1:4317',origin:'https://attacker.example',authorization:'Bearer owner'};const res={};await service.handle(req,res);assert.equal(res.status,403);
  for(const authorization of ['owner','Basic owner','Bearerowner','Bearer wrong','Bearer owner']) {
    const request=Readable.from([JSON.stringify({action:'list',workspace_id})]);request.method='POST';request.headers={host:'127.0.0.1:4317',origin:'http://127.0.0.1:4317',authorization};const response={};await service.handle(request,response);assert.equal(response.status,authorization==='Bearer owner'?200:403);
  }
  const saved=api('capture',{name:'One',viewport,base_revision:1});api('rename',{layout_id:saved.layout_id,name:'Renamed'});assert.equal(api('list').layouts[0].name,'Renamed');
  const preview=api('preview',{layout_id:saved.layout_id,viewport}),payload={layout:preview.layout,viewport,replacements:{},base_revision:1,operation_id:randomUUID(),intent:'Test hold'};api('apply',payload);
  store.commit(commandIdentity({workspace_id,action:'recovery_policy',base_revision:store.read(workspace_id).revision,operation_id:randomUUID(),intent:'Hold'},'owner'),{recoveryPolicy:true});assert.throws(()=>api('apply',payload),{category:'RECOVERY_POLICY_CHANGED'});
  const revision=store.read(workspace_id).revision;
  for(let i=1;i<32;i++)api('capture',{name:'Layout '+i,viewport,base_revision:revision});assert.throws(()=>api('capture',{name:'Overflow',viewport,base_revision:revision}));assert.equal(api('list').layouts.length,32);
  api('delete',{layout_id:saved.layout_id});assert.equal(api('list').layouts.length,31);
});
test('exact pending payload survives storage roundtrip, corruption blocks retry',()=>{
  const command={action:'apply',workspace_id:randomUUID(),operation_id:randomUUID(),intent:'Retained apply',base_revision:3,layout:captureLayout(initial(),emptyPlacement(),viewport),viewport,replacements:{}};
  const values=new Map(),storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k)??null};retainSavedLayout(storage,command);assert.deepEqual(parsePendingSavedLayout([...values.values()][0],command.workspace_id),command);assert.throws(()=>parsePendingSavedLayout(JSON.stringify({...command,base_revision:-1}),command.workspace_id));assert.throws(()=>retainSavedLayout({setItem(){},getItem(){return null;}},command));
});
test('missing identity or invalid geometry refuses apply without checkpoint, receipt or partial placement',t=>{
  const {api,store,workspace_id,state}=setup(t),layout=captureLayout(state,emptyPlacement(),viewport),before=store.read(workspace_id),counts=store.diagnostics();
  const missing=structuredClone(layout);missing.windows[0].id='missing-window';if(missing.selected===layout.windows[0].id)missing.selected='missing-window';
  const invalid=structuredClone(layout);invalid.windows[0].geometry.frame.width=10;
  for(const candidate of [missing,invalid]) {
    assert.throws(()=>api('apply',{layout:candidate,viewport,replacements:{},base_revision:1,operation_id:randomUUID(),intent:'Refuse malformed preset'}));
    assert.deepEqual(store.read(workspace_id),before);assert.deepEqual(store.diagnostics(),counts);
  }
});
