import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqliteWorkspaceStore } from '../server/sqlite-workspace-store.mjs';

test('owner bundle retention CLI exercises dry-run without deleting a published artifact', t => {
  const root = fs.mkdtempSync('/tmp/opencode/orbit-retention-cli-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime'), build = path.join(root, 'build');
  fs.mkdirSync(build); fs.writeFileSync(path.join(build, 'index.html'), '<h1>Disposable retention fixture</h1>');
  const store = new SqliteWorkspaceStore(runtime); store.close();
  const published = spawnSync('python3', ['scripts/plugin_publish.py', build, '--id', 'retention-fixture', '--version', '1.0.0', '--title', 'Retention fixture', '--runtime', runtime], { encoding: 'utf8' });
  assert.equal(published.status, 0, published.stderr);
  const manifest = JSON.parse(published.stdout);
  const artifact = path.join(runtime, manifest.entry);
  const before = fs.readFileSync(artifact);
  const invoke = command => spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/workspace_bundles.mjs', command, '--root', runtime], { encoding: 'utf8' });
  const refresh = invoke('refresh'); assert.equal(refresh.status, 0, refresh.stderr);
  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = invoke('plan'); assert.equal(plan.status, 0, plan.stderr);
    const result = JSON.parse(plan.stdout);
    assert.equal(result.dry_run, true);
    assert.ok(JSON.stringify(result).includes(manifest.entry.split('/')[2]), 'Plan names the actual published fixture');
    assert.deepEqual(fs.readFileSync(artifact), before, 'Plan must preserve artifact bytes');
  }
  const unsupported = invoke('delete'); assert.notEqual(unsupported.status, 0);
  assert.deepEqual(fs.readFileSync(artifact), before);
});
