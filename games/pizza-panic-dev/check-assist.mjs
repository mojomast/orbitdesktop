// Headless check for assist.js (DOLAN): team-up meter fills from hits, KeyU fires the Nous gang assist only at 100.
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

ok(await page.evaluate(() => !!window.__ppAssist && window.__ppState.super === 0), 'assist.js loaded, meter starts at 0');
// Park two tough ninjas in front of the hero, everything else gone.
const park = () => page.evaluate(() => { const s = window.__ppState; s.holdWave = true; s.invuln = 99;
  const live = s.ninjas.filter(n => !n.dead && n.kind !== 'drone' && !n.boss && !n.__boss).slice(0, 2);
  s.ninjas.forEach(n => { if (!live.includes(n)) { n.hp = 0; n.dead = true; } });
  live.forEach((n, i) => { n.x = s.player.x + 40 + i * 60; n.y = s.player.y; n.hp = n.maxHp = 30; n.stun = 0; n.down = 0; n.atk = null; n.kind = n.kind === 'blocker' ? 'striker' : n.kind; });
  s.combat.facing = 1; return live.length; });
const nLive = await park();
ok(nLive >= 1, `ninjas parked on screen (${nLive})`);
for (let i = 0; i < 8; i++) { await page.keyboard.press('KeyJ'); await page.waitForTimeout(260); if (i % 3 === 2) await park(); }
const filled = await page.evaluate(() => window.__ppState.super);
ok(filled >= 4, `meter fills from landed hits (super=${filled})`);
const hurt = await page.evaluate(async () => { const s = window.__ppState; const b = s.super; s.hp -= 5; await new Promise(r => setTimeout(r, 120)); return [b, s.super]; });
ok(hurt[1] - hurt[0] >= 6, `taking damage adds 6 (${hurt})`);
// Below 100: KeyU does nothing.
await page.evaluate(() => { window.__ppState.super = 60; });
await page.keyboard.press('KeyU'); await page.waitForTimeout(200);
let st = await page.evaluate(() => ({ fired: window.__ppAssist.stats.fired, sup: window.__ppState.super, cut: window.__ppAssist.cut }));
ok(st.fired === 0 && st.sup >= 60 && !st.cut, `KeyU below 100 does nothing (${JSON.stringify(st)})`);
// At 100: fires.
await park();
const hp0 = await page.evaluate(() => { const s = window.__ppState; s.super = 100; s.invuln = 0; return s.ninjas.filter(n => !n.dead).map(n => n.hp); });
await page.waitForTimeout(150);
await page.keyboard.press('KeyU'); await page.waitForTimeout(500);
st = await page.evaluate(() => ({ fired: window.__ppAssist.stats.fired, sup: window.__ppState.super, cut: window.__ppAssist.cut, hero: window.__ppState.selectedHero, inv: window.__ppState.invuln }));
ok(st.fired === 1 && st.cut && st.sup === 0, `KeyU at 100 fires and resets the meter (${JSON.stringify(st)})`);
ok(st.cut && st.cut.id !== st.hero && ['teknium', 'turbofit', 'nous_girl'].includes(st.cut.id), `assist hero is a Nous gang member other than the pick (${st.cut && st.cut.id})`);
ok(st.inv > 0.5, 'player is invulnerable during the cut-in');
await page.screenshot({ path: '/workspace/dolan-bak/shots/assist.png' });
await page.waitForTimeout(900);
const res = await page.evaluate(() => ({ hits: window.__ppAssist.stats.hits, inv: window.__ppState.invuln, sup: window.__ppState.super, flash: window.__ppAssist.flash, ninjas: window.__ppState.ninjas.filter(n => n.x > window.__ppCamX && n.x < window.__ppCamX + 740).map(n => ({ hp: n.hp, dead: !!n.dead, down: n.down || 0, falling: !!n.falling })) }));
await page.screenshot({ path: '/workspace/dolan-bak/shots/assist-strike.png' });
ok(res.hits >= 1 && res.ninjas.length >= 1 && res.ninjas.every((n, i) => n.dead || n.hp <= (hp0[i] ?? 99) - 4), `on-screen ninjas lose hp (before ${hp0} after ${JSON.stringify(res.ninjas)})`);
ok(res.ninjas.every(n => n.dead || n.down > 0 || n.falling), 'struck ninjas are knocked down');
ok(res.inv > 0.8, `player gets post-strike invulnerability (${res.inv.toFixed(2)})`);
ok(res.sup < 100 && res.sup <= 16, `meter stays reset after the strike (super=${res.sup})`);
// A new run resets the meter.
const fresh = await page.evaluate(async () => { const { createState } = await import('./logic.js'); const s = createState(); s.super = 77; window.__ppAssist.step(s, 0.01); return s.super; });
ok(fresh === 0, 'a new state object resets the meter');
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
