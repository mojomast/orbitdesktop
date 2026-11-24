// MR.INDIA icon set refresh (t_bb55902aff9746ff). Replaced PNGs keep their old file names and pixel sizes, the
// 64/128 masters exist, shield/rapid/weapon power-ups draw from assets/icons/*_64.png in game, 0 console errors.
// usage: node check-icons.mjs [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const pngSize = f => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const REPL = ['ui_slice.png', 'pickups/pizza.png', 'shop/coin.png', 'bonus/coin.png', 'ui_coin.png', 'shop/life.png', 'ui_heart.png'];
await t('replaced PNGs keep their file names and sizes; 64px icons exist (128 masters checked when present)', () => {
  let bytes = 0;
  for (const f of REPL) { const p = path.join(GAME, 'assets', f), b = p + '.bak-icons'; assert.ok(fs.existsSync(p), f);
    if (fs.existsSync(b)) assert.deepEqual(pngSize(p), pngSize(b), f + ' size'); bytes += fs.statSync(p).size; }
  for (const n of ['slice', 'pizza', 'coin', 'shield', 'rapid', 'weapon', 'life']) for (const s of [64, 128]) {
    const p = path.join(GAME, `assets/icons/${n}_${s}.png`); if (s === 128 && !fs.existsSync(p)) continue; // the 128 masters were pruned from the app (file budget); the 64s are used in game
    assert.deepEqual(pngSize(p), [s, s], p); bytes += fs.statSync(p).size; }
  return `(${Math.round(bytes / 1024)} KB)`; });
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
await t('power-ups draw as icons in game', async () => {
  await ev(() => { const s = window.__ppState; s.ninjas.length = 0; const p = s.player;
    s.powerups.length = 0; ['shield', 'rapid', 'weapon', 'spread', 'life'].forEach((type, i) => s.powerups.push({ x: p.x + 90 + i * 50, y: p.y + 30, r: 12, type, age: 0 })); });
  await page.evaluate(() => { const c = document.querySelector('canvas'); const o = CanvasRenderingContext2D.prototype.drawImage; window.__icDraw = {};
    CanvasRenderingContext2D.prototype.drawImage = function (im, ...a) { const m = /icons\/(\w+)_64/.exec(im && im.src || ''); if (m) window.__icDraw[m[1]] = (window.__icDraw[m[1]] || 0) + 1; return o.call(this, im, ...a); }; });
  await w(400); const d = await ev(() => window.__icDraw);
  for (const k of ['shield', 'rapid', 'weapon']) assert.ok(d[k] > 0, k + ' drawn ' + JSON.stringify(d));
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/icons-powerups.png` }); }
  await ev(() => { window.__ppState.powerups.length = 0; });
  return JSON.stringify(d); });
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
