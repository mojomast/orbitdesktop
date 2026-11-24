// Headless check for breakables.js: props take melee hits, shatter, free their footprint and drop pickups.
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
ok(await page.evaluate(() => !!window.__ppBreak), 'breakables.js loaded');
// Park the hero just left of the first sewer barrel (x 700) in its lane, road clear.
const setup = () => page.evaluate(() => { const s = window.__ppState, B = window.__ppBreak; const b = B.list(s)[0]; s.ninjas.forEach(n => { n.hp = 0; n.dead = true; }); s.holdWave = true; s.player.x = b.x0 - 22; s.player.y = b.footY; s.combat.facing = 1; s.invuln = 99; return { name: b.p.name, hp: b.hp, x0: b.x0, ob: b.ob ? b.ob.x : null }; });
const b0 = await setup();
ok(b0.name === 'barrel' && b0.hp === 2 && b0.ob !== null, `first sewer prop is a 2-hit barrel with a live footprint (${JSON.stringify(b0)})`);
let hits = 0;
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('KeyJ'); await page.waitForTimeout(380);
  hits = await page.evaluate(() => window.__ppBreak.stats.hits);
  if (await page.evaluate(() => window.__ppBreak.list(window.__ppState)[0].broken)) break;
  await setup();
}
let st = await page.evaluate(() => { const B = window.__ppBreak, b = B.list(window.__ppState)[0]; return { broken: b.broken, hits: B.stats.hits, debris: B.debris.length, pickups: B.pickups.length, obx: b.ob.x }; });
ok(st.hits >= 2 && st.broken, `melee hits break the barrel (${JSON.stringify(st)})`);
ok(st.debris > 0, 'smashing throws debris');
ok(st.pickups === 1, 'smashing drops a pickup');
ok(st.obx < -1000, 'the broken prop no longer blocks walking');
await page.waitForTimeout(100); await snap('break-smash');
// Walk onto the pickup.
const before = await page.evaluate(() => { const s = window.__ppState, k = window.__ppBreak.pickups[0]; s.hp = 40; return { type: k.type, hp: s.hp, score: s.score }; });
await page.waitForTimeout(900);
await page.evaluate(() => { const s = window.__ppState, k = window.__ppBreak.pickups[0]; if (k) { s.player.x = k.x; s.player.y = k.y; } });
await page.waitForTimeout(300);
const after = await page.evaluate(() => ({ n: window.__ppBreak.pickups.length, c: window.__ppBreak.stats.collected, hp: window.__ppState.hp, score: window.__ppState.score }));
ok(after.c === 1 && after.n === 0, `walking over the ${before.type} collects it`);
ok(after.hp > before.hp || after.score > before.score, `pickup pays out (hp ${before.hp}->${after.hp}, score ${before.score}->${after.score})`);
// Every drop table works and non-breakables (valve) stay put.
const tbl = await page.evaluate(() => { const s = window.__ppState, B = window.__ppBreak; const L = B.list(s); const valve = B.smash(s, 1); const crate = B.smash(s, 2); return { valve: valve.p.name, vb: valve.broken, crate: crate.p.name, cb: crate.broken, pk: B.pickups.map(k => k.type) }; });
ok(tbl.valve === 'valve' && !tbl.vb, 'valves cannot be broken');
ok(tbl.crate === 'crate' && tbl.cb && tbl.pk.length === 1, `crates break and drop (${tbl.pk})`);
await page.evaluate(() => { const s = window.__ppState; s.player.x = 1600; s.player.y = window.__ppBreak.list(s)[2].footY; });
await page.waitForTimeout(500); await snap('break-crate');
// A new run restores everything.
await page.evaluate(() => { const s = window.__ppState; s.over = true; });
const fresh = await page.evaluate(async () => { const { createState } = await import('./logic.js'); const s = createState(); s.level = 0; const L = window.__ppBreak.list(s); return { broken: L.filter(b => b.broken).length, obx: L[0].ob.x }; });
ok(fresh.broken === 0 && fresh.obx > 0, 'a new run restores props and footprints');
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
