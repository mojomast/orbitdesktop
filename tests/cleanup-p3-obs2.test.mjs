// Approved test for cleanup P3-OBS2: the Orbit Hive host reads the Observatory
// snapshot through the owner-authenticated extension proxy (P3-OBS1), not the
// unauthenticated /obs-snapshot route. /obs-snapshot itself stays in the server
// until the new path is verified live (Kyle's decision 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const EXT = '/api/ext/rizzstack-observatory/snapshot/snapshot';

test('AC-001 the Hive host no longer reads /obs-snapshot', () => {
  const host = read('src/hive-host.ts');
  assert.doesNotMatch(host, /['"`]\/obs-snapshot/);
});

test('AC-002 the Hive host reads the extension proxy with the owner bearer', () => {
  const host = read('src/hive-host.ts');
  const at = host.indexOf(EXT);
  assert.ok(at > 0, 'host fetches the extension proxy snapshot path');
  const call = host.slice(Math.max(0, at - 40), at + 400);
  assert.match(call, /fetch\(/);
  assert.match(call, /Authorization['"]?\s*:\s*[`'"]Bearer /, 'owner bearer sent with the read');
  assert.match(call, /method\s*:\s*['"]GET['"]/);
  assert.doesNotMatch(call, /credentials\s*:\s*['"]include['"]/);
});

test('AC-003 the browser integration test follows the new path', () => {
  const b = read('tests/hive-integration.browser.mjs');
  assert.doesNotMatch(b, /\/obs-snapshot/);
  assert.ok(b.includes(EXT));
});

test('AC-004 the legacy route is still served until live verification', () => {
  const index = read('server/index.mjs');
  assert.match(index, /serveObsSnapshot/);
  assert.match(index, /\/api\/ext\//);
});
