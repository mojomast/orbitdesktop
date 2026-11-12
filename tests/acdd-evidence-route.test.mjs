// Acceptance tests for wiring the read-only ACDD evidence view into Orbit.
// The route verifies every record and the acceptance report with the
// coordinator's private lease key. Orbit only displays the verified result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, chmodSync, unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcddEvidenceRoute } from '../server/acdd-evidence-route.mjs';
import { canonicalJson, verifyRecordSignature } from '../server/acdd-evidence.mjs';
import { contractListHtml, evidenceRequest, ACDD_EVIDENCE_COMMAND } from '../src/acdd-evidence-window.ts';

const SHA = 'a'.repeat(40);
const CSHA = 'c'.repeat(64);
const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

const unsigned = value => Object.fromEntries(
  Object.entries(value).filter(([key]) => key !== 'signature' && !key.startsWith('_')),
);
const sign = (value, key = KEY) => ({
  ...unsigned(value),
  signature: createHmac('sha256', key).update(canonicalJson(unsigned(value)), 'utf8').digest('hex'),
});

const contract = (over = {}) => ({
  contract_version: 'acdd/1', id: 'W1-pricing', title: 'Add apply_tax',
  outcome: { summary: 'tax', observable_behavior: ['x'] },
  acceptance_criteria: [
    { id: 'AC-001', given: 'a price', when: 'apply_tax(1000, 10)', then: '1100', verification: 'test', tests: ['tests/test_pricing.py::test_apply_tax'] },
  ],
  scope: { assigned_files: ['shop/pricing.py'], test_files: ['tests/test_pricing.py'] },
  source_rev: SHA, tdd: { applicable: true }, verification: { independent: true },
  evidence_required: ['red', 'green'],
  authorization: { human_gates: ['merge'] },
  review: { status: 'approved', approved_by: 'kyle', approved_at: '2026-11-12T18:00:00Z', contract_sha256: CSHA },
  ...over,
});
const rec = (phase, classification, criteria) => ({
  evidence_version: 'tdd-evidence/1', contract_id: 'W1-pricing', contract_sha256: CSHA, phase,
  revision: (phase === 'red' ? 'e' : 'b').repeat(40), base_rev: SHA, test_fingerprints: { 'tests/test_pricing.py': 'd'.repeat(64) },
  command: ['pytest'], result: { exit_code: classification === 'passed' ? 0 : 1, tests: 1, failures: classification === 'passed' ? 0 : 1, errors: 0, skipped: 0, timed_out: false },
  classification, criteria, produced_by: { role: 'verifier', name: 'bundlebees' }, test_first: true, at: '2026-11-12T18:01:00Z',
});
const RED = sign(rec('red', 'behavioral_failure', { 'AC-001': 'failed' }));
const GREEN = sign(rec('green', 'passed', { 'AC-001': 'passed' }));
const acceptance = (over = {}) => sign({
  contract_id: 'W1-pricing', contract_sha256: CSHA, accepted: true,
  phases: { red: 'valid', green: 'valid' },
  criteria: { 'AC-001': { status: 'passed', evidence: 'evidence/0002-green.json' } },
  ...over,
});

// A bundlebees plugin data directory: leases/<attempt>.json carry the brief (with its contract);
// evidence/<contract_id>/NNNN-phase.json are the signed records; reports/<id>.json is the signed report.
function stateDir({ records = [RED, GREEN] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acdd-route-'));
  mkdirSync(join(root, 'leases'));
  mkdirSync(join(root, 'evidence', 'W1-pricing'), { recursive: true });
  writeFileSync(join(root, 'lease.key'), KEY, { mode: 0o600 });
  chmodSync(join(root, 'lease.key'), 0o600);
  writeFileSync(join(root, 'leases', 'att-1.json'), JSON.stringify({ attempt_id: 'att-1', brief: { objective: 'x', contract: contract() } }));
  writeFileSync(join(root, 'leases', 'att-0.json'), JSON.stringify({ attempt_id: 'att-0', brief: { objective: 'legacy brief without a contract' } }));
  records.forEach((record, index) => {
    writeFileSync(join(root, 'evidence', 'W1-pricing', `000${index + 1}-${record.phase}.json`), JSON.stringify(record));
  });
  return root;
}

function writeReport(root, report) {
  mkdirSync(join(root, 'reports'), { recursive: true });
  writeFileSync(join(root, 'reports', 'W1-pricing.json'), JSON.stringify(report));
}

function snapshot(root) {
  const out = {};
  const walk = dir => { for (const name of readdirSync(dir)) { const p = join(dir, name); const s = statSync(p); if (s.isDirectory()) walk(p); else out[p] = [s.size, s.mtimeMs, readFileSync(p, 'utf8')]; } };
  walk(root);
  return out;
}

async function call(route, { method = 'GET', path = '/api/acdd-evidence', authorized = true } = {}) {
  const url = new URL(path, 'http://127.0.0.1');
  const req = { method, url: url.pathname + url.search, headers: authorized ? { authorization: 'Bearer ok' } : {} };
  let status = 0, headers = {}, body = '';
  const res = { writeHead(code, h = {}) { status = code; headers = h; return this; }, setHeader() {}, end(data) { body = data ? String(data) : ''; } };
  await route.handle(req, res, url);
  return { status, headers, json: body ? JSON.parse(body) : null, body };
}

const authorize = req => req.headers.authorization === 'Bearer ok';

// AC-001: the route is GET-only and needs an authorized Orbit session.
test('route refuses unauthorized callers and non-GET methods', async () => {
  const route = createAcddEvidenceRoute({ stateDir: stateDir(), authorize });
  assert.equal((await call(route, { authorized: false })).status, 403);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await call(route, { method })).status, 405);
});

// AC-002: without a configured bundlebees state directory the view says so instead of guessing.
test('unconfigured state dir is reported, not guessed', async () => {
  const route = createAcddEvidenceRoute({ stateDir: '', authorize });
  const out = await call(route);
  assert.equal(out.status, 200);
  assert.equal(out.json.configured, false);
  assert.deepEqual(out.json.contracts, []);
});

// AC-003: the list shows each contract that has evidence, with a record count; bad names are skipped.
test('lists contracts with evidence and skips unsafe entries', async () => {
  const root = stateDir();
  mkdirSync(join(root, 'evidence', '.hidden'));
  symlinkSync(join(root, 'evidence', 'W1-pricing'), join(root, 'evidence', 'W2-link'));
  const out = await call(createAcddEvidenceRoute({ stateDir: root, authorize }));
  assert.equal(out.status, 200);
  assert.equal(out.json.configured, true);
  assert.deepEqual(out.json.contracts, [{ id: 'W1-pricing', title: 'Add apply_tax', records: 2 }]);
  assert.match(out.headers['cache-control'] || out.headers['Cache-Control'] || '', /no-store/);
});

// AC-004: one contract's view is built from verified records, not labels.
test('contract view comes from the lease contract and verified evidence records', async () => {
  const out = await call(createAcddEvidenceRoute({ stateDir: stateDir(), authorize }), { path: '/api/acdd-evidence?contract=W1-pricing' });
  assert.equal(out.status, 200);
  assert.equal(out.json.view.contractId, 'W1-pricing');
  assert.equal(out.json.view.authority, 'bundlebees verifier');
  assert.deepEqual(out.json.view.timeline.map(r => r.phase), ['red', 'green']);
  assert.equal(out.json.view.phases.green, 'valid');
  assert.equal(out.json.view.accepted, false);
  assert.deepEqual(out.json.verification, { available: true, verified: 2, rejected: 0 });
  assert.ok(Array.isArray(out.json.items) && out.json.items.some(i => i.id === 'W1-pricing:summary'));
});

// AC-005: only a verified, contract-matching report can accept.
test('a valid signed report with matching contract sha yields accepted:true', async () => {
  const root = stateDir();
  writeReport(root, acceptance());
  const out = await call(createAcddEvidenceRoute({ stateDir: root, authorize }), { path: '/api/acdd-evidence?contract=W1-pricing' });
  assert.equal(out.status, 200);
  assert.equal(out.json.view.accepted, true);
  assert.equal(out.json.view.criteria.find(c => c.id === 'AC-001').status, 'passed');
  assert.equal(out.json.verification.available, true);
});

test('a report with a bad signature or mismatched sha yields accepted:false', async () => {
  const badSignature = stateDir();
  writeReport(badSignature, sign(acceptance(), OTHER_KEY));
  const bad = await call(createAcddEvidenceRoute({ stateDir: badSignature, authorize }), { path: '/api/acdd-evidence?contract=W1-pricing' });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.view.accepted, false);
  assert.equal(bad.json.view.phases.green, 'valid');

  const wrongSha = stateDir();
  writeReport(wrongSha, acceptance({ contract_sha256: '9'.repeat(64) }));
  const mismatch = await call(createAcddEvidenceRoute({ stateDir: wrongSha, authorize }), { path: '/api/acdd-evidence?contract=W1-pricing' });
  assert.equal(mismatch.status, 200);
  assert.equal(mismatch.json.view.accepted, false);
  assert.ok(mismatch.json.view.notes.some(note => /report/i.test(note)));
});

test('a modified or stolen-label record is rejected by the route', async () => {
  const root = stateDir();
  writeFileSync(join(root, 'evidence', 'W1-pricing', '0002-green.json'), JSON.stringify({ ...GREEN, at: '2026-11-12T18:09:00Z' }));
  const modified = await call(createAcddEvidenceRoute({ stateDir: root, authorize }), { path: '/api/acdd-evidence?contract=W1-pricing' });
  assert.equal(modified.json.view.phases.green, 'unrun');
  assert.ok(modified.json.view.failures.some(f => f.code === 'evidence_tampered'));
  assert.equal(modified.json.verification.rejected, 1);

  const stolenRoot = stateDir();
  writeFileSync(join(stolenRoot, 'evidence', 'W1-pricing', '0002-green.json'), JSON.stringify(unsigned(rec('green', 'passed', { 'AC-001': 'passed' }))));
  const stolen = await call(createAcddEvidenceRoute({ stateDir: stolenRoot, authorize }), { path: '/api/acdd-evidence?contract=W1-pricing' });
  assert.equal(stolen.json.view.phases.green, 'unrun');
  assert.ok(stolen.json.view.failures.some(f => f.code === 'evidence_tampered'));
  assert.equal(stolen.json.view.accepted, false);
});

// AC-006: missing or unsafe keys disable verification without inventing acceptance.
test('missing, group-readable and symlinked lease keys disable verification', async () => {
  const missing = stateDir();
  unlinkSync(join(missing, 'lease.key'));
  for (const root of [missing, stateDir()]) {
    if (root !== missing) chmodSync(join(root, 'lease.key'), 0o640);
    const out = await call(createAcddEvidenceRoute({ stateDir: root, authorize }), { path: '/api/acdd-evidence?contract=W1-pricing' });
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.verification, { available: false, verified: 0, rejected: 2 });
    assert.equal(out.json.view.accepted, false);
    assert.equal(out.json.view.phases.green, 'unrun');
    assert.ok(out.json.view.notes.some(note => /verification.*unavailable/i.test(note)));
  }

  const linked = stateDir();
  const target = join(linked, 'real-key');
  writeFileSync(target, KEY, { mode: 0o600 });
  chmodSync(target, 0o600);
  unlinkSync(join(linked, 'lease.key'));
  symlinkSync(target, join(linked, 'lease.key'));
  const out = await call(createAcddEvidenceRoute({ stateDir: linked, authorize }), { path: '/api/acdd-evidence?contract=W1-pricing' });
  assert.equal(out.json.verification.available, false);
  assert.equal(out.json.view.accepted, false);
});

// AC-007: key material and host paths never appear in any response.
test('the lease key never appears in any route response', async () => {
  const root = stateDir();
  writeReport(root, acceptance({ contract_sha256: '9'.repeat(64) }));
  const route = createAcddEvidenceRoute({ stateDir: root, authorize });
  const responses = [
    await call(route),
    await call(route, { path: '/api/acdd-evidence?contract=W1-pricing' }),
    await call(route, { path: '/api/acdd-evidence?contract=nope' }),
    await call(route, { path: '/api/acdd-evidence?contract=bad/../id' }),
    await call(route, { authorized: false }),
    await call(route, { method: 'POST' }),
  ];
  for (const out of responses) {
    assert.ok(!out.body.includes(KEY.toString('hex')));
    assert.ok(!out.body.includes(KEY.toString('base64')));
    assert.ok(!out.body.includes(root));
    assert.ok(!out.body.includes(join(root, 'lease.key')));
  }
});

// AC-008: bad ids are refused; unknown contracts are 404; a missing lease contract is not invented.
test('bad, unknown and contract-less ids are refused', async () => {
  const root = stateDir();
  mkdirSync(join(root, 'evidence', 'W9-orphan'));
  const route = createAcddEvidenceRoute({ stateDir: root, authorize });
  assert.equal((await call(route, { path: '/api/acdd-evidence?contract=../leases' })).status, 400);
  assert.equal((await call(route, { path: '/api/acdd-evidence?contract=nope' })).status, 404);
  const orphan = await call(route, { path: '/api/acdd-evidence?contract=W9-orphan' });
  assert.equal(orphan.status, 404);
  assert.match(orphan.json.error, /contract/i);
});

// AC-009: the route is read-only: nothing in the state directory changes.
test('reading never writes to the bundlebees state dir', async () => {
  const root = stateDir();
  writeReport(root, acceptance({ contract_sha256: '9'.repeat(64) }));
  const before = snapshot(root);
  const route = createAcddEvidenceRoute({ stateDir: root, authorize });
  await call(route);
  await call(route, { path: '/api/acdd-evidence?contract=W1-pricing' });
  await call(route, { method: 'POST' });
  assert.deepEqual(snapshot(root), before);
});

// AC-010: secrets in titles are redacted and errors do not leak absolute paths.
test('secrets and host paths do not leak', async () => {
  const root = stateDir();
  writeFileSync(join(root, 'leases', 'att-1.json'), JSON.stringify({ attempt_id: 'att-1', brief: { contract: contract({ title: 'token sk-abcdefghijklmnopqrstuvwxyz0123456789 here' }) } }));
  const route = createAcddEvidenceRoute({ stateDir: root, authorize });
  const list = await call(route);
  assert.doesNotMatch(list.body, /sk-abcdefghijklmnopqrstuvwxyz0123456789/);
  const missing = await call(route, { path: '/api/acdd-evidence?contract=nope' });
  assert.ok(!missing.body.includes(root));
});

// AC-011: the client helpers build an authorized GET and escape the contract list.
test('client helpers: authorized GET request and escaped list', () => {
  const r = evidenceRequest('tok', 'W1-pricing');
  assert.equal(r.url, '/api/acdd-evidence?contract=W1-pricing');
  assert.equal(r.init.method, 'GET');
  assert.equal(r.init.headers.Authorization, 'Bearer tok');
  assert.equal(evidenceRequest('tok').url, '/api/acdd-evidence');
  const html = contractListHtml([{ id: 'W1-pricing', title: '<img src=x onerror=alert(1)>', records: 2 }]);
  assert.ok(!html.includes('<img'));
  assert.match(html, /data-contract="W1-pricing"/);
  assert.match(html, /2 records/);
  assert.match(contractListHtml([]), /No ACDD evidence yet/);
  assert.ok(!/<script|<[a-z][^>]*\son[a-z]+=/i.test(html));
});

// AC-012: Orbit's existing navigation reaches the view: a command and a Hermes menu item, plus the server route.
test('the view is wired into the command palette, the Hermes menu and the server', () => {
  assert.equal(ACDD_EVIDENCE_COMMAND, 'acdd-evidence');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(main, /id:\s*'acdd-evidence'[^\n]*group:\s*'Hermes'/);
  assert.match(main, /commands\.execute\('acdd-evidence'\)/);
  const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.match(server, /'\/api\/acdd-evidence'/);
  assert.match(server, /createAcddEvidenceRoute\(/);
  assert.match(server, /ORBIT_ACDD_STATE_DIR/);
});

// AC-013: the window styles are dark-only and the window offers no write controls.
test('styles are dark-only and the window is read-only', () => {
  const css = readFileSync(new URL('../src/acdd-evidence.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /prefers-color-scheme:\s*light/);
  assert.match(css, /\.acdd-evidence-dialog/);
  const win = readFileSync(new URL('../src/acdd-evidence-window.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(win, /method:\s*'(POST|PUT|DELETE|PATCH)'/);
});
