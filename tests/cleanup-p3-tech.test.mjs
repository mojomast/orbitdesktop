// Phase 3 (rizzstack cleanup): browser copilot, MCP Apps, voice transcript and Data Lab (data workbench) are cut from Orbit.
// AC-001: their modules, contracts, provisioning scripts, tests and feature docs are deleted.
// AC-002: nothing tracked in code, contracts, tests, CI or the agent guide/README still references them.
// AC-003: the server no longer serves their routes or assets (404), and capabilities no longer advertise them.
// AC-004: kept technology surfaces (knowledge search, interactive results, documents, run traces) and Grok Bots stay.
// Amended 2:35 PM ET per Kyle ("Voice: keep the Grok Bots dictation mic"): the voice engine files return for the
// Grok Bots mic only (tests/cleanup-p3-mic.test.mjs); the standalone Voice transcript surface stays cut.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boot} from './fixtures/local-orbit.mjs';
import {FEATURE_CAPABILITIES} from '../contracts/feature-capabilities.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const self = fileURLToPath(import.meta.url);
const gone = [
  'server/browser-copilot-driver.mjs','server/browser-copilot-evidence.mjs','server/browser-copilot-records.mjs','server/browser-copilot-route.mjs','server/browser-copilot.mjs',
  'src/browser-copilot-client.ts','src/browser-copilot-pane.ts','src/browser-copilot.css','src/browser-copilot.ts','tests/browser-copilot-fixture.mjs','tests/browser-copilot.browser.py','tests/browser-copilot.test.mjs',
  'contracts/browser-copilot-v1.mjs','docs/BROWSER_COPILOT.md',
  'scripts/mcp-apps-fixture.mjs','server/mcp-apps-sandbox.mjs','server/mcp-apps.mjs','src/mcp-apps-host.css','src/mcp-apps-host.ts','tests/mcp-apps-proxy.test.mjs','tests/mcp-apps.browser.py','tests/mcp-apps.test.mjs',
  'contracts/mcp-apps-v1.mjs','docs/MCP_APPS.md',
  
  
  'scripts/provision_data_engine.mjs','server/data-engine-assets.mjs','server/data-recipes.mjs','src/data-published-input.ts','src/data-query.ts','src/data-workbench.css','src/data-workbench.ts','src/duckdb-client.ts',
  'tests/data-published-input.test.mjs','tests/data-workbench-assets.test.mjs','tests/data-workbench.browser.py','tests/data-workbench.test.mjs','contracts/data-recipes-v1.mjs','docs/DATA_LAB.md'];
const tokens = ['browser-copilot','browserCopilot','BrowserCopilot','browser_copilot','Browser copilot','mcp-apps','mcpApps','McpApps','mcp_apps','mcp_snapshot','MCP Apps',
  'Voice transcript','technology-voice',
  'data-workbench','dataWorkbench','DataWorkbench','Data workbench','data-recipes','dataRecipes','data-engine','DATA_ENGINE','data-query','data-published','publishedDataInput','duckdb','DuckDB','/vendor/duckdb','provision_data'];
function walk(dir, out=[]) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','.git','dist','docs','experiments','vendor'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|cjs|ts|json|py|css|html|yml|yaml|sh)$/.test(entry.name) && !/^(orbit-inventory\.json|package-lock\.json|package\.json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('AC-001 copilot, MCP Apps, voice and Data Lab files are deleted', () => {
  for (const file of gone) assert.equal(fs.existsSync(path.join(root,file)), false, `${file} still exists`);
});

test('AC-002 nothing tracked references them', () => {
  const hits = [];
  for (const file of walk(root)) {
    if (file === self || /tests\/cleanup-[^/]*\.test\.mjs$/.test(file)) continue;
    const rel = path.relative(root,file), text = fs.readFileSync(file,'utf8');
    for (const t of tokens) if (text.includes(t)) hits.push(`${rel}: ${t}`);
    if (/^(src|server)\//.test(rel) && /\bcase ['"](copilot|data|mcp-apps)['"]|orbit:\/\/surface\/(copilot|data|browser-copilot|mcp-apps)\b/.test(text)) hits.push(`${rel}: surface id`);
  }
  assert.deepEqual(hits, []);
  const scripts = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts || {};
  assert.deepEqual(Object.entries(scripts).filter(([k,v]) => /duckdb|data-engine|mcp-apps|copilot/i.test(k+v)), []);
  for (const doc of ['README.md','docs/AGENT_GUIDE.md'])
    assert.ok(!/Browser copilot|MCP Apps|Voice transcript|Data workbench|Data Lab|DuckDB/i.test(fs.readFileSync(path.join(root,doc),'utf8')), `${doc} still mentions a cut feature`);
  assert.deepEqual(FEATURE_CAPABILITIES.map(row => row[0]).filter(id => ['browser-copilot','mcp-apps','voice-transcript','data-workbench'].includes(id)), []);
});

test('AC-003 their routes and assets are gone (404) and capabilities stop advertising them', async t => {
  const {base, token} = await boot(t);
  const auth = {Authorization:`Bearer ${token}`,'Content-Type':'application/json',Origin:base};
  for (const route of ['/api/browser-copilot','/api/mcp-apps','/api/data-recipes']) {
    const res = await fetch(base+route, {method:'POST', headers:auth, body:'{}'}); await res.arrayBuffer();
    assert.equal(res.status, 404, `POST ${route} -> ${res.status}`);
  }
  for (const asset of ['/vendor/duckdb/duckdb-eh.wasm','/vendor/voice/model.onnx','/vendor/duckdb/v1.4.3/status']) {
    const res = await fetch(base+asset, {headers:auth}); await res.arrayBuffer();
    assert.equal(res.status, 404, `GET ${asset} -> ${res.status}`);
  }
  const caps = await fetch(base+'/api/technology-capabilities', {method:'POST', headers:auth, body:JSON.stringify({action:'capabilities'})});
  const body = await caps.json();
  assert.equal(caps.status, 200);
  assert.equal(Object.hasOwn(body,'browser_copilot') || Object.hasOwn(body,'mcp_apps'), false, 'capabilities must not advertise cut features');
  const ids = (body.descriptors?.features || []).map(f => f.feature_id);
  for (const id of ['browser-copilot','mcp-apps','voice-transcript','data-workbench']) assert.ok(!ids.includes(id), `${id} still described`);
});

test('AC-004 kept technology surfaces and Grok Bots stay', async t => {
  for (const file of ['server/knowledge-index.mjs','src/search-surface.ts','server/interactive-results.mjs','src/interactive-result-host.ts','server/documents-store.mjs',
    'src/document-library.ts','server/run-traces.mjs','src/run-trace-pane.ts','src/technology-surfaces.ts','server/grokbots-app.mjs','src/grokbots-bridge.ts','apps/grokbots/index.html'])
    assert.ok(fs.existsSync(path.join(root,file)), `${file} must stay`);
  const {base, token} = await boot(t);
  const auth = {Authorization:`Bearer ${token}`,'Content-Type':'application/json',Origin:base};
  for (const route of ['/api/search','/api/interactive-results','/api/documents','/api/run-traces']) {
    const res = await fetch(base+route, {method:'POST', headers:auth, body:'{}'}); await res.arrayBuffer();
    assert.notEqual(res.status, 404, `${route} must stay`);
  }
});
