// Adversarial confinement tests for the Comet Project Workbench owner API.
//
// These tests target the Slice A surface (server/project-files.mjs,
// server/workbench.mjs, server/workbench-store.mjs, contracts/workbench-v1.mjs).
// They only ever use disposable roots under /tmp/opencode and never touch an owner
// runtime, .runtime, dist, credentials, terminals or live services.
//
// All tests here are strict: there are no `todo`, `skip` or retry-to-green paths.
// The global capture traversal budget is asserted directly. Remaining confirmed
// open findings are reported to the parent with reproducers instead of being
// encoded as failing assertions that would redden the shared `npm run check`:
//   - server/project-files.mjs repositorySnapshot scratch is same-UID writable and
//     git reads scratch-local config, so a racer can enable a clean filter that
//     executes (reproduced: marker executed, state 'available').
//   - server/workbench.mjs `file` returns replacement bytes and only flags `stale`
//     (reproduced: swapped content returned).
//   - `.gitattributes` `diff` forces binary/NUL content into repository diffs
//     (reproduced; --no-textconv does not disable the built-in diff attribute).
//   - link_pane/bind accept a stale root and bindings have no independent CAS.
//   - Git loose-object limits bound compressed bytes, not inflated memory, and
//     concurrent inspects are not capacity-limited.
//   - a root-identity failure after scratch creation leaks the scratch directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {createWorkbench} from '../server/workbench.mjs';
import {captureProject,readProjectFile,openProjectRoot,repositorySnapshot,PROJECT_LIMITS} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const TOKEN='w'.repeat(40);

function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/workbench-adversarial-');
  const projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
  const scratchRoot=path.join(root,'scratch');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime'));
  const workspace_id=randomUUID(),other=randomUUID();
  for(const id of [workspace_id,other])store.commit(commandIdentity({workspace_id:id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Adversarial fixture'},'owner'),{create:()=>({id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  let clock=1000;
  const api=createWorkbench({store,token:TOKEN,port:4318,devOrigins:[],reply:(res,status,body)=>{res.status=status;res.body=body;},now:()=>clock});
  const call=(action,fields={})=>api.dispatch({action,workspace_id,...fields});
  const preview=async(root=projectRoot,name='Adversarial')=>call('register_preview',{root,name});
  const register=async(root=projectRoot,name='Adversarial')=>{const p=await preview(root,name);return (await call('register_commit',{approval_id:p.approval_id})).project;};
  const privateProject=id=>api.records.project(workspace_id,id);
  const send=async(headers,body)=>{const req=Readable.from([JSON.stringify(body)]);Object.assign(req,{method:'POST',headers:{host:'127.0.0.1:4318',origin:'http://127.0.0.1:4318',...headers}});const res={headers:{},setHeader(k,v){this.headers[k]=v;}};await api.handle(req,res);return res;};
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,projectRoot,scratchRoot,store,workspace_id,other,api,call,preview,register,privateProject,send,advance:(ms=61000)=>{clock+=ms;}};
}

test('project root descriptor rejects non-canonical, relative, root, NUL and non-directory paths',async t=>{
  const f=fixture(t);
  for(const bad of ['relative/path','/','//tmp',f.projectRoot+'/',f.projectRoot+'/.',f.projectRoot+'/../'+path.basename(f.projectRoot),'/tmp/\0x',path.join(f.root,'missing')]) assert.throws(()=>openProjectRoot(bad),/unsupported|permission_denied|unavailable/,`accepted ${JSON.stringify(bad)}`);
  fs.writeFileSync(path.join(f.root,'plain'),'x');assert.throws(()=>openProjectRoot(path.join(f.root,'plain')));
  fs.symlinkSync(f.projectRoot,path.join(f.root,'alias'));assert.throws(()=>openProjectRoot(path.join(f.root,'alias')));
  const held=openProjectRoot(f.projectRoot);assert.match(held.identity,/^\d+:\d+$/);held.close();
});

test('descriptor confinement denies nested symlinks, hardlinks, FIFOs, sockets and large files',async t=>{
  const f=fixture(t);const project=await f.register();const bound=f.privateProject(project.id);
  const outside=path.join(f.root,'outside');fs.writeFileSync(outside,'SYNTHETIC_DO_NOT_DISCLOSE');
  fs.mkdirSync(path.join(f.projectRoot,'sub'));
  fs.symlinkSync(outside,path.join(f.projectRoot,'sub','leak.js'));
  fs.symlinkSync(f.root,path.join(f.projectRoot,'dirlink'));
  fs.linkSync(outside,path.join(f.projectRoot,'hard.js'));
  execFileSync('/usr/bin/mkfifo',[path.join(f.projectRoot,'pipe')]);
  const socketPath=path.join(f.projectRoot,'sock');
  const server=net.createServer();server.listen(socketPath);await new Promise(resolve=>server.once('listening',resolve));
  fs.writeFileSync(path.join(f.projectRoot,'.env'),'DO_NOT_DISCLOSE=synthetic');
  fs.writeFileSync(path.join(f.projectRoot,'id.pem'),'-----BEGIN PRIVATE KEY-----');
  fs.writeFileSync(path.join(f.projectRoot,'big.js'),Buffer.alloc(PROJECT_LIMITS.fileBytes+1));
  try{
    for(const relative of ['sub/leak.js','dirlink/outside','hard.js','pipe','sock','big.js','.env','id.pem','../outside','/etc/passwd'])
      assert.throws(()=>readProjectFile(bound,relative),(error)=>['permission_denied','unsupported','limit_exceeded'].includes(error.code),`read ${relative}`);
    const capture=captureProject(bound);
    assert.ok(!capture.files.some(file=>['hard.js','pipe','sock','big.js','.env','id.pem','sub/leak.js'].includes(file.path)),'excluded file disclosed');
    const reasons=Object.fromEntries(capture.exclusions.map(entry=>[entry.path,entry.reason]));
    assert.equal(reasons['.env'],'excluded_by_policy');
    assert.equal(reasons['id.pem'],'excluded_by_policy');
    assert.equal(reasons['big.js'],'file_size_limit');
    assert.equal(reasons['pipe'],'unsupported_special_file');
    assert.ok(['unsupported_special_file','unavailable_or_unsupported'].includes(reasons['sock']));
    assert.equal(reasons['hard.js'],'unavailable_or_unsupported');
    assert.ok(!JSON.stringify(capture.manifest).includes('DO_NOT_DISCLOSE'));
  }finally{server.close();}
});

test('git materialization refuses linked worktrees and common-dir indirection',async t=>{
  const f=fixture(t);const fileRoot=path.join(f.root,'worktree');fs.mkdirSync(fileRoot);
  fs.writeFileSync(path.join(fileRoot,'.git'),'gitdir: /tmp/opencode/elsewhere/.git\n');
  const fileProject=await f.register(fileRoot,'Gitfile');
  const fileSnapshot=await repositorySnapshot(f.privateProject(fileProject.id),captureProject(f.privateProject(fileProject.id)),{scratchRoot:f.scratchRoot});
  assert.equal(fileSnapshot.state,'unavailable');
  const commonRoot=path.join(f.root,'common');fs.mkdirSync(path.join(commonRoot,'.git'),{recursive:true});
  fs.writeFileSync(path.join(commonRoot,'.git','commondir'),'../elsewhere\n');
  const commonProject=await f.register(commonRoot,'Common');
  const commonSnapshot=await repositorySnapshot(f.privateProject(commonProject.id),captureProject(f.privateProject(commonProject.id)),{scratchRoot:f.scratchRoot});
  assert.equal(commonSnapshot.state,'unavailable');
  const gitdirRoot=path.join(f.root,'gitdir');fs.mkdirSync(path.join(gitdirRoot,'.git'),{recursive:true});
  fs.writeFileSync(path.join(gitdirRoot,'.git','gitdir'),'/tmp/opencode/elsewhere\n');
  const gitdirProject=await f.register(gitdirRoot,'Gitdir');
  const gitdirSnapshot=await repositorySnapshot(f.privateProject(gitdirProject.id),captureProject(f.privateProject(gitdirProject.id)),{scratchRoot:f.scratchRoot});
  assert.equal(gitdirSnapshot.state,'unavailable');
});

test('git materialization never executes copied config, hooks, filters, textconv or alternates',async t=>{
  const f=fixture(t);const marker=path.join(f.root,'should-not-exist');
  fs.writeFileSync(path.join(f.root,'.gitconfig'),`[alias]\n\tpwn = !touch ${marker}\n[include]\n\tpath = /etc/passwd\n`);
  const env={PATH:'/usr/bin:/bin',HOME:f.root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const git=(...args)=>execFileSync('/usr/bin/git',args,{cwd:f.projectRoot,env,stdio:'pipe'});
  git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
  fs.writeFileSync(path.join(f.projectRoot,'.env'),'SECRET=old');
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),'export const sum=(a,b)=>a+b;\n');
  git('add','.');git('commit','-m','base');
  fs.writeFileSync(path.join(f.projectRoot,'math.js'),'export const sum=(a,b)=>a-b;\n');
  fs.writeFileSync(path.join(f.projectRoot,'.env'),'SECRET=new');
  const hooks=path.join(f.projectRoot,'.git','hooks');fs.mkdirSync(hooks,{recursive:true});
  fs.writeFileSync(path.join(hooks,'pre-commit'),`#!/bin/sh\ntouch ${marker}\n`);fs.chmodSync(path.join(hooks,'pre-commit'),0o755);
  git('config','core.hooksPath',hooks);
  git('config','diff.external',`touch ${marker}`);
  git('config','core.fsmonitor',`touch ${marker}`);
  git('config','filter.evil.smudge',`touch ${marker}`);
  git('config','alias.pwn',`!touch ${marker}`);
  git('config','include.path','/etc/passwd');
  fs.writeFileSync(path.join(f.projectRoot,'.gitattributes'),'*.js filter=evil diff=evil\n');
  fs.mkdirSync(path.join(f.projectRoot,'.git','objects','info'),{recursive:true});
  fs.writeFileSync(path.join(f.projectRoot,'.git','objects','info','alternates'),path.join(f.root,'alternate-objects')+'\n');
  const project=await f.register();
  const bound=f.privateProject(project.id);
  const capture=captureProject(bound);
  const snapshot=await repositorySnapshot(bound,capture,{scratchRoot:f.scratchRoot});
  assert.equal(snapshot.state,'available');
  assert.match(snapshot.diff,/a-b/);
  assert.ok(!snapshot.diff.includes('SECRET'),'excluded secret appeared in diff');
  assert.ok(!fs.existsSync(marker),'configured git command executed');
  assert.match(snapshot.head,/^[a-f0-9]{40}$/);
});

test('git materialization enforces git file and byte bounds',async t=>{
  const f=fixture(t);const many=path.join(f.root,'many');fs.mkdirSync(path.join(many,'.git'),{recursive:true});
  for(let i=0;i<PROJECT_LIMITS.gitFiles+25;i++)fs.writeFileSync(path.join(many,'.git','f'+i),'x');
  const manyProject=await f.register(many,'Many');
  const manySnapshot=await repositorySnapshot(f.privateProject(manyProject.id),captureProject(f.privateProject(manyProject.id)),{scratchRoot:f.scratchRoot});
  assert.equal(manySnapshot.state,'unavailable');
  const huge=path.join(f.root,'huge');fs.mkdirSync(path.join(huge,'.git'),{recursive:true});
  fs.writeFileSync(path.join(huge,'.git','objects'),Buffer.alloc(PROJECT_LIMITS.gitBytes+1));
  const hugeProject=await f.register(huge,'Huge');
  const hugeSnapshot=await repositorySnapshot(f.privateProject(hugeProject.id),captureProject(f.privateProject(hugeProject.id)),{scratchRoot:f.scratchRoot});
  assert.equal(hugeSnapshot.state,'unavailable');
});

test('capture enforces file, byte, depth and size bounds and never reads excluded names',async t=>{
  const f=fixture(t);
  const countRoot=path.join(f.root,'count');fs.mkdirSync(countRoot);
  for(let i=0;i<PROJECT_LIMITS.files+80;i++)fs.writeFileSync(path.join(countRoot,`f${i}.js`),'x');
  const countProject=await f.register(countRoot,'Count');
  const countCapture=captureProject(f.privateProject(countProject.id));
  assert.equal(countCapture.limited,true);assert.ok(countCapture.files.length<=PROJECT_LIMITS.files);
  const deepRoot=path.join(f.root,'deep');fs.mkdirSync(deepRoot);
  let cursor=deepRoot;
  for(let i=0;i<PROJECT_LIMITS.depth+3;i++){cursor=path.join(cursor,`d${i}`);fs.mkdirSync(cursor);}
  fs.writeFileSync(path.join(cursor,'deep.js'),'deep\n');
  const deepProject=await f.register(deepRoot,'Deep');
  const deepCapture=captureProject(f.privateProject(deepProject.id));
  assert.equal(deepCapture.limited,true);assert.ok(deepCapture.exclusions.some(entry=>entry.reason==='depth_limit'));
  const totalRoot=path.join(f.root,'total');fs.mkdirSync(totalRoot);
  for(let i=0;i<48;i++)fs.writeFileSync(path.join(totalRoot,`p${i}.bin`),Buffer.alloc(200000));
  const totalProject=await f.register(totalRoot,'Total');
  const totalCapture=captureProject(f.privateProject(totalProject.id));
  assert.equal(totalCapture.limited,true);assert.ok(totalCapture.total_bytes<=PROJECT_LIMITS.totalBytes);
});

// The walk enforces global visited-directory (PROJECT_LIMITS.directories) and
// visited-entry (PROJECT_LIMITS.entries) budgets before descending, sets
// limited=true and records a `traversal_budget` exclusion. These assertions use
// real over-budget trees and real counts, and also prove a small tree is not
// falsely reported as limited.
test('captureProject enforces global entry and directory traversal budgets with real counts',async t=>{
  const f=fixture(t);
  const dirRoot=path.join(f.root,'dirs');fs.mkdirSync(dirRoot);
  for(let i=0;i<PROJECT_LIMITS.directories+40;i++){const level=path.join(dirRoot,`d${i}`);fs.mkdirSync(level);fs.writeFileSync(path.join(level,'f.js'),'x\n');}
  const dirProject=await f.register(dirRoot,'Dirs');
  const dirCapture=captureProject(f.privateProject(dirProject.id));
  assert.equal(dirCapture.limited,true,'directory budget was not reported');
  assert.ok(dirCapture.exclusions.some(entry=>entry.reason==='traversal_budget'),'expected a traversal_budget exclusion');
  assert.ok(dirCapture.files.length<=PROJECT_LIMITS.directories,`visited ${dirCapture.files.length} files beyond the directory budget`);

  const entryRoot=path.join(f.root,'entries');fs.mkdirSync(entryRoot);
  // Exceed the global entry budget across many directories without tripping the
  // 512-name per-directory cap or the 128-directory budget first. `.env.*` names
  // are policy-excluded, so no file bytes are stored while every readdir entry is
  // still counted (100 dirs x 25 + 100 = 2600 > PROJECT_LIMITS.entries).
  for(let i=0;i<100;i++){const level=path.join(entryRoot,`e${i}`);fs.mkdirSync(level);for(let j=0;j<25;j++)fs.writeFileSync(path.join(level,`.env.${j}`),'x\n');}
  const entryProject=await f.register(entryRoot,'Entries');
  const entryCapture=captureProject(f.privateProject(entryProject.id));
  assert.equal(entryCapture.limited,true,'entry budget was not reported');
  assert.ok(entryCapture.exclusions.some(entry=>entry.reason==='traversal_budget'),'expected an entry traversal_budget exclusion');
  assert.ok(entryCapture.files.length<=PROJECT_LIMITS.files);

  const smallRoot=path.join(f.root,'small');fs.mkdirSync(smallRoot);
  fs.writeFileSync(path.join(smallRoot,'a.js'),'a\n');
  const smallProject=await f.register(smallRoot,'Small');
  const smallCapture=captureProject(f.privateProject(smallProject.id));
  assert.equal(smallCapture.limited,false,'small tree was falsely reported as limited');
  assert.deepEqual(smallCapture.files.map(file=>file.path),['a.js']);
});

test('HTTP boundary requires owner bearer, allowed origin, strict body and rejects controller capability',async t=>{
  const f=fixture(t);const body={action:'list',workspace_id:f.workspace_id};
  assert.equal((await f.send({},body)).status,403);
  assert.equal((await f.send({authorization:'Bearer '+f.store.read(f.workspace_id).capability},body)).status,403);
  assert.equal((await f.send({authorization:'Bearer '+TOKEN,origin:'https://unapproved.invalid'},body)).status,403);
  assert.equal((await f.send({authorization:'Bearer '+'x'.repeat(40)},body)).status,403);
  const good=await f.send({authorization:'Bearer '+TOKEN},body);
  assert.equal(good.status,200);assert.equal(good.headers['Cache-Control'],'no-store');
  assert.equal((await f.send({authorization:'Bearer '+TOKEN},{...body,confirm:true})).status,400);
  assert.equal((await f.send({authorization:'Bearer '+TOKEN},{action:'inspect',workspace_id:f.workspace_id,project_id:randomUUID(),extra:1})).status,400);
  const big=Readable.from(['x'.repeat(20000)]);Object.assign(big,{method:'POST',headers:{host:'127.0.0.1:4318',origin:'http://127.0.0.1:4318',authorization:'Bearer '+TOKEN}});
  const res={status:undefined,setHeader(){}};await f.api.handle(big,res);assert.equal(res.status,413);
});

test('registration approvals are owner-bound, workspace-bound, expiring, single-use and capped',async t=>{
  const f=fixture(t);
  await assert.rejects(f.call('register_commit',{approval_id:randomUUID()}),{code:'permission_denied'});
  const cross=await f.preview();await assert.rejects(f.api.dispatch({action:'register_commit',workspace_id:f.other,approval_id:cross.approval_id}),{code:'permission_denied'});
  const expiring=await f.preview();f.advance();await assert.rejects(f.call('register_commit',{approval_id:expiring.approval_id}),{code:'expired'});
  const once=await f.preview();await f.call('register_commit',{approval_id:once.approval_id});await assert.rejects(f.call('register_commit',{approval_id:once.approval_id}),{code:'permission_denied'});
  let clock=1000;
  const capStore=new SqliteWorkspaceStore(path.join(f.root,'cap-runtime'));
  const capWorkspace=randomUUID();
  capStore.commit(commandIdentity({workspace_id:capWorkspace,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'cap'},'owner'),{create:()=>({id:capWorkspace,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const capApi=createWorkbench({store:capStore,token:TOKEN,port:4318,devOrigins:[],reply:()=>{},now:()=>clock});
  t.after(()=>capStore.close());
  let busy=false;
  try{for(let i=0;i<40;i++){clock+=1000;await capApi.dispatch({action:'register_preview',workspace_id:capWorkspace,root:f.projectRoot,name:'cap'+i});}}catch(error){busy=error.code==='busy';}
  assert.equal(busy,true,'approval map was not bounded');
});

test('registered root incarnation is re-verified before commit, inspect and file reads',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.projectRoot,'a.js'),'export const a=1;\n');
  const pending=await f.preview();
  fs.renameSync(f.projectRoot,f.projectRoot+'-old');fs.mkdirSync(f.projectRoot);
  await assert.rejects(f.call('register_commit',{approval_id:pending.approval_id}),{code:'stale_resource'});
  fs.rmSync(f.projectRoot,{recursive:true,force:true});fs.renameSync(f.projectRoot+'-old',f.projectRoot);
  const project=await f.register();
  const before=await f.call('inspect',{project_id:project.id});
  const resource=before.resources.find(entry=>entry.path==='a.js');assert.ok(resource);
  fs.renameSync(f.projectRoot,f.projectRoot+'-old2');fs.mkdirSync(f.projectRoot);
  await assert.rejects(f.call('inspect',{project_id:project.id}),{code:'stale_resource'});
  await assert.rejects(f.call('file',{project_id:project.id,resource_id:resource.id}),{code:'stale_resource'});
});

test('workbench binding is metadata-only, projects linked surfaces, and exposes no execution or agent tools',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.projectRoot,'a.js'),'export const a=1;\n');
  const project=await f.register();const before=f.store.read(f.workspace_id);
  const inspect=await f.call('inspect',{project_id:project.id});
  assert.equal(inspect.execution.state,'not_enabled');assert.deepEqual(inspect.execution.tasks,[]);assert.deepEqual(inspect.execution.jobs,[]);
  const doctor=await f.call('doctor');
  assert.match(doctor.server_build,/^[a-f0-9]{64}$/);
  assert.match(doctor.execution,/not enabled/);assert.match(doctor.gateway_compatibility,/agent tools disabled/);
  const leaf=node=>node.type==='pane'?node.pane:leaf(node.first);
  const pane=leaf(before.state.monitors[0].layout);
  const linked=await f.call('link_pane',{project_id:project.id,pane_id:pane.id,base_revision:before.revision});
  assert.equal(linked.resource.kind,'terminal');assert.equal(linked.resource.state,'linked_metadata_only');
  assert.equal(linked.bindings.find(binding=>binding.pane_id===pane.id).role,'active_terminal');
  assert.deepEqual(f.store.read(f.workspace_id),before,'link_pane mutated the layout');
  // Metadata-linked non-file resources are projected live: linked while the pane
  // still exists, stale_surface once the layout no longer carries it.
  const projected=await f.call('inspect',{project_id:project.id});
  assert.equal(projected.resources.find(resource=>resource.id===linked.resource.id).state,'linked_metadata_only');
  const movedState=structuredClone(before.state);movedState.monitors[0].layout.pane.id=randomUUID();
  f.store.commit(commandIdentity({workspace_id:f.workspace_id,action:'sync',base_revision:before.revision,state:movedState,operation_id:randomUUID(),intent:'Move pane surface'},'owner'),{apply:()=>movedState});
  const reprojected=await f.call('inspect',{project_id:project.id});
  assert.equal(reprojected.resources.find(resource=>resource.id===linked.resource.id).state,'stale_surface');
  await assert.rejects(f.call('link_pane',{project_id:project.id,pane_id:pane.id,base_revision:999}),{code:'stale_resource'});
  await assert.rejects(f.call('file',{project_id:project.id,resource_id:linked.resource.id}),{code:'unsupported'});
});

test('inspect admits at most two concurrent observations and rejects the third with busy',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.projectRoot,'a.js'),'export const a=1;\n');
  const project=await f.register();
  // All three dispatches start in the same tick; the first two suspend on the
  // awaited Git materialization while the third sees the in-flight counter at 2.
  const settled=await Promise.allSettled([0,1,2].map(()=>f.call('inspect',{project_id:project.id})));
  assert.equal(settled.filter(result=>result.status==='fulfilled').length,2);
  assert.equal(settled.filter(result=>result.status==='rejected'&&result.reason.code==='busy').length,1);
  const followup=await f.call('inspect',{project_id:project.id});
  assert.equal(followup.execution.state,'not_enabled');
});
