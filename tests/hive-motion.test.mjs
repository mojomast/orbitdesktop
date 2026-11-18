import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, fixtureTime } from '../apps/rizzstack-hive/fixtures.js';
import { project } from '../apps/rizzstack-hive/snapshot-adapter.js';
import { confirmedChanges } from '../apps/rizzstack-hive/transitions.js';

const stamp = delta => new Date(fixtureTime + delta).toISOString().replace('.000Z','Z');
function pair() {
  const s = structuredClone(fixtures.shift);
  const a = project(s, {now: fixtureTime});
  s.generated_at = s.fleet.collected_at = stamp(30000);
  const changed = s.fleet.attempts.find(x => x.state === 'running');
  changed.generated_at = changed.updated_at = s.generated_at;
  changed.state = 'working';
  return [a,project(s, {now: fixtureTime + 30000}),changed.attempt_id];
}

test('only a continuous, newer pair of fleet projections highlights a changed origin ID', () => {
  const [a,b,id] = pair();
  assert.deepEqual([...confirmedChanges(a,b,true)], [id]);
  for(const [first,second,continuous] of [[null,b,true],[a,b,false],[a,a,true],[b,a,true]]) {
    assert.equal(confirmedChanges(first,second,continuous).size,0);
  }
});

test('stale clocks, old terminal receipts, ambiguous identities and missing origin cannot pulse', () => {
  for(const [description,defect] of Object.entries({
    'clock invalid': (_a,b) => {b.generatedAt = 'invalid';},
    'observations too far apart': (_a,b) => {b.generatedAt = stamp(700000);},
    'source missing on both': (_a,_b,p,r) => {delete p.source; delete r.source;},
    'fallback source': (_a,_b,p,r) => {p.source = r.source = 'snapshot/1:fleet:dispatch_leases';},
    'provenance changed': (_a,_b,p) => {p.source = 'fleet';},
    'coverage stale': (_a,b) => {b.sections.find(s=>s.id==='fleet').state='stale';},
    'old heartbeat': (_a,_b,p) => {p.quality = 'stale';},
    'prior state unknown': (_a,_b,p) => {p.state='unknown';},
    'new state unknown': (_a,_b,_p,r) => {r.state='unknown';},
    'old filed receipt': (_a,_b,p,r) => {p.at=stamp(-3900000);r.at=stamp(-3600000);r.state='done';},
    'future event': (_a,_b,_p,r) => {r.at=stamp(600000);},
    'unchanged event time': (_a,_b,p,r) => {r.at=p.at;},
    'different identity': (_a,_b,_p,r) => {r.id='unrelated';},
    'ambiguous old identity': (a,_b,p) => {a.attempts.push(p);},
    'ambiguous new identity': (_a,b,_p,r) => {b.attempts.push(r);},
    'historical view': (_a,b) => {b.health='recorded · partial';},
  })) {
    const [a,b,id] = pair();
    defect(a,b,a.attempts.find(x=>x.id===id),b.attempts.find(x=>x.id===id));
    assert.equal(confirmedChanges(a,b,true).size,0,description);
  }
});
