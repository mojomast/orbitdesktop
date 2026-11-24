// Phase 3 (rizzstack cleanup): Kitty DOOM and IRC are cut from Orbit.
// AC-001: their modules, vendored IRC suite, tests and docs page are deleted.
// AC-002: nothing tracked in code, config, tests or CI still references them.
// AC-003: the server no longer serves /api/irc or /api/kitty-doom (404, even with the token).
// AC-004: kept features stay: health, Google Colab, SSH hosts, collab, docking, themes, token router.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {boot} from './fixtures/local-orbit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const gone = ['server/kitty-doom.mjs','server/kitty-graphics-demo.py','server/kitty-terminal-probe.py','src/kitty-doom.css','src/kitty-doom.ts',
  'tests/kitty-doom.test.mjs','verify-kitty-doom-live.mjs','server/irc.mjs','src/irc.ts','tests/irc.test.mjs','vendor/irc-suite','docs/IRC.md'];
const tokens = ['kitty-doom','KittyDoom','kittyDoom','Kitty DOOM','irc-suite','/api/irc','createIrcService','mountIrc','test:irc',"'./irc'",'"./irc"','irc.mjs','orbit://surface/irc'];
const quoted = [/['"]irc['"]/, /\birc:/, /\.irc[\s,{.:-]/];
const self = fileURLToPath(import.meta.url);

function walk(dir, out=[]) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','.git','dist','docs','experiments','contracts'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|js|cjs|ts|json|py|css|html|yml|yaml|sh)$/.test(entry.name) && !/^(orbit-inventory\.json|package-lock\.json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('AC-001 Kitty DOOM and IRC files are deleted', () => {
  for (const file of gone) assert.equal(fs.existsSync(path.join(root,file)), false, `${file} still exists`);
});

test('AC-002 nothing tracked references Kitty DOOM or IRC', () => {
  const hits = [];
  for (const file of walk(root)) {
    if (file === self || /tests\/cleanup-[^/]*\.test\.mjs$/.test(file)) continue;
    const rel = path.relative(root, file), text = fs.readFileSync(file,'utf8');
    for (const t of tokens) if (text.includes(t)) hits.push(`${rel}: ${t}`);
    if (/^(src|server|apps|examples|scripts|\.github)\//.test(rel) || rel === 'package.json')
      for (const re of quoted) if (re.test(text)) hits.push(`${rel}: ${re}`);
  }
  assert.deepEqual(hits, []);
  for (const doc of ['README.md','docs/AGENT_GUIDE.md','docs/VERIFICATION.md','docs/AGENT_PANE_SESSION.md']) {
    const text = fs.readFileSync(path.join(root,doc),'utf8');
    assert.ok(!/\bIRC\b|Kitty DOOM|kitty-doom|orbit:\/\/surface\/irc/.test(text), `${doc} still mentions IRC or Kitty DOOM`);
  }
});

test('AC-003 /api/irc and /api/kitty-doom are gone (404 with the token)', async t => {
  const {base, token} = await boot(t);
  for (const route of ['/api/irc','/api/kitty-doom']) for (const method of ['GET','POST']) {
    const res = await fetch(base+route, {method, headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body: method==='POST' ? '{}' : undefined});
    await res.arrayBuffer();
    assert.equal(res.status, 404, `${method} ${route} -> ${res.status}`);
  }
});

test('AC-004 kept features stay', async t => {
  for (const file of ['server/colab-orchestrator.mjs','src/colab-orchestrator.ts','server/ssh-hosts.mjs','server/collab.mjs','src/collab.ts',
    'src/docking-renderer.ts','src/themes.ts','src/theme-picker.ts','server/router-supervisor.mjs','server/grokbots-app.mjs','server/shared-agents.mjs'])
    assert.ok(fs.existsSync(path.join(root,file)), `${file} must stay`);
  const {base, token} = await boot(t);
  assert.equal((await fetch(base+'/api/health')).status, 200);
  const colab = await fetch(base+'/api/colab-runtime', {headers:{Authorization:`Bearer ${token}`}}); await colab.arrayBuffer();
  assert.notEqual(colab.status, 404, 'Google Colab route must stay');
  const hosts = await fetch(base+'/api/hosts', {headers:{Authorization:`Bearer ${token}`}}); await hosts.arrayBuffer();
  assert.notEqual(hosts.status, 404, 'SSH hosts route must stay');
});
