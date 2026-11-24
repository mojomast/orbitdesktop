// Rizzstack cleanup, review fixes (Nov 18 2026).
// AC-001: a stray server/mobile-proxy.mjs left in a deploy directory does not change the build
//         identity (the Doctor definition excludes it); both identity helpers agree.
// AC-002: the docking docs and architecture docs no longer point at deleted paths.
// AC-003: docs/orbit-inventory.json no longer lists the deleted modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {serviceBuildId} from '../scripts/release_manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const deleted = ['experiments/docking', 'experiments/orbit-docking', 'tests/orbit-docking.browser.py',
  'tests/docking-adapters.browser.py', 'server/host-api.mjs', 'server/approvals-route.mjs',
  'server/ssh-bootstrap.mjs', 'server/mobile-proxy.mjs', 'server/mobile-security.mjs', 'server/workspace-store.mjs'];

test('AC-001 a stray mobile-proxy.mjs does not change the build identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-identity-'));
  try {
    for (const sub of ['server', 'contracts']) fs.mkdirSync(path.join(dir, sub));
    fs.writeFileSync(path.join(dir, 'server', 'index.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(dir, 'contracts', 'a.mjs'), 'export const a = 1;\n');
    const releaseBefore = serviceBuildId(dir);
    fs.writeFileSync(path.join(dir, 'server', 'mobile-proxy.mjs'), 'stray leftover\n');
    assert.equal(serviceBuildId(dir), releaseBefore, 'a stray mobile-proxy.mjs must not change the build identity');
    fs.writeFileSync(path.join(dir, 'server', 'other.mjs'), 'real change\n');
    assert.notEqual(serviceBuildId(dir), releaseBefore, 'other server files still count');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('AC-002 docs do not point at deleted paths', () => {
  const hits = [];
  for (const doc of ['docs/ARCHITECTURE.md', 'docs/ORBIT_DOCKING_SPIKE.md', 'docs/DOCKING_EVALUATION.md', 'docs/ORBIT_EVOLUTION_HANDOFF.md']) {
    const text = fs.readFileSync(path.join(root, doc), 'utf8');
    for (const gone of deleted) if (text.includes(gone)) hits.push(`${doc}: ${gone}`);
  }
  assert.deepEqual(hits, []);
});

test('AC-003 the inventory no longer lists deleted modules', () => {
  const text = fs.readFileSync(path.join(root, 'docs/orbit-inventory.json'), 'utf8');
  const inventory = JSON.parse(text);
  for (const name of ['host-api.mjs', 'approvals-route.mjs', 'ssh-bootstrap.mjs', 'mobile-proxy.mjs', 'mobile-security.mjs', 'workspace-store.mjs'])
    assert.equal(Object.hasOwn(inventory.server_modules, name), false, `${name} still in server_modules`);
  for (const gone of deleted) assert.equal(text.includes(gone), false, `${gone} still in the inventory`);
  assert.equal(inventory.counts.server_modules, Object.keys(inventory.server_modules).length);
});
