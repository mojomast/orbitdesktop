// mr_india (render-bug regression, t_04ffd001df3944ed): Kyle saw the sewer turn
// into smeared trails mid-level: placeholder circles for heroes/enemies, smeared
// drones and dialogue, a flat green floor. Cause: the art had failed to load
// (files were being swapped by a republish), loaders never retried, and draw()
// never cleared the canvas, relying on the background art to cover it.
// This check plays ~3 minutes (sewer through its scripted beats, team-up assist and
// the drone flyover, then the street) and asserts:
//   - 0 page errors, 0 console errors, 0 errors caught in the frame (window.__ppRenderErrors)
//   - every frame fully repaints the canvas (paint it magenta between frames: none may survive)
//   - the background changes as the camera scrolls, and the hero is the rig, never the fallback circle
// then a short second session where every image fails for the first seconds (a
// republish gap): frames must still clear, and the art must heal by itself.
// usage: node check-longplay.mjs [url|-] [screenshot dir] [seconds=180]
// Use the default local server ('-'): Orbit serves /apps/ from a sandboxed (opaque)
// origin, which taints the canvas, so the pixel checks cannot read the live app.
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname;
let url = process.argv[2], server;
if (!url || url === '-') {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); url = `http://127.0.0.1:${server.address().port}/`;
}
const SH = process.argv[3] || '/workspace/pizza-story/render-bug/longplay';
const SECS = +(process.argv[4] || 180);
fs.mkdirSync(SH, { recursive: true });
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });

async function open({ outageSecs = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
  const errs = { page: [], console: [], net: [] };
  const outageEnd = Date.now() + outageSecs * 1000 + 4000; // + boot time
  const inOutage = () => outageSecs > 0 && Date.now() < outageEnd + 1000;
  page.on('pageerror', e => errs.page.push(String(e && e.stack || e).slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error' && !(inOutage() && /Failed to load resource/.test(m.text()))) errs.console.push(m.text().slice(0, 300)); });
  page.on('requestfailed', r => { if (!inOutage()) errs.net.push('requestfailed ' + r.url()); });
  page.on('response', r => { if (r.status() >= 400) errs.net.push(`HTTP ${r.status()} ${r.url()}`); });
  if (outageSecs) await page.route(/\.(png|jpg)(\?|$)/, r => (Date.now() < outageEnd ? r.abort() : r.continue()));
  await page.goto(url); await page.waitForTimeout(1500);
  for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
  await page.keyboard.press('Enter'); await page.waitForTimeout(400); // hero 0: PURPLE TURTLE, as in Kyle's session
  for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
  return { page, errs };
}

// Paint the canvas magenta right after a frame, let the game draw two more frames,
// then count the magenta pixels that survived (0 when every frame repaints the canvas).
const smearProbe = page => page.evaluate(async () => {
  const c = document.getElementById('c'), x = c.getContext('2d');
  const raf = () => new Promise(r => requestAnimationFrame(r));
  await raf();
  x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none'; x.fillStyle = '#ff00ff'; x.fillRect(0, 0, c.width, c.height); x.restore();
  await raf(); await raf();
  const d = x.getImageData(0, 0, c.width, c.height).data; let m = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 255) m++;
  return m;
});
// One look at the frame: camera, the background band (y 150..300, below the HUD),
// and how many pixels around the hero have the fallback-circle colours.
const sample = page => page.evaluate(() => {
  const c = document.getElementById('c'), x = c.getContext('2d'), s = window.__ppState, cam = window.__ppCamX || 0;
  const band = x.getImageData(0, 150, c.width, 150).data, small = [];
  for (let i = 0; i < band.length; i += 4 * 37) small.push(band[i], band[i + 1], band[i + 2]);
  const px = Math.round(s.player.x - cam), py = Math.round(s.player.y - (s.player.z || 0));
  const bx = Math.max(0, px - 60), by = Math.max(0, py - 120), bw = Math.min(c.width - bx, 120), bh = Math.min(c.height - by, 160);
  let fallback = 0;
  if (bw > 0 && bh > 0) { const d = x.getImageData(bx, by, bw, bh).data; for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2]; if ((r === 0x6b && g === 0x4a && b === 0x1e) || (r === 0x3f && g === 0xae && b === 0x3f)) fallback++; } }
  const kind = window.__ppRig.heroKind(s);
  return { cam, level: s.level, wave: s.wave, score: s.score, x: Math.round(s.player.x), band: small, fallback, rigDrawn: window.__ppRig.stats[kind] || 0, kind,
    renderErrors: window.__ppRenderErrors ? window.__ppRenderErrors.count : -1, renderBy: window.__ppRenderErrors ? window.__ppRenderErrors.by : null,
    broken: window.__ppAssetRetry ? [...window.__ppAssetRetry.broken] : null, line: window.__ppEvents()?.line || null, fired: window.__ppEvents()?.fired || 0 };
});
const bandDiff = (a, b) => { let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length; };
const blocked = page => page.evaluate(() => window.__ppCinema.isActive() || window.__ppScreens.active() || (window.__ppBonus && window.__ppBonus.active()) || (window.__ppShop && window.__ppShop.active && window.__ppShop.active()) || (window.__ppPause && window.__ppPause.isOpen()));
async function bot(page, ms) {
  await page.keyboard.down('ArrowRight'); await page.waitForTimeout(ms); await page.keyboard.up('ArrowRight');
  for (const k of ['KeyJ', 'KeyJ', 'KeyK', 'KeyL']) { await page.keyboard.press(k); await page.waitForTimeout(100); }
  if (Math.random() < 0.25) { await page.keyboard.down('KeyJ'); await page.keyboard.down('KeyL'); await page.waitForTimeout(60); await page.keyboard.up('KeyJ'); await page.keyboard.up('KeyL'); } // J+L special
}

// ---- session 1: ~3 minutes, sewer then street ----
{
  const { page, errs } = await open();
  ok(await page.evaluate(() => !!window.__ppState && window.__ppState.level === 0 && !window.__ppCinema.isActive()), 'in the sewer, gameplay running');
  const t0 = Date.now(), samples = [], probes = []; let lastX = 0, lastMove = Date.now(), superFired = false, forced = false, shots = 0, levelsSeen = new Set();
  const el = () => (Date.now() - t0) / 1000;
  while (el() < SECS) {
    await page.evaluate(() => { const s = window.__ppState; if (s.hp < 45) s.hp = s.maxHp || 100; });
    if (await blocked(page)) { await page.keyboard.press('Enter'); await page.waitForTimeout(250); if (await blocked(page)) await page.keyboard.press('Escape'); await page.waitForTimeout(250); continue; }
    // If the page goes away mid-run (a republish restarts the served app, or the
    // renderer dies), say so with context instead of dying on an opaque
    // "Target page, context or browser has been closed".
    try { await bot(page, 260); } catch (e) {
      const where = await page.evaluate(() => ({ level: window.__ppState && window.__ppState.level, wave: window.__ppState && window.__ppState.wave })).catch(() => null);
      console.log(`   bot stopped after ${el().toFixed(0)}s at ${where ? `level ${where.level} wave ${where.wave}` : 'an unknown point'}: ${e.message}`);
      console.log(`   page errors captured before it closed: ${errs.page.length}${errs.page.length ? ' — ' + errs.page.slice(0, 2).join(' | ') : ''}`);
      throw e;
    }
    const st = await page.evaluate(() => ({ x: window.__ppState.player.x, level: window.__ppState.level, super: window.__ppState.super }));
    levelsSeen.add(st.level);
    // team-up super once the sewer is under way: fill the meter and fire it (KeyU)
    if (!superFired && el() > 35) { await page.evaluate(() => { window.__ppState.super = 100; }); await page.keyboard.press('KeyU'); superFired = true; }
    if (Math.abs(st.x - lastX) > 30) { lastX = st.x; lastMove = Date.now(); }
    else if (Date.now() - lastMove > 9000) { // the bot cannot reach some flyers: clear the arena so the run moves on
      await page.evaluate(() => window.__ppState.ninjas.forEach(n => { if (!n.dead) { n.hp = 0; n.dead = true; } })); lastMove = Date.now();
    }
    // past the halfway mark, finish the sewer so the street gets its share of the run
    if (!forced && st.level === 0 && el() > SECS * 0.55) {
      forced = true;
      await page.evaluate(() => { const s = window.__ppState, e = s.events; if (!(s.holdWave && s.walkLevel) || s.level !== 0 || window.__ppScreens.active()) return; s.ninjas.forEach(n => { n.hp = 0; n.dead = true; }); if (e) { e.lock = null; e.camX = null; } s.holdWave = false; s.walkLevel = false; s.levelsDone = (s.levelsDone || 0) + 1; });
    }
    if (samples.length < el() / 6) {
      const sm = await sample(page); samples.push({ t: Math.round(el()), ...sm });
      if (sm.level === 0 || sm.level === 1) probes.push({ t: Math.round(el()), level: sm.level, magenta: await smearProbe(page) });
      console.log(`  ${Math.round(el())}s level ${sm.level} x ${sm.x} cam ${Math.round(sm.cam)} score ${sm.score} beats ${sm.fired} rig ${sm.rigDrawn} fallbackPx ${sm.fallback}${sm.line ? ' "' + sm.line + '"' : ''}`);
      if (shots < 12 && samples.length % 3 === 1) await page.screenshot({ path: `${SH}/play-${String(shots++).padStart(2, '0')}-lv${sm.level}.png` });
    }
  }
  const fin = await sample(page);
  await page.screenshot({ path: `${SH}/play-final.png` });
  const evlog = await page.evaluate(() => window.__ppEvents()?.log || []);
  const assists = await page.evaluate(() => (window.__ppAssist && window.__ppAssist.stats ? { ...window.__ppAssist.stats } : null));
  ok(levelsSeen.has(0) && levelsSeen.has(1), `played the sewer and the street (levels seen: ${[...levelsSeen].join(',')})`);
  ok(evlog.filter(e => e.level === 0 && e.type !== 'bark' && e.type !== 'arenaLock' && e.type !== 'go' && e.type !== 'arenaClear').length >= 4, `sewer scripted beats fired (${evlog.filter(e => e.level === 0).length} log entries)`);
  ok(evlog.some(e => e.level === 0 && (e.kinds || []).includes('drone')), 'sewer drone beat fired');
  ok(superFired && (!assists || assists.fired >= 1), 'team-up super fired' + (assists ? ' ' + JSON.stringify(assists) : ''));
  ok(errs.page.length === 0, `0 page errors (${errs.page.length})${errs.page.length ? '\n    ' + errs.page.slice(0, 5).join('\n    ') : ''}`);
  ok(errs.console.length === 0 && errs.net.length === 0, `0 console/network errors (${errs.console.length + errs.net.length})${errs.console.length + errs.net.length ? '\n    ' + [...errs.console, ...errs.net].slice(0, 5).join('\n    ') : ''}`);
  ok(fin.renderErrors === 0, `0 errors caught inside the frame (window.__ppRenderErrors=${fin.renderErrors}${fin.renderBy && fin.renderErrors ? ' ' + JSON.stringify(fin.renderBy) : ''})`);
  ok(probes.length >= 10 && probes.every(p => p.magenta === 0), `every frame repaints the whole canvas: ${probes.length} probes, surviving magenta px max ${Math.max(0, ...probes.map(p => p.magenta))}`);
  const play = samples.filter(s => s.level === 0 || s.level === 1);
  ok(play.length >= 10 && play.every(s => s.fallback < 40), `hero never drawn as the fallback circle (max fallback px ${Math.max(0, ...play.map(s => s.fallback))})`);
  ok(fin.rigDrawn > 1000, `hero drawn by its rig (${fin.kind} rig draws ${fin.rigDrawn})`);
  const pairs = [];
  for (let i = 0; i < play.length; i++) for (let j = i + 1; j < play.length; j++) if (play[i].level === play[j].level && Math.abs(play[i].cam - play[j].cam) > 200) { pairs.push(bandDiff(play[i].band, play[j].band)); break; }
  ok(pairs.length >= 3 && pairs.every(d => d > 6), `background changes as the camera scrolls (${pairs.length} pairs, min mean diff ${pairs.length ? Math.min(...pairs).toFixed(1) : '-'})`);
  ok(fin.broken && fin.broken.length === 0, 'no image left broken');
  await page.close();
}

// ---- session 2: every image fails for the first seconds (a republish gap) ----
{
  const { page, errs } = await open({ outageSecs: 6 });
  let probeDuring = null;
  for (let i = 0; i < 6; i++) { if (await blocked(page)) { await page.keyboard.press('Escape'); continue; } await bot(page, 300); }
  const early = await sample(page);
  probeDuring = await smearProbe(page);
  await page.screenshot({ path: `${SH}/outage-during.png` });
  ok(early.broken && early.broken.length > 50, `outage simulated: ${early.broken ? early.broken.length : '?'} images failed`);
  ok(probeDuring === 0, `frames still repaint the whole canvas while the art is missing (surviving magenta px ${probeDuring})`);
  for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.__ppAssetRetry && window.__ppAssetRetry.broken.size === 0)) break; await bot(page, 250); }
  for (let i = 0; i < 4; i++) await bot(page, 250);
  const late = await sample(page);
  await page.screenshot({ path: `${SH}/outage-healed.png` });
  ok(late.broken && late.broken.length === 0, `all art healed by itself after the outage (${late.broken ? late.broken.length : '?'} still broken)`);
  ok(late.fallback < 40 && late.rigDrawn > 0, `hero back on its rig after healing (fallback px ${late.fallback}, rig draws ${late.rigDrawn})`);
  ok(errs.page.length === 0 && late.renderErrors === 0, `0 page errors / frame errors during the outage (${errs.page.length}/${late.renderErrors})`);
  await page.close();
}
await browser.close(); if (server) server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
