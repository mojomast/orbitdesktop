import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMcpApps } from '../server/mcp-apps.mjs';
const workspace_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const snapshot={title:'Private',resource_uri:'ui://exact/resource',html:'<h1>Private</h1>',arguments:{},result:{content:[{type:'text',text:'Exact'}]}};
test('private content-addressed snapshots recover exact results and refuse scope/identity/CAS drift',()=>{
 const root=fs.mkdtempSync(path.join('/tmp/opencode/','mcp-apps-unit-'));
 try{
  const service=createMcpApps({root,workspaceRead:id=>id===workspace_id});
  const send=(action,fields={})=>service.dispatch({action,workspace_id,...fields});
  assert.equal(send('capabilities').available,false);
  const revision=send('list').revision;
  const {id}=send('import',{snapshot,expected_revision:revision});
  assert.deepEqual(send('get',{id}).snapshot,snapshot);
  assert.equal(send('import',{snapshot,expected_revision:revision}).id,id);
  assert.throws(()=>send('import',{snapshot:{...snapshot,title:'Changed'},expected_revision:revision}),/changed/);
  assert.throws(()=>send('get',{id:'../escape'}),/identity/);
  assert.throws(()=>service.dispatch({action:'list',workspace_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}),/workspace/);
  assert.throws(()=>send('import',{snapshot:{...snapshot,server:'http://127.0.0.1'},expected_revision:send('list').revision}),/fields/);
  assert.equal(fs.statSync(path.join(root,'mcp-apps',workspace_id)).mode&0o777,0o700);
  assert.equal(fs.statSync(path.join(root,'mcp-apps',workspace_id,id+'.json')).mode&0o777,0o600);
  fs.writeFileSync(path.join(root,'mcp-apps',workspace_id,id+'.json'),'{}');
  assert.throws(()=>send('get',{id}),/Corrupt/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('sandbox origin configuration must be exact',()=>{
 for(const sandboxOrigin of ['https://example.com/path','file:///tmp/x','https://u:p@example.com'])assert.throws(()=>createMcpApps({root:'/unused',workspaceRead:()=>true,sandboxOrigin}));
});
test('retention is bounded and deleted snapshots cannot be recovered by identity',()=>{
 const root=fs.mkdtempSync(path.join('/tmp/opencode/','mcp-apps-retention-'));
 try{
  const service=createMcpApps({root,workspaceRead:()=>true});
  const send=(action,fields={})=>service.dispatch({action,workspace_id,...fields});
  let first;
  for(let index=0;index<64;index++){
   const saved=send('import',{snapshot:{...snapshot,title:`Snapshot ${index}`},expected_revision:send('list').revision});
   first??=saved.id;
  }
  const revision=send('list').revision;
  assert.throws(()=>send('import',{snapshot:{...snapshot,title:'Overflow'},expected_revision:revision}),/retention/);
  send('delete',{id:first});
  assert.throws(()=>send('get',{id:first}));
  send('import',{snapshot:{...snapshot,title:'Replacement'},expected_revision:send('list').revision});
  assert.equal(send('list').count,64);
  assert.notEqual(send('list').revision,revision);
  assert.throws(()=>send('import',{snapshot:{...snapshot,title:'ABA attempt'},expected_revision:revision}),/changed/);
  assert.throws(()=>send('import',{snapshot:{...snapshot,html:'x'.repeat(1572864)},expected_revision:send('list').revision}),/exceeds/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

function privateFixture(run) {
 const root=fs.mkdtempSync(path.join('/tmp/opencode/','mcp-apps-fs-'));
 const factory=()=>createMcpApps({root,workspaceRead:id=>id===workspace_id});
 const send=(action,fields={})=>factory().dispatch({action,workspace_id,...fields});
 const save=(value=snapshot)=>send('import',{snapshot:value,expected_revision:send('list').revision});
 try { run({root,factory,send,save,dir:path.join(root,'mcp-apps',workspace_id)}); }
 finally { fs.rmSync(root,{recursive:true,force:true}); }
}
const isUnavailable=error=>error.code==='unavailable';

test('root, ancestor and workspace symlinks fail closed without touching targets',()=>{
 privateFixture(({root,send,save,dir})=>{
  save();
  const outside=path.join(root,'outside');fs.mkdirSync(outside,{mode:0o700});
  fs.writeFileSync(path.join(outside,'sentinel'),'owner data');
  fs.rmSync(dir,{recursive:true});fs.symlinkSync(outside,dir);
  assert.throws(()=>send('list'),isUnavailable);
  assert.deepEqual(fs.readdirSync(outside),['sentinel']);
  fs.symlinkSync(outside,path.join(root,'linked'));
  for(const unsafeRoot of [path.join(root,'linked'),path.join(root,'linked','descendant')]){
   const service=createMcpApps({root:unsafeRoot,workspaceRead:()=>true});
   assert.throws(()=>service.dispatch({action:'list',workspace_id}),isUnavailable);
  }
  assert.equal(fs.readFileSync(path.join(outside,'sentinel'),'utf8'),'owner data');
 });
});

test('unsafe directory/file modes are rejected, never repaired',()=>{
 privateFixture(({root,send,save,dir})=>{
  const {id}=save(),file=path.join(dir,id+'.json');
  for(const target of [root,path.join(root,'mcp-apps'),dir]){
   fs.chmodSync(target,0o755);
   assert.throws(()=>send('list'),isUnavailable);
   assert.equal(fs.statSync(target).mode&0o777,0o755);
   fs.chmodSync(target,0o700);
  }
  fs.chmodSync(file,0o644);
  assert.throws(()=>send('get',{id}),isUnavailable);
  assert.equal(fs.statSync(file).mode&0o777,0o644);
 });
});

test('symlinked, hardlinked and sparse oversized records are refused before reading',()=>{
 privateFixture(({send,save,dir,root})=>{
  const {id}=save(),file=path.join(dir,id+'.json'),target=path.join(root,'outside.json');
  fs.renameSync(file,target);fs.symlinkSync(target,file);
  assert.throws(()=>send('get',{id}),isUnavailable);
  fs.unlinkSync(file);fs.linkSync(target,file);
  assert.throws(()=>send('get',{id}),isUnavailable);
  fs.unlinkSync(target);fs.truncateSync(file,10*1024*1024*1024);
  const read=fs.readSync;let called=false;
  fs.readSync=(...args)=>{called=true;return read(...args);};
  try { assert.throws(()=>send('get',{id}),isUnavailable);assert.equal(called,false); }
  finally { fs.readSync=read; }
 });
});

test('disk retention overflow and orphan entries fail closed without implicit cleanup',()=>{
 privateFixture(({send,save,dir})=>{
  save();
  fs.writeFileSync(path.join(dir,'.orphan'),'unfinished');
  assert.throws(()=>send('list'),isUnavailable);
  assert.equal(fs.readFileSync(path.join(dir,'.orphan'),'utf8'),'unfinished');
  fs.unlinkSync(path.join(dir,'.orphan'));
  for(let i=0;i<64;i++)fs.writeFileSync(path.join(dir,i.toString(16).padStart(64,'0')+'.json'),'{}',{mode:0o600});
  assert.throws(()=>send('list'),error=>error.code==='unavailable'&&/retention/.test(error.message));
  assert.equal(fs.readdirSync(dir).length,65);
 });
});

test('restart recovers exact bytes; corrupt records block list, get, import and delete',()=>{
 privateFixture(({factory,send,save,dir})=>{
  const {id}=save();
  assert.deepEqual(factory().dispatch({action:'get',workspace_id,id}).snapshot,snapshot);
  fs.writeFileSync(path.join(dir,id+'.json'),'{}');
  for(const action of ['list','get','delete'])assert.throws(()=>send(action,action==='list'?{}:{id}),isUnavailable);
  assert.throws(()=>send('import',{snapshot,expected_revision:'0'.repeat(64)}),isUnavailable);
  assert.equal(fs.readFileSync(path.join(dir,id+'.json'),'utf8'),'{}');
 });
});

test('temporary files are cleaned after write and file-fsync failures',()=>{
 for(const operation of ['writeFileSync','fsyncSync'])privateFixture(({send,save,dir})=>{
  save();const original=fs[operation];
  const revision=send('list').revision;
  fs[operation]=(...args)=>{
   if(typeof args[0]==='number'&&fs.fstatSync(args[0]).isFile())throw Object.assign(Error('Injected failure'),{code:'EIO'});
   return original(...args);
  };
  try { assert.throws(()=>send('import',{snapshot:{...snapshot,title:'Failed write'},expected_revision:revision}),isUnavailable); }
  finally { fs[operation]=original; }
  assert.equal(fs.readdirSync(dir).length,1);
  assert.equal(send('list').count,1);
 });
});

test('deletion fsyncs the directory; replay and restart confirm absence',()=>{
 privateFixture(({send,save,dir,factory})=>{
  const {id}=save(),sync=fs.fsyncSync;let directorySyncs=0;
  fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())directorySyncs++;return sync(fd);};
  try {
   assert.deepEqual(send('delete',{id}),{deleted:id});
   assert.deepEqual(send('delete',{id}),{deleted:id});
  }finally{fs.fsyncSync=sync;}
  assert.equal(directorySyncs,2);
  assert.deepEqual(fs.readdirSync(dir),[]);
  assert.equal(factory().dispatch({action:'list',workspace_id}).count,0);
  assert.throws(()=>send('get',{id}),isUnavailable);
  const next=save({...snapshot,title:'Delete fsync retry'});
  fs.fsyncSync=()=>{throw Object.assign(Error('Injected fsync failure'),{code:'EIO'});};
  try { assert.throws(()=>send('delete',{id:next.id}),isUnavailable); }
  finally { fs.fsyncSync=sync; }
  assert.deepEqual(send('delete',{id:next.id}),{deleted:next.id});
  assert.equal(send('list').count,0);
 });
});

test('strict action/workspace shapes produce stable public codes',()=>{
 privateFixture(({factory})=>{
  for(const body of [{action:'constructor',workspace_id},{action:[],workspace_id},{action:'list',workspace_id:12},{action:'list',workspace_id:'a'.repeat(36)},{action:'list',workspace_id,extra:true},{action:'get',workspace_id,id:[]}])assert.throws(()=>factory().dispatch(body),error=>error.code==='invalid_request');
  assert.throws(()=>factory().dispatch({action:'list',workspace_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}),error=>error.code==='permission_denied');
 });
});
