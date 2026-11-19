// Phase 3 (Kyle, 2:35 PM ET): "Knowledge search: keep a minimal index for the bots' shared-source search".
// The Knowledge search feature (search UI, cited-passage evidence view, local MiniLM embeddings) is cut.
// A minimal keyword index stays: owner-added source snapshots that bots reach through resource grants
// (search / get_source verbs) after the owner delegates selected sources.
// AC-001: the semantic-embedding and search-UI files are deleted.
// AC-002: the index is keyword-only and still ingests, lists, searches, reads and deletes sources.
// AC-003: the owner surface is "Shared sources" (add/list/remove sources, delegate to bots) with no search box; no "Knowledge search" left.
// AC-004: the resource-grant verbs and the delegation approval flow stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {TECHNOLOGY_SURFACES} from '../src/technology-surfaces.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const self = fileURLToPath(import.meta.url);
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const gone = ['server/knowledge-embedder.mjs','server/knowledge-embed-worker.mjs','server/knowledge-model.mjs','scripts/knowledge-model.mjs',
  'tests/knowledge-embedder.test.mjs','tests/knowledge-vector.test.mjs','src/search-evidence.ts','tests/search-evidence.test.mjs','tests/knowledge-search.browser.py','docs/KNOWLEDGE_SEARCH.md'];

test('AC-001 semantic-embedding and search-UI files are deleted', () => {
  for (const file of gone) assert.equal(fs.existsSync(path.join(root, file)), false, `${file} still exists`);
});

test('AC-002 keyword-only index still serves sources', async t => {
  const index = read('server/knowledge-index.mjs');
  assert.ok(!/knowledge-embedder|knowledge-model|MiniLM|createEmbedder/.test(index), 'index must not load an embedding model');
  const {createKnowledgeSearch} = await import('../server/knowledge-index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-know-'));
  const ws = '11111111-1111-1111-1111-111111111111';
  const service = createKnowledgeSearch({root: dir, workspaceRead: id => { if (id !== ws) throw Error('gone'); return {id}; }});
  t.after(async () => { await service.close(); fs.rmSync(dir, {recursive: true, force: true}); });
  const call = (action, fields = {}) => service.dispatch({action, workspace_id: ws, ...fields});
  const status = await call('status');
  assert.equal(Object.hasOwn(status, 'semantic'), false, 'status must not report a semantic model');
  const src = await call('ingest_text', {kind: 'owner_text', title: 'Shared notes', location: 'test', text: 'The observatory telescope sees distant planets.'});
  assert.equal((await call('list_sources')).sources.length, 1);
  const found = await call('search', {query: 'planets'});
  assert.equal(found.mode, 'keyword');
  assert.ok(found.results.length >= 1, 'keyword search must find the source');
  assert.equal((await call('get_source', {source_id: src.source_id})).title, 'Shared notes');
  const generation = (await call('list_sources')).consent_generation;
  await call('delete_source', {source_id: src.source_id, base_consent_generation: generation});
  assert.equal((await call('list_sources')).sources.length, 0);
});

test('AC-003 owner surface is Shared sources, no Knowledge search left', () => {
  assert.equal(TECHNOLOGY_SURFACES.search.title, 'Shared sources');
  const surface = read('src/search-surface.ts');
  assert.match(surface, /mountResourceGrants/, 'surface must keep the delegate-selected-sources flow');
  assert.ok(!/search-evidence|renderResult|aria-label["'], *["']Search|placeholder *= *["']Search/.test(surface), 'surface must not keep the search box or results view');
  const hits = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    if (['node_modules','.git','dist','docs','experiments','vendor','.github'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(mjs|js|ts|py|css|html|json)$/.test(e.name) && !/^(package-lock|orbit-inventory)\.json$/.test(e.name) && full !== self && !/tests\/cleanup-[^/]*\.test\.mjs$/.test(full)) {
      const text = fs.readFileSync(full, 'utf8');
      if (/Knowledge search|knowledge-embedder|knowledge-model|search-evidence|MiniLM/.test(text)) hits.push(path.relative(root, full));
    } } };
  walk(root);
  assert.deepEqual(hits, []);
  for (const doc of ['README.md','docs/AGENT_GUIDE.md']) assert.ok(!/Knowledge search|MiniLM/i.test(read(doc)), `${doc} still mentions Knowledge search`);
});

test('AC-004 resource-grant verbs and delegation approval stay', () => {
  const delegation = read('server/resource-delegation.mjs');
  assert.match(delegation, /search:\s*\(/, 'grant search verb stays');
  assert.match(delegation, /get_source/, 'grant get_source verb stays');
  assert.match(delegation, /Shared sources -> Delegate selected sources/, 'approval hint names the Shared sources surface');
  assert.ok(fs.existsSync(path.join(root, 'src/resource-grants.ts')));
});
