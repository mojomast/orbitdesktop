import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createProjectTools} from '../server/project-tools.mjs';
import {projectToolChecks} from '../server/project-tools-evidence.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';
import {TOOL_LIMITS} from '../contracts/project-tools-v1.mjs';

function findPaneUrl(state, url) {
  for (const monitor of state.monitors) {
    let found = null;
    const visit = node => {if (node.type === 'pane') {if (node.pane.url === url) found = node.pane;} else {visit(node.first); visit(node.second);}};
    visit(monitor.layout);
    if (found) return found;
  }
  return null;
}

function fixture(t) {
  const root = fs.mkdtempSync('/tmp/opencode/project-tools-');
  const store = new SqliteWorkspaceStore(path.join(root, 'runtime'));
  const workspace_id = randomUUID();
  store.commit(commandIdentity({workspace_id, action: 'sync', base_revision: 0, state: initial(), operation_id: randomUUID()}, 'owner'), {
    create: () => ({id: workspace_id, revision: 1, state: initial(), capability: randomUUID(), api: 'http://127.0.0.1:0'}),
  });
  const records = new WorkbenchStore(store);
  const data = new WorkbenchData(store);
  const projectRoot = path.join(root, 'source');
  fs.mkdirSync(projectRoot);
  const opened = openProjectRoot(projectRoot);
  const project = records.register(workspace_id, {root: projectRoot, name: 'Tool fixture', identity: opened.identity});
  opened.close();

  const state = {time: 1000};
  const tools = createProjectTools({store, records, data, now: () => state.time});
  t.after(() => {store.close(); fs.rmSync(root, {recursive: true, force: true});});

  const call = async (fields, actor = 'owner') => {
    const body = {workspace_id, ...fields};
    // `resolve` intentionally has no project selector: it derives scope from the
    // authoritative binding. Other actions default to the fixture project.
    if (body.action !== 'resolve' && body.project_id === undefined) body.project_id = project.id;
    return tools.dispatch(body, {actor});
  };
  const newProject = name => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const handle = openProjectRoot(dir);
    const registered = records.register(workspace_id, {root: dir, name, identity: handle.identity});
    handle.close();
    return registered;
  };
  const bump = () => {
    const before = store.read(workspace_id);
    store.commit(commandIdentity({workspace_id, action: 'apply', base_revision: before.revision, operation_id: randomUUID(), intent: 'Fixture bump'}, 'owner'), {
      apply: current => {const next = structuredClone(current.state); const index = next.monitors.findIndex(m => m.id === next.selected); next.selected = next.monitors[(index + 1) % next.monitors.length].id; return next;},
    });
  };
  const setHold = held => {
    const before = store.read(workspace_id);
    store.commit(commandIdentity({workspace_id, action: 'recovery_policy', base_revision: before.revision, operation_id: randomUUID(), intent: held ? 'Enter hold' : 'Release hold', held}, 'owner'), {recoveryPolicy: held, checkpointLabel: 'Before recovery policy change'});
  };
  const createTool = async ({kind = 'notebook', title = 'Notes', project: projectId = project.id, ...fields} = {}) => {
    const base = store.read(workspace_id).revision;
    const preview = await call({action: 'create_preview', project_id: projectId, kind, title, base_revision: base, ...fields});
    const commit = await call({action: 'create_commit', project_id: projectId, preview_id: preview.preview_id, preview_digest: preview.preview_digest, op_id: randomUUID(), intent: 'Install tool'});
    const pane = findPaneUrl(store.read(workspace_id).state, `orbit://project-tool/${commit.instance.id}`);
    return {preview, commit, instance: commit.instance, pane_id: pane.id, project_id: projectId};
  };
  const save = (instance, text, expected_revision, op_id = randomUUID()) => call({
    action: 'data_save', project_id: instance.project_id, instance_id: instance.instance.id, pane_id: instance.pane_id,
    expected_revision, data: {text}, op_id, intent: 'Save notes',
  });
  const read = instance => call({action: 'data_read', project_id: instance.project_id, instance_id: instance.instance.id, pane_id: instance.pane_id});
  const instanceCount = () => data.db.prepare('SELECT count(*) AS n FROM wb_tool_instances WHERE workspace_id=?').get(workspace_id).n;
  const checkpoint = label => store.commit(commandIdentity({workspace_id, action: 'checkpoint', base_revision: store.read(workspace_id).revision, operation_id: randomUUID(), intent: label}, 'owner'), {checkpointOnly: true, checkpointLabel: label, response: (next, cp) => ({checkpoint: cp?.id ?? null})}).result.checkpoint;
  const restore = checkpointId => {
    const cp = store.checkpointGet(workspace_id, checkpointId);
    store.commit(commandIdentity({workspace_id, action: 'restore', base_revision: store.read(workspace_id).revision, operation_id: randomUUID(), intent: 'Restore fixture'}, 'owner'), {apply: () => structuredClone(cp.state), placement: cp.placement});
  };
  return {root, store, records, data, tools, workspace_id, project, state, call, newProject, bump, setHold, createTool, save, read, instanceCount, checkpoint, restore};
}

test('metadata_list seeds two closed host releases per definition and a legacy plugin projection', async t => {
  const f = fixture(t);
  const meta = await f.call({action: 'metadata_list'});
  assert.equal(meta.definitions.length, 2);
  const notebook = meta.definitions.find(record => record.kind === 'notebook');
  const checks = meta.definitions.find(record => record.kind === 'evidence_checks');
  assert.ok(notebook && checks);
  const releases = meta.releases.filter(record => record.definition_id === notebook.id);
  assert.deepEqual(releases.map(record => record.release).sort(), ['1', '2']);
  assert.ok(releases.every(record => record.data_schema_version === 1 && record.status === 'available'));
  assert.equal(new Set(releases.map(record => record.host_digest)).size, 2);
  assert.deepEqual(meta.legacy_plugins, []);
  assert.equal(meta.limits.maxInstances, 64);
  const again = await f.call({action: 'metadata_list'});
  assert.equal(again.definitions.length, 2);
  assert.equal(again.releases.length, 4);
});

test('create_preview/create_commit atomically inserts layout, instance, binding, checkpoint and receipt', async t => {
  const f = fixture(t);
  const before = f.store.read(f.workspace_id);
  const preview = await f.call({action: 'create_preview', kind: 'notebook', title: 'Lab notes', base_revision: before.revision});
  assert.equal(preview.rendered, false);
  assert.equal(preview.tested, false);
  assert.equal(preview.preview_digest.length, 64);
  assert.ok(preview.expires_at > f.state.time);
  assert.ok(preview.diff.length >= 2);
  const commit = await f.call({action: 'create_commit', preview_id: preview.preview_id, preview_digest: preview.preview_digest, op_id: randomUUID(), intent: 'Install notebook'});
  assert.equal(commit.instance.kind, 'notebook');
  assert.equal(commit.instance.enabled, true);
  assert.equal(commit.instance.revoked, false);
  assert.equal(commit.instance.revision, 1);
  assert.ok(commit.checkpoint_id);
  assert.equal(commit.command_receipt.legacy, false);
  const after = f.store.read(f.workspace_id);
  assert.ok(after.revision > before.revision);
  const pane = findPaneUrl(after.state, `orbit://project-tool/${commit.instance.id}`);
  assert.ok(pane && pane.kind === 'browser');
  const binding = f.data.db.prepare('SELECT * FROM wb_tool_bindings WHERE workspace_id=? AND pane_id=?').get(f.workspace_id, pane.id);
  assert.equal(binding.instance_id, commit.instance.id);
  assert.ok(f.store.checkpointList(f.workspace_id).some(entry => entry.id === commit.checkpoint_id));
  const resolved = await f.call({action: 'resolve', pane_id: pane.id});
  assert.equal(resolved.instance.id, commit.instance.id);
  assert.equal(resolved.release.release, '1');
  assert.equal(resolved.release.data_schema_version, 1);
  assert.equal(typeof resolved.policy_generation, 'number');
  assert.equal(resolved.checks, undefined);
});

test('resolve refuses a forged URL, a missing binding, a disabled or revoked instance and a held workspace', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Resolve'});
  await assert.rejects(f.call({action: 'resolve', pane_id: 'nope'}), {code: 'permission_denied'});
  // Rewrite the pane URL so the selector no longer matches the binding.
  const changed = f.store.read(f.workspace_id);
  const before = f.store.read(f.workspace_id).revision;
  const mutate = schedule => f.store.commit(commandIdentity({workspace_id: f.workspace_id, action: 'apply', base_revision: before, operation_id: randomUUID(), intent: 'Forge URL'}, 'owner'), {apply: current => {const next = structuredClone(current.state); schedule(next); return next;}});
  mutate(state => {const pane = findPaneUrl(state, `orbit://project-tool/${tool.instance.id}`); pane.url = 'orbit://project-tool/00000000-0000-0000-0000-000000000000';});
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), {code: 'permission_denied'});
  // Project inactive.
  const project = f.records.project(f.workspace_id, f.project.id);
  f.records.revoke(f.workspace_id, f.project.id, project.generation);
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), {code: 'permission_denied'});
  // A held workspace is refused distinctly (reactivate the project first).
  const revived = f.records.register(f.workspace_id, {root: path.join(f.root, 'source'), name: 'Tool fixture', identity: f.records.projectForRecovery(f.workspace_id, f.project.id).identity});
  assert.equal(revived.active, true);
  const tool2 = await f.createTool({title: 'Held', project: f.project.id});
  f.setHold(true);
  await assert.rejects(f.call({action: 'resolve', pane_id: tool2.pane_id}), error => error.code === 'conflict' && error.reason === 'recovery_hold');
});

test('independent private data uses CAS and the receipt stores no note bytes', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Notes'});
  const first = await f.save(tool, 'hello world', 0);
  assert.deepEqual(first, {revision: 1, instance_id: tool.instance.id, data_schema_version: 1});
  await assert.rejects(f.save(tool, 'stale', 0), {code: 'stale_resource'});
  const loaded = await f.read(tool);
  assert.equal(loaded.data.text, 'hello world');
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.instance_revision, tool.instance.revision);
  assert.equal(loaded.data_schema_version, 1);
  // Receipt-first replay returns the original metadata even after the revision moved.
  const opId = randomUUID();
  await f.save(tool, 'one', 1, opId);
  await f.save(tool, 'two', 2);
  const replay = await f.save(tool, 'one', 1, opId);
  assert.deepEqual(replay, {revision: 2, instance_id: tool.instance.id, data_schema_version: 1});
  // Changed payload on the same key is a conflict, never a reapply.
  await assert.rejects(f.save(tool, 'changed', 3, opId), {code: 'conflict'});
  const receipt = f.data.db.prepare('SELECT result_json FROM wb_tool_receipts WHERE workspace_id=? AND op_id=?').get(f.workspace_id, opId);
  assert.ok(!receipt.result_json.includes('one'));
  const after = await f.read(tool);
  assert.equal(after.data.text, 'two');
});

test('configure replaces bounded primitive config, allowed while disabled but not revoked', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Config'});
  const configured = await f.call({action: 'configure', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, config: {font_size: 20, show_counts: true}, op_id: randomUUID(), intent: 'Configure'});
  assert.deepEqual(configured.instance.config, {font_size: 20, show_counts: true});
  await assert.rejects(f.call({action: 'configure', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: configured.instance.revision, config: {font_size: 99}, op_id: randomUUID(), intent: 'Bad config'}), {code: 'invalid_request'});
  await assert.rejects(f.call({action: 'configure', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: configured.instance.revision, config: {unknown: true}, op_id: randomUUID(), intent: 'Bad config'}), {code: 'invalid_request'});
  const disabled = await f.call({action: 'set_enabled', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: configured.instance.revision, enabled: false, op_id: randomUUID(), intent: 'Disable'});
  assert.equal(disabled.instance.enabled, false);
  const whileDisabled = await f.call({action: 'configure', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: disabled.instance.revision, config: {font_size: 14}, op_id: randomUUID(), intent: 'Configure disabled'});
  assert.deepEqual(whileDisabled.instance.config, {font_size: 14});
  const revoked = await f.call({action: 'revoke', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: whileDisabled.instance.revision, op_id: randomUUID(), intent: 'Revoke'});
  assert.equal(revoked.instance.revoked, true);
  assert.equal(revoked.instance.enabled, false);
  await assert.rejects(f.call({action: 'configure', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: revoked.instance.revision, config: {font_size: 15}, op_id: randomUUID(), intent: 'Configure revoked'}), {code: 'revoked'});
  await assert.rejects(f.call({action: 'set_enabled', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: revoked.instance.revision, enabled: true, op_id: randomUUID(), intent: 'Re-enable revoked'}), {code: 'revoked'});
  // Revoke is terminal.
  await assert.rejects(f.call({action: 'revoke', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: revoked.instance.revision, op_id: randomUUID(), intent: 'Revoke again'}), {code: 'stale_resource'});
});

test('set_enabled(true) is refused on an inactive project', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Inactive'});
  const disabled = await f.call({action: 'set_enabled', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, enabled: false, op_id: randomUUID(), intent: 'Disable'});
  const project = f.records.project(f.workspace_id, f.project.id);
  f.records.revoke(f.workspace_id, f.project.id, project.generation);
  await assert.rejects(f.call({action: 'set_enabled', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: disabled.instance.revision, enabled: true, op_id: randomUUID(), intent: 'Enable inactive'}), {code: 'permission_denied'});
});

test('compatible repin preserves notes and can revert; an incompatible data schema is refused', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Repin'});
  await f.save(tool, 'kept', 0);
  const meta = await f.call({action: 'metadata_list'});
  const notebook = meta.definitions.find(record => record.kind === 'notebook');
  const v1 = meta.releases.find(record => record.definition_id === notebook.id && record.release === '1');
  const v2 = meta.releases.find(record => record.definition_id === notebook.id && record.release === '2');
  const upgraded = await f.call({action: 'repin', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, release_id: v2.id, op_id: randomUUID(), intent: 'Repin v2'});
  assert.equal(upgraded.instance.release_id, v2.id);
  assert.equal((await f.read(tool)).data.text, 'kept');
  const reverted = await f.call({action: 'repin', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: upgraded.instance.revision, release_id: v1.id, op_id: randomUUID(), intent: 'Revert v1'});
  assert.equal(reverted.instance.release_id, v1.id);
  const incompatible = {version: 1, id: randomUUID(), definition_id: notebook.id, release: '9', host_digest: 'a'.repeat(64), data_schema_version: 2, status: 'available', render_version: 9, created_at: 1};
  f.data.db.prepare('INSERT INTO wb_tool_releases(id,definition_id,record_json) VALUES (?,?,?)').run(incompatible.id, notebook.id, JSON.stringify(incompatible));
  // The closed trusted-descriptor check refuses the synthetic release outright
  // (unknown render/data version and digest), not merely because its data schema
  // differs from the current pin.
  await assert.rejects(f.call({action: 'repin', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: reverted.instance.revision, release_id: incompatible.id, op_id: randomUUID(), intent: 'Repin bad'}), {code: 'unsupported'});
  assert.equal((await f.read(tool)).data.text, 'kept');
});

test('recovery hold blocks new instances and private operations; release never re-enables', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Held tool'});
  f.setHold(true);
  await assert.rejects(f.call({action: 'create_preview', kind: 'notebook', title: 'Held', base_revision: f.store.read(f.workspace_id).revision}), error => error.code === 'conflict' && error.reason === 'recovery_hold');
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), error => error.code === 'conflict' && error.reason === 'recovery_hold');
  await assert.rejects(f.read(tool), error => error.code === 'conflict' && error.reason === 'recovery_hold');
  await assert.rejects(f.call({action: 'data_save', project_id: tool.project_id, instance_id: tool.instance.id, pane_id: tool.pane_id, expected_revision: 0, data: {text: 'x'}, op_id: randomUUID(), intent: 'Save'}), error => error.code === 'conflict' && error.reason === 'recovery_hold');
  await assert.rejects(f.call({action: 'set_enabled', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, enabled: true, op_id: randomUUID(), intent: 'Enable held'}), error => error.code === 'conflict' && error.reason === 'recovery_hold');
  const meta = await f.call({action: 'metadata_list'});
  assert.ok(meta.definitions.length === 2 && meta.instances.length === 1);
  f.setHold(false);
  // The lead-owned hold transaction disabled the enabled instance; release must
  // not re-enable it, and the service never auto-enables a disabled instance.
  assert.ok(f.records.projectForRecovery(f.workspace_id, f.project.id).active !== false);
  const afterRelease = JSON.parse(f.data.db.prepare('SELECT record_json FROM wb_tool_instances WHERE id=?').get(tool.instance.id).record_json);
  assert.equal(afterRelease.enabled, false);
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), {code: 'unavailable'});

  const disabledTool = await f.createTool({title: 'Disabled tool'});
  await f.call({action: 'set_enabled', project_id: disabledTool.project_id, instance_id: disabledTool.instance.id, expected_revision: disabledTool.instance.revision, enabled: false, op_id: randomUUID(), intent: 'Disable'});
  f.setHold(true);
  f.setHold(false);
  await assert.rejects(f.call({action: 'resolve', pane_id: disabledTool.pane_id}), {code: 'unavailable'});
});

test('a recovery generation change refuses a staged commit as stale', async t => {
  const f = fixture(t);
  const preview = await f.call({action: 'create_preview', kind: 'notebook', title: 'Fenced', base_revision: f.store.read(f.workspace_id).revision});
  f.setHold(true);
  f.setHold(false);
  await assert.rejects(f.call({action: 'create_commit', preview_id: preview.preview_id, preview_digest: preview.preview_digest, op_id: randomUUID(), intent: 'Install fenced'}), error => error.code === 'stale_resource' && error.reason === 'recovery_generation');
});

test('a stale base revision and an expired preview are refused; a committed receipt replays first', async t => {
  const f = fixture(t);
  const stale = await f.call({action: 'create_preview', kind: 'notebook', title: 'Stale', base_revision: f.store.read(f.workspace_id).revision});
  f.bump();
  await assert.rejects(f.call({action: 'create_commit', preview_id: stale.preview_id, preview_digest: stale.preview_digest, op_id: randomUUID(), intent: 'Install stale'}), {code: 'stale_resource'});

  const expiring = await f.call({action: 'create_preview', kind: 'notebook', title: 'Expiring', base_revision: f.store.read(f.workspace_id).revision});
  f.state.time += TOOL_LIMITS.previewTtlMs + 1;
  await assert.rejects(f.call({action: 'create_commit', preview_id: expiring.preview_id, preview_digest: expiring.preview_digest, op_id: randomUUID(), intent: 'Install expired'}), {code: 'expired'});
  const status = JSON.parse(f.data.db.prepare('SELECT record_json FROM wb_tool_proposals WHERE id=?').get(expiring.preview_id).record_json).status;
  assert.equal(status, 'stale');

  f.state.time += 1000;
  const fresh = await f.call({action: 'create_preview', kind: 'notebook', title: 'Replay', base_revision: f.store.read(f.workspace_id).revision});
  const opId = randomUUID();
  const committed = await f.call({action: 'create_commit', preview_id: fresh.preview_id, preview_digest: fresh.preview_digest, op_id: opId, intent: 'Install replay'});
  f.bump();
  const replay = await f.call({action: 'create_commit', preview_id: fresh.preview_id, preview_digest: fresh.preview_digest, op_id: opId, intent: 'Install replay'});
  assert.deepEqual(replay, committed);
  assert.equal(f.instanceCount(), 1);
});

test('two instances stay isolated and a second connection cannot reuse a stale revision', async t => {
  const f = fixture(t);
  const first = await f.createTool({title: 'One'});
  const second = await f.createTool({title: 'Two'});
  await f.save(first, 'first notes', 0);
  assert.equal((await f.read(first)).data.text, 'first notes');
  assert.equal((await f.read(second)).data.text, '');

  const store2 = new SqliteWorkspaceStore(path.join(f.root, 'runtime'));
  const tools2 = createProjectTools({store: store2, records: new WorkbenchStore(store2), data: new WorkbenchData(store2), now: () => f.state.time});
  await assert.rejects(tools2.dispatch({workspace_id: f.workspace_id, action: 'data_save', project_id: first.project_id, instance_id: first.instance.id, pane_id: first.pane_id, expected_revision: 0, data: {text: 'racing'}, op_id: randomUUID(), intent: 'Race'}, {actor: 'owner'}), {code: 'stale_resource'});
  store2.close();

  // Revoking one instance never touches the other.
  await f.call({action: 'revoke', project_id: first.project_id, instance_id: first.instance.id, expected_revision: first.instance.revision, op_id: randomUUID(), intent: 'Revoke one'});
  const resolved = await f.call({action: 'resolve', pane_id: second.pane_id});
  assert.equal(resolved.instance.id, second.instance.id);
});

test('a failed instance insert rolls back layout, checkpoint and receipt together', async t => {
  const f = fixture(t);
  const before = f.store.read(f.workspace_id);
  const preview = await f.call({action: 'create_preview', kind: 'notebook', title: 'Rollback', base_revision: before.revision});
  const proposal = JSON.parse(f.data.db.prepare('SELECT record_json FROM wb_tool_proposals WHERE id=?').get(preview.preview_id).record_json);
  // Occupy the staged pane with a conflicting authoritative binding so the
  // commit's binding insert violates UNIQUE(workspace_id, pane_id).
  const occupier = randomUUID();
  f.data.db.prepare('INSERT INTO wb_tool_instances(id,workspace_id,project_id,revision,record_json) VALUES (?,?,?,?,?)').run(occupier, f.workspace_id, f.project.id, 1, JSON.stringify({version: 1, id: occupier, workspace_id: f.workspace_id, project_id: f.project.id, definition_id: randomUUID(), release_id: randomUUID(), kind: 'notebook', title: 'Occupier', config: {}, enabled: true, revoked: false, revision: 1, created_at: 1, updated_at: 1}));
  f.data.db.prepare('INSERT INTO wb_tool_bindings(id,workspace_id,project_id,instance_id,pane_id,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), f.workspace_id, f.project.id, occupier, proposal.pane_id, 1);
  await assert.rejects(f.call({action: 'create_commit', preview_id: preview.preview_id, preview_digest: preview.preview_digest, op_id: randomUUID(), intent: 'Install rollback'}), () => true);
  const after = f.store.read(f.workspace_id);
  assert.equal(after.revision, before.revision);
  assert.equal(f.data.db.prepare('SELECT count(*) AS n FROM wb_tool_instances WHERE id=?').get(proposal.instance_id).n, 0);
  assert.equal(findPaneUrl(after.state, `orbit://project-tool/${proposal.instance_id}`), null);
  assert.equal(f.data.db.prepare('SELECT count(*) AS n FROM wb_tool_receipts WHERE workspace_id=?').get(f.workspace_id).n, 0);
});

test('an operation key cannot be reused with a different actor-independent payload', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Keys'});
  const opId = randomUUID();
  await f.save(tool, 'alpha', 0, opId);
  await assert.rejects(f.call({action: 'data_save', project_id: tool.project_id, instance_id: tool.instance.id, pane_id: tool.pane_id, expected_revision: 1, data: {text: 'beta'}, op_id: opId, intent: 'Save notes'}), {code: 'conflict'});
  // A different actor has its own receipt key space and may save independently
  // (revision CAS still applies).
  const other = await f.call({action: 'data_save', project_id: tool.project_id, instance_id: tool.instance.id, pane_id: tool.pane_id, expected_revision: 1, data: {text: 'gamma'}, op_id: randomUUID(), intent: 'Save notes'}, 'workspace-controller');
  assert.equal(other.revision, 2);
});

test('evidence_checks projects sanitized recorded facts and reports absence, never a pass', async t => {
  const f = fixture(t);
  f.data.create('evidence', {
    workspace_id: f.workspace_id, project_id: f.project.id, project_generation: 1,
    job_id: randomUUID(), task_id: randomUUID(), candidate_id: randomUUID(),
    definition_id: 'node-test', definition_digest: 'a'.repeat(64), verdict: 'pass', exit_code: 0,
    timed_out: false, process_survival_unknown: false, candidate_hash_before: 'b'.repeat(64), candidate_hash_after: 'b'.repeat(64),
    superseded: false, revoked: false, stdout_preview: 'SECRET BODY', stderr_preview: 'SECRET ERR', log_path: '/private/output.log', env_fingerprint: 'ENV',
  });
  const tool = await f.createTool({kind: 'evidence_checks', title: 'Checks'});
  const resolved = await f.call({action: 'resolve', pane_id: tool.pane_id});
  assert.equal(resolved.instance.kind, 'evidence_checks');
  assert.equal(resolved.checks.recorded.length, 1);
  assert.equal(resolved.checks.recorded[0].verdict, 'pass');
  assert.equal(resolved.checks.recorded[0].pass, undefined);
  for (const forbidden of ['stdout_preview', 'stderr_preview', 'log_path', 'env_fingerprint', 'command']) assert.equal(resolved.checks.recorded[0][forbidden], undefined);
  assert.ok(!JSON.stringify(resolved.checks).includes('SECRET'));
  const empty = f.newProject('empty-evidence');
  const emptyTool = await f.createTool({kind: 'evidence_checks', title: 'Empty checks', project: empty.id});
  const emptyResolved = await f.call({action: 'resolve', pane_id: emptyTool.pane_id});
  assert.equal(emptyResolved.checks.recorded.length, 0);
  assert.match(emptyResolved.checks.message, /never a pass/);
});

test('an owner-less request body and every action require workspace_id', async t => {
  const f = fixture(t);
  await assert.rejects(f.tools.dispatch({action: 'metadata_list'}), {code: 'invalid_request'});
  await assert.rejects(f.tools.dispatch({workspace_id: f.workspace_id, action: 'nope'}), {code: 'invalid_request'});
  await assert.rejects(f.tools.dispatch({workspace_id: f.workspace_id, action: 'create_preview', project_id: f.project.id, kind: 'notebook', title: 'x', base_revision: f.store.read(f.workspace_id).revision, extra: true}), {code: 'invalid_request'});
});

// --- independent authoritative host grants ---------------------------------

function grantRows(f) {return f.data.db.prepare('SELECT record_json,revision FROM wb_tool_grants WHERE workspace_id=?').all(f.workspace_id).map(row => JSON.parse(row.record_json));}
function mutateGrant(f, instanceId, patch) {
  const row = f.data.db.prepare('SELECT record_json,revision FROM wb_tool_grants WHERE instance_id=?').get(instanceId);
  const grant = JSON.parse(row.record_json);
  const next = {...grant, ...patch, revision: grant.revision + 1, updated_at: 1};
  f.data.db.prepare('UPDATE wb_tool_grants SET revision=?,record_json=? WHERE instance_id=?').run(next.revision, JSON.stringify(next), instanceId);
  return next;
}

test('create_commit mints one closed-scope grant, and exact kind scopes gate every private operation', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Granted'});
  const grants = grantRows(f);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].instance_id, tool.instance.id);
  assert.deepEqual(grants[0].scopes, ['notebook.read', 'notebook.write']);
  assert.equal(grants[0].revoked, false);
  assert.equal(grants[0].project_generation, f.records.projectForRecovery(f.workspace_id, f.project.id).generation);
  assert.equal(tool.instance.grant_id, grants[0].id);
  // A grant whose scope set is not the exact closed set is refused everywhere.
  mutateGrant(f, tool.instance.id, {scopes: ['notebook.read']});
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), error => error.code === 'permission_denied' && error.reason === 'grant_scope');
  await assert.rejects(f.save(tool, 'blocked', 0), error => error.code === 'permission_denied' && error.reason === 'grant_scope');

  // evidence_checks receives only evidence.read and can never write notebook data.
  const checks = await f.createTool({kind: 'evidence_checks', title: 'Granted checks'});
  const checkGrant = grantRows(f).find(record => record.instance_id === checks.instance.id);
  assert.deepEqual(checkGrant.scopes, ['evidence.read']);
  await assert.rejects(f.save(checks, 'not allowed', 0), {code: 'permission_denied'});
});

test('a manually revoked authoritative grant blocks resolve even while the instance projection still looks enabled', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Manual revoke'});
  mutateGrant(f, tool.instance.id, {revoked: true});
  const projection = JSON.parse(f.data.db.prepare('SELECT record_json FROM wb_tool_instances WHERE id=?').get(tool.instance.id).record_json);
  assert.equal(projection.enabled, true);
  assert.equal(projection.revoked, false);
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), {code: 'revoked'});
  await assert.rejects(f.read(tool), {code: 'revoked'});
  await assert.rejects(f.save(tool, 'blocked', 0), {code: 'revoked'});
});

test('ordinary revoke revokes the grant, and a snapshot restore cannot revive access or notes', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Restore guard'});
  await f.save(tool, 'retained', 0);
  const captured = f.checkpoint('With tool pane');
  const revoked = await f.call({action: 'revoke', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, op_id: randomUUID(), intent: 'Revoke'});
  assert.equal(revoked.instance.revoked, true);
  const grant = grantRows(f).find(record => record.instance_id === tool.instance.id);
  assert.equal(grant.revoked, true, 'revoke must independently revoke the authoritative grant');
  assert.ok(grant.revision >= 2);
  // Restore a checkpoint that still contains the pane: layout returns, but the
  // revoked grant/instance fences access and the notes are retained.
  f.restore(captured);
  assert.ok(findPaneUrl(f.store.read(f.workspace_id).state, `orbit://project-tool/${tool.instance.id}`), 'the pane is restored');
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), {code: 'revoked'});
  await assert.rejects(f.read(tool), {code: 'revoked'});
  const stored = f.data.db.prepare('SELECT record_json FROM wb_tool_data WHERE instance_id=?').get(tool.instance.id).record_json;
  assert.ok(stored.includes('retained'), 'private notes are retained, not deleted');
});

test('project generation fences old grants/instances after a revoke and re-register', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Generation fence'});
  await f.save(tool, 'old data', 0);
  const project = f.records.projectForRecovery(f.workspace_id, f.project.id);
  f.records.revoke(f.workspace_id, f.project.id, project.generation);
  const revived = f.records.register(f.workspace_id, {root: path.join(f.root, 'source'), name: 'Tool fixture', identity: project.identity});
  assert.equal(revived.active, true);
  assert.ok(revived.generation > project.generation);
  // Retained records stay listable for inspection...
  const meta = await f.call({action: 'metadata_list'});
  assert.ok(meta.instances.some(instance => instance.id === tool.instance.id));
  assert.ok(meta.grants.some(grant => grant.instance_id === tool.instance.id));
  // ...but every operation is refused by the generation fence, even though the
  // project is active again.
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), error => error.code === 'stale_resource' && error.reason === 'project_generation');
  await assert.rejects(f.read(tool), error => error.code === 'stale_resource' && error.reason === 'project_generation');
  await assert.rejects(f.save(tool, 'new data', 1), error => error.code === 'stale_resource' && error.reason === 'project_generation');
});

test('metadata_list grant projection carries identity and scope only, never notebook bytes', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Private grant'});
  await f.save(tool, 'SECRET-NOTE-BODY', 0);
  const meta = await f.call({action: 'metadata_list'});
  assert.ok(Array.isArray(meta.grants) && meta.grants.length === 1);
  for (const grant of meta.grants) {
    assert.deepEqual(grant.scopes, ['notebook.read', 'notebook.write']);
    assert.equal(grant.project_generation, f.records.projectForRecovery(f.workspace_id, f.project.id).generation);
    assert.equal(grant.revoked, false);
  }
  assert.ok(!JSON.stringify(meta.grants).includes('SECRET-NOTE-BODY'), 'grant projection must not leak notebook bytes');
});

test('a data_save operation key is bound to its pane: the same key on another pane conflicts', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Pane identity'});
  const other = await f.createTool({title: 'Other pane'});
  const opId = randomUUID();
  await f.save(tool, 'same payload', 0, opId);
  // Same op_id, same instance, same payload, but a different pane selector. The
  // receipt identity must include pane_id, so this is a conflict, never a replay.
  await assert.rejects(f.call({
    action: 'data_save', project_id: tool.project_id, instance_id: tool.instance.id, pane_id: other.pane_id,
    expected_revision: 0, data: {text: 'same payload'}, op_id: opId, intent: 'Save notes',
  }), {code: 'conflict'});
  // The original exact payload still replays as metadata only (no note bytes).
  const replay = await f.save(tool, 'same payload', 0, opId);
  assert.deepEqual(replay, {revision: 1, instance_id: tool.instance.id, data_schema_version: 1});
  const receipt = f.data.db.prepare('SELECT result_json FROM wb_tool_receipts WHERE workspace_id=? AND op_id=?').get(f.workspace_id, opId);
  assert.ok(!receipt.result_json.includes('same payload'));
});

test('evidence projection folds supersession annotations and joins the newest identity-matched review and job generation', async t => {
  const f = fixture(t);
  const candidate_id = randomUUID();
  const base = {workspace_id: f.workspace_id, project_id: f.project.id, project_generation: 1, acceptance_digest: 'b'.repeat(64), task_id: randomUUID(), candidate_id, definition_id: 'node-test', definition_digest: 'c'.repeat(64), verdict: 'pass', exit_code: 0, candidate_hash_before: 'a'.repeat(64), candidate_hash_after: 'a'.repeat(64), superseded: false, revoked: false};
  const superseded = f.data.create('evidence', {...base, job_id: randomUUID()});
  // The recorder marks supersession with an annotation and keeps the immutable
  // evidence row's `superseded:false` intact.
  f.data.create('annotations', {workspace_id: f.workspace_id, project_id: f.project.id, kind: 'evidence_superseded', evidence_id: superseded.id, candidate_id, reason: 'candidate_edited', actor: 'owner'});
  let checks = projectToolChecks({data: f.data}, {workspace_id: f.workspace_id, project_id: f.project.id});
  assert.equal(checks.recorded_count, 0, 'annotation-superseded evidence must not be current');
  assert.match(checks.message, /never a pass/);

  const job = f.data.create('jobs', {workspace_id: f.workspace_id, project_id: f.project.id, candidate_id, candidate_generation: 7, acceptance_version: 1, acceptance_digest: 'b'.repeat(64)});
  const current = f.data.create('evidence', {...base, job_id: job.id});
  const reviewBase = {workspace_id: f.workspace_id, project_id: f.project.id, task_id: current.task_id, candidate_id, candidate_hash: 'a'.repeat(64), evidence_ids: [current.id], acceptance_version: 1, acceptance_digest: 'b'.repeat(64), actor: 'owner', accept_is_merge: false};
  f.data.create('reviews', {...reviewBase, decision: 'rejected', review_identity: 'review-oldest'});
  f.data.create('reviews', {...reviewBase, decision: 'approved', review_identity: 'review-newest'});
  checks = projectToolChecks({data: f.data}, {workspace_id: f.workspace_id, project_id: f.project.id});
  assert.equal(checks.recorded_count, 1);
  assert.equal(checks.recorded[0].candidate_generation, 7, 'exact candidate generation comes from the authoritative job');
  assert.equal(checks.recorded[0].review?.decision, 'approved', 'the newest matching review is shown, not the oldest');
  assert.equal(checks.recorded[0].review?.review_identity, 'review-newest');
  assert.equal(checks.recorded[0].review?.acceptance_digest, 'b'.repeat(64));
  assert.ok(!JSON.stringify(checks).includes('SECRET'));
});

test('receipts are recovery-generation fenced: hold/release refuses data_save and create_commit replays', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Fenced receipts'});
  const saveOp = randomUUID();
  await f.save(tool, 'private bytes', 0, saveOp);

  const base = f.store.read(f.workspace_id).revision;
  const preview = await f.call({action: 'create_preview', project_id: tool.project_id, kind: 'notebook', title: 'Fenced commit', base_revision: base});
  const commitOp = randomUUID();
  const committed = await f.call({action: 'create_commit', project_id: tool.project_id, preview_id: preview.preview_id, preview_digest: preview.preview_digest, op_id: commitOp, intent: 'Install fenced commit'});

  // Same generation: exact replays still resolve, even after CAS moved.
  assert.deepEqual(await f.save(tool, 'private bytes', 0, saveOp), {revision: 1, instance_id: tool.instance.id, data_schema_version: 1});
  assert.deepEqual(await f.call({action: 'create_commit', project_id: tool.project_id, preview_id: preview.preview_id, preview_digest: preview.preview_digest, op_id: commitOp, intent: 'Install fenced commit'}), committed);

  // A hold then release advances the policy generation. Both durable receipts
  // are now obsolete and must be refused rather than replaying stale metadata.
  f.setHold(true);
  f.setHold(false);
  await assert.rejects(f.save(tool, 'private bytes', 0, saveOp), error => error.code === 'stale_resource' && error.reason === 'RECOVERY_POLICY_CHANGED');
  await assert.rejects(f.call({action: 'create_commit', project_id: tool.project_id, preview_id: preview.preview_id, preview_digest: preview.preview_digest, op_id: commitOp, intent: 'Install fenced commit'}), error => error.code === 'stale_resource' && error.reason === 'RECOVERY_POLICY_CHANGED');

  // No refused replay rewrote private bytes, and no extra instance was created.
  const stored = f.data.db.prepare('SELECT record_json FROM wb_tool_data WHERE instance_id=?').get(tool.instance.id).record_json;
  assert.ok(stored.includes('private bytes'));
  assert.equal(f.instanceCount(), 2);
});

test('a future stored data schema is refused by read/save/repin without rewriting data; disable and revoke stay available', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Future data'});
  await f.save(tool, 'schema one', 0);
  // Simulate private data written by a newer data schema.
  f.data.db.prepare("UPDATE wb_tool_data SET record_json=json_set(record_json,'$.data_schema_version',2), revision=revision+1 WHERE instance_id=?").run(tool.instance.id);
  const before = f.data.db.prepare('SELECT revision,record_json FROM wb_tool_data WHERE instance_id=?').get(tool.instance.id);

  await assert.rejects(f.read(tool), error => error.code === 'unsupported' && error.reason === 'incompatible_data_schema');
  await assert.rejects(f.save(tool, 'downgrade attempt', before.revision), error => error.code === 'unsupported' && error.reason === 'incompatible_data_schema');

  const meta = await f.call({action: 'metadata_list'});
  const notebook = meta.definitions.find(record => record.kind === 'notebook');
  const v2 = meta.releases.find(record => record.definition_id === notebook.id && record.release === '2');
  await assert.rejects(f.call({action: 'repin', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, release_id: v2.id, op_id: randomUUID(), intent: 'Repin future data'}), error => error.code === 'unsupported' && error.reason === 'incompatible_data_schema');

  const after = f.data.db.prepare('SELECT revision,record_json FROM wb_tool_data WHERE instance_id=?').get(tool.instance.id);
  assert.deepEqual(after, before, 'refused operations must not rewrite stored data');

  // Recovery directions remain available even with incompatible data.
  const disabled = await f.call({action: 'set_enabled', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, enabled: false, op_id: randomUUID(), intent: 'Disable for recovery'});
  assert.equal(disabled.instance.enabled, false);
  await f.call({action: 'revoke', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: disabled.instance.revision, op_id: randomUUID(), intent: 'Revoke for recovery'});
});

test('a tampered host descriptor blocks resolve/enable but not disable or revoke', async t => {
  const f = fixture(t);
  const tool = await f.createTool({title: 'Broken release'});
  // The release row's digest no longer matches the trusted host descriptor.
  f.data.db.prepare("UPDATE wb_tool_releases SET record_json=json_set(record_json,'$.host_digest',?) WHERE id=?").run('f'.repeat(64), tool.instance.release_id);
  await assert.rejects(f.call({action: 'resolve', pane_id: tool.pane_id}), {code: 'unsupported'});
  await assert.rejects(f.call({action: 'set_enabled', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, enabled: true, op_id: randomUUID(), intent: 'Enable broken'}), {code: 'unsupported'});
  const disabled = await f.call({action: 'set_enabled', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: tool.instance.revision, enabled: false, op_id: randomUUID(), intent: 'Disable broken'});
  assert.equal(disabled.instance.enabled, false);
  await f.call({action: 'revoke', project_id: tool.project_id, instance_id: tool.instance.id, expected_revision: disabled.instance.revision, op_id: randomUUID(), intent: 'Revoke broken'});
});
