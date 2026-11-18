import test from 'node:test';
import assert from 'node:assert/strict';
import {project} from '../apps/rizzstack-hive/snapshot-adapter.js';
import {fixtures, fixtureTime} from '../apps/rizzstack-hive/fixtures.js';

const clock = {now: fixtureTime};
const section = (v, id) => v.sections.find(x => x.id === id);
const station = (v, id) => v.stations.find(x => x.id === id);

test('a section body the adapter cannot read degrades only that section', () => {
  const s = structuredClone(fixtures.dense);
  s.decisions.requests = {unexpected: 'shape'};
  const v = project(s, clock);
  assert.deepEqual(section(v, 'decisions'), {id: 'decisions', state: 'unavailable', at: null});
  assert.equal(section(v, 'fleet').state, 'live');
  assert.equal(section(v, 'pipeline').state, 'live');
  assert.equal(section(v, 'usage').state, 'live');
  assert.equal(station(v, 'build').level, 'active');
  assert.ok(v.records.some(r => r.kind === 'job' && r.id === 'job:ledger'));
  assert.ok(v.records.some(r => r.kind === 'bottleneck'));
  assert.ok(v.records.some(r => r.kind === 'usage'));
  assert.ok(!v.records.some(r => r.kind === 'decision'));
});

test('multiple malformed section bodies stay local to their own stations', () => {
  const s = structuredClone(fixtures.dense);
  s.decisions.requests = 'not-a-list';
  s.usage.by_model = {unexpected: true};
  const v = project(s, clock);
  assert.equal(section(v, 'decisions').state, 'unavailable');
  assert.equal(section(v, 'usage').state, 'unavailable');
  assert.equal(section(v, 'fleet').state, 'live');
  assert.equal(section(v, 'ci').state, 'live');
  assert.equal(station(v, 'build').level, 'active');
  assert.equal(v.metrics.cost, null);
  assert.equal(v.metrics.costCoverage, null);
  assert.equal(v.metrics.active, 14);
  assert.ok(v.records.some(r => r.kind === 'job'));
  assert.ok(v.records.some(r => r.kind === 'ci'));
  assert.ok(!v.records.some(r => ['decision', 'usage'].includes(r.kind)));
});

test('document-level security refusals still fail closed', () => {
  for (const mutate of [
    s => { s.fleet = Object.create(s.fleet); },
    s => { s.decisions.requests[0] = Object.create(s.decisions.requests[0]); },
    s => { s.fleet.attempts[0] = Object.defineProperty({}, 'state', {get() { throw Error('private note'); }}); },
    s => { s.usage.totals.cost_usd = Infinity; },
    s => { s.generated_at = '2026-02-31T00:00:00Z'; },
    s => { s.decisions.requests[0].raised_at = '2026-02-31T00:00:00Z'; },
    s => { s.fleet.attempts.push(structuredClone(s.fleet.attempts[0])); },
    s => { s.schema += '.99'; },
    s => { delete s.generated_at; },
    s => { s.degraded = ['not_a_section']; },
  ]) {
    const s = structuredClone(fixtures.dense);
    mutate(s);
    assert.throws(() => project(s, clock), {message: 'Invalid Hive snapshot'});
  }
});

test('credential-shaped identifiers are still withheld', () => {
  const s = structuredClone(fixtures.dense);
  s.fleet.attempts[0].attempt_id = 'ghp_fixtureCredential';
  const v = project(s, clock);
  assert.ok(!v.attempts.some(a => a.id === 'ghp_fixtureCredential'));
  assert.doesNotMatch(JSON.stringify(v), /ghp_fixtureCredential/);
});
