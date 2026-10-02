// Table-driven tests for the dependency-free Workbench CI scope detector.
// The detector decides whether the deferred Workbench suites run: full gate for
// release validation, weekly/manual runs and failed diffs; path gate otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isWorkbenchPath, shouldRunWorkbench} from '../scripts/workbench_ci_scope.mjs';

const SHA = 'a'.repeat(40);
const ZERO = '0'.repeat(40);

test('isWorkbenchPath matches the deferred Workbench surface', () => {
  const cases = [
    ['src/workbench-execution.ts', true],
    ['src/workbench-contract.generated.ts', true],
    ['src/pane-workbench.css', true],
    ['src/project-workbench.ts', true],
    ['src/candidate-diff-adapter.ts', true],
    ['server/workbench.mjs', true],
    ['server/sqlite-workspace-store.mjs', true],
    ['server/workspace-arrangements.mjs', true],
    ['tests/workspace-arrangements-retention.test.mjs', true],
    ['tests/workspace-arrangements.browser.py', true],
    ['server/workbench-legacy-state.mjs', true],
    ['server/project-tools.mjs', true],
    ['server/project-files.mjs', true],
    ['contracts/workbench-v1.mjs', true],
    ['contracts/project-tools-v1.mjs', true],
    ['tests/workbench-evaluation/cases.json', true],
    ['tests/workbench_setup_fixture.py', true],
    ['tests/project-workbench.browser.py', true],
    ['hermes-plugin/workbench.py', true],
    ['hermes-plugin/workbench-tool-schema.json', true],
    ['scripts/generate-workbench-contract.mjs', true],
    ['scripts/workbench_ci_scope.mjs', true],
    ['.github/workflows/workbench.yml', true],
    ['tests/browser_workspace.py', true],
    // Unrelated paths must not widen the deep gate.
    ['server/workspace-store.mjs', false],
    ['server/project-registry.mjs', false],
    ['src/agent-chat.ts', false],
    ['src/project-tool-host.ts', false],
    ['tests/workbenchish.test.mjs', false],
    ['docs/PROJECT_WORKBENCH.md', false],
    ['scripts/generate-workspace-contract.mjs', false],
    ['.github/workflows/test.yml', false],
  ];
  for (const [file, expected] of cases) {
    assert.equal(isWorkbenchPath(file), expected, file);
  }
});

test('shouldRunWorkbench table: full gate versus path gate', () => {
  const cases = [
    {name: 'weekly schedule runs the full gate', input: {event: 'schedule'}, expected: true},
    {name: 'manual dispatch runs the full gate', input: {event: 'workflow_dispatch'}, expected: true},
    {name: 'release branch push runs the full gate', input: {event: 'push', ref: 'refs/heads/release/0.3.1'}, expected: true},
    {name: 'release tag runs the full gate', input: {event: 'push', ref: 'refs/tags/hermes-plugin-v0.3.1'}, expected: true},
    {name: 'PR into a release branch runs the full gate', input: {event: 'pull_request', ref: 'refs/pull/7/merge', baseRef: 'release/0.3.1', changedFiles: []}, expected: true},
    {name: 'PR into a release branch runs even with unrelated files', input: {event: 'pull_request', baseRef: 'release/0.2.7', changedFiles: ['docs/HERMES.md']}, expected: true},
    {name: 'PR with a Workbench source change runs', input: {event: 'pull_request', baseRef: 'main', changedFiles: ['src/workbench-execution.ts']}, expected: true},
    {name: 'PR with server/workbench.mjs runs', input: {event: 'pull_request', baseRef: 'main', changedFiles: ['server/workbench.mjs']}, expected: true},
    {name: 'PR with the Workbench browser fixture runs', input: {event: 'pull_request', baseRef: 'main', changedFiles: ['tests/project-workbench.browser.py']}, expected: true},
    {name: 'PR with the Workbench generator runs', input: {event: 'pull_request', baseRef: 'main', changedFiles: ['scripts/generate-workbench-contract.mjs']}, expected: true},
    {name: 'PR with the Workbench workflow runs', input: {event: 'pull_request', baseRef: 'main', changedFiles: ['.github/workflows/workbench.yml']}, expected: true},
    {name: 'PR with an unrelated file skips the deep gate', input: {event: 'pull_request', baseRef: 'main', changedFiles: ['src/agent-chat.ts', 'docs/HERMES.md']}, expected: false},
    {name: 'push with a Workbench change runs', input: {event: 'push', ref: 'refs/heads/main', before: SHA, changedFiles: ['server/workbench-hermes.mjs']}, expected: true},
    {name: 'push with only unrelated files skips', input: {event: 'push', ref: 'refs/heads/main', before: SHA, changedFiles: ['README.md']}, expected: false},
    {name: 'new push branch with no previous commit runs the full gate', input: {event: 'push', ref: 'refs/heads/feature', before: '', changedFiles: []}, expected: true},
    {name: 'new push branch with zero before sha runs the full gate', input: {event: 'push', ref: 'refs/heads/feature', before: ZERO, changedFiles: []}, expected: true},
    {name: 'a removed Workbench file is still listed and triggers', input: {event: 'push', ref: 'refs/heads/main', before: SHA, changedFiles: ['server/workbench-legacy-state.mjs']}, expected: true},
    {name: 'a removed unrelated file does not trigger', input: {event: 'push', ref: 'refs/heads/main', before: SHA, changedFiles: ['src/legacy-widget.ts']}, expected: false},
    {name: 'a PR diff error runs the full gate', input: {event: 'pull_request', baseRef: 'main', diffError: true, changedFiles: []}, expected: true},
    {name: 'a push diff error runs the full gate', input: {event: 'push', ref: 'refs/heads/main', before: SHA, diffError: true, changedFiles: []}, expected: true},
    {name: 'an unknown event fails closed to the full gate', input: {event: 'repository_dispatch', changedFiles: ['README.md']}, expected: true},
    {name: 'no event falls back to the full gate', input: {}, expected: true},
  ];
  for (const {name, input, expected} of cases) {
    assert.equal(shouldRunWorkbench(input), expected, name);
  }
});

test('CLI emits workbench=scope from arguments and stdin', () => {
  const script = fileURLToPath(new URL('../scripts/workbench_ci_scope.mjs', import.meta.url));
  const run = (args, input = '') => {
    const result = spawnSync(process.execPath, [script, ...args], {input, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(run(['--event', 'pull_request', '--base-ref', 'main'], 'server/workbench.mjs\n'), 'workbench=true');
  assert.equal(run(['--event', 'pull_request', '--base-ref', 'main'], 'src/agent-chat.ts\n'), 'workbench=false');
  assert.equal(run(['--event', 'push', '--before', SHA], 'README.md\n'), 'workbench=false');
  assert.equal(run(['--event', 'push', '--before', ZERO], ''), 'workbench=true');
  assert.equal(run(['--event', 'pull_request', '--base-ref', 'main', '--diff-error'], ''), 'workbench=true');
  assert.equal(run(['--event', 'workflow_dispatch'], ''), 'workbench=true');
});
