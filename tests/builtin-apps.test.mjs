import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installBuiltinApps, builtinVersion, builtinAppsRoot, BUILTIN_APPS } from '../server/builtin-apps.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-builtin-'));
const shipped = fs.readFileSync(path.join(builtinAppsRoot, 'grokbots', 'index.html'), 'utf8');
const sha = s => createHash('sha256').update(s).digest('hex');

test('shipped Grok Bots bundle is marked, self-contained and secret-free', () => {
  assert.equal(builtinVersion(shipped, 'grokbots') >= 1, true);
  assert.match(shipped, /new URL\('\/api\/grokbots-app',location\.href\)/);
  assert.doesNotMatch(shipped, /ts\.net|\b100\.\d+\.\d+\.\d+\b|sk-[A-Za-z0-9]{16}|xai-[A-Za-z0-9]{16}|ghp_[A-Za-z0-9]{20}|127\.0\.0\.1:\d+/);
  assert.equal(BUILTIN_APPS.some(app => app.slug === 'grokbots'), true);
});

test('installs into a fresh runtime and is idempotent', () => {
  const root = tmp();
  assert.deepEqual(installBuiltinApps({ runtimeRoot: root }).map(r => r.action), ['installed']);
  assert.equal(fs.readFileSync(path.join(root, 'apps/grokbots/index.html'), 'utf8'), shipped);
  assert.deepEqual(installBuiltinApps({ runtimeRoot: root }).map(r => r.action), ['current']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'apps')), ['grokbots']);
});

test('never overwrites local edits or a newer installed version', () => {
  const root = tmp(), file = path.join(root, 'apps/grokbots/index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<!doctype html><title>hand edited</title>');
  assert.equal(installBuiltinApps({ runtimeRoot: root })[0].action, 'kept');
  assert.equal(fs.readFileSync(file, 'utf8'), '<!doctype html><title>hand edited</title>');
  const newer = shipped.replace(/grokbots@\d+/, 'grokbots@9999');
  fs.writeFileSync(file, newer);
  assert.equal(installBuiltinApps({ runtimeRoot: root })[0].action, 'kept');
  assert.equal(fs.readFileSync(file, 'utf8'), newer);
});

test('upgrades older marked or known legacy builds and keeps the previous copy', () => {
  for (const old of [shipped.replace(/grokbots@\d+/, 'grokbots@0'), '<!doctype html>legacy']) {
    const root = tmp(), file = path.join(root, 'apps/grokbots/index.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, old);
    const apps = [{ slug: 'grokbots', legacyDigests: [sha('<!doctype html>legacy')] }];
    assert.equal(installBuiltinApps({ runtimeRoot: root, apps })[0].action, 'upgraded');
    assert.equal(fs.readFileSync(file, 'utf8'), shipped);
    assert.equal(fs.readFileSync(path.join(root, 'apps/grokbots.previous/index.html'), 'utf8'), old);
  }
});

test('the legacy digest matches the unmarked build of the shipped file', () => {
  const unmarked = shipped.replace(/<meta name="orbit-builtin-app" content="grokbots@1">/, '');
  if (builtinVersion(shipped, 'grokbots') === 1) assert.equal(BUILTIN_APPS[0].legacyDigests.includes(sha(unmarked)), true);
});
