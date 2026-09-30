import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SqliteWorkspaceStore } from '../server/sqlite-workspace-store.mjs';
import { createExtensionStudio } from '../server/extension-studio.mjs';
import { commandIdentity } from '../server/command-identity.mjs';
import { initial } from '../src/model.ts';
import { applyOperation } from '../src/workspace-ops.ts';
import { pluginSelector } from '../src/plugins.ts';

function fixture(t){
 const root=fs.mkdtempSync('/tmp/opencode/plugin-instance-policy-'),workspace_id=randomUUID(),store=new SqliteWorkspaceStore(root);
 t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
 const studio=createExtensionStudio({store}),call=body=>studio.dispatch({workspace_id,...body});
 const mutate=change=>store.commit(commandIdentity({workspace_id,action:'apply',base_revision:store.read(workspace_id).revision,operation_id:randomUUID()},'owner'),change);
 return {store,workspace_id,call,mutate,read:()=>store.read(workspace_id)};
}

async function installed(f){
 const {draft}=await f.call({action:'draft',operation_id:randomUUID(),spec:{id:'timer',title:'Timer',version:'1.0.0',minutes:25,accent:'#b5f268'}});
 await f.call({action:'check',draft_id:draft.id});
 const {proposal}=await f.call({action:'preview',draft_id:draft.id,operation_id:randomUUID()});
 await f.call({action:'install',proposal_id:proposal.id,artifact_digest:proposal.artifact_digest,preview_digest:proposal.preview_digest,operation_id:randomUUID(),confirm:true});
 f.mutate({apply:r=>applyOperation(r.state,{action:'plugin_duplicate',plugin_id:'timer'})});
 return draft;
}

test('recovery hold disables every sibling and fences active snapshot restoration and individual activation',async t=>{
 const f=fixture(t);await installed(f);const active=f.read().state;
 assert.equal(active.plugins.filter(p=>p.enabled).length,2);
 f.mutate({recoveryPolicy:true});const held=f.read().state;
 assert.ok(held.plugins.every(p=>!p.enabled));assert.ok(held.plugins.every(p=>!held.monitors.some(m=>m.id===p.window.id)));
 for(const p of held.plugins)assert.throws(()=>f.mutate({apply:r=>applyOperation(r.state,{action:'plugin_enable',...pluginSelector(p)})}));
 assert.throws(()=>f.mutate({apply:()=>active}));
 f.mutate({recoveryPolicy:false});assert.ok(f.read().state.plugins.every(p=>!p.enabled));
});

test('Studio revocation detaches every sibling and rejects duplicate/enable/restore activation of the revoked release',async t=>{
 const f=fixture(t),draft=await installed(f),active=f.read().state;
 await f.call({action:'revoke',draft_id:draft.id,base_revision:f.read().revision,operation_id:randomUUID(),confirm:true});
 const disabled=f.read().state;assert.ok(disabled.plugins.every(p=>!p.enabled));assert.equal(disabled.plugins.length,2);
 for(const p of disabled.plugins)assert.throws(()=>f.mutate({apply:r=>applyOperation(r.state,{action:'plugin_enable',...pluginSelector(p)})}),{category:'STUDIO_RELEASE_REVOKED'});
 assert.throws(()=>f.mutate({apply:()=>active}),{category:'STUDIO_RELEASE_REVOKED'});
 assert.throws(()=>f.mutate({apply:()=>applyOperation(active,{action:'plugin_duplicate',plugin_id:'timer'})}),{category:'STUDIO_RELEASE_REVOKED'});
});
