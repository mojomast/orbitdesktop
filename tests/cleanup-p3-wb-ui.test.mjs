// Approved test for cleanup P3-WB-UI: remove the Project Workbench user interface.
// Kyle's decision (Phase 3): Workbench is cut; its database tables stay, unused.
// Server routes are removed by a later slice, so this test covers src/ only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(join(root, p), 'utf8');
const srcFiles = () => readdirSync(join(root, 'src'), { recursive: true })
  .map(String).filter(f => /\.(ts|css|html)$/.test(f) && !f.endsWith('.generated.ts')).map(f => `src/${f}`);

const GONE = [
  'src/candidate-diff-adapter.ts', 'src/candidate-diff-engine.ts', 'src/candidate-diff-highlight.ts',
  'src/candidate-diff-types.ts', 'src/candidate-diff-viewer.css', 'src/candidate-diff-viewer.ts',
  'src/candidate-diff-worker.ts', 'src/pane-workbench.css', 'src/pane-workbench.ts',
  'src/project-tool-host.ts', 'src/project-tool-manager.ts', 'src/project-tools.css',
  'src/project-workbench.css', 'src/project-workbench.ts', 'src/workbench-arrangements.css',
  'src/workbench-context.ts', 'src/workbench-execution.ts', 'src/workbench-live-client.ts',
  'src/workbench-review-host.ts', 'src/workbench-review-view.ts', 'src/workbench-setup.css',
  'src/workbench-setup.ts', 'src/workbench-task-authority.ts', 'src/workbench-task-inbox.ts',
  'src/workbench-task-result.ts', 'src/workbench-workflow.ts',
  'src/experimental.ts',
  'tests/candidate-diff-adapter.test.mjs', 'tests/candidate-diff-engine.test.mjs',
  'tests/workbench-live-client.test.mjs', 'tests/experimental.test.mjs',
  'tests/pane-workbench-mode.browser.py', 'tests/project-workbench.browser.py',
  'tests/experimental-workbench.browser.py', 'tests/project-tools.browser.py',
];

test('AC-001 Workbench UI modules and their UI tests are removed', () => {
  const left = GONE.filter(f => existsSync(join(root, f)));
  assert.deepEqual(left, []);
});

test('AC-002 no kept src file imports, opens or advertises Workbench', () => {
  const bad = [];
  // src/grokbots-bridge.ts is leased by P3-MIC; its 'workbench' op is removed by a follow-up.
  for (const f of srcFiles().filter(f => f !== 'src/grokbots-bridge.ts')) {
    const s = read(f);
    if (/from\s+['"]\.\/(candidate-diff-|pane-workbench|project-tool-|project-workbench|workbench-|experimental)/.test(s)) bad.push(`${f}: import`);
    if (/import\(\s*['"]\.\/(project-workbench|pane-workbench|workbench-)/.test(s)) bad.push(`${f}: dynamic import`);
    if (/\/api\/(workbench|project-tools)\b/.test(s)) bad.push(`${f}: api`);
    if (/orbit-open-workbench-window|Project Workbench|Workbench window|Workbench Hermes mode|experimentalEnabled/.test(s)) bad.push(`${f}: ui text`);
  }
  assert.deepEqual(bad, []);
});

test('AC-003 the kept chat, menu and bridge files carry no Workbench mode', () => {
  for (const f of ['src/agent-chat.ts', 'src/agent-activity.ts', 'src/main.ts', 'src/panes.ts',
    'src/workspace-extensions.ts', 'src/orbit-settings.ts']) {
    assert.doesNotMatch(read(f), /workbench/i, `${f} still mentions workbench`);
  }
  if (existsSync(join(root, 'src/pane-prefs.ts'))) assert.doesNotMatch(read('src/pane-prefs.ts'), /'workbench'/);
});

test('AC-004 the Normal Hermes chat and kept surfaces remain', () => {
  assert.match(read('src/agent-chat.ts'), /export function createAgentChat\(/);
  const main = read('src/main.ts');
  assert.match(main, /Google Colab/);
  assert.match(read('src/workspace-extensions.ts'), /build-queue/);
  // Run traces keep reading historical records, including old Workbench-method rows.
  assert.ok(existsSync(join(root, 'src/run-trace-pane.ts')));
});
