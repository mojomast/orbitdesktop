// MR.INDIA rig generator sync (t_7abe3a5269614640). The generator (tools/gen_enemy_rigs.mjs) is run in
// dry-run mode (--out tmp) and its output must be byte-identical to the live enemy-rigs.js and
// hero-rigs.js, so a real regeneration can never silently overwrite a live rig. Also pins the drone
// claw/thruster rows to what skate.js drawDrone actually draws (open/half/closed pincer frames on the
// torso hinge 46,50; thruster attach 10,31), and checks the dry run leaves the live files untouched.
// Headless: skate-level claw drones and hover drones still draw and animate, 0 console errors.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http'; import crypto from 'node:crypto';
const DEV = new URL('./', import.meta.url).pathname, GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigsync-'));
const before = { e: sha(GAME + 'enemy-rigs.js'), h: sha(GAME + 'hero-rigs.js') };
execFileSync(process.execPath, [DEV + 'tools/gen_enemy_rigs.mjs', '--out', tmp], { encoding: 'utf8' });

await t('dry run (--out) leaves the live enemy-rigs.js and hero-rigs.js untouched', () => {
  assert.equal(sha(GAME + 'enemy-rigs.js'), before.e); assert.equal(sha(GAME + 'hero-rigs.js'), before.h); });
for (const f of ['enemy-rigs.js', 'hero-rigs.js']) await t(`generator output == live ${f} (byte-identical)`, () => {
  const a = fs.readFileSync(path.join(tmp, f), 'utf8'), b = fs.readFileSync(GAME + f, 'utf8');
  if (a !== b) { const al = a.split('\n'), bl = b.split('\n'); const d = al.map((l, i) => l !== bl[i] ? `${i + 1}: gen ${l.trim()} | live ${(bl[i] || '').trim()}` : null).filter(Boolean); throw new Error('drift:\n' + d.slice(0, 8).join('\n')); }
  return `(${sha(GAME + f)})`; });
await t('drone claw + thruster rows match what skate.js drawDrone draws', async () => {
  const { ENEMY_RIGS } = await import(new URL('../pizza-panic/enemy-rigs.js', import.meta.url).href); const d = ENEMY_RIGS.drone;
  for (const [k, py] of [['claw1', 26], ['claw2', 24], ['claw3', 20]]) { assert.equal(d[k].parent, 'torso', k + ' hinges on the torso (not chained)'); assert.deepEqual([d[k].px, d[k].py, d[k].ax, d[k].ay], [10, py, 46, 50], k); }
  assert.deepEqual([d.thruster.px, d.thruster.py, d.thruster.ax, d.thruster.ay, d.thruster.parent], [35, 20, 10, 31, 'torso']);
  const sk = fs.readFileSync(GAME + 'skate.js', 'utf8');
  assert.match(sk, /claw1: \[10, 26\], claw2: \[10, 24\], claw3: \[10, 20\]/); assert.match(sk, /tx\(46\), ty\(50\)/); assert.match(sk, /part\('thruster', 35, 20, tx\(10\), ty\(31\)/); });
fs.rmSync(tmp, { recursive: true, force: true });

// ---- headless: drones draw + animate ----
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(GAME, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(GAME) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res)); const url = `http://127.0.0.1:${server.address().port}/?coach=0`;
const shots = process.argv[2];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); const page = await browser.newPage({ viewport: { width: 740, height: 510 } }); const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
const ev = (f, a) => page.evaluate(f, a), w = ms => page.waitForTimeout(ms);
await page.goto(url); await w(1200);
for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
await page.keyboard.press('Enter'); await w(300);
for (let i = 0; i < 14 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
await w(400);
await t('claw drone (kind drone) draws and animates', async () => {
  // A claw drone next to the hero on the current level, drawn by skate.js drawDrone.
  await ev(() => { const s = window.__ppState; s.invuln = 99; for (const n of s.ninjas) n.x += 900; s.ninjas.push({ kind: 'drone', x: s.player.x + 160, y: s.player.y - 10, r: 22, hp: 1, maxHp: 1, hover: 70, flying: true, face: -1, vx: 0, vy: 0, z: 0, stun: 99, scripted: true }); });
  await w(150); const box = await ev(() => { const s = window.__ppState, n = s.ninjas[s.ninjas.length - 1]; return { x: Math.round(n.x - s.cameraX), y: Math.round(n.y - (n.hover || 0)) }; });
  const clip = { x: Math.max(0, box.x - 70), y: Math.max(0, box.y - 110), width: 140, height: 130 };
  const a = await page.screenshot({ clip }); await w(37); const b = await page.screenshot({ clip }); await w(53); const c = await page.screenshot({ clip });
  if (shots) fs.writeFileSync(shots + '/claw-drone.png', b);
  const n = await ev(() => window.__ppState.ninjas.filter(m => m.kind === 'drone').length);
  assert.ok(n >= 1, 'drone alive'); assert.ok(!a.equals(b) || !b.equals(c), 'frames differ (rotor spin / bob / thruster flicker)'); return `(clip ${JSON.stringify(clip)})`; });
await t('hover-drone pack still spawns and animates', async () => {
  const r = await ev(() => { const s = window.__ppState, d = window.__ppDrones; if (!d || !d.spawnPack) return null; d.spawnPack(s, 3); return s.ninjas.filter(n => n.kind === 'hoverdrone').length; });
  assert.ok(r >= 3, 'pack of ' + r); await w(600);
  const live = await ev(() => window.__ppDrones.info(window.__ppState).live.length); assert.ok(live >= 3); return `(${live} live)`; });
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
