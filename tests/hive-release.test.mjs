import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { release, checksForTuple } from '../apps/rizzstack-hive/release.js';

const tuple = {
  workflow: 'badc5591d7e5d4985fe829c3a1e39b2ee0e4c0f6',
  bundlebees: '83ffa37811225deb8f06518b2ef997a021b63bd2',
  hyvv: '35a4d0cf9473b3d30a2b8eb0b71ab9d10b6509a8',
  orbitdesktop: '43a3cb61b8e5f9822c3bcc1431afe850b8ca0c3e',
};

test('release tile retains the historical software gate, not a deployment receipt', () => {
  assert.deepEqual(release.tuple, tuple);
  assert.equal(release.at, '2026-11-17T22:41:57.149960+00:00');
  assert.match(release.evidenceUrl, /^https:\/\/github\.com\/mojomast\/workflow\/blob\/2d45b5958abed555b910cbddd5bdfe5e8b22144d\/evidence\/rails-rc\/release\/DECISION\.md$/);
  assert.equal(release.decision, 'HOLD');
  assert.equal(release.tests, 665);
  assert.equal(release.checks, 64);
  assert.equal(release.receiver, 'pending');
  assert.equal(release.loaded, 'unverified');
  assert.match(release.canary, /blocked.*not run/i);
  assert.deepEqual([release.defaultEventsMs, release.indexedEventsMs, release.priorIndexedEventsMs], [1614.091, 499.716, 670.749]);
  const notes = release.notes.join(' ');
  assert.match(notes, /Windows CI passed/);
  assert.match(notes, /historical/i);
  assert.match(notes, /unqualified/i);
  assert.match(notes, /6058fa382132dfb728908e47ddb519fc15a3d9241a21bd083b717482a9e3c585/);
  assert.doesNotMatch(JSON.stringify(release), /\/var\/|\/home\/|\/tmp\/|BEGIN PRIVATE/);
});

test('reported checks apply to precisely the four observed heads', () => {
  assert.equal(checksForTuple(tuple), 64);
  for (const other of [null, {}, { ...tuple, hyvv: 'f'.repeat(40) }, { ...tuple, extra: true }]) {
    assert.equal(checksForTuple(other), null);
  }
});

test('importer refuses modified pinned bytes before producing a module', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'evidence', 'rails-rc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'release.json'), JSON.stringify(tuple)); // same values, different bytes
  const script = fileURLToPath(new URL('../scripts/hive-release-evidence.py', import.meta.url));
  const r = spawnSync('python3', ['-B', script, root], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /digest mismatch: release\.json/);
  assert.equal(r.stdout, '');
});
