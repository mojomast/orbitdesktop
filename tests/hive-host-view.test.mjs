import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixtures, fixtureTime} from '../apps/rizzstack-hive/fixtures.js';
import {project} from '../apps/rizzstack-hive/snapshot-adapter.js';

// Same mock channel as hive-host-client.test.mjs: no token, network or receiver
// privileges, and a fresh module instance (node:test runs one process per file).
test('the document channel accepts the optional bee block and refuses a malformed one', async t => {
  let port;
  const outbound = [], states = [], views = [];
  const globals = {location: {hash: '#orbit-hive-document=00000000-0000-4000-9000-000000000000'},
    self: {}, parent: {postMessage() {}}, document: {createElement() { return {}; }, head: {prepend() {}}}, addEventListener() {},
    MessageChannel: class { constructor() { this.port2 = {}; this.port1 = port = {postMessage: d => outbound.push(d), close() {}}; } }};
  for (const [key, val] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {configurable: true, value: val});
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else delete globalThis[key]; });
  }
  const { connectHost } = await import('../apps/rizzstack-hive/host-client.js');
  const client = { onStatus: s => states.push(s), onView: v => { views.push(v); return v ? 'new' : 'invalid'; }, onReturnFocus() {} };
  const handle = connectHost(client);
  const send = data => port.onmessage({ data });

  const snapshot = structuredClone(fixtures.dense);
  Object.assign(snapshot.usage, {
    by_role: {
      coordinator: { status: 'known', source: 'bee.usage/v1', requests: 5, input: 2065, output: 615, thinking: 0, total: 2670, cost_usd: null, priced: null, unknown_cost: 5, cache_read: 0 },
      worker: { status: 'known', source: 'rizzstack-rails/usage.observed', requests: 3, input: 500, output: 180, thinking: 40, total: 720, cost_usd: null, priced: null, unknown_cost: 3, cache_read: 0 },
      unknown: { status: 'unknown', source: 'bee.usage/v1', requests: null, input: null, output: null, thinking: null, total: null, cost_usd: null, priced: null, unknown_cost: null, cache_read: 0 },
    },
    bee: { status: 'known', source: 'rizzstack-rails/usage.observed', attempts: 3, requests: 3, input: 500, output: 180, thinking: 40, total: 720,
      cost_usd: null, priced: 0, unknown_cost: 3, by_model: [], by_repo: [] },
    tokens_per_verified_patch: { value: 360, numerator: 720, denominator: 2, unit: 'tokens',
      denominator_rule: 'attempt ids whose verify-results/<attempt_id>.json has ok true and sha matching ^[0-9a-f]{40}$',
      basis: 'worker usage.observed receipts: input+output+thinking tokens', scope: 'all time',
      cost: { status: 'partial', note: 'launcher receipts carry no cost' } },
  });
  const view = project(snapshot, { now: fixtureTime });
  assert.ok(view.beeTokens && view.beeTokens.patch.denominator === 2);

  send({ type: 'status', value: 'loading' });
  send({ type: 'view', view });
  send({ type: 'status', value: 'connected' });
  assert.equal(views.length, 1);
  assert.equal(views[0].beeTokens.patch.value, 360);

  // A pre-BU2 view (no additive key at all) is still accepted.
  const bare = project(fixtures.dense, { now: fixtureTime });
  send({ type: 'status', value: 'loading' });
  send({ type: 'view', view: bare });
  send({ type: 'status', value: 'connected' });
  assert.equal(views.length, 2);

  // A malformed block never becomes the pending view: the channel stays waiting.
  const bad = { ...view, beeTokens: { stale: false, status: 'known' } };
  send({ type: 'status', value: 'loading' });
  send({ type: 'view', view: bad });
  send({ type: 'status', value: 'connected' });
  assert.equal(views.length, 2);
  assert.equal(states.filter(s => s === 'connected').length, 2);
  assert.equal(states.length > 0, true);
  handle.close();
});
