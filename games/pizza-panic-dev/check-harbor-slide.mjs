// MR.INDIA harbor wet-plank slide teleport fix (t_7dabfde5245b4d9d). harbor.step derives slide momentum from the
// frame-to-frame position delta, so a teleport / forced snap onto wet planks used to become a huge slide.
// Node part (deterministic, harbor.step at 60 fps): teleports give no rocket slide, walking / dashing slide exactly
// as before (BASE values measured on the pre-fix code), knockback / forced moves are bounded. Browser part: an
// in-game teleport on the docks doesn't slide and the page logs 0 console errors.
// usage: node check-harbor-slide.mjs [--measure]   (--measure prints the raw numbers only)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module'; import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const G = new URL('../pizza-panic/', import.meta.url).href, GAME = new URL('../pizza-panic/', import.meta.url).pathname;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const L = await import(G + 'logic.js'); const C = await import(G + 'combat.js');
const HD = await import(G + 'harbor-data.js'); const H = await import(G + 'harbor.js');
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const LV = HD.HARBOR_LEVEL_INDEX, DT = 1 / 60, X0 = 2660; // wet zone 2650..3350, no crane within reach of the test runs
const fresh = () => { const s = L.createState(); s.hpMode = true; s.level = LV; s.wave = L.LEVEL_ORDER.indexOf(LV) + 1; C.createCombat(s); s.player.x = X0; s.player.y = 430; s.harbor = undefined; return s; };
// Run a scenario: a list of [frames, perFrame(s)] phases; returns the slide the planks added (total - scripted moves).
function run(phases) {
  const h = H.createHarbor(), s = fresh(); h.step(s, DT);
  let scripted = 0; const start = s.player.x;
  for (const [n, f] of phases) for (let i = 0; i < n; i++) { const x = s.player.x; f(s); scripted += s.player.x - x; h.step(s, DT); }
  for (let i = 0; i < 240; i++) { s.combat.moving = false; s.playerDown = 0; h.step(s, DT); }
  return Math.round((s.player.x - start - scripted) * 10) / 10; // extra travel the planks added on top of the scripted moves
}
const walk = sp => s => { s.combat.moving = true; s.player.x += sp * DT; };
const idle = s => { s.combat.moving = false; };
const SC = {
  walkRelease: [[40, walk(220)]],
  dashRelease: [[5, idle], [11, s => { s.combat.moving = false; s.player.x += 760 * DT; }]],
  slowWalk: [[40, walk(110)]],
  teleportIdle: [[10, idle], [1, s => { s.player.x += 200; s.combat.moving = false; }]],
  teleportWalking: [[10, walk(220)], [1, s => { s.player.x += 200; }], [5, walk(220)]],
  knockback600: [[15, s => { s.playerDown = 0.5; s.combat.moving = false; s.player.x += 600 * DT; }]],
  forcedPull3000: [[6, s => { s.playerDown = 0.5; s.combat.moving = false; s.player.x += 3000 * DT; }]],
  teleportOnRelease: [[10, walk(220)], [1, s => { s.player.x += 200; s.combat.moving = true; }]],
  teleportFromDry: [[1, s => { s.player.x = 2400; }], [10, idle], [1, s => { s.player.x = 2700; s.combat.moving = false; }]],
  forcedPush1200: [[12, s => { s.playerDown = 0.5; s.combat.moving = false; s.player.x += 1200 * DT; }]],
  lunge132: [[5, idle], [1, s => { s.player.x += 132; }]],
};
const R = Object.fromEntries(Object.entries(SC).map(([k, v]) => [k, run(v)]));
if (process.argv.includes('--measure')) { console.log(JSON.stringify(R)); process.exit(0); }
// Pre-fix harbor.js (harbor.js.bak-slide) measured with --measure:
// {"walkRelease":95.1,"dashRelease":345.1,"slowWalk":44.1,"teleportIdle":578.7,"teleportWalking":95.1,"knockback600":270.9,
//  "forcedPull3000":390.4,"teleportOnRelease":578.7,"teleportFromDry":868,"lunge132":614.2}  (teleports ran to the end of the wet zone)
const BASE = { walkRelease: 95.1, dashRelease: 345.1, slowWalk: 44.1, teleportWalking: 95.1, knockback600: 270.9 };
const CAP = 800 / 2.2 + 30; // the most any slide can add once velocity is clamped to dash speed (~394 px)
await t('teleports onto wet planks give no rocket slide (< 12 px; were 579-868 px)', () => {
  for (const k of ['teleportIdle', 'teleportOnRelease', 'teleportFromDry', 'lunge132']) assert.ok(Math.abs(R[k]) < 12, `${k} slid ${R[k]}px`);
  return `(idle ${R.teleportIdle}, on release ${R.teleportOnRelease}, from dry ${R.teleportFromDry}, 132px lunge ${R.lunge132})`; });
await t('normal wet-plank sliding unchanged (walk, slow walk, dash, walk-through teleport, knockback within 2 px of pre-fix)', () => {
  for (const [k, v] of Object.entries(BASE)) assert.ok(Math.abs(R[k] - v) <= 2, `${k} ${R[k]} vs ${v}`);
  return `(walk ${R.walkRelease}, slow ${R.slowWalk}, dash ${R.dashRelease}, knockback ${R.knockback600})`; });
await t('knockback / forced moves onto planks are bounded', () => {
  for (const k of ['knockback600', 'forcedPush1200', 'forcedPull3000']) assert.ok(Math.abs(R[k]) <= CAP, `${k} ${R[k]} > ${CAP}`);
  return `(600 px/s ${R.knockback600}, 1200 px/s ${R.forcedPush1200}, 3000 px/s ${R.forcedPull3000}; cap ${Math.round(CAP)})`; });

// Browser: the same teleport in the running game on the docks.
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(GAME, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(GAME) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); const page = await browser.newPage({ viewport: { width: 740, height: 510 } }); const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const ev = (f, a) => page.evaluate(f, a), w = ms => page.waitForTimeout(ms);
await page.goto(`http://127.0.0.1:${server.address().port}/?coach=0&wipe=0`); await w(1200);
for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
await page.keyboard.press('Enter'); await w(300);
for (let i = 0; i < 14 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
await t('in game: a teleport onto the wet planks does not slide', async () => {
  await ev(async () => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas.length = 0; s.wave = L.LEVEL_ORDER.indexOf(6); L.spawnWave(s); });
  for (let i = 0; i < 25; i++) { await w(100); if (await ev(() => window.__ppScreens.mode())) { await w(1300); await page.keyboard.press('Enter'); await w(200); break; } }
  for (let i = 0; i < 6; i++) { await ev(() => { const B = window.__ppBonus; if (B && B.active()) { try { B.finish(); } catch {} try { B.close(); } catch {} } if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); }); await w(150); }
  const r = await ev(async () => { const s = window.__ppState; const wait = ms => new Promise(r => setTimeout(r, ms));
    const iv = setInterval(() => { s.ninjas.length = 0; if (s.events) s.events.lock = null; }, 10); // no arena lock / foes: only the planks move the hero
    s.player.x = 1000; s.player.y = 430; await wait(900);
    const x0 = s.player.x, x1 = x0 + 220; s.player.x = x1; await wait(1200); clearInterval(iv);
    return { level: s.level, x0, x1, x2: s.player.x, jumps: s.harbor && s.harbor.jumps }; });
  assert.equal(r.level, 6); assert.ok(Math.abs(r.x2 - r.x1) < 20, `slid ${Math.round(r.x2 - r.x1)}px ${JSON.stringify(r)}`);
  return `(moved ${Math.round(r.x2 - r.x1)}px after a 220px teleport; jumps seen ${r.jumps})`; });
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
