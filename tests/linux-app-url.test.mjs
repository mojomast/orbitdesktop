import test from 'node:test';
import assert from 'node:assert/strict';
import {linuxAppUrl} from '../src/linux-app-url.ts';

test('optional Linux viewers stay on the user deployment for local, TLS and IPv6 origins', () => {
  for (const [origin, expected] of [
    ['http://127.0.0.1:4318', 'http://127.0.0.1'],
    ['http://localhost:9999', 'http://localhost'],
    ['https://desktop.example.org:8443', 'https://desktop.example.org'],
    ['http://[::1]:4318', 'http://[::1]'],
  ]) {
    for (const port of [4344,4350,4351,4352,4353,4354,4355,4356])
      assert.equal(linuxAppUrl(origin,port,'/?sharing=true'), `${expected}:${port}/?sharing=true`);
  }
  assert.throws(()=>linuxAppUrl('javascript:alert(1)',4350));
  assert.throws(()=>linuxAppUrl('https://user:secret@example.org',4350));
});
