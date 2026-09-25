import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {initial} from '../src/model.ts';
import {createWorkspaceService} from '../server/workspace.mjs';
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-bundle-workspace-')),id=randomUUID(),token=randomUUID();let service;
  const server=http.createServer((req,res)=>req.url.startsWith('/apps/')?service.serveApp(req,res,new URL(req.url,'http://localhost').pathname):service.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  service=createWorkspaceService({root,port,token,devOrigins:[],reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));service.close();fs.rmSync(root,{recursive:true,force:true});});
  const request=async fields=>{const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:id,...fields})});return {status:r.status,body:await r.json()};};
  assert.equal((await request({action:'sync',state:initial()})).status,200);
  const publish=(text,version='1.0.0')=>{
    const source=fs.mkdtempSync(path.join(root,'source-'));fs.writeFileSync(path.join(source,'index.html'),text);
    return JSON.parse(execFileSync('python3',['scripts/plugin_publish.py',source,'--id','fixture','--version',version,'--title','Fixture','--runtime',root],{encoding:'utf8'}));
  };
  return {root,id,service,origin,request,publish};
}
test('publisher registration, exact-byte serving, checkpoint retention and missing-bundle restore gate',async t=>{
  const {root,id,service,origin,request,publish}=await fixture(t);
  const old=publish('<h1>old fixture</h1>'),next=publish('<h1>new fixture</h1>','2.0.0');
  const oldSlug=old.entry.split('/')[2];
  const installed=await request({action:'plugins_apply',base_revision:1,operations:[{action:'plugin_install',manifest:old},{action:'plugin_enable',plugin_id:'fixture'}]});assert.equal(installed.status,200);
  const saved=await request({action:'checkpoint',label:'Original pinned fixture'});assert.equal(saved.status,200);
  const updated=await request({action:'plugins_apply',base_revision:2,operations:[{action:'plugin_update',plugin_id:'fixture',manifest:next}]});assert.equal(updated.status,200);
  const plan=service.store.bundles.cleanupPlan();assert.equal(plan.dry_run,true);assert.ok(plan.retained.some(entry=>entry.slug===oldSlug));assert.ok(!plan.candidates.some(entry=>entry.slug===oldSlug));
  const restored=await request({action:'restore',base_revision:3,checkpoint_id:saved.body.checkpoint,confirm:true});assert.equal(restored.status,200);assert.equal(restored.body.state.plugins[0].manifest.entry,old.entry);
  assert.equal(await (await fetch(origin+old.entry)).text(),'<h1>old fixture</h1>');
  fs.writeFileSync(path.join(root,'apps',oldSlug,'index.html'),'<h1>bad fixture</h1>');
  assert.equal((await fetch(origin+old.entry)).status,404,'Changed bytes never served under a verified hash URL');
  service.store.bundles.refresh();
  const disabled=await request({action:'plugins_apply',base_revision:4,operations:[{action:'plugin_disable',plugin_id:'fixture'}]});assert.equal(disabled.status,200,'Broken bundle must not prevent disable');
  const rejected=await request({action:'restore',base_revision:5,checkpoint_id:saved.body.checkpoint,confirm:true});assert.equal(rejected.status,409);assert.equal(rejected.body.category,'BUNDLE_UNAVAILABLE');assert.equal(service.read(id).revision,5);
  fs.rmSync(path.join(root,'apps',oldSlug),{recursive:true});service.store.bundles.refresh();
  assert.equal(service.store.bundles.list().find(bundle=>bundle.slug===oldSlug).status,'missing');
  assert.ok(service.store.bundles.cleanupPlan().retained.some(entry=>entry.slug===oldSlug));
});
test('ordinary workspace reads use the bundle index without scanning app directories',async t=>{
  const {service,request,publish}=await fixture(t);const manifest=publish('indexed fixture');
  const original=fs.readdirSync;fs.readdirSync=()=>{throw Error('Unexpected directory traversal');};
  try {
    const result=await request({action:'read'});assert.equal(result.status,200);assert.equal(typeof result.body.app_versions[manifest.entry.split('/')[2]],'number');
    assert.equal(typeof service.store.bundles.versions()[manifest.entry.split('/')[2]],'number');
  } finally {fs.readdirSync=original;}
});
