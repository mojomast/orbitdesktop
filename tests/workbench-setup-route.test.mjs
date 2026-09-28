import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {initial} from '../src/model.ts';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchSetup} from '../server/workbench-setup.mjs';
import {createWorkspaceService} from '../server/workspace.mjs';
import {workbenchOwnerRoute} from '../server/workbench-owner-route.mjs';

const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};

async function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-setup-route-');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime'));
  const records=new WorkbenchStore(store),data=new WorkbenchData(store);
  const ownerToken=randomUUID(),workspace_id=randomUUID(),layout=initial();
  const paneA=layout.monitors[0].layout.pane.id,paneB=layout.monitors[1].layout.pane.id;
  const bindings=new Map([[paneA,{trusted_host:true,sandbox:false,profile_id:'owner-profile',session_id:'owner-session-a',config_generation:1,binding_revision:1}]]);
  const hermes={async readBinding({pane_id}){return bindings.get(pane_id)??null;}};
  const setup=createWorkbenchSetup({store,records,data,hermes,execution:{setupStep(){throw Error('unexpected setup step');}},native:{dispatch(){throw Error('unexpected native call');}},gate:{busy(){return false;}}});
  let service,setupRoute;
  const ownerCalls=[];
  const server=http.createServer((req,res)=>req.url==='/api/workbench/setup'?setupRoute(req,res):service.handle(req,res,req.url==='/control'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  setupRoute=workbenchOwnerRoute({token:ownerToken,port,devOrigins:[],reply,dispatch:body=>{ownerCalls.push(body);return setup.dispatch(body);}});
  service=createWorkspaceService({store,root:store.root,token:ownerToken,port,devOrigins:[],reply,workbenchSetup:setup});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));service.close();fs.rmSync(root,{recursive:true,force:true});});
  async function request(route,body,credential=ownerToken,headers={}){
    const response=await fetch(origin+route,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${credential}`,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  assert.equal((await request('/workspace',{workspace_id,action:'sync',state:layout})).status,200);
  const capability=store.read(workspace_id).capability;
  const projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'example.test.mjs'),"import test from 'node:test'; test('example',()=>{});\n");
  const opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Fixture',identity:opened.identity});opened.close();
  return {root,store,records,setup,request,ownerCalls,ownerToken,capability,workspace_id,paneA,paneB,bindings,project};
}

test('owner setup route refuses workspace capabilities before dispatch',async t=>{
  const f=await fixture(t);
  const body={workspace_id:f.workspace_id,pane_id:f.paneA,expected_binding_revision:1,action:'state'};
  assert.equal((await f.request('/api/workbench/setup',body,f.capability)).status,403);
  assert.equal((await f.request('/api/workbench/setup',body,f.ownerToken,{Origin:'https://untrusted.example'})).status,403);
  assert.equal(f.ownerCalls.length,0,'neither a capability nor an untrusted origin may call dispatch');
  assert.equal((await f.request('/api/workbench/setup',body,f.ownerToken)).status,200);
  assert.deepEqual(f.ownerCalls,[body]);
});

test('real controller proposal cannot forward owner verbs or identity and does not enter layout or events',async t=>{
  const f=await fixture(t),w=f.workspace_id;
  const before=f.store.read(w),eventsBefore=f.store.eventsAfter(0);
  const request={op_id:randomUUID(),goal:'Make dashboard responsive',title:'Responsive dashboard',acceptance_statement:'Works at narrow widths'};
  for(const poison of [{action:'prepare'},{pane_id:f.paneA},{profile_id:'owner-profile'},{session_id:'owner-session-a'},{actor:'owner'},{workspace_id:randomUUID()},{preview_id:randomUUID()},{grant_id:randomUUID()}]){
    const rejected=await f.request('/control',{workspace_id:w,action:'workbench_setup',request:{...request,...poison}},f.capability);
    assert.equal(rejected.status,400,JSON.stringify(poison));
  }
  const proposed=await f.request('/control',{workspace_id:w,action:'workbench_setup',request},f.capability);
  assert.equal(proposed.status,200,JSON.stringify(proposed.body));
  assert.ok(proposed.body.id);
  const after=f.store.read(w);
  assert.deepEqual(after.state,before.state);
  assert.equal(after.revision,before.revision);
  assert.deepEqual(f.store.eventsAfter(0),eventsBefore);
  assert.equal(JSON.stringify(after).includes(request.goal),false);
  assert.equal(JSON.stringify(f.store.eventsAfter(0)).includes(request.goal),false);
  const owner=await f.request('/api/workbench/setup',{workspace_id:w,pane_id:f.paneA,expected_binding_revision:1,action:'state'});
  assert.equal(owner.status,200);
  assert.equal(owner.body.suggestions[0].goal,request.goal);
});

test('owner state requires a live trusted pane binding and draft access stays binding-scoped',async t=>{
  const f=await fixture(t),w=f.workspace_id;
  const state=pane_id=>f.request('/api/workbench/setup',{workspace_id:w,pane_id,expected_binding_revision:1,action:'state'});
  const absent=await state(randomUUID());
  assert.equal(absent.status,409);
  assert.equal(absent.body.code,'stale_resource');
  const drafted=await f.request('/api/workbench/setup',{workspace_id:w,pane_id:f.paneA,expected_binding_revision:1,action:'draft',op_id:randomUUID(),project_id:f.project.id,goal:'Make dashboard responsive'});
  assert.equal(drafted.status,200,JSON.stringify(drafted.body));
  const paneB=f.paneB;
  f.bindings.set(paneB,{trusted_host:true,sandbox:false,profile_id:'owner-profile',session_id:'owner-session-b',config_generation:1,binding_revision:1});
  const other=await state(paneB);
  assert.equal(other.status,200,JSON.stringify(other.body));
  assert.deepEqual(other.body.drafts,[]);
  const forbidden=await f.request('/api/workbench/setup',{workspace_id:w,pane_id:paneB,expected_binding_revision:1,action:'preview',draft_id:drafted.body.draft.id,op_id:randomUUID()});
  assert.equal(forbidden.status,409);
  assert.equal(forbidden.body.code,'stale_resource');
  f.bindings.set(f.paneA,{...f.bindings.get(f.paneA),sandbox:true});
  assert.equal((await state(f.paneA)).status,409);
});
