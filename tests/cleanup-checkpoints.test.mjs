// Owner decision (Kyle t1650u): the legacy fs checkpoint store is deleted.
// AC-001: server/checkpoints.mjs is gone.
// AC-002: no tracked source imports it, and the inventory no longer lists it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out=[]) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','.git','dist','vendor','experiments','docs'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('AC-001 server/checkpoints.mjs is deleted', () => {
  assert.equal(fs.existsSync(path.join(root,'server/checkpoints.mjs')), false);
});

test('AC-002 nothing imports it and the inventory does not list it', () => {
  const self = fileURLToPath(import.meta.url);
  const hits = walk(root).filter(f => f !== self && /['"][^'"]*\/checkpoints\.mjs['"]/.test(fs.readFileSync(f,'utf8')));
  assert.deepEqual(hits, []);
  const inventory = JSON.parse(fs.readFileSync(path.join(root,'docs/orbit-inventory.json'),'utf8'));
  assert.equal(JSON.stringify(inventory).includes('checkpoints.mjs'), false);
});
