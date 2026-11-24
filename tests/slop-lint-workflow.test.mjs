// Acceptance tests for .github/workflows/slop-lint.yml in orbitdesktop (same shape as the other repos' slop-lint job).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const WF = resolve(new URL('../.github/workflows/slop-lint.yml', import.meta.url).pathname);
const text = () => { assert.ok(existsSync(WF), 'workflow file missing'); return readFileSync(WF, 'utf8'); };

test('AC-001 triggers: pull_request and push to main only, no pull_request_target', () => {
  const t = text();
  assert.match(t, /^on:/m);
  assert.ok(t.includes('pull_request:'));
  assert.match(t, /push:\s*\n\s*branches:\s*\[main\]/);
  assert.ok(!t.includes('pull_request_target'));
});

test('AC-002 permissions are read-only', () => {
  const m = text().match(/^permissions:\s*\n((?:[ \t]+.*\n)+)/m);
  assert.ok(m, 'top-level permissions required');
  assert.ok(m[1].includes('contents: read'));
  assert.ok(!/write/.test(m[1]));
});

test('AC-003 every action is pinned to a full SHA', () => {
  const uses = [...text().matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 2);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});

test('AC-004 stable job name slop-lint, bounded, Node 22', () => {
  const t = text();
  assert.match(t, /^name:\s*slop-lint\s*$/m);
  assert.match(t, /^  slop-lint:\s*\n    name:\s*slop-lint\s*$/m);
  const m = t.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(m && Number(m[1]) <= 10);
  assert.match(t, /node-version:\s*['"]?22['"]?/);
});

test('AC-005 runs the repo script against the committed baseline over the baseline dirs', () => {
  const t = text();
  assert.ok(t.includes('node scripts/slop-lint.mjs check src server scripts packages'));
  assert.ok(t.includes('--baseline slop-baseline.json'));
  assert.ok(t.includes('GITHUB_STEP_SUMMARY'));
  assert.ok(!/pip install|npm (ci|install)|curl /.test(t));
  assert.ok(!t.includes('secrets.'));
});

test('AC-006 blocking ratchet: fails only on new findings (--pass-on-unpruned), no report-only, no continue-on-error', () => {
  const t = text();
  assert.ok(t.includes('--pass-on-unpruned'));
  assert.ok(!t.includes('--report-only'));
  assert.ok(!t.includes('continue-on-error'));
  assert.match(t, /shell:\s*bash/);
});

test('AC-007 the baseline is owned via CODEOWNERS', () => {
  const co = readFileSync(resolve(new URL('../.github/CODEOWNERS', import.meta.url).pathname), 'utf8');
  assert.match(co, /^\/slop-baseline\.json\s+@mojomast\s*$/m);
});
