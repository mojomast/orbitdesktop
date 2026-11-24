// MR.INDIA live STYLE meter (board t_ada855f0f2f140dd): style.js draws a grade pip + thin
// progress bar on the HUD during play.
//  - drawn during play, not on the title / select / pause / stage clear screens
//  - live grade (style.js styleLive, same formula) matches the clear card's STYLE grade
//  - its rect does not intersect any other HUD draw (hero card, life pips, score/sound
//    panels, combo counter, co-op 2P card, TEAM UP, boss bar), 1P and co-op
//  - dims after a few idle seconds, lights up again on activity
//  - colour-safe palette + tick cue; rank-up pulse off with reduced motion
//  - 0 console errors
// usage: node check-style-meter.mjs [shotdir]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
globalThis.window = globalThis.window || {};
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname;
const St = await import(ROOT + 'style.js'); const { W, H } = await import(ROOT + 'logic.js');
const shots = process.argv[2]; if (shots) fs.mkdirSync(shots, { recursive: true });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
// Node: formula
{ const L = St.styleLive({ maxCombo: 25, juggles: 1, specials: 0, dmg: 0 }); ok(L.grade === 'B' && L.points === 29 && L.next === 'A' && Math.abs(L.progress - 0.45) < 1e-9, 'styleLive B 29 -> A at 45%: ' + JSON.stringify(L)); }
for (const g of [{ maxCombo: 70, juggles: 9, specials: 9 }, { maxCombo: 41 }, { maxCombo: 3, dmg: 40 }, {}]) { const L = St.styleLive(g); ok(L.grade === St.styleGrade(g) && L.points === St.stylePoints(g) && L.progress >= 0 && L.progress <= 1, `styleLive agrees with styleGrade (${L.grade} ${L.points})`); }
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.md': 'text/plain' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res)); const URL0 = `http://127.0.0.1:${server.address().port}/`;
// Draw-op recorder: screen-space bbox of every rect / text / image per frame.
const INIT = () => {
  const P = CanvasRenderingContext2D.prototype, ops = []; let cur = [];
  window.__ops = () => ops.slice();
  const ro = requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => ro(t => { if (cur.length > 40) { ops.length = 0; ops.push(...cur); cur = []; } cb(t); });
  const box = (ctx, x, y, w, h) => { const m = ctx.getTransform(); const xs = [], ys = []; for (const [a, b] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) { xs.push(m.a * a + m.c * b + m.e); ys.push(m.b * a + m.d * b + m.f); } return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; };
  const rec = (ctx, kind, b, text) => cur.push({ kind, ...b, text, alpha: ctx.globalAlpha, fill: String(ctx.fillStyle), sx: ctx.getTransform().a });
  for (const k of ['fillRect', 'strokeRect']) { const o = P[k]; P[k] = function (x, y, w, h) { rec(this, k, box(this, x, y, w, h)); return o.apply(this, arguments); }; }
  if (P.roundRect) { const o = P.roundRect; P.roundRect = function (x, y, w, h) { rec(this, 'roundRect', box(this, x, y, w, h)); return o.apply(this, arguments); }; }
  { const o = P.rect; P.rect = function (x, y, w, h) { rec(this, 'rect', box(this, x, y, w, h)); return o.apply(this, arguments); }; }
  for (const k of ['fillText', 'strokeText']) { const o = P[k]; P[k] = function (t, x, y) {
    const w = this.measureText(String(t)).width, sz = +((this.font.match(/(\d+)px/) || [])[1] || 10);
    const ax = this.textAlign === 'center' ? x - w / 2 : (this.textAlign === 'right' || this.textAlign === 'end') ? x - w : x;
    const ay = this.textBaseline === 'middle' ? y - sz / 2 : this.textBaseline === 'top' ? y : y - sz * 0.8;
    rec(this, k, box(this, ax, ay, w, sz), String(t)); return o.apply(this, arguments); }; }
  { const o = P.drawImage; P.drawImage = function (img, ...a) { const [x, y, w, h] = a.length >= 8 ? a.slice(4) : a.length >= 4 ? a : [a[0], a[1], img.width, img.height]; rec(this, 'image', box(this, x, y, w, h)); return o.apply(this, arguments); }; }
};
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const R = St.METER_RECT(W);
const inter = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a, b, pad = 6) => a.x >= b.x - pad && a.y >= b.y - pad && a.x + a.w <= b.x + b.w + pad && a.y + a.h <= b.y + b.h + pad;
async function boot(coop) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } }); await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('favicon')) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  const ev = (f, a) => page.evaluate(f, a), w = ms => page.waitForTimeout(ms);
  await page.goto(URL0 + '?coach=0&wipe=0&amb=0'); await w(1200);
  const meterOn = () => ev(() => window.__ops().some(o => o.text === 'STYLE'));
  const titleSeen = await meterOn();
  for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect && window.__ppSelect.active)); i++) { await page.keyboard.press('KeyX'); await w(150); }
  await w(200); const selSeen = await meterOn();
  await page.keyboard.press('Enter'); await w(300);
  for (let i = 0; i < 40; i++) { const st = await ev(() => ({ cine: window.__ppCinema.isActive(), c: !!(window.__ppState && window.__ppState.combat) })); if (st.cine) { await page.keyboard.press('Escape'); await w(250); continue; } if (st.c) break; await w(200); }
  await w(500);
  if (coop) for (let i = 0; i < 3 && !(await ev(() => !!(window.__ppCoop && window.__ppCoop.p2))); i++) { await page.keyboard.press('NumpadEnter'); await w(400); await page.keyboard.press('NumpadEnter'); await w(400); }
  await ev(() => { const s = window.__ppState; s.invuln = 99; s.ninjas.forEach(n => { n.x = s.player.x + 900; n.stun = 99; }); });
  return { ctx, page, ev, w, meterOn, titleSeen, selSeen };
}
const tag = c => c ? 'co-op' : '1P';
for (const coop of [false, true]) {
  const { ctx, page, ev, w, meterOn, titleSeen, selSeen } = await boot(coop);
  if (!coop) { ok(!titleSeen, 'meter not drawn on the title'); ok(!selSeen, 'meter not drawn on character select'); }
  if (coop) ok(await ev(() => !!(window.__ppCoop && window.__ppCoop.p2)), 'co-op: 2P joined');
  ok(await meterOn(), `${tag(coop)}: meter drawn during play`);
  // Busy HUD: combo counter up, a boss bar on screen. (No HP poke: style counts lost HP as damage.)
  if (coop) { // the boss bar only in the co-op pass (removing a fake boss ends the stage)
    await ev(() => { const s = window.__ppState; s.ninjas.push({ kind: 'boss', name: 'TEST BOSS', level: s.level, x: s.player.x + 1400, y: s.player.y, r: 20, hp: 30, maxHp: 30, vx: 0, vy: 0, stun: 99, phase: 1 }); });
    await w(200); for (let i = 0; i < 20 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(250); } // the boss intro
    await w(400); if (await ev(() => window.__ppPause && window.__ppPause.isOpen())) { await page.keyboard.press('Escape'); await w(300); }
    for (let i = 0; i < 40 && await ev(() => window.__ops().some(o => o.text === 'BOSS')); i++) await w(200); // wait out the boss name card
    await ev(() => { const s = window.__ppState; s.invuln = 99; });
  }
  for (let c = 2; c <= 12; c++) { await ev(c => { const s = window.__ppState; s.combo = c; s.comboTimer = 2.4; }, c); await w(20); }
  await w(800); // past the milestone pop
  ok(!(await ev(() => window.__ppPause && window.__ppPause.isOpen())), `${tag(coop)}: not paused`);
  const m = await ev(() => window.__ppStyle.meter);
  ok(m.drawn && m.rect && m.rect.x === R.x && m.rect.y === R.y, `${tag(coop)}: meter rect ${JSON.stringify(m.rect)}`);
  const ops = await ev(() => window.__ops());
  const hudStart = ops.findIndex(o => o.text === 'SCORE');
  const hud = ops.slice(Math.max(0, hudStart)).filter(o => !(o.w > W * 0.8 && o.h > H * 0.5) && o.w > 0 && o.h > 0);
  const mine = hud.filter(o => inside(o, R));
  const hit = hud.filter(o => !inside(o, R) && inter(o, R));
  ok(hudStart >= 0 && mine.some(o => o.text === 'STYLE'), `${tag(coop)}: meter ops found in the HUD pass (${mine.length})`);
  ok(hit.length === 0, `${tag(coop)}: no HUD draw intersects the meter` + (hit.length ? ' ' + JSON.stringify(hit.slice(0, 4).map(o => [o.kind, o.text, Math.round(o.x), Math.round(o.y), Math.round(o.w), Math.round(o.h)])) : ''));
  const combo = hud.find(o => o.text === '12'), heroCard = hud.find(o => o.text === 'HP' || o.text === 'HERO');
  ok(combo && !inter(combo, R) && combo.y + combo.h <= R.y, `${tag(coop)}: combo counter sits above the meter`);
  if (coop) ok(hud.some(o => /^PHASE /.test(o.text || '')), `${tag(coop)}: boss bar drawn in the same frame`);
  if (shots) await page.screenshot({ path: `${shots}/meter-${coop ? 'coop' : '1p'}.png` });
  if (!coop) {
    // Rank-up pulse, then dim on idle and relight.
    await ev(() => { const s = window.__ppState; s.combo = 0; }); await w(100);
    await ev(() => { const s = window.__ppState; s.combo = 22; s.comboTimer = 2.4; }); await w(130); // 22 + -> B
    const pulse = await ev(() => { const o = window.__ops(); const i = o.findIndex(x => x.text === 'STYLE'); return o.slice(Math.max(0, i - 6), i).filter(x => /^[SABC]$/.test(x.text || '')).map(x => ({ t: x.text, sx: x.sx })); });
    ok(pulse.length && pulse[0].t === 'B' && pulse[0].sx > 1.01, 'rank-up C -> B pulses the pip: ' + JSON.stringify(pulse));
    if (shots) await page.screenshot({ path: `${shots}/meter-rankup.png` });
    await ev(() => { const s = window.__ppState; s.combo = 0; }); await w(6000);
    const dim = await ev(() => window.__ppStyle.meter);
    ok(dim.drawn && dim.alpha < 0.5, 'dims after idle: alpha ' + dim.alpha);
    if (shots) await page.screenshot({ path: `${shots}/meter-dim.png` });
    await ev(() => { const s = window.__ppState; s.combo = 3; s.comboTimer = 2.4; }); await w(100);
    ok((await ev(() => window.__ppStyle.meter)).alpha === 1, 'lights up again on activity');
    // Options: colour-safe palette + ticks; reduced motion kills the pulse.
    await ev(async () => { const { OPTIONS } = await import('./options-live.js'); OPTIONS.set('colourSafe', true); OPTIONS.set('reducedMotion', true); });
    await ev(() => { const s = window.__ppState; s.combo = 45; s.comboTimer = 2.4; }); await w(130); // -> A
    const o2 = await ev(() => { const o = window.__ops(); const i = o.findIndex(x => x.text === 'STYLE'); return { letter: o.slice(Math.max(0, i - 6), i).filter(x => /^[SABC]$/.test(x.text || '')).map(x => ({ t: x.text, sx: x.sx, fill: x.fill })), ticks: o.slice(i).filter(x => x.kind === 'fillRect' && Math.round(x.w) === 2 && Math.round(x.h) === 6).length, m: window.__ppStyle.meter }; });
    ok(o2.m.safe && o2.letter[0] && o2.letter[0].t === 'A' && o2.letter[0].fill === '#e69f00' && o2.ticks === 3, 'colour-safe: Okabe-Ito A + 3 ticks: ' + JSON.stringify(o2.letter) + ' ticks ' + o2.ticks);
    ok(o2.letter[0] && o2.letter[0].sx <= 1.0001, 'reduced motion: no rank-up pulse');
    if (shots) await page.screenshot({ path: `${shots}/meter-colour-safe.png` });
    await ev(async () => { const { OPTIONS } = await import('./options-live.js'); OPTIONS.set('colourSafe', false); OPTIONS.set('reducedMotion', false); });
    // Pause: not drawn? (pause overlay keeps the world; the meter may stay, so only check it is not on the clear card.)
    // Stage clear: the last live grade equals the clear card's STYLE grade, and the meter is gone on the card.
    await ev(() => { const s = window.__ppState; s.combo = 0; }); await w(100);
    await ev(() => { const s = window.__ppState; s.hp -= 12; }); await w(100);
    const live = await ev(() => window.__ppStyle.live);
    await ev(async () => { const L = await import('./logic.js'); const s = window.__ppState; s.ninjas.length = 0; L.spawnWave(s); s.invuln = 99; });
    for (let i = 0; i < 30 && (await ev(() => window.__ppScreens.mode())) !== 'clear'; i++) await w(100);
    await w(1700);
    const card = await ev(() => window.__ppScreens.data && window.__ppScreens.data.style);
    ok(card && live && card.grade === live.grade && card.points === live.points, `live grade ${live && live.grade} (${live && live.points}) == clear card ${card && card.grade} (${card && card.points})`);
    ok(!(await meterOn()) && !(await ev(() => window.__ppStyle.meter.drawn)), 'meter not drawn on the stage clear card');
    if (shots) await page.screenshot({ path: `${shots}/stage-clear.png` });
  }
  await ctx.close();
}
ok(errors.length === 0, '0 console errors ' + errors.slice(0, 3).join(' | '));
await browser.close(); server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
