import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {createExtensionStudio} from '../server/extension-studio.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';

const spec={id:'focus-timer',title:'Focus <&> timer',version:'1.0.0',minutes:25,accent:'#b5f268'};
function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/studio-test-'),workspace_id=randomUUID();
  let store=new SqliteWorkspaceStore(root),clock=1000,studio=createExtensionStudio({store,now:()=>clock});
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const call=body=>studio.dispatch({workspace_id,...body});
  const mutate=change=>store.commit(commandIdentity({workspace_id,action:'apply',base_revision:store.read(workspace_id).revision,operation_id:randomUUID()},'owner'),change);
  const draft=async patch=>(await call({action:'draft',operation_id:randomUUID(),spec:{...spec,...patch}})).draft;
  const prepare=async d=>{await call({action:'check',draft_id:d.id});return (await call({action:'preview',draft_id:d.id,operation_id:randomUUID()})).proposal;};
  const installBody=p=>({action:'install',proposal_id:p.id,artifact_digest:p.artifact_digest,preview_digest:p.preview_digest,operation_id:randomUUID(),confirm:true});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,workspace_id,call,mutate,draft,prepare,installBody,get store(){return store;},time:t=>{clock=t;},restart:()=>{store.close();store=new SqliteWorkspaceStore(root);studio=createExtensionStudio({store,now:()=>clock});}};
}
test('Studio publishes exact bytes, persists draft/check/proposal across restart and recovers an expired installed receipt',async t=>{
  const f=fixture(t),before=f.store.read(f.workspace_id).state;
  const d=await f.draft(),p=await f.prepare(d),body=f.installBody(p);
  assert.equal(p.base_revision,1);assert.equal(f.store.read(f.workspace_id).revision,1);
  f.restart();const result=await f.call(body);
  assert.equal(result.artifact_digest,d.artifact_digest);assert.equal(result.revision,2);
  const installed=f.store.read(f.workspace_id).state;
  assert.equal(installed.plugins[0].manifest.entry,d.manifest.entry);
  assert.deepEqual(installed.monitors.slice(0,before.monitors.length),before.monitors);
  assert.equal(f.store.checkpointGet(f.workspace_id,result.checkpoint_id).state.plugins,undefined);
  f.time(90000);f.restart();assert.equal((await f.call(body)).replayed,true);
  assert.equal(f.store.read(f.workspace_id).revision,2);
  const {files}=await f.call({action:'get',draft_id:d.id});assert.match(files['index.html'],/Focus &lt;&amp;&gt; timer/);
  assert.equal((await f.call({action:'list'})).drafts.length,1);
});
test('Studio refuses substituted digest, stale review, expired review and unreviewed install',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.prepare(d);
  await assert.rejects(f.call({...f.installBody(p),artifact_digest:'f'.repeat(64)}),{code:'conflict'});
  await assert.rejects(f.call({action:'preview',draft_id:(await f.draft({id:'unchecked'})).id,operation_id:randomUUID()}),{code:'unavailable'});
  f.mutate({apply:r=>r.state});await assert.rejects(f.call(f.installBody(p)),{code:'stale_resource'});
  const next=await f.prepare(d);f.time(70000);await assert.rejects(f.call(f.installBody(next)),{code:'expired'});
  assert.equal(f.store.read(f.workspace_id).state.plugins,undefined);
});
test('release update and release rollback retain later configuration and original window/pane identities',async t=>{
  const f=fixture(t),a=await f.draft();await f.call(f.installBody(await f.prepare(a)));
  const original=f.store.read(f.workspace_id).state.plugins[0];
  f.mutate({apply:r=>applyOperation(r.state,{action:'plugin_configure',plugin_id:spec.id,config:{minutes:42,note:'later public setting'}})});
  const b=await f.draft({version:'2.0.0',accent:'#ffaa00'});await f.call(f.installBody(await f.prepare(b)));
  f.mutate({apply:r=>applyOperation(r.state,{action:'plugin_patch_config',plugin_id:spec.id,patch:{minutes:37}})});
  const rollback=await f.prepare(a);assert.equal(rollback.preview_config.minutes,37);await f.call(f.installBody(rollback));
  const final=f.store.read(f.workspace_id).state.plugins[0];assert.deepEqual(final.config,{minutes:37,note:'later public setting'});
  assert.equal(final.window.id,original.window.id);assert.equal(final.window.layout.pane.id,original.window.layout.pane.id);
  assert.equal(final.manifest.entry,a.manifest.entry);assert.ok(fs.existsSync(path.join(f.root,b.manifest.entry)));
});
test('revocation is durable, disables registered instance and blocks install, controller enable and layout undo',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.prepare(d),body=f.installBody(p);await f.call(body);
  const active=f.store.read(f.workspace_id).state;
  await f.call({action:'revoke',draft_id:d.id,operation_id:randomUUID(),base_revision:2,confirm:true});f.restart();
  assert.equal(f.store.read(f.workspace_id).state.plugins[0].enabled,false);
  await assert.rejects(f.call(body),{code:'revoked'});
  await assert.rejects(f.call({action:'check',draft_id:d.id}),{code:'revoked'});
  assert.throws(()=>f.mutate({apply:r=>applyOperation(r.state,{action:'plugin_enable',plugin_id:spec.id})}),{category:'STUDIO_RELEASE_REVOKED'});
  assert.throws(()=>f.mutate({apply:()=>active}),{category:'STUDIO_RELEASE_REVOKED'});
  const same=await f.draft();assert.equal(same.revoked,true);await assert.rejects(f.prepare(same),{code:'revoked'});
});
test('hold removes optional surfaces; release never enables them or validates an older review',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.prepare(d);await f.call(f.installBody(p));const next=await f.prepare(d);
  f.mutate({recoveryPolicy:true});assert.equal(f.store.read(f.workspace_id).state.plugins[0].enabled,false);
  await assert.rejects(f.call({action:'get',draft_id:d.id}),{code:'permission_denied'});
  f.mutate({recoveryPolicy:false});f.restart();assert.equal(f.store.read(f.workspace_id).state.plugins[0].enabled,false);
  await assert.rejects(f.call(f.installBody(next)),{code:'stale_resource'});
  const disabledUpdate=await f.prepare(d);await f.call(f.installBody(disabledUpdate));assert.equal(f.store.read(f.workspace_id).state.plugins[0].enabled,false);
});
test('publication tampering and extra source files fail closed before install',async t=>{
  const f=fixture(t),d=await f.draft(),p=await f.prepare(d),directory=path.dirname(path.join(f.root,d.manifest.entry));
  fs.writeFileSync(path.join(directory,'extra.js'),'alert(1)');await assert.rejects(f.call(f.installBody(p)),{code:'conflict'});
  fs.unlinkSync(path.join(directory,'extra.js'));fs.appendFileSync(path.join(directory,'timer.js'),'\nfetch("https://example.test")');
  await assert.rejects(f.call(f.installBody(p)));assert.equal(f.store.read(f.workspace_id).revision,1);
});
test('strict finite profile, actor-scoped operation identity and workspace separation',async t=>{
  const f=fixture(t),operation_id=randomUUID(),body={action:'draft',operation_id,spec};
  await assert.rejects(f.call({...body,source:'arbitrary code'}),{code:'invalid_request'});
  await assert.rejects(f.call({...body,spec:{...spec,minutes:0}}),{code:'invalid_request'});
  const [a,b]=await Promise.all([f.call(body),f.call(body)]);assert.equal(a.draft.id,b.draft.id);
  await assert.rejects(f.call({...body,spec:{...spec,title:'Changed'}}),{code:'conflict'});
  await assert.rejects(f.call({action:'get',draft_id:a.draft.id,workspace_id:randomUUID()}));
});
test('real schema-10 database upgrades without rewriting state; archived writer refuses the Studio revocation schema',async t=>{
  const root=fs.mkdtempSync('/tmp/opencode/studio-schema-'),source=path.join(root,'source'),runtime=path.join(root,'runtime');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(source);
  const repo=fileURLToPath(new URL('../',import.meta.url));
  const archive=execFileSync('git',['archive','--format=tar','a15d7eb947d0c5936ce7ac66b5cda0ce49b5fea3'],{cwd:repo,maxBuffer:64*1024*1024});
  execFileSync('tar',['-xf','-','-C',source],{input:archive,maxBuffer:64*1024*1024});
  fs.symlinkSync(path.join(repo,'node_modules'),path.join(source,'node_modules'),'dir');
  const {SqliteWorkspaceStore:Old}=await import(pathToFileURL(path.join(source,'server/sqlite-workspace-store.mjs')).href);
  const old=new Old(runtime),workspace_id=randomUUID();
  old.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
  const before=old.read(workspace_id);assert.equal(old.diagnostics().schema_version,10);old.close();
  const upgraded=new SqliteWorkspaceStore(runtime);assert.equal(upgraded.diagnostics().schema_version,11);assert.deepEqual(upgraded.read(workspace_id),before);upgraded.close();
  assert.throws(()=>new Old(runtime),{category:'UPGRADE_REQUIRED'});
});
