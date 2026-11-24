// MR.INDIA claw stage wipe (t_96f516de1275486c): assets/ui/wipes/wipe_01..10.png exist at half canvas size (370x255),
// paletted, whole set under 250 KB; in game the wipe plays once when play resumes on a new stage (not at run start),
// never blocks input, and leaves 0 console errors.  usage: node check-wipes.mjs [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const pngSize = f => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
await t('10 frames, 370x255, paletted, total under 250 KB', () => {
  let tot = 0;
  for (let i = 1; i <= 10; i++) { const f = path.join(GAME, `assets/ui/wipes/wipe_${String(i).padStart(2, '0')}.png`); assert.ok(fs.existsSync(f), f);
    assert.deepEqual(pngSize(f), [370, 255], f); assert.equal(fs.readFileSync(f)[25], 3, f + ' is paletted'); tot += fs.statSync(f).size; }
  assert.ok(fs.readdirSync(path.join(GAME, 'assets/ui/wipes')).filter(n => n.endsWith('.png')).length === 10, 'exactly 10 frames');
  assert.ok(tot < 250 * 1024, 'total ' + tot); return `(${Math.round(tot / 1024)} KB)`; });
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(GAME, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(GAME) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const shots = process.argv[2];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); const page = await browser.newPage({ viewport: { width: 740, height: 510 } }); const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const ev = (f, a) => page.evaluate(f, a), w = ms => page.waitForTimeout(ms);
await page.goto(`http://127.0.0.1:${server.address().port}/?coach=0`); await w(1200);
for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
await page.keyboard.press('Enter'); await w(300);
for (let i = 0; i < 14 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
await w(400);
async function goLevel(level) {
  await ev(async lv => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas.length = 0; s.wave = L.LEVEL_ORDER.indexOf(lv); L.spawnWave(s); }, level);
  for (let i = 0; i < 25; i++) { await w(100); if (await ev(() => window.__ppScreens.mode())) { await w(1300); await page.keyboard.press('Enter'); await w(200); break; } }
  for (let i = 0; i < 6; i++) { // DOLAN's bonus stage + shop can follow the card: finish and close them
    await ev(() => { const B = window.__ppBonus; if (B && B.active()) { try { B.finish(); } catch {} try { B.close(); } catch {} } if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); }); await w(150);
  }
  await ev(() => { if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); });
  return ev(() => window.__ppState.level);
}
await t('no wipe at run start', async () => { assert.equal(await ev(() => window.__ppWipe.plays), 0); });
await t('wipe plays once when play resumes on a new stage; input still works during it', async () => {
  await ev(() => { window.__wf = []; const o = window.__ppWipe; (function tick() { if (o.playing) window.__wf.push(o.frame); requestAnimationFrame(tick); })(); });
  const lv = await goLevel(2); await page.keyboard.down('ArrowRight'); const x0 = await ev(() => window.__ppState.player.x);
  for (let i = 0; i < 30 && !(await ev(() => window.__ppWipe.frame >= 4)); i++) await w(15);
  await w(700); await page.keyboard.up('ArrowRight');
  const r = await ev(() => ({ plays: window.__ppWipe.plays, playing: window.__ppWipe.playing, frames: [...new Set(window.__wf)], x: window.__ppState.player.x, level: window.__ppState.level }));
  assert.equal(lv, 2); assert.equal(r.plays, 1, JSON.stringify(r)); assert.ok(!r.playing, 'finished'); assert.ok(r.frames.length >= 6, 'frames shown ' + r.frames);
  assert.ok(r.x !== x0, 'player moved during the wipe'); return JSON.stringify({ plays: r.plays, frames: r.frames }); });
if (shots) await t('mid-wipe screenshots (frames 3, 5, 7, 9 pinned)', async () => {
  fs.mkdirSync(shots, { recursive: true });
  for (const k of [2, 4, 6, 8]) { await ev(k => window.__ppWipe.hold(k), k); await w(120); await page.screenshot({ path: `${shots}/wipe-ingame-${String(k + 1).padStart(2, '0')}.png` }); }
  await ev(() => window.__ppWipe.hold(null)); });
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
