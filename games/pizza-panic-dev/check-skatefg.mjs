// Skate-run near-field foreground props (baba_booey, t_ff6cf63cc2c04b1e): one atlas
// (assets/levels/skate/fg/skate_fg.png) + FG_ATLAS frame map in parallax.js, drawn through the
// existing foreground-props path. Checks: atlas file lean and frames inside it and disjoint, each
// frame keyed (transparent around, no key magenta left, the pink neon arrow kept), top-anchored
// cables reach the frame top, the skate theme uses all 8 with sparse gaps, the published folder
// stays <= 500 files, skate physics untouched, and in the game every prop loads and draws
// (pixels land where placements() says) with 0 console errors. Shots -> /workspace/pizza-bg/skate-fg/.
// usage: node check-skatefg.mjs [shots dir]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname;
const SH = process.argv[2] || '/workspace/pizza-bg/skate-fg/shots'; fs.mkdirSync(SH, { recursive: true });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const P = await import(path.join(ROOT, 'parallax.js'));
const KINDS = ['trash_bags', 'barricade', 'dumpster', 'tire_stack', 'neon_slice', 'arrow_sign', 'hanging_cables', 'no_entry'];
const A = P.FG_ATLAS, F = A && A.frames;
// --- static -----------------------------------------------------------------
ok(F && KINDS.every(k => F[k] && P.FG_KINDS[k]), 'FG_ATLAS maps all 8 skate props, each with FG_KINDS sizing');
const file = path.join(ROOT, A.src), buf = fs.readFileSync(file);
const AW = buf.readUInt32BE(16), AH = buf.readUInt32BE(20);
ok(buf.readUInt32BE(0) === 0x89504e47 && buf.length < 260 * 1024, `atlas ${A.src}: PNG ${AW}x${AH}, ${Math.round(buf.length / 1024)} KB (< 260)`);
const rects = KINDS.map(k => F[k]);
ok(rects.every(([x, y, w, h]) => x >= 0 && y >= 0 && w > 20 && h > 20 && x + w <= AW && y + h <= AH && h <= 300), 'every frame inside the atlas, <= 300 px tall');
ok(rects.every((a, i) => rects.every((b, j) => i === j || a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1])), 'frames do not overlap');
ok(fs.existsSync(path.join(ROOT, 'assets/levels/skate/fg/README.md')), 'README with pivots and sizes next to the atlas');
const L = P.FG[3], kinds = new Set(L.map(p => p.k)), gaps = L.slice(1).map((p, i) => p.x - L[i].x).concat(L[0].x + P.SKATE_PERIOD - L[L.length - 1].x);
ok(KINDS.every(k => kinds.has(k)) && kinds.has('skate_rail') && Math.min(...gaps) >= 600, `skate theme: ${L.length} props, ${kinds.size} kinds, min gap ${Math.min(...gaps)} fg px over a ${P.SKATE_PERIOD} px repeat (incl. the wrap)`);
ok(L.filter(p => p.k === 'hanging_cables').every(p => p.top) && P.FG_KINDS.hanging_cables.sink <= 0 && L.filter(p => ['trash_bags', 'barricade', 'dumpster', 'tire_stack', 'arrow_sign', 'no_entry'].includes(p.k)).every(p => !p.top),
  'cables hang from the screen top (pivot at the top edge); ground props stand on the bottom edge');
{ const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const n = walk(ROOT).filter(f => !/\.bak/.test(f) && !/\.md$/.test(f)).length; ok(n <= 500, `published folder: ${n} files (<= 500)`); }
{ const sk = fs.readFileSync(path.join(ROOT, 'skate.js'), 'utf8'); ok(!/parallax|FG_ATLAS|skate_fg/.test(sk), 'skate.js (physics) untouched by the prop wiring'); }
// --- browser ----------------------------------------------------------------
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const url = `http://127.0.0.1:${server.address().port}/`;
const errors = [];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().split('\n')[0]); });
page.on('pageerror', e => errors.push(String(e).split('\n')[0]));
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.addInitScript(() => { try { localStorage.setItem('pizzaPanicCoachDone', '1'); } catch (_) {} });
const shots = [];
try {
  await page.goto(url); await page.waitForTimeout(1500);
  // atlas pixels: keyed frames (corners clear, no key magenta, a solid body)
  const px = await page.evaluate(async ({ src, frames }) => {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const out = {};
    for (const [k, [x, y, w, h]] of Object.entries(frames)) {
      const d = g.getImageData(x, y, w, h).data; let solid = 0, key = 0, rim = 0, pink = 0, topRow = 0;
      const clear = (xx, yy) => xx < 0 || yy < 0 || xx >= w || yy >= h || d[(yy * w + xx) * 4 + 3] < 128;
      for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (a > 200) solid++;
        if (a > 128 && Math.hypot(d[i] - 252, d[i + 1] - 3, d[i + 2] - 165) < 60) { key++; const p = i / 4, xx = p % w, yy = (p / w) | 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (clear(xx + dx, yy + dy)) { rim++; dy = dx = 3; } }
        if (a > 200 && d[i] > 120 && d[i + 2] > 60 && d[i] > d[i + 1] * 2.2) pink++; }
      for (let xx = 0; xx < w; xx++) if (d[xx * 4 + 3] > 128) topRow++;
      const corner = (k === 'hanging_cables' ? [(h - 1) * w, h * w - 1] : [0, w - 1, (h - 1) * w, h * w - 1]).map(j => d[j * 4 + 3]); // cables are anchored at their top corners
      out[k] = { solid: solid / (w * h), key: key / (w * h), rim, pink: pink / (w * h), topRow, corner: Math.max(...corner) };
    }
    return out;
  }, A);
  for (const k of KINDS) {
    const s = px[k];
    // key-coloured pixels on the matte edge = leftover background; inside, only the neon arrow's own glow may be that pink
    ok(s.solid > 0.08 && s.rim === 0 && (k === 'arrow_sign' ? s.key < 0.03 : s.key < 0.004) && s.corner < 40, `${k}: keyed (${(s.solid * 100).toFixed(0)}% solid, ${s.rim} key-pink edge px, ${(s.key * 100).toFixed(2)}% key-coloured inside, corner alpha ${s.corner})`);
  }
  ok(px.arrow_sign.pink > 0.08, `pink neon arrow survived the key (${(px.arrow_sign.pink * 100).toFixed(0)}% pink)`);
  ok(px.hanging_cables.topRow >= 2, `cables run off the frame top (anchor) (${px.hanging_cables.topRow} px)`);
  // the game: skate level, every prop loads as a silhouette canvas, then each one drawn by front()
  for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
  await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema?.isActive?.()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  const loaded = await page.evaluate(ks => ks.map(k => { const im = window.__ppParallax.images['fg_' + k]; return im ? [im.width, im.height] : null; }), KINDS);
  ok(loaded.every((wh, i) => wh && wh[0] === F[KINDS[i]][2] && wh[1] === F[KINDS[i]][3]), 'every skate prop loaded from the atlas at its frame size');
  const drawn = await page.evaluate(({ kinds, rate }) => {
    const px = window.__ppParallax, s = window.__ppState; s.ninjas = [];
    const out = {}, c = document.createElement('canvas'); c.width = 740; c.height = 510; const g = c.getContext('2d');
    for (const k of kinds) {
      const p = px.placements(3, 0, 1e9).find(q => q.k === k && q.sx > 0); // a layout x for this kind
      const camX = (p.sx - 370) / rate; let best = 0;
      for (let i = 0; i < 12; i++) { g.clearRect(0, 0, 740, 510); px.front(g, 3, camX, 740, 510, -2000, -2000); }
      const pl = px.placements(3, camX, 740).find(q => q.k === k && Math.abs(q.sx - 370) < 2);
      const d = g.getImageData(270, 0, 200, 510).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 60) best++;
      out[k] = { on: best, at: pl ? Math.round(pl.sx) : null };
    }
    return out;
  }, { kinds: KINDS, rate: P.FG_RATE });
  for (const k of KINDS) ok(drawn[k].at === 370 && drawn[k].on > 2000, `${k}: drawn by the foreground layer at its placement (${drawn[k].on} px)`);
  // showcase: the skate background + each prop at x 370, and live shots of the run
  const shotsData = await page.evaluate(({ kinds, rate }) => {
    const px = window.__ppParallax, out = [];
    for (const k of kinds) {
      const p = px.placements(3, 0, 1e9).find(q => q.k === k && q.sx > 0), camX = (p.sx - 370) / rate;
      const c = document.createElement('canvas'); c.width = 740; c.height = 510; const g = c.getContext('2d');
      px.back(g, 3, camX, 740, 510); for (let i = 0; i < 12; i++) px.front(g, 3, camX, 740, 510, -2000, -2000);
      out.push([k, c.toDataURL('image/png')]);
    }
    return out;
  }, { kinds: KINDS, rate: P.FG_RATE });
  for (const [k, d] of shotsData) { const f = `${SH}/skatefg-${k}.png`; fs.writeFileSync(f, Buffer.from(d.split(',')[1], 'base64')); shots.push(f); }
  await page.evaluate(async () => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas = []; s.wave = L.LEVEL_ORDER.indexOf(3) + 1; s.level = 3; s.holdWave = true; s.invuln = 999; s.player.x = 200; });
  for (let i = 0; i < 40 && (await page.evaluate(() => window.__ppState.level)) !== 3; i++) { await page.waitForTimeout(150); await page.keyboard.press('Enter'); }
  for (let i = 0; i < 30 && await page.evaluate(() => !!(window.__ppScreens?.active?.() || window.__ppCinema?.isActive?.() || window.__ppShop?.active?.() || window.__ppBonus?.active?.())); i++) {
    await page.evaluate(() => { try { window.__ppShop?.active?.() && window.__ppShop.leave(); window.__ppBonus?.active?.() && window.__ppBonus.close(); } catch (_) {} });
    await page.keyboard.press(await page.evaluate(() => window.__ppCinema?.isActive?.()) ? 'Escape' : 'Enter'); await page.waitForTimeout(200);
  }
  let live = 0;
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(700); const st = await page.evaluate(() => ({ lv: window.__ppState.level, ...window.__ppParallax.stats() })); if (st.lv === 3 && st.shown) { live = Math.max(live, st.shown); if (i % 3 === 0) { const f = `${SH}/skatefg-live-${i}.png`; await page.screenshot({ path: f }); shots.push(f); } } }
  ok(live >= 1, `in the running skate level the foreground layer draws props (${live} at once)`);
  ok(errors.length === 0, `0 console errors (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
} catch (e) { ok(false, 'browser: ' + (e && e.stack || e)); }
await browser.close(); server.close();
try { execFileSync('python3', ['-c', `
import sys
from PIL import Image, ImageDraw
fs=sys.argv[1:]; cols=4; w,h=370,255; rows=(len(fs)+cols-1)//cols
s=Image.new('RGB',(cols*w,rows*(h+18)),(12,12,16)); d=ImageDraw.Draw(s)
for i,f in enumerate(fs):
  im=Image.open(f).convert('RGB').resize((w,h)); x,y=(i%cols)*w,(i//cols)*(h+18); s.paste(im,(x,y+18)); d.text((x+4,y+3),f.split('/')[-1][:-4],fill=(255,230,100))
s.save('${SH}/../skatefg-contact.png')`, ...shots]); console.log('contact sheet ' + path.resolve(SH, '..', 'skatefg-contact.png')); } catch (e) { console.log('contact sheet failed: ' + e.message); }
console.log(fails ? `${fails} skatefg checks FAILED` : 'all skatefg checks passed');
process.exit(fails ? 1 : 0);
