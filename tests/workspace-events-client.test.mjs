import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectWorkspaceEvents } from '../src/workspace-events.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const event = (sequence, changed = true) => ({
  sequence, type: 'workspace.command', timestamp: 1790294400000,
  causation_id: 'operation-fixture', correlation_id: 'operation-fixture',
  payload: { action: 'apply', revision: sequence, changed },
});
const page = (events, cursor, extra = {}) => ({
  workspace_id: workspaceId, events, cursor, has_more: false, reset_required: false, ...extra,
});

function fixture(t, replies, options = {}) {
  const original = globalThis.fetch;
  const calls = [], changes = [], resets = [], statuses = [];
  let token = 'secret-one';
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = replies.shift();
    assert.ok(next, 'unexpected request');
    if (typeof next === 'function') return next(init);
    return new Response(JSON.stringify(next));
  };
  const connection = connectWorkspaceEvents({
    workspaceId, getToken: () => token,
    onChange: e => changes.push(e), onReset: () => resets.push(true),
    status: text => statuses.push(text), ...options,
  });
  t.after(() => { connection.close(); globalThis.fetch = original; });
  return { connection, calls, changes, resets, statuses, setToken: value => { token = value; } };
}

test('bounded pagination, in-memory sequence cursor, and bearer POST', async t => {
  const replies = Array.from({ length: 5 }, (_, i) => page([event(i + 1)], i + 1, { has_more: true }));
  const f = fixture(t, [...replies, page([], 5)]);
  await f.connection.poll();
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.map(c => c.body.cursor), [0, 1, 2, 3]);
  assert.deepEqual(f.changes.map(e => e.sequence), [1, 2, 3, 4]);
  await f.connection.poll();
  assert.deepEqual(f.calls.map(c => c.body.cursor), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(f.changes.map(e => e.sequence), [1, 2, 3, 4, 5]);
  assert.ok(f.calls.every(c => c.url === '/api/workspace/events' && c.init.method === 'POST' &&
    c.init.headers.Authorization === 'Bearer secret-one' && c.body.workspace_id === workspaceId && c.body.limit === 100));
  assert.ok(f.calls.every(c => !c.url.includes('secret') && !c.url.includes('cursor')));
});

test('rejects malformed, mismatched and out-of-order pages before notifying', async t => {
  const bad = [
    page([event(1)], 2),
    { ...page([event(1)], 1), workspace_id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' },
    page([event(2), event(1)], 1),
    page([{ ...event(1), timestamp: '2026-09-25T00:00:00Z' }], 1),
    page([{ ...event(1), causation_id: null }], 1),
    page([{ ...event(1), payload: { ...event(1).payload, changed: 'yes' } }], 1),
    page(Array.from({ length: 101 }, (_, i) => event(i + 1)), 101),
    page([], 0, { has_more: true }),
  ];
  const f = fixture(t, [...bad, page([event(1)], 1)]);
  for (const _ of bad) await f.connection.poll();
  assert.equal(f.changes.length, 0);
  assert.equal(f.statuses.length, 1, 'transient errors are reported once');
  assert.ok(f.calls.every(c => c.body.cursor === 0));
  await f.connection.poll();
  assert.equal(f.changes.length, 1);
  assert.equal(f.statuses.length, 2, 'recovery is reported once');
});

test('reset pauses pagination; reconnect retains cursor after failure and starts fresh for a new token', async t => {
  const f = fixture(t, [
    page([event(1)], 1),
    () => { throw Error('offline'); },
    page([], 8, { reset_required: true }),
    page([event(9)], 9),
    page([event(1)], 1),
  ]);
  await f.connection.poll();
  await f.connection.poll();
  await f.connection.poll();
  assert.equal(f.resets.length, 1);
  assert.deepEqual(f.calls.map(c => c.body.cursor), [0, 1, 1]);
  await f.connection.poll();
  assert.deepEqual(f.changes.map(e => e.sequence), [1, 9]);
  f.setToken('secret-two');
  await f.connection.poll();
  assert.equal(f.calls.at(-1).body.cursor, 0);
  assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer secret-two');
});

test('close aborts pending request, suppresses callbacks and future polls', async t => {
  let finish;
  const f = fixture(t, [init => new Promise(resolve => {
    finish = () => resolve(new Response(JSON.stringify(page([event(1)], 1))));
    assert.equal(init.signal.aborted, false);
  })]);
  const pending = f.connection.poll();
  assert.equal(f.calls.length, 1);
  f.connection.close();
  assert.equal(f.calls[0].init.signal.aborted, true);
  finish();
  await pending;
  await f.connection.poll();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.statuses, []);
});

test('oversized and malformed UTF-8 responses do not notify or advance the cursor',async t=>{
  const f=fixture(t,[()=>new Response(' '.repeat(2_000_001)),()=>new Response(new Uint8Array([0xff])),page([event(1)],1)]);
  await f.connection.poll();await f.connection.poll();
  assert.equal(f.changes.length,0);
  await f.connection.poll();assert.equal(f.calls.at(-1).body.cursor,0);assert.equal(f.changes.length,1);
});

test('callback failures request a snapshot reset without wedging replay on the same event',async t=>{
  const f=fixture(t,[page([event(1),event(2)],2),page([event(2)],2)],{onChange:()=>{throw Error('consumer failed');}});
  await f.connection.poll();await f.connection.poll();
  assert.deepEqual(f.calls.map(call=>call.body.cursor),[0,1]);assert.equal(f.resets.length,2);
});
test('callbacks receive allowlisted metadata only, even if response has unexpected fields',async t=>{
  const f=fixture(t,[page([{...event(1),secret:'fixture-private',payload:{...event(1).payload,capability:'fixture-private'}}],1)]);
  await f.connection.poll();assert.deepEqual(f.changes,[event(1)]);
});
