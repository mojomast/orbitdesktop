// RED: Orbit validates the brief it POSTs (report-only) and maps launcher states
// through rizzstack.attempt/1, keeping its own client state.
//
// The vendored validator beside this test is the frozen B3 artifact and is a
// read-only given. The implementer must not edit this test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createLocalWorkers } from '../server/local-workers.mjs';
import { validateBrief, validateAttempt } from '../validators/js/rizzstack-validators.mjs';

const VALIDATOR = new URL('../validators/js/rizzstack-validators.mjs', import.meta.url);
const VALIDATOR_SHA256 = '95611750bbe52a6e889ef080abf3c90b65e74a22eb27cc735fdfe0ab78b04d7a';

function v1Brief(overrides = {}) {
  return {
    schema: 'rizzstack.brief/1',
    objective: 'Dispatch a brief that names the worker contract.',
    project: 'demo',
    source_rev: 'a'.repeat(40),
    assigned_files: ['server/local-workers.mjs'],
    acceptance: { criteria: ['the attempt records the brief problems'] },
    risk: { tier: 'low' },
    ...overrides,
  };
}

async function fakeLauncher(remoteState = 'running') {
  const seen = { posts: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const send = (code, value) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'POST' && req.url === '/v1/attempts') {
        seen.posts += 1;
        seen.bodies.push(JSON.parse(body));
        return send(201, { attempt_id: JSON.parse(body).attempt_id, state: remoteState, detail: 'fake' });
      }
      const match = req.url.match(/^\/v1\/attempts\/([^/?]+)/);
      if (req.method === 'GET' && match) return send(200, { attempt_id: match[1], state: remoteState, detail: 'fake' });
      return send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function adapter(url, extra = {}) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), 'lw-b5a-'));
  return createLocalWorkers({
    runtimeDir,
    launcherUrl: url,
    launcherToken: 'a'.repeat(64),
    board: { update: async () => {} },
    maxConcurrent: 1,
    retries: 0,
    ...extra,
  });
}

test('valid brief passes validation and is posted unchanged with no problems', async () => {
  const F = await fakeLauncher('running');
  try {
    const lw = adapter(F.url);
    const brief = v1Brief();
    const a = await lw.create({ taskId: 'ok', group: 'g', brief });
    assert.equal(F.seen.posts, 1);
    const { input_manifest_sha256, ...posted } = F.seen.bodies[0].brief;
    assert.deepEqual(posted, brief, 'a valid brief is POSTed unchanged');
    assert.match(input_manifest_sha256, /^[a-f0-9]{64}$/);
    const row = lw.get(a.attempt_id);
    assert.deepEqual(row.brief_problems, [], 'the attempt row records an empty problem list');
  } finally {
    await F.close();
  }
});

test('an invalid brief is still dispatched with its problems recorded', async () => {
  const F = await fakeLauncher('running');
  try {
    const lw = adapter(F.url);
    const brief = v1Brief();
    delete brief.risk;
    const a = await lw.create({ taskId: 'bad', group: 'g', brief });
    assert.equal(F.seen.posts, 1, 'report-only: the invalid brief is still dispatched');
    const row = lw.get(a.attempt_id);
    assert.ok(Array.isArray(row.brief_problems), 'the attempt row records brief_problems');
    assert.ok(row.brief_problems.length > 0);
    assert.ok(row.brief_problems.some((problem) => problem.includes('risk')), row.brief_problems.join('\n'));
  } finally {
    await F.close();
  }
});

test('an unknown remote state never replaces client state and keeps the raw state', async () => {
  const F = await fakeLauncher('mystery');
  try {
    const lw = adapter(F.url);
    const a = await lw.create({ taskId: 'unknown', group: 'g', brief: v1Brief() });
    const row = lw.get(a.attempt_id);
    assert.equal(row.state, 'unknown');
    assert.equal(row.remote_state, 'mystery');
    assert.ok(row.history.some((entry) => entry.state === 'dispatching'), 'the client lifecycle history is kept');
  } finally {
    await F.close();
  }
});

test('the vendored validator is the frozen copy and exports both validators', () => {
  const bytes = readFileSync(VALIDATOR);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), VALIDATOR_SHA256);
  assert.equal(typeof validateBrief, 'function');
  assert.equal(typeof validateAttempt, 'function');
  assert.deepEqual(validateBrief(v1Brief()), []);
  const invalid = v1Brief();
  delete invalid.risk;
  assert.ok(validateBrief(invalid).length > 0);
});
