// Acceptance tests for the ACDD evidence model and server-side signature checks.
// Evidence counts only after the bundlebees HMAC signature verifies with the
// coordinator's lease key; a label alone is never authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAILURE_TEXT, STATUS_LABEL, parseContract, parseEvidence, buildEvidenceView, toActivityItems, readEvidenceDir,
  canonicalJson, verifyRecordSignature, loadLeaseKey,
} from '../server/acdd-evidence.mjs';
import { renderEvidencePanel } from '../src/acdd-evidence-panel.ts';

const SHA = 'a'.repeat(40);
const CSHA = 'c'.repeat(64);
const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const VERIFY = { verify: record => verifyRecordSignature(record, KEY), verificationAvailable: true };

const unsigned = value => Object.fromEntries(
  Object.entries(value).filter(([key]) => key !== 'signature' && !key.startsWith('_')),
);
const signatureFor = (value, key = KEY) => createHmac('sha256', key)
  .update(canonicalJson(unsigned(value)), 'utf8')
  .digest('hex');
const sign = (value, key = KEY) => ({ ...unsigned(value), signature: signatureFor(value, key) });

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
  command: ['python3', '-m', 'pytest'], result: { exit_code: classification === 'passed' ? 0 : 1, tests: 1, failures: classification === 'passed' ? 0 : 1, errors: 0, skipped: 0, timed_out: false },
  classification, criteria, produced_by: { role: 'verifier', name: 'bundlebees' }, test_first: true, at: '2026-11-12T18:0' + (phase === 'red' ? '1' : '2') + ':00Z',
  ...extra,
});
const RED = sign(rec('red', 'behavioral_failure', { 'AC-001': 'failed', 'AC-002': 'not_run', 'AC-003': 'review_required' }, { at: '2026-11-12T18:01:00Z' }));
const GREEN = sign(rec('green', 'passed', { 'AC-001': 'passed', 'AC-002': 'not_run', 'AC-003': 'review_required' }, { at: '2026-11-12T18:02:00Z' }));
const view = (records, report = null) => buildEvidenceView(contract(), records, report, VERIFY);
const report = (over = {}) => sign({
  contract_id: 'W1-pricing', contract_sha256: CSHA, accepted: true,
  phases: { red: 'valid', green: 'valid', integration: 'unrun' },
  criteria: {
    'AC-001': { status: 'passed', evidence: 'evidence/0002-green.json' },
    'AC-002': { status: 'not_run', evidence: null },
    'AC-003': { status: 'review_required', evidence: null },
  },
  ...over,
});

// AC-001: every protocol failure code and status has a plain-language label.
test('failure codes and status labels cover the protocol', () => {
  for (const code of ['contract_invalid', 'contract_not_frozen', 'contract_changed', 'red_invalid', 'red_incomplete', 'red_missing',
    'stale_revision', 'tests_tampered', 'scope_violation', 'green_failed', 'refactor_failed', 'integration_failed', 'unrun', 'evidence_tampered']) {
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
  // Parsing never grants signature authority; only the server-side check can.
  assert.equal(g.signed, false);
  assert.equal(g.hasSignature, true);
  assert.equal(parseEvidence(unsigned(RED)).signed, false);
  assert.equal(parseEvidence(unsigned(RED)).hasSignature, false);
  assert.throws(() => parseEvidence({ ...GREEN, evidence_version: 'x' }), e => e.code === 'evidence_invalid');
});

// AC-003: canonical JSON and signatures match the bundlebees/Python scheme.
test('canonicalJson matches Python json.dumps for nested keys and non-ASCII text', t => {
  const value = {
    zebra: [1, true, null, -7],
    'é': 'café ☃ 𝄞',
    nested: { b: 2, a: '\n\t\b\f\r"\\\u0001\u007f' },
    alpha: { z: [], y: {} },
  };
  const script = [
    'import json,sys',
    'value=json.load(sys.stdin)',
    "print(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True))",
  ].join('\n');
  const out = spawnSync('python3', ['-c', script], { input: JSON.stringify(value), encoding: 'utf8' });
  if (out.error && out.error.code === 'ENOENT') {
    t.skip('python3 is not available');
    return;
  }
  assert.equal(out.status, 0, out.stderr);
  assert.equal(canonicalJson(value), out.stdout.replace(/\n$/, ''));
});

test('a Python-computed fixture signature verifies byte-for-byte', t => {
  const fixture = rec('green', 'passed', { 'AC-001': 'passed' }, {
    nested: { z: 'naïve', a: [1, 2, { '𝄞': 'ok' }] },
    _server_hint: 'never signed',
    at: '2026-11-12T18:02:00Z',
  });
  const script = [
    'import hmac,hashlib,json,sys',
    'key=bytes.fromhex(sys.argv[1])',
    'record=json.load(sys.stdin)',
    "payload={k:v for k,v in record.items() if k!='signature' and not str(k).startswith('_')}",
    "canonical=json.dumps(payload,sort_keys=True,separators=(',',':'),ensure_ascii=True)",
    "print(canonical)",
    "print(hmac.new(key,canonical.encode('utf-8'),hashlib.sha256).hexdigest())",
  ].join('\n');
  const out = spawnSync('python3', ['-c', script, KEY.toString('hex')], {
    input: JSON.stringify(fixture), encoding: 'utf8',
  });
  if (out.error && out.error.code === 'ENOENT') {
    t.skip('python3 is not available');
    return;
  }
  assert.equal(out.status, 0, out.stderr);
  const [pythonCanonical, pythonSignature] = out.stdout.trim().split('\n');
  assert.equal(canonicalJson(unsigned(fixture)), pythonCanonical);
  const signed = { ...unsigned(fixture), signature: pythonSignature };
  assert.equal(verifyRecordSignature(signed, KEY), true);
  assert.equal(verifyRecordSignature({ ...signed, classification: 'failed' }, KEY), false);
});

test('canonicalJson sorts keys by code point and escapes like Python', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ '😀': 1, '\uffff': 2 }), '{"\\uffff":2,"\\ud83d\\ude00":1}');
  assert.equal(canonicalJson('café'), '"caf\\u00e9"');
  assert.equal(canonicalJson('a\nb'), '"a\\nb"');
});

// AC-004: only signed verifier records count; modified and stolen labels are rejected.
test('a valid signed verifier record counts', () => {
  const v = view([RED, GREEN]);
  assert.equal(v.authority, 'bundlebees verifier');
  assert.deepEqual(v.timeline.map(t => [t.phase, t.classification, t.ok]), [['red', 'behavioral_failure', true], ['green', 'passed', true]]);
  assert.equal(v.phases.red, 'valid');
  assert.equal(v.phases.green, 'valid');
  assert.deepEqual(v.verification, { available: true, verified: 2, rejected: 0 });
  assert.equal(v.accepted, false);
});

test('a modified record is rejected and never counted', () => {
  const modified = { ...GREEN, at: '2026-11-12T18:03:00Z' };
  const v = view([RED, modified]);
  assert.equal(v.phases.green, 'unrun');
  assert.equal(v.criteria.find(c => c.id === 'AC-001').status, 'failed');
  assert.ok(v.failures.some(f => f.code === 'evidence_tampered'));
  assert.deepEqual(v.verification, { available: true, verified: 1, rejected: 1 });
  assert.ok(v.notes.some(note => /signature|tamper|verify/i.test(note)));
});

test('a stolen verifier label is rejected with evidence_tampered', () => {
  const unsignedStolen = { ...unsigned(rec('green', 'passed', { 'AC-001': 'passed' })) };
  const wrongKey = sign(rec('green', 'passed', { 'AC-001': 'passed' }), OTHER_KEY);
  for (const stolen of [unsignedStolen, wrongKey]) {
    const v = view([RED, stolen]);
    assert.equal(v.phases.green, 'unrun');
    assert.ok(v.failures.some(f => f.code === 'evidence_tampered'));
    assert.equal(v.criteria.find(c => c.id === 'AC-001').status, 'failed');
    assert.ok(v.notes.some(note => /verifier/i.test(note) && /signature|count|ignored|verify/i.test(note)));
  }
});

test('unsigned and worker records are ignored, not counted', () => {
  const unsignedWorker = { ...unsigned(rec('green', 'passed', { 'AC-001': 'passed' }, { produced_by: { role: 'worker', name: 'bee' } })) };
  const signedWorker = sign(rec('green', 'passed', { 'AC-001': 'passed' }, { produced_by: { role: 'worker', name: 'bee' } }));
  for (const worker of [unsignedWorker, signedWorker]) {
    const v = view([RED, worker]);
    assert.equal(v.phases.green, 'unrun');
    assert.ok(v.notes.some(n => /worker/i.test(n) && /ignored|not authority/i.test(n)));
    assert.ok(!v.failures.some(f => f.code === 'evidence_tampered'));
  }
});

test('a fake 64-character signature is not evidence', () => {
  const fake = { ...rec('green', 'passed', { 'AC-001': 'passed' }), signature: 'f'.repeat(64) };
  const v = view([RED, fake]);
  assert.equal(v.phases.green, 'unrun');
  assert.ok(v.failures.some(f => f.code === 'evidence_tampered'));
});

// AC-005: report acceptance requires a contract-matching signed report.
test('a valid signed acceptance report with matching sha yields accepted:true', () => {
  const v = view([RED, GREEN], report());
  assert.equal(v.accepted, true);
  assert.equal(v.phases.green, 'valid');
  assert.equal(v.criteria.find(c => c.id === 'AC-001').status, 'passed');
  assert.equal(v.criteria.find(c => c.id === 'AC-001').evidence, 'evidence/0002-green.json');
});

test('a report with a bad signature or mismatched sha cannot set accepted:true', () => {
  const badSignature = { ...report({ accepted: false }), accepted: true };
  const wrongContract = report({ contract_sha256: '9'.repeat(64) });
  for (const candidate of [badSignature, wrongContract]) {
    const v = view([RED, GREEN], candidate);
    assert.equal(v.accepted, false);
    assert.equal(v.phases.green, 'valid');
    assert.ok(v.notes.some(note => /report/i.test(note) && /ignored|signature|contract/i.test(note)));
  }
});

test('without a verified report criteria come from verified records only', () => {
  const fake = { ...rec('green', 'passed', { 'AC-001': 'passed' }), signature: 'a'.repeat(64) };
  const v = view([RED, fake]);
  assert.equal(v.accepted, false);
  assert.equal(v.criteria.find(c => c.id === 'AC-001').status, 'failed');
  assert.equal(v.phases.green, 'unrun');
});

// AC-006: stale evidence is flagged and ignored for status.
test('signed stale records are flagged and ignored for status', () => {
  const stale = sign(rec('green', 'passed', { 'AC-001': 'passed' }, { contract_sha256: '9'.repeat(64) }));
  const v = view([RED, stale]);
  assert.equal(v.criteria.find(c => c.id === 'AC-001').status, 'failed');
  assert.equal(v.phases.green, 'unrun');
  assert.ok(v.failures.some(f => f.code === 'stale_revision'));
});

// AC-007: activity items for the Activity panel.
test('toActivityItems summarises phases for the activity feed', () => {
  const items = toActivityItems(view([RED, GREEN]));
  assert.ok(items.length >= 3);
  for (const it of items) {
    assert.equal(it.kind, 'acdd');
    assert.ok(['done', 'error', 'pending'].includes(it.state));
    assert.equal(typeof it.text, 'string');
  }
  assert.ok(items.some(i => i.state === 'pending' && /integration/i.test(i.text)));
  assert.ok(items.some(i => i.state === 'done' && /green/i.test(i.text)));
});

// AC-008: evidence directory reading is read-only and bounded.
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

// AC-009: the lease key must be a private regular 32-byte file.
test('lease key loading refuses missing, group-readable, symlinked and wrong-size keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acdd-key-'));
  const path = join(root, 'lease.key');

  assert.equal((await loadLeaseKey(root)).available, false);
  assert.equal((await loadLeaseKey('')).available, false);

  writeFileSync(path, KEY, { mode: 0o600 });
  chmodSync(path, 0o600);
  const good = await loadLeaseKey(root);
  assert.equal(good.available, true);
  assert.deepEqual(Buffer.from(good.key), KEY);

  chmodSync(path, 0o640);
  assert.equal((await loadLeaseKey(root)).available, false);
  chmodSync(path, 0o604);
  assert.equal((await loadLeaseKey(root)).available, false);

  chmodSync(path, 0o600);
  const target = join(root, 'other.key');
  writeFileSync(target, KEY, { mode: 0o600 });
  chmodSync(target, 0o600);
  const linkRoot = mkdtempSync(join(tmpdir(), 'acdd-key-link-'));
  symlinkSync(target, join(linkRoot, 'lease.key'));
  assert.equal((await loadLeaseKey(linkRoot)).available, false);

  const shortRoot = mkdtempSync(join(tmpdir(), 'acdd-key-short-'));
  writeFileSync(join(shortRoot, 'lease.key'), KEY.subarray(0, 31), { mode: 0o600 });
  chmodSync(join(shortRoot, 'lease.key'), 0o600);
  assert.equal((await loadLeaseKey(shortRoot)).available, false);
});

test('an unavailable key produces an unavailable view and counts nothing', () => {
  const v = buildEvidenceView(contract(), [RED, GREEN], null, { verificationAvailable: false });
  assert.deepEqual(v.verification, { available: false, verified: 0, rejected: 2 });
  assert.equal(v.phases.red, 'unrun');
  assert.equal(v.phases.green, 'unrun');
  assert.equal(v.accepted, false);
  assert.ok(v.notes.some(note => /verification.*unavailable/i.test(note)));
  assert.ok(v.notes.every(note => !note.includes(KEY.toString('hex'))));
});

// AC-010: text is redacted and the panel escapes HTML.
test('secrets are redacted and the panel escapes HTML', () => {
  const c = contract();
  c.title = '<script>alert(1)</script> token=abcdef0123456789abcdefXYZ'; // gitleaks:allow (fake value)
  const v = buildEvidenceView(c, [RED, GREEN], null, VERIFY);
  assert.ok(!v.title.includes('abcdef0123456789abcdefXYZ'));
  const html = renderEvidencePanel(v);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Not run'));
  assert.ok(html.includes('AC-001'));
  assert.match(html, /acdd-status-not-run/);
  assert.match(html, /bundlebees verifier/);
});

test('buildEvidenceView fails closed when no verifier is available: no report or record is trusted', () => {
  const unsignedReport = unsigned(report());
  const signedReport = report();
  const cases = [
    ['no options, unsigned report', buildEvidenceView(contract(), [RED, GREEN], unsignedReport)],
    ['no options, signed report', buildEvidenceView(contract(), [RED, GREEN], signedReport)],
    ['empty options', buildEvidenceView(contract(), [RED, GREEN], signedReport, {})],
    ['verificationAvailable false with a permissive verify', buildEvidenceView(contract(), [RED, GREEN], unsignedReport, { verify: () => true, verificationAvailable: false })],
    ['null options', buildEvidenceView(contract(), [RED, GREEN], signedReport, null)],
  ];
  for (const [name, result] of cases) {
    assert.equal(result.accepted, false, `${name} must not be accepted`);
    assert.equal(result.verified ?? 0, 0, `${name} must not count verified records`);
  }
  const forged = buildEvidenceView(contract(), [RED, GREEN], { ...unsignedReport, signature: 'f'.repeat(64) }, { key: KEY });
  assert.equal(forged.accepted, false);
  const realKey = buildEvidenceView(contract(), [RED, GREEN], signedReport, { key: KEY });
  assert.equal(realKey.accepted, true, 'a report signed with the lease key is still accepted');
});
