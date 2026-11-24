// baba_booey world map interstitial (t_5f5d1eed411041b2): assets/map/ holds map.jpg + map_ui.png (+ MANIFEST.md);
// between stages (after the clear card, bonus and shop) a ~2.5 s map shows, freezes play, moves the pin from the
// cleared stage to the next one by NAME, stamps cleared stages, pulses the next node; any key or pad button skips;
// reduced motion is one static frame; the wipe plays after it; the checkpoint save still lands; 0 console errors.
// usage: node check-worldmap.mjs [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const M = await import(path.join(GAME, 'worldmap.js')); const { LEVELS } = await import(path.join(GAME, 'collision.js')); const { LEVEL_ORDER } = await import(path.join(GAME, 'logic.js'));
await t('assets: map.jpg 960x540, map_ui.png paletted atlas, MANIFEST, 2 runtime files', () => {
  const d = path.join(GAME, 'assets/map'), files = fs.readdirSync(d).sort();
  assert.deepEqual(files.filter(f => !f.endsWith('.md') && !f.includes('.bak')), ['map.jpg', 'map_ui.png']); assert.ok(files.includes('MANIFEST.md'));
  const j = fs.readFileSync(path.join(d, 'map.jpg')); assert.equal(j.readUInt16BE(0), 0xffd8);
  let i = 2, wh = null; while (i < j.length) { const m = j[i + 1], L = j.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) { wh = [j.readUInt16BE(i + 7), j.readUInt16BE(i + 5)]; break; } i += 2 + L; }
  assert.deepEqual(wh, M.MAP_SIZE);
  const p = fs.readFileSync(path.join(d, 'map_ui.png')); const W = p.readUInt32BE(16), H = p.readUInt32BE(20); assert.equal(p[25], 3, 'paletted');
  for (const [k, f] of Object.entries(M.MAP_UI)) assert.ok(f[0] >= 0 && f[1] >= 0 && f[0] + f[2] <= W && f[1] + f[3] <= H, k);
  const kb = Math.round((j.length + p.length) / 1024); assert.ok(kb < 260, kb + ' KB'); return `(${kb} KB)`; });
await t('every stage has a node by name; all on the map', () => {
  for (const lv of LEVEL_ORDER) { const n = LEVELS[lv].id, xy = M.MAP_NODES[n]; assert.ok(xy, n); assert.ok(xy[0] > 0 && xy[0] < 960 && xy[1] > 0 && xy[1] < 540, n); assert.ok(M.STAGE_TITLES[n], n); } });
await t('node-side: cleared list follows LEVEL_ORDER, a mid-play level poke shows nothing, a new state resets', () => {
  const m = M.createWorldMap(); const ctx = new Proxy({}, { get: () => () => {} }); const s = { level: 0 };
  m.draw(ctx, 740, 510, s, 0.016, true); s.level = 1; m.draw(ctx, 740, 510, s, 0.016, true); assert.ok(!m.active(), 'poked mid-play');
  m.draw(ctx, 740, 510, s, 0.016, false); s.level = 3; m.draw(ctx, 740, 510, s, 0.016, true); assert.ok(m.active(), 'after a gate');
  assert.deepEqual(m.state.cleared, ['sewer', 'street']); assert.equal(m.state.to, 'skate');
  for (let i = 0; i < 40; i++) m.draw(ctx, 740, 510, s, 0.1, true); assert.ok(!m.active(), 'auto-closes');
  m.draw(ctx, 740, 510, s, 0.016, false); s.level = 1; m.draw(ctx, 740, 510, s, 0.016, true); assert.ok(!m.active(), 'never backwards');
  const s2 = { level: 5 }; m.draw(ctx, 740, 510, s2, 0.016, false); m.draw(ctx, 740, 510, s2, 0.016, true); assert.ok(!m.active(), 'new run / resumed save'); });

const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(GAME, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(GAME) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const base = `http://127.0.0.1:${server.address().port}/`;
const shots = process.argv[2];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); const page = await browser.newPage({ viewport: { width: 740, height: 510 } }); const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const ev = (f, a) => page.evaluate(f, a), w = ms => page.waitForTimeout(ms);
await page.goto(base + '?coach=0&map=1'); await w(1200);
for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
await page.keyboard.press('Enter'); await w(300);
for (let i = 0; i < 14 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
await w(400);
// clear the current stage through the real flow: clear card -> (bonus) -> shop -> next stage
async function goLevel(level) {
  await ev(async lv => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas.length = 0; s.wave = L.LEVEL_ORDER.indexOf(lv); L.spawnWave(s); }, level);
  for (let i = 0; i < 25; i++) { await w(100); if (await ev(() => window.__ppScreens.mode())) { await w(1300); await page.keyboard.press('Enter'); await w(200); break; } }
  for (let i = 0; i < 6 && !(await ev(() => window.__ppMap.active())); i++) {
    await ev(() => { const B = window.__ppBonus; if (B && B.active()) { try { B.finish(); } catch {} try { B.close(); } catch {} } if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); }); await w(150);
  }
  for (let i = 0; i < 20 && !(await ev(() => window.__ppMap.active())); i++) await w(25);
  return ev(() => ({ level: window.__ppState.level, map: window.__ppMap.state, active: window.__ppMap.active() }));
}
await t('images load; no map at run start; enabled with ?map=1', async () => {
  const r = await ev(() => ({ map: !!window.__ppMap.images.map, ui: !!window.__ppMap.images.ui, n: window.__ppMap.stats().shown, off: window.__ppMap.off }));
  assert.deepEqual(r, { map: true, ui: true, n: 0, off: false }); });
await t('sewer -> street: map shows after the shop, freezes play, wipe waits, auto-closes ~2.5 s', async () => {
  const r = await goLevel(1); assert.equal(r.level, 1); assert.ok(r.active, 'map active');
  assert.equal(r.map.from, 'sewer'); assert.equal(r.map.to, 'street'); assert.deepEqual(r.map.cleared, ['sewer']);
  const snap = () => ev(() => JSON.stringify(window.__ppState.ninjas.map(n => [Math.round(n.x), Math.round(n.y)])));
  const t0 = Date.now(); const n0 = await snap(); await w(600); const n1 = await snap();
  const mid = await ev(() => ({ wipe: window.__ppWipe.playing, plays: window.__ppWipe.plays }));
  for (let i = 0; i < 80 && await ev(() => window.__ppMap.active()); i++) await w(50);
  const dt = (Date.now() - t0) / 1000;
  const after = await ev(() => ({ st: window.__ppMap.stats() }));
  assert.ok(!mid.wipe, 'wipe held behind the map'); assert.ok(dt > 1.6 && dt < 3.4, 'duration ' + dt);
  assert.ok(n0.length > 2, 'enemies on stage ' + n0); assert.equal(n1, n0, 'play frozen'); assert.equal(after.st.done, 1); assert.equal(after.st.skipped, 0);
  for (let i = 0; i < 20 && !(await ev(p => window.__ppWipe.plays > p, mid.plays)); i++) await w(50);
  assert.ok(await ev(p => window.__ppWipe.plays > p, mid.plays), 'wipe played after the map');
  return `(${dt.toFixed(2)} s)`; });
await t('checkpoint save still lands on the new stage', async () => {
  const d = await ev(async () => { const L = await import('./logic.js'); const d = window.__ppSave.load(); return d && L.levelForWave(d.wave); }); assert.equal(d, 1); });
await t('street -> skate: any key skips at once; play resumes', async () => {
  const r = await goLevel(3); assert.ok(r.active); assert.equal(r.map.to, 'skate'); await w(300);
  await page.keyboard.press('KeyX'); await w(60);
  const st = await ev(() => ({ a: window.__ppMap.active(), s: window.__ppMap.stats() })); assert.ok(!st.a, 'closed'); assert.equal(st.s.skipped, 1);
  await page.keyboard.down('ArrowRight'); const x0 = await ev(() => window.__ppState.player.x); await w(500); await page.keyboard.up('ArrowRight');
  assert.ok(await ev(x => window.__ppState.player.x !== x, x0), 'player moves after the skip'); });
await t('skate -> subway: stamps on cleared, next node pulses, pin glides; screenshot', async () => {
  const r = await goLevel(5); assert.ok(r.active); assert.deepEqual(r.map.cleared, ['sewer', 'street', 'skate']); assert.equal(r.map.to, 'subway');
  const k = 740 / 960, y0 = (510 - 540 * k) / 2, [nx, ny] = M.MAP_NODES.subway, clip = { x: Math.round(nx * k - 24), y: Math.round(y0 + ny * k - 24), width: 48, height: 48 };
  const a = await page.screenshot({ clip }); await w(110); const b = await page.screenshot({ clip });
  assert.ok(!a.equals(b), 'next node animates');
  for (let i = 0; i < 30 && await ev(() => window.__ppMap.t < 1.2); i++) await w(30);
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/worldmap-ingame.png` }); }
  await ev(() => window.__ppMap.skip()); });
await t('pad button skips (gamepad.js path)', async () => {
  const r = await goLevel(2); assert.ok(r.active); assert.equal(r.map.to, 'rooftop');
  await ev(() => { const btn = i => ({ pressed: i === 0, value: i === 0 ? 1 : 0 }); const pad = { id: 'mock', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => btn(i)) };
    window.__padNow = true; navigator.getGamepads = () => [window.__padNow ? pad : null]; });
  for (let i = 0; i < 20 && await ev(() => window.__ppMap.active()); i++) await w(30);
  await ev(() => { navigator.getGamepads = () => []; });
  assert.ok(!(await ev(() => window.__ppMap.active())), 'pad press closed the map'); });
await t('reduced motion: one static frame (no pulse, pin already on the next node); screenshot', async () => {
  await ev(async () => { const O = await import('./options-live.js'); O.OPTIONS.set('reducedMotion', true); });
  const r = await goLevel(7); assert.ok(r.active); assert.equal(r.map.to, 'arcade'); assert.ok(r.map.reduced);
  await w(150); const a = await page.screenshot(); await w(400); const b = await page.screenshot();
  assert.ok(a.equals(b), 'frame is static');
  if (shots) fs.writeFileSync(`${shots}/worldmap-reduced.png`, a);
  await ev(async () => { window.__ppMap.skip(); const O = await import('./options-live.js'); O.OPTIONS.set('reducedMotion', false); }); });
await t('off by default under automation and with ?map=0', async () => {
  for (const q of ['?coach=0', '?coach=0&map=0']) { const p2 = await browser.newPage(); await p2.goto(base + q); await p2.waitForTimeout(400); assert.ok(await p2.evaluate(() => window.__ppMap.off), q); await p2.close(); } });
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
