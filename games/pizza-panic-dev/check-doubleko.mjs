// Co-op double-KO checks (baba_booey, t_72c55578c7774b62): P1 and P2 both go to 0 HP on the same
// frame (in every phase of game.js simStep, in both orders, and outside the sim step the way
// game.js's "game over can land outside the sim step" path sees it) and on consecutive frames.
// Each case must reach the continue screen exactly once (no softlock, no double game over),
// count down, and a continue there must be SHARED: both players back up, the co-op pool reset,
// nobody left lying at 0 lives. Then the run-end path: countdown out -> GAME OVER -> initials ->
// high-score table -> title. Last, the same thing in the live game in a browser, 0 console errors.
// usage: node check-doubleko.mjs [url] [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
globalThis.localStorage = globalThis.localStorage || { _: {}, getItem(k) { return k in this._ ? this._[k] : null; }, setItem(k, v) { this._[k] = String(v); }, removeItem(k) { delete this._[k]; } };
const G = new URL('../pizza-panic/', import.meta.url);
const L = await import(new URL('logic.js', G).href);
const E = await import(new URL('events.js', G).href);
const C = await import(new URL('combat.js', G).href);
const CO = await import(new URL('coop.js', G).href);
const SC = await import(new URL('screens.js', G).href);
let pass = 0, total = 0;
const t = async (name, fn) => { total++; try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); } };
const DT = 1 / 120;
const ko = x => { for (let n = 0; !x.over && n < 50; n++) { x.invuln = 0; x.player.shield = false; L.damagePlayer(x, 999); } assert.ok(x.over, 'KO landed'); };

// A headless copy of game.js's simStep around a co-op run: the screens.js continue / initials /
// scores flow, the top-of-step game-over catch, and the end-of-step one. plan(frame, phase, s, v)
// lands the KOs: 'pre' = P1's combat step, 'step' = before coop.step (P2's own enemies), 'world'
// = before the world update (events, enemies, bosses, hazards), 'after' = before coop.after
// (P2's hazards), 'end' = after the sim step (a cinematic callback / debug hook).
function rig(plan) {
  const s = L.createState(); s.hpMode = true; s.selectedHero = 'turtle_blue'; C.createCombat(s); E.ensureEvents(s); L.spawnWave(s);
  const r = { quits: 0, overs: 0 };
  const scr = SC.createScreens({ audio: null, onQuit: () => r.quits++ }); scr.reset(s);
  const coop = CO.createCoop({ rand: () => 0.5, playing: () => !scr.active() });
  coop.step(s, DT); const v = coop.join(s, 'turtle_red');
  for (const n of s.ninjas) n.dead = true; // nobody else hits anyone: only the plan's KOs land
  let prevOver = false, f = 0;
  const frame = () => {
    f++;
    if (scr.blocking()) { scr.update(DT); return; }
    if (s.over && !prevOver) { prevOver = true; r.overs++; scr.gameOver(s); return; }
    if (s.over) return;
    plan(f, 'pre', s, v); C.combatStep(s, DT);
    plan(f, 'step', s, v); coop.step(s, DT);
    plan(f, 'world', s, v); E.stepEvents(s, DT); L.update(s, DT);
    plan(f, 'after', s, v); coop.after(s, DT);
    plan(f, 'end', s, v);
    if (s.over && !prevOver) { r.overs++; scr.gameOver(s); }
    prevOver = s.over;
  };
  return Object.assign(r, { s, v, coop, scr, frame, run: n => { for (let i = 0; i < n; i++) frame(); } });
}
const at = (F, phase, ...who) => (f, p, s, v) => { if (f === F && p === phase) for (const w of who) ko(w === 1 ? s : v); };
const all = (...rules) => (...a) => rules.forEach(q => q(...a));
const CASES = {
  'same frame, P1 then P2 (P1 in its combat step, P2 in coop.step)': all(at(10, 'pre', 1), at(10, 'step', 2)),
  'same frame, P2 then P1 (P2 in coop.step, P1 in the world update)': all(at(10, 'step', 2), at(10, 'world', 1)),
  'same frame, P1 in the world update, P2 in coop.after (hazards)': all(at(10, 'world', 1), at(10, 'after', 2)),
  'same frame, both before coop.step': at(10, 'step', 1, 2),
  'same frame, both in the world update, P1 first': at(10, 'world', 1, 2),
  'same frame, both in the world update, P2 first': at(10, 'world', 2, 1),
  'same frame, both before coop.after': at(10, 'after', 2, 1),
  'same frame, outside the sim step, P1 first': at(10, 'end', 1, 2),
  'same frame, outside the sim step, P2 first': at(10, 'end', 2, 1),
  'consecutive frames, P1 then P2': all(at(10, 'world', 1), at(11, 'step', 2)),
  'consecutive frames, P2 then P1': all(at(10, 'step', 2), at(11, 'world', 1)),
  'consecutive frames, P2 outside the step, P1 next frame': all(at(10, 'end', 2), at(11, 'pre', 1)),
};
const downCheck = r => {
  assert.equal(r.scr.mode(), 'continue', 'continue screen up (mode ' + r.scr.mode() + ')');
  assert.equal(r.overs, 1, 'game over raised exactly once');
  assert.ok(r.s.over && r.v.over, 'both down');
  assert.equal(r.coop.p1Out, false, 'no "1P DOWN" card under the continue screen');
};
const bothUp = (r, why) => {
  assert.equal(r.scr.mode(), null, why + ': screen closed');
  assert.ok(!r.s.over && r.s.lives > 0 && r.s.hp > 0, why + `: P1 up (lives ${r.s.lives}, hp ${r.s.hp})`);
  assert.ok(!r.v.over && r.v.lives > 0 && r.v.hp > 0, why + `: P2 up too (over ${r.v.over}, lives ${r.v.lives})`);
  assert.equal(r.coop.handed, false, why + ': hand-off latch released');
  assert.equal(r.coop.p1Out, false, why + ': P1 not left out');
  assert.equal(r.coop.pool, CO.COOP.continues, why + ': co-op pool reset by the shared continue');
};
for (const [name, plan] of Object.entries(CASES)) {
  await t(name + ': one game over, countdown, shared continue, then a second double KO between frames works too', () => {
    const r = rig(plan); r.run(20); downCheck(r);
    const t0 = r.scr.t; r.run(120 * 2); assert.ok(r.scr.t > t0 + 1.9 && r.scr.mode() === 'continue', 'countdown runs (' + t0.toFixed(2) + ' -> ' + r.scr.t.toFixed(2) + ')');
    r.scr.press('Enter'); r.run(30); bothUp(r, 'continue');
    // the run goes on together: P2 can still be KO'd alone and P1 alone (the co-op rules, not a game over)
    ko(r.v); r.run(2); assert.ok(r.v.over && !r.s.over && r.scr.mode() === null, 'P2 alone down is not a game over');
    assert.ok(r.coop.continueP2(r.s) && !r.v.over, 'P2 spends a pool continue');
    // and a second same-frame double KO goes through the same flow again
    const s = r.s, v = r.v; s.invuln = v.invuln = 0; ko(s); ko(v); r.run(10);
    assert.equal(r.scr.mode(), 'continue', 'second double KO: continue screen (' + r.scr.mode() + ')'); assert.equal(r.overs, 2, 'second game over raised once');
    r.scr.press('Enter'); r.run(30); bothUp(r, 'second continue');
  });
}
await t('run end after a same-frame double KO: countdown out -> GAME OVER -> initials -> high scores -> title', () => {
  localStorage._ = {};
  const r = rig(at(10, 'world', 2, 1)); r.s.score = 12345; r.run(20); downCheck(r);
  r.run(120 * 11); assert.equal(r.scr.mode(), 'final', 'countdown ran out into GAME OVER (' + r.scr.mode() + ')');
  r.run(150); r.scr.press('Enter'); assert.equal(r.scr.mode(), 'initials', 'initials entry (' + r.scr.mode() + ')');
  for (const k of ['KeyK', 'KeyY', 'KeyL']) r.scr.press(k);
  assert.equal(r.scr.mode(), 'scores', 'high-score table'); assert.ok(SC.loadScores().some(e => e.n === 'KYL' && e.score === 12345), 'score saved with initials');
  r.run(150); r.scr.press('Enter'); assert.equal(r.scr.mode(), null); assert.equal(r.quits, 1, 'back to the title exactly once');
  assert.equal(r.overs, 1, 'no second game over on the way out');
});
await t('Escape on the continue screen after a double KO also ends the run cleanly; a new run resets co-op', () => {
  const r = rig(at(10, 'end', 1, 2)); r.run(20); downCheck(r);
  r.scr.press('Escape'); assert.equal(r.scr.mode(), 'final'); r.run(150); r.scr.press('Enter'); r.run(150); r.scr.press('Enter'); r.run(150); r.scr.press('Enter');
  assert.equal(r.quits, 1, 'title');
  const s2 = L.createState(); s2.hpMode = true; s2.selectedHero = 'turtle_blue'; C.createCombat(s2); E.ensureEvents(s2); L.spawnWave(s2);
  r.coop.step(s2, DT); const v2 = r.coop.p2;
  assert.ok(v2 && !v2.over && v2.lives > 0, 'P2 rides into the new run fresh');
  assert.deepEqual([r.coop.handed, r.coop.p1Out, r.coop.pool], [false, false, CO.COOP.continues], 'co-op flags fresh');
});

// ---- browser
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
let url = process.argv[2], server; const shots = process.argv[3] || '/workspace/pizza-doubleko/';
fs.mkdirSync(shots, { recursive: true });
if (!url || url === '-') {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(G.pathname, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(G.pathname) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); url = `http://127.0.0.1:${server.address().port}/`;
}
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
const w = ms => page.waitForTimeout(ms), ev = (f, a) => page.evaluate(f, a);
const snap = async f => { const d = await ev(() => { try { return document.getElementById('c').toDataURL('image/png'); } catch (_) { return null; } }); if (d) fs.writeFileSync(f, Buffer.from(d.split(',')[1], 'base64')); else await page.screenshot({ path: f }); };
const until = async (f, ms = 4000, a) => { for (let i = 0; i < ms / 50; i++) { if (await ev(f, a)) return true; await w(50); } return false; };
const start = async () => {
  await page.goto(url); await w(1000); await page.keyboard.press('Enter');
  for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect.active)); i++) { await page.keyboard.press('Enter'); await w(100); }
  await page.keyboard.press('NumpadEnter'); await w(100); await page.keyboard.press('Numpad6'); await w(100); await page.keyboard.press('Numpad1'); await w(100);
  await page.keyboard.press('Enter'); await w(300);
  for (let i = 0; i < 12 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); }
  await w(400); assert.ok(await ev(() => !!window.__ppCoop.p2 && !window.__ppState.over), 'co-op run going');
};
// Same frame inside the live sim step: tower.step runs after the world update, before coop.after.
const arm = () => ev(() => {
  const tw = window.__ppTower, base = tw.__baseStep || (tw.__baseStep = tw.step);
  tw.step = function (s, dt) {
    if (!window.__dko) { const ko = x => { for (let n = 0; !x.over && n < 50; n++) { x.invuln = 0; x.player.shield = false; x.hp = 0.5; x.lives = Math.min(x.lives, 1); x.hp = 0; x.lives = 0; x.over = true; } }; ko(window.__ppCoop.p2); ko(s); window.__dko = true; }
    return base.call(this, s, dt);
  };
});
const shot = () => ev(() => ({ mode: window.__ppScreens.mode(), t: window.__ppScreens.t, s: { over: window.__ppState.over, lives: window.__ppState.lives, hp: window.__ppState.hp }, v: { over: window.__ppCoop.p2.over, lives: window.__ppCoop.p2.lives, hp: window.__ppCoop.p2.hp }, handed: window.__ppCoop.handed, p1Out: window.__ppCoop.p1Out, pool: window.__ppCoop.pool }));
await t('browser: same-frame double KO in the live sim -> continue countdown -> shared continue, both fight on', async () => {
  await start(); await arm();
  assert.ok(await until(() => window.__ppScreens.mode() === 'continue'), 'continue screen');
  const a = await shot(); await w(1300); const b = await shot(); await snap(shots + 'doubleko-1-continue.png');
  assert.ok(b.mode === 'continue' && b.t > a.t + 1, 'countdown ticking ' + JSON.stringify([a.t, b.t]));
  await page.keyboard.press('Enter'); await w(500); const c = await shot(); await snap(shots + 'doubleko-2-continued.png');
  assert.ok(c.mode === null && !c.s.over && !c.v.over && c.s.lives > 0 && c.v.lives > 0 && !c.handed && !c.p1Out, 'both back up ' + JSON.stringify(c));
  await ev(() => { window.__ppTower.step = window.__ppTower.__baseStep; });
});
await t('browser: double KO between frames (debug hook / callback path) -> shared continue too', async () => {
  await ev(() => { for (const x of [window.__ppState, window.__ppCoop.p2]) { x.hp = 0; x.lives = 0; x.over = true; } });
  assert.ok(await until(() => window.__ppScreens.mode() === 'continue'), 'continue screen');
  await page.keyboard.press('Enter'); await w(500); const c = await shot();
  assert.ok(c.mode === null && !c.s.over && !c.v.over && c.v.lives > 0 && !c.handed, 'both back up ' + JSON.stringify(c));
});
await t('browser: double KO, countdown runs out -> GAME OVER -> initials -> high scores -> title, 0 console errors', async () => {
  await ev(() => { window.__ppState.score = 54321; window.__dko = false; }); await arm();
  assert.ok(await until(() => window.__ppScreens.mode() === 'continue'), 'continue screen');
  assert.ok(await until(() => window.__ppScreens.mode() === 'final', 14000), 'countdown ran out into GAME OVER');
  await snap(shots + 'doubleko-3-gameover.png'); await w(1200); await page.keyboard.press('Enter');
  assert.ok(await until(() => window.__ppScreens.mode() === 'initials'), 'initials entry');
  for (const k of ['KeyK', 'KeyY', 'KeyL']) { await page.keyboard.press(k); await w(80); }
  assert.ok(await until(() => window.__ppScreens.mode() === 'scores'), 'high-score table'); await snap(shots + 'doubleko-4-scores.png');
  assert.ok(await ev(() => window.__ppScreens.scores().some(e => e.n === 'KYL' && e.score === 54321)), 'score saved');
  await w(1200); await page.keyboard.press('Enter');
  assert.ok(await until(() => window.__ppScreens.mode() === null && (window.__ppTitle.isActive() || window.__ppSelect.active), 5000), 'back to the title');
  await ev(() => { window.__ppTower.step = window.__ppTower.__baseStep; });
  await w(600); await snap(shots + 'doubleko-5-title.png');
  assert.deepEqual(errors, []);
});
await browser.close(); if (server) server.close();
console.log(`${pass}/${total} double-KO checks passed`);
process.exit(pass === total ? 0 : 1);
