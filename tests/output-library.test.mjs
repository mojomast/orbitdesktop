import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOutputLibrary} from '../server/output-library.mjs';
import {
  OUTPUT_LIBRARY_LIMITS,
  decodeAppUrl,
  filterOutputItems,
  joinOutputItem,
  normalizeTags,
  outputReferenceText,
  sanitizeShelfEntries,
  shelfItemId,
} from '../src/output-library-helpers.ts';

const HASH_A = 'a'.repeat(24);
const HASH_B = 'b'.repeat(24);
const rootFor = name => fs.mkdtempSync(`/tmp/opencode/ol-${name}-`);
const reply = (res, status, data) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data)); };

function request(body, {token = 'o'.repeat(40), origin = 'http://127.0.0.1:4318', host = '127.0.0.1:4318', method = 'POST', authorization} = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = (async function* () { yield bytes; })();
  req.method = method;
  req.headers = {authorization: authorization ?? `Bearer ${token}`, origin, host};
  return req;
}

function response() {
  const out = {status: undefined, headers: {}, body: undefined};
  return {
    out,
    res: {
      setHeader(key, value) { out.headers[key.toLowerCase()] = value; },
      writeHead(status, headers) { out.status = status; Object.assign(out.headers, headers ?? {}); },
      end(value) { out.body = value === undefined ? undefined : JSON.parse(value); },
    },
  };
}

function service({root, workspaces = new Set(), token = 'o'.repeat(40), read} = {}) {
  return createOutputLibrary({
    root,
    token,
    port: 4318,
    devOrigins: [],
    reply,
    workspaceRead: read ?? (id => {
      if (!workspaces.has(id)) throw Object.assign(Error('Workspace unavailable'), {code: 'ENOENT', category: 'RESOURCE_GONE'});
      return {id};
    }),
  });
}

async function call(lib, body, options) {
  const holder = response();
  await lib.handle(request(body, options), holder.res);
  return holder.out;
}

test('identity is the exact immutable resource URL, not a logical app id', () => {
  const first = shelfItemId(`/apps/focus-timer-${HASH_A}/index.html`);
  const republished = shelfItemId(`/apps/focus-timer-${HASH_B}/index.html`);
  assert.equal(first, `/apps/focus-timer-${HASH_A}/index.html`);
  assert.equal(republished, `/apps/focus-timer-${HASH_B}/index.html`);
  assert.notEqual(first, republished, 'a content hash change is a different resource');
  assert.equal(shelfItemId(`/apps/focus-timer-${HASH_A}/reports/summary.csv`), `/apps/focus-timer-${HASH_A}/reports/summary.csv`);
  assert.equal(shelfItemId('/apps/legacy-app/index.html'), '/apps/legacy-app/index.html');
  // Literal percent filenames follow server semantics: single decode per segment.
  assert.equal(shelfItemId('/apps/app/data%252f.csv'), '/apps/app/data%2f.csv');
  assert.equal(decodeAppUrl('/apps/app/data%252f.csv').relative, 'data%2f.csv');
});

test('decodeAppUrl refuses synthetic origins, queries, traversal and ambiguous slashes', () => {
  for (const bad of [
    'https://evil.example/apps/app/index.html',
    'http://orbit-output-library.invalid/apps/app/index.html',
    '//apps/app/index.html',
    '/apps//app/index.html',
    '/apps/app/index.html?x=1',
    '/apps/app/index.html#frag',
    '/apps/app/../secret.txt',
    '/apps/app/%2e%2e/secret.txt',
    '/apps/app/%2E%2E%2Fsecret.txt',
    '/apps/app/a%2fb.txt',
    '/apps/app/a%2Fb.txt',
    '/apps/app/.hidden',
    '/apps/app\\index.html',
    '/apps/app/%00name.txt',
    '/apps/app/%' + 'zz',
    '/other/app/index.html',
    '/apps/app',
    '',
    42,
  ]) assert.equal(shelfItemId(bad), null, String(bad));
  // Double-encoded traversal is a literal filename, not a traversal.
  assert.equal(shelfItemId('/apps/app/%252e%252e.txt'), '/apps/app/%2e%2e.txt');
  assert.equal(decodeAppUrl('/apps/app/a%252fb.txt').relative, 'a%2fb.txt');
});

test('shelf sanitizing, filtering and reference text are bounded and conservative', () => {
  const entries = sanitizeShelfEntries([
    {title: 'Report', url: `/apps/report-${HASH_A}/index.html`, kind: 'app/report'},
    {title: 'Data', url: `/apps/report-${HASH_A}/data.csv`, kind: 'output'},
    {title: 'Bad', url: 'https://evil.example/apps/x/index.html', kind: 'output'},
    {title: 7, url: '/apps/x/index.html', kind: 'output'},
  ]);
  assert.equal(entries.length, 2);
  const items = entries.map(entry => joinOutputItem(entry, entry.kind === 'output' ? {alias: null, pinned: true, tags: ['pinned', 'data']} : undefined));
  assert.equal(items.length, 2);
  assert.equal(items[1].pinned, true);
  assert.equal(filterOutputItems(items, {query: 'data'}).length, 1);
  assert.equal(filterOutputItems(items, {kind: 'output'}).length, 1);
  assert.equal(filterOutputItems(items, {pinnedOnly: true}).length, 1);
  assert.equal(filterOutputItems(items, {tag: 'DATA'}).length, 1);
  assert.equal(filterOutputItems(items, {query: 'nothing'}).length, 0);
  const reference = outputReferenceText(items[1]);
  assert.match(reference, /^Published output reference: Data/);
  assert.match(reference, /URL: \/apps\/report-/);
  assert.match(reference, /file contents were not fetched/);
  assert.ok(reference.length <= OUTPUT_LIBRARY_LIMITS.maxReferenceLength);
  assert.deepEqual(normalizeTags([' a ', 'a', 'b', 3, '']), ['a', 'b']);
});

test('owner authentication, strict schemas and bounded bodies are enforced', async t => {
  const root = rootFor('auth');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const workspace = randomUUID();
  const lib = service({root, workspaces: new Set([workspace])});
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace}, {authorization: 'Bearer wrong'})).status, 403);
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace}, {origin: 'http://evil.example'})).status, 403);
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace}, {method: 'GET'})).status, 405);
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace, extra: true})).status, 400);
  assert.equal((await call(lib, {action: 'nope', workspace_id: workspace})).status, 400);
  assert.equal((await call(lib, 'not json')).status, 400);
  const missing = await call(lib, {action: 'list', workspace_id: randomUUID()});
  assert.equal(missing.status, 404);
  assert.equal(fs.existsSync(path.join(root, 'output-library')), false, 'missing workspace must not create metadata');
  // Invalid uuid is rejected before any workspace read.
  assert.equal((await call(lib, {action: 'list', workspace_id: 'not-a-uuid'})).status, 400);
});

test('metadata persists, uses revision CAS and keeps drafts resolvable', async t => {
  const root = rootFor('cas');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const workspace = randomUUID();
  const url = `/apps/report-${HASH_A}/index.html`;
  const lib = service({root, workspaces: new Set([workspace])});

  const empty = await call(lib, {action: 'list', workspace_id: workspace});
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, {ok: true, workspace_id: workspace, revision: 0, items: {}});

  const created = await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {alias: 'Quarterly <b>report</b>', pinned: true, tags: ['draft', 'draft', ' finance ']}});
  assert.equal(created.status, 200);
  assert.equal(created.body.revision, 1);
  assert.equal(created.body.metadata.alias, 'Quarterly <b>report</b>');
  assert.equal(created.body.metadata.pinned, true);
  assert.deepEqual(created.body.metadata.tags, ['draft', 'finance']);
  const itemId = url;

  // Stale base revision is rejected and returns the current values.
  const conflict = await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {alias: 'Lost'}});
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'conflict');
  assert.equal(conflict.body.revision, 1);
  assert.equal(conflict.body.items[itemId].alias, 'Quarterly <b>report</b>');
  assert.equal(conflict.body.metadata.alias, 'Quarterly <b>report</b>');

  // Retry against the fresh revision succeeds (the draft is not lost).
  const retried = await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: conflict.body.revision, patch: {alias: 'Quarterly report'}});
  assert.equal(retried.status, 200);
  assert.equal(retried.body.revision, 2);
  assert.equal(retried.body.metadata.alias, 'Quarterly report');

  // Clearing and tag replacement round-trip.
  const cleared = await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 2, patch: {alias: null, tags: [], pinned: false}});
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.metadata.alias, null);
  assert.deepEqual(cleared.body.metadata.tags, []);

  // A second service instance reads the same durable file.
  const restarted = service({root, workspaces: new Set([workspace])});
  const persisted = await call(restarted, {action: 'list', workspace_id: workspace});
  assert.equal(persisted.body.revision, 3);
  assert.equal(persisted.body.items[itemId].pinned, false);

  // Private file is a regular 0600 file.
  const file = path.join(root, 'output-library', `${workspace}.json`);
  const stat = fs.lstatSync(file);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);

  // A republished report under a new content hash is a *different* resource:
  // the old alias/pin must never silently attach to the changed report.
  const republishedUrl = `/apps/report-${HASH_B}/index.html`;
  const republished = await call(lib, {action: 'set', workspace_id: workspace, url: republishedUrl, base_revision: 3, patch: {pinned: true}});
  assert.equal(republished.body.item_id, republishedUrl);
  assert.notEqual(republished.body.item_id, itemId);
  assert.equal(republished.body.metadata.alias, null, 'new release does not inherit the old alias');
  const after = await call(lib, {action: 'list', workspace_id: workspace});
  assert.equal(after.body.items[itemId].alias, null, 'old resource metadata is unchanged');
  assert.equal(after.body.items[republishedUrl].pinned, true);
  const other = await call(lib, {action: 'set', workspace_id: workspace, url: `/apps/report-${HASH_A}/data.csv`, base_revision: 4, patch: {tags: ['csv']}});
  assert.equal(other.body.item_id, `/apps/report-${HASH_A}/data.csv`);
});

test('bounds and invalid shapes are rejected without writing', async t => {
  const root = rootFor('bounds');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const workspace = randomUUID();
  const lib = service({root, workspaces: new Set([workspace])});
  const url = `/apps/app-${HASH_A}/index.html`;
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url: 'https://evil.example/apps/x/index.html', base_revision: 0, patch: {pinned: true}})).status, 400);
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {}})).status, 400);
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: -1, patch: {pinned: true}})).status, 400);
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {alias: 'x'.repeat(OUTPUT_LIBRARY_LIMITS.maxAliasLength + 1)}})).status, 400);
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {tags: Array.from({length: OUTPUT_LIBRARY_LIMITS.maxTagsPerItem + 1}, (_, i) => `t${i}`)}})).status, 400);
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {tags: ['bad\u0000tag']}})).status, 400);
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {pinned: 'yes'}})).status, 400);
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {pinned: true, unknown: 1}})).status, 400);
  // No request-id idempotency layer: operation_id/intent are rejected, not ignored.
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {pinned: true}, operation_id: 'x'})).status, 400);
  assert.equal((await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {pinned: true}, intent: 'x'})).status, 400);
  assert.equal((await call(lib, '{"action":"list","workspace_id":"'+workspace+'"}'.padEnd(40 * 1024, ' '))).status, 413);
  assert.equal(fs.existsSync(path.join(root, 'output-library', `${workspace}.json`)), false, 'rejected requests must not write');

  const valid = await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: 0, patch: {pinned: true}});
  assert.equal(valid.status, 200);
  // A malformed stored file fails closed instead of resetting.
  fs.writeFileSync(path.join(root, 'output-library', `${workspace}.json`), '{not json');
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace})).status, 404);
});

test('stored records fail closed on unexpected field types instead of being repaired', async t => {
  const root = rootFor('strict');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const workspace = randomUUID();
  const url = `/apps/app-${HASH_A}/index.html`;
  const lib = service({root, workspaces: new Set([workspace])});
  const file = path.join(root, 'output-library', `${workspace}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const base = {version: 1, workspace_id: workspace, revision: 1, items: {[url]: {url, alias: 'ok', pinned: false, tags: ['t'], updated_at: 1}}};
  const write = value => fs.writeFileSync(file, JSON.stringify(value));
  write(base);
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace})).status, 200, 'valid stored record reads');
  for (const patch of [
    {alias: 7}, {alias: ''}, {alias: 'x'.repeat(OUTPUT_LIBRARY_LIMITS.maxAliasLength + 1)},
    {pinned: 'yes'}, {tags: 'x'}, {tags: ['']}, {tags: [1]}, {tags: ['x'.repeat(OUTPUT_LIBRARY_LIMITS.maxTagLength + 1)]},
    {updated_at: 1.5}, {updated_at: -1},
    {url: '/apps/other/index.html'}, {url: 'https://evil.example/apps/app/index.html'}, {url: 7},
  ]) {
    write({...base, items: {[url]: {...base.items[url], ...patch}}});
    assert.equal((await call(lib, {action: 'list', workspace_id: workspace})).status, 404, JSON.stringify(patch));
  }
  write({...base, revision: 1.5});
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace})).status, 404);
  write({...base, version: 2});
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace})).status, 404);
  write({...base, workspace_id: randomUUID()});
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace})).status, 404);
  // Stored item_id must match the server-derived canonical resource identity.
  write({...base, items: {[`/apps/app-${HASH_B}/index.html`]: base.items[url]}});
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace})).status, 404);
});

test('store.read fallback is bound to the store and used when workspaceRead is absent', async t => {
  const root = rootFor('fallback');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const workspace = randomUUID();
  const store = {
    root,
    read(id) {
      if (this !== store) throw Error('unbound read');
      if (id !== workspace) throw Object.assign(Error('missing'), {code: 'ENOENT'});
      return {id};
    },
  };
  const lib = createOutputLibrary({root, token: 'o'.repeat(40), port: 4318, devOrigins: [], reply, store});
  assert.equal((await call(lib, {action: 'list', workspace_id: workspace})).status, 200);
  assert.equal((await call(lib, {action: 'list', workspace_id: randomUUID()})).status, 404);
});

test('revision overflow fails closed instead of committing an unsafe integer', async t => {
  const root = rootFor('overflow');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const workspace = randomUUID();
  const url = `/apps/app-${HASH_A}/index.html`;
  const lib = service({root, workspaces: new Set([workspace])});
  const file = path.join(root, 'output-library', `${workspace}.json`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({version: 1, workspace_id: workspace, revision: Number.MAX_SAFE_INTEGER, items: {[url]: {url, alias: null, pinned: false, tags: [], updated_at: 1}}}));
  const result = await call(lib, {action: 'set', workspace_id: workspace, url, base_revision: Number.MAX_SAFE_INTEGER, patch: {pinned: true}});
  assert.equal(result.status, 413);
});
