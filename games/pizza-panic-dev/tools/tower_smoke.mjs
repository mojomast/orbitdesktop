// Headless smoke test for the OpenClaw Tower (baba_booey): jump the run to the
// tower, walk lobby / server floor / elevator / penthouse, fight SHREDCLAW;
// screenshots per section and 0 console errors.
// usage: node tools/tower_smoke.mjs [outdir]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../../pizza-panic/', import.meta.url).pathname;
const OUT = process.argv[2] || '/workspace/pizza-tower';
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
const snap = async name => { const f = path.join(OUT, `tower-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };
ok(!!(await page.evaluate(() => window.__ppTower && window.__ppState)), 'tower.js loaded (window.__ppTower)');
// Jump the run to the tower: the rooftop level end hands over to the next wave.
const lvl = await page.evaluate(async () => {
  const L = await import('./logic.js'); const s = window.__ppState;
  s.ninjas = []; s.wave = L.LEVEL_ORDER.indexOf(4); s.level = L.LEVEL_ORDER[s.wave - 1]; s.walkLevel = false; s.holdWave = false; s.invuln = 999;
  return L.LEVEL_ORDER;
});
for (let i = 0; i < 40 && (await page.evaluate(() => window.__ppState.level)) !== 4; i++) { await page.waitForTimeout(150); await page.keyboard.press('Enter'); }
for (let i = 0; i < 20 && await page.evaluate(() => window.__ppScreens?.active?.()); i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(250); }
await skipCine();
const st = await page.evaluate(() => ({ level: window.__ppState.level, x: window.__ppState.player.x }));
ok(st.level === 4, `reached the tower after the rooftop (level ${st.level}, order ${lvl.join(',')})`);
const imgs = await page.evaluate(() => Object.keys(window.__ppParallax?.images || {}).filter(k => /tower/.test(k)));
// Visit each section: clear the beats before x, park the hero, keep the beat's fight.
const goTo = async (x, fight) => page.evaluate(([x, fight]) => {
  const s = window.__ppState; s.invuln = 999; s.hp = s.maxHp;
  for (const n of s.ninjas) n.dead = true; s.ninjas = [];
  if (s.events) { s.events.lock = null; s.events.cooldown = 0; s.events.camX = null; }
  s.player.x = x; s.player.y = 440; s.cameraX = Math.max(0, x - 330);
  return fight;
}, [x, fight]);
const markFired = async upto => page.evaluate(async upto => { const E = await import('./events.js'); const s = window.__ppState; for (const b of E.TRIGGERS) if (b.level === 4 && b.x < upto) s.events.fired[b.level + ':' + b.x] = true; }, upto);
await markFired(300); await goTo(305); await page.waitForTimeout(1500); await snap('1-lobby');
await markFired(2150); await goTo(2155); await page.waitForTimeout(1400); await snap('2-server-floor');
await markFired(3000); await goTo(3002); await page.waitForTimeout(1600);
let el = await page.evaluate(() => window.__ppTower.info(window.__ppState).elev);
ok(!!el && !el.done, 'elevator ride started ' + JSON.stringify(el));
await snap('3-elevator');
// Clear the ride's drops one by one until the doors open.
for (let i = 0; i < 80; i++) {
  el = await page.evaluate(() => { const s = window.__ppState; s.invuln = 999; s.hp = s.maxHp; const n = s.ninjas.find(m => !m.dead); if (n) { n.hp = 0; n.dead = true; } return window.__ppTower.info(s).elev; });
  if (el.done) break; await page.waitForTimeout(250);
  if (i === 6) await snap('3b-elevator-climb');
}
ok(el.done && el.drops === 2, 'elevator arrived after its 2 drops ' + JSON.stringify(el));
await page.waitForTimeout(300); await snap('4-elevator-arrive');
await markFired(4650); await goTo(4655); await page.waitForTimeout(400); await skipCine(); await page.waitForTimeout(2200);
const boss = await page.evaluate(() => { const s = window.__ppState; const n = s.ninjas.find(m => m.kind === 'boss' && !m.dead); return n ? { name: n.name, bar: s.bossBar && s.bossBar.name, x: Math.round(n.x) } : null; });
ok(boss && boss.name === 'SHREDCLAW' && boss.bar === 'SHREDCLAW', 'SHREDCLAW in the penthouse ' + JSON.stringify(boss));
await snap('5-penthouse-shredclaw');
await page.waitForTimeout(1200); await snap('5b-penthouse-fight');
ok(errors.length === 0, `0 console errors (${errors.length})` + (errors.length ? '\n  ' + errors.slice(0, 8).join('\n  ') : ''));
console.log('screenshots:\n  ' + shots.join('\n  '));
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
