// MR.INDIA hero special-move FX sheets (t_fd630e9e9b1c4c85): 7 sheets in assets/fx/specials (8 frames of 160x144 in
// one row, paletted, < 350 KB together) whose rects and anchors match the README and specialfx.js; in game each hero's
// J+L special plays its own sheet (spawned + drawn), Reduced flash / Reduced motion skip it, 0 console errors.
// usage: node check-special-fx.mjs [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const pngSize = f => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const HEROES = ['turtle_purple', 'turtle_blue', 'turtle_red', 'turtle_orange', 'nous_girl', 'teknium', 'turbofit'];
const SF = await import(new URL('../pizza-panic/specialfx.js', import.meta.url).href).catch(e => ({ err: e }));
await t('7 sheets: 1280x144 (8 x 160x144), paletted, < 350 KB; README rects + anchors match specialfx.js', () => {
  const dir = path.join(GAME, 'assets/fx/specials'), md = fs.readFileSync(path.join(dir, 'README.md'), 'utf8'); let tot = 0;
  assert.deepEqual(SF.SFX_FRAME, { w: 160, h: 144, n: 8 });
  for (const h of HEROES) { const f = path.join(dir, h + '.png'); assert.deepEqual(pngSize(f), [1280, 144], h); assert.equal(fs.readFileSync(f)[25], 3, h + ' paletted'); tot += fs.statSync(f).size;
    const row = md.split('\n').find(l => l.startsWith(`| ${h} |`)); assert.ok(row, h + ' in README');
    const an = row.split('|')[4].trim().split(',').map(Number); assert.deepEqual(an, SF.SFX_ANCHOR[h], h + ' anchor'); }
  for (let i = 0; i < 8; i++) assert.ok(md.includes(`- frame ${i}: [${i * 160}, 0, 160, 144]`), 'rect ' + i);
  assert.equal(fs.readdirSync(dir).length, 8, '7 sheets + README');
  assert.ok(tot < 350 * 1024, 'total ' + tot); return `(${Math.round(tot / 1024)} KB)`; });
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
await w(500);
const special = async () => { await page.keyboard.down('KeyJ'); await page.keyboard.down('KeyL'); await w(60); await page.keyboard.up('KeyJ'); await page.keyboard.up('KeyL'); };
const SHOT = ['turtle_purple', 'turtle_red', 'nous_girl', 'turbofit'];
for (const h of HEROES) await t(`${h}: its special plays its own sheet`, async () => {
  await ev(h => { const s = window.__ppState; s.selectedHero = h; s.hp = 100; s.ninjas.length = 0; }, h); await w(700);
  const before = await ev(() => ({ sp: window.__ppSpecialFX.spawned, dr: window.__ppSpecialFX.draws }));
  await special(); await w(250);
  const after = await ev(() => ({ sp: window.__ppSpecialFX.spawned, dr: window.__ppSpecialFX.draws, atk: window.__ppState.combat.lastMove }));
  assert.equal((after.sp[h] || 0) - (before.sp[h] || 0), 1, `spawned ${JSON.stringify(after)}`);
  assert.ok((after.dr[h] || 0) > (before.dr[h] || 0), 'drawn');
  for (const o of HEROES) if (o !== h) assert.equal(after.sp[o] || 0, before.sp[o] || 0, 'no other sheet');
  if (shots && SHOT.includes(h)) { fs.mkdirSync(shots, { recursive: true }); await w(500);
    await ev(h => window.__ppSpecialFX.hold(window.__ppState, h, 3), h); await w(150);
    await page.screenshot({ path: `${shots}/special-${h}.png` }); await ev(() => window.__ppSpecialFX.hold(null)); }
  return `(${after.atk}, ${(after.dr[h] || 0) - (before.dr[h] || 0)} draws)`; });
await t('Reduced flash / Reduced motion skip the sheets', async () => {
  for (const key of ['reducedFlash', 'reducedMotion']) {
    await ev(async key => { const O = (await import('./options-live.js')).default; O.set(key, true); }, key); await w(700);
    const b = await ev(() => ({ sp: Object.values(window.__ppSpecialFX.spawned).reduce((a, v) => a + v, 0), sk: window.__ppSpecialFX.skipped }));
    await special(); await w(300);
    const a = await ev(() => ({ sp: Object.values(window.__ppSpecialFX.spawned).reduce((a, v) => a + v, 0), sk: window.__ppSpecialFX.skipped, live: window.__ppSpecialFX.live }));
    await ev(async key => { const O = (await import('./options-live.js')).default; O.set(key, false); }, key);
    assert.equal(a.sp, b.sp, key + ': nothing spawned'); assert.equal(a.sk, b.sk + 1, key + ': skip counted'); assert.equal(a.live, 0);
  } });
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
