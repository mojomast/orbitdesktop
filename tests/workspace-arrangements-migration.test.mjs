import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BASELINE_COMMIT='d35142f812619c1a2492f0223fce2798cf105b6d';
// Schema-9 was the immediately preceding baseline. A real archived reader (not
// a manual `user_version` rewind) proves old binaries refuse a schema-10 store.
const SCHEMA9_COMMIT='ae14c4f327765dc5ff8786070dedc9eb7e9b3abe';
const id=()=>randomUUID();

function tempRoot(prefix){return fs.mkdtempSync(path.join(os.tmpdir(),prefix));}
function clean(root){fs.rmSync(root,{recursive:true,force:true});}
function commit(store,workspaceId,baseRevision,operationId,intent,change){
  return store.commit(commandIdentity({workspace_id:workspaceId,action:'apply',base_revision:baseRevision,operation_id:operationId,intent},'owner'),change);
}

async function loadArchivedBaseline(t){
  const archived=tempRoot('orbit-schema8-source-');
  t.after(()=>clean(archived));
  const bytes=execFileSync('git',['archive','--format=tar',BASELINE_COMMIT],{cwd:ROOT,maxBuffer:64*1024*1024});
  execFileSync('tar',['-xf','-','-C',archived],{input:bytes,maxBuffer:64*1024*1024});
  fs.symlinkSync(path.join(ROOT,'node_modules'),path.join(archived,'node_modules'),'dir');
  const source=pathToFileURL(path.join(archived,'server/sqlite-workspace-store.mjs')).href;
  const {SqliteWorkspaceStore:BaselineStore}=await import(`${source}?baseline=${id()}`);
  return BaselineStore;
}

/** Import the real archived schema-9 store from Git history. */
async function loadArchivedSchema9Reader(t){
  const archived=tempRoot('orbit-schema9-source-');
  t.after(()=>clean(archived));
  const bytes=execFileSync('git',['archive','--format=tar',SCHEMA9_COMMIT],{cwd:ROOT,maxBuffer:64*1024*1024});
  execFileSync('tar',['-xf','-','-C',archived],{input:bytes,maxBuffer:64*1024*1024});
  fs.symlinkSync(path.join(ROOT,'node_modules'),path.join(archived,'node_modules'),'dir');
  const source=pathToFileURL(path.join(archived,'server/sqlite-workspace-store.mjs')).href;
  const {SqliteWorkspaceStore:Schema9Store}=await import(`${source}?schema9=${id()}`);
  return Schema9Store;
}

function fixtureState(){
  const state=initial();
  state.monitors[0].layout={type:'split',axis:'row',ratio:0.61,
    first:{type:'pane',pane:{id:'migration-terminal-stable',kind:'terminal',url:'orbit://welcome'}},
    second:{type:'pane',pane:{id:'migration-browser-stable',kind:'browser',url:'/apps/testbundle/index.html'}}};
  return state;
}

test('schema 12 upgrades a real schema-8 database and preserves authoritative workspace/Workbench/bundle records through backup and restore',async t=>{
  const BaselineStore=await loadArchivedBaseline(t);
  const sourceRoot=tempRoot('orbit-arrangements-v8-');
  const upgradedRoot=tempRoot('orbit-arrangements-v9-');
  const restoredRoot=path.join(sourceRoot,'restored-runtime');
  t.after(()=>{clean(sourceRoot);clean(upgradedRoot);});
  const baseline=new BaselineStore(sourceRoot);
  const workspaceId=id(),projectId=id(),resourceId=id(),bindingId=id();
  const operationId=id();
  const state=fixtureState();
  const created=baseline.commit(commandIdentity({workspace_id:workspaceId,action:'sync',base_revision:0,operation_id:id(),intent:'Schema migration fixture'},'owner'),{
    create:()=>({id:workspaceId,revision:1,state,capability:'synthetic-capability',api:'http://127.0.0.1:4318'}),
  }).record;
  const applied=commit(baseline,workspaceId,created.revision,operationId,'Fixture with checkpoint',{
    apply:current=>({...structuredClone(current.state),arc:current.state.arc+1}),checkpointLabel:'Schema-8 checkpoint',
  }).record;
  baseline.db.prepare('INSERT INTO wb_projects(id,workspace_id,root,record_json) VALUES (?,?,?,?)')
    .run(projectId,workspaceId,'/private/synthetic-project',JSON.stringify({version:1,id:projectId,workspace_id:workspaceId,root:'/private/synthetic-project',name:'Synthetic',identity:'fixture',generation:1,created_at:1}));
  baseline.db.prepare('INSERT INTO wb_resources(id,project_id,locator,record_json) VALUES (?,?,?,?)')
    .run(resourceId,projectId,'README.md',JSON.stringify({version:1,id:resourceId,project_id:projectId,locator:'README.md',kind:'file',hash:'synthetic-hash',generation:1}));
  baseline.db.prepare('INSERT INTO wb_bindings(id,workspace_id,project_id,resource_id,pane_id,role,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(bindingId,workspaceId,projectId,resourceId,'migration-browser-stable','preview',1);
  const appDir=path.join(sourceRoot,'apps','testbundle');fs.mkdirSync(appDir,{recursive:true});
  fs.writeFileSync(path.join(appDir,'index.html'),'<p>synthetic migration fixture</p>');
  baseline.bundles.refresh();
  assert.equal(baseline.db.pragma('user_version',{simple:true}),8,'fixture must come from the archived schema-8 reader');
  const receiptBefore=baseline.db.prepare('SELECT * FROM receipts WHERE workspace_id=? AND operation_id=?').get(workspaceId,operationId);
  const checkpointBefore=baseline.checkpointList(workspaceId);
  const bundleBefore=baseline.db.prepare('SELECT slug,digest,status,version FROM bundles WHERE slug=?').get('testbundle');
  assert.ok(receiptBefore);assert.equal(checkpointBefore.length,1);assert.ok(bundleBefore);
  const baselineBackup=path.join(sourceRoot,'schema8.sqlite');await baseline.backup(baselineBackup);
  fs.copyFileSync(baselineBackup,path.join(upgradedRoot,'workspace.sqlite'));
  baseline.close();

  const upgraded=new SqliteWorkspaceStore(upgradedRoot);
  t.after(()=>upgraded.close());
  assert.equal(upgraded.diagnostics().schema_version,12);
  assert.deepEqual(upgraded.read(workspaceId),applied);
  assert.deepEqual(upgraded.read(workspaceId).state.monitors[0].layout,state.monitors[0].layout);
  assert.deepEqual(upgraded.checkpointList(workspaceId),checkpointBefore);
  assert.deepEqual(upgraded.checkpointGet(workspaceId,checkpointBefore[0].id).state,state);
  assert.deepEqual(upgraded.db.prepare('SELECT * FROM receipts WHERE workspace_id=? AND operation_id=?').get(workspaceId,operationId),receiptBefore);
  assert.deepEqual(upgraded.db.prepare('SELECT id,workspace_id,root,record_json FROM wb_projects WHERE id=?').get(projectId),
    {id:projectId,workspace_id:workspaceId,root:'/private/synthetic-project',record_json:JSON.stringify({version:1,id:projectId,workspace_id:workspaceId,root:'/private/synthetic-project',name:'Synthetic',identity:'fixture',generation:1,created_at:1})});
  assert.equal(upgraded.db.prepare('SELECT id FROM wb_resources WHERE id=?').get(resourceId).id,resourceId);
  assert.equal(upgraded.db.prepare('SELECT id FROM wb_bindings WHERE id=?').get(bindingId).id,bindingId);
  assert.deepEqual(upgraded.db.prepare('SELECT slug,digest,status,version FROM bundles WHERE slug=?').get('testbundle'),bundleBefore);

  const migratedBackup=path.join(sourceRoot,'schema9.sqlite');await upgraded.backup(migratedBackup);
  const restoredOutput=execFileSync(process.execPath,['--experimental-strip-types','scripts/workspace_store.mjs','restore','--runtime',restoredRoot,'--source',migratedBackup,'--confirm-stopped'],{cwd:ROOT,encoding:'utf8'});
  assert.equal(JSON.parse(restoredOutput).schema_version,12);
  const restored=new SqliteWorkspaceStore(restoredRoot);
  try{
    assert.equal(restored.diagnostics().schema_version,12);
    assert.deepEqual(restored.read(workspaceId),applied);
    assert.deepEqual(restored.checkpointList(workspaceId),checkpointBefore);
    assert.equal(restored.db.prepare('SELECT id FROM wb_projects WHERE id=?').get(projectId).id,projectId);
    assert.equal(restored.db.prepare('SELECT id FROM wb_resources WHERE id=?').get(resourceId).id,resourceId);
    assert.equal(restored.db.prepare('SELECT id FROM wb_bindings WHERE id=?').get(bindingId).id,bindingId);
    assert.deepEqual(restored.db.prepare('SELECT slug,digest,status,version FROM bundles WHERE slug=?').get('testbundle'),bundleBefore);
    assert.deepEqual(restored.db.prepare('SELECT * FROM receipts WHERE workspace_id=? AND operation_id=?').get(workspaceId,operationId),receiptBefore);
  }finally{restored.close();}

  const oldReaderRoot=tempRoot('orbit-arrangements-old-reader-');t.after(()=>clean(oldReaderRoot));
  fs.copyFileSync(migratedBackup,path.join(oldReaderRoot,'workspace.sqlite'));
  const OldStore=await loadArchivedBaseline(t);
  assert.throws(()=>new OldStore(oldReaderRoot),error=>error.category==='UPGRADE_REQUIRED');
  const oldReaderDb=new Database(path.join(oldReaderRoot,'workspace.sqlite'),{readonly:true});
  try{assert.equal(oldReaderDb.pragma('user_version',{simple:true}),12);}finally{oldReaderDb.close();}
});

test('schema 13 is refused by the current reader, and an archived schema-9 reader refuses a schema-12 database',async t=>{
  const fixture=tempRoot('orbit-arrangements-schema-future-');t.after(()=>clean(fixture));
  const store=new SqliteWorkspaceStore(fixture);
  assert.equal(store.diagnostics().schema_version,12,'current store must create schema 12');
  store.close();
  // The archived schema-9 reader is a real build from the preceding baseline,
  // not a manual user_version rewind. It must fail closed on the real schema-10
  // database, which is the mixed-version downgrade gate.
  const schema9Root=tempRoot('orbit-arrangements-schema10-old-');t.after(()=>clean(schema9Root));
  fs.copyFileSync(path.join(fixture,'workspace.sqlite'),path.join(schema9Root,'workspace.sqlite'));
  const Schema9Store=await loadArchivedSchema9Reader(t);
  assert.throws(()=>new Schema9Store(schema9Root),error=>error.category==='UPGRADE_REQUIRED');
  const untouched=new Database(path.join(fixture,'workspace.sqlite'),{readonly:true});
  try{assert.equal(untouched.pragma('user_version',{simple:true}),12);}finally{untouched.close();}
  // No schema-13 implementation exists, so this marker is simulated; the
  // current reader must still refuse it without modifying the database.
  const db=new Database(path.join(fixture,'workspace.sqlite'));db.pragma('user_version=13');db.close();
  assert.throws(()=>new SqliteWorkspaceStore(fixture),error=>error.category==='UPGRADE_REQUIRED');
  const verify=new Database(path.join(fixture,'workspace.sqlite'),{readonly:true});
  try{assert.equal(verify.pragma('user_version',{simple:true}),13);}finally{verify.close();}
});
