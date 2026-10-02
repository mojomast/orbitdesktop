import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceSelectionOffsets, formatKnowledgeExcerpt } from '../src/search-evidence.ts';

test('textarea selections retain exact BOM/CRLF/CR and emoji UTF-16 source offsets', () => {
  const original = '\ufeffA\r\n😀B\rC';
  const normalized = original.replace(/\r\n?/g, '\n');
  const start = normalized.indexOf('😀'), end = normalized.indexOf('C');
  const [from, to] = sourceSelectionOffsets(original, start, end);
  assert.equal(original.slice(from, to), '😀B\r');
  const evidence = { sourceId: 'full-opaque-source', extractor: 'utf8-v1', textSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), start: from, end: to };
  const payload = formatKnowledgeExcerpt(original.slice(from, to), evidence);
  assert.ok(payload.startsWith('😀B\r\n\n[Knowledge included-excerpt]'));
  assert.ok(payload.includes(`UTF-16 offsets: [${from}, ${to})`));
  assert.ok(payload.includes(evidence.textSha256));
  assert.deepEqual(sourceSelectionOffsets(original, 0, 0), [0, original.length]);
  assert.throws(() => formatKnowledgeExcerpt('wrong', evidence), /offsets/);
  assert.throws(() => formatKnowledgeExcerpt('x'.repeat(20000), {...evidence,start:0,end:20000}), /exceed/);
});
