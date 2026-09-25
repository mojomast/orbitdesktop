import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { initial } from '../src/model.ts';
import { loadSqliteWorkspaceStore, tempRoot, removeRoot, errorCategory } from './fixtures/sqlite-store-helpers.mjs';

const SqliteWorkspaceStore = await loadSqliteWorkspaceStore();
const skip = SqliteWorkspaceStore ? false : 'server/sqlite-workspace-store.mjs is not implemented yet';

function setup(t) {
  const root = tempRoot('orbit-sqlite-store-test-');
  let store;
  t.after(() => { try { store?.close?.(); } catch {} removeRoot(root); });
  store = new SqliteWorkspaceStore(root);
  return { root, get store() { return store; }, reopen() { store = new SqliteWorkspaceStore(root); return store; } };
}

function command(workspaceId, baseRevision, overrides = {}) {
  return {
    workspaceId, actor: 'sqlite-store-test', operationId: randomUUID(),
    intent: 'test mutation', requestHash: createHash('sha256').update(randomUUID()).digest('hex'), action: 'update',
    baseRevision, ...overrides,
  };
}

function create(store) {
  const record = {
    id: randomUUID(), state: initial(), revision: 1,
    capability: randomUUID(), api: 'http://localhost:4317',
    observed_revision: 0, browser_seen: false, futureMetadata: { revoked: true },
  };
  const output = store.commit(command(record.id, 0, { action: 'create' }), {
    create: () => structuredClone(record),
    response: (saved) => ({ id: saved.id, revision: saved.revision }),
  });
  return { record, output };
}

const toggle = (record) => ({ ...record.state, sidebarHidden: !record.state.sidebarHidden });

function assertFields(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
}

function assertNoKeys(value, forbidden) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!forbidden.includes(key), `unexpected private key: ${key}`);
    assertNoKeys(child, forbidden);
  }
}

function cursor(event) {
  const value = event.cursor ?? event.sequence ?? event.seq ?? event.id;
  assert.equal(typeof value, 'number', 'event cursor must be numeric');
  assert.ok(Number.isFinite(value));
  return value;
}

function checkpointKey(checkpoint) {
  const key = checkpoint.key ?? checkpoint.id;
  assert.ok(key !== undefined, 'checkpoint metadata must expose a key or id');
  return key;
}

test('fresh root creates authoritative DB and preserves private record metadata', { skip }, async (t) => {
  const { root, store } = setup(t);
  assert.ok(fs.existsSync(path.join(root, 'workspace.sqlite')));
  const { record, output } = create(store);
  assert.equal(output.record.revision, 1);
  assertFields(store.read(record.id), record);
  assert.deepEqual(store.connection(record.id), {
    workspace_id: record.id, storage: 'sqlite-v1', api: record.api, capability: record.capability,
  });
});

test('mutation owns revision numbering, updates api, returns response and preserves metadata', { skip }, async (t) => {
  const { store } = setup(t);
  const { record } = create(store);
  let applied = false;
  const output = store.commit(command(record.id, 1), {
    api: 'http://localhost:4318',
    apply: (current) => {
      applied = true;
      assert.equal(current.revision, 1);
      assert.deepEqual(current.state, record.state);
      return toggle(current);
    },
    response: (current, checkpoint) => {
      return { revision: current.revision, hidden: current.state.sidebarHidden };
    },
  });
  assert.ok(applied);
  assert.equal(output.replayed, false);
  assert.deepEqual(output.result, { revision: 2, hidden: !record.state.sidebarHidden });
  assertFields(store.read(record.id), {
    ...record, revision: 2, api: 'http://localhost:4318', state: toggle(record),
  });
});

test('response receipt survives reopening and replay never reruns callbacks', { skip }, async (t) => {
  const fixture = setup(t);
  const { record } = create(fixture.store);
  const cmd = command(record.id, 1);
  let applyCalls = 0;
  let responseCalls = 0;
  const change = {
    apply: (current) => { applyCalls++; return toggle(current); },
    response: (current) => { responseCalls++; return { revision: current.revision, nested: { token: randomUUID() } }; },
  };
  const first = fixture.store.commit(cmd, change);
  fixture.store.close();
  const replay = fixture.reopen().commit(cmd, change);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.record.revision, first.record.revision);
  assert.equal(applyCalls, 1);
  assert.equal(responseCalls, 1);
});

test('receipt lookup precedes the stale base revision check', { skip }, async (t) => {
  const { store } = setup(t);
  const { record } = create(store);
  const cmd = command(record.id, 1);
  const first = store.commit(cmd, { apply: toggle, response: (current) => ({ revision: current.revision }) });
  assert.equal(store.read(record.id).revision, 2);
  const replay = store.commit({ ...cmd, baseRevision: 1 }, {
    apply: () => { throw new Error('replay must not apply'); },
    response: () => { throw new Error('replay must not respond again'); },
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(replay.record.revision, 2);
});

test('new stale operations conflict and missing workspaces return ENOENT', { skip }, async (t) => {
  const { store } = setup(t);
  const { record } = create(store);
  store.commit(command(record.id, 1), { apply: toggle });
  assert.throws(() => store.commit(command(record.id, 1), { apply: toggle }),
    (error) => error.category === 'REVISION_CONFLICT');
  const missing = randomUUID();
  assert.throws(() => store.read(missing), (error) => errorCategory(error) === 'ENOENT');
  assert.throws(() => store.commit(command(missing, 0), { apply: toggle }),
    (error) => errorCategory(error) === 'ENOENT');
});

test('different request hash for a used operation conflicts without mutation', { skip }, async (t) => {
  const { store } = setup(t);
  const { record } = create(store);
  const cmd = command(record.id, 1);
  store.commit(cmd, { apply: toggle });
  const before = structuredClone(store.read(record.id));
  assert.throws(() => store.commit({ ...cmd, requestHash: createHash('sha256').update(randomUUID()).digest('hex') }, { apply: toggle }),
    (error) => error.category === 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(store.read(record.id), before);
});

test('checkpoints contain pre-change state, list newest first and support checkpoint-only commits', { skip }, async (t) => {
  const { store } = setup(t);
  const { record } = create(store);
  store.commit(command(record.id, 1), { apply: toggle, checkpointLabel: 'first' });
  const firstList = store.checkpointList(record.id);
  assert.equal(firstList.length, 1);
  assertNoKeys(firstList, ['state']);
  const first = store.checkpointGet(record.id, checkpointKey(firstList[0]));
  assert.equal(first.revision, 1);
  assert.deepEqual(first.state, record.state);
  await new Promise((resolve) => setTimeout(resolve, 20));
  store.commit(command(record.id, 2), { apply: toggle, checkpointLabel: 'second' });
  const list = store.checkpointList(record.id);
  assert.equal(list.length, 2);
  assertNoKeys(list, ['state']);
  assert.equal(checkpointKey(list[1]), checkpointKey(firstList[0]));
  assert.ok(list[0].created >= list[1].created);
  const second = store.checkpointGet(record.id, checkpointKey(list[0]));
  assert.equal(second.revision, 2);
  assert.deepEqual(second.state, toggle(record));
  const before = structuredClone(store.read(record.id));
  store.commit(command(record.id, 3), { checkpointOnly: true, checkpointLabel: 'only' });
  assert.equal(store.checkpointList(record.id).length, 3);
  assert.equal(store.read(record.id).revision, 3);
  assert.deepEqual(store.read(record.id).state, before.state);
  assert.throws(() => store.checkpointGet(record.id, randomUUID()), (error) => errorCategory(error) === 'ENOENT');
});

test('skipUnchanged keeps revision for equal state but increments for changed state', { skip }, async (t) => {
  const { store } = setup(t);
  const { record } = create(store);
  const unchanged = store.commit(command(record.id, 1), {
    skipUnchanged: true, apply: (current) => structuredClone(current.state),
  });
  assert.equal(unchanged.record.revision, 1);
  assert.equal(store.read(record.id).revision, 1);
  const changed = store.commit(command(record.id, 1), { skipUnchanged: true, apply: toggle });
  assert.equal(changed.record.revision, 2);
  assert.deepEqual(store.read(record.id).state, toggle(record));
});

test('outbox events have ordered numeric cursors, respect limits and omit private state', { skip }, async (t) => {
  const { store } = setup(t);
  const { record } = create(store);
  for (let revision = 1; revision <= 3; revision++) {
    store.commit(command(record.id, revision), { apply: toggle });
  }
  const events = store.eventsAfter(0);
  assert.ok(Array.isArray(events));
  assert.ok(events.length >= 4, 'creation and each mutation must publish an event');
  assertNoKeys(events, ['state', 'capability']);
  let previous = 0;
  for (const event of events) {
    assert.ok(cursor(event) > previous);
    previous = cursor(event);
  }
  assert.deepEqual(store.eventsAfter(previous), []);
  assert.deepEqual(store.eventsAfter(0, 2), events.slice(0, 2));
  const after = cursor(events[0]);
  const remaining = store.eventsAfter(after);
  assert.deepEqual(remaining, events.slice(1));
  for (const event of remaining) assert.ok(cursor(event) > after);
});

test('throwing apply, response and create callbacks roll back atomically', { skip }, async (t) => {
  const { store } = setup(t);
  const { record } = create(store);
  const snapshot = () => structuredClone({
    revision: store.read(record.id).revision, state: store.read(record.id).state,
    checkpoints: store.checkpointList(record.id), events: store.eventsAfter(0),
  });
  for (const stage of ['apply', 'response']) {
    const before = snapshot();
    const failure = new Error(`${stage} failed`);
    const cmd = command(record.id, 1);
    assert.throws(() => store.commit(cmd, {
      checkpointLabel: `rollback-${stage}`,
      apply: (current) => { if (stage === 'apply') throw failure; return toggle(current); },
      response: () => { throw failure; },
    }), (error) => error === failure);
    assert.deepEqual(snapshot(), before);
  }
  const missing = randomUUID();
  const before = snapshot();
  const failure = new Error('create failed');
  assert.throws(() => store.commit(command(missing, 0, { action: 'create' }), {
    create: () => { throw failure; },
  }), (error) => error === failure);
  assert.throws(() => store.read(missing), (error) => errorCategory(error) === 'ENOENT');
  assert.deepEqual(snapshot(), before);
});

test('discovery credentials can be deleted without losing authoritative records', { skip }, async (t) => {
  const { root, store } = setup(t);
  const { record } = create(store);
  const projectionFile = path.join(root, 'workspace-access', `${record.id}.json`);
  assert.ok(fs.existsSync(projectionFile));
  const projection = JSON.parse(fs.readFileSync(projectionFile, 'utf8'));
  assert.equal(projection.capability, record.capability);
  assertNoKeys(projection, ['state']);
  fs.unlinkSync(projectionFile);
  assertFields(store.read(record.id), record);
  assert.deepEqual(store.connection(record.id), {
    workspace_id: record.id, storage: 'sqlite-v1', api: record.api, capability: record.capability,
  });
});

test('abrupt worker exit preserves committed state and durable replay receipt', { skip }, async (t) => {
  const fixture = setup(t);
  const { record } = create(fixture.store);
  fixture.store.close();
  const cmd = command(record.id, 1);
  const marker = randomUUID();
  const specPath = path.join(fixture.root, 'worker-spec.json');
  const outPath = path.join(fixture.root, 'worker-output.json');
  fs.writeFileSync(specPath, JSON.stringify({ root: fixture.root, command: cmd, marker }));
  const workerFile = new URL('./fixtures/sqlite-crash-worker.mjs', import.meta.url).pathname;
  const child = spawnSync(process.execPath, ['--experimental-strip-types', workerFile, specPath, outPath], { env: process.env });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr?.toString());
  const { output, applyCalls } = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(applyCalls, 1);
  assert.equal(output.record.revision, 2);
  assert.equal(output.replayed, false);
  assert.deepEqual(output.result, { revision: 2, hidden: true, marker });
  const store = fixture.reopen();
  assert.equal(store.read(record.id).revision, 2);
  assert.equal(store.read(record.id).state.sidebarHidden, true);
  const replay = store.commit(cmd, { apply: () => { throw new Error('crash replay must not apply'); } });
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.revision, 2);
  assert.deepEqual(replay.result, output.result);
});
