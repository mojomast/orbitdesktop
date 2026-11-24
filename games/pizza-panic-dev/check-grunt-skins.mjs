// MR.INDIA per-level grunt reskins (t_58e0f476b119417e). The brawler draws as brawler_harbor on level 6,
// brawler_arcade on 7 and brawler_tower on 4 (game.js skinKind), and as the default brawler elsewhere; a skin
// whose art is missing falls back to the default; the skin tables keep the brawler's exact rig numbers and
// file sizes; 0 console errors.  usage: node check-grunt-skins.mjs [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const SKINS = { 6: 'brawler_harbor', 7: 'brawler_arcade', 4: 'brawler_tower' };
const { ENEMY_RIGS } = await import(new URL('../pizza-panic/enemy-rigs.js', import.meta.url).href);
const pngSize = f => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

await t('skin tables exist and match the brawler rig numbers exactly; every PNG has the brawler size', () => {
  const B = ENEMY_RIGS.brawler; let bytes = 0; const seen = new Set();
  for (const k of Object.values(SKINS)) {
    const R = ENEMY_RIGS[k]; assert.ok(R, k + ' in ENEMY_RIGS'); assert.deepEqual(Object.keys(R).sort(), Object.keys(B).sort(), k + ' parts');
    for (const [p, v] of Object.entries(B)) {
      assert.deepEqual(R[p], v, `${k}.${p} rig numbers`);
      const f = path.join(GAME, 'assets/enemies', k, v.file); assert.ok(fs.existsSync(f), f); assert.deepEqual(pngSize(f), [v.w, v.h], `${k}/${v.file} size`); if (!seen.has(f)) { seen.add(f); bytes += fs.statSync(f).size; }
    }
  }
  return `(${seen.size} PNGs, ${Math.round(bytes / 1024)} KB for all three skins)`; });

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
await t('skin art decoded in the rig', async () => {
  for (let i = 0; i < 30 && !(await ev(k => k.every(x => window.__ppRig.ready(x)), Object.values(SKINS))); i++) await w(100);
  assert.ok(await ev(k => k.every(x => window.__ppRig.ready(x)), Object.values(SKINS))); });

async function goLevel(level) {
  await ev(async lv => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas.length = 0; s.wave = L.LEVEL_ORDER.indexOf(lv); L.spawnWave(s); }, level);
  for (let i = 0; i < 25; i++) { await w(100); if (await ev(() => window.__ppScreens.mode())) { await w(1300); await page.keyboard.press('Enter'); await w(200); break; } }
  for (let i = 0; i < 6; i++) { // DOLAN's bonus stage + shop can follow the card: finish and close them
    await ev(() => { const B = window.__ppBonus; if (B && B.active()) { try { B.finish(); } catch {} try { B.close(); } catch {} } if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); }); await w(150);
  }
  await ev(() => { if (window.__ppShop && window.__ppShop.active()) window.__ppShop.leave(); });
  return ev(() => window.__ppState.level);
}
async function drawBrawler(level, tag) {
  // One stunned brawler in front of the hero; count which rig kind draws it.
  await ev(() => { const s = window.__ppState; s.invuln = 99; s.ninjas.length = 0; if (s.events) s.events.lock = null;
    s.ninjas.push({ kind: 'brawler', level: s.level, x: s.player.x + 150, y: s.player.y, r: 17, hp: 9, maxHp: 9, vx: 0, vy: 0, face: -1, stun: 99, scripted: true }); });
  await w(150);
  const before = await ev(() => ({ ...window.__ppRig.stats })); await w(400); const after = await ev(() => ({ ...window.__ppRig.stats }));
  const d = k => (after[k] || 0) - (before[k] || 0);
  if (shots && tag) { const b = await ev(() => { const s = window.__ppState, n = s.ninjas[0]; return n ? { x: Math.round(n.x - s.cameraX), y: Math.round(n.y) } : null; });
    await page.screenshot({ path: `${shots}/grunt-${tag}.png` });
    if (b) await page.screenshot({ path: `${shots}/grunt-${tag}-zoom.png`, clip: { x: Math.max(0, b.x - 110), y: Math.max(0, b.y - 150), width: 260, height: 190 } }); }
  return { brawler: d('brawler'), harbor: d('brawler_harbor'), arcade: d('brawler_arcade'), tower: d('brawler_tower') };
}
for (const [lv, name] of [[6, 'harbor'], [7, 'arcade'], [4, 'tower']]) await t(`level ${lv} (${name}) draws brawler_${name}`, async () => {
  const at = await goLevel(lv); assert.equal(at, lv, 'reached level'); const c = await drawBrawler(lv, name);
  assert.ok(c[name] > 5 && c.brawler === 0, JSON.stringify(c)); return JSON.stringify(c); });
for (const lv of [1, 5]) await t(`level ${lv} draws the default brawler`, async () => {
  const at = await goLevel(lv); assert.equal(at, lv); const c = await drawBrawler(lv, lv === 1 ? 'default-street' : null);
  assert.ok(c.brawler > 5 && c.harbor + c.arcade + c.tower === 0, JSON.stringify(c)); return JSON.stringify(c); });
await t('missing skin art falls back to the default brawler', async () => {
  await goLevel(6);
  await ev(() => { const im = window.__ppRig.images.brawler_harbor; window.__ppSaved = im['brawler_torso.png']; delete im['brawler_torso.png']; });
  const c = await drawBrawler(6, null); await ev(() => { window.__ppRig.images.brawler_harbor['brawler_torso.png'] = window.__ppSaved; });
  assert.ok(c.brawler > 5 && c.harbor === 0, JSON.stringify(c)); return JSON.stringify(c); });
await t('0 console errors (no 404s for skin art)', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
