import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedRequest, resolveListenHost } from '../server/security.mjs';

const saved = process.env.ORBIT_HOST;

test.after(() => {
  if (saved === undefined) delete process.env.ORBIT_HOST;
  else process.env.ORBIT_HOST = saved;
});

test('a specific bind address is accepted and a wildcard bind is not an origin', () => {
  process.env.ORBIT_HOST = '100.120.57.35';
  assert.equal(resolveListenHost(), '100.120.57.35');
  assert.equal(allowedRequest({ headers: { host: '100.120.57.35:4318', origin: 'http://100.120.57.35:4318' } }, 4318), true);
  assert.equal(allowedRequest({ headers: { host: 'evil.example:4318', origin: 'http://evil.example:4318' } }, 4318), false);
  assert.equal(allowedRequest({ headers: { host: '127.0.0.1:4318', origin: 'http://127.0.0.1:4318' } }, 4318), true);

  process.env.ORBIT_HOST = '0.0.0.0';
  assert.equal(allowedRequest({ headers: { host: '100.120.57.35:4318', origin: 'http://100.120.57.35:4318' } }, 4318), false);
  assert.equal(allowedRequest({ headers: { host: '127.0.0.1:4318', origin: 'http://127.0.0.1:4318' } }, 4318), true);
});

test('ORBIT_HOST rejects values that are not a hostname or address', () => {
  assert.throws(() => resolveListenHost('bad host'), /ORBIT_HOST/);
  assert.throws(() => resolveListenHost('a..b'), /ORBIT_HOST/);
  assert.throws(() => resolveListenHost(''), /ORBIT_HOST/);
});
