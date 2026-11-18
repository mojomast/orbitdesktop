import test from 'node:test';
import assert from 'node:assert/strict';
import { renderQueueDesk, queueFacts } from '../apps/rizzstack-hive/queue-desk.js';
import { capture } from '../apps/rizzstack-hive/queue-data.js';

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.ownerDocument = {createElement: t => new El(t)}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  words() { return [this.textContent, ...this.children.map(c => c.words())].join(' '); }
  set innerHTML(_) { throw Error('HTML input is forbidden'); }
}

test('demonstration names the exact candidate, pending criterion and separate scope conflict', () => {
  const root = new El('section');
  renderQueueDesk(root, {demo: true});
  const shown = root.words();
  for (const value of ['DISCONNECTED', 'suggestion', 'PARTIAL', 'AC-004', 'AC-001', 'AC-002', 'AC-003',
      '3 of 4', 'queued', capture.candidate, ...capture.work.overlap_ids, 'not enrolled']) assert.ok(shown.includes(value), value);
  assert.match(shown, /simulated draft/i);
  assert.match(shown, /queue (was not changed|unchanged)/i);
  assert.doesNotMatch(shown, /att_\w+|\/tmp\//);
});

test('disconnected host mode clears the previous example and supplies no substitute facts', () => {
  const root = new El('section');
  renderQueueDesk(root, {demo:true});
  for (const demo of [false, 'true', undefined]) {
    renderQueueDesk(root, {demo});
    assert.match(root.words(), /unavailable/i);
    assert.doesNotMatch(root.words(), /PARTIAL|AC-001|3 of 4|simulated draft/i);
  }
});

test('stale head, ungrounded verdict, malformed evidence and hostile content lose coverage', () => {
  const poison = '<img src=x onerror=alert(1)>';
  for (const changed of [ {candidate: 'f'.repeat(40)}, {coverage: {...capture.coverage, classification:'UNKNOWN'}},
    {coverage: {...capture.coverage, queue_mutated:true}}, {coverage: {...capture.coverage, missing: ['AC-001']}},
    {coverage: {...capture.coverage, feature_id: poison, pr_url:'javascript:alert(1)'}},
    {coverage: {...capture.coverage, covered:Array(10000).fill(poison)}} ]) {
    const facts = queueFacts({...capture,...changed});
    assert.equal(facts.verdict, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(facts), /onerror|javascript:|PARTIAL/);
  }
});
