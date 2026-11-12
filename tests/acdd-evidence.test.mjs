// Approved acceptance tests for the ACDD evidence view (contract OR1).
// Written by the coordinator before implementation; the implementer must not edit this file.
// Orbit only DISPLAYS contracts and evidence; the bundlebees verifier and Kyle's gates decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAILURE_TEXT, STATUS_LABEL, parseContract, parseEvidence, buildEvidenceView, toActivityItems, readEvidenceDir,
} from '../server/acdd-evidence.mjs';
import { renderEvidencePanel } from '../src/acdd-evidence-panel.ts';

const SHA = 'a'.repeat(40);
const CSHA = 'c'.repeat(64);
const contract = () => ({
  contract_version: 'acdd/1', id: 'W1-pricing', title: 'Add apply_tax',
  outcome: { summary: 'tax', observable_behavior: ['x'] },
  acceptance_criteria: [
    { id: 'AC-001', given: 'a price', when: 'apply_tax(1000, 10)', then: '1100', verification: 'test', tests: ['tests/test_pricing.py::test_apply_tax'] },
    { id: 'AC-002', statement: 'combined suite passes', verification: 'integration' },
    { id: 'AC-003', statement: 'naming reviewed', verification: 'review' },
  ],
  scope: { assigned_files: ['shop/pricing.py'], test_files: ['tests/test_pricing.py'] },
  source_rev: SHA, tdd: { applicable: true }, verification: { independent: true },
  evidence_required: ['red', 'green', 'integration'],
  authorization: { human_gates: ['merge', 'release', 'deploy', 'publish'] },
  review: { status: 'approved', approved_by: 'kyle', approved_at: '2026-11-12T18:00:00Z', contract_sha256: CSHA },
});
const rec = (phase, classification, criteria, extra = {}) => ({
  evidence_version: 'tdd-evidence/1', contract_id: 'W1-pricing', contract_sha256: CSHA, phase,
  revision: (phase === 'red' ? 'e' : 'b').repeat(40), base_rev: SHA, test_fingerprints: { 'tests/test_pricing.py': 'd'.repeat(64) },
  command: ['python', '-m', 'pytest'], result: { exit_code: classification === 'passed' ? 0 : 1, tests: 1, failures: classification === 'passed' ? 0 : 1, errors: 0, skipped: 0, timed_out: false },
  classification, criteria, produced_by: { role: 'verifier', name: 'bundlebees' }, test_first: true, at: '2026-11-12T18:0' + (phase === 'red' ? '1' : '2') + ':00Z',
  ...extra,
});
const RED = rec('red', 'behavioral_failure', { 'AC-001': 'failed', 'AC-002': 'not_run', 'AC-003': 'review_required' });
const GREEN = rec('green', 'passed', { 'AC-001': 'passed', 'AC-002': 'not_run', 'AC-003': 'review_required' }, { signature: 'f'.repeat(64) });

// AC-001: every protocol failure code and status has a plain-language label.
test('failure codes and status labels cover the protocol', () => {
  for (const code of ['contract_invalid', 'contract_not_frozen', 'contract_changed', 'red_invalid', 'red_incomplete', 'red_missing',
    'stale_revision', 'tests_tampered', 'scope_violation', 'green_failed', 'refactor_failed', 'integration_failed', 'unrun']) {
    assert.equal(typeof FAILURE_TEXT[code], 'string', code);
    assert.ok(FAILURE_TEXT[code].length > 10, code);
  }
  assert.equal(STATUS_LABEL.passed, 'Passed');
  assert.equal(STATUS_LABEL.failed, 'Failed');
  assert.equal(STATUS_LABEL.not_run, 'Not run');
  assert.equal(STATUS_LABEL.unrun, 'Not run');
  assert.equal(STATUS_LABEL.review_required, 'Needs review');
});

// AC-002: contracts and evidence are parsed strictly by version.
test('parseContract reads acdd/1 and refuses other versions', () => {
  const c = parseContract(contract());
  assert.equal(c.id, 'W1-pricing');
  assert.equal(c.sha256, CSHA);
  assert.equal(c.shortSha, CSHA.slice(0, 12));
  assert.equal(c.frozen, true);
  assert.deepEqual(c.criteria.map(x => x.id), ['AC-001', 'AC-002', 'AC-003']);
  assert.match(c.criteria[0].text, /Given a price.*When apply_tax\(1000, 10\).*Then 1100/);
  assert.equal(c.criteria[1].text, 'combined suite passes');
  assert.deepEqual(c.testFiles, ['tests/test_pricing.py']);
  assert.throws(() => parseContract({ ...contract(), contract_version: 'acdd/2' }), e => e.code === 'contract_invalid');
  assert.throws(() => parseContract({ ...contract(), acceptance_criteria: [] }), e => e.code === 'contract_invalid');
  const draft = parseContract({ ...contract(), review: { status: 'draft' } });
  assert.equal(draft.frozen, false);
});

test('parseEvidence normalises a record and refuses other versions', () => {
  const g = parseEvidence(GREEN);
  assert.equal(g.phase, 'green');
  assert.equal(g.classification, 'passed');
  assert.equal(g.shortRev, 'b'.repeat(12));
  assert.equal(g.by, 'verifier');
  assert.equal(g.signed, true);
  assert.equal(parseEvidence(RED).signed, false);
  assert.throws(() => parseEvidence({ ...GREEN, evidence_version: 'x' }), e => e.code === 'evidence_invalid');
});

// AC-003: the view shows RED -> GREEN, per-criterion status, and unrun checks as unrun.
test('buildEvidenceView shows the timeline and never shows unrun as passed', () => {
  const v = buildEvidenceView(contract(), [RED, GREEN]);
  assert.equal(v.contractId, 'W1-pricing');
  assert.equal(v.authority, 'bundlebees verifier');
  assert.deepEqual(v.timeline.map(t => [t.phase, t.classification, t.ok]), [['red', 'behavioral_failure', true], ['green', 'passed', true]]);
  const byId = Object.fromEntries(v.criteria.map(c => [c.id, c]));
  assert.equal(byId['AC-001'].status, 'passed');
  assert.equal(byId['AC-001'].label, 'Passed');
  assert.equal(byId['AC-002'].status, 'not_run');
  assert.equal(byId['AC-002'].label, 'Not run');
  assert.equal(byId['AC-003'].status, 'review_required');
  assert.equal(v.phases.red, 'valid');
  assert.equal(v.phases.green, 'valid');
  assert.equal(v.phases.integration, 'unrun');
  assert.equal(v.accepted, false);
});

test('a bundlebees acceptance report is shown as-is and failures get plain text', () => {
  const report = { contract_id: 'W1-pricing', contract_sha256: CSHA, accepted: false,
    phases: { red: 'valid', green: 'tests_tampered', integration: 'unrun' },
    criteria: { 'AC-001': { status: 'failed', evidence: 'evidence/0002-green.json' }, 'AC-002': { status: 'not_run', evidence: null }, 'AC-003': { status: 'review_required', evidence: null } } };
  const v = buildEvidenceView(contract(), [RED, GREEN], report);
  assert.equal(v.phases.green, 'tests_tampered');
  assert.equal(v.accepted, false);
  assert.ok(v.failures.some(f => f.code === 'tests_tampered' && f.text === FAILURE_TEXT.tests_tampered));
  assert.equal(Object.fromEntries(v.criteria.map(c => [c.id, c.status]))['AC-001'], 'failed');
  assert.equal(v.criteria.find(c => c.id === 'AC-001').evidence, 'evidence/0002-green.json');
});

// AC-004: stale evidence and worker self-reports never count.
test('stale and worker-produced records are flagged and ignored for status', () => {
  const stale = rec('green', 'passed', { 'AC-001': 'passed' }, { contract_sha256: '9'.repeat(64) });
  const worker = rec('green', 'passed', { 'AC-001': 'passed' }, { produced_by: { role: 'worker', name: 'bee' } });
  const v = buildEvidenceView(contract(), [RED, stale, worker]);
  assert.equal(v.criteria.find(c => c.id === 'AC-001').status, 'failed');
  assert.equal(v.phases.green, 'unrun');
  assert.ok(v.failures.some(f => f.code === 'stale_revision'));
  assert.ok(v.notes.some(n => /worker/i.test(n) && /not authority|does not count|ignored/i.test(n)));
});

// AC-005: activity items for the Activity panel.
test('toActivityItems summarises phases for the activity feed', () => {
  const items = toActivityItems(buildEvidenceView(contract(), [RED, GREEN]));
  assert.ok(items.length >= 3);
  for (const it of items) {
    assert.equal(it.kind, 'acdd');
    assert.ok(['done', 'error', 'pending'].includes(it.state));
    assert.equal(typeof it.text, 'string');
  }
  assert.ok(items.some(i => i.state === 'pending' && /integration/i.test(i.text)));
  assert.ok(items.some(i => i.state === 'done' && /green/i.test(i.text)));
});

// AC-006: evidence directory reading is read-only and bounded.
test('readEvidenceDir reads the bundlebees layout safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acdd-ev-'));
  const dir = join(root, 'W1-pricing');
  mkdirSync(dir);
  writeFileSync(join(dir, '0001-red.json'), JSON.stringify(RED));
  writeFileSync(join(dir, '0002-green.json'), JSON.stringify(GREEN));
  writeFileSync(join(dir, '0003-bad.json'), '{not json');
  writeFileSync(join(dir, '0004-big.json'), 'x'.repeat(300 * 1024));
  symlinkSync('/etc/hostname', join(dir, '0005-link.json'));
  const out = await readEvidenceDir(root, 'W1-pricing');
  assert.deepEqual(out.records.map(r => r.phase), ['red', 'green']);
  assert.equal(out.skipped.length, 3);
  await assert.rejects(() => readEvidenceDir(root, '../etc'), e => e.code === 'evidence_invalid');
  const none = await readEvidenceDir(root, 'nobody');
  assert.deepEqual(none.records, []);
});

// AC-007: text is redacted and the panel escapes HTML.
test('secrets are redacted and the panel escapes HTML', () => {
  const c = contract();
  c.title = '<script>alert(1)</script> token=abcdef0123456789abcdefXYZ'; // gitleaks:allow (fake value)
  const v = buildEvidenceView(c, [RED, GREEN]);
  assert.ok(!v.title.includes('abcdef0123456789abcdefXYZ'));
  const html = renderEvidencePanel(v);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Not run'));
  assert.ok(html.includes('AC-001'));
  assert.match(html, /acdd-status-not-run/);
  assert.match(html, /bundlebees verifier/);
});
