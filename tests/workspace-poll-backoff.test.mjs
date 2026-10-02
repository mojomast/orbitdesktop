import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { connectWorkspaceEvents, FOREGROUND_POLL_MS, HIDDEN_POLL_MS, visibilityAwarePollMs } from '../src/workspace-events.ts';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const page = (events = [], cursor = 0, extra = {}) => ({
  workspace_id: workspaceId, events, cursor, has_more: false, reset_required: false, ...extra,
});

test('shared visibility policy maps hidden to the backed-off cadence', () => {
  assert.equal(FOREGROUND_POLL_MS, 1200);
  assert.equal(HIDDEN_POLL_MS, 15000);
  assert.equal(visibilityAwarePollMs(false), FOREGROUND_POLL_MS);
  assert.equal(visibilityAwarePollMs(true), HIDDEN_POLL_MS);
});

test('event polling follows the injected interval and disposes its pending timer', async (t) => {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, fetch: globalThis.fetch };
  t.after(() => { Object.assign(globalThis, original); });
  let hidden = false, next = 1;
  const scheduled = [], timers = new Map();
  globalThis.setTimeout = (fn, delay) => { const id = next++; timers.set(id, fn); scheduled.push(delay); return id; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.fetch = async () => new Response(JSON.stringify(page()));
  const connection = connectWorkspaceEvents({
    workspaceId, getToken: () => 'secret', onChange() {}, onReset() {},
    pollIntervalMs: () => (hidden ? HIDDEN_POLL_MS : FOREGROUND_POLL_MS),
  });
  assert.equal(scheduled.at(-1), FOREGROUND_POLL_MS, 'initial schedule is foreground');
  await connection.poll();
  assert.equal(scheduled.at(-1), FOREGROUND_POLL_MS);
  hidden = true;
  await connection.poll();
  assert.equal(scheduled.at(-1), HIDDEN_POLL_MS, 'hidden schedule backs off');
  hidden = false;
  await connection.poll();
  assert.equal(scheduled.at(-1), FOREGROUND_POLL_MS, 'visible schedule resumes');
  connection.close();
  assert.equal(timers.size, 0, 'close clears the pending schedule');
});

test('an invalid injected interval falls back to the foreground cadence', async (t) => {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, fetch: globalThis.fetch };
  t.after(() => { Object.assign(globalThis, original); });
  const scheduled = [];
  globalThis.setTimeout = (fn, delay) => { scheduled.push(delay); return 1; };
  globalThis.clearTimeout = () => {};
  globalThis.fetch = async () => new Response(JSON.stringify(page()));
  const connection = connectWorkspaceEvents({ workspaceId, getToken: () => 'secret', onChange() {}, onReset() {}, pollIntervalMs: () => Number.NaN });
  await connection.poll();
  assert.equal(scheduled.filter((delay) => delay === FOREGROUND_POLL_MS).length, 2);
  connection.close();
});

// Execute the real sync module in a disposable browser-like environment, with a
// mutable visibility state and recorded timer cadences.
function syncFixture() {
  const requests = [], intervals = [], cleared = [], timeouts = [];
  const listeners = new Map();
  const lifecycle = { started: 0, closed: 0, polls: 0 };
  let nextTimer = 1;
  let state = { plugins: [], monitors: [] };
  const documentRef = { querySelectorAll: () => [], querySelector: () => null, visibilityState: 'visible' };
  const exports = {};
  const context = vm.createContext({
    exports, crypto: { randomUUID }, CustomEvent,
    localStorage: { getItem: () => undefined, setItem: () => {} },
    document: documentRef,
    window: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      dispatchEvent: (event) => { listeners.get(event.type)?.(event); return true; },
    },
    setInterval: (_fn, delay) => { intervals.push(delay); return nextTimer++; },
    clearInterval: (id) => { cleared.push(id); },
    setTimeout: (_fn, delay) => { timeouts.push(delay); return nextTimer++; },
    clearTimeout: () => {},
    require: (name) => {
      if (name === './workspace-appearance') return { applyAppearance: () => {} };
      if (name === './workspace-events') return { connectWorkspaceEvents: () => { lifecycle.started++; return { close: () => { lifecycle.closed++; }, poll: async () => { lifecycle.polls++; } }; } };
      if (name === './workspace-client') return { workspaceFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) };
      throw Error(`Unexpected import ${name}`);
    },
  });
  const source = fs.readFileSync(new URL('../src/workspace-sync.ts', import.meta.url), 'utf8');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const connection = exports.connectWorkspace(() => state, (next) => { state = next; }, () => 'fixture-token', () => {});
  return {
    connection, documentRef, lifecycle, intervals, cleared, timeouts,
    dispatch: (name) => listeners.get(name)?.({ type: name }),
  };
}

test('state polling backs off while hidden without resubscribing, and refreshes on return', () => {
  const f = syncFixture();
  assert.deepEqual(f.intervals, [FOREGROUND_POLL_MS]);
  assert.equal(f.lifecycle.started, 1);

  f.documentRef.visibilityState = 'hidden';
  f.dispatch('visibilitychange');
  assert.equal(f.intervals.at(-1), HIDDEN_POLL_MS, 'hidden uses the backed-off interval');
  assert.equal(f.lifecycle.started, 1, 'visibility must not duplicate the event subscription');
  const afterHidden = f.intervals.length;
  f.dispatch('visibilitychange');
  assert.equal(f.intervals.length, afterHidden, 'redundant hidden change does not churn timers');

  f.documentRef.visibilityState = 'visible';
  f.dispatch('visibilitychange');
  assert.equal(f.intervals.at(-1), FOREGROUND_POLL_MS, 'visible resumes the normal cadence');
  assert.equal(f.lifecycle.started, 1, 'no duplicate subscription across visibility changes');
  assert.ok(f.lifecycle.polls >= 1, 'returning visible polls events immediately');
  assert.ok(f.timeouts.includes(0), 'returning visible schedules an immediate state refresh');

  f.documentRef.visibilityState = 'hidden';
  f.dispatch('visibilitychange');
  f.documentRef.visibilityState = 'visible';
  f.dispatch('visibilitychange');
  assert.equal(f.intervals.length, 5, 'one polling timer per transition, none accumulated');
  assert.equal(f.lifecycle.started, 1);
});

test('pagehide/pageshow still suspend and restart both paths exactly once', () => {
  const f = syncFixture();
  f.dispatch('pagehide');
  assert.equal(f.lifecycle.closed, 1);
  assert.equal(f.lifecycle.started, 1);
  assert.equal(f.intervals.length, 1, 'pagehide adds no polling timer');

  f.dispatch('pageshow');
  f.dispatch('pageshow');
  assert.equal(f.lifecycle.started, 2, 'pageshow restarts events exactly once');
  assert.equal(f.lifecycle.closed, 1);
  assert.equal(f.intervals.at(-1), FOREGROUND_POLL_MS);

  f.dispatch('pagehide');
  assert.equal(f.lifecycle.closed, 2);
});

test('a page restored while still hidden keeps the backoff until visible', () => {
  const f = syncFixture();
  f.documentRef.visibilityState = 'hidden';
  f.dispatch('visibilitychange');
  f.dispatch('pagehide');
  f.dispatch('pageshow');
  assert.equal(f.intervals.at(-1), HIDDEN_POLL_MS, 'restored hidden page stays backed off');
  f.documentRef.visibilityState = 'visible';
  f.dispatch('visibilitychange');
  assert.equal(f.intervals.at(-1), FOREGROUND_POLL_MS);
});
