import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initial } from '../src/model.ts';
import { createWorkspaceService } from '../server/workspace.mjs';

const request = () => ({
  op_id: randomUUID(),
  goal: 'Make the dashboard work on mobile',
  title: 'Mobile dashboard',
  acceptance_statement: 'The dashboard is usable at 380px without losing the desktop layout',
  project_id: randomUUID(),
  check_definition_id: 'node-test',
});

async function setup(t, { propose } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-workbench-setup-'));
  const token = 'workspace-test-secret'.repeat(3);
  let service;
  const server = http.createServer((req, res) => service.handle(req, res, req.url === '/control'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  service = createWorkspaceService({ token, port, devOrigins: [], root, reply: (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  }, ...(propose ? { workbenchSetup: { propose } } : {}) });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const id = randomUUID();
  async function req(body, { control = false, capability = token, originHeader = origin } = {}) {
    const response = await fetch(origin + (control ? '/control' : '/workspace'), { method: 'POST', headers: {
      Origin: originHeader, Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ workspace_id: id, ...body }) });
    return { status: response.status, body: await response.json() };
  }
  await req({ action: 'sync', state: initial() });
  return { root, origin, id, req, service, capability: service.store.read(id).capability };
}

test('workbench_setup proposes on the workspace-capability route and returns only the suggestion id', async t => {
  const calls = [], suggestionId = randomUUID();
  const { id, req, service, capability } = await setup(t, { propose: args => {
    calls.push(args); return { id: suggestionId };
  } });
  const proposal = request(), before = service.store.read(id);
  const result = await req({ action: 'workbench_setup', request: proposal }, { control: true, capability });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: suggestionId }, 'only the caller-submitted suggestion id is returned');
  assert.deepEqual(calls, [{ workspace_id: id, ...proposal }]);
  const after = service.store.read(id);
  assert.deepEqual(after.state, before.state, 'a suggestion must not mutate layout');
  assert.equal(after.revision, before.revision);
});

test('workbench_setup can be attached after construction through the narrow setter', async t => {
  const { id, req, service, capability } = await setup(t);
  const calls = [];
  service.setWorkbenchSetup({ propose: args => { calls.push(args); return { id: randomUUID() }; } });
  const proposal = request();
  const result = await req({ action: 'workbench_setup', request: proposal }, { control: true, capability });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspace_id, id);
  service.setWorkbenchSetup(null);
  assert.equal((await req({ action: 'workbench_setup', request: proposal }, { control: true, capability })).status, 503);
});

test('workbench_setup is unavailable on the browser route and without a bound capability', async t => {
  const calls = [];
  const { req, capability } = await setup(t, { propose: args => { calls.push(args); return { suggestion: { id: randomUUID() } }; } });
  const proposal = request();
  assert.equal((await req({ action: 'workbench_setup', request: proposal })).status, 403);
  assert.equal((await req({ action: 'workbench_setup', request: proposal }, { control: true, capability: 'not-the-capability' })).status, 403);
  assert.equal((await req({ action: 'workbench_setup', request: proposal }, { control: true, capability: 'not-the-capability', originHeader: 'https://evil.example' })).status, 403);
  assert.equal(calls.length, 0, 'unauthorized callers must never reach the setup service');
});

test('workbench_setup fails closed when no setup service is injected', async t => {
  const { req, capability } = await setup(t);
  const result = await req({ action: 'workbench_setup', request: request() }, { control: true, capability });
  assert.equal(result.status, 503);
  assert.equal(result.body.category, 'STORE_UNAVAILABLE');
});

test('workbench_setup cannot spoof owner, pane, session, actor, execution or private-scope fields', async t => {
  const calls = [];
  const { id, req, service, capability } = await setup(t, { propose: args => { calls.push(args); return { suggestion: { id: randomUUID() } }; } });
  const base = { op_id: randomUUID(), goal: 'bounded goal' };
  const before = service.store.read(id);
  const spoofed = [
    { action: 'task_create' },
    { pane_id: randomUUID() },
    { profile_id: 'owner-profile' },
    { session_id: 'owner-session' },
    { actor: 'owner' },
    { operations: [{ action: 'apply' }] },
    { credentials: 'secret' },
    { root: '/etc' },
    { path: '/private/project' },
    { command: 'rm -rf /' },
    { workspace_id: randomUUID() },
    { preview_id: randomUUID() },
    { launch: true },
    { surprise: 'unknown' },
  ];
  for (const field of spoofed) {
    const result = await req({ action: 'workbench_setup', request: { ...base, ...field } }, { control: true, capability });
    assert.equal(result.status, 400, JSON.stringify(field));
    assert.equal(result.body.category, 'INVALID_OPERATION');
  }
  for (const extra of [{ actor: 'owner' }, { pane_id: randomUUID() }, { operations: [] }, { base_revision: 1 }, { confirm: true }]) {
    const envelope = await req({ action: 'workbench_setup', request: base, ...extra }, { control: true, capability });
    assert.equal(envelope.status, 400, JSON.stringify(extra));
  }
  assert.equal(calls.length, 0, 'a rejected spoof must never reach the setup service');
  assert.deepEqual(service.store.read(id).state, before.state);
});

test('workbench_setup rejects malformed proposals before the service', async t => {
  const calls = [];
  const { req, capability } = await setup(t, { propose: args => { calls.push(args); return { suggestion: { id: randomUUID() } }; } });
  const bad = [
    {},
    { request: null },
    { request: 'goal' },
    { request: {} },
    { request: { goal: 'no op id' } },
    { request: { op_id: 'not-a-uuid', goal: 'g' } },
    { request: { op_id: randomUUID(), goal: '' } },
    { request: { op_id: randomUUID(), goal: '   ' } },
    { request: { op_id: randomUUID(), goal: 'x'.repeat(4001) } },
    { request: { op_id: randomUUID(), goal: 'g', check_definition_id: 'arbitrary-shell' } },
    { request: { op_id: randomUUID(), goal: 'g', project_id: 'not-a-uuid' } },
    { request: { op_id: randomUUID(), goal: 'g', title: '' } },
    { request: { op_id: randomUUID(), goal: 'g', acceptance_statement: '   ' } },
  ];
  for (const body of bad) {
    const result = await req({ action: 'workbench_setup', ...body }, { control: true, capability });
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});
