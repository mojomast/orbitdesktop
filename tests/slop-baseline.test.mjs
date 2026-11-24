// Approved acceptance tests: report-only slop-lint baseline adopted in orbitdesktop. Coordinator-written; do not edit.
// Deliberately does NOT fail on new findings: adoption is report-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const BASE = resolve(ROOT, 'slop-baseline.json');
const DIRS = ['src', 'server', 'scripts', 'packages'];

test('AC-001 baseline exists, is a non-empty object of per-file rule counts', () => {
  assert.ok(existsSync(BASE), 'slop-baseline.json missing at repo root');
  const data = JSON.parse(readFileSync(BASE, 'utf8'));
  assert.equal(typeof data, 'object');
  const files = Object.keys(data);
  assert.ok(files.length > 0);
  for (const f of files) {
    for (const [rule, n] of Object.entries(data[f])) {
      assert.ok(Number.isInteger(n) && n > 0, `${f} ${rule}`);
    }
  }
});

test('AC-002 paths are repo-relative posix and not machine specific', () => {
  const text = readFileSync(BASE, 'utf8');
  for (const needle of ['/home/', '/workspace/', 'C:\\', '\\\\', '../']) assert.ok(!text.includes(needle), needle);
  for (const f of Object.keys(JSON.parse(text))) assert.ok(DIRS.some((d) => f.startsWith(d + '/')), f);
});

test('AC-003 check --report-only against the baseline exits 0 at adoption', () => {
  const r = spawnSync(process.execPath, ['scripts/slop-lint.mjs', 'check', ...DIRS, '--baseline', 'slop-baseline.json',
    '--report-only', '--pass-on-unpruned'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, (r.stdout || '').slice(-600) + (r.stderr || '').slice(-300));
});
