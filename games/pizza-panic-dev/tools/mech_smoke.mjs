// Headless smoke test for the CLAW WALKER mech mini boss (baba_booey): jump the
// run to the OpenClaw Tower lobby gate, let boss.js adopt the mech, force each
// attack and screenshot wind-up / active / punish window; 0 console errors.
// usage: node tools/mech_smoke.mjs [outdir]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../../pizza-panic/', import.meta.url).pathname;
const OUT = process.argv[2] || '/workspace/pizza-mech';
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
const snap = async name => { const f = path.join(OUT, `mech-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };
await page.evaluate(async () => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas = []; s.wave = L.LEVEL_ORDER.indexOf(4); s.level = L.LEVEL_ORDER[s.wave - 1]; s.walkLevel = false; s.holdWave = false; s.invuln = 999; });
for (let i = 0; i < 40 && (await page.evaluate(() => window.__ppState.level)) !== 4; i++) { await page.waitForTimeout(150); await page.keyboard.press('Enter'); }
for (let i = 0; i < 20 && await page.evaluate(() => window.__ppScreens?.active?.()); i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(250); }
await skipCine();
ok((await page.evaluate(() => window.__ppState.level)) === 4, 'in the OpenClaw Tower');
const imgs = await page.evaluate(async () => { const m = await import('./mech.js'); await new Promise(r => setTimeout(r, 400)); return Object.keys(m.mechImages).length; });
ok(imgs === 7, `mech parts loaded (${imgs}/7)`);
await page.evaluate(async () => { const E = await import('./events.js'); const s = window.__ppState; s.ninjas = []; s.invuln = 999; s.hp = s.maxHp;
  for (const b of E.TRIGGERS) if (b.level === 4 && b.x < 1300) s.events.fired[b.level + ':' + b.x] = true;
  s.events.lock = null; s.events.cooldown = 0; s.player.x = 1305; s.player.y = 440; s.cameraX = 975; });
await page.waitForTimeout(600); await skipCine();
await page.evaluate(() => { const s = window.__ppState; s.ninjas.filter(n => !n.mech).forEach(n => { n.dead = true; }); });
await page.waitForTimeout(1500);
const adopted = await page.evaluate(() => { const s = window.__ppState, n = s.ninjas.find(m => m.mech && !m.dead); return n ? { name: n.name, bar: s.bossBar && s.bossBar.name } : null; });
ok(adopted && adopted.name === 'CLAW WALKER' && adopted.bar === 'CLAW WALKER', 'mech adopted with the boss bar ' + JSON.stringify(adopted));
await snap('0-walk');
const force = (name, dx, phase) => page.evaluate(([name, dx, phase]) => { const s = window.__ppState, b = s.bossFight.active; s.invuln = 999; s.hp = s.maxHp; s.ninjas.filter(n => !n.mech).forEach(n => { n.dead = true; });
  b.mode = 'fight'; b.atk = null; b.cd = 0; b.phase = phase; b.next = name; b.n.x = s.player.x + dx; b.n.y = s.player.y; b.n.vx = 0; }, [name, dx, phase]);
const waitPhase = async (ph, max = 60) => { for (let i = 0; i < max; i++) { const a = await page.evaluate(() => { const b = window.__ppState.bossFight.active; return b && b.atk ? b.atk.phase + ':' + (b.atk.t).toFixed(2) : null; }); if (a && a.startsWith(ph)) return a; await page.waitForTimeout(30); } return null; };
const seen = {};
for (const [name, dx, phase] of [['claw', 110, 0], ['stomp', 160, 0], ['gatling', 260, 0], ['missiles', 240, 1]]) {
  await force(name, dx, phase);
  const w = await waitPhase('wind'); await page.waitForTimeout(300); await snap(`${name}-1-wind`);
  const a = await waitPhase('active'); await snap(`${name}-2-active`);
  const r = await waitPhase('recover'); await page.waitForTimeout(150);
  const weak = await page.evaluate(() => !!(window.__ppState.bossBar && window.__ppState.bossBar.weak));
  await snap(`${name}-3-punish`);
  seen[name] = { w: !!w, a: !!a, r: !!r, weak };
  ok(w && a && r && weak, `${name}: wind -> active -> recover with the cockpit open`);
  await page.waitForTimeout(1200);
}
// Defeat: finish it from the punish window, check the defeat signal.
const def = await page.evaluate(async () => { const s = window.__ppState, b = s.bossFight.active; const L = await import('./logic.js');
  b.phase = 1; b.invuln = 0; b.atk = null; b.mode = 'fight'; b.hp = 0.5; L.damageNinja(s, b.n, 5); return true; });
await page.waitForTimeout(900);
const done = await page.evaluate(() => ({ d: window.__ppState.bossDefeated, run: !!window.__ppState.runComplete }));
ok(done.d && done.d.id === 'mech' && !done.d.final && !done.run, 'defeat signal (non-final) ' + JSON.stringify(done));
await snap('9-defeated');
ok(errors.length === 0, `0 console errors (${errors.length})` + (errors.length ? '\n  ' + errors.slice(0, 8).join('\n  ') : ''));
console.log('screenshots:\n  ' + shots.join('\n  '));
await browser.close(); server.close();
process.exit(fails ? 1 : 0);
