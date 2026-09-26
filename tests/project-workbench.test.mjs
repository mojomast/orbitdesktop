import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {createWorkbench} from '../server/workbench.mjs';
import {captureProject,readProjectFile,openProjectRoot,repositorySnapshot,PROJECT_LIMITS} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-test-'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum = (a,b) => a - b;\n');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID(),other=randomUUID();
  for(const id of [workspace_id,other])store.commit(commandIdentity({workspace_id:id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  let clock=1000;
  const api=createWorkbench({store,token:'w'.repeat(40),port:4318,devOrigins:[],reply:(res,status,body)=>{res.status=status;res.body=body;},now:()=>clock});
  const call=(action,fields={})=>api.dispatch({action,workspace_id,...fields});
  const register=async()=>{const preview=await call('register_preview',{root:projectRoot,name:'Synthetic defect'});return (await call('register_commit',{approval_id:preview.approval_id})).project;};
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,projectRoot,store,workspace_id,other,api,call,register,advance:()=>{clock+=61000;}};
}
test('explicit registration is owner-scoped, expiring and bound to exact directory incarnation',async t=>{
  const f=fixture(t),preview=await f.call('register_preview',{root:f.projectRoot,name:'Project'});
  assert.equal((await f.call('list')).projects.length,0);
  await assert.rejects(f.api.dispatch({action:'register_commit',workspace_id:f.other,approval_id:preview.approval_id}),{code:'permission_denied'});
  f.advance();await assert.rejects(f.call('register_commit',{approval_id:preview.approval_id}),{code:'expired'});
  const next=await f.call('register_preview',{root:f.projectRoot,name:'Project'});
  fs.renameSync(f.projectRoot,f.projectRoot+'-old');fs.mkdirSync(f.projectRoot);
  await assert.rejects(f.call('register_commit',{approval_id:next.approval_id}),{code:'stale_resource'});
});
test('stable file/resource IDs, exact bounded snapshots, stale previews and cross-project denials',async t=>{
  const f=fixture(t),project=await f.register();
  fs.writeFileSync(path.join(f.projectRoot,'.env'),'DO_NOT_DISCLOSE=synthetic');
  fs.writeFileSync(path.join(f.projectRoot,'binary.bin'),Buffer.from([0,1,2]));
  const before=await f.call('inspect',{project_id:project.id});
  assert.ok(before.snapshot.exclusions.some(e=>e.path==='.env'));
  const resource=before.resources.find(r=>r.path==='math.js');assert.ok(resource.id);
  const file=await f.call('file',{project_id:project.id,resource_id:resource.id});
  assert.equal(file.snapshot.stale,false);assert.match(file.snapshot.text,/a - b/);
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),'export const sum = (a,b) => a + b;\n');
  const after=await f.call('file',{project_id:project.id,resource_id:resource.id});
  assert.equal(after.resource.id,resource.id);assert.equal(after.snapshot.stale,true);assert.notEqual(file.snapshot.hash,after.snapshot.hash);assert.match(file.snapshot.text,/a - b/);
  await assert.rejects(f.api.dispatch({action:'file',workspace_id:f.other,project_id:project.id,resource_id:resource.id}),{code:'permission_denied'});
  await assert.rejects(f.call('file',{project_id:project.id,resource_id:randomUUID()}),{code:'permission_denied'});
  await assert.rejects(f.call('file',{project_id:project.id,resource_id:resource.id,path:'../outside'}),{code:'invalid_request'});
  await assert.rejects(f.call('list',{actor:'owner'}),{code:'invalid_request'});
});
test('descriptor traversal rejects symlink races, hardlinks, special files and bounds large files',async t=>{
  const f=fixture(t),project=await f.register(),privateProject=f.api.records.project(f.workspace_id,project.id);
  const outside=path.join(f.root,'outside');fs.writeFileSync(outside,'SYNTHETIC_NOT_ALLOWED');
  fs.symlinkSync(outside,path.join(f.projectRoot,'escape'));fs.linkSync(outside,path.join(f.projectRoot,'hardlink'));
  execFileSync('/usr/bin/mkfifo',[path.join(f.projectRoot,'pipe')]);
  fs.writeFileSync(path.join(f.projectRoot,'large'),Buffer.alloc(PROJECT_LIMITS.fileBytes+1));
  for(const name of ['escape','hardlink','pipe','large','../outside'])assert.throws(()=>readProjectFile(privateProject,name));
  const original=fs.openSync;let raced=false;
  fs.openSync=function(file,...args){if(typeof file==='string'&&file.endsWith('/math.js')&&!raced){raced=true;fs.unlinkSync(path.join(f.projectRoot,'math.js'));fs.symlinkSync(outside,path.join(f.projectRoot,'math.js'));}return original.call(this,file,...args);};
  try{assert.throws(()=>readProjectFile(privateProject,'math.js'));}finally{fs.openSync=original;}
  assert.equal(raced,true);const capture=captureProject(privateProject);assert.equal(capture.files.length,0);assert.ok(capture.exclusions.length>=5);
  fs.symlinkSync(f.projectRoot,path.join(f.root,'aliased'));assert.throws(()=>openProjectRoot(path.join(f.root,'aliased')));
});
test('Git diff describes the identified dirty copy, never executes configured filters or exposes excluded files',async t=>{
  const f=fixture(t),env={PATH:'/usr/bin:/bin',HOME:f.root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:f.projectRoot,env,stdio:'pipe'});
  git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(f.projectRoot,'.env'),'SECRET=old');git('add','.');git('commit','-m','Synthetic base');
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),'export const sum = (a,b) => a + b;\n');fs.writeFileSync(path.join(f.projectRoot,'.env'),'SECRET=new');
  const marker=path.join(f.root,'should-not-exist');git('config','diff.external',`touch ${marker}`);git('config','core.fsmonitor',`touch ${marker}`);
  const project=await f.register(),capture=captureProject(f.api.records.project(f.workspace_id,project.id));
  const repository=await repositorySnapshot(f.api.records.project(f.workspace_id,project.id),capture);
  assert.equal(repository.state,'available');assert.match(repository.diff,/a \+ b/);assert.ok(!repository.diff.includes('SECRET'));assert.ok(!fs.existsSync(marker));assert.match(repository.head,/^[a-f0-9]{40}$/);
  assert.notEqual(capture.hash,repository.head);assert.ok(capture.manifest.some(file=>file.path==='math.js'));
});
test('metadata bindings preserve layout and resources survive whole-state sync and backup',async t=>{
  const f=fixture(t),project=await f.register(),before=f.store.read(f.workspace_id),snapshot=await f.call('inspect',{project_id:project.id});
  const first=before.state.monitors[0].layout;const leaf=node=>node.type==='pane'?node.pane:leaf(node.first);const pane=leaf(first);
  const request={project_id:project.id,resource_id:snapshot.resources[0].id,pane_id:pane.id,base_revision:before.revision,role:'project_files'};
  assert.equal((await f.call('bind',request)).bindings.length,1);assert.deepEqual(f.store.read(f.workspace_id),before);
  await assert.rejects(f.call('bind',{...request,base_revision:99}),{code:'stale_resource'});
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'sync',base_revision:1,state:before.state,operation_id:randomUUID(),intent:'Old client sync'},'owner'),{apply:()=>before.state});
  assert.equal((await f.call('list')).projects[0].id,project.id);
  const backup=path.join(f.root,'backup.sqlite');await f.store.backup(backup);
  const copy=new Database(backup,{readonly:true});try{assert.equal(copy.prepare('SELECT count(*) AS n FROM wb_projects').get().n,1);assert.equal(copy.prepare('SELECT count(*) AS n FROM wb_bindings').get().n,1);}finally{copy.close();}
});
test('HTTP boundary requires owner Bearer and allowed origin; IDs and confirm cannot authorize',async t=>{
  const f=fixture(t);
  const send=async(headers,body)=>{const req=Readable.from([JSON.stringify(body)]);Object.assign(req,{method:'POST',headers:{host:'127.0.0.1:4318',origin:'http://127.0.0.1:4318',...headers}});const res={headers:{},setHeader(k,v){this.headers[k]=v;}};await f.api.handle(req,res);return res;};
  const body={action:'list',workspace_id:f.workspace_id};
  for(const headers of [{},{authorization:'Bearer '+f.store.read(f.workspace_id).capability},{authorization:'Bearer '+'w'.repeat(40),origin:'https://unapproved.invalid'}])assert.equal((await send(headers,body)).status,403);
  const good=await send({authorization:'Bearer '+'w'.repeat(40)},body);assert.equal(good.status,200);assert.equal(good.headers['Cache-Control'],'no-store');
  assert.equal((await send({authorization:'Bearer '+'w'.repeat(40)},{...body,confirm:true})).status,400);
  assert.equal(f.store.eventPage(f.workspace_id)?.events?.some?.(event=>JSON.stringify(event).includes('math.js'))??false,false);
});
test('schema 4 upgrades additively and backup preserve-schema can retain the old binary format',async t=>{
  const root=fs.mkdtempSync('/tmp/opencode/workbench-migrate-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=new SqliteWorkspaceStore(path.join(root,'source'));store.db.exec('DROP TABLE wb_bindings; DROP TABLE wb_resources; DROP TABLE wb_projects; PRAGMA user_version=4;');
  const backup=path.join(root,'v4.sqlite');await store.backup(backup);store.close();
  const before=fs.readFileSync(backup);
  const result=JSON.parse(execFileSync(process.execPath,['--experimental-strip-types','scripts/workspace_store.mjs','restore','--source',backup,'--runtime',path.join(root,'restored'),'--confirm-stopped','--preserve-schema'],{encoding:'utf8'}));
  assert.equal(result.schema_version,4);assert.deepEqual(fs.readFileSync(backup),before);
  const migrated=new SqliteWorkspaceStore(path.join(root,'restored'));try{assert.equal(migrated.db.pragma('user_version',{simple:true}),5);assert.equal(migrated.db.prepare('SELECT count(*) AS n FROM wb_projects').get().n,0);}finally{migrated.close();}
});

test('revocation fences future and late results, invalidates previews, and requires fresh registration',async t=>{
  const f=fixture(t),project=await f.register();
  const preview=await f.call('register_preview',{root:f.projectRoot,name:'Old preview'});
  const late=f.call('inspect',{project_id:project.id});
  const rejected=assert.rejects(late,{code:'permission_denied'});
  const revoked=await f.call('revoke_project',{project_id:project.id,base_generation:project.generation});
  await rejected;
  assert.equal(revoked.project.active,false);
  await assert.rejects(f.call('inspect',{project_id:project.id}),{code:'permission_denied'});
  await assert.rejects(f.call('register_commit',{approval_id:preview.approval_id}),{code:'permission_denied'});
  const restored=await f.register();assert.equal(restored.id,project.id);assert.ok(restored.generation>revoked.project.generation);
  await assert.rejects(f.call('revoke_project',{project_id:project.id,base_generation:project.generation}),{code:'stale_resource'});
});

test('binding rejects replaced roots even though it never captures private output',async t=>{
  const f=fixture(t),project=await f.register(),capture=await f.call('inspect',{project_id:project.id});
  const pane=(await f.call('list')).surfaces[0];
  fs.renameSync(f.projectRoot,f.projectRoot+'-old');fs.mkdirSync(f.projectRoot);
  await assert.rejects(f.call('bind',{project_id:project.id,resource_id:capture.resources[0].id,pane_id:pane.pane_id,base_revision:1,role:'project_files'}),{code:'stale_resource'});
  await assert.rejects(f.call('link_pane',{project_id:project.id,pane_id:pane.pane_id,base_revision:1}),{code:'stale_resource'});
});

test('binding reassignment requires removing the exact prior ID, not a last-writer overwrite',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.projectRoot,'other.txt'),'second resource');
  const project=await f.register(),capture=await f.call('inspect',{project_id:project.id}),pane=(await f.call('list')).surfaces[0];
  const request={project_id:project.id,resource_id:capture.resources[0].id,pane_id:pane.pane_id,base_revision:1,role:'project_files'};
  const first=(await f.call('bind',request)).bindings[0];
  const second={...request,resource_id:capture.resources[1].id};
  await assert.rejects(f.call('bind',second),{code:'stale_resource'});
  assert.equal((await f.call('bind',request)).bindings[0].id,first.id);
  await f.call('unbind',{project_id:project.id,binding_id:first.id});
  const replaced=(await f.call('bind',second)).bindings[0];assert.notEqual(replaced.id,first.id);
  await assert.rejects(f.call('unbind',{project_id:project.id,binding_id:first.id}),{code:'stale_resource'});
  assert.equal((await f.call('bind',second)).bindings[0].id,replaced.id);
});

test('non-roundtrippable filenames cannot alias a literal replacement-character resource',async t=>{
  const f=fixture(t),project=await f.register();
  fs.writeFileSync(Buffer.concat([Buffer.from(f.projectRoot+'/'),Buffer.from([255]),Buffer.from('.txt')]),'malformed filename');
  fs.writeFileSync(path.join(f.projectRoot,'\uFFFD.txt'),'literal replacement filename');
  const capture=await f.call('inspect',{project_id:project.id});
  assert.ok(capture.resources.every(resource=>!resource.path?.includes('\uFFFD')));
  assert.ok(capture.snapshot.exclusions.some(entry=>entry.path.includes('\uFFFD')));
});
