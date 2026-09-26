import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initial } from '../src/model.ts';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import { loadSqliteWorkspaceStore, tempRoot, removeRoot } from './fixtures/sqlite-store-helpers.mjs';

const SqliteWorkspaceStore = await loadSqliteWorkspaceStore();
const CLI = new URL('../scripts/workspace_store.mjs', import.meta.url).pathname;
const env = { PATH: process.env.PATH };

function run(args) {
  return JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { env, encoding: 'utf8' }));
}

function runFailure(args) {
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', CLI, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const lines = (error.stderr || '').toString().trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  }
  throw new Error('Expected the workspace_store CLI to fail');
}

function seed(store) {
  const id = randomUUID();
  store.commit({
    workspaceId: id, actor: 'preserve-schema-test', operationId: randomUUID(), intent: 'seed',
    requestHash: createHash('sha256').update(randomUUID()).digest('hex'), action: 'create', baseRevision: 0,
  }, { create: () => ({ id, revision: 1, state: initial(), capability: 'fixture-capability', api: 'http://127.0.0.1:4318' }) });
  return id;
}

/** Produce a genuine pre-upgrade schema-3 artifact from a schema-4 store. */
async function schema3Backup(root) {
  const store = new SqliteWorkspaceStore(root);
  const id = seed(store);
  store.close();
  const database = new Database(path.join(root, 'workspace.sqlite'));
  database.exec(`ALTER TABLE checkpoints DROP COLUMN placement_json;
    ALTER TABLE revisions DROP COLUMN placement_json;
    UPDATE workspaces SET record_json=json_remove(record_json,'$.placement','$.placement_revision');
    PRAGMA user_version=3;`);
  database.pragma('wal_checkpoint(TRUNCATE)');
  const backup = path.join(root, 'preupgrade.sqlite');
  await database.backup(backup);
  database.close();
  return { id, backup };
}

function rawVersion(file) {
  const database = new Database(file, { fileMustExist: true });
  try { return database.pragma('user_version', { simple: true }); } finally { database.close(); }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('preserve-schema restores a pre-upgrade schema-3 backup without migrating', async (t) => {
  const root = tempRoot('orbit-preserve-schema-');
  t.after(() => removeRoot(root));
  const { id, backup } = await schema3Backup(root);
  const before = sha256(backup);
  const destination = path.join(root, 'restored-preserved');
  const result = run(['restore', '--runtime', destination, '--source', backup, '--confirm-stopped', '--preserve-schema']);
  assert.deepEqual(result, { restored: true, preserved: true, schema_version: 3 });
  assert.equal(rawVersion(path.join(destination, 'workspace.sqlite')), 3, 'preserved runtime must stay schema 3');
  assert.equal(sha256(backup), before, 'source backup must remain byte-for-byte unchanged');
  // Readable raw without opening the newer store (which would migrate it).
  const database = new Database(path.join(destination, 'workspace.sqlite'), { readonly: true, fileMustExist: true });
  try {
    assert.equal(database.prepare('SELECT revision FROM workspaces WHERE id=?').get(id).revision, 1);
  } finally { database.close(); }
});

test('normal restore of the same backup migrates the copy to schema 8', async (t) => {
  const root = tempRoot('orbit-preserve-normal-');
  t.after(() => removeRoot(root));
  const { id, backup } = await schema3Backup(root);
  const before = sha256(backup);
  const destination = path.join(root, 'restored-migrated');
  const result = run(['restore', '--runtime', destination, '--source', backup, '--confirm-stopped']);
  assert.equal(result.restored, true);
  assert.equal(result.preserved, undefined);
  assert.equal(result.schema_version, 8);
  assert.equal(rawVersion(path.join(destination, 'workspace.sqlite')), 8);
  assert.equal(sha256(backup), before, 'source backup must remain byte-for-byte unchanged');
  const reopened = new SqliteWorkspaceStore(destination);
  try {
    assert.equal(reopened.diagnostics().schema_version, 8);
    assert.equal(reopened.read(id).revision, 1);
  } finally { reopened.close(); }
});

test('preserve-schema refuses an existing destination and leaves it untouched', async (t) => {
  const root = tempRoot('orbit-preserve-exists-');
  t.after(() => removeRoot(root));
  const { backup } = await schema3Backup(root);
  const destination = path.join(root, 'occupied');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'owner data');
  const failure = runFailure(['restore', '--runtime', destination, '--source', backup, '--confirm-stopped', '--preserve-schema']);
  assert.ok(typeof failure.error === 'string' && failure.error.length > 0, 'restore must be rejected');
  assert.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'owner data');
  assert.equal(fs.existsSync(path.join(destination, 'workspace.sqlite')), false);
});

test('preserve-schema reports schema 8 for a schema-8 backup without tampering', async (t) => {
  const root = tempRoot('orbit-preserve-v4-');
  t.after(() => removeRoot(root));
  const store = new SqliteWorkspaceStore(root);
  seed(store);
  const backup = path.join(root, 'v4.sqlite');
  await store.backup(backup);
  store.close();
  const destination = path.join(root, 'restored-v4');
  const result = run(['restore', '--runtime', destination, '--source', backup, '--confirm-stopped', '--preserve-schema']);
  assert.deepEqual(result, { restored: true, preserved: true, schema_version: 8 });
  assert.equal(rawVersion(path.join(destination, 'workspace.sqlite')), 8);
});

test('genuine schema-7 backup preserves seven, while normal restore upgrades a copy to eight',async t=>{
  const root=tempRoot('orbit-preserve-seven-');t.after(()=>removeRoot(root));
  const store=new SqliteWorkspaceStore(root),id=seed(store),before=store.read(id);
  store.close();
  const db=new Database(path.join(root,'workspace.sqlite'));
  try{
    db.exec('DROP TABLE wb_cards; DROP TABLE wb_results; DROP TABLE wb_patches; PRAGMA user_version=7');
    const backup=path.join(root,'seven.sqlite');await db.backup(backup);
    const unchanged=sha256(backup),preserved=path.join(root,'preserved'),upgraded=path.join(root,'upgraded');
    assert.deepEqual(run(['restore','--runtime',preserved,'--source',backup,'--confirm-stopped','--preserve-schema']),{restored:true,preserved:true,schema_version:7});
    assert.equal(rawVersion(path.join(preserved,'workspace.sqlite')),7);
    assert.equal(run(['restore','--runtime',upgraded,'--source',backup,'--confirm-stopped']).schema_version,8);
    assert.equal(rawVersion(path.join(upgraded,'workspace.sqlite')),8);
    assert.equal(sha256(backup),unchanged);
    const reopened=new SqliteWorkspaceStore(upgraded);
    try{assert.deepEqual(reopened.read(id),before);for(const name of ['wb_results','wb_cards','wb_patches'])assert.equal(reopened.db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n,0);}finally{reopened.close();}
  }finally{db.close();}
});

test('schema-8 backup/restore retains result, card and patch records and workspace receipts',async t=>{
  const root=tempRoot('orbit-preserve-eight-'),runtime=path.join(root,'source');t.after(()=>removeRoot(root));
  const store=new SqliteWorkspaceStore(runtime),workspace_id=seed(store);
  const projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'file.txt'),'fixture');
  const opened=openProjectRoot(projectRoot),records=new WorkbenchStore(store),project=records.register(workspace_id,{root:projectRoot,name:'Backup fixture',identity:opened.identity});opened.close();
  const data=new WorkbenchData(store),project_id=project.id;
  for(const [kind,fields] of [['results',{availability:'available',text:'owner explanation',run_id:randomUUID()}],['cards',{result_id:randomUUID(),text:'card fixture',op_id:randomUUID()}],['patches',{status:'available',artifact_hash:'a'.repeat(64),op_id:randomUUID()}]])data.create(kind,{workspace_id,project_id,...fields});
  const rows=Object.fromEntries(['results','cards','patches'].map(kind=>[kind,data.list(kind,workspace_id,project_id)]));
  const receipt=store.db.prepare('SELECT * FROM receipts WHERE workspace_id=?').get(workspace_id);
  const backup=path.join(root,'eight.sqlite');await store.backup(backup);store.close();
  const before=sha256(backup),destination=path.join(root,'restored');
  assert.deepEqual(run(['restore','--runtime',destination,'--source',backup,'--confirm-stopped','--preserve-schema']),{restored:true,preserved:true,schema_version:8});
  const restored=new SqliteWorkspaceStore(destination);
  try{
    assert.equal(restored.diagnostics().schema_version,8);
    const copy=new WorkbenchData(restored);
    for(const kind of ['results','cards','patches'])assert.deepEqual(copy.list(kind,workspace_id,project_id),rows[kind]);
    assert.deepEqual(restored.db.prepare('SELECT * FROM receipts WHERE workspace_id=?').get(workspace_id),receipt);
  }finally{restored.close();}
  assert.equal(sha256(backup),before);
});

test('preserve-schema is rejected outside restore and requires confirmation', async (t) => {
  const root = tempRoot('orbit-preserve-args-');
  t.after(() => removeRoot(root));
  const { backup } = await schema3Backup(root);
  const wrongAction = runFailure(['diagnose', '--runtime', root, '--preserve-schema']);
  assert.ok(typeof wrongAction.error === 'string' && wrongAction.error.length > 0);
  const destination = path.join(root, 'no-confirm');
  const unconfirmed = runFailure(['restore', '--runtime', destination, '--source', backup, '--preserve-schema']);
  assert.ok(typeof unconfirmed.error === 'string' && unconfirmed.error.length > 0, 'restore without confirmation must be rejected');
  assert.equal(fs.existsSync(destination), false);
});

test('future schema 9 backup cannot be restored or silently downgraded',async t=>{
  const root=tempRoot('orbit-future-schema-');t.after(()=>removeRoot(root));
  const store=new SqliteWorkspaceStore(root);seed(store);store.close();
  const db=new Database(path.join(root,'workspace.sqlite'));db.pragma('user_version = 9');
  const backup=path.join(root,'future.sqlite');await db.backup(backup);db.close();
  const before=sha256(backup);
  for(const preserve of [false,true]){
    const destination=path.join(root,preserve?'preserve-future':'upgrade-future');
    assert.deepEqual(runFailure(['restore','--runtime',destination,'--source',backup,'--confirm-stopped',...(preserve?['--preserve-schema']:[])]),{error:'UPGRADE_REQUIRED'});
    assert.equal(fs.existsSync(destination),false);
  }
  assert.equal(sha256(backup),before);
});
