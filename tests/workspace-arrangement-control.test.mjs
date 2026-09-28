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

const uuid=()=>randomUUID();

async function start(root,ownerToken,t){
  let service;
  const server=http.createServer((req,res)=>service.handle(req,res,req.url==='/control'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  service=createWorkspaceService({root,port,token:ownerToken,devOrigins:[],reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;await new Promise(resolve=>server.close(resolve));service.close();};
  t.after(close);
  const request=async(body,credential=ownerToken,route='/workspace')=>{
    const response=await fetch(origin+route,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  return {service,server,origin,request,close};
}

function seedProject(service,workspaceId,name,paneIndex){
  const records=new WorkbenchStore(service.store);
  const project=records.register(workspaceId,{root:`/private/${name}`,name,identity:`synthetic-${name}`});
  const pane=service.store.read(workspaceId).state.monitors[paneIndex].layout.pane.id;
  const resource=records.resource(project.id,'synthetic-locator',{kind:'terminal',pane_id:pane,secret:'private fixture data'});
  records.bind({workspace_id:workspaceId,project_id:project.id,resource_id:resource.id,pane_id:pane,base_revision:service.store.read(workspaceId).revision,role:'active_terminal'});
  return {project,pane,resource,binding:records.bindings(workspaceId,project.id)[0]};
}

test('HTTP arrangement controller enforces route/workspace authority and persists actor-scoped receipts across restart',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-arrangement-control-'));
  const ownerToken=uuid(),workspaceA=uuid(),workspaceB=uuid();
  let running=await start(root,ownerToken,t);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));

  for(const workspace_id of [workspaceA,workspaceB]){
    const created=await running.request({workspace_id,action:'sync',state:initial()});
    assert.equal(created.status,200);
  }
  const workspaceRecordA=running.service.store.read(workspaceA),workspaceRecordB=running.service.store.read(workspaceB);
  const projectA=seedProject(running.service,workspaceA,'project-a',2);
  const projectB=seedProject(running.service,workspaceB,'project-b',1);

  const control=(workspace_id,request,capability=workspaceRecordA.capability)=>running.request({workspace_id,action:'arrangement',request},capability,'/control');
  const owner=(workspace_id,request)=>running.request({workspace_id,action:'arrangement',request},ownerToken);
  assert.equal((await running.request({workspace_id:workspaceA,action:'describe'},'wrong-token')).status,403);
  assert.equal((await control(workspaceB,{action:'recipe_list',project_id:projectB.project.id},workspaceRecordA.capability)).status,403,'a workspace-A capability cannot select workspace B');
  assert.equal((await control(workspaceA,{action:'recipe_list',project_id:projectB.project.id})).status,403,'Workbench project IDs remain workspace-scoped');
  assert.equal((await running.request({workspace_id:workspaceA,action:'arrangement',actor:'workspace-controller:'+workspaceA,request:{action:'recipe_list',project_id:projectA.project.id}})).status,400);
  assert.equal((await control(workspaceA,{action:'recipe_list',project_id:projectA.project.id,actor:'owner'})).status,400,'nested actor override is rejected');
  assert.equal((await control(workspaceA,{action:'recipe_list',project_id:projectA.project.id,workspace_id:workspaceB})).status,400,'nested workspace override is rejected');

  const ownerDescribe=await running.request({workspace_id:workspaceA,action:'describe',project_id:projectA.project.id});
  assert.equal(ownerDescribe.status,200);
  assert.deepEqual(ownerDescribe.body.projects.map(item=>item.id),[projectA.project.id]);
  assert.deepEqual(ownerDescribe.body.bindings.map(({id,project_id,resource_id,pane_id,role,available})=>({id,project_id,resource_id,pane_id,role,available})),[
    {id:projectA.binding.id,project_id:projectA.project.id,resource_id:projectA.resource.id,pane_id:projectA.pane,role:'active_terminal',available:true},
  ]);
  const serialized=JSON.stringify(ownerDescribe.body);
  for(const hidden of [workspaceRecordA.capability,'/private/project-a','synthetic-locator','private fixture data'])assert.equal(serialized.includes(hidden),false);

  const list=async project_id=>control(workspaceA,{action:'recipe_list',project_id});
  const preview=async(project_id,recipe='project_focus')=>control(workspaceA,{action:'recipe_preview',project_id,recipe});

  const ownerPreview=await owner(workspaceA,{action:'recipe_preview',project_id:projectA.project.id,recipe:'project_focus'});
  assert.equal(ownerPreview.status,200);
  const missingKey=await control(workspaceA,{action:'recipe_apply',project_id:projectA.project.id,recipe:'project_focus',preview_id:ownerPreview.body.preview_id,preview_digest:ownerPreview.body.preview_digest});
  assert.equal(missingKey.status,400,'apply without op_id must fail contract validation');
  const operationId=uuid();
  const ownerRequest={action:'recipe_apply',project_id:projectA.project.id,recipe:'project_focus',preview_id:ownerPreview.body.preview_id,preview_digest:ownerPreview.body.preview_digest,op_id:operationId};
  const ownerApplied=await owner(workspaceA,ownerRequest);
  assert.equal(ownerApplied.status,200);assert.equal(ownerApplied.body.idempotent,false);
  const ownerReplay=await owner(workspaceA,ownerRequest);
  assert.equal(ownerReplay.status,200,JSON.stringify(ownerReplay.body));assert.equal(ownerReplay.body.idempotent,true);
  assert.deepEqual(ownerReplay.body.workspace,ownerApplied.body.workspace,'same-actor replay returns the exact committed workspace result');

  const changedPreview=await preview(projectA.project.id,'investigate');
  assert.equal(changedPreview.status,200);
  const changed=await owner(workspaceA,{action:'recipe_apply',project_id:projectA.project.id,recipe:'investigate',preview_id:changedPreview.body.preview_id,preview_digest:changedPreview.body.preview_digest,op_id:operationId});
  assert.equal(changed.status,409);assert.equal(changed.body.category,'REVISION_CONFLICT','changed payload under an existing key must not apply');

  // The same key in a different actor namespace is independent. The controller
  // commits against the SAME project after the owner's commit, so its current
  // preview must not collide with a project-wide key belonging to another actor.
  const controllerPreview=await preview(projectA.project.id);
  assert.equal(controllerPreview.status,200);
  const controllerRequest={action:'recipe_apply',project_id:projectA.project.id,recipe:'project_focus',preview_id:controllerPreview.body.preview_id,preview_digest:controllerPreview.body.preview_digest,op_id:operationId};
  const controllerApplied=await control(workspaceA,controllerRequest);
  assert.equal(controllerApplied.status,200,JSON.stringify(controllerApplied.body));assert.equal(controllerApplied.body.idempotent,false);
  const receipts=running.service.store.db.prepare('SELECT actor,request_hash,record_json FROM receipts WHERE workspace_id=? AND operation_id=? ORDER BY actor').all(workspaceA,operationId);
  assert.deepEqual(receipts.map(row=>row.actor),[`owner`,`workspace-controller:${workspaceA}`]);
  const controllerReplay=await control(workspaceA,controllerRequest);
  assert.equal(controllerReplay.status,200);assert.equal(controllerReplay.body.idempotent,true);
  assert.deepEqual(controllerReplay.body.workspace,controllerApplied.body.workspace);
  const ownerReplayAfterController=await owner(workspaceA,ownerRequest);
  assert.equal(ownerReplayAfterController.status,200);assert.equal(ownerReplayAfterController.body.idempotent,true);
  assert.deepEqual(ownerReplayAfterController.body.workspace,ownerApplied.body.workspace,'controller receipt must not replace owner receipt');

  const controllerWorkspaceToken=await running.request({workspace_id:workspaceA,action:'read'},workspaceRecordA.capability,'/control');
  assert.equal(controllerWorkspaceToken.status,200);
  await running.close();
  running=await start(root,ownerToken,t);
  const recovered=await running.request({workspace_id:workspaceA,action:'arrangement',request:{action:'proposal_list',project_id:projectA.project.id}},workspaceRecordA.capability,'/control');
  assert.equal(recovered.status,200);
  const stored=recovered.body.proposals.find(item=>item.id===ownerPreview.body.preview_id);
  assert.ok(stored,'committed proposal is retrievable from durable Workbench storage after service restart');
  assert.equal(stored.status,'committed');
  assert.equal(stored.committed_revision,ownerApplied.body.workspace.revision);
  assert.equal(stored.op_id,operationId);
  assert.equal(running.service.store.read(workspaceB).id,workspaceB,'unrelated workspace survives service restart');
  assert.equal(workspaceRecordB.capability,running.service.store.read(workspaceB).capability);
  // Keep the explicit recipe_list request helper exercised through the real route.
  assert.equal((await list(projectA.project.id)).status,200);
});
