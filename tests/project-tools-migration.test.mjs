import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';

// Schema 10 project-tools migration audit. This file owns only the additive
// store contract: it does not require the owner route or frontend to exist.
// The backend service is imported lazily so the migration assertions can run as
// soon as the lead's schema-10 store lands, and the projection assertion runs
// once server/project-tools.mjs is available.
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// The real schema-9 source baseline; used as an archived old reader, never a
// manual `user_version` rewind.
const SCHEMA9_COMMIT='ae14c4f327765dc5ff8786070dedc9eb7e9b3abe';
const PLUGIN_ID='notes';
const PLUGIN_ENTRY='/apps/notes-0123456789abcdef01234567/index.html';
const id=()=>randomUUID();

function tempRoot(prefix){return fs.mkdtempSync(path.join('/tmp/opencode',prefix));}
function clean(root){fs.rmSync(root,{recursive:true,force:true});}
function commit(store,workspaceId,baseRevision,operationId,intent,change){
  return store.commit(commandIdentity({workspace_id:workspaceId,action:'apply',base_revision:baseRevision,operation_id:operationId,intent},'owner'),change);
}
function legacyState(){
  return applyOperation(initial(),{action:'plugin_install',manifest:{apiVersion:1,id:PLUGIN_ID,version:'1.0.0',title:'Notes',entry:PLUGIN_ENTRY},config:{message:'fixture'}});
}
function seedLegacyWorkspace(store){
  const workspaceId=id();
  // The bundle must be indexed before the commit validates the plugin entry.
  const bundleRoot=path.join(store.root,'apps','notes-0123456789abcdef01234567');
  fs.mkdirSync(bundleRoot,{recursive:true});
  fs.writeFileSync(path.join(bundleRoot,'index.html'),'<p>project-tools migration fixture</p>');
  store.bundles.refresh();
  const state=legacyState();
  const created=store.commit(commandIdentity({workspace_id:workspaceId,action:'sync',base_revision:0,operation_id:id(),intent:'Project tools fixture'},'owner'),{create:()=>({id:workspaceId,revision:1,state,capability:'fixture-capability',api:'http://127.0.0.1:4318'})}).record;
  const applied=commit(store,workspaceId,created.revision,id(),'Checkpoint before schema 10',{apply:current=>({...structuredClone(current.state),arc:current.state.arc+1}),checkpointLabel:'Schema-10 fixture checkpoint'}).record;
  return {workspaceId,applied};
}
async function loadArchivedSchema9Reader(t){
  const archived=tempRoot('orbit-project-tools-schema9-src-');
  t.after(()=>clean(archived));
  const bytes=execFileSync('git',['archive','--format=tar',SCHEMA9_COMMIT],{cwd:ROOT,maxBuffer:64*1024*1024});
  execFileSync('tar',['-xf','-','-C',archived],{input:bytes,maxBuffer:64*1024*1024});
  fs.symlinkSync(path.join(ROOT,'node_modules'),path.join(archived,'node_modules'),'dir');
  const source=pathToFileURL(path.join(archived,'server/sqlite-workspace-store.mjs')).href;
  const {SqliteWorkspaceStore:Schema9Store}=await import(`${source}?schema9=${id()}`);
  return Schema9Store;
}
async function optionalImport(specifier){
  try{return await import(specifier);}catch{return null;}
}
function resolveDispatch(created){
  if(typeof created==='function')return created;
  return created.dispatch;
}
/** True only once the lead's schema-10 store is available in this checkout. */
function schemaTenStore(root){
  const store=new SqliteWorkspaceStore(root);
  if(store.diagnostics().schema_version===10)return store;
  store.close();
  return null;
}

test('schema 10 is additive: new tables land empty while workspace, checkpoints, receipts, bundles and v1 plugins survive',async t=>{
  const root=tempRoot('orbit-project-tools-migration-');
  t.after(()=>clean(root));
  const store=schemaTenStore(root);
  if(!store){t.skip('schema-10 store not available yet; run once the lead migration lands');return;}
  t.after(()=>store.close());
  const {workspaceId,applied}=seedLegacyWorkspace(store);
  assert.equal(store.diagnostics().schema_version,10);
  const checkpointBefore=store.checkpointList(workspaceId);
  const receiptBefore=store.db.prepare('SELECT * FROM receipts ORDER BY operation_id LIMIT 1').get();
  const bundleBefore=store.db.prepare('SELECT slug,digest,status,version FROM bundles WHERE slug=?').get('notes-0123456789abcdef01234567');
  assert.ok(bundleBefore,'fixture bundle must be indexed');
  assert.ok(checkpointBefore.length>=1&&receiptBefore);
  const stateBefore=store.read(workspaceId).state;
  assert.equal(stateBefore.plugins[0].manifest.id,PLUGIN_ID);
  assert.equal(stateBefore.plugins[0].manifest.entry,PLUGIN_ENTRY);

  // The new DDL is the lead-owned source of truth; parse it instead of guessing
  // names, then prove every new table exists and starts empty.
  const projectionModule=await optionalImport('../server/project-tools-data.mjs');
  if(!projectionModule?.projectToolsSchemaSql){t.diagnostic('project-tools-data.mjs not available; skipped table-shape assertions');}
  else{
    const names=[...String(projectionModule.projectToolsSchemaSql).matchAll(/CREATE TABLE IF NOT EXISTS\s+"?([a-zA-Z0-9_]+)"?/g)].map(match=>match[1]);
    assert.ok(names.length>0,'projectToolsSchemaSql must declare tables');
    for(const name of names){
      assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name),`schema 10 must create ${name}`);
      assert.equal(store.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n,0,`${name} must start empty`);
    }
  }

  // Additive migration must not rewrite authoritative layout or metadata.
  assert.deepEqual(store.read(workspaceId),applied);
  assert.deepEqual(store.read(workspaceId).state,stateBefore);
  assert.equal(store.read(workspaceId).state.plugins[0].manifest.entry,PLUGIN_ENTRY);
  assert.deepEqual(store.checkpointList(workspaceId),checkpointBefore);
  assert.deepEqual(store.db.prepare('SELECT * FROM receipts ORDER BY operation_id LIMIT 1').get(),receiptBefore);
  assert.deepEqual(store.db.prepare('SELECT slug,digest,status,version FROM bundles WHERE slug=?').get('notes-0123456789abcdef01234567'),bundleBefore);
});

test('an archived schema-9 reader refuses schema 10, and the current reader refuses schema 11',async t=>{
  const root=tempRoot('orbit-project-tools-future-');
  t.after(()=>clean(root));
  const store=schemaTenStore(root);
  if(!store){t.skip('schema-10 store not available yet; run once the lead migration lands');return;}
  store.close();

  // Real archived schema-9 build against the real schema-10 database.
  const oldRoot=tempRoot('orbit-project-tools-schema10-old-');
  t.after(()=>clean(oldRoot));
  fs.copyFileSync(path.join(root,'workspace.sqlite'),path.join(oldRoot,'workspace.sqlite'));
  const Schema9Store=await loadArchivedSchema9Reader(t);
  assert.throws(()=>new Schema9Store(oldRoot),error=>error.category==='UPGRADE_REQUIRED');
  const untouched=new Database(path.join(root,'workspace.sqlite'),{readonly:true});
  try{assert.equal(untouched.pragma('user_version',{simple:true}),10);}finally{untouched.close();}

  // No schema-11 implementation exists, so the marker is simulated; the current
  // reader must still refuse it without modifying the database.
  const db=new Database(path.join(root,'workspace.sqlite'));db.pragma('user_version=11');db.close();
  assert.throws(()=>new SqliteWorkspaceStore(root),error=>error.category==='UPGRADE_REQUIRED');
  const verify=new Database(path.join(root,'workspace.sqlite'),{readonly:true});
  try{assert.equal(verify.pragma('user_version',{simple:true}),11);}finally{verify.close();}
});

test('schema-10 SQLite backup restores the additive tables and legacy plugin facts without a second writable copy',async t=>{
  const root=tempRoot('orbit-project-tools-backup-'),runtime=path.join(root,'source');
  t.after(()=>clean(root));
  const store=schemaTenStore(runtime);
  if(!store){t.skip('schema-10 store not available yet; run once the lead migration lands');return;}
  const {workspaceId,applied}=seedLegacyWorkspace(store);
  const backup=path.join(root,'schema10.sqlite');
  await store.backup(backup);
  const before=fs.readFileSync(backup);
  store.close();

  const restoredRoot=path.join(root,'restored');
  fs.mkdirSync(restoredRoot);
  fs.copyFileSync(backup,path.join(restoredRoot,'workspace.sqlite'));
  const restored=new SqliteWorkspaceStore(restoredRoot);
  try{
    assert.equal(restored.diagnostics().schema_version,10);
    assert.deepEqual(restored.read(workspaceId),applied);
    assert.equal(restored.read(workspaceId).state.plugins[0].manifest.id,PLUGIN_ID);
    assert.equal(restored.read(workspaceId).state.plugins[0].manifest.version,'1.0.0');
  }finally{restored.close();}
  assert.deepEqual(fs.readFileSync(backup),before,'source backup must remain byte-for-byte unchanged');
});

test('legacy v1 plugins project read-only through metadata_list without writing a second copy',async t=>{
  const root=tempRoot('orbit-project-tools-projection-');
  t.after(()=>clean(root));
  const store=schemaTenStore(root);
  if(!store){t.skip('schema-10 store not available yet; run once the lead migration lands');return;}
  t.after(()=>store.close());
  const serviceModule=await optionalImport('../server/project-tools.mjs');
  if(!serviceModule?.createProjectTools){t.skip('server/project-tools.mjs not available yet; projection runs once the backend lands');return;}
  const {workspaceId}=seedLegacyWorkspace(store);
  const before=store.read(workspaceId);
  const dataModule=await optionalImport('../server/project-tools-data.mjs');
  const tableNames=String(dataModule?.projectToolsSchemaSql??'').match(/CREATE TABLE IF NOT EXISTS\s+"?([a-zA-Z0-9_]+)"?/g)?.map(stmt=>/CREATE TABLE IF NOT EXISTS\s+"?([a-zA-Z0-9_]+)"?/.exec(stmt)[1])??[];
  const counts=()=>Object.fromEntries(tableNames.map(name=>[name,store.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]));
  const {WorkbenchStore}=await import('../server/workbench-store.mjs');
  const {WorkbenchData}=await import('../server/workbench-data.mjs');
  const records=new WorkbenchStore(store);
  records.register(workspaceId,{root:path.join(root,'project'),name:'Projection fixture',identity:'projection'});
  const data=new WorkbenchData(store);
  const dispatch=resolveDispatch(serviceModule.createProjectTools({store,records,data,now:Date.now}));
  const listed=await dispatch({action:'metadata_list',workspace_id:workspaceId});
  assert.ok(Array.isArray(listed.legacy_plugins),'metadata_list must expose legacy_plugins');
  const serialized=JSON.stringify(listed.legacy_plugins);
  assert.ok(serialized.includes(PLUGIN_ID)&&serialized.includes('1.0.0'),'legacy plugin identity/version must appear in the projection');
  // The legacy plugin is projected, never materialized as a project-tool
  // definition, instance or binding.
  assert.ok(!JSON.stringify(listed.definitions??[]).includes(PLUGIN_ENTRY),'legacy v1 plugin must not become a definition');
  assert.ok(!JSON.stringify(listed.instances??[]).includes(PLUGIN_ENTRY),'legacy v1 plugin must not become an instance');
  // A repeated projection is an idempotent read: no extra tool records accrue.
  const afterFirst=counts();
  await dispatch({action:'metadata_list',workspace_id:workspaceId});
  assert.deepEqual(counts(),afterFirst,'metadata_list must not write new tool records on repeat');
  assert.deepEqual(store.read(workspaceId),before,'projection must not mutate authoritative workspace state');
});
