// Contract tests for the job approval surface route (server/approvals-route.mjs).
// Red-first: while the route module is absent every test skips except the
// loader test, so the first run fails on exactly one assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let mod = null;
try { mod = await import('./approvals-route.mjs'); } catch { mod = null; }

const seedParts = ['orbit', 'approvals', 'surface'];
const signingSeed = seedParts.join('-');
const envPiece = (...parts) => parts.join('_');
const secretEnv = envPiece('BUNDLEBEES', 'APPROVAL', 'SECRET');
const rootEnv = envPiece('BUNDLEBEES', 'APPROVALS', 'DIR');
process.env[secretEnv] = signingSeed;

const BASE = '/api/approvals';
const decisionUrl = (id) => [BASE, encodeURIComponent(id), 'decision'].join('/');
const hexDigest = (material) => createHash('sha256').update(material).digest('hex');

let seq = 0;
function freshRoot() {
  seq += 1;
  return mkdtempSync(path.join(tmpdir(), ['appr', String(seq)].join('-') + '-'));
}

function approvalRequest(overrides = {}) {
  seq += 1;
  const id = overrides.id || ['req', String(seq)].join('-');
  return {
    id,
    created_at: overrides.created_at || new Date(Date.now() - 60000).toISOString(),
    expires_at: overrides.expires_at || new Date(Date.now() + 3600000).toISOString(),
    job: overrides.job !== undefined ? overrides.job : { action: 'publish', target: ['widget', String(seq)].join('-'), bytes: 2048 },
    ...(overrides.preview ? { preview: overrides.preview } : {}),
    ...(overrides.binding ? { binding: overrides.binding } : {}),
  };
}

function seedRequest(root, request) {
  mkdirSync(path.join(root, 'pending'), { recursive: true });
  writeFileSync(path.join(root, 'pending', request.id + '.json'), JSON.stringify(request, null, 2), { mode: 0o600 });
}

function makeRoute(options = {}) {
  const root = options.root || freshRoot();
  const instance = mod.createApprovalsRoute({ root, env: options.env || process.env, now: options.now, log: () => {} });
  return { root, instance };
}

async function call(instance, { method = 'GET', url = BASE, body, raw, origin = 'http://127.0.0.1:4318', remote = '127.0.0.1' } = {}) {
  const payload = raw !== undefined ? raw : body === undefined ? [] : [JSON.stringify(body)];
  const req = Readable.from(payload);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:4318' };
  if (origin) req.headers.origin = origin;
  req.socket = { remoteAddress: remote };
  let status = 0;
  let text = '';
  let headers = {};
  const res = {
    writeHead(code, head) { status = code; headers = head || {}; },
    end(chunk) { if (chunk !== undefined) text = String(chunk); },
  };
  await instance.handle(req, res);
  return { status, text, headers, data: text ? JSON.parse(text) : null };
}

test('approval surface route module loads with its factory', () => {
  assert.ok(mod, 'approvals route module must exist and load');
  assert.equal(typeof mod.createApprovalsRoute, 'function');
  assert.equal(typeof mod.canonicalJson, 'function');
  assert.equal(typeof mod.bindingDigest, 'function');
});

test('pending list exposes id, timestamps, preview, binding digest and state', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const first = approvalRequest({ preview: 'Publish widget alpha' });
  const second = approvalRequest({ job: { action: 'deploy', target: 'edge' } });
  seedRequest(root, first);
  seedRequest(root, second);
  const got = await call(instance);
  assert.equal(got.status, 200);
  assert.equal(got.headers['Cache-Control'], 'no-store');
  assert.equal(got.data.count, 2);
  const item = got.data.approvals.find((a) => a.id === first.id);
  assert.ok(item, 'seeded request must be listed');
  assert.deepEqual(Object.keys(item).sort(), ['binding', 'created_at', 'expired', 'expires_at', 'id', 'preview', 'state']);
  assert.equal(item.preview, 'Publish widget alpha');
  assert.equal(item.state, 'pending');
  assert.equal(item.expired, false);
  assert.match(item.binding, /^[0-9a-f]{64}$/);
  assert.equal(item.binding, mod.bindingDigest(first));
  const other = got.data.approvals.find((a) => a.id === second.id);
  assert.notEqual(other.binding, item.binding);
  assert.match(other.preview, /deploy/);
  const twin = makeRoute();
  seedRequest(twin.root, { ...first });
  const twinList = await call(twin.instance);
  assert.equal(twinList.data.approvals.find((a) => a.id === first.id).binding, item.binding);
  const empty = makeRoute();
  const emptyList = await call(empty.instance);
  assert.deepEqual(emptyList.data, { approvals: [], count: 0, generated_at: emptyList.data.generated_at });
});

test('detail exposes the job and refuses unknown or malformed identifiers', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const request = approvalRequest();
  seedRequest(root, request);
  const got = await call(instance, { url: [BASE, request.id].join('/') });
  assert.equal(got.status, 200);
  assert.deepEqual(Object.keys(got.data).sort(), ['binding', 'created_at', 'expired', 'expires_at', 'id', 'job', 'preview', 'state']);
  assert.deepEqual(got.data.job, request.job);
  assert.equal(got.data.binding, mod.bindingDigest(request));
  const missing = await call(instance, { url: [BASE, ['ghost', String(seq)].join('-')].join('/') });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, 'not_found');
  const traversed = await call(instance, { url: [BASE, encodeURIComponent('x/y')].join('/') });
  assert.equal(traversed.status, 400);
  assert.equal(traversed.data.error, 'invalid_request');
});

test('approve writes an atomic 0600 receipt and flips the listed state', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const request = approvalRequest();
  seedRequest(root, request);
  const binding = mod.bindingDigest(request);
  const sent = await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'approve', binding, note: ['looks', 'good', 'to', 'me'].join(' ') } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.ok, true);
  assert.equal(sent.data.state, 'approved');
  const receipt = sent.data.receipt;
  const file = path.join(root, 'decisions', request.id + '.json');
  assert.ok(existsSync(file), 'receipt file must exist');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), receipt);
  const fields = { ...receipt };
  delete fields.signature;
  const expected = createHmac('sha256', signingSeed).update(mod.canonicalJson(fields), 'utf8').digest('hex');
  assert.equal(receipt.signature, expected, 'signature must verify over the canonical binding document');
  const listed = await call(instance);
  assert.equal(listed.data.approvals.find((a) => a.id === request.id).state, 'approved');
  const detail = await call(instance, { url: [BASE, request.id].join('/') });
  assert.equal(detail.data.state, 'approved');
  assert.equal(detail.data.signature, receipt.signature);
  assert.equal(detail.data.note, 'looks good to me');
});

test('decline writes an unsigned decline record', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const request = approvalRequest();
  seedRequest(root, request);
  const sent = await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'decline' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.ok, true);
  assert.equal(sent.data.state, 'declined');
  const record = sent.data.record;
  assert.equal(record.decision, 'declined');
  assert.equal(record.signature, undefined);
  assert.equal(record.note, undefined);
  const file = path.join(root, 'decisions', request.id + '.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), record);
  const detail = await call(instance, { url: [BASE, request.id].join('/') });
  assert.equal(detail.data.state, 'declined');
  assert.equal(detail.data.decision, 'declined');
  assert.equal(detail.data.signature, undefined);
});

test('expired approvals are refused for both decisions', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const request = approvalRequest({ expires_at: new Date(Date.now() - 5000).toISOString() });
  seedRequest(root, request);
  const listed = await call(instance);
  assert.equal(listed.data.approvals.find((a) => a.id === request.id).expired, true);
  const binding = mod.bindingDigest(request);
  const approveAttempt = await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'approve', binding } });
  assert.equal(approveAttempt.status, 410);
  assert.equal(approveAttempt.data.error, 'approval_expired');
  const declineAttempt = await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'decline' } });
  assert.equal(declineAttempt.status, 410);
  assert.ok(!existsSync(path.join(root, 'decisions', request.id + '.json')));
});

test('binding mismatches and forged records are refused without writing', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const request = approvalRequest();
  seedRequest(root, request);
  const wrongEcho = hexDigest(['wrong', 'echo'].join(':'));
  const bad = await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'approve', binding: wrongEcho } });
  assert.equal(bad.status, 409);
  assert.equal(bad.data.error, 'binding_mismatch');
  assert.ok(!existsSync(path.join(root, 'decisions', request.id + '.json')));
  const forged = approvalRequest({ binding: hexDigest(['other', 'material'].join(':')) });
  seedRequest(root, forged);
  const forgedAttempt = await call(instance, { method: 'POST', url: decisionUrl(forged.id), body: { decision: 'approve', binding: mod.bindingDigest(forged) } });
  assert.equal(forgedAttempt.status, 409);
  assert.equal(forgedAttempt.data.error, 'binding_mismatch');
  const stray = approvalRequest();
  const strayName = ['stray', String(seq)].join('-');
  mkdirSync(path.join(root, 'pending'), { recursive: true });
  writeFileSync(path.join(root, 'pending', strayName + '.json'), JSON.stringify(stray, null, 2));
  const strayAttempt = await call(instance, { method: 'POST', url: decisionUrl(strayName), body: { decision: 'approve' } });
  assert.equal(strayAttempt.status, 409);
  assert.equal(strayAttempt.data.error, 'invalid_record');
});

test('a second decision is refused with the recorded state', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const first = approvalRequest();
  seedRequest(root, first);
  const binding = mod.bindingDigest(first);
  await call(instance, { method: 'POST', url: decisionUrl(first.id), body: { decision: 'approve', binding } });
  const again = await call(instance, { method: 'POST', url: decisionUrl(first.id), body: { decision: 'approve', binding } });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, 'already_decided');
  assert.equal(again.data.state, 'approved');
  const flip = await call(instance, { method: 'POST', url: decisionUrl(first.id), body: { decision: 'decline', binding } });
  assert.equal(flip.status, 409);
  assert.equal(flip.data.state, 'approved');
  const second = approvalRequest();
  seedRequest(root, second);
  await call(instance, { method: 'POST', url: decisionUrl(second.id), body: { decision: 'decline' } });
  const late = await call(instance, { method: 'POST', url: decisionUrl(second.id), body: { decision: 'approve', binding: mod.bindingDigest(second) } });
  assert.equal(late.status, 409);
  assert.equal(late.data.state, 'declined');
});

test('receipt shape follows the canonical field set and signature rules', async (t) => {
  if (!mod) return t.skip('route module absent');
  assert.equal(mod.canonicalJson({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(mod.canonicalJson({ k: ['café'] }), '{"k":["caf\\u00e9"]}');
  const { root, instance } = makeRoute();
  const withNote = approvalRequest();
  seedRequest(root, withNote);
  const sent = await call(instance, { method: 'POST', url: decisionUrl(withNote.id), body: { decision: 'approve', binding: mod.bindingDigest(withNote), note: ['ship', 'it'].join(' ') } });
  const receipt = sent.data.receipt;
  assert.deepEqual(Object.keys(receipt).sort(), ['approval_id', 'binding', 'decided_at', 'decision', 'note', 'signature']);
  assert.equal(receipt.approval_id, withNote.id);
  assert.equal(receipt.binding, mod.bindingDigest(withNote));
  assert.match(receipt.decided_at, /Z$/);
  assert.equal(receipt.decision, 'approved');
  assert.equal(receipt.note, 'ship it');
  assert.match(receipt.signature, /^[0-9a-f]{64}$/);
  const bare = approvalRequest();
  seedRequest(root, bare);
  const bareSent = await call(instance, { method: 'POST', url: decisionUrl(bare.id), body: { decision: 'approve', binding: mod.bindingDigest(bare) } });
  assert.deepEqual(Object.keys(bareSent.data.receipt).sort(), ['approval_id', 'binding', 'decided_at', 'decision', 'signature']);
  const spaced = approvalRequest();
  seedRequest(root, spaced);
  const spacedSent = await call(instance, { method: 'POST', url: decisionUrl(spaced.id), body: { decision: 'approve', note: '   ' } });
  assert.deepEqual(Object.keys(spacedSent.data.receipt).sort(), ['approval_id', 'binding', 'decided_at', 'decision', 'signature']);
});

test('decision journal stays complete and no temp files linger', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const approved = approvalRequest();
  const declined = approvalRequest();
  seedRequest(root, approved);
  seedRequest(root, declined);
  await call(instance, { method: 'POST', url: decisionUrl(approved.id), body: { decision: 'approve', binding: mod.bindingDigest(approved) } });
  await call(instance, { method: 'POST', url: decisionUrl(declined.id), body: { decision: 'decline' } });
  const entries = readdirSync(path.join(root, 'decisions')).sort();
  assert.deepEqual(entries, [approved.id + '.json', declined.id + '.json', 'journal.jsonl'].sort());
  for (const name of entries) {
    if (name === 'journal.jsonl') continue;
    assert.equal(statSync(path.join(root, 'decisions', name)).mode & 0o777, 0o600);
  }
  const journal = readFileSync(path.join(root, 'decisions', 'journal.jsonl'), 'utf8');
  const lines = journal.trim().split('\n');
  assert.equal(lines.length, 2);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(parsed.map((entry) => entry.decision).sort(), ['approved', 'declined']);
  assert.deepEqual(parsed.map((entry) => entry.approval_id).sort(), [approved.id, declined.id].sort());
  for (const entry of parsed) assert.match(entry.binding, /^[0-9a-f]{64}$/);
  await call(instance, { method: 'POST', url: decisionUrl(approved.id), body: { decision: 'decline' } });
  assert.equal(readFileSync(path.join(root, 'decisions', 'journal.jsonl'), 'utf8'), journal);
});

test('the signing secret is never returned or persisted', async (t) => {
  if (!mod) return t.skip('route module absent');
  const distinctSeed = ['vault', 'approval', String(Date.now())].join('-');
  const env = { ...process.env, [secretEnv]: distinctSeed };
  const { root, instance } = makeRoute({ env });
  const request = approvalRequest();
  seedRequest(root, request);
  const seen = [];
  seen.push(await call(instance));
  seen.push(await call(instance, { url: [BASE, request.id].join('/') }));
  seen.push(await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'approve', binding: mod.bindingDigest(request) } }));
  seen.push(await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'approve', binding: mod.bindingDigest(request) } }));
  seen.push(await call(instance, { url: [BASE, ['ghost', String(seq)].join('-')].join('/') }));
  const needles = [distinctSeed, secretEnv];
  for (const response of seen) {
    for (const needle of needles) {
      assert.ok(!response.text.includes(needle), 'secret material must never appear in a response');
    }
  }
  const stored = readFileSync(path.join(root, 'decisions', request.id + '.json'), 'utf8');
  for (const needle of needles) {
    assert.ok(!stored.includes(needle), 'secret material must never be persisted');
  }
  const receipt = seen[2].data.receipt;
  const fields = { ...receipt };
  delete fields.signature;
  assert.equal(receipt.signature, createHmac('sha256', distinctSeed).update(mod.canonicalJson(fields), 'utf8').digest('hex'));
});

test('transport guards and body validation refuse bad decisions', async (t) => {
  if (!mod) return t.skip('route module absent');
  const { root, instance } = makeRoute();
  const request = approvalRequest();
  seedRequest(root, request);
  const binding = mod.bindingDigest(request);
  const offsite = await call(instance, { remote: '203.0.113.9' });
  assert.equal(offsite.status, 403);
  assert.equal(offsite.data.error, 'loopback_only');
  const stealth = await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'approve', binding }, origin: null });
  assert.equal(stealth.status, 403);
  assert.equal(stealth.data.error, 'cross_origin_decision');
  const evil = await call(instance, { method: 'POST', url: decisionUrl(request.id), body: { decision: 'approve', binding }, origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  const wrongMethod = await call(instance, { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  const wrongDetail = await call(instance, { method: 'POST', url: [BASE, request.id].join('/') });
  assert.equal(wrongDetail.status, 405);
  const foreign = await call(instance, { url: '/api/other' });
  assert.equal(foreign.status, 404);
  for (const body of [
    { decision: 'maybe' },
    { decision: 'approve', binding, force: true },
    { decision: 'approve', binding, note: 'x'.repeat(3000) },
    { binding },
    {},
  ]) {
    const refused = await call(instance, { method: 'POST', url: decisionUrl(request.id), body });
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(refused.data.error, 'invalid_request');
  }
  const broken = await call(instance, { method: 'POST', url: decisionUrl(request.id), raw: '{not json' });
  assert.equal(broken.status, 400);
  assert.equal(broken.data.error, 'invalid_request');
  const oversized = await call(instance, { method: 'POST', url: decisionUrl(request.id), raw: 'x'.repeat(70000) });
  assert.equal(oversized.status, 413);
  const bareEnv = { ...process.env };
  delete bareEnv[secretEnv];
  const unlocked = makeRoute({ env: bareEnv });
  const hidden = approvalRequest();
  seedRequest(unlocked.root, hidden);
  const refused = await call(unlocked.instance, { method: 'POST', url: decisionUrl(hidden.id), body: { decision: 'approve', binding: mod.bindingDigest(hidden) } });
  assert.equal(refused.status, 503);
  assert.equal(refused.data.error, 'signing_unavailable');
  assert.ok(!existsSync(path.join(unlocked.root, 'decisions', hidden.id + '.json')));
  const quiet = await call(unlocked.instance, { method: 'POST', url: decisionUrl(hidden.id), body: { decision: 'decline' } });
  assert.equal(quiet.status, 200);
  assert.equal(quiet.data.state, 'declined');
});

test('the approvals root can come from the configured environment', async (t) => {
  if (!mod) return t.skip('route module absent');
  const root = freshRoot();
  const previous = process.env[rootEnv];
  process.env[rootEnv] = root;
  try {
    const instance = mod.createApprovalsRoute({ env: process.env, log: () => {} });
    const request = approvalRequest();
    seedRequest(root, request);
    const listed = await call(instance);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.count, 1);
    assert.equal(listed.data.approvals[0].id, request.id);
  } finally {
    if (previous === undefined) delete process.env[rootEnv];
    else process.env[rootEnv] = previous;
  }
});

test('the approvals page renders preview and digest without any secret', async (t) => {
  if (!mod) return t.skip('route module absent');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(path.join(here, '..', 'apps', 'rizzstack-approvals', 'index.html'), 'utf8');
  const script = readFileSync(path.join(here, '..', 'apps', 'rizzstack-approvals', 'app.js'), 'utf8');
  assert.match(html, /<script[^>]*src="\.\/app\.js"/);
  assert.match(html, /id="approval-list"/);
  assert.match(script, /function escapeHtml/);
  assert.match(script, /\/api\/approvals/);
  assert.match(script, /'decision'/);
  assert.match(script, /binding/);
  for (const source of [html, script]) {
    assert.ok(!source.includes(secretEnv), 'page must not reference the signing secret setting');
    assert.ok(!source.includes(signingSeed), 'page must not embed the signing seed');
  }
});
