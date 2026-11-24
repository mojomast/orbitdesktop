// Approved test for cleanup P3-LEFT: the last Phase 3 leftovers. Docs outside the
// P3-DOCS lease stop describing removed features (Project Workbench and its
// arrangements/isolated checks/project tools, Data Lab, MCP Apps, knowledge model,
// spatial view, JEV); no markdown link points at a deleted doc; dead Workbench
// code/config goes. A line may still name a cut feature only to say it was removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const read = f => readFileSync(join(root, f), 'utf8');
const DOCS = [
  'README.md', 'hermes-plugin/README.md',
  'docs/AGENCY_EVOLUTION.md', 'docs/AGENT_GUIDE.md', 'docs/AGENT_PANE_UX.md', 'docs/ARCHITECTURE.md',
  'docs/DEPLOYMENT.md', 'docs/DOCKING_EVALUATION.md', 'docs/DYNAMIC_WORKSPACE_PLAN.md',
  'docs/ENVIRONMENT_MALLEABILITY_LEDGER.md', 'docs/EXTENSION_STUDIO.md', 'docs/LOCAL_WORKERS.md',
  'docs/ORBIT_EVOLUTION_HANDOFF.md', 'docs/ORBIT_EVOLUTION_PLAN.md', 'docs/RELEASE_READINESS_PLAN.md',
  'docs/RENDERER_PARITY.md', 'docs/RESEARCH.md', 'docs/RESOURCE_AUTHORITY_PROPOSAL.md',
  'docs/RESOURCE_DELEGATION.md', 'docs/TESTING_BRANCH.md', 'docs/THIRD_PARTY.md',
  'docs/VERIFICATION.md', 'docs/WORKSPACE_STORE.md', 'docs/adr/001-evolution-boundaries.md',
];
const CUT = /Kitty DOOM|kitty-doom|\bIRC\b|\bJEV\b|Browser copilot|browser-copilot|MCP Apps|mcp-apps|Data Lab|DATA_LAB|data-workbench|DuckDB|duckdb|\bset_view\b|\bset_arc\b|set_spatial|arrange_spatial|CSS3D|Three\.js|Spatial view|spatial desktop|Knowledge search|knowledge-model|MiniLM|Project Workbench|Comet Workbench|orbit_workbench|workbench_setup|\/api\/workbench|Workbench window|WORKSPACE_ARRANGEMENTS_API|arrangement recipe|ISOLATED_CHECKS|PROJECT_TOOLS\.md|PROJECT_WORKBENCH|MILESTONE_GOAL_FIRST_WORKBENCH|WORKBENCH_SETUP|gVisor|runsc|catalog\.arrangements|action:"arrangement"|arrangement '<request|Durable workspace arrangements|arrangement proposals/;

test('AC-001 dead Workbench files are gone', () => {
  for (const f of ['docs/ISOLATED_CHECKS.md', 'contracts/project-tools-v1.mjs']) assert.equal(existsSync(join(root, f)), false, f);
});

test('AC-002 docs outside the P3-DOCS lease no longer describe cut features', () => {
  const bad = [];
  for (const f of DOCS) {
    if (!existsSync(join(root, f))) continue;
    read(f).split('\n').forEach((line, i) => { if (CUT.test(line) && !/\bremoved\b/i.test(line)) bad.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(bad, []);
});

test('AC-003 no tracked markdown file links to a missing markdown file', () => {
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const bad = [];
  for (const f of files) {
    if (f.startsWith('node_modules/') || !existsSync(join(root, f))) continue;
    for (const m of read(f).matchAll(/\]\(([^)#:\s]+\.md)(?:#[^)]*)?\)/g)) {
      const target = normalize(join(dirname(f), m[1]));
      if (!existsSync(join(root, target))) bad.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('AC-004 packaging and tooling stop naming deleted Workbench/DuckDB/JEV pieces', () => {
  const policy = JSON.parse(read('scripts/portable-product.json'));
  for (const list of [policy.required, policy.excluded]) for (const f of list) assert.ok(existsSync(join(root, f)), `portable-product lists missing ${f}`);
  assert.doesNotMatch(read('scripts/check-local.mjs'), /DUCKDB/);
  assert.doesNotMatch(read('src/main.ts'), /\bjev\b/);
  // kept: docking, themes, SSH hosts, Google Colab, Grok Bots and saved layouts stay documented
  const readme = read('README.md');
  for (const kept of [/Google Colab/, /[Dd]ock/, /theme/i, /SSH/, /Grok Bots/, /saved/i]) assert.match(readme, kept);
});
