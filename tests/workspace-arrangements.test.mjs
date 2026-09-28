import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore,wbError} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkspaceArrangements} from '../server/workspace-arrangements.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';
import {ARRANGEMENT_LIMITS} from '../contracts/workbench-workflow-v1.mjs';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-arrangements-'),projectRoot=path.join(root,'source');
  fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum = (a,b) => a - b;\n');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Arrangement fixture',identity:opened.identity});
  const projectIdentity=opened.identity;opened.close();
  const arrangements=createWorkspaceArrangements({store,records,data});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const newProject=name=>{
    const target=path.join(root,name);fs.mkdirSync(target);
    const handle=openProjectRoot(target);const registered=records.register(workspace_id,{root:target,name,identity:handle.identity});handle.close();return registered;
  };
  const newWorkspace=()=>{
    const id=randomUUID();
    store.commit(commandIdentity({workspace_id:id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id,revision:1,state:initial(),capability:randomUUID()})});
    return id;
  };
  const flow=(action,fields={},actor='owner')=>arrangements.dispatch({action,workspace_id,project_id:project.id,...(action==='recipe_save'?{op_id:randomUUID()}:{}),...fields},{actor});
  const kindFor=role=>({project_files:'file',candidate_diff:'file',active_terminal:'terminal',primary_agent:'conversation',preview:'browser'}[role]);
  const bind=(role,pane,locator)=>{
    const resource=records.resource(project.id,locator,{kind:kindFor(role),hash:'0'.repeat(64),identity:locator,state:'available'});
    records.bind({workspace_id,project_id:project.id,resource_id:resource.id,pane_id:pane,role,base_revision:store.read(workspace_id).revision});
    return records.bindings(workspace_id,project.id).find(binding=>binding.pane_id===pane&&binding.role===role);
  };
  const monitorPane=index=>store.read(workspace_id).state.monitors[index].layout.pane.id;
  const bindIn=(projectId,pane,locator,role='project_files')=>{
    const resource=records.resource(projectId,locator,{kind:kindFor(role),hash:'0'.repeat(64),identity:locator,state:'available'});
    records.bind({workspace_id,project_id:projectId,resource_id:resource.id,pane_id:pane,role,base_revision:store.read(workspace_id).revision});
    return records.bindings(workspace_id,projectId).find(binding=>binding.pane_id===pane&&binding.role===role);
  };
  const flowIn=(projectId,action,fields={},actor='owner')=>arrangements.dispatch({action,workspace_id,project_id:projectId,...(action==='recipe_save'?{op_id:randomUUID()}:{}),...fields},{actor});
  return {root,projectRoot,store,workspace_id,project,projectIdentity,records,data,arrangements,flow,flowIn,bind,bindIn,monitorPane,newProject,newWorkspace};
}
const apply=async(f,recipe,preview,op_id=randomUUID())=>f.flow('recipe_apply',{recipe,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});

test('a consumed preview is reconciled from the durable operation key instead of expiring',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const preview=await f.flow('recipe_preview',{recipe:'project_focus'});
  const op_id=randomUUID();
  const first=await f.flow('recipe_apply',{recipe:'project_focus',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});
  assert.equal(first.idempotent,false);assert.equal(first.status,'committed');
  const revision=f.store.read(f.workspace_id).revision;
  const retry=await f.flow('recipe_apply',{recipe:'project_focus',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id});
  assert.equal(retry.idempotent,true);assert.equal(retry.status,'committed');
  assert.equal(retry.workspace.revision,revision);assert.equal(f.store.read(f.workspace_id).revision,revision);
  assert.deepEqual(retry.workspace.state,f.store.read(f.workspace_id).state);
});

test('a changed payload on the same operation key is a conflict, not a reapply',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const first=await f.flow('recipe_preview',{recipe:'project_focus'});
  const other=await f.flow('recipe_preview',{recipe:'investigate'});
  const op_id=randomUUID();
  await f.flow('recipe_apply',{recipe:'project_focus',preview_id:first.preview_id,preview_digest:first.preview_digest,op_id});
  const revision=f.store.read(f.workspace_id).revision;
  await assert.rejects(f.flow('recipe_apply',{recipe:'investigate',preview_id:other.preview_id,preview_digest:other.preview_digest,op_id}),{code:'conflict'});
  assert.equal(f.store.read(f.workspace_id).revision,revision);
});

test('a different operation key for an already committed proposal never reapplies',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const preview=await f.flow('recipe_preview',{recipe:'project_focus'});
  await apply(f,'project_focus',preview);
  const revision=f.store.read(f.workspace_id).revision,state=f.store.read(f.workspace_id).state;
  await assert.rejects(apply(f,'project_focus',preview),{code:'stale_resource'});
  assert.equal(f.store.read(f.workspace_id).revision,revision);
  assert.deepEqual(f.store.read(f.workspace_id).state,state);
});

test('proposal metadata, checkpoint and receipt roll back together when the metadata CAS fails',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const preview=await f.flow('recipe_preview',{recipe:'project_focus'});
  const before=f.store.read(f.workspace_id),checkpoints=f.store.checkpointList(f.workspace_id).length,op_id=randomUUID();
  const original=f.data.update.bind(f.data);
  f.data.update=(kind,...args)=>{if(kind==='proposals')throw wbError('stale_resource');return original(kind,...args);};
  try{
    await assert.rejects(f.flow('recipe_apply',{recipe:'project_focus',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id}),{code:'stale_resource'});
  }finally{f.data.update=original;}
  assert.deepEqual(f.store.read(f.workspace_id),before,'workspace state and revision must be untouched');
  assert.equal(f.store.checkpointList(f.workspace_id).length,checkpoints,'no checkpoint may survive a rolled-back commit');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM receipts WHERE workspace_id=? AND operation_id=?').get(f.workspace_id,op_id).n,0,'no receipt may survive a rolled-back commit');
  const stored=f.data.get('proposals',f.workspace_id,f.project.id,preview.preview_id);
  assert.equal(stored.status,'previewed');
});

test('return is restart-safe and restores the exact revision captured by the forward commit',async t=>{
  const f=fixture(t),pane=f.monitorPane(1);f.bind('project_files',pane,'math.js');
  const before=f.store.read(f.workspace_id),priorState=structuredClone(before.state),priorRevision=before.revision;
  await apply(f,'project_focus',await f.flow('recipe_preview',{recipe:'project_focus'}));
  assert.equal(f.store.read(f.workspace_id).revision,priorRevision+1);
  // A fresh compiler instance models a server restart: the old in-memory map is gone.
  const restarted=createWorkspaceArrangements({store:f.store,records:f.records,data:f.data});
  const flow=(action,fields={})=>restarted.dispatch({action,workspace_id:f.workspace_id,project_id:f.project.id,...fields},{actor:'owner'});
  const returning=await flow('recipe_preview',{recipe:'return'});
  assert.equal(returning.operations[0].action,'set_workspace');
  const restored=await flow('recipe_apply',{recipe:'return',preview_id:returning.preview_id,preview_digest:returning.preview_digest,op_id:randomUUID()});
  assert.deepEqual(restored.workspace.state,priorState);
  assert.equal(restored.workspace.revision,priorRevision+2);
  await assert.rejects(flow('recipe_preview',{recipe:'return'}),{code:'stale_resource'});
});

test('return refuses a broad restore after an intervening workspace edit',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  await apply(f,'project_focus',await f.flow('recipe_preview',{recipe:'project_focus'}));
  const current=f.store.read(f.workspace_id);
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'apply',operations:[],base_revision:current.revision,operation_id:randomUUID()},'owner'),{apply:value=>{const state=structuredClone(value.state);state.sidebarHidden=!state.sidebarHidden;return state;}});
  await assert.rejects(f.flow('recipe_preview',{recipe:'return'}),{code:'stale_resource'});
});

test('saved recipes snapshot portable role constraints and use revision CAS',async t=>{
  const f=fixture(t);
  const empty=await f.flow('recipe_list');
  assert.deepEqual(empty.recipes,[]);assert.equal(empty.capabilities.portable_constraints_only,true);
  assert.deepEqual(empty.capabilities.roles,['primary_agent','active_terminal','preview','candidate_diff','project_files']);
  const saved=await f.flow('recipe_save',{name:'Files first',roles:['project_files'],layout:'prioritize',renderer:'windows'});
  assert.equal(saved.recipe.version,1);assert.equal(saved.recipe.name,'Files first');
  await assert.rejects(f.flow('recipe_save',{name:'Files first',roles:['project_files'],layout:'prioritize',renderer:'windows'}),{code:'conflict'});
  await assert.rejects(f.flow('recipe_save',{name:'Renamed',roles:['project_files'],layout:'prioritize',renderer:'windows',recipe_id:saved.recipe.id,expected_version:99}),{code:'stale_resource'});
  const updated=await f.flow('recipe_save',{name:'Renamed',roles:['project_files'],layout:'columns',renderer:'docking',recipe_id:saved.recipe.id,expected_version:1});
  assert.equal(updated.recipe.version,2);assert.equal(updated.recipe.layout,'columns');assert.equal(updated.recipe.renderer,'docking');
  const listed=await f.flow('recipe_list');
  assert.equal(listed.recipes.length,1);assert.equal(listed.recipes[0].id,saved.recipe.id);assert.equal(listed.recipes[0].version,2);
  await assert.rejects(f.flow('recipe_save',{name:'Bad role',roles:['recovery'],layout:'prioritize',renderer:'windows'}),{code:'invalid_request'});
});

test('role choices resolve only real project bindings; ambiguity and unknown choices conflict; missing roles are unbound',async t=>{
  const f=fixture(t);
  const first=f.bind('project_files',f.monitorPane(1),'a.js'),second=f.bind('project_files',f.monitorPane(2),'b.js');
  f.bind('candidate_diff',f.monitorPane(0),'diff.js');
  const saved=await f.flow('recipe_save',{name:'Multi',roles:['project_files','primary_agent'],layout:'prioritize',renderer:'windows'});
  await assert.rejects(f.flow('recipe_preview',{recipe:'project_focus',recipe_id:saved.recipe.id}),{code:'conflict'});
  const chosen=await f.flow('recipe_preview',{recipe:'project_focus',recipe_id:saved.recipe.id,role_choices:{project_files:second.id}});
  assert.equal(chosen.role_choices.project_files,second.id);
  assert.deepEqual(chosen.unbound,['primary_agent']);
  await assert.rejects(f.flow('recipe_preview',{recipe:'project_focus',recipe_id:saved.recipe.id,role_choices:{project_files:randomUUID()}}),{code:'conflict'});
  await assert.rejects(f.flow('recipe_preview',{recipe:'project_focus',recipe_id:saved.recipe.id,role_choices:{candidate_diff:first.id}}),{code:'invalid_request'});
  assert.notEqual(first.id,second.id);
});

test('a columns recipe applies measured geometry and reports deferred geometry honestly',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const saved=await f.flow('recipe_save',{name:'Columns',roles:['project_files'],layout:'columns',renderer:'windows'});
  const deferred=await f.flow('recipe_preview',{recipe:'investigate',recipe_id:saved.recipe.id});
  assert.equal(deferred.geometry,'deferred');
  assert.ok(deferred.operations.every(operation=>operation.action==='reorder_windows'));
  const measured=await f.flow('recipe_preview',{recipe:'investigate',recipe_id:saved.recipe.id,width:1400,height:900});
  assert.equal(measured.geometry,'applied');
  const geometry=measured.operations.find(operation=>operation.action==='update_window');
  assert.ok(geometry&&geometry.frame.width>=280&&geometry.frame.height>=180);
  const applied=await f.flow('recipe_apply',{recipe:'investigate',preview_id:measured.preview_id,preview_digest:measured.preview_digest,op_id:randomUUID()});
  assert.equal(applied.workspace.state.monitors.find(monitor=>monitor.id===geometry.window_id).frame.width,geometry.frame.width);
});

test('preview base/revision drift and digest mismatch are refused before commit',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const preview=await f.flow('recipe_preview',{recipe:'project_focus'});
  await assert.rejects(apply(f,'project_focus',{...preview,preview_digest:'0'.repeat(64)}),{code:'stale_resource'});
  const current=f.store.read(f.workspace_id);
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'apply',operations:[],base_revision:current.revision,operation_id:randomUUID()},'owner'),{apply:value=>{const state=structuredClone(value.state);state.arc=state.arc+1;return state;}});
  await assert.rejects(apply(f,'project_focus',preview),{code:'stale_resource'});
});

test('recipe_save enforces the per-project recipe budget',async t=>{
  const f=fixture(t);
  for(let index=0;index<ARRANGEMENT_LIMITS.maxRecipes;index++)await f.flow('recipe_save',{name:`Recipe ${index}`,roles:[],layout:'prioritize',renderer:'windows'});
  await assert.rejects(f.flow('recipe_save',{name:'One too many',roles:[],layout:'prioritize',renderer:'windows'}),{code:'limit_exceeded'});
});

test('the normal-controller factory works without a caller-supplied WorkbenchData',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const control=createWorkspaceArrangements({store:f.store,records:f.records});
  const listed=await control.dispatch({action:'recipe_list',workspace_id:f.workspace_id,project_id:f.project.id},{actor:'workspace-controller:'+f.workspace_id});
  assert.deepEqual(listed.recipes,[]);
  const preview=await control.dispatch({action:'recipe_preview',recipe:'project_focus',workspace_id:f.workspace_id,project_id:f.project.id},{actor:'workspace-controller:'+f.workspace_id});
  const parsed=(await control.proposalList({action:'proposal_list',workspace_id:f.workspace_id,project_id:f.project.id})).proposals;
  assert.equal(parsed.length,1);assert.equal(parsed[0].id,preview.preview_id);assert.equal(parsed[0].status,'previewed');
});

test('proposals are inspectable and a preview can be explicitly rejected without touching the workspace',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const preview=await f.flow('recipe_preview',{recipe:'project_focus'});
  const before=f.store.read(f.workspace_id);
  const got=await f.flow('proposal_get',{proposal_id:preview.preview_id});
  assert.equal(got.proposal.id,preview.preview_id);
  assert.equal(got.proposal.staged_state.monitors.length,before.state.monitors.length);
  assert.deepEqual(got.proposal.staged_placement,before.placement);
  assert.equal(got.proposal.preview_digest,preview.preview_digest);
  assert.deepEqual(got.proposal.semantic_diff,preview.semantic_diff);
  const rejected=await f.flow('proposal_reject',{proposal_id:preview.preview_id,expected_version:got.proposal.version});
  assert.equal(rejected.proposal.status,'rejected');
  assert.deepEqual(f.store.read(f.workspace_id),before);
  await assert.rejects(f.flow('recipe_apply',{recipe:'project_focus',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id:randomUUID()}),{code:'stale_resource'});
  await assert.rejects(f.flow('proposal_reject',{proposal_id:preview.preview_id,expected_version:got.proposal.version}),{code:'stale_resource'});
});

const commitState=(f,state)=>f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'apply',operations:[],base_revision:f.store.read(f.workspace_id).revision,operation_id:randomUUID()},'owner'),{apply:()=>state});

test('distinct proposals sharing one operation key never collide and receipts are actor scoped',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const a=await f.flow('recipe_preview',{recipe:'project_focus'});
  const b=await f.flow('recipe_preview',{recipe:'project_focus'});
  const op_id=randomUUID();
  await f.flow('recipe_apply',{recipe:'project_focus',preview_id:a.preview_id,preview_digest:a.preview_digest,op_id});
  const revision=f.store.read(f.workspace_id).revision;
  // Same operations, different proposal id/digest: must be a conflict, never a replay.
  await assert.rejects(f.flow('recipe_apply',{recipe:'project_focus',preview_id:b.preview_id,preview_digest:b.preview_digest,op_id}),{code:'conflict'});
  assert.equal(f.store.read(f.workspace_id).revision,revision);
  // The committing actor is distinct: another actor cannot inherit the receipt.
  const controller='workspace-controller:'+f.workspace_id;
  await assert.rejects(f.arrangements.dispatch({action:'recipe_apply',workspace_id:f.workspace_id,project_id:f.project.id,recipe:'project_focus',preview_id:a.preview_id,preview_digest:a.preview_digest,op_id},{actor:controller}),{code:'stale_resource'});
  const ownerRetry=await f.flow('recipe_apply',{recipe:'project_focus',preview_id:a.preview_id,preview_digest:a.preview_digest,op_id});
  assert.equal(ownerRetry.idempotent,true);
});

test('apply revalidates project generation, bindings including resource generation and recovery generation in the commit transaction',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const preview=await f.flow('recipe_preview',{recipe:'project_focus'});
  const before=f.store.read(f.workspace_id);
  f.records.resource(f.project.id,'math.js',{kind:'file',hash:'1'.repeat(64),identity:'file',state:'available'});
  await assert.rejects(apply(f,'project_focus',preview),{code:'stale_resource'});
  assert.equal(f.store.read(f.workspace_id).revision,before.revision);

  const previewA=await f.flow('recipe_preview',{recipe:'project_focus'});
  f.records.revoke(f.workspace_id,f.project.id,f.records.project(f.workspace_id,f.project.id).generation);
  f.records.register(f.workspace_id,{root:f.projectRoot,name:'Arrangement fixture',identity:f.projectIdentity});
  await assert.rejects(apply(f,'project_focus',previewA),{code:'stale_resource'});

  const previewR=await f.flow('recipe_preview',{recipe:'project_focus'});
  const current=f.store.read(f.workspace_id);
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'recovery_policy',base_revision:current.revision,operation_id:randomUUID(),intent:'hold'},'owner'),{recoveryPolicy:true});
  await assert.rejects(apply(f,'project_focus',previewR),{code:'stale_resource'});
});

test('a saved recipe changed after preview refuses the commit instead of using the old definition',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const saved=await f.flow('recipe_save',{name:'Files',roles:['project_files'],layout:'prioritize',renderer:'windows'});
  const preview=await f.flow('recipe_preview',{recipe:'investigate',recipe_id:saved.recipe.id});
  await f.flow('recipe_save',{name:'Files',roles:['project_files'],layout:'columns',renderer:'windows',recipe_id:saved.recipe.id,expected_version:1});
  await assert.rejects(apply(f,'investigate',preview),{code:'stale_resource'});
});

test('recipes saved in one project are reusable in another project of the same workspace and never cross workspaces',async t=>{
  const f=fixture(t);
  const saved=await f.flow('recipe_save',{name:'Shared',roles:['project_files'],layout:'prioritize',renderer:'windows'});
  const other=f.newProject('project-b');
  const otherBinding=f.bindIn(other.id,f.monitorPane(2),'b.js');
  const listed=await f.flowIn(other.id,'recipe_list');
  assert.equal(listed.recipes.length,1);assert.equal(listed.recipes[0].id,saved.recipe.id);assert.equal(listed.recipes[0].project_id,f.project.id);
  assert.deepEqual(listed.bindings.map(binding=>binding.id),[otherBinding.id]);
  const preview=await f.flowIn(other.id,'recipe_preview',{recipe:'investigate',recipe_id:saved.recipe.id,role_choices:{project_files:otherBinding.id}});
  assert.equal(preview.role_choices.project_files,otherBinding.id);
  const applied=await f.flowIn(other.id,'recipe_apply',{recipe:'investigate',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id:randomUUID()});
  assert.equal(applied.status,'committed');
  const foreignWorkspace=f.newWorkspace();
  const foreignProject=f.records.register(foreignWorkspace,{root:f.projectRoot,name:'foreign',identity:f.projectIdentity});
  await assert.rejects(f.arrangements.dispatch({action:'recipe_preview',workspace_id:foreignWorkspace,project_id:foreignProject.id,recipe:'investigate',recipe_id:saved.recipe.id},{actor:'owner'}),{code:'stale_resource'});
});

test('columns and rows produce distinct measured shapes, docking updates only chosen windows and spatial refuses geometry',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(0),'a.js');f.bind('active_terminal',f.monitorPane(1),'t.js');
  const ids=f.store.read(f.workspace_id).state.monitors.map(monitor=>monitor.id);
  const columns=await f.flow('recipe_save',{name:'Columns',roles:['project_files','active_terminal'],layout:'columns',renderer:'windows'});
  const rows=await f.flow('recipe_save',{name:'Rows',roles:['project_files','active_terminal'],layout:'rows',renderer:'windows'});
  const columnPreview=await f.flow('recipe_preview',{recipe:'implement',recipe_id:columns.recipe.id,width:1400,height:900});
  const rowPreview=await f.flow('recipe_preview',{recipe:'implement',recipe_id:rows.recipe.id,width:1400,height:900});
  const columnFrames=columnPreview.operations.filter(op=>op.action==='update_window');
  const rowFrames=rowPreview.operations.filter(op=>op.action==='update_window');
  assert.equal(columnFrames.length,2);assert.equal(rowFrames.length,2);
  assert.equal(new Set(columnFrames.map(op=>op.frame.y)).size,1,'columns share one row');
  assert.equal(new Set(columnFrames.map(op=>op.frame.x)).size,2);
  assert.equal(new Set(rowFrames.map(op=>op.frame.x)).size,1,'rows share one column');
  assert.equal(new Set(rowFrames.map(op=>op.frame.y)).size,2);
  // Narrow columns fall back to fewer columns at the minimum frame width.
  f.bind('preview',f.monitorPane(2),'p.js');
  const narrow=await f.flow('recipe_save',{name:'Narrow',roles:['project_files','active_terminal','preview'],layout:'columns',renderer:'windows'});
  const narrowPreview=await f.flow('recipe_preview',{recipe:'implement',recipe_id:narrow.recipe.id,width:700,height:900});
  assert.equal(narrowPreview.geometry,'applied');
  const narrowFrames=narrowPreview.operations.filter(op=>op.action==='update_window');
  assert.equal(narrowFrames[0].frame.width,342,'3 columns would be 225px, so columns narrow to 2 at 342px');
  assert.equal(new Set(narrowFrames.map(op=>op.frame.y)).size,2,'narrow columns wrap into two rows');
  await assert.rejects(f.flow('recipe_preview',{recipe:'implement',recipe_id:columns.recipe.id,renderer:'spatial',width:1400,height:900}),{code:'unsupported'});

  const unrelated={version:1,layout:null,floats:[{windows:[ids[2]],frame:{x:700,y:40,width:320,height:240},active:ids[2]}],active:ids[2]};
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'placement_save',base_revision:f.store.read(f.workspace_id).revision,placement:unrelated,operation_id:randomUUID(),intent:'fixture'},'owner'),{apply:record=>record.state,placement:unrelated,skipUnchanged:true});
  const docking=await f.flow('recipe_save',{name:'Docking',roles:['project_files','active_terminal'],layout:'columns',renderer:'docking'});
  const dockPreview=await f.flow('recipe_preview',{recipe:'implement',recipe_id:docking.recipe.id,width:1400,height:900});
  assert.equal(dockPreview.renderer,'docking');
  const dockApplied=await f.flow('recipe_apply',{recipe:'implement',preview_id:dockPreview.preview_id,preview_digest:dockPreview.preview_digest,op_id:randomUUID()});
  const floats=dockApplied.workspace.placement.floats;
  assert.ok(floats.some(float=>float.windows.length===1&&float.windows[0]===ids[2]&&float.frame.x===700),'unrelated owner float preserved');
  assert.equal(floats.filter(float=>float.windows.length===1&&(float.windows[0]===ids[0]||float.windows[0]===ids[1])).length,2,'chosen windows became floats');
});

test('the measured viewport is part of the preview identity, persisted and enforced on apply',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const saved=await f.flow('recipe_save',{name:'Measured',roles:['project_files'],layout:'columns',renderer:'windows'});
  const small=await f.flow('recipe_preview',{recipe:'investigate',recipe_id:saved.recipe.id,width:1400,height:900});
  const large=await f.flow('recipe_preview',{recipe:'investigate',recipe_id:saved.recipe.id,width:1600,height:900});
  assert.notEqual(small.preview_digest,large.preview_digest,'viewport must affect the preview identity');
  assert.deepEqual(small.viewport,{width:1400,height:900});
  const stored=(await f.flow('proposal_get',{proposal_id:small.preview_id})).proposal;
  assert.deepEqual(stored.viewport,{width:1400,height:900});
  await assert.rejects(f.flow('recipe_apply',{recipe:'investigate',preview_id:small.preview_id,preview_digest:small.preview_digest,op_id:randomUUID(),viewport:{width:1200,height:900}}),{code:'stale_resource'});
  const applied=await f.flow('recipe_apply',{recipe:'investigate',preview_id:small.preview_id,preview_digest:small.preview_digest,op_id:randomUUID(),viewport:{width:1400,height:900}});
  assert.equal(applied.status,'committed');
});

test('an existing binding whose pane is gone is reported unbound and ambiguous built-ins are explicit',async t=>{
  const f=fixture(t);const binding=f.bind('project_files',f.monitorPane(1),'math.js');
  const saved=await f.flow('recipe_save',{name:'Files',roles:['project_files'],layout:'prioritize',renderer:'windows'});
  const current=f.store.read(f.workspace_id),monitorId=current.state.monitors.find(monitor=>monitor.layout.type==='pane'&&monitor.layout.pane.id===binding.pane_id).id;
  const state=structuredClone(current.state);state.monitors=state.monitors.filter(monitor=>monitor.id!==monitorId);if(state.selected===monitorId)state.selected=state.monitors[0].id;
  commitState(f,state);
  const preview=await f.flow('recipe_preview',{recipe:'investigate',recipe_id:saved.recipe.id});
  assert.deepEqual(preview.unbound,['project_files']);
  assert.ok(f.records.bindings(f.workspace_id,f.project.id).some(item=>item.id===binding.id),'binding row itself is not deleted');
  const f2=fixture(t);f2.bind('project_files',f2.monitorPane(0),'a.js');f2.bind('project_files',f2.monitorPane(1),'b.js');
  await assert.rejects(f2.flow('recipe_preview',{recipe:'investigate'}),{code:'conflict'});
});

test('recipe_save requires a durable operation key and reconciles a lost response',async t=>{
  const f=fixture(t),op_id=randomUUID();
  const first=await f.flow('recipe_save',{name:'Idem',roles:[],layout:'prioritize',renderer:'windows',op_id});
  assert.equal(first.idempotent,false);assert.equal(first.legacy,false);
  const retry=await f.flow('recipe_save',{name:'Idem',roles:[],layout:'prioritize',renderer:'windows',op_id});
  assert.equal(retry.idempotent,true);assert.equal(retry.recipe.id,first.recipe.id);
  assert.equal((await f.flow('recipe_list')).recipes.length,1);
  await assert.rejects(f.flow('recipe_save',{name:'Idem',roles:[],layout:'rows',renderer:'windows',op_id}),{code:'conflict'});
  await assert.rejects(f.arrangements.dispatch({action:'recipe_save',workspace_id:f.workspace_id,project_id:f.project.id,name:'No key',roles:[],layout:'prioritize',renderer:'windows'}),{code:'invalid_request'});
});

test('recipe receipts survive later edits: an exact create or edit retry returns the original result/version',async t=>{
  const f=fixture(t),op_id=randomUUID();
  const created=await f.flow('recipe_save',{name:'Original',roles:[],layout:'prioritize',renderer:'windows',op_id});
  await f.flow('recipe_save',{name:'Renamed',roles:[],layout:'prioritize',renderer:'windows',recipe_id:created.recipe.id,expected_version:1});
  const retry=await f.flow('recipe_save',{name:'Original',roles:[],layout:'prioritize',renderer:'windows',op_id});
  assert.equal(retry.idempotent,true);assert.equal(retry.recipe.id,created.recipe.id);
  assert.equal(retry.recipe.version,1);assert.equal(retry.recipe.name,'Original','receipt replays the original version after a later rename');
  assert.equal((await f.flow('recipe_list')).recipes.length,1);

  const editOp=randomUUID();
  const base=await f.flow('recipe_save',{name:'Base',roles:[],layout:'prioritize',renderer:'windows'});
  const firstEdit=await f.flow('recipe_save',{name:'Edit1',roles:[],layout:'prioritize',renderer:'windows',recipe_id:base.recipe.id,expected_version:1,op_id:editOp});
  await f.flow('recipe_save',{name:'Edit2',roles:[],layout:'prioritize',renderer:'windows',recipe_id:base.recipe.id,expected_version:2});
  const editRetry=await f.flow('recipe_save',{name:'Edit1',roles:[],layout:'prioritize',renderer:'windows',recipe_id:base.recipe.id,expected_version:1,op_id:editOp});
  assert.equal(editRetry.idempotent,true);assert.equal(editRetry.recipe.name,'Edit1');assert.equal(editRetry.recipe.version,2);
  assert.equal(firstEdit.recipe.version,2);
  assert.equal((await f.flow('recipe_list')).recipes.find(recipe=>recipe.id===base.recipe.id).name,'Edit2','later edit remains authoritative');
});

test('recipe receipts are actor scoped and a changed expected_version or intent on the same key conflicts',async t=>{
  const f=fixture(t),op_id=randomUUID();
  const owner=await f.flow('recipe_save',{name:'Owner',roles:[],layout:'prioritize',renderer:'windows',op_id},'owner');
  const controller='workspace-controller:'+f.workspace_id;
  const other=await f.arrangements.dispatch({action:'recipe_save',workspace_id:f.workspace_id,project_id:f.project.id,name:'Controller',roles:[],layout:'prioritize',renderer:'windows',op_id},{actor:controller});
  assert.equal(other.idempotent,false);assert.notEqual(other.recipe.id,owner.recipe.id,'another actor key is its own receipt');
  const ownerRetry=await f.flow('recipe_save',{name:'Owner',roles:[],layout:'prioritize',renderer:'windows',op_id},'owner');
  assert.equal(ownerRetry.idempotent,true);assert.equal(ownerRetry.recipe.id,owner.recipe.id);

  const base=await f.flow('recipe_save',{name:'Versioned',roles:[],layout:'prioritize',renderer:'windows'});
  const editOp=randomUUID();
  await f.flow('recipe_save',{name:'Versioned',roles:[],layout:'rows',renderer:'windows',recipe_id:base.recipe.id,expected_version:1,op_id:editOp,intent:'Rows please'});
  await assert.rejects(f.flow('recipe_save',{name:'Versioned',roles:[],layout:'rows',renderer:'windows',recipe_id:base.recipe.id,expected_version:2,op_id:editOp,intent:'Rows please'}),{code:'conflict'});
  await assert.rejects(f.flow('recipe_save',{name:'Versioned',roles:[],layout:'rows',renderer:'windows',recipe_id:base.recipe.id,expected_version:1,op_id:editOp,intent:'Different intent'}),{code:'conflict'});
});

test('a recipe edit must target its owning project',async t=>{
  const f=fixture(t);
  const saved=await f.flow('recipe_save',{name:'Owned',roles:[],layout:'prioritize',renderer:'windows'});
  const other=f.newProject('project-own');
  await assert.rejects(f.flowIn(other.id,'recipe_save',{name:'Owned',roles:[],layout:'rows',renderer:'windows',recipe_id:saved.recipe.id,expected_version:1}),{code:'stale_resource'});
  const stillOwned=await f.flow('recipe_list');
  assert.equal(stillOwned.recipes[0].layout,'prioritize');
});

test('an injected receipt-write failure rolls back the recipe create and leaves no receipt',async t=>{
  const f=fixture(t),db=f.data.db,original=db.prepare.bind(db),op_id=randomUUID();
  db.prepare=sql=>{if(typeof sql==='string'&&sql.includes('INSERT INTO wb_recipe_receipts'))throw Object.assign(Error('injected_failure'),{code:'injected_failure'});return original(sql);};
  try{await assert.rejects(f.flow('recipe_save',{name:'Injected',roles:[],layout:'prioritize',renderer:'windows',op_id}),error=>error.code==='injected_failure');}
  finally{db.prepare=original;}
  assert.equal((await f.flow('recipe_list')).recipes.length,0,'recipe create rolled back with the receipt');
  assert.equal(db.prepare('SELECT count(*) AS n FROM wb_recipe_receipts').get().n,0,'no receipt survives a rolled-back save');
});

test('recipe_apply binds the caller intent into the receipt and refuses a changed intent on the same key',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const preview=await f.flow('recipe_preview',{recipe:'project_focus'}),op_id=randomUUID();
  const first=await f.flow('recipe_apply',{recipe:'project_focus',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id,intent:'Tidy up for review'});
  assert.equal(first.intent,'Tidy up for review');
  const stored=await f.flow('proposal_get',{proposal_id:preview.preview_id});
  assert.equal(stored.proposal.committed_intent,'Tidy up for review');
  const retry=await f.flow('recipe_apply',{recipe:'project_focus',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id,intent:'Tidy up for review'});
  assert.equal(retry.idempotent,true);
  await assert.rejects(f.flow('recipe_apply',{recipe:'project_focus',preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id,intent:'Something else'}),{code:'conflict'});
});

test('proposal_list paginates newest-first with a stable after_id cursor',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  for(let index=0;index<34;index++)await f.flow('recipe_preview',{recipe:'project_focus'});
  const first=await f.flow('proposal_list');
  assert.equal(first.proposals.length,32);assert.equal(first.truncated,true);assert.ok(first.next_after_id);
  const second=await f.flow('proposal_list',{after_id:first.next_after_id});
  assert.equal(second.proposals.length,2);assert.equal(second.truncated,false);assert.equal(second.next_after_id,null);
  assert.equal(first.total_count,34);
  const ids=new Set([...first.proposals,...second.proposals].map(proposal=>proposal.id));
  assert.equal(ids.size,34,'pages do not overlap or drop proposals');
  await assert.rejects(f.flow('proposal_list',{after_id:randomUUID()}),{code:'stale_resource'});
});


test('the proposal operation index is actor scoped at the database boundary',async t=>{
  const f=fixture(t),op_id=randomUUID(),scope={workspace_id:f.workspace_id,project_id:f.project.id};
  f.data.create('proposals',{...scope,status:'committed',op_id,committed_actor:'owner'});
  f.data.create('proposals',{...scope,status:'committed',op_id,committed_actor:'workspace-controller:'+f.workspace_id});
  assert.throws(()=>f.data.create('proposals',{...scope,status:'committed',op_id,committed_actor:'owner'}),error=>error.code==='SQLITE_CONSTRAINT_UNIQUE');
});

test('proposal caps are honest: capabilities document retention and expired uncommitted previews are pruned, committed receipts stay',async t=>{
  const f=fixture(t);f.bind('project_files',f.monitorPane(1),'math.js');
  const list=await f.flow('recipe_list');
  assert.equal(list.capabilities.max_proposals,200);assert.match(list.capabilities.retention,/No committed receipt is deleted/);
  const first=await f.flow('recipe_preview',{recipe:'project_focus'});
  const applied=await f.flow('recipe_apply',{recipe:'project_focus',preview_id:first.preview_id,preview_digest:first.preview_digest,op_id:randomUUID()});
  assert.equal(applied.status,'committed');
  const later=createWorkspaceArrangements({store:f.store,records:f.records,data:f.data,now:()=>Date.now()+120000});
  const second=await later.dispatch({action:'recipe_preview',recipe:'project_focus',workspace_id:f.workspace_id,project_id:f.project.id},{actor:'owner'});
  const proposals=(await f.flow('proposal_list')).proposals;
  const committed=proposals.find(proposal=>proposal.id===first.preview_id);
  assert.ok(committed&&committed.status==='committed','committed proposal retained');
  assert.ok(proposals.some(proposal=>proposal.id===second.preview_id));
});
