import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {observeLocalRelease} from '../server/hive-reports.mjs';
import {validateRelease} from '../apps/rizzstack-hive/release-provider.js';

const orbitRoot = fileURLToPath(new URL('..', import.meta.url));
const genv = {PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Hive', GIT_AUTHOR_EMAIL: 'hive@example.invalid', GIT_COMMITTER_NAME: 'Hive', GIT_COMMITTER_EMAIL: 'hive@example.invalid'};
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, {cwd, env: genv, encoding: 'utf8'}).trim();

// A deployment root shaped like a live checkout: scripts/ from this tree plus its own .git.
function deployment(t) {
  const base = mkdtempSync(join(tmpdir(), 'hra-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const root = join(base, 'orbitdesktop'), dir = join(base, 'reports');
  mkdirSync(join(root, 'scripts'), {recursive: true});
  writeFileSync(join(root, 'scripts', 'hive_release_read.py'), readFileSync(join(orbitRoot, 'scripts', 'hive_release_read.py')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  return {root, dir, head: () => git(root, 'rev-parse', 'HEAD')};
}
const read = dir => JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
const orbitSha = report => report.repos.find(r => r.repo === 'mojomast/orbitdesktop').main.sha;

test('startup writes a validating revision-only report and refreshes its own report on the next start', t => {
  const d = deployment(t);
  assert.equal(observeLocalRelease({dir: d.dir, repoRoot: d.root, env: {PATH: '/usr/bin:/bin'}}), 'written');
  const first = read(d.dir);
  assert.equal(validateRelease(first), true);
  assert.equal(orbitSha(first), d.head());
  assert.ok(first.repos.every(r => r.prs.length === 0 && r.main.checks === null));
  writeFileSync(join(d.root, 'next.txt'), 'x\n');
  git(d.root, 'add', 'next.txt');
  git(d.root, 'commit', '-q', '-m', 'two');
  assert.equal(observeLocalRelease({dir: d.dir, repoRoot: d.root, env: {PATH: '/usr/bin:/bin'}}), 'written');
  assert.equal(orbitSha(read(d.dir)), d.head(), 'a redeploy must not keep showing the previous revision');
});

test('an operator-published or unreadable report is never overwritten', t => {
  const d = deployment(t);
  mkdirSync(d.dir, {mode: 0o700});
  const operator = JSON.stringify({schema: 'hive-release-read/1', repos: [{prs: [{number: 1}], main: {checks: {}}}]});
  writeFileSync(join(d.dir, 'release.json'), operator);
  assert.equal(observeLocalRelease({dir: d.dir, repoRoot: d.root, env: {}}), 'kept');
  assert.equal(readFileSync(join(d.dir, 'release.json'), 'utf8'), operator);
  writeFileSync(join(d.dir, 'release.json'), '{not json');
  assert.equal(observeLocalRelease({dir: d.dir, repoRoot: d.root, env: {}}), 'kept');
  assert.equal(readFileSync(join(d.dir, 'release.json'), 'utf8'), '{not json');
});

test('off without a configured absolute directory or when disabled; the child gets no ambient secrets', t => {
  const d = deployment(t);
  const calls = [];
  const spawn = (cmd, args, options) => { calls.push(options); return {status: 0}; };
  assert.equal(observeLocalRelease({dir: undefined, repoRoot: d.root, env: {}, spawn}), 'off');
  assert.equal(observeLocalRelease({dir: 'relative/reports', repoRoot: d.root, env: {}, spawn}), 'off');
  assert.equal(observeLocalRelease({dir: d.dir, repoRoot: d.root, env: {ORBIT_HIVE_RELEASE_AUTO: '0'}, spawn}), 'off');
  assert.equal(calls.length, 0);
  assert.equal(observeLocalRelease({dir: d.dir, repoRoot: d.root,
    env: {PATH: '/usr/bin:/bin', ORBIT_TOKEN: 'secret-orbit', GITHUB_TOKEN: 'secret-gh', HOME: '/home/x'}, spawn}), 'written');
  assert.deepEqual(Object.keys(calls[0].env).sort(), ['HOME', 'PATH', 'PYTHONDONTWRITEBYTECODE']);
  assert.equal(observeLocalRelease({dir: d.dir, repoRoot: d.root, env: {}, spawn: () => ({status: 1})}), 'failed');
});

test('a staging directory that is not private makes the producer refuse (fail closed)', t => {
  const d = deployment(t);
  mkdirSync(d.dir, {mode: 0o755});
  chmodSync(d.dir, 0o755);
  assert.equal(observeLocalRelease({dir: d.dir, repoRoot: d.root, env: {PATH: '/usr/bin:/bin'}}), 'failed');
});
