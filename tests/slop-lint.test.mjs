// Approved acceptance tests for scripts/slop-lint.mjs (report-only slop gate for JS/TS). Coordinator-written; do not edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanSource, countFindings, compare } from '../scripts/slop-lint.mjs';

const SCRIPT = resolve(new URL('../scripts/slop-lint.mjs', import.meta.url).pathname);
const rules = (src, path = 'a.ts') => [...new Set(scanSource(src, path).map((f) => f.rule))].sort();

test('AC-001 empty catch blocks are flagged, handled ones are not', () => {
  assert.deepEqual(rules('try { f(); } catch (e) {}'), ['empty-catch']);
  assert.deepEqual(rules('try { f(); } catch {\n  // ignore\n}'), ['empty-catch']);
  assert.deepEqual(rules('try { f(); } catch (e) { log(e); }'), []);
});

test('AC-002 `as any` is flagged in TS and ignored in strings', () => {
  assert.deepEqual(rules('const x = y as any;'), ['as-any']);
  assert.deepEqual(rules('const s = "as any";'), []);
});

test('AC-003 @ts-ignore is flagged but @ts-expect-error is not', () => {
  assert.deepEqual(rules('// @ts-ignore\nfoo();'), ['ts-ignore']);
  assert.deepEqual(rules('// @ts-expect-error reason\nfoo();'), []);
});

test('AC-004 findings carry path, 1-based line and rule', () => {
  const f = scanSource('a();\nb as any;\n', 'src/x.ts')[0];
  assert.deepEqual([f.path, f.line, f.rule], ['src/x.ts', 2, 'as-any']);
});

test('AC-005 counts group by file and rule', () => {
  const fs = [...scanSource('a as any; b as any;', 'a.ts'), ...scanSource('try{}catch(e){}', 'b.ts')];
  assert.deepEqual(countFindings(fs), { 'a.ts': { 'as-any': 2 }, 'b.ts': { 'empty-catch': 1 } });
});

test('AC-006 compare: equal passes, higher or new fails, lower is fixed', () => {
  const base = { 'a.ts': { 'as-any': 2 } };
  assert.deepEqual(compare(base, base), { added: [], fixed: [] });
  assert.equal(compare({ 'a.ts': { 'as-any': 3 } }, base).added.length, 1);
  assert.equal(compare({ 'n.ts': { 'as-any': 1 } }, {}).added.length, 1);
  assert.equal(compare({ 'a.ts': { 'as-any': 1 } }, base).fixed.length, 1);
});

function project() {
  const d = mkdtempSync(join(tmpdir(), 'slop-'));
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'a.ts'), 'const x = y as any;\n');
  return d;
}
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 60000 });

test('AC-007 baseline write then check passes', () => {
  const d = project();
  assert.equal(run(d, 'baseline', 'src', '--write', 'base.json').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'base.json'), 'utf8')), { 'src/a.ts': { 'as-any': 1 } });
  assert.equal(run(d, 'check', 'src', '--baseline', 'base.json').status, 0);
});

test('AC-008 a new finding fails and names file and rule', () => {
  const d = project();
  run(d, 'baseline', 'src', '--write', 'base.json');
  writeFileSync(join(d, 'src', 'b.ts'), 'try { f(); } catch (e) {}\n');
  const r = run(d, 'check', 'src', '--baseline', 'base.json');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /b\.ts/);
  assert.match(r.stdout, /empty-catch/);
});

test('AC-009 missing or malformed baseline fails closed (exit 2), even with --report-only', () => {
  const d = project();
  assert.equal(run(d, 'check', 'src', '--baseline', 'absent.json').status, 2);
  writeFileSync(join(d, 'bad.json'), '{nope');
  assert.equal(run(d, 'check', 'src', '--baseline', 'bad.json', '--report-only').status, 2);
});

test('AC-010 --report-only prints findings but exits 0', () => {
  const d = project();
  writeFileSync(join(d, 'base.json'), '{}');
  const r = run(d, 'check', 'src', '--baseline', 'base.json', '--report-only');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /as-any/);
});

test('AC-011 stale baseline entries fail unless --pass-on-unpruned; prune rewrites the file', () => {
  const d = project();
  run(d, 'baseline', 'src', '--write', 'base.json');
  writeFileSync(join(d, 'src', 'a.ts'), 'const x = 1;\n');
  assert.equal(run(d, 'check', 'src', '--baseline', 'base.json').status, 1);
  assert.equal(run(d, 'check', 'src', '--baseline', 'base.json', '--pass-on-unpruned').status, 0);
  assert.equal(run(d, 'prune', 'src', '--baseline', 'base.json').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'base.json'), 'utf8')), {});
});

test('AC-012 node_modules and dot directories are skipped', () => {
  const d = project();
  mkdirSync(join(d, 'src', 'node_modules'));
  mkdirSync(join(d, 'src', '.cache'));
  writeFileSync(join(d, 'src', 'node_modules', 'v.ts'), 'a as any;\n');
  writeFileSync(join(d, 'src', '.cache', 'w.ts'), 'a as any;\n');
  run(d, 'baseline', 'src', '--write', 'base.json');
  assert.deepEqual(JSON.parse(readFileSync(join(d, 'base.json'), 'utf8')), { 'src/a.ts': { 'as-any': 1 } });
});
