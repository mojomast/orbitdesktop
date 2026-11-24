// MR.INDIA combo counter + per-stage STYLE grade (t_35fa8ec420214dc1). Unit part: each stat is
// tracked (max combo, juggles, specials incl. assists, damage minus special cost), milestone pops at
// 10/25/50 (and fx.js praise on the same hits, once each), per-stage reset, grade thresholds,
// screens.js S/A/B/C rank rules unchanged. Headless: live counter draws during play, the STYLE line
// lands on the stage clear card (data.style) with the rank untouched, 0 console errors.
// usage: node check-style.mjs [url] [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
const L = await import(G + 'logic.js');
const St = await import(G + 'style.js');
const Sc = await import(G + 'screens.js');
let fails = 0; const t = (n, f) => { try { const d = f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const scr = () => { const o = { m: null, data: null, mode: () => o.m, juice: { stamped: true }, t: 2 }; return o; };
const run = () => { const s = L.createState(); s.hpMode = true; s.wave = 1; s.hp = 100; s.combo = 0; s.combat = { attack: null }; s.ninjas = []; s.super = 0; return s; };
const setup = () => { const s = run(), sc = scr(), y = St.createStyle(); y.watch(s, sc); return { s, sc, y }; };

t('max combo is the longest combo of the stage', () => { const { s, sc, y } = setup(); for (const c of [1, 2, 3, 7, 0, 4]) { s.combo = c; y.watch(s, sc); } assert.equal(y.stage.maxCombo, 7); });
t('juggles count air re-launches (first launch is not a juggle)', () => {
  const { s, sc, y } = setup(); const n = { juggles: 0 }; s.ninjas.push(n); y.watch(s, sc);
  for (const j of [1, 2, 3, 0, 1, 2]) { n.juggles = j; y.watch(s, sc); } assert.equal(y.stage.juggles, 3); });
t('specials: health specials (move with a cost) and team-up assists both count, once each', () => {
  const { s, sc, y } = setup(); const sp = { name: 'upper', cost: 6 };
  s.combat.attack = sp; s.hp -= 6; y.watch(s, sc); y.watch(s, sc); s.combat.attack = { name: 'punch1' }; y.watch(s, sc);
  s.super = 100; y.watch(s, sc); s.super = 0; y.watch(s, sc);
  assert.equal(y.stage.specials, 2); assert.equal(y.stage.dmg, 0, "a special's own health cost is not damage taken"); });
t('damage taken sums HP lost', () => { const { s, sc, y } = setup(); s.hp = 92; y.watch(s, sc); s.hp = 80; y.watch(s, sc); s.hp = 100; y.watch(s, sc); s.hp = 98; y.watch(s, sc); assert.equal(y.stage.dmg, 22); });
t('milestone pops at 10, 25 and 50 only; fx praise words on the same crossings, once each', () => {
  const { s, sc, y } = setup(); const pops = [];
  for (let c = 1; c <= 60; c++) { s.combo = c; y.watch(s, sc); const p = y.pop; if (p.t === 0 && !pops.includes(p.m)) pops.push(p.m); y.draw({ save() {}, restore() {} }, 740, 510, null, sc, 0.001); }
  assert.deepEqual(pops, [10, 25, 50]);
  const words = []; for (let c = 1; c <= 60; c++) { const w = St.fxPraise(c - 1, c); if (w) words.push(c + ':' + w); }
  assert.deepEqual(words, ['10:RADICAL!', '25:TUBULAR!', '50:COWABUNGA!']); assert.equal(St.fxPraise(8, 12), 'RADICAL!', 'a multi-hit jump past 10 still pops');
  const fxSrc = fs.readFileSync(new URL('../pizza-panic/fx.js', import.meta.url), 'utf8'); assert.ok(fxSrc.includes('fxPraise(') && !fxSrc.includes("'NICE!'"), 'fx.js uses the shared milestones'); });
t('per-stage reset: the clear card finalises the stage and the next stage starts from zero', () => {
  const { s, sc, y } = setup(); s.combo = 12; y.watch(s, sc); s.hp = 90; y.watch(s, sc);
  s.wave = 2; sc.m = 'clear'; sc.data = { combo: 12, hits: 1, secs: 100, total: 2000 }; y.watch(s, sc);
  assert.equal(sc.data.style.maxCombo, 12); assert.equal(sc.data.style.dmg, 10);
  const st2 = y.stage; assert.deepEqual([st2.maxCombo, st2.juggles, st2.specials, st2.dmg, st2.wave], [0, 0, 0, 0, 2]);
  y.watch(s, sc); assert.equal(sc.data.style.maxCombo, 12, 'finalised once'); sc.m = null; s.combo = 3; y.watch(s, sc); assert.equal(y.stage.maxCombo, 3); });
t('grade thresholds: points = min(combo,50) + min(4*juggles,30) + min(5*specials,20) - floor(dmg/4); S>=60 A>=40 B>=20', () => {
  const G2 = St.styleGrade, P = St.stylePoints;
  assert.equal(P({ maxCombo: 23, juggles: 4, specials: 2, dmg: 18 }), 45); assert.equal(G2({ maxCombo: 23, juggles: 4, specials: 2, dmg: 18 }), 'A');
  assert.equal(G2({ maxCombo: 60 }), 'A', 'combo points cap at 50'); assert.equal(P({ maxCombo: 60, juggles: 99, specials: 99 }), 100); assert.equal(G2({ maxCombo: 50, juggles: 3 }), 'S');
  assert.equal(G2({ maxCombo: 40 }), 'A'); assert.equal(G2({ maxCombo: 39 }), 'B'); assert.equal(G2({ maxCombo: 20 }), 'B'); assert.equal(G2({ maxCombo: 19 }), 'C'); assert.equal(G2({ maxCombo: 30, dmg: 80 }), 'C'); assert.equal(G2({ maxCombo: 30, dmg: 40 }), 'B'); assert.equal(G2({ maxCombo: 10, dmg: 100 }), 'C');
  assert.equal(St.styleLine({ maxCombo: 23, juggles: 4, specials: 2, dmg: 18 }), 'STYLE A: max combo 23, 4 juggles, 2 specials, 18 dmg taken'); return JSON.stringify(St.STYLE_THRESHOLDS); });
t('screens.js S/A/B/C rank rules unchanged', () => {
  const R = Sc.stageRank; assert.equal(R({ hits: 0, secs: 90, total: 0 }), 'S'); assert.equal(R({ hits: 0, secs: 91, total: 0 }), 'A'); assert.equal(R({ hits: 2, secs: 50, total: 6500 }), 'A');
  assert.equal(R({ hits: 2, secs: 50, total: 6499 }), 'B'); assert.equal(R({ hits: 2, secs: 50, total: 3000 }), 'B'); assert.equal(R({ hits: 2, secs: 50, total: 2999 }), 'C'); assert.equal(R(null), 'C');
  const src = fs.readFileSync(new URL('../pizza-panic/screens.js', import.meta.url), 'utf8'); assert.ok(!/style/i.test(src.match(/export function stageRank[\s\S]*?\n}/)[0]), 'stageRank does not read style'); });

// ---- headless ----
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname;
let url = process.argv[2], server;
if (!url || url === '-') {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); url = `http://127.0.0.1:${server.address().port}/`;
}
const shots = process.argv[3];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } }); const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const ev = f => page.evaluate(f), w = ms => page.waitForTimeout(ms);
await page.goto(url); await w(1200);
for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
await page.keyboard.press('Enter'); await w(300);
for (let i = 0; i < 12 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
await w(400);
ok(await ev(() => !!window.__ppStyle && window.__ppState.wave === 1), 'in play on stage 1 with style tracking');
// Build a stage: a 26-hit combo, 18 HP lost, then clear the stage.
await ev(() => { const s = window.__ppState; s.invuln = 0; s.ninjas.forEach(n => { n.x = s.player.x + 900; n.stun = 9; }); });
for (let c = 2; c <= 26; c++) await page.evaluate(c => { const s = window.__ppState; s.combo = c; s.comboTimer = 2.4; }, c);
await w(120);
const pop = await ev(() => window.__ppStyle.pop); ok(pop.m === 25, 'live counter popped on the 25 milestone: ' + JSON.stringify(pop));
if (shots) await page.screenshot({ path: shots + '/live-counter.png' });
await ev(() => { const s = window.__ppState; s.hp -= 18; }); await w(120);
const stg = await ev(() => window.__ppStyle.stage); ok(stg.maxCombo === 26 && stg.dmg === 18, 'tracked in game: ' + JSON.stringify(stg));
await ev(async () => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas.length = 0; L.spawnWave(s); s.invuln = 99; });
for (let i = 0; i < 30 && (await ev(() => window.__ppScreens.mode())) !== 'clear'; i++) await w(100);
await w(1700);
const d = await ev(async () => { const { stageRank } = await import('./screens.js'); const d = window.__ppScreens.data; return { style: d.style, rank: d.rank, expect: stageRank(d), stamped: window.__ppScreens.juice.stamped }; });
ok(d.style && /^STYLE [SABC]: max combo 26, 0 juggles, 0 specials, 18 dmg taken$/.test(d.style.text) && d.style.grade === St.styleGrade(d.style), 'STYLE line on the stage clear card: ' + (d.style && d.style.text));
ok(d.rank === d.expect, `stage rank still from stageRank (${d.rank})`);
if (shots) await page.screenshot({ path: shots + '/stage-clear-style.png' });
await page.keyboard.press('Enter'); await w(300); await ev(() => { if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); }); await w(300);
const st3 = await ev(() => window.__ppStyle.stage); ok(st3.maxCombo === 0 && st3.dmg === 0 && st3.wave === 2, 'stage 2 starts with fresh stats: ' + JSON.stringify(st3));
ok(errors.length === 0, '0 console errors ' + errors.slice(0, 3).join(' | '));
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
