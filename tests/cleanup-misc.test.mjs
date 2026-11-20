// Phase 2 (rizzstack cleanup): experiments, the unused zod dependency and the superseded plan.
// AC-001: experiments/ (the docking spikes) and the two spike-only browser gates are gone.
//         Product docking (src/docking-*.ts, dockview-core) stays.
// AC-002: zod is no longer a direct dependency (nothing in the tree imports it).
// AC-003: docs/orbit-decomposition.md opens with a SUPERSEDED notice pointing at the cleanup
//         plan, and its PLAN-ONLY guard (tests/test_orbit_decomposition.py) is retired.
// AC-004: the guard's still-true checks survive here: core routes stay wired in server/index.mjs
//         and the deployed Observatory surfaces exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const exists = rel => fs.existsSync(path.join(root, rel));

test('AC-001 docking spikes are gone, product docking stays', () => {
  assert.equal(exists('experiments'), false);
  assert.equal(exists('tests/orbit-docking.browser.py'), false);
  assert.equal(exists('tests/docking-adapters.browser.py'), false);
  for (const rel of ['src/docking-renderer.ts', 'src/docking-placement.ts', 'src/docking.css']) assert.ok(exists(rel), rel);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['dockview-core']);
});

test('AC-002 zod is not a direct dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal((pkg.dependencies || {}).zod, undefined);
  assert.equal((pkg.devDependencies || {}).zod, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages[''].dependencies.zod, undefined);
});

test('AC-003 the decomposition plan is marked superseded and its plan-only guard retired', () => {
  const head = fs.readFileSync(path.join(root, 'docs/orbit-decomposition.md'), 'utf8').split('\n').slice(0, 8).join('\n');
  assert.match(head, /SUPERSEDED/);
  assert.match(head, /cleanup plan/i);
  assert.equal(exists('tests/test_orbit_decomposition.py'), false);
});

test('AC-004 core routes stay wired and the Observatory surfaces exist', () => {
  const index = fs.readFileSync(path.join(root, 'server/index.mjs'), 'utf8');
  for (const route of ['/api/workspace', '/api/agent', '/api/terminal', '/api/health', '/api/auth', '/api/managed-terminals', '/api/grokbots-app'])
    assert.ok(index.includes(`'${route}`) || index.includes(`"${route}`) || index.includes('`' + route), `${route} not wired`);
  for (const rel of ['apps/rizzstack-observatory/index.html', 'apps/rizzstack-observatory/app.js', 'apps/rizzstack-observatory/styles.css'])
    assert.ok(exists(rel), rel);
});
