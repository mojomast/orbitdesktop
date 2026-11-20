import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Live moltussy-1 (Nov 19 2026): the browser reaches Orbit at ORBIT_PUBLIC_ORIGIN through a
// framing proxy that rewrites Host to the loopback upstream. A same-origin GET carries no Origin
// header, so the extension proxy saw Referer host != Host and refused the owner's Observatory read.
// Only the exact configured public origin may differ from Host; everything else stays refused.
const PUBLIC = 'https://orbit.example.test:8443';
function run(publicOrigin, cases) {
  const src = `const { allowedRequest } = await import(${JSON.stringify(new URL('../server/security.mjs', import.meta.url).href)});
    const cases = ${JSON.stringify(cases)};
    console.log(JSON.stringify(cases.map(([url, h]) => allowedRequest({ method: 'GET', url, headers: h }, 4318))));`;
  const env = { PATH: process.env.PATH, ORBIT_HOST: '127.0.0.1' };
  if (publicOrigin) env.ORBIT_PUBLIC_ORIGIN = publicOrigin;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
}
const so = (referer, host = '127.0.0.1:4318', site = 'same-origin') => ({ host, referer, 'sec-fetch-site': site });
const ext = '/api/ext/rizzstack-observatory/snapshot/snapshot';

test('same-origin read through a Host-rewriting proxy at the exact public origin is allowed', () => {
  assert.deepEqual(run(PUBLIC, [
    [ext, so(PUBLIC + '/')],
    ['/api/acdd-evidence', so(PUBLIC + '/')],
    [ext, so('http://127.0.0.1:4318/')],
  ]), [true, true, true]);
});

test('everything else stays refused (fail-closed)', () => {
  assert.deepEqual(run(PUBLIC, [
    [ext, so(PUBLIC + '/', '127.0.0.1:4318', 'cross-site')],
    [ext, so(PUBLIC + '/', '127.0.0.1:4318', 'same-site')],
    [ext, { host: '127.0.0.1:4318', referer: PUBLIC + '/' }],
    [ext, so('https://evil.example/')],
    [ext, so('https://orbit.example.test:9443/')],
    [ext, so('http://orbit.example.test:8443/')],
    [ext, so(PUBLIC + '/', 'evil.example:4318')],
    [ext, so('http://localhost:4318/')],
    [ext, so('not a url')],
    [ext, { host: '127.0.0.1:4318', 'sec-fetch-site': 'same-origin' }],
    ['/api/workspace', so(PUBLIC + '/')],
    ['/api/ext-other/x', so(PUBLIC + '/')],
  ]), Array(12).fill(false));
  assert.deepEqual(run('', [[ext, so(PUBLIC + '/')]]), [false]);
});
