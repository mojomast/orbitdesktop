// Phase 2 (rizzstack cleanup): dead server modules are deleted, not just unmounted.
// AC-001: host-api, approvals-route, ssh-bootstrap, mobile-proxy (+ mobile-security) and the
//         JSON workspace store are gone, with the tests that only exercised them.
// AC-002: nothing tracked still imports or packages them (server, scripts, tests, Dockerfile).
// AC-003: the SSH hosts feature itself stays (server/ssh-hosts.mjs, ssh-config, ssh-keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const gone = ['server/host-api.mjs','server/approvals-route.mjs','server/approvals-route.test.mjs','server/ssh-bootstrap.mjs',
  'server/mobile-proxy.mjs','server/mobile-security.mjs','server/workspace-store.mjs','tests/host-api.test.mjs','tests/approvals.test.mjs'];
const names = ['host-api.mjs','approvals-route','ssh-bootstrap','mobile-proxy','mobile-security','JsonWorkspaceStore',"/workspace-store.mjs'"];

function walk(dir, out=[]) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','.git','dist','vendor','experiments'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|ts|json|py)$/.test(entry.name) && entry.name !== 'orbit-inventory.json') out.push(full);
  }
  return out;
}

test('AC-001 dead server modules are deleted', () => {
  for (const file of gone) assert.equal(fs.existsSync(path.join(root,file)), false, `${file} still exists`);
});

test('AC-002 nothing tracked references the deleted modules', () => {
  const self = fileURLToPath(import.meta.url);
  const hits = [];
  for (const file of walk(root)) {
    if (file === self) continue;
    const text = fs.readFileSync(file,'utf8');
    for (const name of names) if (text.includes(name)) hits.push(`${path.relative(root,file)}: ${name}`);
  }
  assert.deepEqual(hits, []);
});

test('AC-003 the SSH hosts feature stays', () => {
  for (const file of ['server/ssh-hosts.mjs','server/ssh-config.mjs','server/ssh-keys.mjs','tests/ssh-hosts.test.mjs'])
    assert.ok(fs.existsSync(path.join(root,file)), `${file} must stay`);
});
