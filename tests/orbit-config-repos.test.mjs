import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOrbitConfig, defaultOrbitConfig, normalizeRepoList, validateOrbitConfig } from '../server/orbit-config.mjs';

const repo = path.resolve(new URL('..', import.meta.url).pathname);

test('a new config watches no repositories', () => {
  assert.deepEqual(defaultOrbitConfig().observability, { repos: [] });
});

test('repo names are trimmed, validated and de-duplicated case-insensitively', () => {
  assert.deepEqual(normalizeRepoList([' octo/one ', 'Octo/One', 'a-b/c.d_e-f']), ['octo/one', 'a-b/c.d_e-f']);
  for (const bad of ['octo', 'octo/', '/one', 'octo/one/two', 'oc to/one', '-'.repeat(40) + '/x', 'octo/' + 'x'.repeat(101), 'octo/..', 'octo/.', 'https://github.com/octo/one', 42]) {
    assert.throws(() => normalizeRepoList([bad]), /owner\/name/, String(bad));
  }
  assert.throws(() => normalizeRepoList('octo/one'), /list/);
  assert.throws(() => normalizeRepoList(Array.from({ length: 51 }, (_, i) => `o/r${i}`)), /50/);
  assert.deepEqual(normalizeRepoList([]), []);
});

test('the config validates and persists the watch list', t => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-repos-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const store = createOrbitConfig({ runtimeDir, env: {} });
  const saved = store.save({ ...store.load(), observability: { repos: ['octo/one', 'OCTO/one', 'octo/two'] } });
  assert.deepEqual(saved.observability.repos, ['octo/one', 'octo/two']);
  assert.deepEqual(createOrbitConfig({ runtimeDir, env: {} }).load().observability.repos, ['octo/one', 'octo/two']);
  assert.throws(() => store.save({ ...store.load(), observability: { repos: ['nope'] } }), /owner\/name/);
  assert.throws(() => store.save({ ...store.load(), observability: { repos: [], extra: 1 } }), /unknown field/);
});

test('a config file without observability still loads with an empty list', () => {
  const doc = defaultOrbitConfig();
  delete doc.observability;
  assert.deepEqual(validateOrbitConfig(doc).observability, { repos: [] });
});

test('the schema documents observability.repos, empty by default', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repo, 'config/orbit-config.schema.json'), 'utf8'));
  const repos = schema.properties.observability.properties.repos;
  assert.deepEqual(repos.default, []);
  assert.equal(repos.maxItems, 50);
  assert.equal(repos.uniqueItems, true);
  assert.ok(new RegExp(repos.items.pattern).test('octo/one'));
  assert.ok(!new RegExp(repos.items.pattern).test('octo'));
});

test('no repository names are hardcoded in the product', () => {
  for (const file of ['server/orbit-config.mjs', 'server/onboarding-github.mjs', 'src/onboarding-github.ts', 'src/onboarding-repos-input.ts', 'config/orbit-config.schema.json']) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    assert.equal(/mojomast\/(workflow|bundlebees|orbitdesktop)/.test(text), false, file);
  }
});
