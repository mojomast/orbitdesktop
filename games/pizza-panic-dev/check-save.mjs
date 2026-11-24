// MR.INDIA stage checkpoint save (t_1a56b31774f34ff9). Unit part: round-trip, sandbox fallback
// (store/localStorage throws -> in-memory, no crash), corrupt / out-of-range saves ignored and
// dropped, save on stage clear + shop close, resume restores the run, victory clears it.
// Headless part: title shows CONTINUE only when a save exists, CONTINUE starts the saved stage
// with the saved hero/difficulty/coins/score (no intro), CLEAR SAVE works, sandboxed storage
// boots with 0 console errors.  usage: node check-save.mjs [url] [screenshot.png]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
const L = await import(G + 'logic.js');
const S = await import(G + 'save.js');
let fails = 0; const t = (n, f) => { try { const d = f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const mapStore = () => { const m = new Map(); return { m, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)) }; };
const throwing = { get() { throw new Error('SecurityError'); }, set() { throw new Error('SecurityError'); } };
const run = (wave = 3) => { const s = L.createState(); s.hpMode = true; s.selectedHero = 'turtle_red'; s.difficulty = 'hard'; s.wave = wave; s.coins = 140; s.score = 23450; s.lives = 4;
  s.shopBuys = { hp: 1, dmg: 2, life: 0, meter: 1, ammo: 0 }; s.maxHp = 125; s.dmgMult = 1.3; s.weaponLevel = 2; s.superStart = 50; return s; };

t('round-trip: save then load returns stage, hero, difficulty, coins, upgrades and score', () => {
  const st = mapStore(), c = S.createCheckpoint({ store: st }); assert.equal(c.load(), null); assert.ok(c.save(run(3)));
  const d = S.createCheckpoint({ store: st }).load(); // a fresh instance reads it back (persisted)
  assert.deepEqual([d.wave, d.hero, d.difficulty, d.coins, d.score, d.lives, d.maxHp, d.dmgMult, d.weaponLevel, d.superStart], [3, 'turtle_red', 'hard', 140, 23450, 4, 125, 1.3, 2, 50]);
  assert.deepEqual(d.shopBuys, { hp: 1, dmg: 2, life: 0, meter: 1, ammo: 0 }); return `(key ${S.SAVE_KEY})`;
});
t('sandbox fallback: a store that throws degrades to memory, no crash, still loads this session', () => {
  const c = S.createCheckpoint({ store: throwing }); assert.equal(c.load(), null); assert.ok(c.save(run(4))); assert.equal(c.load().wave, 4); c.clear(); assert.equal(c.load(), null);
});
t('sandbox fallback: no store given and localStorage itself throws on access -> memory', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try { const c = S.createCheckpoint(); assert.equal(c.load(), null); c.save(run(2)); assert.equal(c.load().wave, 2); }
  finally { if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage; }
});
t('corrupted / invalid saves are ignored safely and dropped', () => {
  const bad = ['{not json', '[]', 'null', '42', JSON.stringify({ v: 1, wave: 99, hero: 'turtle_red' }), JSON.stringify({ v: 1, wave: 1, hero: 'turtle_red' }),
    JSON.stringify({ v: 1, wave: -3, hero: 'turtle_red' }), JSON.stringify({ v: 1, wave: 'x', hero: 'turtle_red' }), JSON.stringify({ v: 1, wave: 3, hero: 'shredder' }), JSON.stringify({ v: 9, wave: 3, hero: 'turtle_red' })];
  for (const raw of bad) { const st = mapStore(); st.set(S.SAVE_KEY, raw); const c = S.createCheckpoint({ store: st }); assert.equal(c.load(), null, raw); assert.equal(c.has(), false); assert.ok(!st.get(S.SAVE_KEY), 'dropped ' + raw); }
  const st = mapStore(); st.set(S.SAVE_KEY, JSON.stringify({ v: 1, wave: 3, hero: 'turtle_red', difficulty: 'insane', coins: -5, score: 'lots' }));
  const d = S.createCheckpoint({ store: st }).load(); assert.deepEqual([d.difficulty, d.coins, d.score], ['normal', 0, 0]); return `(${bad.length} bad payloads; stage range 2..${L.LEVEL_ORDER.length})`;
});
t('watch: saves the next stage when the wave advances and again when the shop closes; nothing before stage 2', () => {
  const st = mapStore(), c = S.createCheckpoint({ store: st }), s = run(1);
  c.watch(s, {}); assert.equal(c.load(), null);
  s.wave = 2; s.coins = 60; c.watch(s, { shop: true }); assert.equal(c.load().wave, 2); assert.equal(c.load().coins, 60);
  s.coins = 10; s.shopBuys.hp = 2; c.watch(s, { shop: true }); assert.equal(c.load().coins, 60);
  c.watch(s, { shop: false }); assert.equal(c.load().coins, 10); assert.equal(c.load().shopBuys.hp, 2);
});
t('watch: final victory clears the save; a game over keeps it (that is when you continue)', () => {
  const st = mapStore(), c = S.createCheckpoint({ store: st }), s = run(1); c.watch(s, {}); s.wave = 5; c.watch(s, {});
  s.over = true; c.watch(s, {}); assert.equal(c.load().wave, 5);
  const s2 = run(1); c.watch(s2, {}); s2.wave = L.LEVEL_ORDER.length; c.watch(s2, {}); s2.runComplete = true; c.watch(s2, {}); assert.equal(c.load(), null);
});
t('resume: a fresh run jumps to the saved stage with every saved field', () => {
  const st = mapStore(), c = S.createCheckpoint({ store: st }); c.save(run(5));
  const s = L.createState(); s.hpMode = true; s.selectedHero = 'turtle_blue'; L.spawnWave(s); assert.equal(s.wave, 1);
  assert.equal(c.resume(s), false, 'not armed -> normal start'); assert.ok(c.arm()); assert.ok(c.resume(s));
  assert.deepEqual([s.wave, s.level, s.selectedHero, s.difficulty, s.coins, s.score, s.lives, s.maxHp, s.hp, s.dmgMult, s.weaponLevel, s.superStart],
    [5, L.levelForWave(5), 'turtle_red', 'hard', 140, 23450, 4, 125, 125, 1.3, 2, 50]); return `(stage 5 = level ${s.level})`;
});
t('title menu keys: Up/Down wrap, CLEAR SAVE clears, no save -> menu not shown', () => {
  const st = mapStore(), c = S.createCheckpoint({ store: st }); assert.equal(c.menuKey({ code: 'Enter' }), null); c.save(run(3));
  assert.match(c.items()[0], /CONTINUE FROM STAGE 3/); assert.equal(c.menuKey({ code: 'ArrowUp' }), 'nav'); assert.equal(c.sel, 2);
  assert.equal(c.menuKey({ code: 'Enter' }), 'clear'); assert.equal(c.has(), false); assert.equal(c.items(), null);
});

// ---- headless: real title, continue, clear, sandbox ----
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
const shot = process.argv[3];
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
async function open(ctx) {
  const page = await ctx.newPage(), errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(url); await page.waitForTimeout(1200);
  await page.keyboard.press('KeyX'); await page.waitForTimeout(200);
  for (let i = 0; i < 40 && !(await page.evaluate(() => window.__ppTitle?.ready?.())); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  return { page, errors };
}
const SEED = { v: 1, wave: 4, hero: 'turbofit', difficulty: 'easy', coins: 77, score: 12345, lives: 2, maxHp: 115, dmgMult: 1.15, weaponLevel: 1, superStart: 0, shopBuys: { hp: 1, dmg: 1 } };
const vp = { viewport: { width: 740, height: 510 } };
// 1) no save -> PRESS START starts the normal select flow
{ const ctx = await browser.newContext(vp); const { page, errors } = await open(ctx);
  ok(await page.evaluate(() => window.__ppTitle.ready() && !window.__ppSave.has()), 'title ready, no save -> no CONTINUE menu');
  await page.keyboard.press('Enter'); await page.waitForTimeout(250); ok(await page.evaluate(() => window.__ppSelect.active), 'no save: PRESS START goes to character select');
  ok(errors.length === 0, 'no-save boot: 0 console errors ' + errors.slice(0, 3).join(' | ')); await ctx.close(); }
// 2) saved run -> CONTINUE FROM STAGE 4 shown; continue starts there; then CLEAR SAVE
{ const ctx = await browser.newContext(vp); await ctx.addInitScript(d => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('pizzaPanicCheckpoint', d); sessionStorage.setItem('seeded', '1'); } } catch {} }, JSON.stringify(SEED));
  const { page, errors } = await open(ctx);
  const items = await page.evaluate(() => window.__ppSave.items()); ok(items && items[0] === 'CONTINUE FROM STAGE 4' && items[2] === 'CLEAR SAVE', 'title menu: ' + JSON.stringify(items));
  if (shot) { await page.waitForTimeout(300); await page.screenshot({ path: shot }); }
  await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  const st = await page.evaluate(() => { const s = window.__ppState; return s && { wave: s.wave, level: s.level, hero: s.selectedHero, diff: s.difficulty, coins: s.coins, score: s.score, lives: s.lives, maxHp: s.maxHp, cine: window.__ppCinema.isActive?.(), title: window.__ppTitle.isActive() }; });
  ok(st && st.wave === 4 && st.level === L.levelForWave(4) && st.hero === 'turbofit' && st.diff === 'easy' && st.coins === 77 && st.score === 12345 && st.lives === 2 && st.maxHp === 115, 'CONTINUE starts stage 4 with saved hero/difficulty/coins/score: ' + JSON.stringify(st));
  ok(st && !st.cine && !st.title, 'continue skips the intro cinematic');
  await page.waitForTimeout(1500); ok(await page.evaluate(() => window.__ppState.wave === 4 && !window.__ppState.over), 'stage 4 keeps running');
  await page.reload(); await page.waitForTimeout(1200); await page.keyboard.press('KeyX'); await page.waitForTimeout(200);
  for (let i = 0; i < 40 && !(await page.evaluate(() => window.__ppTitle?.ready?.())); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  ok(await page.evaluate(() => window.__ppSave.has()), 'save persists across a reload');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  ok(await page.evaluate(() => !window.__ppSave.has() && localStorage.getItem('pizzaPanicCheckpoint') !== JSON.stringify(window.__seed)), 'CLEAR SAVE removes the save');
  await page.keyboard.press('Enter'); await page.waitForTimeout(250); ok(await page.evaluate(() => window.__ppSelect.active), 'after clearing, PRESS START goes to the normal select');
  ok(errors.length === 0, 'save flow: 0 console errors ' + errors.slice(0, 3).join(' | ')); await ctx.close(); }
// 3) sandboxed origin: localStorage access throws -> boots, saves in memory, 0 errors
{ const ctx = await browser.newContext(vp); await ctx.addInitScript(() => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } }); });
  const { page, errors } = await open(ctx);
  const r = await page.evaluate(() => { const s = { hpMode: true, wave: 1, selectedHero: 'turtle_blue', difficulty: 'normal', coins: 5, score: 9 }; const c = window.__ppSave; c.watch(s, {}); s.wave = 3; c.watch(s, {}); return c.load() && c.load().wave; });
  ok(r === 3, 'sandboxed storage: save kept in memory (stage ' + r + ')');
  ok(errors.length === 0, 'sandboxed boot: 0 console errors ' + errors.slice(0, 3).join(' | ')); await ctx.close(); }
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
