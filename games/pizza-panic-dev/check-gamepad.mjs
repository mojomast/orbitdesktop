// Gamepad checks (cheese, t_e2a79b1973914d1c). Part 1 runs gamepad.js in Node with a
// stubbed pad list and asserts the key events it emits. Part 2 stubs
// navigator.getGamepads in headless Chrome and drives the real game with the pad only:
// boot, title, character select, intro skip, movement, punch, pause menu, game over.
// usage: node check-gamepad.mjs [url]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const G = new URL('../pizza-panic/', import.meta.url);
const GP = await import(new URL('gamepad.js', G).href);
let pass = 0, total = 0;
const ok = (c, m) => { total++; if (c) pass++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

// ---- Part 1: unit mapping
const pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
const ev = []; let face = 1;
const gp = GP.createGamepad({ getPads: () => [null, pad], emit: (t, c) => ev.push(t + ':' + c), facing: () => face });
const press = (i, v = true) => { pad.buttons[i] = { pressed: v, value: v ? 1 : 0 }; };
const frame = (mode = 'play') => { ev.length = 0; gp.poll(1 / 60, mode); return ev.slice(); };
ok(frame().length === 0, 'idle pad emits nothing');
pad.axes[0] = 0.2; ok(frame().length === 0, 'stick inside 0.25 deadzone is ignored');
pad.axes[0] = 0.9; ok(frame().join() === 'keydown:ArrowRight', 'stick right holds ArrowRight');
ok(frame().length === 0, 'held stick does not repeat keydown');
pad.axes[0] = 0; pad.axes[1] = -0.8; ok(frame().sort().join() === 'keydown:ArrowUp,keyup:ArrowRight', 'stick up: ArrowUp down, ArrowRight up');
pad.axes[1] = 0; frame();
press(GP.BTN.LEFT); ok(frame().join() === 'keydown:ArrowLeft', 'd-pad left holds ArrowLeft'); press(GP.BTN.LEFT, false); ok(frame().join() === 'keyup:ArrowLeft', 'd-pad release');
const btn = (i, mode = 'play') => { press(i); const e = frame(mode); press(i, false); const r = frame(mode); return [e, r]; };
ok(btn(GP.BTN.X)[0].join() === 'keydown:KeyJ,keyup:KeyJ', 'X = punch (J)');
ok(btn(GP.BTN.B)[0].join() === 'keydown:KeyK,keyup:KeyK', 'B = kick (K)');
ok(btn(GP.BTN.A)[0].join() === 'keydown:KeyL,keyup:KeyL', 'A = jump (L)');
ok(btn(GP.BTN.LB)[0].join() === 'keydown:KeyJ,keyup:KeyJ,keydown:KeyK,keyup:KeyK', 'LB = back attack chord (J+K)');
ok(btn(GP.BTN.RB)[0].join() === 'keydown:KeyJ,keyup:KeyJ,keydown:KeyL,keyup:KeyL', 'RB = special chord (J+L)');
{ const [d, u] = btn(GP.BTN.Y); ok(d.join() === 'keydown:Space' && u.join() === 'keyup:Space', 'Y = pizza throw held while pressed'); }
ok(btn(GP.BTN.START)[0].join() === 'keydown:Escape,keyup:Escape', 'Start = pause (Escape)');
face = -1; ok(btn(GP.BTN.RT)[0].join() === 'keydown:ArrowLeft,keyup:ArrowLeft,keydown:ArrowLeft,keyup:ArrowLeft', 'RT = dash (double tap facing dir)');
press(GP.BTN.X); frame(); ok(frame().length === 0, 'held button fires once (edge detect)'); press(GP.BTN.X, false); frame();
ok(btn(GP.BTN.A, 'pause')[0].join() === 'keydown:Enter,keyup:Enter', 'pause: A = Enter');
ok(btn(GP.BTN.B, 'pause')[0].join() === 'keydown:Escape,keyup:Escape', 'pause: B = Escape (back)');
press(GP.BTN.DOWN); const d1 = frame('pause'); let reps = 0; for (let i = 0; i < 60; i++) reps += frame('pause').length; press(GP.BTN.DOWN, false); frame('pause');
ok(d1.join() === 'keydown:ArrowDown,keyup:ArrowDown' && reps >= 8 && reps <= 20, `menu d-pad taps then auto-repeats (${reps / 2} repeats in 1 s)`);
ok(btn(GP.BTN.START, 'select')[0].join() === 'keydown:Enter,keyup:Enter', 'select: Start = Enter');
ok(btn(GP.BTN.B, 'cine')[0].join() === 'keydown:Escape,keyup:Escape', 'cinematic: B = skip (Escape)');
ok(btn(GP.BTN.A, 'over')[0].join() === 'keydown:Space,keyup:Space', 'game over: A = continue (Space)');
ok(btn(GP.BTN.A, 'continue')[0].join() === 'keydown:Enter,keyup:Enter' && btn(GP.BTN.START, 'continue')[0].join() === 'keydown:Enter,keyup:Enter', 'CONTINUE screen: A/Start = continue (Enter)');
ok(btn(GP.BTN.B, 'continue')[0].join() === 'keydown:Escape,keyup:Escape', 'CONTINUE screen: B = give up (Escape)');
ok(btn(GP.BTN.A, 'clear')[0].join() === 'keydown:Enter,keyup:Enter', 'stage clear: A = next (Enter)');
press(GP.BTN.UP); ok(frame('initials').join() === 'keydown:ArrowUp,keyup:ArrowUp', 'initials: d-pad up cycles the letter'); press(GP.BTN.UP, false); frame('initials');
ok(btn(GP.BTN.B, 'initials')[0].join() === 'keydown:Backspace,keyup:Backspace' && btn(GP.BTN.START, 'initials')[0].join() === 'keydown:Escape,keyup:Escape', 'initials: B = back a slot, Start = commit');
ok(btn(GP.BTN.A, 'credits')[0].join() === 'keydown:Enter,keyup:Enter' && btn(GP.BTN.A, 'scores')[0].join() === 'keydown:Enter,keyup:Enter', 'credits/scores: A = advance');
press(GP.BTN.DOWN); ok(frame('continue').length === 0, 'd-pad does nothing on CONTINUE (would tick the countdown)'); press(GP.BTN.DOWN, false); frame('continue');
{ const g = fs.readFileSync(new URL('game.js', G), 'utf8'); ok(/import \{ pollGamepad \} from '\.\/gamepad\.js'/.test(g) && /^\s*pollGamepad\(dt, [^\n]*screens\.mode\(\)/m.test(g), 'game.js still has the gamepad import + pollGamepad(dt, mode) hook in loop()'); }
pad.axes[0] = 1; frame('play'); ok(frame('pause').join() === 'keyup:ArrowRight', 'mode change releases held keys'); pad.axes[0] = 0; frame('pause');
pad.axes[0] = 1; frame('play'); pad.connected = false; ok(frame('play').join() === 'keyup:ArrowRight', 'disconnect releases held keys'); pad.connected = true; pad.axes[0] = 0; frame();

// No pad connected: the keyboard must be untouched (no events, nothing held).
{ const out = []; let throwIt = false;
  const g0 = GP.createGamepad({ getPads: () => { if (throwIt) throw new Error('no api'); return [null, null, null, null]; }, emit: (t, c) => out.push(t + ':' + c) });
  for (const m of ['boot', 'title', 'cine', 'select', 'pause', 'over', 'play', 'continue', 'initials', 'credits']) for (let i = 0; i < 5; i++) g0.poll(1 / 60, m);
  throwIt = true; g0.poll(1 / 60, 'play');
  const g1 = GP.createGamepad({ getPads: () => [], emit: (t, c) => out.push(t + ':' + c) }); g1.poll(1 / 60, 'play');
  ok(out.length === 0 && g0.held.length === 0 && g0.connected === 0, 'no pad (null slots, empty list, or a throwing API) emits no key events in any mode'); }
// ---- Part 2: real game in headless Chrome, pad only
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = G.pathname;
let url = process.argv[2], server;
if (!url || url === '-') {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); url = `http://127.0.0.1:${server.address().port}/`;
}
const errors = [];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
await page.addInitScript(() => {
  const mk = () => ({ id: 'stub pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
  window.__pad = mk();
  navigator.getGamepads = () => [window.__pad, null, null, null];
  window.__btn = (i, v) => { window.__pad.buttons[i] = { pressed: v, value: v ? 1 : 0 }; };
});
const B = GP.BTN, wait = ms => page.waitForTimeout(ms);
const tapBtn = async (i, hold = 90) => { await page.evaluate(i => window.__btn(i, true), i); await wait(hold); await page.evaluate(i => window.__btn(i, false), i); await wait(90); };
try {
  await page.goto(url); await wait(1200);
  await tapBtn(B.A);
  ok(await page.evaluate(() => window.__ppTitle.isActive()), 'pad A on the boot screen starts the title');
  for (let i = 0; i < 60 && !(await page.evaluate(() => window.__ppSelect.active)); i++) await tapBtn(i % 6 === 5 ? B.B : B.START);
  ok(await page.evaluate(() => window.__ppSelect.active), 'pad Start/B through the title reaches character select');
  const idx = () => page.evaluate(() => window.__ppSelect.index);
  const i0 = await idx(); await tapBtn(B.RIGHT); ok(await idx() === (i0 + 1) % 7, 'd-pad right moves the select cursor');
  await page.evaluate(() => { window.__pad.axes[1] = 0.9; }); await wait(120); await page.evaluate(() => { window.__pad.axes[1] = 0; }); await wait(80);
  ok(await idx() >= 4, 'stick down jumps to the second row (' + await idx() + ')');
  const want = await page.evaluate(i => import('./heroes.js').then(m => m.HEROES[i].id), await idx());
  await tapBtn(B.A);
  ok(await page.evaluate(() => window.__ppCinema.isActive()) && await page.evaluate(() => window.__ppSelect.hero) === want, 'pad A confirms the hero (' + want + ') and the intro plays');
  for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema.isActive()); i++) await tapBtn(B.B);
  ok(!(await page.evaluate(() => window.__ppCinema.isActive())), 'pad B skips the intro');
  await wait(400);
  const x0 = await page.evaluate(() => window.__ppState.player.x);
  await page.evaluate(() => { window.__pad.axes[0] = 1; }); await wait(700); await page.evaluate(() => { window.__pad.axes[0] = 0; }); await wait(100);
  const x1 = await page.evaluate(() => window.__ppState.player.x);
  ok(x1 > x0 + 20, `stick right walks the hero (${Math.round(x0)} -> ${Math.round(x1)})`);
  await page.evaluate(() => window.__btn(2, true)); await wait(40);
  const ph = await page.evaluate(() => window.__ppState.combat.phase + '/' + (window.__ppState.combat.attack && window.__ppState.combat.attack.name));
  await page.evaluate(() => window.__btn(2, false)); await wait(300);
  ok(/wind|active/.test(ph), 'pad X starts a punch (' + ph + ')');
  const smode = () => page.evaluate(() => window.__ppScreens && window.__ppScreens.mode());
  const kill = () => page.evaluate(async () => { const s = window.__ppState; s.lives = 1; s.hp = 1; s.player.shield = false; s.invuln = 0; const L = await import('./logic.js'); L.damagePlayer(s, 999); });
  await kill(); await wait(400);
  ok(await smode() === 'continue', 'death opens the CONTINUE screen (' + await smode() + ')');
  await tapBtn(B.A); await wait(100);
  ok(!(await smode()) && await page.evaluate(() => !window.__ppState.over && window.__ppState.lives > 0), 'pad A on CONTINUE resumes the run');
  await wait(3200); await kill(); await wait(400);
  await tapBtn(B.B); await wait(1200);
  ok(await smode() === 'final', 'pad B on CONTINUE gives up (final game over: ' + await smode() + ')');
  await tapBtn(B.A); await wait(200);
  const m2 = await smode(); ok(m2 === 'initials' || m2 === 'scores', 'pad A on the final screen moves on (' + m2 + ')');
  if (m2 === 'initials') { await tapBtn(B.UP); await tapBtn(B.START); await wait(1200); ok(await smode() === 'scores', 'pad d-pad + Start enters initials and shows the table'); }
  await wait(1200); await tapBtn(B.A); await wait(400);
  ok(await page.evaluate(() => window.__ppTitle.isActive()), 'pad A on the high-score table returns to the title');
  for (let i = 0; i < 60 && !(await page.evaluate(() => window.__ppSelect.active)); i++) await tapBtn(B.START);
  await tapBtn(B.A); for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema.isActive()); i++) await tapBtn(B.B);
  ok(await page.evaluate(() => !window.__ppSelect.active && !window.__ppCinema.isActive() && !window.__ppState.over), 'pad Start/A/B from the title back into a new run');
  await wait(300);
  await tapBtn(B.START);
  ok(await page.evaluate(() => window.__ppPause.isOpen()), 'pad Start opens the pause menu');
  await tapBtn(B.DOWN); await tapBtn(B.A);
  ok(await page.evaluate(() => window.__ppPause.menu()) === 'controls', 'pad d-pad down + A opens Controls');
  await tapBtn(B.B); ok(await page.evaluate(() => window.__ppPause.menu()) === 'main', 'pad B goes back to the main pause menu');
  await tapBtn(B.START); ok(!(await page.evaluate(() => window.__ppPause.isOpen())), 'pad Start closes the pause menu');
  // Keyboard-only run with Chrome's real empty pad list: the pad layer must stay silent.
  { const p2 = await browser.newPage({ viewport: { width: 740, height: 510 } }); const e2 = [];
    p2.on('pageerror', e => e2.push(String(e))); p2.on('console', m => { if (m.type() === 'error') e2.push(m.text()); });
    await p2.addInitScript(() => { navigator.getGamepads = () => [null, null, null, null]; });
    await p2.goto(url); await p2.waitForTimeout(1200); await p2.keyboard.press('Enter'); await p2.waitForTimeout(300);
    for (let i = 0; i < 80 && !(await p2.evaluate(() => window.__ppSelect.active)); i++) { await p2.keyboard.press('Enter'); await p2.waitForTimeout(120); }
    await p2.keyboard.press('ArrowRight'); const si = await p2.evaluate(() => window.__ppSelect.index);
    await p2.keyboard.press('Enter'); await p2.waitForTimeout(300);
    for (let i = 0; i < 12 && await p2.evaluate(() => window.__ppCinema.isActive()); i++) { await p2.keyboard.press('Escape'); await p2.waitForTimeout(150); }
    await p2.waitForTimeout(300);
    const kx0 = await p2.evaluate(() => window.__ppState.player.x); await p2.keyboard.down('ArrowRight'); await p2.waitForTimeout(600); await p2.keyboard.up('ArrowRight');
    const kx1 = await p2.evaluate(() => window.__ppState.player.x);
    await p2.keyboard.press('KeyJ'); const kph = await p2.evaluate(() => window.__ppState.combat.phase);
    await p2.waitForTimeout(400); await p2.keyboard.press('Escape'); await p2.waitForTimeout(100);
    const kpause = await p2.evaluate(() => window.__ppPause.isOpen()); const klog = await p2.evaluate(() => window.__ppGamepad ? window.__ppGamepad.log.length : -1);
    ok(si === 1 && kx1 > kx0 + 20 && /wind|active/.test(kph) && kpause && klog === 0 && e2.length === 0, `no pad: keyboard select/walk/punch/pause all work and the pad layer emitted nothing (select ${si}, x ${Math.round(kx0)}->${Math.round(kx1)}, ${kph}, pause ${kpause}, pad events ${klog}, errors ${e2.length})`);
    await p2.close(); }
  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
} catch (e) { ok(false, 'browser run threw: ' + e.message); }
await browser.close(); if (server) server.close();
console.log(`${pass}/${total} gamepad checks passed`);
process.exit(pass === total ? 0 : 1);
