import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initial, leaves } from '../src/model.ts';
import { applyOperation } from '../src/workspace-ops.ts';
import { createWorkspaceService } from '../server/workspace.mjs';
const token = 'workspace-test-secret'.repeat(3);
async function setup(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-workspace-'));
 let service;
 const server=http.createServer((req,res)=>req.url.startsWith('/apps/')?service.serveApp(req,res,req.url):service.handle(req,res,req.url==='/control'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port,origin=`http://127.0.0.1:${port}`;
 service=createWorkspaceService({token,port,devOrigins:[],root,reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
 t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
 const id=randomUUID();
 async function req(body,control=false,key=token,originHeader=origin) {
  const r=await fetch(origin+(control?'/control':'/workspace'),{method:'POST',headers:{Origin:originHeader,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:id,...body})});return {status:r.status,body:await r.json()};
 }
 return {root,origin,id,req,service};
}
test('checkpoints restore layout, reject stale writes, and keep a before-restore snapshot',async t=>{
 const {root,id,req}=await setup(t);await req({action:'sync',state:initial()});
 const record=JSON.parse(fs.readFileSync(path.join(root,'workspaces',id+'.json'),'utf8'));
 await req({action:'apply',base_revision:1,operations:[{action:'sidebar',hidden:true}]},true,record.capability);
 const history=await req({action:'history'});assert.equal(history.body.checkpoints.length,1);
 const checkpoint_id=history.body.checkpoints[0].id;
 assert.equal((await req({action:'restore',checkpoint_id,base_revision:1,confirm:true})).status,409);
 assert.equal((await req({action:'restore',checkpoint_id,base_revision:2})).status,409);
 const result=await req({action:'restore',checkpoint_id,base_revision:2,confirm:true});assert.equal(result.status,200);assert.notEqual(result.body.state.sidebarHidden,true);assert.equal(result.body.revision,3);
 assert.equal((await req({action:'history'})).body.checkpoints.length,2);
 assert.equal((await req({action:'history'},false,'bad')).status,403);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'workspaces',id+'.json'),'utf8')).revision,3);
});
test('plugin browser mutations require current revision and checkpoint before commit',async t=>{
 const {req}=await setup(t);await req({action:'sync',state:initial()});
 const operations=[{action:'plugin_install',manifest:{apiVersion:1,id:'notes',title:'Notes',version:'1.0.0',entry:'/apps/notes/index.html'}},{action:'plugin_enable',plugin_id:'notes'}];
 assert.equal((await req({action:'plugins_apply',base_revision:0,operations})).status,409);
 assert.equal((await req({action:'plugins_apply',base_revision:1,operations},false,'bad')).status,403);
 assert.equal((await req({action:'plugins_apply',base_revision:1,operations:[...operations,{action:'plugin_enable',plugin_id:'missing'}]})).status,400);
 assert.equal((await req({action:'history'})).body.checkpoints.length,0);
 const ok=await req({action:'plugins_apply',base_revision:1,operations});assert.equal(ok.status,200);assert.equal(ok.body.state.plugins[0].enabled,true);
 const history=(await req({action:'history'})).body;assert.equal(history.checkpoints.length,1);
 const restored=await req({action:'restore',checkpoint_id:history.checkpoints[0].id,base_revision:2,confirm:true});assert.equal(restored.status,200);assert.equal(restored.body.state.plugins,undefined);
});
test('appearance operations are checkpointable and reject CSS or remote URL injection',()=>{
 const state=initial();const next=applyOperation(state,{action:'set_appearance',appearance:{background:'#123456',wallpaper:'/neon-horizon-v1.svg'}});
 assert.deepEqual(next.appearance,{background:'#123456',wallpaper:'/neon-horizon-v1.svg'});assert.equal(state.appearance,undefined);
 for(const appearance of [{background:'red;display:none'},{wallpaper:'https://evil.test/x.png'},{wallpaper:'//evil/x.png'},{css:'x'}])assert.throws(()=>applyOperation(state,{action:'set_appearance',appearance}));
});
test('workspace operations validate geometry and support targeted changes without mutating input',()=>{
 const s=initial(),id=s.monitors[0].id;
 const next=applyOperation(s,{action:'update_window',window_id:id,name:'Host Workshop',frame:{x:10,y:20,width:700,height:450,z:5}});
 assert.equal(next.monitors[0].name,'Host Workshop');assert.notEqual(s.monitors[0].name,'Host Workshop');
 assert.throws(()=>applyOperation(s,{action:'update_window',window_id:id,frame:{x:-10,y:0,width:2,height:2,z:1}}));
 assert.equal(applyOperation(s,{action:'sidebar',hidden:true}).sidebarHidden,true);
 assert.equal(applyOperation(s,{action:'set_view',view:'windows'}).view,'windows');
 const split=applyOperation(s,{action:'split_pane',window_id:id,pane_id:leaves(s.monitors[0].layout)[0].id,kind:'browser'});
 assert.equal(leaves(split.monitors[0].layout).length,2);
});
test('large spatial windows and small text survive validation while unsafe numbers fail',()=>{
 const s=initial(),window_id=s.monitors[0].id;
 const next=applyOperation(s,{action:'update_window',window_id,diagonal:1200,fontSize:6});
 assert.equal(next.monitors[0].diagonal,1200); assert.equal(next.monitors[0].fontSize,6);
 for(const diagonal of [NaN,Infinity,-1]) assert.throws(()=>applyOperation(s,{action:'update_window',window_id,diagonal}));
 assert.throws(()=>applyOperation(s,{action:'update_window',window_id,fontSize:5}));
});
test('workspace browser sync requires authentication and exact origin',async t=>{
 const {req}=await setup(t);
 assert.equal((await req({action:'sync',state:initial()},false,'wrong')).status,403);
 assert.equal((await req({action:'sync',state:initial()},false,token,'https://evil.example')).status,403);
 assert.equal((await req({action:'sync',state:initial()})).status,200);
});
test('capabilities are private, workspace-scoped, and revision conflicts reject stale writes',async t=>{
 const {root,id,req}=await setup(t);
 const first=await req({action:'sync',state:initial()});assert.equal(first.body.revision,1);assert.equal(first.body.capability,undefined);
 const record=JSON.parse(fs.readFileSync(path.join(root,'workspaces',id+'.json'),'utf8'));
 assert.equal(fs.statSync(path.join(root,'workspaces',id+'.json')).mode & 0o777,0o600);
 assert.equal((await req({action:'read'},true)).status,403);
 const changed=await req({action:'apply',base_revision:1,operations:[{action:'sidebar',hidden:true}]},true,record.capability);
 assert.equal(changed.body.revision,2);assert.equal(changed.body.state.sidebarHidden,true);
 assert.equal((await req({action:'apply',base_revision:1,operations:[{action:'sidebar',hidden:false}]},true,record.capability)).status,409);
 assert.equal((await req({action:'sync',base_revision:1,state:initial()})).status,409);
 const ack=await req({action:'read',observed_revision:2});assert.equal(ack.body.observed_revision,2);
 assert.equal((await req({action:'read',workspace_id:randomUUID()},true,record.capability)).status,404);
});
test('workspace polling reports changed app assets without a layout revision',async t=>{
 const {root,req}=await setup(t);
 const app=path.join(root,'apps','live-test');fs.mkdirSync(app);const file=path.join(app,'index.html');fs.writeFileSync(file,'before');
 const first=await req({action:'sync',state:initial()});
 fs.writeFileSync(file,'after');fs.utimesSync(file,new Date(),new Date(Date.now()+2000));
 const second=await req({action:'read'});
 assert.equal(second.body.revision,first.body.revision);
 assert.notEqual(second.body.app_versions['live-test'],first.body.app_versions['live-test']);
});
test('operation batches are atomic when a later operation is invalid',async t=>{
 const {root,id,req}=await setup(t);await req({action:'sync',state:initial()});
 const cap=JSON.parse(fs.readFileSync(path.join(root,'workspaces',id+'.json'))).capability;
 assert.equal((await req({action:'apply',base_revision:1,operations:[{action:'sidebar',hidden:true},{action:'set_view',view:'INVALID'}]},true,cap)).status,400);
 const state=await req({action:'read'});assert.equal(state.body.revision,1);assert.notEqual(state.body.state.sidebarHidden,true);
});
test('app preview is CSP-sandboxed, supports modules, and blocks hidden files and symlink escapes',async t=>{
 const {root,origin}=await setup(t);const app=path.join(root,'apps','demo');fs.mkdirSync(app);fs.writeFileSync(path.join(app,'index.html'),'<h1>Demo</h1>');fs.writeFileSync(path.join(app,'main.js'),'export const x=1;');fs.writeFileSync(path.join(app,'.env'),'secret');fs.symlinkSync('/etc/passwd',path.join(app,'leak.txt'));
 const r=await fetch(origin+'/apps/demo/');assert.equal(r.status,200);assert.ok(r.headers.get('content-security-policy').includes('sandbox allow-scripts'));assert.ok(!r.headers.get('content-security-policy').includes('allow-same-origin'));
 const module=await fetch(origin+'/apps/demo/main.js');assert.equal(module.headers.get('access-control-allow-origin'),'*');
 for(const url of ['/apps/demo/.env','/apps/demo/leak.txt','/apps/demo/%2e%2e%2f%2e%2e%2fworkspaces/test.json'])assert.equal((await fetch(origin+url)).status,404);
});
