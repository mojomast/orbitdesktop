// Headless smoke test for the iteration-10 enemies (enemies-ext.js): spawn the
// claw ninja, shield brute and flamethrower bot by the hero, catch telegraphs and
// the flame/burn FX in screenshots, check FX sprites load and 0 console errors.
// usage: node tools/enemies_smoke.mjs [outdir]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../../pizza-panic/', import.meta.url).pathname;
const OUT = process.argv[2] || '/workspace/pizza-enemies';
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
ok(!!(await page.evaluate(() => window.__ppExt && window.__ppState)), 'enemies-ext loaded (window.__ppExt)');
const shots = [];
const imgs = await page.evaluate(async () => { const m = await import('./enemies-ext.js'); await new Promise(r => setTimeout(r, 500)); return Object.keys(m.extImages).length; });
ok(imgs === 9, `generated FX sprites loaded (${imgs}/9)`);
for (const [lv, label] of [[0, 'sewer'], [1, 'street'], [2, 'rooftop']]) {
  await page.evaluate(lv => {
    const s = window.__ppState; s.level = lv; s.ninjas = []; s.invuln = 999; s.hp = s.maxHp; s.ext = null;
    if (s.events) { s.events.lock = null; for (const k of Object.keys(s.events.fired)) s.events.fired[k] = true; }
    const p = s.player; p.y = lv === 2 ? 395 : 410;
    const e = window.__ppExt;
    e.spawn(s, 'clawninja', p.x + 220, p.y - 10); e.spawn(s, 'flamebot', p.x + 170, p.y); e.spawn(s, 'shieldbrute', p.x - 120, p.y + 5);
    for (const n of s.ninjas) n.xs.cd = 0.3;
  }, lv);
  let seen = new Set();
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(100);
    const info = await page.evaluate(() => { const s = window.__ppState; for (const n of s.ninjas) if (n.ext === 'flamebot') { n.y = s.player.y; } return window.__ppExt.info(s); });
    for (const l of info.live) if (l.atk) seen.add(l.atk);
    if ([...seen].some(a => a.startsWith('flame:active')) && i > 12) break;
  }
  ok([...seen].some(a => a.endsWith(':wind')), `${label}: telegraph seen (${[...seen].join(', ')})`);
  const f = path.join(OUT, `enemies-${lv}-${label}.png`); await page.screenshot({ path: f }); shots.push(f);
  await page.waitForTimeout(500);
  const f2 = path.join(OUT, `enemies-${lv}-${label}-b.png`); await page.screenshot({ path: f2 }); shots.push(f2);
}
await page.evaluate(() => { window.__ppState.ninjas = []; });
await page.waitForTimeout(500);
ok(errors.length === 0, `0 console errors (${errors.length})` + (errors.length ? '\n  ' + errors.slice(0, 8).join('\n  ') : ''));
console.log('screenshots:\n  ' + shots.join('\n  '));
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
