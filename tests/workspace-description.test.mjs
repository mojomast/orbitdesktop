import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {initial} from '../src/model.ts';
import {createWorkspaceService} from '../server/workspace.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {contract,arrangementControlRequests} from '../contracts/workspace-v1.mjs';
import {featureCapabilities} from '../contracts/feature-capabilities.mjs';
import {observeFeatureReadiness} from '../server/feature-readiness.mjs';

test('description is authenticated, bounded layout metadata with contract-derived catalog and real bindings only',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-description-')),token=randomUUID(),id=randomUUID();
  let service;
  const server=http.createServer((req,res)=>service.handle(req,res,req.url==='/control'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  let configured=false,clock=1000;
  const capabilityDescription=audience=>featureCapabilities({audience,observation:observeFeatureReadiness({root,runtimeRoot:root,env:{},mcpConfigured:configured,now:()=>clock})});
  service=createWorkspaceService({root,port,token,devOrigins:[],capabilityDescription,reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));service.close();fs.rmSync(root,{recursive:true,force:true});});
  const request=async(body,credential=token,route='/workspace')=>{
    const response=await fetch(origin+route,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:id,...body})});
    return {status:response.status,body:await response.json()};
  };
  assert.equal((await request({action:'sync',state:initial()})).status,200);
  const records=new WorkbenchStore(service.store),project=records.register(id,{root:'/private/project',name:'Debug project',identity:'test'});
  const workspace=service.store.read(id),pane=workspace.state.monitors[0].layout.pane;
  const resource=records.resource(project.id,'private-locator',{kind:'terminal',pane_id:pane.id,secret:'never disclose'});
  records.bind({workspace_id:id,project_id:project.id,resource_id:resource.id,pane_id:pane.id,base_revision:workspace.revision,role:'active_terminal'});
  const before=service.store.read(id);
  assert.equal((await request({action:'describe'},'wrong')).status,403);
  assert.equal((await request({action:'describe',actor:'owner'})).status,400);
  for(const nested of [
    {action:'integrate_confirm',project_id:project.id},
    {action:'recipe_list',project_id:project.id,workspace_id:randomUUID()},
    {action:'recipe_list',project_id:project.id,actor:'owner'},
  ])assert.equal((await request({action:'arrangement',request:nested},before.capability,'/control')).status,400);
  const response=await request({action:'describe',catalog:true},before.capability,'/control');
  assert.equal(response.status,200);
  assert.equal(response.body.capabilities.observed_at,new Date(1000).toISOString());
  assert.ok(response.body.capabilities.features.every(f=>f.content.availability==='not_granted'));
  assert.equal(response.body.capabilities.features.find(f=>f.feature_id==='mcp-apps').readiness.state,'missing_prerequisite');
  configured=true;clock=2000;
  const ownerDescription=(await request({action:'describe'})).body.capabilities;
  assert.equal(ownerDescription.observed_at,new Date(2000).toISOString());
  assert.ok(ownerDescription.features.every(f=>f.content.availability==='owner_authenticated'));
  assert.equal(ownerDescription.features.find(f=>f.feature_id==='mcp-apps').readiness.state,'unknown');
  assert.deepEqual(response.body.catalog.operations,contract.operations);
  assert.deepEqual(response.body.catalog.$defs,contract.schema.$defs);
  assert.deepEqual(response.body.catalog.arrangements,arrangementControlRequests);
  assert.equal(response.body.bindings.length,1);
  assert.equal(response.body.bindings[0].role,'active_terminal');
  assert.equal(response.body.bindings[0].available,true);
  assert.equal(response.body.extension_compatibility.private_frame_data,false);
  const serialized=JSON.stringify(response.body);
  for(const secret of [before.capability,'/private/project','private-locator','never disclose'])assert.equal(serialized.includes(secret),false);
  assert.deepEqual(service.store.read(id),before,'description must not acknowledge a browser or mutate state');
  records.revoke(id,project.id,project.generation);
  assert.deepEqual((await request({action:'describe'})).body.projects,[]);
  assert.deepEqual((await request({action:'describe'})).body.bindings,[]);
  assert.notEqual((await request({action:'describe',project_id:project.id})).status,200);
});
