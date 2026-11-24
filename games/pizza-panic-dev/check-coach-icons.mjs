// MR.INDIA coach-mark icons (t_cd6d3db7a9774e77): assets/ui/coach/{move,attack,special,grab}.png are 128x128 with
// transparent corners (checked offline with PIL), each card draws its icon (?coach=1), 0 console errors.
// usage: node check-coach-icons.mjs [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http';
const GAME = new URL('../pizza-panic/', import.meta.url).pathname;
let fails = 0; const t = async (n, f) => { try { const d = await f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
import { execFileSync } from 'node:child_process';
const IDS = ['move', 'attack', 'special', 'grab'];
await t('icons are 128x128 RGBA with transparent corners', () => {
  const py = `import sys\nfrom PIL import Image\nfor f in sys.argv[1:]:\n  im=Image.open(f).convert('RGBA'); w,h=im.size; a=[im.getpixel(p)[3] for p in [(0,0),(w-1,0),(0,h-1),(w-1,h-1)]]; print(w,h,max(a))`;
  const out = execFileSync('python3', ['-c', py, ...IDS.map(i => path.join(GAME, 'assets/ui/coach', i + '.png'))]).toString().trim().split('\n');
  out.forEach((l, i) => { const [w, h, a] = l.split(' ').map(Number); assert.equal(w, 128, IDS[i]); assert.equal(h, 128, IDS[i]); assert.equal(a, 0, IDS[i] + ' corner alpha'); });
  return out.join(' | '); });
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(GAME, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!f.startsWith(GAME) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const shots = process.argv[2];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); const page = await browser.newPage({ viewport: { width: 740, height: 510 } }); const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const ev = (f, a) => page.evaluate(f, a), w = ms => page.waitForTimeout(ms);
await page.goto(`http://127.0.0.1:${server.address().port}/?coach=1`); await w(1200);
for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
await page.keyboard.press('Enter'); await w(300);
for (let i = 0; i < 14 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
for (const id of IDS) await t(`${id.toUpperCase()} card draws its icon`, async () => {
  for (let i = 0; i < 40 && !(await ev(id => window.__ppCoach.card === id && (window.__ppCoach.iconDraws[id] || 0) > 3, id)); i++) await w(100);
  const d = await ev(() => ({ card: window.__ppCoach.card, draws: window.__ppCoach.iconDraws }));
  assert.equal(d.card, id); assert.ok(d.draws[id] > 0, JSON.stringify(d));
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await w(250); await page.screenshot({ path: `${shots}/coach-${id}.png` }); }
  await page.keyboard.press('Enter'); await w(250); return JSON.stringify(d.draws); });
await t('cards finished, 0 console errors', async () => { assert.ok(await ev(() => !window.__ppCoach.active)); assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
