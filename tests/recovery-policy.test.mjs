import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { initial } from '../src/model.ts';
import { createWorkspaceService } from '../server/workspace.mjs';
import { SqliteWorkspaceStore } from '../server/sqlite-workspace-store.mjs';
import { commandIdentity } from '../server/command-identity.mjs';
import Database from 'better-sqlite3';

const manifest = { apiVersion: 1, id: 'recovery-fixture', version: '1.0.0', title: 'Recovery fixture', entry: '/apps/recovery-fixture/index.html' };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-recovery-policy-'));
  const workspace_id = randomUUID(), token = randomUUID();
  let service;
  const server = http.createServer((req, res) => service.handle(req, res, req.url === '/api/workspace/control', req.url === '/api/workspace/recovery'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const start = () => createWorkspaceService({ root, port, token, devOrigins: [], reply: (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  } });
  service = start();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function request(body, { route = 'workspace', credential = token, site = origin } = {}) {
    const response = await fetch(`${origin}/api/workspace/${route}`, {
      method: 'POST', headers: { Origin: site, Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request({ action: 'sync', state: initial() })).status, 200);
  return { root, workspace_id, request, get service() { return service; }, restart() { service.close(); service = start(); } };
}

const policy = (base_revision, held, operation_id = randomUUID()) => ({
  action: 'recovery_policy', base_revision, operation_id, intent: held ? 'isolate plugins' : 'release recovery hold', confirm: true, held,
});

async function installEnabled(request, base_revision = 1) {
  const result = await request({ action: 'plugins_apply', base_revision, operations: [
    { action: 'plugin_install', manifest }, { action: 'plugin_enable', plugin_id: manifest.id },
  ] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state.plugins[0].enabled, true);
  return result.body;
}

test('recovery hold atomically disables registered plugins, advances policy generation, and release does not reenable', async t => {
  const { request, service, workspace_id } = await fixture(t);
  const active = await installEnabled(request);
  const before = service.store.read(workspace_id);
  const held = await request(policy(active.revision, true), { route: 'recovery' });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.deepEqual(held.body.recovery_policy, { held: true, generation: 1 });
  assert.equal(held.body.revision, before.revision + 1);
  assert.equal(held.body.state.plugins[0].enabled, false);
  assert.deepEqual(held.body.state.plugins[0].manifest, manifest);
  assert.equal(held.body.state.plugins[0].window.id, active.state.plugins[0].window.id);
  assert.deepEqual(held.body.state.monitors, active.state.monitors.slice(0, -1));
  assert.deepEqual(service.store.read(workspace_id).recovery_policy, held.body.recovery_policy);
  const released = await request(policy(held.body.revision, false), { route: 'recovery' });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.deepEqual(released.body.recovery_policy, { held: false, generation: 2 });
  assert.equal(released.body.revision, held.body.revision + 1);
  assert.equal(released.body.state.plugins[0].enabled, false);
  assert.deepEqual((await request({ action: 'read' }, { route: 'recovery' })).body.recovery_policy, released.body.recovery_policy);
});

test('recovery policy requires owner authentication, strict metadata, confirmation, and current revision', async t => {
  const { request, service, workspace_id } = await fixture(t);
  const command = policy(1, true, 'strict-policy-1');
  for (const options of [{ credential: 'wrong' }, { site: 'https://foreign.invalid' }]) {
    assert.equal((await request(command, { route: 'recovery', ...options })).status, 403);
  }
  const capability = service.store.read(workspace_id).capability;
  assert.equal((await request(command, { route: 'control', credential: capability })).status, 403);
  for (const invalid of [
    { ...command, confirm: false }, { ...command, confirm: undefined },
    { ...command, operation_id: undefined }, { ...command, intent: undefined },
    { ...command, held: 'true' }, { ...command, actor: 'owner' }, { ...command, extra: true },
  ]) {
    const response = await request(invalid, { route: 'recovery' });
    assert.notEqual(response.status, 200, JSON.stringify(invalid));
  }
  assert.equal(service.store.read(workspace_id).revision, 1);
  const stale = await request({ ...command, base_revision: 0 }, { route: 'recovery' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.category, 'REVISION_CONFLICT');
  assert.equal(service.store.read(workspace_id).revision, 1);
});

test('held policy rejects activation through plugin operations, owner sync, set_workspace, and checkpoint restore without side effects', async t => {
  const { request, service, workspace_id } = await fixture(t);
  const active = await installEnabled(request);
  const saved = await request({ action: 'checkpoint', base_revision: active.revision, label: 'Active plugin recovery fixture' });
  assert.equal(saved.status, 200);
  const held = await request(policy(active.revision, true), { route: 'recovery' });
  assert.equal(held.status, 200);
  const revision = held.body.revision;
  const capability = service.store.read(workspace_id).capability;
  const attempts = [
    request({ action: 'plugins_apply', base_revision: revision, operations: [{ action: 'plugin_enable', plugin_id: manifest.id }] }),
    request({ action: 'sync', base_revision: revision, state: active.state }),
    request({ action: 'apply', base_revision: revision, operations: [{ action: 'set_workspace', state: active.state }], operation_id: 'held-set-workspace', intent: 'restore active state' }, { route: 'control', credential: capability }),
    request({ action: 'restore', base_revision: revision, checkpoint_id: saved.body.checkpoint, confirm: true }, { route: 'recovery' }),
  ];
  for (const result of await Promise.all(attempts)) {
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.category, 'RECOVERY_HOLD');
  }
  const install = await request({ action: 'plugins_apply', base_revision: revision, operations: [
    { action: 'plugin_install', manifest: { ...manifest, id: 'second-fixture' } },
    { action: 'plugin_enable', plugin_id: 'second-fixture' },
  ] });
  assert.equal(install.status, 409);
  assert.equal(install.body.category, 'RECOVERY_HOLD');
  assert.deepEqual(service.store.read(workspace_id).state, held.body.state);
  assert.equal(service.store.read(workspace_id).revision, revision);
  assert.equal(service.store.read(workspace_id).state.plugins.length, 1);
});

test('policy generation invalidates an obsolete receipt replay, including after release', async t => {
  const { request, service, workspace_id } = await fixture(t);
  const first = policy(1, true, 'generation-replay-hold');
  const held = await request(first, { route: 'recovery' });
  assert.equal(held.status, 200);
  assert.deepEqual(await request(first, { route: 'recovery' }), held);
  const release = await request(policy(held.body.revision, false, 'generation-replay-release'), { route: 'recovery' });
  assert.equal(release.status, 200);
  const releasedCommand = policy(held.body.revision, false, 'generation-replay-release');
  assert.deepEqual(await request(releasedCommand, { route: 'recovery' }), release);
  const obsoleteHold = await request(first, { route: 'recovery' });
  assert.equal(obsoleteHold.status, 409);
  assert.equal(obsoleteHold.body.category, 'RECOVERY_POLICY_CHANGED');
  const next = await request(policy(release.body.revision, true, 'next-generation-hold'), { route: 'recovery' });
  assert.equal(next.status, 200);
  const before = service.store.read(workspace_id);
  for (const obsolete of [first, releasedCommand]) {
    const replay = await request(obsolete, { route: 'recovery' });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.category, 'RECOVERY_POLICY_CHANGED');
  }
  assert.deepEqual(service.store.read(workspace_id), before);
});

test('recovery policy survives service restart and SQLite backup', async t => {
  const fixtureState = await fixture(t);
  const { root, workspace_id, request } = fixtureState;
  const held = await request(policy(1, true), { route: 'recovery' });
  assert.equal(held.status, 200);
  fixtureState.restart();
  assert.deepEqual((await request({ action: 'read' }, { route: 'recovery' })).body.recovery_policy, held.body.recovery_policy);
  const backup = path.join(root, 'recovery-backup.sqlite');
  await fixtureState.service.store.backup(backup);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-recovery-policy-copy-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.copyFileSync(backup, path.join(copy, 'workspace.sqlite'));
  const restored = new SqliteWorkspaceStore(copy);
  try {
    assert.deepEqual(restored.read(workspace_id).recovery_policy, held.body.recovery_policy);
    assert.equal(restored.read(workspace_id).revision, held.body.revision);
  } finally { restored.close(); }
});

test('held workspace permits unrelated layout changes and rejects replay of a pre-hold active result', async t => {
  const { request, service, workspace_id } = await fixture(t);
  const activeCommand = { action: 'plugins_apply', base_revision: 1, operation_id: 'install-active-before-hold', intent: 'activate test plugin', operations: [
    { action: 'plugin_install', manifest }, { action: 'plugin_enable', plugin_id: manifest.id },
  ] };
  const active = await request(activeCommand);
  assert.equal(active.status, 200);
  const held = await request(policy(active.body.revision, true), { route: 'recovery' });
  assert.equal(held.status, 200);
  const replay = await request(activeCommand);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.category, 'RECOVERY_POLICY_CHANGED');
  const unrelated = await request({ action: 'sync', base_revision: held.body.revision, state: { ...held.body.state, arc: 12 } });
  assert.equal(unrelated.status, 200, JSON.stringify(unrelated.body));
  assert.deepEqual(unrelated.body.recovery_policy, held.body.recovery_policy);
  assert.equal(unrelated.body.state.plugins[0].enabled, false);
  assert.equal(service.store.read(workspace_id).revision, held.body.revision + 1);
});

test('opening a version-1 database upgrades in place without losing its records', async t => {
  const fixtureState = await fixture(t);
  const { root, workspace_id, request } = fixtureState;
  fixtureState.service.close();
  const database = new Database(path.join(root, 'workspace.sqlite'));
  try {
    const row = database.prepare('SELECT record_json FROM workspaces WHERE id=?').get(workspace_id);
    const record = JSON.parse(row.record_json);
    delete record.recovery_policy;
    database.prepare('UPDATE workspaces SET record_json=? WHERE id=?').run(JSON.stringify(record), workspace_id);
    database.exec('ALTER TABLE receipts DROP COLUMN policy_generation');
    database.pragma('user_version = 1');
  } finally { database.close(); }
  fixtureState.restart();
  const read = await request({ action: 'read' }, { route: 'recovery' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.recovery_policy, { held: false, generation: 0 });
  assert.equal(read.body.workspace_id, workspace_id);
  assert.equal(fixtureState.service.store.diagnostics().schema_version, 5);
  const held = await request(policy(read.body.revision, true), { route: 'recovery' });
  assert.equal(held.status, 200);
  const check = new Database(path.join(root, 'workspace.sqlite'), { readonly: true });
  try { assert.equal(check.pragma('user_version', { simple: true }), 5); } finally { check.close(); }
});

test('failed policy transition rolls back state, generation, revision, checkpoint, receipt, and event', async t => {
  const { service, workspace_id, request } = await fixture(t);
  const active = await installEnabled(request);
  const store = service.store;
  const before = structuredClone(store.read(workspace_id));
  const diagnostics = store.diagnostics();
  const identity = commandIdentity({ workspace_id, ...policy(active.revision, true, 'rollback-transition') }, 'owner');
  assert.throws(() => store.commit(identity, {
    recoveryPolicy: true,
    checkpointLabel: 'Before failed recovery policy',
    response: () => { throw Error('simulate failure before commit'); },
  }), /simulate failure/);
  assert.deepEqual(store.read(workspace_id), before);
  const after = store.diagnostics();
  for (const key of ['checkpoints', 'receipts', 'events']) assert.equal(after[key], diagnostics[key], key);
  const succeeded = await request(policy(active.revision, true, 'rollback-transition'), { route: 'recovery' });
  assert.equal(succeeded.status, 200);
  assert.deepEqual(succeeded.body.recovery_policy, { held: true, generation: 1 });
});
