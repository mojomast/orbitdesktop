import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkspaceArrangements} from '../server/workspace-arrangements.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/arrangement-retention-'),runtime=path.join(root,'runtime'),source=path.join(root,'source');
  fs.mkdirSync(source);
  const workspace_id=randomUUID();let time=1000,store=new SqliteWorkspaceStore(runtime),records,data,arrangements;
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const attach=()=>{records=new WorkbenchStore(store);data=new WorkbenchData(store,{now:()=>time});arrangements=createWorkspaceArrangements({store,records,data,now:()=>time});};
  attach();
  const opened=openProjectRoot(source),project=records.register(workspace_id,{root:source,name:'Retention fixture',identity:opened.identity});opened.close();
  const before=store.read(workspace_id),resource=records.resource(project.id,'file.js',{kind:'file',hash:'0'.repeat(64),identity:'file',state:'available'});
  records.bind({workspace_id,project_id:project.id,resource_id:resource.id,pane_id:before.state.monitors[1].layout.pane.id,role:'project_files',base_revision:before.revision});
  const flow=(action,fields={})=>arrangements.dispatch({action,workspace_id,project_id:project.id,...fields});
  const preview=(recipe='project_focus')=>flow('recipe_preview',{recipe});
  const request=(p,recipe='project_focus')=>({recipe,preview_id:p.preview_id,preview_digest:p.preview_digest,op_id:randomUUID()});
  const reject=p=>flow('proposal_reject',{proposal_id:p.preview_id,expected_version:1});
  const all=()=>data.list('proposals',workspace_id,project.id);
  const drift=()=>{const current=store.read(workspace_id);store.commit(commandIdentity({workspace_id,action:'apply',operations:[],base_revision:current.revision,operation_id:randomUUID()},'owner'),{apply:()=>{const state=structuredClone(current.state);state.selected=state.monitors[2].id;return state;}});};
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {flow,preview,request,reject,all,drift,workspace_id,project,before,get store(){return store;},get data(){return data;},set time(value){time=value;},restart(){store.close();store=new SqliteWorkspaceStore(runtime);attach();}};
}

test('200 rapid cancel cycles reclaim oldest terminal previews durably and keep storage bounded',async t=>{
  const f=fixture(t);let first,second;
  for(let index=0;index<200;index++){
    f.time=1000+index;const p=await f.preview();if(index===0)first=p;if(index===1)second=p;await f.reject(p);
  }
  assert.equal(f.all().length,200);
  f.restart();
  const next=await f.preview();
  assert.equal(f.all().length,200);assert.ok(!f.all().some(p=>p.id===first.preview_id));assert.ok(f.all().some(p=>p.id===second.preview_id));
  await assert.rejects(f.flow('recipe_apply',f.request(first)),{code:'expired'});
  await assert.rejects(f.flow('proposal_get',{proposal_id:first.preview_id}),{code:'permission_denied'});
  await assert.rejects(f.flow('proposal_list',{after_id:first.preview_id}),{code:'stale_resource'});
  await f.reject(next);
  for(let index=0;index<20;index++){await f.reject(await f.preview());assert.equal(f.all().length,200);}
  f.restart();assert.equal(f.all().length,200);
});

test('age reclamation uses strict expiry boundary for previewed, rejected and drift-stale records',async t=>{
  const f=fixture(t),live=await f.preview(),rejected=await f.preview(),stale=await f.preview();
  await f.reject(rejected);f.drift();
  await assert.rejects(f.flow('recipe_apply',f.request(stale)),{code:'stale_resource'});
  assert.equal(f.all().find(p=>p.id===stale.preview_id).status,'stale');
  f.time=live.expires_at;
  const atBoundary=await f.preview();
  assert.ok([live,rejected,stale].every(p=>f.all().some(record=>record.id===p.preview_id)));
  // A newly created preview can actually commit at its exact expiry boundary.
  f.time=atBoundary.expires_at;
  const apply=await f.flow('recipe_apply',f.request(atBoundary));assert.equal(apply.status,'committed');
  await f.preview();
  assert.ok([live,rejected,stale].every(p=>!f.all().some(record=>record.id===p.preview_id)));
  assert.ok(f.all().some(record=>record.id===atBoundary.preview_id));
});

test('capacity pressure evicts drift-stale records but preserves unexpired live previews',async t=>{
  const f=fixture(t),stale=await f.preview();f.drift();
  await assert.rejects(f.flow('recipe_apply',f.request(stale)),{code:'stale_resource'});
  const live=[];for(let index=0;index<199;index++)live.push(await f.preview());
  await f.preview();assert.equal(f.all().length,200);
  assert.ok(!f.all().some(p=>p.id===stale.preview_id));assert.ok(live.every(p=>f.all().some(record=>record.id===p.preview_id)));
  await assert.rejects(f.preview(),{code:'limit_exceeded'});assert.equal(f.all().length,200);
  f.time=live[0].expires_at;await assert.rejects(f.preview(),{code:'limit_exceeded'});
  f.time=live[0].expires_at+1;await f.preview();assert.equal(f.all().length,1);
});

test('reclamation across restart preserves committed replay, exact Return checkpoint and Return replay',async t=>{
  const f=fixture(t),forward=await f.preview(),forwardRequest=f.request(forward);
  const applied=await f.flow('recipe_apply',forwardRequest),source=f.all().find(p=>p.id===forward.preview_id);
  assert.ok(source.return_checkpoint_id);
  for(let index=0;index<210;index++)await f.reject(await f.preview());
  assert.equal(f.all().length,201);f.time=forward.expires_at+1;f.restart();
  const inverse=await f.preview('return');
  assert.equal(f.all().length,2);assert.deepEqual(f.all().find(p=>p.id===forward.preview_id),source);
  assert.deepEqual(f.store.checkpointGet(f.workspace_id,source.return_checkpoint_id).state,f.before.state);
  const replay=await f.flow('recipe_apply',forwardRequest);assert.equal(replay.idempotent,true);assert.deepEqual(replay.workspace,applied.workspace);
  const inverseRequest=f.request(inverse,'return'),restored=await f.flow('recipe_apply',inverseRequest);
  assert.deepEqual(restored.workspace.state,f.before.state);assert.deepEqual(restored.workspace.placement,f.before.placement);
  f.time=inverse.expires_at+1;await f.preview();f.restart();
  assert.equal((await f.flow('recipe_apply',inverseRequest)).idempotent,true);
  assert.equal((await f.flow('recipe_apply',forwardRequest)).idempotent,true);
  await assert.rejects(f.flow('recipe_apply',{...forwardRequest,op_id:randomUUID()}),{code:'stale_resource'});
  await assert.rejects(f.flow('recipe_apply',{...forwardRequest,intent:'Changed identity'}),{code:'conflict'});
});

test('1001 committed proposals leave active capacity available across restart with exact replay and Return',async t=>{
  const f=fixture(t);let firstRequest,firstResult,lastRequest,lastResult;
  for(let index=0;index<1001;index++){
    const p=await f.preview(),request=f.request(p);if(index===0)firstRequest=request;
    const result=await f.flow('recipe_apply',request);if(index===0)firstResult=result;lastRequest=request;lastResult=result;
    if(index===500)f.restart();
  }
  const retained=f.all();f.time=1000000;f.restart();
  assert.deepEqual(f.all(),retained);assert.equal((await f.flow('recipe_apply',firstRequest)).idempotent,true);
  assert.deepEqual((await f.flow('recipe_apply',firstRequest)).workspace,firstResult.workspace);
  assert.deepEqual((await f.flow('recipe_apply',lastRequest)).workspace,lastResult.workspace);
  await assert.rejects(f.flow('recipe_apply',{...firstRequest,intent:'altered'}),{code:'conflict'});
  const capacity=(await f.flow('recipe_list')).capacity;
  assert.equal(capacity.active,0);assert.equal(capacity.archived,1001);assert.equal(capacity.remaining,200);
  await f.preview();const inverse=await f.preview('return');
  await f.flow('recipe_apply',f.request(inverse,'return'));
  f.restart();assert.equal((await f.flow('recipe_apply',firstRequest)).idempotent,true);
});

test('identity-bearing terminal records fail closed and failed creation rolls back reclamation',async t=>{
  const f=fixture(t),keys=['op_id','committed_actor','committed_intent','committed_revision','committed_viewport','return_checkpoint_id','committed_at','returned_at'];
  for(const key of keys){const p=await f.preview();await f.reject(p);f.data.update('proposals',f.workspace_id,f.project.id,p.preview_id,2,{[key]:key==='committed_revision'||key.endsWith('_at')?1:key==='committed_viewport'?{width:1000,height:800}:randomUUID()});}
  const reclaimable=await f.preview();await f.reject(reclaimable);
  f.time=reclaimable.expires_at+1;
  f.store.db.exec("CREATE TRIGGER fail_preview BEFORE INSERT ON wb_proposals BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END");
  const retained=f.all();await assert.rejects(f.preview(),/fixture insert failure/);assert.deepEqual(f.all(),retained);
  f.store.db.exec('DROP TRIGGER fail_preview');await f.preview();
  assert.equal(f.all().length,keys.length+1);assert.ok(!f.all().some(p=>p.id===reclaimable.preview_id));
});
