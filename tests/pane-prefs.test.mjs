import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPanePrefs,
  panePrefsKey,
  readPanePrefs,
  writePanePrefs,
  clearWorkbenchSelection,
  normalizeDurableId,
} from '../src/pane-prefs.ts';

function storage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    raw: map,
  };
}

const WS = 'a345639c-42bb-41d0-94da-f9d9abb8fd41';
const PANE = '74977184-cbe1-4622-9fae-7ed32e531347';

test('missing or corrupt state falls back to bounded defaults', () => {
  const store = storage();
  assert.deepEqual(readPanePrefs(WS, PANE, store), defaultPanePrefs());
  store.setItem(panePrefsKey(WS, PANE), '{not json');
  assert.deepEqual(readPanePrefs(WS, PANE, store), defaultPanePrefs());
  store.setItem(panePrefsKey(WS, PANE), JSON.stringify({ version: 99, mode: 'workbench' }));
  assert.deepEqual(readPanePrefs(WS, PANE, store), defaultPanePrefs());
  store.setItem(panePrefsKey(WS, PANE), 'x'.repeat(5000));
  assert.deepEqual(readPanePrefs(WS, PANE, store), defaultPanePrefs());
});

test('mode and durable IDs round-trip, keyed by workspace plus pane', () => {
  const store = storage();
  writePanePrefs(WS, PANE, { mode: 'workbench', projectId: 'proj-1', taskId: 'task:1', candidateId: 'cand_2', attemptId: 'att-3', grantId: 'grant.4', resultId: 'res-5', reviewId: 'rev-6' }, store);
  const restored = readPanePrefs(WS, PANE, store);
  assert.equal(restored.mode, 'workbench');
  assert.equal(restored.projectId, 'proj-1');
  assert.equal(restored.taskId, 'task:1');
  assert.equal(restored.candidateId, 'cand_2');
  assert.equal(restored.attemptId, 'att-3');
  assert.equal(restored.grantId, 'grant.4');
  assert.equal(restored.resultId, 'res-5');
  assert.equal(restored.reviewId, 'rev-6');
  // A different pane in the same workspace is independent.
  assert.deepEqual(readPanePrefs(WS, 'other-pane', store), defaultPanePrefs());
});

test('stored values never include conversation text or unknown fields', () => {
  const store = storage();
  writePanePrefs(WS, PANE, { mode: 'workbench', projectId: 'proj-1' }, store);
  const raw = store.raw.get(panePrefsKey(WS, PANE));
  const value = JSON.parse(raw);
  assert.deepEqual(Object.keys(value).sort(), ['attemptId', 'candidateId', 'grantId', 'mode', 'projectId', 'resultId', 'reviewId', 'taskId', 'version'].sort());
  assert.equal(Object.hasOwn(value, 'messages'), false);
  assert.equal(Object.hasOwn(value, 'excerpts'), false);
  assert.equal(JSON.stringify(value).includes('proj-1'), true);
});

test('invalid durable IDs are rejected rather than stored', () => {
  const store = storage();
  writePanePrefs(WS, PANE, { mode: 'workbench', projectId: '../etc/passwd', taskId: 'ok-1' }, store);
  const restored = readPanePrefs(WS, PANE, store);
  assert.equal(restored.projectId, null);
  assert.equal(restored.taskId, 'ok-1');
  assert.equal(normalizeDurableId('a'.repeat(129)), null);
  assert.equal(normalizeDurableId('has space'), null);
  assert.equal(normalizeDurableId(''), null);
});

test('clearing the workbench selection preserves the pane mode', () => {
  const store = storage();
  writePanePrefs(WS, PANE, { mode: 'workbench', projectId: 'proj-1', resultId: 'res-5' }, store);
  const cleared = clearWorkbenchSelection(WS, PANE, store);
  assert.equal(cleared.mode, 'workbench');
  assert.equal(cleared.projectId, null);
  assert.equal(cleared.resultId, null);
  assert.deepEqual(readPanePrefs(WS, PANE, store), cleared);
});

test('unknown mode values normalize to normal', () => {
  const store = storage();
  store.setItem(panePrefsKey(WS, PANE), JSON.stringify({ version: 1, mode: 'sideways' }));
  assert.equal(readPanePrefs(WS, PANE, store).mode, 'normal');
});
