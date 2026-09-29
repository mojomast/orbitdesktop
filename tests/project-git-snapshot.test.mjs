import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {captureProject,openProjectRoot,readProjectFile,repositorySnapshot,PROJECT_LIMITS} from '../server/project-files.mjs';

function fixture(t){
  const home=fs.mkdtempSync('/tmp/opencode/git-snapshot-');
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const root=path.join(home,'project');
  fs.mkdirSync(root);
  return {home,root,scratchRoot:path.join(home,'scratch')};
}

function gitIn(dir,home,...args){
  return execFileSync('/usr/bin/git',args,{cwd:dir,env:{PATH:'/usr/bin:/bin',HOME:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:'pipe'});
}

function commit(root,home){
  gitIn(root,home,'init');
  gitIn(root,home,'config','user.email','snapshot@example.invalid');
  gitIn(root,home,'config','user.name','Snapshot Fixture');
  gitIn(root,home,'add','.');
  gitIn(root,home,'commit','-m','base');
}

function makeProject(root){
  const opened=openProjectRoot(root);
  try{return {root,identity:opened.identity};}
  finally{opened.close();}
}

async function snapshotFor(f){
  const project=makeProject(f.root);
  const capture=captureProject(project);
  return repositorySnapshot(project,capture,{scratchRoot:f.scratchRoot});
}

function withCrossDeviceStat(action){
  const original=fs.fstatSync;
  let calls=0;
  fs.fstatSync=function(...args){
    const stat=original.apply(this,args);
    if(calls++===0)return stat;
    const clone=Object.create(Object.getPrototypeOf(stat));
    Object.assign(clone,stat);
    clone.dev=stat.dev+1;
    return clone;
  };
  try{return action();}
  finally{fs.fstatSync=original;}
}

test('repository attributes and configured filters cannot execute or force binary diff',async t=>{
  const f=fixture(t);
  const marker=path.join(f.home,'filter-executed');
  fs.writeFileSync(path.join(f.root,'code.js'),'export const value = 1;\n');
  commit(f.root,f.home);
  fs.writeFileSync(path.join(f.root,'.gitattributes'),'*.js filter=evil diff=evil textconv=evil -text\n');
  for(const key of ['filter.evil.smudge','filter.evil.clean','diff.evil.textconv','diff.evil.command'])
    gitIn(f.root,f.home,'config',key,`touch ${marker}`);
  fs.writeFileSync(path.join(f.root,'code.js'),'export const value = 2;\n');

  const snapshot=await snapshotFor(f);
  assert.equal(snapshot.state,'available',snapshot.reason);
  assert.match(snapshot.diff,/--- a\/code\.js/);
  assert.match(snapshot.diff,/\+export const value = 2;/);
  assert.ok(!snapshot.diff.includes('\0'));
  assert.equal(fs.existsSync(marker),false);
});

test('binary and oversized historical blobs are described without returning their bytes',async t=>{
  const f=fixture(t);
  assert.equal(PROJECT_LIMITS.fileBytes,262144);
  fs.writeFileSync(path.join(f.root,'blob.bin'),Buffer.from([0,1,2,3]));
  fs.writeFileSync(path.join(f.root,'huge.txt'),'x'.repeat(PROJECT_LIMITS.fileBytes+5000));
  commit(f.root,f.home);
  fs.writeFileSync(path.join(f.root,'blob.bin'),Buffer.from([0,4,5,6]));
  const secret='SYNTHETIC_SHORT_SECRET_98765';
  fs.writeFileSync(path.join(f.root,'huge.txt'),secret+'\n');

  const snapshot=await snapshotFor(f);
  assert.equal(snapshot.state,'available',snapshot.reason);
  assert.match(snapshot.diff,/\[Binary content omitted\]/);
  assert.match(snapshot.diff,/\[historical blob exceeds the bounded 262144-byte preview and was not read\]/);
  assert.ok(!snapshot.diff.includes('\0'));
  assert.ok(!snapshot.diff.includes(secret));
  assert.ok(!snapshot.diff.includes('x'.repeat(100)));
});

test('modified, deleted and untracked paths have porcelain statuses and real unified hunks',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'a.js'),'export const value = 1;\n');
  fs.writeFileSync(path.join(f.root,'gone.js'),'export const gone = true;\n');
  commit(f.root,f.home);
  fs.writeFileSync(path.join(f.root,'a.js'),'export const value = 2;\n');
  fs.unlinkSync(path.join(f.root,'gone.js'));
  fs.writeFileSync(path.join(f.root,'new.js'),'export const fresh = true;\n');

  const snapshot=await snapshotFor(f);
  assert.equal(snapshot.state,'available',snapshot.reason);
  const entries=snapshot.status.split('\0').filter(Boolean);
  assert.ok(entries.includes(' M a.js'));
  assert.ok(entries.includes(' D gone.js'));
  assert.ok(entries.includes('?? new.js'));
  assert.ok(snapshot.status.endsWith('\0'));
  for(const [oldLabel,newLabel] of [['a/a.js','b/a.js'],['a/gone.js','/dev/null'],['/dev/null','b/new.js']])
    assert.ok(snapshot.diff.includes(`--- ${oldLabel}\n+++ ${newLabel}\n`),`${oldLabel} -> ${newLabel}`);
  assert.match(snapshot.diff,/@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/);
  for(const line of ['-export const value = 1;','+export const value = 2;','-export const gone = true;','+export const fresh = true;'])
    assert.ok(snapshot.diff.split('\n').includes(line),`missing ${line}`);
  assert.ok(!snapshot.diff.includes('\0'));
});

test('missing prlimit disables repository inspection at call time',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'code.js'),'export const value = 1;\n');
  commit(f.root,f.home);
  const project=makeProject(f.root);
  const capture=captureProject(project);
  const original=fs.existsSync;
  fs.existsSync=function(file){return file==='/usr/bin/prlimit'?false:original.apply(this,arguments);};
  try{
    const snapshot=await repositorySnapshot(project,capture,{scratchRoot:f.scratchRoot});
    assert.equal(snapshot.state,'unavailable');
    assert.match(snapshot.reason,/prlimit/);
  }finally{fs.existsSync=original;}
});

test('cross-device descendants are refused for reads, captures and repository snapshots',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'code.js'),'export const value = 1;\n');
  commit(f.root,f.home);
  const project=makeProject(f.root);
  assert.throws(()=>withCrossDeviceStat(()=>readProjectFile(project,'code.js')),
    error=>['unsupported','permission_denied'].includes(error.code));
  const capture=withCrossDeviceStat(()=>captureProject(project));
  assert.equal(capture.files.length,0);
  assert.ok(capture.exclusions.some(entry=>entry.path==='code.js'&&entry.reason==='cross_device'));
  const validCapture=captureProject(project);
  const snapshot=await withCrossDeviceStat(()=>repositorySnapshot(project,validCapture,{scratchRoot:f.scratchRoot}));
  assert.equal(snapshot.state,'unavailable');
});

test('stale root leaves no scratch state and a blocked scratch parent fails cleanly',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'code.js'),'export const value = 1;\n');
  commit(f.root,f.home);
  fs.mkdirSync(f.scratchRoot);
  const staleProject=makeProject(f.root);
  const moved=path.join(f.home,'original-project');
  fs.renameSync(f.root,moved);
  fs.mkdirSync(f.root);
  const dummyCapture={files:[],exclusions:[],limited:false,hash:'0'};
  const stale=await repositorySnapshot(staleProject,dummyCapture,{scratchRoot:f.scratchRoot});
  assert.equal(stale.state,'unavailable');
  assert.deepEqual(fs.readdirSync(f.scratchRoot),[]);
  fs.rmdirSync(f.root);
  fs.renameSync(moved,f.root);
  const blocker=path.join(f.home,'blocked-parent');
  const contents='leave this blocking file intact\n';
  fs.writeFileSync(blocker,contents);
  const blocked=await repositorySnapshot(makeProject(f.root),captureProject(makeProject(f.root)),{scratchRoot:path.join(blocker,'scratch')});
  assert.equal(blocked.state,'unavailable');
  assert.equal(fs.readFileSync(blocker,'utf8'),contents);
  assert.equal(fs.statSync(blocker).isFile(),true);
});

test('a repository with more tracked paths than the file budget is unavailable, not enumerated',async t=>{
  const f=fixture(t);
  for(let i=0;i<PROJECT_LIMITS.files+40;i++)
    fs.writeFileSync(path.join(f.root,`tracked-${String(i).padStart(4,'0')}.js`),'x\n');
  commit(f.root,f.home);
  // Sparse capture: the historical commit is far larger than the current tree.
  for(const name of fs.readdirSync(f.root))
    if(name!=='.git')fs.unlinkSync(path.join(f.root,name));
  const project=makeProject(f.root);
  const capture=captureProject(project);
  assert.equal(capture.files.length,0);
  const snapshot=await repositorySnapshot(project,capture,{scratchRoot:f.scratchRoot});
  assert.equal(snapshot.state,'unavailable');
  assert.equal(snapshot.status,'');
  assert.equal(snapshot.diff,'');
  assert.match(snapshot.reason,/bounded/);
});

test('oversized porcelain status output is bounded and returns unavailable',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'base.txt'),'base\n');
  commit(f.root,f.home);
  // Many long untracked paths produce a status larger than the diff budget
  // while the HEAD listing stays tiny.
  const segment='s'.repeat(200),stem='n'.repeat(195);
  fs.mkdirSync(path.join(f.root,segment,segment),{recursive:true});
  let bytes=0;
  for(let i=0;i<PROJECT_LIMITS.files;i++){
    const relative=path.join(segment,segment,`${stem}-${String(i).padStart(3,'0')}.js`);
    fs.writeFileSync(path.join(f.root,relative),'x\n');
    bytes+=Buffer.byteLength(relative)+4;
  }
  assert.ok(bytes>PROJECT_LIMITS.diffBytes,'fixture did not exceed the status budget');
  const project=makeProject(f.root);
  const capture=captureProject(project);
  assert.equal(capture.files.length,PROJECT_LIMITS.files);
  const snapshot=await repositorySnapshot(project,capture,{scratchRoot:f.scratchRoot});
  assert.equal(snapshot.state,'unavailable');
  assert.equal(snapshot.status,'');
  assert.match(snapshot.reason,/bounded/);
});
