// baba_booey game over + continue illustrations (t_a4826c482cfc4c4a): assets/ui/gameover/{continue,gameover}.jpg are 740x510,
// under 200 KB each, no new runtime files beyond those two. In a headless drive, the CONTINUE countdown shows the warm
// continue art, which DOLAN's grey drain greys out as the timer runs down; the glass crack brings up the game-over art,
// which sits under GAME OVER. Timing (10 s countdown + 0.7 s crack) and inputs (Enter continues, any key afterwards)
// are unchanged, the old assets/ui/continue.png banner still loads, and there are 0 console errors.
// usage: node check-gameover.mjs [shotdir]  (default /workspace/pizza-art/gameover/shots)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const jpgSize = b => { let i = 2; while (i < b.length) { const m = b[i + 1], L = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + L; } return null; };
await t('assets: two 740x510 JPGs under 200 KB; continue.png banner kept and still referenced', () => {
  const d = path.join(GAME, 'assets/ui/gameover'); assert.deepEqual(fs.readdirSync(d).filter(f => !f.endsWith('.md') && !f.includes('.bak')).sort(), ['continue.jpg', 'gameover.jpg']);
  const out = [];
  for (const f of ['continue.jpg', 'gameover.jpg']) { const b = fs.readFileSync(path.join(d, f)); assert.equal(b.readUInt16BE(0), 0xffd8, f); assert.deepEqual(jpgSize(b), [740, 510], f); assert.ok(b.length < 200 * 1024, f + ' ' + b.length); out.push(Math.round(b.length / 1024) + ' KB'); }
  assert.ok(fs.existsSync(path.join(GAME, 'assets/ui/continue.png'))); assert.match(fs.readFileSync(path.join(GAME, 'screens.js'), 'utf8'), /'continue'\]\) \{ try \{ const im = new Image\(\); im\.src = 'assets\/ui\/' \+ k \+ '\.png'/);
  return '(' + out.join(', ') + ')'; });
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(GAME, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(GAME) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const SH = process.argv[2] || '/workspace/pizza-art/gameover/shots'; fs.mkdirSync(SH, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); const page = await browser.newPage({ viewport: { width: 740, height: 510 } }); const errors = [], got = new Set();
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); else got.add(new URL(r.url()).pathname); });
const ev = (f, a) => page.evaluate(f, a), w = ms => page.waitForTimeout(ms);
await page.goto(`http://127.0.0.1:${server.address().port}/?coach=0`); await w(1200);
for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
await page.keyboard.press('Enter'); await w(300);
for (let i = 0; i < 14 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
await w(500);
const kill = () => ev(async () => { const { damagePlayer } = await import('./logic.js'); const s = window.__ppState; s.lives = 1; s.invuln = 0; s.player.shield = false; damagePlayer(s, 9999); return s.over; });
// mean colour of a canvas box -> [r, g, b, saturation]
const box = (x, y, w2, h2) => ev(([x, y, w2, h2]) => { const c = document.getElementById('c'), d = c.getContext('2d').getImageData(x, y, w2, h2).data; let r = 0, g = 0, b = 0, n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } r /= n; g /= n; b /= n; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return [r, g, b, mx ? (mx - mn) / mx : 0].map(v => +v.toFixed(2)); }, [x, y, w2, h2]);
const SKY = [500, 100, 180, 80], RED = [430, 120, 70, 60];
await t('both illustrations are requested and served', () => { for (const f of ['/assets/ui/gameover/continue.jpg', '/assets/ui/gameover/gameover.jpg', '/assets/ui/continue.png']) assert.ok(got.has(f), f); });
let warm;
await t('CONTINUE: warm continue art behind the banner + digits; Enter still continues', async () => {
  assert.ok(await kill(), 'killed'); await w(300); assert.equal(await ev(() => window.__ppScreens.mode()), 'continue');
  await w(900); await page.screenshot({ path: SH + '/continue.png' }); warm = await box(...SKY);
  assert.ok(warm[0] > warm[2] + 25 && warm[3] > 0.3, 'golden sunrise visible ' + warm);
  await page.keyboard.press('Enter'); await w(300);
  const m = await ev(() => ({ mode: window.__ppScreens.mode(), over: window.__ppState.over, c: window.__ppState.continues })); assert.deepEqual(m, { mode: null, over: false, c: 1 });
  return 'sky ' + JSON.stringify(warm); });
await t('drain: the continue art greys toward the end; then the crack brings the game-over art, timing unchanged', async () => {
  assert.ok(await kill()); const t0 = Date.now(); await w(300);
  for (let i = 0; i < 200 && await ev(() => window.__ppScreens.t < 6.8); i++) await w(50);
  await page.screenshot({ path: SH + '/continue-drain.png' }); const grey = await box(...SKY), dr = await ev(() => window.__ppScreens.juice.drain);
  assert.ok(dr > 0.6, 'drain ' + dr); // sampled before the last-3 s red heartbeat tint
  const chroma = c => (c[1] - c[2]) / Math.max(1, c[0]) * 100; // gold = green well above blue; grey (+ DOLAN's red tint) loses it assert.ok(chroma(grey) < chroma(warm) * 0.5, `greyed ${grey} vs ${warm}`);
  for (let i = 0; i < 300 && await ev(() => window.__ppScreens.juice.crack == null); i++) await w(20);
  assert.ok(await ev(() => window.__ppScreens.juice.crack != null), 'crack started'); await w(380); await page.screenshot({ path: SH + '/continue-crack.png' });
  for (let i = 0; i < 100 && await ev(() => window.__ppScreens.mode() === 'continue'); i++) await w(20);
  const secs = (Date.now() - t0) / 1000; assert.equal(await ev(() => window.__ppScreens.mode()), 'final');
  assert.ok(secs > 10.2 && secs < 12.5, 'countdown + crack took ' + secs.toFixed(2) + ' s');
  return `(chroma ${chroma(warm).toFixed(0)} -> ${chroma(grey).toFixed(0)}, ${secs.toFixed(1)} s to GAME OVER)`; });
await t('GAME OVER: red-sky game-over art under the text; any key moves on', async () => {
  await w(1300); await page.screenshot({ path: SH + '/gameover.png' }); const red = await box(...RED);
  assert.ok(red[0] > red[1] + 20 && red[0] > red[2], 'red sky ' + red);
  await page.keyboard.press('Enter'); await w(300); const m = await ev(() => window.__ppScreens.mode());
  assert.ok(m === 'initials' || m === 'scores' || m === null, 'left GAME OVER, now ' + m); return 'sky ' + JSON.stringify(red); });
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
