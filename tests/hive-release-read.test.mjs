import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {validateRelease, renderReleaseObservation} from '../apps/rizzstack-hive/release-provider.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts', 'hive_release_read.py');
const env = {
  PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Hive Read', GIT_AUTHOR_EMAIL: 'hive@example.invalid',
  GIT_COMMITTER_NAME: 'Hive Read', GIT_COMMITTER_EMAIL: 'hive@example.invalid',
};
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, {cwd, env, encoding: 'utf8'}).trim();

function checkout(directory, file, text) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  git(directory, 'init', '-q', '-b', 'main');
  writeFileSync(join(directory, file), text);
  git(directory, 'add', file);
  git(directory, 'commit', '-q', '-m', 'fixture');
  return git(directory, 'rev-parse', 'HEAD');
}

function dom() {
  const view = {}; view.parent = view;
  const doc = {defaultView: view, createElement(tag) {
    return {ownerDocument: doc, tag, children: [], textContent: '', className: '',
      append(...els) { this.children.push(...els); }, replaceChildren(...els) { this.children = els; }};
  }};
  const root = doc.createElement('section');
  const walk = n => [n, ...n.children.flatMap(walk)];
  return {root, text: () => walk(root).map(el => el.textContent).join(' '), all: () => walk(root)};
}

test('local deployment revisions are read once, unknown stays unknown, and the report validates and renders', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'hive-release-read-'));
  t.after(() => rmSync(temporary, {recursive: true, force: true}));
  const deployment = join(temporary, 'deployment'), reports = join(temporary, 'reports');
  mkdirSync(deployment, {mode: 0o700});
  mkdirSync(reports, {mode: 0o700});
  const workflow = checkout(join(deployment, 'workflow'), 'README.md', 'workflow\n');
  const orbit = checkout(join(deployment, 'orbitdesktop'), 'README.md', 'orbit\n');

  const run = spawnSync('python3', [script, '--staging-dir', reports, '--local', '--deployment-root', deployment],
    {env, encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(readFileSync(join(reports, 'release.json'), 'utf8'));

  assert.equal(report.schema, 'hive-release-read/1');
  assert.deepEqual(report.repos.map(r => r.repo),
    ['mojomast/workflow', 'mojomast/bundlebees', 'mojomast/hyvv', 'mojomast/orbitdesktop']);
  assert.equal(report.repos[0].main.sha, workflow);
  assert.equal(report.repos[3].main.sha, orbit);
  for (const index of [1, 2]) {
    assert.equal(report.repos[index].main.sha, null, 'an absent checkout is never guessed');
    assert.equal(report.repos[index].main.checks, null);
  }
  assert.ok(report.repos.every(r => r.prs.length === 0 && r.main.checks === null));
  assert.equal(validateRelease(report), true);

  const d = dom();
  renderReleaseObservation(d.root, report);
  assert.ok(d.text().includes(workflow.slice(0, 12)));
  assert.ok(d.text().includes(orbit.slice(0, 12)));
  assert.match(d.text(), /Revision unknown/);
  assert.match(d.text(), /No check-run evidence/);
  assert.match(d.text(), /2 of 4 enrolled main refs observed/);
  for (const link of d.all().filter(n => n.tag === 'a'))
    assert.match(link.href, /^https:\/\/github\.com\/mojomast\/(workflow|orbitdesktop)\/commit\/[a-f0-9]{40}$/);

  // The producer is strictly read-only: HEAD and the worktree are untouched.
  assert.equal(git(join(deployment, 'workflow'), 'rev-parse', 'HEAD'), workflow);
  assert.equal(git(join(deployment, 'workflow'), 'status', '--porcelain'), '');
});

test('a malformed or tampered report is refused instead of rendered', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'hive-release-tamper-'));
  t.after(() => rmSync(temporary, {recursive: true, force: true}));
  const deployment = join(temporary, 'deployment'), reports = join(temporary, 'reports');
  mkdirSync(deployment, {mode: 0o700});
  mkdirSync(reports, {mode: 0o700});
  const workflow = checkout(join(deployment, 'workflow'), 'README.md', 'workflow\n');
  assert.equal(spawnSync('python3', [script, '--staging-dir', reports, '--local', '--deployment-root', deployment],
    {env, encoding: 'utf8'}).status, 0);
  const report = JSON.parse(readFileSync(join(reports, 'release.json'), 'utf8'));

  const mutations = [
    r => { r.repos[0].main.sha = 'HEAD'; },
    r => { r.repos[0].main.sha = '0'.repeat(40); },
    r => { r.repos[0].main.sha = workflow.slice(0, 39); },
    r => { r.repos[0].main.checks = {at: r.repos[0].at, sha: workflow, total: 0, sampled: 0,
      truncated: false, success: 0, failure: 0, neutral: 0, pending: 0, skipped: 0}; },
    r => { r.repos[0].repo = 'other/workflow'; },
    r => { r.repos[0].repoId++; },
    r => { r.repos[0].prs.push({number: 91}); },
    r => { r.authority = 'PROMOTE'; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(report);
    mutate(value);
    assert.equal(validateRelease(value), false, mutate.toString());
  }

  const d = dom();
  renderReleaseObservation(d.root, report);
  assert.ok(d.text().includes(workflow.slice(0, 12)));
  const tampered = structuredClone(report);
  tampered.repos[0].main.sha = 'not-a-commit';
  renderReleaseObservation(d.root, tampered);
  assert.match(d.text(), /Current release observation unavailable/);
  assert.ok(!d.text().includes(workflow.slice(0, 12)));
  assert.ok(!d.text().includes('not-a-commit'));
});
