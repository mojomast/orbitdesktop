import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {initial} from '../src/model.ts';
import {createWorkspaceService} from '../server/workspace.mjs';
import {JsonWorkspaceStore} from '../server/workspace-store.mjs';

async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-recovery-test-')), token=randomUUID(), id=randomUUID();
  let service;
  const server=http.createServer((req,res)=>service.handle(req,res,req.url==='/control',req.url==='/recovery'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  service=createWorkspaceService({token,port,root,devOrigins:[],reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  async function call(action,fields={},route='/recovery',key=token,site=origin) {
    const res=await fetch(origin+route,{method:'POST',headers:{Origin:site,Authorization:`Bearer ${key}`},body:JSON.stringify({workspace_id:id,action,...fields})});
    return {status:res.status,body:await res.json()};
  }
  assert.equal((await call('sync',{state:initial()},'/workspace')).status,200);
  return {root,id,token,call};
}
test('recovery read/history are authenticated and do not scan damaged bundles or acknowledge display',async t=>{
  const {root,id,call}=await fixture(t);
  const filename=path.join(root,'workspaces',`${id}.json`),before=fs.readFileSync(filename,'utf8');
  fs.rmSync(path.join(root,'apps'),{recursive:true}); // simulate broken optional asset store
  assert.equal((await call('read',{},'/recovery','bad')).status,403);
  assert.equal((await call('read',{},'/recovery',undefined,'https://foreign.invalid')).status,403);
  const result=await call('read',{observed_revision:999});
  assert.equal(result.status,200);assert.equal(result.body.app_versions,undefined);assert.equal(result.body.capability,undefined);
  assert.equal(fs.readFileSync(filename,'utf8'),before);
  assert.equal((await call('history')).status,200);
});
test('recovery rejects unrelated commands and restores as a new revision with checkpoint',async t=>{
  const {call}=await fixture(t);
  const old=(await call('read')).body;
  const checkpoint=await call('checkpoint',{label:'known good'},'/workspace');
  const changed=structuredClone(old.state);changed.sidebarHidden=true;
  assert.equal((await call('sync',{state:changed,base_revision:1},'/workspace')).status,200);
  assert.equal((await call('sync',{state:old.state,base_revision:2})).status,403);
  const args={checkpoint_id:checkpoint.body.checkpoint,base_revision:2,confirm:true};
  assert.equal((await call('restore',{...args,base_revision:1})).body.category,'REVISION_CONFLICT');
  assert.equal((await call('restore',{...args,confirm:false})).status,409);
  const result=await call('restore',args);
  assert.equal(result.status,200);assert.equal(result.body.revision,3);assert.deepEqual(result.body.state,old.state);
  assert.equal((await call('history')).body.checkpoints.length,2);
});
test('recovery disable removes registered app views only and preserves identity bindings and bundles',async t=>{
  const {root,call}=await fixture(t);
  const old=(await call('read')).body.state;
  const manifest={apiVersion:1,id:'bad-app',version:'1.0.0',title:'Broken app',entry:'/apps/bad-app/index.html'};
  fs.mkdirSync(path.join(root,'apps','bad-app'));fs.writeFileSync(path.join(root,'apps','bad-app','index.html'),'<script>throw Error("broken fixture")</script>');
  const operations=[{action:'plugin_install',manifest},{action:'plugin_enable',plugin_id:'bad-app'}];
  assert.equal((await call('plugins_apply',{base_revision:1,operations})).status,403);
  assert.equal((await call('plugins_apply',{base_revision:1,operations},'/workspace')).status,200);
  const disabled=await call('plugins_apply',{base_revision:2,operations:[{action:'plugin_disable_all'}]});
  assert.equal(disabled.status,200);assert.equal(disabled.body.state.plugins[0].enabled,false);
  assert.deepEqual(disabled.body.state.monitors,old.monitors);
  assert.deepEqual(disabled.body.state.plugins[0].manifest,manifest);
  assert.ok(fs.existsSync(path.join(root,'apps','bad-app','index.html')));
});
test('future-version records cannot be downgraded by a stale sync or restore',async t=>{
  const {root,id,call}=await fixture(t),store=new JsonWorkspaceStore(root),record=store.read(id);
  record.state.version=2;store.write(record);
  const result=await call('sync',{state:initial(),base_revision:1},'/workspace');
  assert.equal(result.status,409);assert.equal(result.body.category,'UPGRADE_REQUIRED');
  assert.equal(store.read(id).state.version,2);
});
test('JSON store preserves record metadata and isolates temporary filenames, without transactional claims',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-store-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new JsonWorkspaceStore(root),id=randomUUID(),record={id,state:initial(),revision:1,capability:'fixture-only',futureMetadata:{revoked:true}};
  store.write(record);store.write({...record,revision:2});
  assert.deepEqual(store.read(id),{...record,revision:2});
  assert.deepEqual(fs.readdirSync(path.join(root,'workspaces')),[`${id}.json`]);
  assert.equal(fs.statSync(store.filename(id)).mode&0o777,0o600);
  assert.throws(()=>store.read('../other'));
});
