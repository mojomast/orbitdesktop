// Approved test for cleanup P3-WB-SRV: remove the Project Workbench server.
// Kyle's decision 2 (Phase 3): "Workbench data: leave it unused in the database,
// no migration". The wb_* / project-tool tables stay in the schema and on disk,
// inert; Orbit must still open stores that contain them. Only the schema SQL is
// kept (server/workbench-schema.mjs); every Workbench route, service and contract
// goes. The Hermes plugin side is a separate slice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteWorkspaceStore } from '../server/sqlite-workspace-store.mjs';
import { tempRoot, removeRoot } from './fixtures/sqlite-store-helpers.mjs';
import { boot } from './fixtures/local-orbit.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = p => readFileSync(join(root, p), 'utf8');
const list = d => readdirSync(join(root, d)).map(f => `${d}/${f}`);
const SERVER_GONE = /^server\/(workbench-(?!schema\.mjs$).*|workbench\.mjs|project-tools.*|project-files\.mjs|workspace-arrangements?\.mjs|workspace-arrangement-control\.mjs)$/;

test('AC-001 Workbench server modules, contracts, generator and CI are removed', () => {
  const left = [
    ...list('server').filter(f => SERVER_GONE.test(f)),
    ...list('contracts').filter(f => /workbench/i.test(f)),
    ...['scripts/generate-workbench-contract.mjs', 'scripts/workbench_ci_scope.mjs',
      '.github/workflows/workbench.yml', 'src/workbench-contract.generated.ts'].filter(f => existsSync(join(root, f))),
  ];
  assert.deepEqual(left, []);
});

test('AC-002 no kept code imports Workbench modules or serves Workbench routes', () => {
  const bad = [];
  for (const f of [...list('server'), ...list('scripts')].filter(f => /\.(mjs|js|ts)$/.test(f))) {
    const s = read(f);
    if (/from\s+['"]\.\/(workbench-(?!schema)|workbench\.mjs|project-tools|project-files|workspace-arrangement)/.test(s)) bad.push(`${f}: import`);
    if (/import\(\s*['"]\.\/(workbench|project-tools|project-files|workspace-arrangement)/.test(s)) bad.push(`${f}: dynamic import`);
    if (/['"`]\/api\/workbench/.test(s)) bad.push(`${f}: route`);
    if (/contracts\/workbench-|generate-workbench-contract|workbench_ci_scope/.test(s)) bad.push(`${f}: contract/ci`);
  }
  assert.deepEqual(bad, []);
  const ws = read('server/workspace.mjs');
  assert.doesNotMatch(ws, /'arrangement'|workbench_setup|setWorkbenchSetup/);
  assert.doesNotMatch(read('server/agent.mjs'), /workbench/i);
});

test('AC-003 the schema stays: wb_* tables are created and survive reopen, never dropped', t => {
  assert.ok(existsSync(join(root, 'server/workbench-schema.mjs')));
  assert.match(read('server/sqlite-workspace-store.mjs'), /from '\.\/workbench-schema\.mjs'/);
  for (const f of list('server').filter(f => f.endsWith('.mjs'))) assert.doesNotMatch(read(f), /DROP TABLE[^;]*\b(wb_|project_tool)/i, f);
  const dir = tempRoot('orbit-p3-wbsrv-'); t.after(() => removeRoot(dir));
  let store = new SqliteWorkspaceStore(dir);
  const tables = () => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'wb\\_%' ESCAPE '\\' OR name LIKE 'project\\_tool%' ESCAPE '\\') ORDER BY name").all().map(r => r.name);
  const first = tables(), version = store.db.pragma('user_version', { simple: true });
  assert.ok(first.includes('wb_projects') && first.length >= 5, `wb tables: ${first}`);
  store.db.pragma('foreign_keys = OFF');
  store.db.prepare("INSERT INTO wb_projects(id,workspace_id,root,record_json) VALUES ('p1','w1','/nonexistent','{}')").run();
  store.close();
  store = new SqliteWorkspaceStore(dir);
  assert.deepEqual(tables(), first);
  assert.equal(store.db.pragma('user_version', { simple: true }), version);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM wb_projects').get().n, 1, 'existing rows are left alone');
  store.close();
});

test('AC-004 kept services use a neutral error helper', () => {
  assert.match(read('server/service-error.mjs'), /export const serviceError\s*=/);
  for (const f of ['server/run-traces.mjs', 'server/run-traces-store.mjs', 'server/extension-studio.mjs']) {
    if (existsSync(join(root, f))) assert.doesNotMatch(read(f), /workbench-store/, f);
  }
});

test('AC-005 Workbench routes are gone; run traces and extension studio still answer', async t => {
  const orbit = await boot(t);
  const auth = { Authorization: `Bearer ${orbit.token}`, Origin: orbit.base, 'Content-Type': 'application/json' };
  for (const p of ['/api/workbench', '/api/workbench/setup', '/api/workbench/native', '/api/workbench/tools', '/api/workbench/live']) {
    const r = await fetch(orbit.base + p, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(r.status, 404, p); await r.body?.cancel();
  }
  const traces = await fetch(orbit.base + '/api/run-traces', { method: 'POST', headers: auth, body: '{}' });
  assert.notEqual(traces.status, 404); await traces.body?.cancel();
});
