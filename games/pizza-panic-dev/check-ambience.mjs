// MR.INDIA animated level ambience (t_dd91539751db48a4): 5 sheets in assets/ambience (sizes + rects match the README and
// amb-fx.js, each < 150 KB), each listed level draws its sheet before any fighter (draw order inside one frame), the
// other levels draw none, Reduced motion turns it off, 0 console errors.  usage: node check-ambience.mjs [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const pngSize = f => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const A = await import(new URL('../pizza-panic/amb-fx.js', import.meta.url).href);
const LV = { sewer: 0, street: 1, subway: 5, rooftop: 2, tower: 4 };
await t('5 sheets: sizes + rects match README and amb-fx.js, paletted, each < 150 KB', () => {
  const dir = path.join(GAME, 'assets/ambience'), md = fs.readFileSync(path.join(dir, 'README.md'), 'utf8'); let tot = 0;
  for (const [k, [w, h, n]] of Object.entries(A.AMB_SHEETS)) { const f = path.join(dir, k + '.png'), sz = fs.statSync(f).size;
    assert.deepEqual(pngSize(f), [w * n, h], k); assert.equal(fs.readFileSync(f)[25], 3, k + ' paletted'); assert.ok(sz < 150 * 1024, k + ' ' + sz); tot += sz;
    assert.ok(md.includes(`| ${k}.png | ${LV[k]} | ${w} x ${h} | ${n} |`), k + ' README row');
    const rects = Array.from({ length: n }, (_, i) => `[${i * w}, 0, ${w}, ${h}]`).join(', '); assert.ok(md.includes(`- ${k}: ${rects}`), k + ' rects'); }
  assert.equal(fs.readdirSync(dir).length, 6, '5 sheets + README'); return `(${Math.round(tot / 1024)} KB total)`; });
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
await page.goto(`http://127.0.0.1:${server.address().port}/?coach=0&wipe=0`); await w(1200);
for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
await page.keyboard.press('Enter'); await w(300);
for (let i = 0; i < 14 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
await ev(() => { const o = CanvasRenderingContext2D.prototype.drawImage; window.__seq = []; window.__rec = false;
  CanvasRenderingContext2D.prototype.drawImage = function (im, ...a) { if (window.__rec) { const m = /assets\/(ambience|heroes|enemies|rig)\//.exec(im && im.src || ''); if (m) window.__seq.push(m[1]); } return o.call(this, im, ...a); }; });
const oneFrame = () => ev(() => new Promise(res => requestAnimationFrame(() => { window.__seq = []; window.__rec = true; requestAnimationFrame(() => { window.__rec = false; res(window.__seq.slice()); }); })));
async function goLevel(level) {
  await ev(async lv => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas.length = 0; s.wave = L.LEVEL_ORDER.indexOf(lv); L.spawnWave(s); }, level);
  for (let i = 0; i < 25; i++) { await w(100); if (await ev(() => window.__ppScreens.mode())) { await w(1300); await page.keyboard.press('Enter'); await w(200); break; } }
  for (let i = 0; i < 6; i++) { // DOLAN's bonus stage + shop can follow the card: finish and close them
    await ev(() => { const B = window.__ppBonus; if (B && B.active()) { try { B.finish(); } catch {} try { B.close(); } catch {} } if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); }); await w(150);
  }
  await ev(() => { if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); });
  return ev(() => window.__ppState.level);
}
for (const [name, lv] of Object.entries(LV)) await t(`${name} (level ${lv}) draws its ambience before the fighters`, async () => {
  const got = await goLevel(lv); assert.equal(got, lv); await ev(() => { window.__ppState.ninjas.length = 0; }); await w(700);
  const d0 = (await ev(() => window.__ppAmbFx.draws))[lv] || 0; let seq = [];
  for (let i = 0; i < 40 && !(seq.includes('ambience') && seq.some(x => x !== 'ambience')); i++) { seq = await oneFrame(); if (i > 5) await w(100); } // under full-suite load the level card / wipe can still cover the first frames
  const a = seq.indexOf('ambience'), f = seq.findIndex(x => x !== 'ambience');
  assert.ok(a >= 0, 'ambience drawn ' + seq.join(',')); assert.ok(f > a && seq.lastIndexOf('ambience') < f, 'all ambience before the first fighter: ' + seq.slice(0, 12).join(','));
  assert.ok(((await ev(() => window.__ppAmbFx.draws))[lv] || 0) > d0, 'draw counter');
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/amb-${name}.png` }); }
  return `(${seq.filter(x => x === 'ambience').length} sheet draws, first fighter at #${f})`; });
for (const lv of [6, 7]) await t(`level ${lv} draws no ambience`, async () => {
  assert.equal(await goLevel(lv), lv); await w(400); const seq = await oneFrame(); assert.ok(!seq.includes('ambience'), seq.join(',')); });
await t('Reduced motion turns it off', async () => {
  assert.equal(await goLevel(0), 0); await w(400);
  await ev(async () => { (await import('./options-live.js')).default.set('reducedMotion', true); }); await w(200);
  const seq = await oneFrame(), sk = await ev(() => window.__ppAmbFx.skipped);
  await ev(async () => { (await import('./options-live.js')).default.set('reducedMotion', false); }); await w(200);
  const seq2 = await oneFrame();
  assert.ok(!seq.includes('ambience'), 'off: ' + seq.join(',')); assert.ok(sk > 0); assert.ok(seq2.includes('ambience'), 'back on'); });
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
