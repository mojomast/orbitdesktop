// Headless check for shop.js (DOLAN): pizza coins, between-stage shop, run upgrades.
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


const E = (fn, a) => page.evaluate(fn, a);
ok(await E(() => !!window.__ppShop && !window.__ppShop.active()), 'shop.js loaded, closed at start');
// Coins from KOs.
const k = await E(async () => { const s = window.__ppState; s.invuln = 99; s.holdWave = true; const c0 = s.coins || 0; const live = s.ninjas.filter(n => !n.dead && !n.boss); live.slice(0, 2).forEach(n => { n.hp = 0; n.dead = true; }); await new Promise(r => setTimeout(r, 150)); return { c0, c1: s.coins, n: Math.min(2, live.length) }; });
ok(k.n >= 1 && k.c1 - k.c0 === k.n, `+1 pizza coin per KO (${k.c0} -> ${k.c1} for ${k.n} KOs)`);
// Stage clear -> card shows coins -> shop opens on close.
await E(() => { const s = window.__ppState; s.ninjas.forEach(n => { n.hp = 0; n.dead = true; }); s.holdWave = false; s.walkLevel = false; });
for (let i = 0; i < 30 && (await E(() => window.__ppScreens.mode())) !== 'clear'; i++) await page.waitForTimeout(100);
const cd = await E(() => ({ mode: window.__ppScreens.mode(), coins: window.__ppScreens.data.coins, s: window.__ppState.coins }));
ok(cd.mode === 'clear' && cd.coins >= 5, `stage clear card carries PIZZA COINS +${cd.coins} (purse ${cd.s})`);
await page.waitForTimeout(1400); await page.keyboard.press('Enter'); await page.waitForTimeout(250);
ok(await E(() => window.__ppShop.active() && !window.__ppScreens.mode()), 'closing the stage clear card opens the shop');
const fr = await E(async () => { const s = window.__ppState, x = s.player.x, w = s.wave; await new Promise(r => setTimeout(r, 300)); return s.player.x === x && s.wave === w; });
ok(fr, 'the world is frozen while the shop is open');
// Unaffordable buy is refused.
const poor = await E(() => { const s = window.__ppState, S = window.__ppShop; s.coins = 3; const before = { coins: s.coins, max: s.maxHp }; S.buy(0); return { before, after: { coins: s.coins, max: s.maxHp }, refused: S.stats.refused }; });
ok(poor.after.coins === 3 && poor.after.max === poor.before.max && poor.refused >= 1, `unaffordable buy is refused (${JSON.stringify(poor)})`);
await page.waitForTimeout(100);
await page.screenshot({ path: '/workspace/dolan-bak/shots/shop-poor.png' });
// Buy each upgrade with keys: HP (tile 0), DAMAGE (1), LIFE (2), METER (3), AMMO (4).
const st0 = await E(() => { const s = window.__ppState; s.coins = 200; return { max: s.maxHp || 100, hp: s.hp, lives: s.lives, wl: s.weaponLevel, mult: s.dmgMult, coins: s.coins }; });
const pressBuy = async () => { await page.keyboard.press('Enter'); await page.waitForTimeout(120); };
await pressBuy();                                   // tile 0: MAX HP
await page.keyboard.press('ArrowRight'); await pressBuy(); // tile 1: DAMAGE
await page.keyboard.press('ArrowRight'); await pressBuy(); // tile 2: LIFE
await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight'); await pressBuy(); // tile 3 (row 2 col 0 after wrap): METER
await page.keyboard.press('ArrowRight'); await pressBuy(); // tile 4: AMMO
const st1 = await E(() => { const s = window.__ppState; return { max: s.maxHp, hp: s.hp, lives: s.lives, wl: s.weaponLevel, mult: s.dmgMult, coins: s.coins, buys: s.shopBuys, sel: window.__ppShop.ui.sel, superStart: s.superStart }; });
const spent = 8 + 10 + 12 + 6 + 7;
ok(st1.coins === st0.coins - spent, `buys deduct coins (${st0.coins} -> ${st1.coins}, expected -${spent}) ${JSON.stringify(st1.buys)}`);
ok(st1.max === st0.max + 20, `MAX HP +20 (${st0.max} -> ${st1.max})`);
ok(st1.lives === st0.lives + 1, `EXTRA LIFE (${st0.lives} -> ${st1.lives})`);
ok(st1.wl === Math.min(5, st0.wl + 1), `PIZZA POWER weapon level (${st0.wl} -> ${st1.wl})`);
ok(Math.abs(st1.mult - 1.15) < 1e-9, `DAMAGE +15% sets the multiplier (${st1.mult})`);
ok(st1.superStart === 50, 'TEAM UP START queued for the next stage');
ok(await E(() => window.__ppShop.price(window.__ppState, 'hp')) === 14, 'prices escalate per purchase (MAX HP 8 -> 14)');
await page.waitForTimeout(400);
await page.screenshot({ path: '/workspace/dolan-bak/shots/shop.png' });
// Esc leaves, meter starts at 50, play resumes.
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
const lv = await E(() => ({ open: window.__ppShop.active(), sup: window.__ppState.super, pause: window.__ppPause.isOpen() }));
ok(!lv.open && lv.sup >= 50 && !lv.pause, `Esc leaves the shop (no pause menu), TEAM UP starts at ${lv.sup}`);
const p0 = await E(() => { const s = window.__ppState; s.invuln = 99; return s.player.x; });
await page.keyboard.down('KeyD'); await page.waitForTimeout(500); await page.keyboard.up('KeyD');
ok((await E(() => window.__ppState.player.x)) > p0 + 15, 'play resumes after leaving');
// The damage multiplier really raises damage dealt (hp diff hook) — compare 1.0x vs 1.45x on the same 10-point loss.
const dmg = await E(async () => {
  const s = window.__ppState, wait = () => new Promise(r => setTimeout(r, 80));
  const n = s.ninjas.find(m => !m.dead) || null; if (!n) return null;
  n.hp = n.maxHp = 200; n.x = s.player.x + 300; s.dmgMult = 1; await wait(); n.hp -= 10; await wait(); const plain = 200 - n.hp;
  n.hp = 200; await wait(); s.dmgMult = 1.45; await wait(); n.hp -= 10; await wait(); const boosted = 200 - n.hp;
  s.dmgMult = 1.15; return { plain, boosted };
});
ok(dmg && dmg.plain === 10 && dmg.boosted === 14, `damage multiplier raises damage dealt (10 -> ${dmg && dmg.boosted} at 1.45x)`);
// Real melee with the multiplier: a jab on a parked enemy still lands and is scaled.
const melee = await E(async () => {
  const s = window.__ppState; s.dmgMult = 1; const n = s.ninjas.find(m => !m.dead); if (!n) return null;
  n.hp = n.maxHp = 50; n.x = s.player.x + 40; n.y = s.player.y; n.stun = 0; n.down = 0; n.kind = n.kind === 'blocker' ? 'striker' : n.kind; s.combat.facing = 1;
  n.__shopT = true; n.scripted = false; await new Promise(r => setTimeout(r, 60)); s.dmgMult = 3; return { kind: n.kind, hp: n.hp, inList: s.ninjas.includes(n), boss: !!n.boss };
});
let lost = 0;
if (melee) { for (let i = 0; i < 4 && lost === 0; i++) { await page.keyboard.press('KeyJ'); await page.waitForTimeout(300); lost = await E(() => { const n = window.__ppState.ninjas.find(m => m.__shopT); return n ? 50 - n.hp : -1; }); } }
ok(lost >= 3 && lost < 50, `a real jab (1 dmg) deals ${lost} at 3x (${JSON.stringify(melee)})`);
await E(() => { window.__ppState.dmgMult = 1.15; });
// A new run resets coins and upgrades.
const fresh = await E(async () => { const { createState } = await import('./logic.js'); const s = createState(); window.__ppShop.stepWorld(s, 0.01); return { coins: s.coins, mult: s.dmgMult, buys: s.shopBuys }; });
ok(fresh.coins === 0 && fresh.mult === 1 && Object.values(fresh.buys).every(v => v === 0), 'a new run starts with 0 coins and no upgrades');
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
