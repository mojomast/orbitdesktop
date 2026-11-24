// Headless smoke test for the walking-level backgrounds (baba_booey,
// t_d7f9cc49e453482c): visit sewer, street and rooftop in the real game,
// screenshot several camera x positions (incl. both tile seams), check that no
// flat-colour hole (the QA's cyan) shows, that each tile draws its own
// painting, and 0 console errors. Also writes a contact sheet.
// usage: node tools/bg_smoke.mjs [outdir] [levels, default 0,1,2; v2: 5,6,7,4]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../../pizza-panic/', import.meta.url).pathname;
const OUT = process.argv[2] || '/workspace/pizza-bg';
fs.mkdirSync(OUT, { recursive: true });
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const url = `http://127.0.0.1:${server.address().port}/`;
const errors = []; let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(url); await page.waitForTimeout(1200);
for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
await page.keyboard.press('Enter'); await page.waitForTimeout(400);
const skipCine = async () => { for (let i = 0; i < 8 && await page.evaluate(() => window.__ppCinema?.isActive?.()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); } };
await skipCine();


const shots = [];
const XS = [200, 1000, 1814, 2600, 3628, 4400, 4800];
const NAMES = { 0: 'sewer', 1: 'street', 2: 'rooftop', 4: 'tower', 5: 'subway', 6: 'harbor', 7: 'arcade' };
const LEVELS = (process.argv[3] || '0,1,2').split(',').map(Number);
const results = {};
async function clearOverlays() {
// the level jump can raise a stage-clear card (and the post-street bonus stage): close them
for (let i = 0, idle = 0; i < 60 && idle < 4; i++) {
  const what = await page.evaluate(() => { const b = window.__ppBonus; if (b && b.active()) { try { b.close(); } catch (_) {} return 'bonus'; }
    const sh = window.__ppShop; if (sh && sh.active()) { try { sh.leave(); } catch (_) {} return 'shop'; }
    if (window.__ppPause?.isOpen?.()) { window.__ppPause.close(); return 'pause'; }
    if (window.__ppScreens?.active?.()) return 'screen'; if (window.__ppCinema?.isActive?.()) return 'cine'; return null; });
  if (what === 'screen') await page.keyboard.press('Enter'); else if (what === 'cine') await page.keyboard.press('Escape');
  idle = what ? 0 : idle + 1; await page.waitForTimeout(200);
}
}
for (const lv of LEVELS) {
  await page.evaluate(async lv => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas = []; s.wave = L.LEVEL_ORDER.indexOf(lv) + 1; s.level = lv; s.holdWave = true; s.invuln = 999; s.player.x = 200; }, lv);
  for (let i = 0; i < 40 && (await page.evaluate(() => window.__ppState.level)) !== lv; i++) { await page.waitForTimeout(150); await page.keyboard.press('Enter'); }
  await clearOverlays();
  await page.evaluate(lv => { const s = window.__ppState; s.level = lv; s.ninjas = []; }, lv);
  ok((await page.evaluate(() => window.__ppState.level)) === lv, `in the ${NAMES[lv]}`);
  results[lv] = [];
  for (const x of XS) {
    if (await page.evaluate(lv => window.__ppState.level !== lv || !!window.__ppScreens?.active?.(), lv)) {
      await clearOverlays(); await page.evaluate(lv => { const s = window.__ppState; s.level = lv; s.ninjas = []; s.walkLevel = true; s.holdWave = true; }, lv);
    }
    await page.evaluate(async x => { const E = await import('./events.js'); const s = window.__ppState; s.ninjas = []; s.invuln = 999; s.hp = s.maxHp; s.holdWave = true;
      for (const b of E.TRIGGERS) if (b.level === s.level) s.events.fired[b.level + ':' + b.x] = true;
      s.events.lock = null; s.events.camX = null; s.events.cooldown = 0; s.player.x = x; s.player.y = 400; if (s.harbor) { s.harbor.px = x; s.harbor.sv = 0; } }, x);
    // hold the hero in place while the camera settles (wet planks / crane knockbacks can carry him past the level end)
    for (let t = 0; t < 6; t++) { await page.evaluate(x => { const st = window.__ppState, p = st.player; p.x = x; p.y = 400; if ('vx' in p) p.vx = 0; if (st.harbor) { st.harbor.px = x; st.harbor.sv = 0; } }, x); await page.waitForTimeout(75); }
    const r = await page.evaluate(() => { const c = document.getElementById('c') || document.querySelector('canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
      let cyan = 0, magenta = 0; for (let i = 0; i < d.length; i += 4) { const R = d[i], G = d[i + 1], B = d[i + 2]; if (Math.abs(R - 137) < 14 && Math.abs(G - 222) < 14 && Math.abs(B - 239) < 14) cyan++; if (R > 240 && G < 20 && B > 240) magenta++; }
      const overlay = (window.__ppShop?.active?.() && 'shop') || (window.__ppBonus?.active?.() && 'bonus') || (window.__ppScreens?.active?.() && 'screen') || (window.__ppPause?.isOpen?.() && 'pause') || (window.__ppCinema?.isActive?.() && 'cine') || null;
      const segs = window.__ppParallax.segments(); const st = window.__ppState; return { px0: Math.round(st.player.x), lvNow: st.level, log: (st.events.log || []).slice(-2).map(e => e.type + ':' + e.level), cam: Math.round(window.__ppCamX), cyan, magenta, segs: segs.size, px: c.width * c.height, overlay }; });
    const f = path.join(OUT, `bg-${NAMES[lv]}-x${x}.png`); await page.screenshot({ path: f }); shots.push(f);
    if (r.overlay) console.log('   diag', JSON.stringify({ x: r.px0, level: r.lvNow, log: r.log }));
    results[lv].push({ x, ...r });
    ok(!r.overlay && r.cyan < r.px * 0.002 && r.magenta === 0, (r.overlay ? `[${r.overlay} overlay up] ` : '') + `${NAMES[lv]} x${x} (cam ${r.cam}, tile ${Math.floor((r.cam + 370) / 1814)}): no flat-colour holes (cyan ${r.cyan}, magenta ${r.magenta})`);
  }
}
if (LEVELS.some(l => l <= 2)) {
  const segs = await page.evaluate(() => [...window.__ppParallax.segments().entries()].map(([k, v]) => [k, v.length, new Set(v).size]));
  ok(segs.length === 3 && segs.every(([, n, u]) => n === 3 && u === 3), 'each walking level has 3 distinct tile images ' + JSON.stringify(segs));
}
if (LEVELS.some(l => l > 2 || l === 4)) {
  const v2 = await page.evaluate(() => ({ subway: ['seg0', 'seg2'].filter(k => window.__ppSubway.images[k]).length, harbor: ['pier2', 'ship2'].filter(k => window.__ppHarbor.images[k]).length,
    arcade: window.__ppArcade.images.row2 ? 1 : 0, tower: window.__ppParallax.towerTile(1) && window.__ppParallax.towerTile(1).tagName === 'CANVAS' ? 1 : 0 }));
  ok(v2.subway === 2 && v2.harbor === 2 && v2.arcade === 1 && v2.tower === 1, 'v2 segment tiles live in the game ' + JSON.stringify(v2));
}
ok(errors.length === 0, `0 console errors (${errors.length})` + (errors.length ? '\n  ' + errors.slice(0, 8).join('\n  ') : ''));
await browser.close(); server.close();
// contact sheet: one row per level, the 7 camera positions
{ const { execFileSync } = await import('node:child_process');
  const py = `
import sys
from PIL import Image, ImageDraw
shots=sys.argv[2:]; cols=7; w,h=370,255; rows=(len(shots)+cols-1)//cols
sheet=Image.new('RGB',(cols*w,rows*(h+18)),(12,12,16)); d=ImageDraw.Draw(sheet)
for i,f in enumerate(shots):
    r,c=divmod(i,cols); im=Image.open(f).convert('RGB').resize((w,h)); sheet.paste(im,(c*w,r*(h+18)+18))
    d.text((c*w+4,r*(h+18)+3),f.split('/')[-1][3:-4],fill=(255,230,120))
sheet.save(sys.argv[1])`;
  const sheet = path.join(OUT, 'bg-contact-sheet.png');
  execFileSync('python3', ['-c', py, sheet, ...shots]); shots.push(sheet); }
console.log('screenshots:\n  ' + shots.join('\n  '));
process.exit(fails ? 1 : 0);
