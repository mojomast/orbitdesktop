// MR.INDIA first-run coach marks (t_6ebf4f0c9c624d89). Unit: cards advance on the real actions,
// timeouts, skip, flag persistence, throwing store -> memory, force flags. Headless: first NEW GAME shows
// the cards over live gameplay (no freeze), real key presses advance them, Enter skips, the flag survives a
// reload, ?coach=0 skips / ?coach=1 forces, CONTINUE runs never show them, sandboxed storage works, 0 errors.
// usage: node check-coach.mjs [url] [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
const Co = await import(G + 'coach.js');
let fails = 0; const t = (n, f) => { try { const d = f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const mapStore = () => { const m = new Map(); return { m, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)) }; };
const throwing = { get() { throw new Error('SecurityError'); }, set() { throw new Error('SecurityError'); } };
const mk = () => ({ player: { x: 100, y: 400 }, combat: { attack: null, grab: null }, over: false });
const live = { live: true }, DT = 1 / 60;

t('4 cards: move, punch/kick, special, grab/throw, each with keyboard and pad hints', () => {
  assert.deepEqual(Co.CARDS.map(c => c.id), ['move', 'attack', 'special', 'grab']); assert.ok(Co.CARDS.every(c => c.keys && c.pad && c.time > 0 && c.time <= 12)); });
t('first run shows the cards; performing each action advances; completing sets the flag', () => {
  const st = mapStore(), c = Co.createCoach({ store: st }), s = mk(); assert.ok(c.begin(s)); assert.equal(c.card, 'move');
  c.update(s, DT, { live: false }); s.player.x += 200; c.update(s, DT, { live: false }); assert.equal(c.card, 'move', 'nothing happens while not live');
  c.update(s, DT, live); for (let i = 0; i < 10; i++) { s.player.x += 12; c.update(s, DT, live); } assert.equal(c.card, 'attack');
  s.combat.attack = { name: 'punch1' }; c.update(s, DT, live); assert.equal(c.card, 'attack'); s.combat.attack = { name: 'kick' }; c.update(s, DT, live); assert.equal(c.card, 'special');
  s.combat.attack = { name: 'upper', cost: 6 }; c.update(s, DT, live); assert.equal(c.card, 'grab');
  s.combat.attack = null; c.update(s, DT, live); s.combat.grab = { n: {} }; c.update(s, DT, live);
  assert.equal(c.active, false); assert.equal(st.get(Co.COACH_KEY), '1'); assert.equal(c.stats.completed, 1); assert.ok(c.done.every(d => d.how === 'did')); });
t('timeouts: a card never blocks (advances after its time)', () => {
  const c = Co.createCoach({ store: mapStore() }), s = mk(); c.begin(s); for (let i = 0; i < 60 * 10; i++) c.update(s, DT, live); assert.equal(c.card, 'attack'); });
t('skip: Enter skips one card, Esc dismisses all and acknowledges', () => {
  const st = mapStore(), c = Co.createCoach({ store: st }), s = mk(); c.begin(s);
  assert.equal(c.handleKey({ code: 'Enter' }), false, 'no keys eaten before the card is on screen'); c.update(s, DT, live);
  assert.ok(c.handleKey({ code: 'Enter' })); assert.equal(c.card, 'attack'); assert.equal(c.handleKey({ code: 'KeyJ' }), false, 'gameplay keys pass through');
  assert.equal(c.handleKey({ code: 'Escape' }), false, 'Esc is passed on (pause still opens)'); assert.equal(c.active, false); assert.equal(st.get(Co.COACH_KEY), '1'); assert.equal(c.handleKey({ code: 'Enter' }), false, 'no keys eaten afterwards'); });
t('flag persists: a new instance on the same store does not show the cards', () => {
  const st = mapStore(); st.set(Co.COACH_KEY, '1'); const c = Co.createCoach({ store: st }); assert.equal(c.begin(mk()), false); assert.equal(c.active, false); });
t('sandbox: throwing store falls back to memory, no crash, acknowledged for the session', () => {
  const c = Co.createCoach({ store: throwing }), s = mk(); assert.ok(c.begin(s)); c.update(s, DT, live); c.handleKey({ code: 'Escape' }); assert.ok(c.acknowledged()); assert.equal(c.begin(mk()), false); });
t('force flags: force(false) skips (replay flag), force(true) shows even when acknowledged, reset clears', () => {
  const st = mapStore(); st.set(Co.COACH_KEY, '1'); const c = Co.createCoach({ store: st }); c.force(true); assert.ok(c.begin(mk()));
  const c2 = Co.createCoach({ store: mapStore() }); c2.force(false); assert.equal(c2.begin(mk()), false); c2.force(null); assert.ok(c2.begin(mk()));
  c.force(null); c.reset(); assert.equal(c.acknowledged(), false); });

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
const vp = { viewport: { width: 740, height: 510 } };
async function newGame(page, q = '') {
  await page.goto(url + q); await page.waitForTimeout(1200);
  for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
  await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  for (let i = 0; i < 14 && await page.evaluate(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await page.waitForTimeout(500);
}
const watchErrors = page => { const errors = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); }); return errors; };
const hold = async (page, key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
{ // first run: real inputs advance the cards; gameplay keeps running
  const ctx = await browser.newContext(vp), page = await ctx.newPage(), errors = watchErrors(page);
  await newGame(page);
  ok(await page.evaluate(() => window.__ppCoach.active && window.__ppCoach.card === 'move'), 'first NEW GAME: MOVE card shows over gameplay');
  await page.evaluate(() => { window.__ppState.invuln = 99; for (const n of window.__ppState.ninjas) n.x += 600; });
  const x0 = await page.evaluate(() => window.__ppState.player.x);
  if (shots) await page.screenshot({ path: shots + '/coach-move.png' });
  await hold(page, 'ArrowRight', 700); await page.waitForTimeout(100);
  ok(await page.evaluate(x0 => window.__ppState.player.x > x0 + 60, x0), 'gameplay is live (hero moved) while the card shows');
  ok(await page.evaluate(() => window.__ppCoach.card === 'attack'), 'moving advances to ATTACK');
  if (shots) await page.screenshot({ path: shots + '/coach-attack.png' });
  for (const k of ['KeyJ', 'KeyK']) { await page.keyboard.press(k); await page.waitForTimeout(450); }
  ok(await page.evaluate(() => window.__ppCoach.card === 'special'), 'punch + kick advance to SPECIAL');
  if (shots) await page.screenshot({ path: shots + '/coach-special.png' });
  await page.keyboard.down('KeyJ'); await page.keyboard.down('KeyL'); await page.waitForTimeout(60); await page.keyboard.up('KeyJ'); await page.keyboard.up('KeyL'); await page.waitForTimeout(700);
  ok(await page.evaluate(() => window.__ppCoach.card === 'grab'), 'J+L special advances to GRAB & THROW');
  if (shots) await page.screenshot({ path: shots + '/coach-grab.png' });
  await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  ok(await page.evaluate(() => !window.__ppCoach.active && window.__ppCoach.acknowledged()), 'Enter skips the last card; flag set');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150); ok(await page.evaluate(() => window.__ppPause ? window.__ppPause.isOpen() : true), 'Esc pauses again once the cards are gone');
  await newGame(page); ok(await page.evaluate(() => !window.__ppCoach.active), 'after a reload the flag persists: no cards');
  await newGame(page, '?coach=1'); ok(await page.evaluate(() => window.__ppCoach.active), '?coach=1 force-shows');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150); ok(await page.evaluate(() => !window.__ppCoach.active && window.__ppCoach.acknowledged()), 'Esc / pad START dismisses all cards (pause opens as usual)');
  ok(errors.length === 0, 'first-run flow: 0 console errors ' + errors.slice(0, 3).join(' | ')); await ctx.close();
}
{ // replay flag skips on a fresh profile
  const ctx = await browser.newContext(vp), page = await ctx.newPage(), errors = watchErrors(page);
  await newGame(page, '?coach=0'); ok(await page.evaluate(() => !window.__ppCoach.active && window.__ppState.wave >= 1), '?coach=0 skips the cards on a fresh profile');
  ok(errors.length === 0, 'replay flag: 0 console errors'); await ctx.close();
}
{ // CONTINUE runs never show the cards
  const ctx = await browser.newContext(vp), page = await ctx.newPage(), errors = watchErrors(page);
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('pizzaPanicCheckpoint', JSON.stringify({ v: 1, wave: 3, hero: 'turtle_red', difficulty: 'normal', coins: 10, score: 500, lives: 3, maxHp: 100, dmgMult: 1, weaponLevel: 1, superStart: 0, shopBuys: {} })); sessionStorage.setItem('seeded', '1'); } } catch {} });
  await page.goto(url); await page.waitForTimeout(1200); await page.keyboard.press('KeyX'); await page.waitForTimeout(200);
  for (let i = 0; i < 40 && !(await page.evaluate(() => window.__ppTitle?.ready?.())); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await page.keyboard.press('Enter'); await page.waitForTimeout(800);
  ok(await page.evaluate(() => window.__ppState && window.__ppState.wave === 3 && !window.__ppCoach.active && !window.__ppCoach.acknowledged()), 'CONTINUE run: no cards (and the flag is untouched)');
  ok(errors.length === 0, 'continue: 0 console errors'); await ctx.close();
}
{ // sandboxed origin
  const ctx = await browser.newContext(vp), page = await ctx.newPage(), errors = watchErrors(page);
  await ctx.addInitScript(() => { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } }); });
  await newGame(page); const a = await page.evaluate(() => window.__ppCoach.active);
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  ok(a && await page.evaluate(() => !window.__ppCoach.active && window.__ppCoach.acknowledged()), 'sandboxed storage: cards show, Esc acknowledges in memory');
  ok(errors.length === 0, 'sandboxed: 0 console errors ' + errors.slice(0, 3).join(' | ')); await ctx.close();
}
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
