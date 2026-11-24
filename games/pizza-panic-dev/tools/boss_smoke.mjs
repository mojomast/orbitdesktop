// Headless boss smoke test: boot, pick a hero, spawn each walking level's gate
// boss next to the hero, wait for a telegraph, screenshot, force a phase change,
// check the boss bar pixels and 0 console errors.
// usage: node tools/boss_smoke.mjs [outdir]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../../pizza-panic/', import.meta.url).pathname;
const OUT = process.argv[2] || '/workspace/pizza-boss';
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
ok(!!(await page.evaluate(() => window.__ppBoss && window.__ppState)), 'boss module loaded (window.__ppBoss)');
const shots = [];
for (const [lv, kind, name] of [[0, 'charger', 'SEWER ENFORCER'], [1, 'charger', 'CLAW BRUISER'], [2, 'boss', 'SHREDCLAW']]) {
  await page.evaluate(({ lv, kind }) => {
    const s = window.__ppState; s.level = lv; s.ninjas = []; s.invuln = 999; s.hp = s.maxHp; s.bossFight = null;
    if (s.events) s.events.lock = null;
    const p = s.player; p.y = lv === 2 ? 395 : 410;
    s.ninjas.push({ kind, level: lv, x: p.x + 230, y: p.y, r: 22, hp: 10, maxHp: 10, vx: 0, vy: 0, levelBoss: true, elite: true, name: 'X' });
  }, { lv, kind });
  await skipCine();
  let a = null;
  for (let i = 0; i < 60; i++) { await page.waitForTimeout(100); await skipCine(); a = await page.evaluate(() => window.__ppBoss.info(window.__ppState).active); if (a && a.attack && a.attack.phase === 'wind') break; }
  ok(a && a.name === name, `level ${lv}: ${name} active`);
  ok(a && a.attack && a.attack.phase === 'wind', `level ${lv}: telegraph visible (${a && a.attack ? a.attack.type : 'none'})`);
  const f = path.join(OUT, `boss-${lv}-${name.toLowerCase().replace(/\W+/g, '-')}.png`);
  await page.screenshot({ path: f }); shots.push(f);
  // Force a phase change and check the bar pixels (top bar region).
  await page.evaluate(() => { const s = window.__ppState, b = s.bossFight.active; b.invuln = 0; b.mode = 'fight'; b.n.hp -= (b.hp - b.thresholds[0]) + 1; });
  await page.waitForTimeout(250);
  const info = await page.evaluate(() => window.__ppBoss.info(window.__ppState).active);
  ok(info && info.phase === 2, `level ${lv}: phase 2 after threshold (hp ${info && info.hp})`);
  const bar = await page.evaluate(() => { const c = document.getElementById('c').getContext('2d'); const d = c.getImageData(160, 468, 300, 6).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 200) lit++; return lit; });
  ok(bar > 100, `level ${lv}: boss bar drawn (${bar} lit px)`);
  await page.waitForTimeout(700);
  const f2 = path.join(OUT, `boss-${lv}-phase2.png`); await page.screenshot({ path: f2 }); shots.push(f2);
}
await page.evaluate(() => { const s = window.__ppState; s.ninjas = []; });
await page.waitForTimeout(600); await skipCine();
ok(errors.length === 0, `0 console errors (${errors.length})` + (errors.length ? '\n  ' + errors.slice(0, 8).join('\n  ') : ''));
console.log('screenshots:\n  ' + shots.join('\n  '));
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
