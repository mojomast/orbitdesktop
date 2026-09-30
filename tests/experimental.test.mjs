import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExperimental, experimentalEnabled, setExperimentalFeature, defaultExperimental } from '../src/experimental.ts';

function memory(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    delete: key => store.delete(key),
    value: key => store.get(key),
  };
}

test('experimental features are off by default and fail closed on bad state', () => {
  assert.deepEqual(defaultExperimental(), { workbench: false });
  assert.equal(experimentalEnabled('workbench', memory()), false);
  assert.equal(experimentalEnabled('workbench', null), false);
  for (const raw of ['not json', '[]', '"workbench"', '{"version":2,"workbench":true}', '{"version":1,"workbench":"yes"}', 'x'.repeat(5000)]) {
    const storage = memory({ 'orbit.experimental.v1': raw });
    assert.equal(experimentalEnabled('workbench', storage), false, raw.slice(0, 30));
  }
});

test('enabling one feature persists it and is read back without touching others', () => {
  const storage = memory();
  const next = setExperimentalFeature('workbench', true, storage);
  assert.deepEqual(next, { workbench: true });
  assert.deepEqual(readExperimental(storage), { workbench: true });
  assert.equal(experimentalEnabled('workbench', storage), true);
  assert.deepEqual(setExperimentalFeature('workbench', false, storage), { workbench: false });
  assert.deepEqual(readExperimental(storage), { workbench: false });
  assert.equal(experimentalEnabled('workbench', storage), false);
});
