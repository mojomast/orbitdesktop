import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { initial } from '../src/model.ts';
import { emptyPlacement } from '../src/docking-placement.ts';
import { loadSqliteWorkspaceStore, tempRoot, removeRoot } from './fixtures/sqlite-store-helpers.mjs';

const SqliteWorkspaceStore = await loadSqliteWorkspaceStore();
const skip = SqliteWorkspaceStore ? false : 'server/sqlite-workspace-store.mjs is not implemented yet';

const LEGACY_ID = '11111111-1111-4111-8111-111111111111';
const LEGACY_CP = '22222222-2222-4222-8222-222222222222';

function legacyFixture(root) {
  const state = initial();
  state.monitors[0].layout = {
    type: 'split', axis: 'row', ratio: 0.5,
    first: { type: 'pane', pane: { id: 'legacy-pane-a', kind: 'terminal', url: 'orbit://welcome' } },
    second: { type: 'pane', pane: { id: 'legacy-pane-b', kind: 'agent', url: 'orbit://welcome' } },
  };
  state.monitors[0].spatial = {
    x: 0, y: 0.9, z: 0, width: 4.8, height: 3, yaw: 0, pitch: 0, resolution: 1920,
  };
  state.spatialCamera = { x: 0, y: 0.9, z: 0, azimuth: 0, elevation: 0, distance: 10 };
  state.plugins = [{
    manifest: {
      apiVersion: 1, id: 'legacy-plugin', version: '1.0.0', title: 'Legacy plugin',
      entry: '/apps/legacy-plugin/index.html',
    },
    enabled: false,
    window: {
      ...structuredClone(state.monitors[1]), id: 'legacy-plugin-window', name: 'Legacy plugin',
    },
    config: { 'feature-flag': true, limit: 5 },
    backendEndpoint: 'https://legacy-backend.example',
  }];
  const record = {
    id: LEGACY_ID, capability: 'original-legacy-capability', revision: 7, state,
    api: 'http://127.0.0.1:3000', observed_revision: 6, browser_seen: 1720000000000,
    futureMetadata: { revoked: true },
  };
  const checkpoint = {
    id: LEGACY_CP, created: 1720000000001, label: 'Before legacy change',
    revision: 6, state: structuredClone(state),
  };
  const workspaceFile = path.join(root, 'workspaces', `${LEGACY_ID}.json`);
  const checkpointFile = path.join(root, 'checkpoints', LEGACY_ID, `${LEGACY_CP}.json`);
  fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
  const workspaceBytes = Buffer.from(JSON.stringify(record));
  const checkpointBytes = Buffer.from(JSON.stringify(checkpoint));
  fs.writeFileSync(workspaceFile, workspaceBytes);
  fs.writeFileSync(checkpointFile, checkpointBytes);
  return { record, checkpoint, workspaceFile, checkpointFile, workspaceBytes, checkpointBytes };
}

function command(workspaceId, baseRevision, action = 'update') {
  const operationId = randomUUID();
  return {
    workspaceId, actor: 'migration-test', operationId, intent: action,
    requestHash: createHash('sha256').update(`migration-test-${operationId}`).digest('hex'), action, baseRevision,
  };
}

function seed(store, id = randomUUID()) {
  const created = store.commit(command(id, 0, 'create'), {
    create: () => ({
      id, state: initial(), revision: 1, capability: 'test-capability',
      api: 'http://127.0.0.1:3000',
    }),
  }).record;
  return created;
}

function mutate(store, record, label) {
  return store.commit(command(record.id, record.revision), {
    apply: (current) => ({ ...structuredClone(current.state), arc: current.state.arc + 1 }),
    ...(label ? { checkpointLabel: label } : {}),
  }).record;
}

function errorCategory(error) {
  return error?.category ?? error?.code;
}

test('fresh root initializes SQLite without legacy migration', { skip }, async (t) => {
  const root = tempRoot('orbit-migration-fresh-');
  t.after(() => removeRoot(root));
  const store = new SqliteWorkspaceStore(root);
  t.after(() => store.close());
  assert.ok(fs.statSync(path.join(root, 'workspace.sqlite')).isFile());
  const created = seed(store);
  assert.deepEqual(store.read(created.id), created);
});

test('legacy JSON requires explicit import', { skip }, async (t) => {
  const root = tempRoot('orbit-migration-required-');
  t.after(() => removeRoot(root));
  legacyFixture(root);
  let store;
  try {
    store = new SqliteWorkspaceStore(root, { importLegacy: false });
    store.read(LEGACY_ID);
    assert.fail('Expected MIGRATION_REQUIRED from constructor or first read');
  } catch (error) {
    assert.equal(errorCategory(error), 'MIGRATION_REQUIRED');
  } finally {
    store?.close();
  }
});

test('legacy import preserves full record, checkpoint, and original JSON bytes', { skip }, async (t) => {
  const root = tempRoot('orbit-migration-import-');
  t.after(() => removeRoot(root));
  const fixture = legacyFixture(root);
  const store = new SqliteWorkspaceStore(root, { importLegacy: true });
  t.after(() => store.close());
  const actual = store.read(LEGACY_ID);
  assert.deepEqual(actual.state, fixture.record.state);
  assert.equal(actual.capability, fixture.record.capability);
  assert.equal(actual.api, fixture.record.api);
  assert.equal(actual.revision, 7);
  assert.equal(actual.observed_revision, fixture.record.observed_revision);
  assert.equal(actual.browser_seen, fixture.record.browser_seen);
  assert.deepEqual(actual.futureMetadata, { revoked: true });
  assert.deepEqual(store.checkpointGet(LEGACY_ID, LEGACY_CP), { ...fixture.checkpoint, placement: emptyPlacement() });
  const listed = store.checkpointList(LEGACY_ID);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0], (({ state, ...metadata }) => metadata)(fixture.checkpoint));
  assert.ok(!Object.hasOwn(listed[0], 'state'));
  assert.deepEqual(fs.readFileSync(fixture.workspaceFile), fixture.workspaceBytes);
  assert.deepEqual(fs.readFileSync(fixture.checkpointFile), fixture.checkpointBytes);
});

test('reopening with import enabled never reimports modified originals', { skip }, async (t) => {
  const root = tempRoot('orbit-migration-once-');
  t.after(() => removeRoot(root));
  const fixture = legacyFixture(root);
  const first = new SqliteWorkspaceStore(root, { importLegacy: true });
  first.close();
  fs.writeFileSync(fixture.workspaceFile, JSON.stringify({
    ...fixture.record, capability: 'changed-on-disk', revision: 99,
    state: { ...fixture.record.state, arc: 29 },
  }));
  const reopened = new SqliteWorkspaceStore(root, { importLegacy: true });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.read(LEGACY_ID), {...fixture.record,placement:emptyPlacement(),placement_revision:0,recovery_policy:{held:false,generation:0}});
  assert.equal(reopened.read(LEGACY_ID).revision, 7);
  assert.deepEqual(reopened.checkpointList(LEGACY_ID), [
    (({ state, ...metadata }) => metadata)(fixture.checkpoint),
  ]);
});

test('legacy import is atomic when another workspace JSON is corrupt', { skip }, async (t) => {
  const root = tempRoot('orbit-migration-atomic-');
  t.after(() => removeRoot(root));
  const fixture = legacyFixture(root);
  const corruptFile = path.join(root, 'workspaces', '33333333-3333-4333-8333-333333333333.json');
  fs.writeFileSync(corruptFile, '{ invalid JSON');
  let failed;
  try {
    failed = new SqliteWorkspaceStore(root, { importLegacy: true });
    assert.fail('Corrupt legacy JSON must abort import');
  } catch (error) {
    assert.notEqual(error.message, 'Corrupt legacy JSON must abort import');
  } finally {
    failed?.close();
  }
  assert.deepEqual(fs.readFileSync(fixture.workspaceFile), fixture.workspaceBytes);
  assert.deepEqual(fs.readFileSync(fixture.checkpointFile), fixture.checkpointBytes);
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{ invalid JSON');
  fs.unlinkSync(corruptFile);
  const recovered = new SqliteWorkspaceStore(root, { importLegacy: true });
  t.after(() => recovered.close());
  assert.deepEqual(recovered.read(LEGACY_ID), {...fixture.record,placement:emptyPlacement(),placement_revision:0,recovery_policy:{held:false,generation:0}});
  assert.equal(recovered.read(LEGACY_ID).revision, 7);
  assert.deepEqual(recovered.checkpointList(LEGACY_ID), [
    (({ state, ...metadata }) => metadata)(fixture.checkpoint),
  ]);
});

test('backup creates a valid SQLite file with records and checkpoints', { skip }, async (t) => {
  const root = tempRoot('orbit-migration-backup-');
  const restoredRoot = tempRoot('orbit-migration-restored-');
  t.after(() => { removeRoot(root); removeRoot(restoredRoot); });
  const store = new SqliteWorkspaceStore(root);
  t.after(() => store.close());
  let record = seed(store);
  record = mutate(store, record, 'Before first update');
  record = mutate(store, record);
  const checkpoints = store.checkpointList(record.id);
  assert.equal(checkpoints.length, 1);
  const destination = path.join(root, 'backup', 'snapshot.sqlite');
  fs.mkdirSync(path.dirname(destination));
  await store.backup(destination);
  assert.ok(fs.statSync(destination).isFile(), 'backup destination must be a file');
  fs.copyFileSync(destination, path.join(restoredRoot, 'workspace.sqlite'));
  const restored = new SqliteWorkspaceStore(restoredRoot);
  try {
    assert.deepEqual(restored.read(record.id), store.read(record.id));
    assert.deepEqual(restored.checkpointList(record.id), checkpoints);
  } finally {
    restored.close();
  }
  const db = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
  }
});

test('backup rejects an existing destination without altering it', { skip }, async (t) => {
  const root = tempRoot('orbit-migration-existing-');
  t.after(() => removeRoot(root));
  const store = new SqliteWorkspaceStore(root);
  t.after(() => store.close());
  seed(store);
  const destination = path.join(root, 'existing.sqlite');
  const original = Buffer.from('this file belongs to the owner');
  fs.writeFileSync(destination, original);
  await assert.rejects(store.backup(destination));
  assert.deepEqual(fs.readFileSync(destination), original);
});

test('backup leaves source revision, checkpoints, and outbox unchanged', { skip }, async (t) => {
  const root = tempRoot('orbit-migration-readonly-');
  t.after(() => removeRoot(root));
  let store = new SqliteWorkspaceStore(root);
  t.after(() => store?.close());
  let record = seed(store);
  record = mutate(store, record, 'Before update');
  const before = store.read(record.id);
  const checkpoints = store.checkpointList(record.id);
  const events = store.eventsAfter(0);
  const destination = path.join(root, 'readonly-backup.sqlite');
  await store.backup(destination);
  assert.ok(fs.statSync(destination).isFile());
  assert.deepEqual(store.read(record.id), before);
  assert.equal(store.read(record.id).revision, before.revision);
  assert.deepEqual(store.checkpointList(record.id), checkpoints);
  assert.deepEqual(store.eventsAfter(0), events);
  store.close();
  store = new SqliteWorkspaceStore(root);
  assert.deepEqual(store.read(record.id), before);
  assert.deepEqual(store.checkpointList(record.id), checkpoints);
  assert.deepEqual(store.eventsAfter(0), events);
});
