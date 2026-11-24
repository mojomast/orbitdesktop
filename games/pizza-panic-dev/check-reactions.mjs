// Reaction portrait checks (baba_booey, t_718b285057564079): assets/heroes/portraits/reactions.png
// is one 480x2400 RGB atlas, row = HEROES order, column 0 hurt / 1 win, 240x300 cells on the same
// card gradient as the idle <id>.png. Checks: the file (PNG, RGB, size, lean), every cell has a bust
// (not just background), no magenta key left, hurt != win != idle, the card background matches the
// idle card's, the published folder stays at <= 500 files, and the game loads with 0 console errors.
// usage: node check-reactions.mjs [url]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const G = new URL('../pizza-panic/', import.meta.url);
const { HEROES } = await import(new URL('heroes.js', G).href);
const ATLAS = new URL('assets/heroes/portraits/reactions.png', G).pathname;
let pass = 0, total = 0;
const t = async (name, fn) => { total++; try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); } };
const CW = 240, CH = 300;

await t('atlas file: PNG, 480x2400, RGB (colour type 2), under 1.2 MB, one row per hero', () => {
  const b = fs.readFileSync(ATLAS);
  assert.equal(b.toString('latin1', 1, 4), 'PNG');
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), ct = b[25];
  assert.deepEqual([w, h], [CW * 2, CH * HEROES.length], `size ${w}x${h}`);
  assert.equal(ct, 2, 'RGB like the select cards (colour type ' + ct + ')');
  assert.ok(b.length < 1.2e6, 'lean: ' + b.length + ' bytes');
  assert.equal(HEROES.length, 8); // baba_booey: + don_piedro (row 8)
});
await t('published folder stays within the 500-file limit (no *.bak*, *.md) and gained only the atlas', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(G.pathname).filter(f => !/\.bak/.test(f) && !/\.md$/.test(f));
  assert.ok(files.length <= 500, files.length + ' files');
  const extra = fs.readdirSync(path.dirname(ATLAS)).filter(f => /react|hurt|win/i.test(f) && !/\.bak|\.md$/.test(f));
  assert.deepEqual(extra, ['reactions.png'], 'one reaction file: ' + extra);
});

// ---- browser: pixel checks on a canvas, then the game itself
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
let url = process.argv[2], server;
if (!url || url === '-') {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(G.pathname, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(G.pathname) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); url = `http://127.0.0.1:${server.address().port}/`;
}
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
await page.goto(url); await page.waitForTimeout(1500);
const stats = await page.evaluate(async ({ ids, CW, CH }) => {
  const load = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('load ' + src)); im.src = src; });
  const px = im => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, im.width, im.height).data; };
  const atlas = await load('assets/heroes/portraits/reactions.png'), A = px(atlas);
  const out = [];
  for (let r = 0; r < ids.length; r++) {
    const idle = px(await load('assets/heroes/portraits/' + ids[r] + '.png'));
    const cell = (m, x, y) => { const i = ((r * CH + y) * atlas.width + m * CW + x) * 4; return [A[i], A[i + 1], A[i + 2]]; };
    const row = { id: ids[r], cells: [] };
    for (let m = 0; m < 2; m++) {
      let magenta = 0, fig = 0, diffIdle = 0, bgd = 0, bgn = 0;
      for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) {
        const [R, Gc, B] = cell(m, x, y), j = (y * CW + x) * 4, ir = idle[j], ig = idle[j + 1], ib = idle[j + 2];
        if (R > 200 && Gc < 70 && B > 140 && R > B * 0.8) magenta++;
        const d = Math.abs(R - ir) + Math.abs(Gc - ig) + Math.abs(B - ib);
        if (d > 60) fig++;
        diffIdle += d;
      }
      // background: the top corners are card gradient on every card
      for (const [x, y] of [[3, 3], [CW - 4, 3], [3, 40], [CW - 4, 40]]) { const [R, Gc, B] = cell(m, x, y), j = (y * CW + x) * 4; bgd += Math.abs(R - idle[j]) + Math.abs(Gc - idle[j + 1]) + Math.abs(B - idle[j + 2]); bgn++; }
      row.cells.push({ magenta, fig: fig / (CW * CH / 4), bg: bgd / bgn });
    }
    let hw = 0; for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) { const a = cell(0, x, y), b = cell(1, x, y); hw += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 60 ? 1 : 0; }
    row.hurtVsWin = hw / (CW * CH / 4); out.push(row);
  }
  return out;
}, { ids: HEROES.map(h => h.id), CW, CH });
for (const row of stats) {
  await t(`${row.id}: hurt and win cards have a bust, no magenta left, same card background as idle, hurt != win`, () => {
    row.cells.forEach((c, m) => {
      const n = m ? 'win' : 'hurt';
      assert.ok(c.fig > 0.2, `${n}: bust covers ${(c.fig * 100).toFixed(0)}% (vs idle-only background)`);
      assert.ok(c.magenta < 20, `${n}: ${c.magenta} magenta key pixels left`);
      assert.ok(c.bg < 24, `${n}: background off the idle card's by ${c.bg.toFixed(1)}`);
    });
    assert.ok(row.hurtVsWin > 0.08, `hurt and win differ (${(row.hurtVsWin * 100).toFixed(1)}%)`);
  });
}
await t('the game loads and runs to the select screen with 0 console errors / 404s', async () => {
  await page.goto(url); await page.waitForTimeout(1000); await page.keyboard.press('Enter');
  for (let i = 0; i < 60 && !(await page.evaluate(() => window.__ppSelect && window.__ppSelect.active)); i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(100); }
  assert.ok(await page.evaluate(() => window.__ppSelect.active), 'select screen');
  assert.deepEqual(errors, []);
});
await browser.close(); if (server) server.close();
console.log(`${pass}/${total} reaction checks passed`);
process.exit(pass === total ? 0 : 1);
