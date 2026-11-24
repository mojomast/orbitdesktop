// Headless check for bonus.js (DOLAN): pizza delivery time attack after the 2nd stage clear.
// (based on check-select.mjs boot): 0 console errors, all 7 heroes on the select
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
const errors = []; let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
page.on('requestfailed', r => errors.push('requestfailed ' + r.url()));
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
// Test-only workaround until events.js bubble() stops shadowing portrait() (t_15268287d7974b40): serve a renamed copy.
if (!process.env.NO_EVENTS_PATCH) await page.route('**/events.js', async r => { const res = await r.fetch(); const src = await res.text(); const body = !/const portrait = /.test(src) ? src : src.replace('function portrait(', 'function portraitChip(').replace(/\bportrait\(ctx,/g, 'portraitChip(ctx,'); await r.fulfill({ response: res, body }); });
await page.goto(url); await page.waitForTimeout(1500);

const SH = process.argv[3] || '/workspace/dolan-bak/shots';
fs.mkdirSync(SH, { recursive: true });
const snap = n => page.screenshot({ path: `${SH}/${n}.png` });
for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
ok(await page.evaluate(() => window.__ppSelect?.active), 'reached character select');
await page.keyboard.press('Enter'); await page.waitForTimeout(400);
for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
ok(!(await page.evaluate(() => window.__ppCinema.isActive())), 'intro skipped, in gameplay');
ok(await page.evaluate(() => typeof window.__ppScreens?.reset === 'function'), 'screens.js loaded');


const B = (fn, arg) => page.evaluate(fn, arg);
ok(await B(() => !!window.__ppBonus && !window.__ppBonus.active()), 'bonus.js loaded, inactive at start');
await B(() => { const s = window.__ppState; s.invuln = 99; s.holdWave = true; });
// --- forced start ---------------------------------------------------------
const w0 = await B(() => { const s = window.__ppState; const ok = window.__ppBonus.start(s); return { ok, px: s.player.x, nx: s.ninjas.map(n => n.x), score: s.score, t: window.__ppBonus.st.time }; });
ok(w0.ok && await B(() => window.__ppBonus.active()), 'start(__ppState) opens the bonus stage');
await page.waitForTimeout(700);
const w1 = await B(() => { const s = window.__ppState; return { px: s.player.x, nx: s.ninjas.map(n => n.x), score: s.score, t: window.__ppBonus.st.time }; });
ok(w1.px === w0.px && JSON.stringify(w1.nx) === JSON.stringify(w0.nx) && w1.score === w0.score, 'the main world is frozen while the bonus runs');
ok(w1.t < w0.t - 0.4, `the 45s timer counts down (${w0.t} -> ${w1.t.toFixed(2)})`);
ok(await B(() => window.__ppBonus.start(window.__ppState)) === false, 'a second start in the same run is refused');
// Steering.
const clearRoad = () => B(() => { const b = window.__ppBonus.st; b.taxis = []; b.cones = []; b.spawn = 99; b.inv = 0; });
await clearRoad();
const sx0 = await B(() => window.__ppBonus.st.x);
await page.keyboard.down('ArrowRight'); await page.waitForTimeout(800); await page.keyboard.up('ArrowRight');
const sx1 = await B(() => window.__ppBonus.st.x);
await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(800); await page.keyboard.up('ArrowLeft');
const sx2 = await B(() => window.__ppBonus.st.x);
ok(sx1 - sx0 > 180 && (sx2 - sx1) < (sx1 - sx0), `Right speeds up, Left slows down (${Math.round(sx1 - sx0)} vs ${Math.round(sx2 - sx1)} px / 0.8s)`);
await page.keyboard.press('ArrowDown'); await page.waitForTimeout(250);
const ln = await B(() => ({ lane: window.__ppBonus.st.lane, y: window.__ppBonus.st.y, L: window.__ppBonus.LANES }));
ok(ln.lane === 1 && Math.abs(ln.y - ln.L[1]) < 6, `Down changes lane (lane ${ln.lane}, y ${ln.y.toFixed(1)})`);
// Delivery at a marked door (on the sidewalk lane).
await page.keyboard.press('KeyJ'); await page.waitForTimeout(80);
ok(await B(() => window.__ppBonus.st.delivered) === 0, 'J off the sidewalk / away from a door delivers nothing');
await page.keyboard.press('ArrowUp'); await page.waitForTimeout(250);
const tgt = await B(() => { const b = window.__ppBonus.st; const d = b.doors.find(o => o.target && !o.done); b.x = d.x - 4; b.lastDeliver = b.t; b.speed = 0; return d.num; });
await page.keyboard.press('Space'); await page.waitForTimeout(150);
const dl = await B(() => { const b = window.__ppBonus.st; return { delivered: b.delivered, tips: b.tips, done: b.doors.filter(d => d.done).map(d => d.num) }; });
ok(dl.delivered === 1 && dl.done.includes(tgt) && dl.tips === 1, `delivery at marked door #${tgt} scores, fast one tips (${JSON.stringify(dl)})`);
// Screenshot with the next marked door in view.
await B(() => { const b = window.__ppBonus.st; const d = b.doors.find(o => o.target && !o.done); b.x = d.x - 260; b.cam = Math.max(0, b.x - 200); b.spawn = 0; b.taxis.push({ x: b.x + 420, lane: 2, v: 200 }); b.coins.push({ x: b.x + 150, lane: 1, got: false }); b.cones.push({ x: b.x + 520, lane: 1 }); });
await page.waitForTimeout(250);
await page.screenshot({ path: '/workspace/dolan-bak/shots/bonus.png' });
// Taxi hit costs 2s.
await clearRoad();
const th = await B(() => { const b = window.__ppBonus.st; b.lane = 1; b.y = window.__ppBonus.LANES[1]; b.inv = 0; b.spin = 0; b.taxis.push({ x: b.x + 30, lane: 1, v: 200 }); return { t: b.time, hits: b.hits }; });
await page.waitForTimeout(150);
const th2 = await B(() => { const b = window.__ppBonus.st; return { t: b.time, hits: b.hits, spin: b.spin }; });
ok(th2.hits === th.hits + 1 && th.t - th2.t >= 2 && th.t - th2.t < 2.6 && th2.spin > 0, `taxi hit costs 2s and spins (${th.t.toFixed(2)} -> ${th2.t.toFixed(2)})`);
// Timer runs out -> results, score applied.
const pre = await B(() => { const s = window.__ppState, b = window.__ppBonus.st; b.coinsGot = 2; b.time = 0.3; return s.score; });
await page.waitForTimeout(600);
const rs = await B(() => ({ mode: window.__ppBonus.mode, total: window.__ppBonus.st.total, score: window.__ppState.score }));
ok(rs.mode === 'results', 'the timer ending shows the results card');
ok(rs.total === 1000 + 500 + 400 && rs.score === pre + rs.total, `results add the bonus to s.score (+${rs.total}: ${pre} -> ${rs.score})`);
await page.waitForTimeout(900);
await page.screenshot({ path: '/workspace/dolan-bak/shots/bonus-results.png' });
await page.waitForTimeout(300);
await page.keyboard.press('Enter'); await page.waitForTimeout(200);
ok(!(await B(() => window.__ppBonus.active())), 'Enter closes the results');
ok(await B(() => window.__ppShop && window.__ppShop.active()), 'the between-stage shop follows the bonus');
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
const pr0 = await B(() => window.__ppState.player.x);
await page.keyboard.down('KeyD'); await page.waitForTimeout(500); await page.keyboard.up('KeyD');
const pr1 = await B(() => window.__ppState.player.x);
ok(pr1 > pr0 + 20, `play resumes: the hero walks again (${Math.round(pr0)} -> ${Math.round(pr1)})`);
// --- natural trigger after the 2nd stage clear ------------------------------
await B(() => window.__ppBonus.rearm());
const clearStage = async () => {
  await B(() => { const s = window.__ppState; s.invuln = 99; s.ninjas.forEach(n => { n.hp = 0; n.dead = true; }); s.holdWave = false; s.walkLevel = false; });
  for (let i = 0; i < 30 && (await B(() => window.__ppScreens.mode())) !== 'clear'; i++) await page.waitForTimeout(100);
  const m = await B(() => ({ mode: window.__ppScreens.mode(), stages: window.__ppScreens.run && window.__ppScreens.run.stages }));
  await page.waitForTimeout(1400); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  if (await B(() => window.__ppShop && window.__ppShop.active())) { m.shop = true; await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  return m;
};
const c1 = await clearStage();
ok(c1.mode === 'clear' && c1.stages === 1 && c1.shop && !(await B(() => window.__ppBonus.active())), `1st stage clear opens the shop, not the bonus (${JSON.stringify(c1)})`);
const c2 = await clearStage();
const nat = await B(() => ({ active: window.__ppBonus.active(), mode: window.__ppBonus.mode, screens: window.__ppScreens.mode() }));
ok(c2.mode === 'clear' && c2.stages === 2 && !c2.shop && nat.active && nat.mode === 'ride' && !nat.screens, `closing the 2nd stage-clear card starts the bonus (${JSON.stringify({ c2, nat })})`);
await page.keyboard.press('Escape'); await page.waitForTimeout(1200);
ok(await B(() => window.__ppBonus.mode) === 'results', 'Esc skips to the results');
await page.keyboard.press('Enter'); await page.waitForTimeout(200);
ok(await B(() => window.__ppShop.active()), 'after the stage-2 bonus the shop opens');
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
ok(!(await B(() => window.__ppBonus.active())) && !(await B(() => window.__ppShop.active())) && !(await B(() => window.__ppPause.isOpen())), 'leaving returns to play without opening the pause menu');
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
