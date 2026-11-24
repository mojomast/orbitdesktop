// Headless check for screens.js: stage clear results, CONTINUE countdown, game over, ending + credits.
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
// Stage clear: clear the road and release the level hold, as events.js does at the level end.
const w0 = await page.evaluate(() => { const s = window.__ppState; s.ninjas.forEach(n => { n.hp = 0; n.dead = true; }); s.holdWave = false; s.walkLevel = false; return s.wave; });
await page.waitForTimeout(500);
let m = await page.evaluate(() => ({ mode: window.__ppScreens.mode(), wave: window.__ppState.wave, d: window.__ppScreens.data }));
ok(m.mode === 'clear' && m.wave === w0 + 1, `stage clear shows when the level ends (mode ${m.mode}, wave ${w0}->${m.wave})`);
ok(m.d && m.d.name === 'SEWER' && m.d.num === 1 && m.d.kos >= 2, `results name the stage and count KOs (${m.d && m.d.name}, kos ${m.d && m.d.kos}, bonus ${m.d && m.d.total})`);
const px = await page.evaluate(() => window.__ppState.player.x); await page.waitForTimeout(300);
ok(px === await page.evaluate(() => window.__ppState.player.x), 'world is frozen behind the results card');
// dolan (juice): rank stamp + count-up skip.
let jz = await page.evaluate(() => ({ j: window.__ppScreens.juice, d: window.__ppScreens.data, t: window.__ppScreens.t }));
ok(['S', 'A', 'B', 'C'].includes(jz.j.rank) && jz.j.rank === (jz.d.hits === 0 && jz.d.secs <= 90 ? 'S' : jz.d.total >= 6500 || jz.d.hits === 0 ? 'A' : jz.d.total >= 3000 ? 'B' : 'C'), `rank is computed from bonus + no-damage (rank ${jz.j.rank}, total ${jz.d.total}, hits ${jz.d.hits}, ${jz.d.secs}s)`);
if (jz.t < 1.1) { await page.keyboard.press('Enter'); await page.waitForTimeout(120); }
jz = await page.evaluate(() => ({ mode: window.__ppScreens.mode(), j: window.__ppScreens.juice }));
ok(jz.mode === 'clear' && jz.j.countDone && jz.j.stamped, `a press during the count-up skips to the end state, card stays (${JSON.stringify(jz)})`);
await page.waitForTimeout(350); await page.screenshot({ path: '/workspace/dolan-bak/shots/clear-juice.png' });
await page.waitForTimeout(1500); await snap('stage-clear');
await page.keyboard.press('Enter'); await page.waitForTimeout(200);
ok(await page.evaluate(() => window.__ppScreens.mode()) === null, 'a key dismisses the results card');
// dolan: the between-stage shop opens next; leave it.
if (await page.evaluate(() => window.__ppShop && window.__ppShop.active())) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
// Game over -> CONTINUE countdown -> continue.
const kill = () => page.evaluate(async () => { const { damagePlayer } = await import('./logic.js'); const s = window.__ppState; s.lives = 1; s.invuln = 0; s.player.shield = false; damagePlayer(s, 9999); return s.over; });
ok(await kill(), 'player can be killed');
await page.waitForTimeout(300);
ok(await page.evaluate(() => window.__ppScreens.mode()) === 'continue', 'game over opens the CONTINUE countdown');
await page.waitForTimeout(1200); await snap('continue');
const dr = await page.evaluate(() => window.__ppScreens.juice.drain);
ok(dr > 0.08 && dr < 0.3, `the world behind drains as the countdown runs (drain ${dr.toFixed(2)} at ~1.5s)`);
await page.keyboard.press('Enter'); await page.waitForTimeout(300);
m = await page.evaluate(() => ({ mode: window.__ppScreens.mode(), over: window.__ppState.over, lives: window.__ppState.lives, hp: window.__ppState.hp, c: window.__ppState.continues }));
ok(m.mode === null && !m.over && m.lives === 3 && m.hp > 0 && m.c === 1, `continue resumes with full HP and 3 lives (${JSON.stringify(m)})`);
// Let the countdown run out -> final GAME OVER -> title.
await kill(); await page.waitForTimeout(400);
for (let i = 0; i < 3; i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(100); }
const tNow = await page.evaluate(() => window.__ppScreens.t);
ok(tNow >= 3, 'other buttons speed the countdown (' + tNow.toFixed(1) + 's)');
const wait1 = Math.max(0, Math.round((7.3 - tNow) * 1000)); await page.waitForTimeout(wait1);
const dr2 = await page.evaluate(() => window.__ppScreens.juice.drain); await page.screenshot({ path: '/workspace/dolan-bak/shots/continue-juice.png' });
ok(dr2 > 0.6, `drain deepens near the end (${dr2.toFixed(2)} with ~3s left)`);
await page.waitForTimeout(8000 - wait1);
ok(await page.evaluate(() => window.__ppScreens.mode()) === 'final', 'countdown expiring shows the final GAME OVER');
await page.waitForTimeout(1200); await snap('game-over');
await page.keyboard.press('Enter'); await page.waitForTimeout(300);
ok(await page.evaluate(() => window.__ppScreens.mode()) === 'initials', 'a qualifying score opens initials entry');
await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200); await snap('initials');
for (const k of ['KeyK', 'KeyY', 'KeyL']) { await page.keyboard.press(k); await page.waitForTimeout(80); }
m = await page.evaluate(() => ({ mode: window.__ppScreens.mode(), top: window.__ppScreens.scores()[0], rank: window.__ppScreens.entry.rank }));
ok(m.mode === 'scores' && m.top && m.top.n === 'KYL' && m.top.score === 9800 && m.rank === 0, `typed initials land in the table (${JSON.stringify(m.top)})`);
await page.waitForTimeout(1300); await snap('high-scores');
await page.keyboard.press('Enter'); await page.waitForTimeout(300);
ok(await page.evaluate(() => window.__ppTitle.isActive() && window.__ppScreens.mode() === null), 'GAME OVER -> initials -> table returns to the title');
const low = await page.evaluate(async () => { const m = await import('./screens.js'); const l = m.loadScores(); return { q0: m.qualifies(0, l), qBig: m.qualifies(1e9, l) }; });
ok(!low.q0 && low.qBig, 'score 0 never qualifies, a big score always does');
// Ending + credits: run the real ending cinematic callback path.
for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(120); await page.keyboard.press('Enter'); await page.waitForTimeout(120); }
if (await page.evaluate(() => window.__ppSelect?.active)) { await page.keyboard.press('Enter'); await page.waitForTimeout(300); }
for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
await page.evaluate(() => { const s = window.__ppState; s.score = 123450; window.__ppCinema.play('ending', () => { s.over = true; window.__ppScreens.ending(s); }); });
await page.waitForTimeout(300); await page.keyboard.press('Escape'); await page.waitForTimeout(400);
ok(await page.evaluate(() => window.__ppScreens.mode()) === 'credits', 'ending cinematic hands off to the credits');
await page.waitForTimeout(2500); await snap('ending-card');
await page.evaluate(() => { window.__ppScreens.press('KeyX'); window.__ppScreens.press('KeyX'); });
await page.waitForTimeout(3500); await snap('credits-roll');
await page.keyboard.press('Escape'); await page.waitForTimeout(300); await snap('the-end');
ok(await page.evaluate(() => window.__ppScreens.rollDone), 'Esc skips to THE END');
await page.keyboard.press('Enter'); await page.waitForTimeout(300);
ok(await page.evaluate(() => window.__ppScreens.mode()) === 'initials', 'after the credits a qualifying run enters initials');
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
m = await page.evaluate(() => ({ list: window.__ppScreens.scores(), rank: window.__ppScreens.entry.rank }));
ok(m.rank === 0 && m.list[0].score === 123450 && m.list[0].stage === 'ALL CLEAR' && m.list[1].n === 'KYL', 'ALL CLEAR run ranks first and keeps the earlier entry');
await page.waitForTimeout(1200); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
ok(await page.evaluate(() => window.__ppTitle.isActive() && window.__ppScreens.mode() === null), 'credits -> table return to the title');
ok(errors.length === 0, `0 console errors (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
