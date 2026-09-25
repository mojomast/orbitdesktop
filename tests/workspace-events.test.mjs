import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createWorkspaceEvents } from '../server/workspace-events.mjs';

const owner = 'owner-secret';
const first = randomUUID(), second = randomUUID();
const event = (sequence = 1) => ({ sequence, type: 'workspace.command', timestamp: Date.now(),
  causation_id: randomUUID(), correlation_id: randomUUID(), payload: { action: 'apply', revision: 3,
    changed: true, recovery_policy: { held: false, generation: 1, capability: 'private' }, state: 'private' },
  workspace_id: second, capability: 'private', request_intent: 'private', state: 'private' });

async function setup(t) {
  const calls = [];
  const records = new Map([[first, { capability: 'first-capability' }], [second, { capability: 'second-capability' }]]);
  const store = {
    read(id) { if (!records.has(id)) throw Object.assign(Error('Missing'), { code: 'ENOENT' }); return records.get(id); },
    eventPage(id, cursor, limit) {
      calls.push({ id, cursor, limit });
      return { events: [event()], cursor: 1, has_more: false, reset_required: false };
    },
  };
  let handle;
  const server = http.createServer((req, res) => handle(req, res, req.url === '/api/workspace/control/events'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  handle = createWorkspaceEvents({ store, token: owner, port, devOrigins: [],
    reply(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } });
  async function request(body = { workspace_id: first }, { control = false, key = owner, originHeader = origin, method = 'POST' } = {}) {
    const response = await fetch(origin + (control ? '/api/workspace/control/events' : '/api/workspace/events'), {
      method, headers: { Authorization: `Bearer ${key}`, ...(originHeader ? { Origin: originHeader } : {}),
        'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  return { request, calls, store, records };
}

test('owner reads bounded metadata with defaults, explicit pagination and no private fields', async t => {
  const { request, calls } = await setup(t);
  const result = await request();
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ id: first, cursor: 0, limit: 100 }]);
  assert.deepEqual(Object.keys(result.body).sort(), ['cursor', 'events', 'has_more', 'reset_required', 'workspace_id']);
  assert.deepEqual(Object.keys(result.body.events[0]).sort(), ['causation_id', 'correlation_id', 'payload', 'sequence', 'timestamp', 'type']);
  assert.deepEqual(result.body.events[0].payload, { action: 'apply', revision: 3, changed: true,
    recovery_policy: { held: false, generation: 1 } });
  assert.equal((await request({ workspace_id: first, cursor: 12, limit: 4 })).status, 200);
  assert.deepEqual(calls[1], { id: first, cursor: 12, limit: 4 });
});

test('owner authentication and Origin precede parsing and store access', async t => {
  const { request, calls } = await setup(t);
  assert.equal((await request('{bad', { key: 'wrong' })).status, 403);
  assert.equal((await request('{bad', { originHeader: 'https://evil.example' })).status, 403);
  assert.equal((await request('{bad', { originHeader: null })).status, 403);
  assert.equal((await request(undefined, { method: 'GET' })).status, 405);
  assert.equal(calls.length, 0);
});

test('strict body validation rejects malformed JSON, unknown fields and invalid pagination', async t => {
  const { request, calls } = await setup(t);
  for (const body of ['{', 'null', '[]',
    { workspace_id: first, wait_ms: 1 }, { workspace_id: 'no' },
    { workspace_id: first, cursor: -1 }, { workspace_id: first, cursor: 1.5 },
    { workspace_id: first, cursor: Number.MAX_SAFE_INTEGER + 1 },
    { workspace_id: first, limit: 0 }, { workspace_id: first, limit: 101 },
    { workspace_id: first, limit: '10' }]) {
    assert.equal((await request(body)).status, 400);
  }
  assert.equal((await request('x'.repeat(4097))).status, 413);
  assert.equal(calls.length, 0);
});

test('control capability is rechecked against requested workspace without Origin', async t => {
  const { request, calls, records } = await setup(t);
  const control = { control: true, originHeader: null, key: 'first-capability' };
  assert.equal((await request({ workspace_id: first }, control)).status, 200);
  const wrong = await request({ workspace_id: second }, control);
  const missing = await request({ workspace_id: randomUUID() }, control);
  assert.equal(wrong.status, 403);
  assert.deepEqual(missing, wrong);
  assert.equal((await request({ workspace_id: randomUUID() })).status, 404);
  records.set(first, { capability: 'rotated' });
  assert.equal((await request({ workspace_id: first }, control)).status, 403);
  assert.equal((await request({ workspace_id: first }, { ...control, key: 'rotated' })).status, 200);
  assert.equal(calls.length, 2);
});

test('response budget fails closed rather than returning partial pages', async t => {
  const { request, store } = await setup(t);
  store.eventPage = () => ({ events: Array.from({ length: 100 }, (_, index) => ({ ...event(index + 1),
    payload: { ...event().payload, action: 'x'.repeat(30000) } })), cursor: 100, has_more: false, reset_required: false });
  assert.equal((await request()).status, 413);
  store.eventPage = () => ({ events: Array.from({ length: 100 }, (_, index) => ({ ...event(index + 1),
    type: 'x'.repeat(99), causation_id: 'x'.repeat(256), correlation_id: 'y'.repeat(256) })),
    cursor: 100, has_more: false, reset_required: false });
  assert.equal((await request()).status, 200);
  store.eventPage = () => ({ events: Array.from({ length: 101 }, (_, index) => event(index + 1)), cursor: 101, has_more: true, reset_required: false });
  assert.equal((await request()).status, 503);
});
