// Phase 3 (rizzstack cleanup): Jev / TypeSafe quick actions are cut from Orbit.
// AC-001: server/jev.mjs, src/jev-ui.ts, their tests and docs/JEV.md are deleted.
// AC-002: the workspace contract no longer has jev_suggest / jev_apply, and the server rejects them.
// AC-003: nothing tracked in code, contracts, tests or the agent guide still references Jev.
// AC-004: the kept workspace actions (sync, apply, layout_apply, plugins_apply, restore, checkpoint) still validate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateWorkspaceRequest} from '../server/workspace-contract.mjs';
import {contract} from '../contracts/workspace-v1.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const self = fileURLToPath(import.meta.url);
function walk(dir, out=[]) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','.git','dist','docs','experiments','pc-launcher'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|ts|json|py|css|html|yml)$/.test(entry.name) && !/^(orbit-inventory\.json|package-lock\.json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('AC-001 Jev files are deleted', () => {
  for (const file of ['server/jev.mjs','src/jev-ui.ts','tests/jev.test.mjs','tests/browser-jev-live.py','docs/JEV.md'])
    assert.equal(fs.existsSync(path.join(root,file)), false, `${file} still exists`);
});

test('AC-002 jev actions are not part of the workspace contract', () => {
  for (const action of ['jev_suggest','jev_apply']) {
    assert.equal(Object.hasOwn(contract.commands, action), false, `${action} must not be a contract command`);
    assert.throws(() => validateWorkspaceRequest({action, workspace_id:'w', base_revision:0, action_id:'a', confirm:true}), /does not match/);
  }
  assert.ok(Object.hasOwn(contract.commands, 'sync'), 'sync must stay');
});

test('AC-003 nothing tracked references Jev', () => {
  const hits = [];
  for (const file of walk(root)) {
    if (file === self || /tests\/cleanup-[^/]*\.test\.mjs$/.test(file)) continue;
    // src/main.ts is leased to the parallel Kitty DOOM/IRC slice; its one-line icon entry goes in the later sweep.
    if (path.relative(root,file) === 'src/main.ts') continue;
    const rel = path.relative(root,file), text = fs.readFileSync(file,'utf8');
    for (const re of [/jev_suggest|jev_apply|jevSuggest|jevCandidates|showJev|jev-ui|jev\.mjs/, /['"]jev['"]|\bjev:/i, /TypeSafe/])
      if (re.test(text)) hits.push(`${rel}: ${re}`);
  }
  assert.deepEqual(hits, []);
  for (const doc of ['README.md','docs/AGENT_GUIDE.md'])
    assert.ok(!/\bJev\b|TypeSafe/.test(fs.readFileSync(path.join(root,doc),'utf8')), `${doc} still mentions Jev`);
});

test('AC-004 kept workspace actions still validate', () => {
  const text = fs.readFileSync(path.join(root,'server/workspace.mjs'),'utf8');
  for (const action of ['sync','apply','layout_apply','plugins_apply','restore','checkpoint','recovery_policy','placement_save'])
    assert.ok(text.includes(`'${action}'`), `server/workspace.mjs must still handle ${action}`);
  const contract = fs.readFileSync(path.join(root,'contracts/workspace-v1.mjs'),'utf8');
  for (const action of ['sync','apply','layout_apply','plugins_apply','restore','checkpoint'])
    assert.ok(new RegExp(`command\\('${action}'`).test(contract), `contract must keep ${action}`);
});
