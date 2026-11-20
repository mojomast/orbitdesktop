// Approved test for cleanup P3-WB-HERMES: the Hermes plugin no longer offers
// Project Workbench (Kyle cut it in Phase 3). The orbit_workbench tool and the
// orbit_workspace 'arrangement' / 'workbench_setup' actions go; the Unix-socket
// transport the resources tool shares stays. Orbit's server side is already gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(join(root, p), 'utf8');

test('AC-001 Workbench plugin files are removed', () => {
  const left = ['hermes-plugin/workbench.py', 'hermes-plugin/workbench-tool-schema.json',
    'tests/test_workbench_native_runtime.py'].filter(f => existsSync(join(root, f)));
  assert.deepEqual(left, []);
});

test('AC-002 the plugin registers no Workbench tool or actions', () => {
  for (const f of ['hermes-plugin/__init__.py', 'hermes-plugin/resources.py', 'hermes-plugin/plugin.yaml', 'hermes-plugin/README.md']) {
    assert.doesNotMatch(read(f), /workbench/i, f);
  }
  const init = read('hermes-plugin/__init__.py');
  const actions = init.match(/^ACTIONS = \(([^)]*)\)/m);
  assert.ok(actions, 'ACTIONS tuple present');
  assert.doesNotMatch(actions[1], /arrangement|workbench_setup/);
  for (const kept of ['read', 'describe', 'preview', 'apply', 'history', 'checkpoint', 'restore']) assert.match(actions[1], new RegExp(`"${kept}"`));
  assert.doesNotMatch(read('scripts/workspace_control.py'), /arrangement|workbench/i);
  assert.doesNotMatch(read('scripts/bundle_hermes.py'), /hermes-plugin\/workbench/);
});

test('AC-003 the plugin still loads and its transport tests pass', () => {
  for (const t of ['tests/test_hermes_plugin.py', 'tests/test_command_adapters.py']) {
    const r = spawnSync('python3', [t], { cwd: root, encoding: 'utf8', timeout: 300000 });
    assert.equal(r.status, 0, `${t}\n${(r.stderr || '').slice(-2000)}`);
  }
});

test('AC-004 the workspace contract no longer advertises Workbench-bound actions', () => {
  for (const f of ['contracts/workspace-v1.mjs', 'contracts/workspace-v1.json', 'src/workspace-contract.generated.ts', 'docs/WORKSPACE_OPERATIONS.generated.md']) {
    assert.doesNotMatch(read(f), /workbench_setup|workbenchSetupRequest|arrangementRequests|recipe_preview/, f);
  }
  const r = spawnSync(process.execPath, ['scripts/generate-workspace-contract.mjs', '--check'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, (r.stderr || r.stdout || '').slice(-1500));
});
