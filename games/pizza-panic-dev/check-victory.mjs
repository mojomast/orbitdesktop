// Headless check for the hero victory portraits + stage clear splash (baba_booey,
// t_bbe9e23bf6af47c5): every hero has a keyed victory cut-out in assets/ui/victory/
// (transparent, trimmed, no magenta spill, <=150 KB), the splash JPG exists, the
// stage clear card draws the splash + the chosen hero (both heroes in co-op), the
// ending victory card uses the cut-out, the card still closes as before, 0 console errors.
// usage: node check-victory.mjs [shots dir]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname;
const SH = process.argv[2] || '/workspace/pizza-victory/shots'; fs.mkdirSync(SH, { recursive: true });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const { HEROES } = await import(path.join(ROOT, 'heroes.js'));
const IDS = HEROES.map(h => h.id);
// --- static -----------------------------------------------------------------
ok(IDS.length === 8, `8 heroes, + don_piedro (${IDS.join(', ')})`);
for (const id of IDS) {
  const f = path.join(ROOT, 'assets/ui/victory', id + '.png');
  const has = fs.existsSync(f), b = has ? fs.readFileSync(f) : null;
  const png = b && b.readUInt32BE(0) === 0x89504e47, w = png && b.readUInt32BE(16), h = png && b.readUInt32BE(20), ct = png && b[25];
  const alpha = png && (ct === 6 || ct === 4 || (ct === 3 && b.includes(Buffer.from('tRNS'))));
  ok(has && png && alpha && b.length <= 150 * 1024 && h >= 300 && h <= 600, `${id}: victory portrait PNG with alpha ${w}x${h}, ${b ? Math.round(b.length / 1024) : 0} KB`);
}
{ const f = path.join(ROOT, 'assets/ui/stage_clear_splash.jpg'), b = fs.existsSync(f) && fs.readFileSync(f);
  ok(b && b[0] === 0xff && b[1] === 0xd8 && b.length <= 250 * 1024, `stage clear splash JPG (${b ? Math.round(b.length / 1024) : 0} KB)`); }
{ const src = fs.readFileSync(path.join(ROOT, 'screens.js'), 'utf8');
  ok(/assets\/ui\/victory\//.test(src) && /stage_clear_splash\.jpg/.test(src) && /drawWinner\(/.test(src), 'screens.js loads the cut-outs + splash and draws them'); }
// --- browser ----------------------------------------------------------------
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const url = `http://127.0.0.1:${server.address().port}/`;
const errors = [], loaded = new Set();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
let phase = 'boot';
page.on('console', m => { if (m.type() === 'error') errors.push(`[${phase}] ` + m.text().split('\n')[0]); });
page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); else if (/assets\/ui\/(victory\/|stage_clear_splash)/.test(r.url())) loaded.add(r.url().split('/assets/ui/')[1]); });
try {
  await page.goto(url); await page.waitForTimeout(1500);
  // cut-out pixel quality, measured in the page
  const q = await page.evaluate(async ids => {
    const out = {};
    for (const id of ids) {
      const im = new Image(); im.src = 'assets/ui/victory/' + id + '.png'; await im.decode();
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let opaque = 0, spill = 0, n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 200) { opaque++; if (d[i] > 225 && d[i + 1] < 45 && d[i + 2] > 150) spill++; } }
      const corner = [0, c.width - 1, (c.height - 1) * c.width, c.height * c.width - 1].map(p => d[p * 4 + 3]);
      // trimmed: every border has some coverage
      const rowHas = y => { for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 20) return true; return false; };
      const colHas = x => { for (let y = 0; y < c.height; y++) if (d[(y * c.width + x) * 4 + 3] > 20) return true; return false; };
      out[id] = { opaque: opaque / n, spill: spill / Math.max(1, opaque), corner: Math.max(...corner), trimmed: rowHas(0) && rowHas(c.height - 1) && colHas(0) && colHas(c.width - 1) };
    }
    return out;
  }, IDS);
  for (const id of IDS) { const r = q[id]; ok(r.corner < 40 && r.opaque > 0.2 && r.spill < 0.004 && r.trimmed, `${id}: keyed (corners ${r.corner}, opaque ${(r.opaque * 100).toFixed(0)}%, magenta spill ${(r.spill * 100).toFixed(2)}%, trimmed ${r.trimmed})`); }
  for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
  await page.keyboard.press('Enter'); await page.waitForTimeout(400);
  for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  ok(await page.evaluate(() => !window.__ppCinema.isActive() && typeof window.__ppScreens?.stageClear === 'function'), 'in gameplay, screens.js loaded');
  const region = (x0, y0, x1, y1) => page.evaluate(([x0, y0, x1, y1]) => { const c = document.getElementById('c') || document.querySelector('canvas'); const d = c.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data; const a = []; for (let i = 0; i < d.length; i += 16) a.push(d[i], d[i + 1], d[i + 2]); return a; }, [x0, y0, x1, y1]);
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const showClear = async (id, p2) => {
    for (let i = 0; i < 10 && await page.evaluate(() => { const sh = window.__ppShop, b = window.__ppBonus; let up = false; if (sh && sh.active()) { sh.leave(); up = true; } if (b && b.active()) { try { b.close(); } catch (_) {} up = true; } return up; }); i++) await page.waitForTimeout(150);
    phase = 'clear ' + id + (p2 ? '+' + p2 : '');
    await page.evaluate(([id, p2]) => { const s = window.__ppState; s.selectedHero = id; s.ninjas = []; const c = window.__ppCoop; if (p2) c.join(s, p2); else if (c.p2) c.leave(); window.__ppScreens.stageClear(s, s.level); }, [id, p2 || null]);
    await page.waitForTimeout(1700);
  };
  const close = async () => { for (let i = 0; i < 8 && await page.evaluate(() => window.__ppScreens.mode() === 'clear'); i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(150); }
    await page.evaluate(() => { const sh = window.__ppShop; if (sh && sh.active()) sh.leave(); const b = window.__ppBonus; if (b && b.active()) { try { b.close(); } catch (_) {} } }); await page.waitForTimeout(150); };
  const heroBox = [8, 190, 206, 500], seen = {};
  for (const id of IDS) {
    await showClear(id);
    const d = await page.evaluate(() => ({ mode: window.__ppScreens.mode(), heroes: window.__ppScreens.data && window.__ppScreens.data.heroes, rank: window.__ppScreens.juice.stamped }));
    await page.screenshot({ path: `${SH}/clear-${id}.png` });
    seen[id] = await region(...heroBox);
    // the same frame with the cut-out removed: the hero box must change a lot
    await page.evaluate(() => { window.__ppScreens.data.heroes = []; }); await page.waitForTimeout(80);
    const bare = await region(...heroBox); await page.evaluate(id => { window.__ppScreens.data.heroes = [id]; }, id);
    if (!(d.mode === 'clear' && diff(seen[id], bare) > 12)) console.log('   diag', JSON.stringify({ d, ov: await page.evaluate(() => ({ shop: window.__ppShop?.active?.(), bonus: window.__ppBonus?.active?.(), pause: window.__ppPause?.isOpen?.(), level: window.__ppState.level })) }));
    ok(d.mode === 'clear' && d.heroes && d.heroes[0] === id && d.rank && diff(seen[id], bare) > 12, `stage clear for ${id}: splash + victory portrait slide in (hero box changes ${diff(seen[id], bare).toFixed(1)}), rank stamped`);
    await close();
  }
  { const ds = []; for (let i = 0; i < IDS.length; i++) for (let j = i + 1; j < IDS.length; j++) ds.push(diff(seen[IDS[i]], seen[IDS[j]])); ok(Math.min(...ds) > 6, `each hero's portrait differs on the card (min pair diff ${Math.min(...ds).toFixed(1)})`); }
  // splash actually drawn: the top corners are the splash's burst, not the old flat backdrop
  // co-op: both heroes on the card
  await showClear('turtle_red', 'nous_girl');
  const co = await page.evaluate(() => ({ heroes: window.__ppScreens.data.heroes, p2: window.__ppCoop.p2 && window.__ppCoop.p2.selectedHero }));
  await page.screenshot({ path: `${SH}/clear-coop-red-nous.png` });
  const right = await region(560, 230, 732, 500); await page.evaluate(() => { window.__ppScreens.data.heroes = ['turtle_red']; }); await page.waitForTimeout(80);
  const right1 = await region(560, 230, 732, 500);
  ok(co.heroes && co.heroes.join() === 'turtle_red,nous_girl' && diff(right, right1) > 8, `co-op stage clear shows both heroes (${co.heroes}, P2 box diff ${diff(right, right1).toFixed(1)})`);
  await close(); await page.evaluate(() => { const c = window.__ppCoop; if (c.p2) c.leave(); });
  // card still behaves: closes on a key after the count-up, auto-closes after 7s
  await showClear('turtle_blue'); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  ok(await page.evaluate(() => window.__ppScreens.mode()) !== 'clear', 'stage clear still closes on a key press after the count-up');
  await close();
  // ending victory card
  const ENDINGS = [['solo-purple', 'turtle_purple'], ['coop-orange-turbofit', 'turtle_orange', 'turbofit'], ['solo-teknium', 'teknium']];
  for (const [tag, id, p2] of ENDINGS) {
    phase = 'ending ' + tag;
    await page.evaluate(([id, p2]) => { const s = window.__ppState; s.selectedHero = id; const c = window.__ppCoop; if (p2) c.join(s, p2); else if (c.p2) c.leave(); window.__ppScreens.ending(s); }, [id, p2 || null]);
    await page.waitForTimeout(2000);
    const e = await page.evaluate(() => ({ mode: window.__ppScreens.mode(), heroes: window.__ppScreens.data.heroes }));
    await page.screenshot({ path: `${SH}/ending-${tag}.png` });
    const box = await region(40, 150, 300, 490); await page.evaluate(() => { window.__ppScreens.data.heroes = []; }); await page.waitForTimeout(80);
    const bare = await region(40, 150, 300, 490);
    ok(e.mode === 'credits' && e.heroes[0] === id && (!p2 || e.heroes[1] === p2) && diff(box, bare) > 10, `ending victory card shows the victory pose for ${e.heroes.join(' + ')} (diff ${diff(box, bare).toFixed(1)})`);
    await page.evaluate(() => { const c = window.__ppCoop; if (c.p2) c.leave(); });
  }
  phase = 'credits skip';
  // the last card: skip into the roll and out, so the initials/high-score flow still follows
  await page.keyboard.press('Escape'); await page.waitForTimeout(300); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__ppScreens.mode());
  ok(after === 'initials' || after === 'scores', `credits still hand over to the high-score flow (${after})`);
  ok(IDS.every(id => loaded.has('victory/' + id + '.png')) && loaded.has('stage_clear_splash.jpg'), `all victory art served (${loaded.size} files)`);
  ok(errors.length === 0, `0 console errors (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
} catch (e) { ok(false, 'browser: ' + (e && e.stack || e)); }
await browser.close(); server.close();
console.log(fails ? `${fails} victory checks FAILED` : 'all victory checks passed');
process.exit(fails ? 1 : 0);
