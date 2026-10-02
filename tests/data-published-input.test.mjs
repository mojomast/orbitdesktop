import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publishedDataInput, fetchPublishedDataInput, PUBLISHED_DATA_LIMIT } from '../src/data-published-input.ts';

const csv = 'id,amount\n1,25\n';
const hash = createHash('sha256').update(csv).digest('hex');
const path = `demo-${'a'.repeat(24)}/sample.csv`;
const url = `orbit://surface/data?input=${path}&sha256=${hash}`;

test('published route admits only an exact public bundle CSV and full hash', () => {
  assert.deepEqual(publishedDataInput(url), { path: `/apps/${path}`, name: 'sample.csv', sha256: hash });
  for (const value of [url+'&sql=SELECT1', url+'#fragment', url+'\n', url.replace(path, '../secret.csv'),
    url.replace(path, 'https://example.com/sample.csv'), url.replace(path, path.replace('/', '%2f')),
    url.replace('.csv', '.json'), url.replace(path, 'mutable/sample.csv'), url.replace(hash, 'a'.repeat(63)),
    url.replace('input=', 'input=x&input='), url.replace('sample.csv','sub/sample.csv')]) {
    assert.equal(publishedDataInput(value), null, value);
  }
});

test('fetch uses no credentials or redirects and verifies exact bytes before constructing an input', async t => {
  t.mock.method(globalThis, 'fetch', async (request, options) => {
    assert.equal(request, `/apps/${path}`);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.mode, 'same-origin');
    return new Response(csv);
  });
  const file = await fetchPublishedDataInput(url, new AbortController().signal);
  assert.equal(file.name, 'sample.csv');
  assert.equal(await file.text(), csv);
  await assert.rejects(fetchPublishedDataInput(url.replace(hash, 'b'.repeat(64)), new AbortController().signal), /SHA-256 mismatch/);
});

test('invalid routes, missing files, empty input and size bounds fail before engine admission', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(fetchPublishedDataInput('https://example.com/data.csv', new AbortController().signal), /Invalid/);
  assert.equal(mock.mock.callCount(), 0);
  await assert.rejects(fetchPublishedDataInput(url, new AbortController().signal), /unavailable/);
  mock.mock.mockImplementation(async () => new Response(''));
  await assert.rejects(fetchPublishedDataInput(url, new AbortController().signal), /empty/);
  mock.mock.mockImplementation(async () => new Response('x', { headers: { 'content-length': String(PUBLISHED_DATA_LIMIT + 1) } }));
  await assert.rejects(fetchPublishedDataInput(url, new AbortController().signal), /exceeds/);
  // A missing/untrusted Content-Length cannot bypass the streamed byte bound.
  let cancelled = false;
  mock.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(PUBLISHED_DATA_LIMIT)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(fetchPublishedDataInput(url, new AbortController().signal), /exceeds/);
  assert.equal(cancelled, true);
});

test('aborted input cannot be returned for engine admission', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { controller.abort(); return new Response(csv); });
  await assert.rejects(fetchPublishedDataInput(url, controller.signal), { name: 'AbortError' });
});
