// Approved test for cleanup P3-DOCS: docs, CI and leftover UI hooks stop
// advertising features Kyle cut in Phase 3 (IRC, Kitty DOOM, JEV, browser copilot,
// MCP apps, Data Lab/DuckDB, the spatial 3D view, semantic knowledge search and
// Project Workbench). A line may still name a cut feature only to say it was removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const FILES = [
  '.github/workflows/technology.yml',
  'README.md',
  'apps/grokbots/index.html',
  'docs/ADAPTERS.md',
  'docs/AGENCY_EVOLUTION.md',
  'docs/AGENT_GUIDE.md',
  'docs/AGENT_PANE_UX.md',
  'docs/COLLAB.md',
  'docs/DEPLOYMENT.md',
  'docs/DOCKING_EVALUATION.md',
  'docs/ENVIRONMENT_MALLEABILITY_LEDGER.md',
  'docs/GROK.md',
  'docs/GROKBOTS.md',
  'docs/GROK_PARITY.md',
  'docs/HERMES_LIVE_VIEW.md',
  'docs/ORBIT_EVOLUTION_HANDOFF.md',
  'docs/PI.md',
  'docs/PLUGINS.md',
  'docs/RESEARCH.md',
  'docs/RESOURCE_DELEGATION.md',
  'docs/ROADMAP.md',
  'docs/TECHNOLOGY_ACCEPTANCE.md',
  'docs/TECHNOLOGY_FEATURES.md',
  'docs/TESTING_BRANCH.md',
  'docs/THIRD_PARTY.md',
  'docs/VERIFICATION.md',
  'docs/WORKSPACE_CONTROL.md',
  'docs/WORKSPACE_PROMPTS.md',
  'docs/WORKSPACE_STORE.md',
  'docs/WORKSPACE_USABILITY.md',
  'docs/adr/001-evolution-boundaries.md',
  'examples/plugins/orbit-showcase/index.html',
  'src/grokbots-bridge.ts',
  'src/onboarding.ts',
  'src/taskbar.css',
  'src/unified-taskbar.css',
  'tests/asteria-simulator.browser.py',
  'tests/catalog-backend.browser.py',
  'tests/command-palette.browser.py',
  'tests/docking-narrow.browser.py',
  'tests/everyday-ux.browser.py',
  'tests/extension-studio.browser.py',
  'tests/feature-readiness.browser.py',
  'tests/grokbots-app.browser.mjs',
  'tests/nous-theme.browser.py',
  'tests/orbit-catalog.browser.py',
  'tests/recovery-real-server.browser.py',
  'tests/technology-workspace.browser.py',
  'tests/theme-chrome.browser.py',
  'tests/theme-icons.browser.py',
  'tests/theme-personalities.browser.py',
  'tests/workspace-arrange.browser.py',
  'tests/workspace-release-acceptance.browser.py',
  'tests/xpra-apps.browser.py'
];
const CUT = /Kitty DOOM|kitty-doom|\bIRC\b|irc-suite|\bJEV\b|jev_|Browser copilot|browser-copilot|MCP Apps|mcp-apps|Data Lab|data-workbench|DuckDB|duckdb|\bset_view\b|\bset_arc\b|set_spatial|arrange_spatial|spatial ordering|CSS3D|Three\.js|Move into 3D|Spatial view|spatial desktop|taskbar-camera|Knowledge search|knowledge-model|MiniLM|Project Workbench|orbit_workbench|\/api\/workbench|Workbench window|wbbtn/;

test('AC-001 kept docs, CI and UI files no longer advertise cut features', () => {
  const bad = [];
  for (const f of FILES) {
    if (!existsSync(join(root, f))) continue; // deleting a doc dedicated to a cut feature is fine
    readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
      if (CUT.test(line) && !/\bremoved\b/i.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('AC-002 kept features stay documented and wired', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  for (const kept of [/Google Colab/, /dock/i, /theme/i, /SSH/, /Grok Bots/]) assert.match(readme, kept);
  assert.match(readFileSync(join(root, 'src/grokbots-bridge.ts'), 'utf8'), /registerGrokBotsOp\('voice'/);
  assert.match(readFileSync(join(root, 'apps/grokbots/index.html'), 'utf8'), /micbtn/);
});
