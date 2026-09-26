import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchWorkflow,workflowSchema} from '../server/workbench-workflow.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';
import {Readable} from 'node:stream';
import {createWorkspaceService} from '../server/workspace.mjs';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-workflow-'),projectRoot=path.join(root,'source');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum = (a,b) => a - b;\n');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Workflow fixture',identity:opened.identity});opened.close();
  const execution=createWorkbenchExecution({store,records,data}),workflow=createWorkbenchWorkflow({store,records,data,execution});
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const call=(action,fields={})=>execution.dispatch({action,workspace_id,project_id:project.id,...fields});
  const flow=(action,fields={})=>workflow.dispatch({action,workspace_id,project_id:project.id,...fields});
  return {root,projectRoot,store,workspace_id,project,records,data,call,flow};
}
async function ownerSavePlacement(f,placement){
  const port=4317,token='fixture-owner-token',service=createWorkspaceService({token,port,root:path.join(f.root,'workspace-service'),store:f.store,reply:(res,status,data)=>{res.writeHead(status);res.end(JSON.stringify(data));}});
  const request={workspace_id:f.workspace_id,action:'placement_save',base_revision:f.store.read(f.workspace_id).revision,placement,operation_id:randomUUID(),intent:'Preserve an existing owner floating window during Review'};
  const req=Readable.from([Buffer.from(JSON.stringify(request))]);req.method='POST';req.url='/api/workspace';req.headers={host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`,authorization:`Bearer ${token}`};
  const response=await new Promise((resolve,reject)=>{const res={writeHead(status){this.status=status;},end(bytes){try{resolve({status:this.status,body:JSON.parse(bytes)});}catch(error){reject(error);}}};service.handle(req,res).catch(reject);});
  assert.equal(response.status,200);return response.body;
}
const git=(folder,...args)=>execFileSync('/usr/bin/git',['-C',folder,...args],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:folder,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();

test('real approved candidate creates a separate private two-commit Git branch, with durable retry receipt',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.projectRoot,'.gitignore'),'math.js\n');fs.writeFileSync(path.join(f.projectRoot,'.gitattributes'),'*.js -diff\n');
  assert.deepEqual(workflowSchema.oneOf.map(item=>item.properties.action.const).sort(),[
    'integration_preview','integrate_confirm','integration_list','retention_inventory','retention_plan','recipe_preview','recipe_apply',
    'patch_preview','patch_export','private_patch_get','patch_list','patch_finalize_retry','patch_check_cancel','patch_acknowledge_unknown',
  ].sort());
  const {task}=await f.call('task_create',{title:'Repair sum',acceptance_statement:'sum returns arithmetic addition',check_definition_id:'host-regression',profile_id:'default',session_id:'fixture'});
  const issued=await f.call('candidate_preview',{task_id:task.id});
  const {candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:issued.preview_id,preview_digest:issued.preview.digest});
  const file=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:file.file.hash,content:'export const sum = (a,b) => a + b;\n'});
  const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  const run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  assert.equal(run.evidence.verdict,'pass');
  const current=await f.call('candidate_get',{candidate_id:candidate.id});
  const {review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const selection={candidate_id:candidate.id,review_id:review.id};
  const preview=await f.flow('integration_preview',selection);
  await assert.rejects(f.flow('integrate_confirm',{...selection,preview_id:randomUUID(),preview_digest:preview.preview_digest,op_id:randomUUID()}),{code:'expired'});
  const op_id=randomUUID();
  const result=await f.flow('integrate_confirm',{...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});
  const artifact=result.integration.artifact_path;
  assert.equal(result.integration.status,'integrated');
  assert.ok(artifact.startsWith(path.join(f.root,'runtime','workbench-integration')+'/'));
  assert.match(git(artifact,'branch','--show-current'),/^comet\/integration-/);
  assert.equal(git(artifact,'rev-list','--count','HEAD'),'2');
  assert.match(git(artifact,'show',`${result.integration.base_commit}:math.js`),/a - b/);
  assert.match(git(artifact,'show',`${result.integration.candidate_commit}:math.js`),/a \+ b/);
  assert.equal(git(artifact,'show',`${result.integration.base_commit}:.gitignore`),'math.js');
  assert.equal(git(artifact,'show',`${result.integration.candidate_commit}:.gitattributes`),'*.js -diff');
  assert.deepEqual(git(artifact,'ls-tree','-r','--name-only',result.integration.candidate_commit).split('\n').sort(),['.gitattributes','.gitignore','math.js'].sort());
  assert.match(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),/a - b/);
  assert.equal(fs.existsSync(path.join(f.projectRoot,'.git')),false);
  const retry=await f.flow('integrate_confirm',{...selection,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});
  assert.equal(retry.idempotent,true);assert.equal(retry.integration.id,result.integration.id);
  const inventory=await f.flow('retention_plan');assert.deepEqual(inventory.deletions,[]);assert.equal(inventory.counts.integrations,1);
  await assert.rejects(f.flow('integration_preview',selection),{code:'stale_resource'});
});

test('a branch change at the same HEAD after review requires fresh review before integration',async t=>{
  const f=fixture(t);git(f.projectRoot,'init');git(f.projectRoot,'add','.');git(f.projectRoot,'commit','-m','fixture base');
  const {task}=await f.call('task_create',{title:'Check branch',acceptance_statement:'sum adds',check_definition_id:'host-regression',profile_id:'default',session_id:'fixture'});
  const p=await f.call('candidate_preview',{task_id:task.id});const {candidate}=await f.call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});
  const read=await f.call('candidate_read',{candidate_id:candidate.id,path:'math.js'});await f.call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:read.file.hash,content:'export const sum=(a,b)=>a+b;\n'});
  const check=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'}),run=await f.call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
  const current=await f.call('candidate_get',{candidate_id:candidate.id});const {review}=await f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  assert.match(review.source_repository.head_reference,/^ref: refs\/heads\//);
  git(f.projectRoot,'checkout','-b','other-reviewed-target');assert.equal(git(f.projectRoot,'rev-parse','HEAD'),review.source_repository.head);
  await assert.rejects(f.flow('integration_preview',{candidate_id:candidate.id,review_id:review.id}),{code:'stale_resource'});
  const next=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  const reviewing=f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:current.review_identity});
  const fenced=assert.rejects(reviewing,error=>['stale_resource','busy'].includes(error.code));
  await f.call('check_run',{candidate_id:candidate.id,preview_id:next.preview_id,preview_digest:next.preview.spec_digest,op_id:randomUUID()});
  await fenced;
});

test('source drift and strict unknown fields refuse integration without touching original',async t=>{
  const f=fixture(t);
  await assert.rejects(f.flow('retention_inventory',{root:'/tmp/elsewhere'}),{code:'invalid_request'});
  const inventory=await f.flow('retention_inventory');assert.equal(inventory.counts.integrations,0);
});

test('project focus preserves pane identities and return requires an unchanged workspace revision',async t=>{
  const f=fixture(t),before=f.store.read(f.workspace_id);
  const pane=before.state.monitors[1].layout.pane.id;
  const resource=f.records.resource(f.project.id,'math.js',{kind:'file',hash:'0'.repeat(64),identity:'file',state:'available'});
  f.records.bind({workspace_id:f.workspace_id,project_id:f.project.id,resource_id:resource.id,pane_id:pane,role:'project_files',base_revision:before.revision});
  const issued=await f.flow('recipe_preview',{recipe:'project_focus'});
  assert.equal(issued.base_revision,before.revision);
  const focused=await f.flow('recipe_apply',{recipe:'project_focus',preview_id:issued.preview_id,preview_digest:issued.preview_digest,op_id:randomUUID()});
  assert.equal(focused.workspace.state.monitors[0].id,before.state.monitors[1].id);
  assert.deepEqual(focused.workspace.state.monitors.map(m=>m.layout.pane.id).sort(),before.state.monitors.map(m=>m.layout.pane.id).sort());
  const returning=await f.flow('recipe_preview',{recipe:'return'});
  assert.match(returning.warning,/Restores the exact workspace state and Docking placement/);
  const restored=await f.flow('recipe_apply',{recipe:'return',preview_id:returning.preview_id,preview_digest:returning.preview_digest,op_id:randomUUID()});
  assert.deepEqual(restored.workspace.state.monitors.map(m=>m.id),before.state.monitors.map(m=>m.id));
  await assert.rejects(f.flow('recipe_preview',{recipe:'return'}),{code:'stale_resource'});
});

test('Review targets only the bound trusted window, floats it beside the agent, preserves an unrelated owner float and CAS-returns exact state',async t=>{
  const f=fixture(t),ids=f.store.read(f.workspace_id).state.monitors.map(window=>window.id),first=f.store.read(f.workspace_id);
  const pane=window=>{const visit=node=>node.type==='pane'?node.pane.id:visit(node.first);return visit(window.layout);};
  const reviewPane=pane(first.state.monitors[1]);
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'apply',operations:[],base_revision:first.revision,operation_id:randomUUID()},'owner'),{apply:value=>{const state=structuredClone(value.state);const visit=node=>node.type==='pane'?(node.pane.id===reviewPane?Object.assign(node.pane,{kind:'browser',url:'orbit://workbench-review'}):undefined):(visit(node.first),visit(node.second));visit(state.monitors.find(item=>item.id===ids[1]).layout);state.monitors[0].frame={x:80,y:60,width:480,height:360,z:2};state.monitors[1].frame={x:12,y:20,width:450,height:300,z:1};return state;}});
  await ownerSavePlacement(f,{version:1,layout:{type:'group',windows:[ids[0],ids[1]]},floats:[{windows:[ids[2]],frame:{x:700,y:40,width:320,height:240},active:ids[2]}],active:ids[0]});
  const before=f.store.read(f.workspace_id),priorState=structuredClone(before.state),priorPlacement=structuredClone(before.placement);
  const genericDiff=f.records.resource(f.project.id,'generic-diff.js',{kind:'file',hash:'3'.repeat(64),identity:'generic-diff',state:'available'});
  f.records.bind({workspace_id:f.workspace_id,project_id:f.project.id,resource_id:genericDiff.id,pane_id:pane(before.state.monitors[0]),base_revision:before.revision,role:'candidate_diff'});
  const file=f.records.resource(f.project.id,'review-diff.js',{kind:'file',hash:'1'.repeat(64),identity:'review-diff',state:'available'});
  const agent=f.records.resource(f.project.id,'review-agent',{kind:'conversation',hash:'2'.repeat(64),identity:'review-agent',state:'available'});
  f.records.bind({workspace_id:f.workspace_id,project_id:f.project.id,resource_id:file.id,pane_id:pane(before.state.monitors[1]),base_revision:before.revision,role:'candidate_diff'});
  f.records.bind({workspace_id:f.workspace_id,project_id:f.project.id,resource_id:agent.id,pane_id:pane(before.state.monitors[0]),base_revision:before.revision,role:'primary_agent'});
  const preview=await f.flow('recipe_preview',{recipe:'review',width:1400,height:900});
  assert.deepEqual(preview.operations.map(operation=>operation.action),['update_window','select','set_view']);
  assert.deepEqual(f.store.read(f.workspace_id).state,priorState,'preview does not mutate owner state');
  assert.deepEqual(f.store.read(f.workspace_id).placement,priorPlacement,'preview does not mutate Docking placement');
  await assert.rejects(f.flow('recipe_preview',{recipe:'review'}),{code:'invalid_request'});
  const applied=await f.flow('recipe_apply',{recipe:'review',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id:randomUUID()});
  assert.equal(applied.workspace.state.monitors[0].id,ids[0]);assert.equal(applied.workspace.state.monitors[1].id,ids[1]);
  const targetFrame=applied.workspace.state.monitors[1].frame;assert.ok(targetFrame.x>=560&&targetFrame.x<1400);assert.ok(targetFrame.y>=0&&targetFrame.y+targetFrame.height<=900);
  assert.equal(applied.workspace.state.selected,ids[1]);assert.equal(applied.workspace.state.view,'windows');
  assert.equal(pane(applied.workspace.state.monitors[1]),reviewPane);
  assert.deepEqual(applied.workspace.placement.floats.find(item=>item.windows.includes(ids[1])).frame,{x:targetFrame.x,y:targetFrame.y,width:targetFrame.width,height:targetFrame.height});
  assert.deepEqual(applied.workspace.placement.floats.find(item=>item.windows.includes(ids[2])),priorPlacement.floats[0],'unrelated owner float remains exact');
  assert.ok(applied.workspace.placement.layout.windows.includes(ids[0]));assert.ok(!applied.workspace.placement.layout.windows.includes(ids[1]));
  const returning=await f.flow('recipe_preview',{recipe:'return'});
  assert.match(returning.warning,/Restores the exact workspace state and Docking placement/);assert.equal(returning.operations[0].action,'restore_review_arrangement');
  const restored=await f.flow('recipe_apply',{recipe:'return',preview_id:returning.preview_id,preview_digest:returning.preview_digest,op_id:randomUUID()});
  assert.deepEqual(restored.workspace.state,priorState);assert.deepEqual(restored.workspace.placement,priorPlacement);
  await assert.rejects(f.flow('recipe_preview',{recipe:'return'}),{code:'stale_resource'});
  const current=f.store.read(f.workspace_id),wrongUrl=structuredClone(current.state);const alter=node=>node.type==='pane'?(node.pane.id===reviewPane?node.pane.url='orbit://generic-browser':undefined):(alter(node.first),alter(node.second));alter(wrongUrl.monitors.find(item=>item.id===ids[1]).layout);
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'apply',operations:[],base_revision:current.revision,operation_id:randomUUID()},'owner'),{apply:()=>wrongUrl});
  await assert.rejects(f.flow('recipe_preview',{recipe:'review',width:1400,height:900}),{code:'unsupported'});
});

test('Review arrangement refuses multiple exact trusted Review bindings instead of choosing the first',async t=>{
  const f=fixture(t),before=f.store.read(f.workspace_id),windows=before.state.monitors;
  const paneIds=windows.map(window=>{const visit=node=>node.type==='pane'?node.pane.id:visit(node.first);return visit(window.layout);});
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'apply',operations:[],base_revision:before.revision,operation_id:randomUUID()},'owner'),{apply:value=>{const state=structuredClone(value.state);for(const window of state.monitors.slice(0,2)){const pane=window.layout.pane;pane.kind='browser';pane.url='orbit://workbench-review';}return state;}});
  const state=f.store.read(f.workspace_id);
  for(let index=0;index<2;index++){
    const resource=f.records.resource(f.project.id,`trusted-review-${index}`,{kind:'file',hash:String(index+4).repeat(64),identity:`trusted-${index}`,state:'available'});
    f.records.bind({workspace_id:f.workspace_id,project_id:f.project.id,resource_id:resource.id,pane_id:paneIds[index],base_revision:state.revision,role:'candidate_diff'});
  }
  const agent=f.records.resource(f.project.id,'agent-anchor',{kind:'conversation',hash:'9'.repeat(64),identity:'agent-anchor',state:'available'});
  f.records.bind({workspace_id:f.workspace_id,project_id:f.project.id,resource_id:agent.id,pane_id:paneIds[2],base_revision:state.revision,role:'primary_agent'});
  await assert.rejects(f.flow('recipe_preview',{recipe:'review',width:1200,height:800}),{code:'conflict'});
});
