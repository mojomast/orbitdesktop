// Headless boot + character select check: 0 console errors, all 8 heroes on the select
// screen with portraits, keyboard navigation, and the confirmed hero is what spawns.
// usage: node check-select.mjs [url] [screenshot.png]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname;
let url = process.argv[2], server;
if (!url || url === '-') {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { if (!q.url.startsWith('/favicon')) console.log('404 ' + q.url); r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); url = `http://127.0.0.1:${server.address().port}/`;
}
const shot = process.argv[3];
const errors = []; let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
page.on('requestfailed', r => errors.push('requestfailed ' + r.url()));
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto(url); await page.waitForTimeout(1500);
for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
ok(await page.evaluate(() => window.__ppSelect?.active), 'reached character select');
const info = await page.evaluate(async () => {
  const { HEROES } = await import('./heroes.js');
  const imgs = [...HEROES].map(h => new Promise(r => { const im = new Image(); im.onload = () => r(im.width > 0); im.onerror = () => r(false); im.src = 'assets/heroes/portraits/' + h.id + '.png'; }));
  return { ids: HEROES.map(h => h.id), lines: HEROES.map(h => !!(h.name && h.blurb && h.weapon && h.stat)), portraits: await Promise.all(imgs) };
});
const want = ['turtle_purple', 'turtle_blue', 'turtle_red', 'turtle_orange', 'nous_girl', 'teknium', 'turbofit', 'don_piedro']; // baba_booey: 8th hero
ok(JSON.stringify(info.ids) === JSON.stringify(want), 'roster is the 8 heroes in order: ' + info.ids.join(','));
ok(info.lines.every(Boolean), 'every hero has name, weapon, blurb and stat');
ok(info.portraits.every(Boolean), 'every portrait loads');
const idx = () => page.evaluate(() => window.__ppSelect.index);
await page.keyboard.press('ArrowRight'); ok(await idx() === 1, 'ArrowRight moves to 2');
await page.keyboard.press('ArrowDown'); ok(await idx() === 4 || await idx() === 5, 'ArrowDown jumps to the second row (' + await idx() + ')');
await page.keyboard.press('ArrowUp'); ok(await idx() < 4, 'ArrowUp returns to the top row');
await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); ok(await idx() === want.length - 1 || await idx() <= 1, 'ArrowLeft wraps');
for (let k = 1; k <= want.length; k++) { await page.keyboard.press('Digit' + k); ok(await idx() === k - 1, `key ${k} selects ${want[k - 1]}`); }
await page.keyboard.press('Digit1'); await page.waitForTimeout(400);
if (shot) { await page.screenshot({ path: shot }); console.log('screenshot ' + shot); }
// confirm a non-default hero and check it spawns
await page.keyboard.press('Digit6'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
const spawned = await page.evaluate(() => ({ sel: window.__ppState?.selectedHero, hero: window.__ppSelect.hero, active: window.__ppSelect.active }));
ok(!spawned.active && spawned.sel === 'teknium' && spawned.hero === 'teknium', 'Enter on TEKNIUM spawns teknium (state.selectedHero=' + spawned.sel + ')');
for (let i = 0; i < 6; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
await page.waitForTimeout(1500);
ok(errors.length === 0, `0 console errors (${errors.length})` + (errors.length ? '\n  ' + errors.slice(0, 8).join('\n  ') : ''));
await browser.close(); server?.close();
process.exit(fails ? 1 : 0);
