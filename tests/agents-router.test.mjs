// RED for wave A slice T3: orbitdesktop/AGENTS.md is a short router.
// Bees that follow today's AGENTS.md read three long docs (~15k tokens) before
// any work. Context files help only for non-standard practice (arXiv
// 2602.11988), so the file lists the non-standard commands and names each long
// doc only for the change that needs it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const text = fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');

test('AGENTS.md is short', () => {
  assert.ok(Buffer.byteLength(text) <= 1500, `AGENTS.md is ${Buffer.byteLength(text)} bytes`);
});

test('it keeps the non-standard commands', () => {
  assert.match(text, /npm run check/);
  assert.match(text, /scripts\/bundle_hermes\.py/);
});

test('long docs are named only conditionally', () => {
  for (const line of text.split('\n')) {
    const docs = line.match(/docs\/[A-Z_]+\.md/g) || [];
    if (!docs.length) continue;
    assert.match(line, /\b(when|if|only)\b/i, `unconditional doc pointer: ${line}`);
    assert.ok(docs.length <= 2, `too many docs in one pointer: ${line}`);
  }
});

test('no blanket read-before-anything instruction', () => {
  assert.doesNotMatch(text, /^Read `docs\/[A-Z_]+\.md` before (changing|any)/m);
  assert.doesNotMatch(text, /For current features, read/);
});
