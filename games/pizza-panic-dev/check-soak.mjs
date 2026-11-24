// mr_india long-play soak (t_6935cafade474eaa). Plays the whole campaign (all 8 levels in LEVEL_ORDER) with an
// in-page autopilot at 3x game speed (requestAnimationFrame timestamps scaled; the game caps dt at 0.05 s), on
// Easy / Normal / Hard and in 2-player co-op (Normal), through the real stage transitions, boss fights, stage-clear,
// bonus, shop, wipe and coach paths, and a page reload + CONTINUE from the save mid-run.
// The bot is a player, not a cheat: it walks, fights the nearest enemy, jumps, specials; the only help is an HP floor
// ("god mode", so a weak bot still sees every level) and nudges when it stalls, each nudge logged as a finding.
// Watches: console errors + warnings, page errors, frame errors, softlocks (no progress), enemies stuck off-screen /
// out of bounds / NaN, boss spawn + death, stage transitions (level sequence = LEVEL_ORDER), co-op double-KO,
// entity counts and JS heap growth.
// usage: node check-soak.mjs easy,normal,hard,coop [--speed 3] [--minutes 30] [--json out.json]   (runs in parallel)
// With no run names (the suite loop) only the fast node-side regression runs.
import { createRequire } from 'node:module'; import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname;
const argv = process.argv.slice(2); const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const RUNS = (argv.find(a => /^(easy|normal|hard|coop)/.test(a)) || 'easy,normal,hard,coop').split(',');
const SPEED = +opt('--speed', 3), JSON_OUT = opt('--json', null), RUN_MIN = +opt('--minutes', 30);
const { LEVEL_ORDER } = await import(ROOT + 'logic.js');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.md': 'text/plain' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res)); const URL0 = `http://127.0.0.1:${server.address().port}/`;
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- in-page: time scale + autopilot + monitor (installed before the game boots) ----
const INIT = (SPEED) => {
  const raf = window.requestAnimationFrame.bind(window); let base = null;
  window.requestAnimationFrame = cb => raf(t => { if (base == null) base = t; cb(base + (t - base) * SPEED); });
  const P = window.__soak = { findings: [], warns: [], tick: 0, levels: [], bossSpawn: 0, bossDie: 0, nudges: 0, modes: {}, maxCounts: {}, heap: [], doubleKO: null, p2: false, lastLevelT: 0, snaps: [] };
  const down = new Set();
  const key = (code, on) => { if (on === down.has(code)) return; on ? down.add(code) : down.delete(code); window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, key: code, bubbles: true })); };
  const tap = code => { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true })); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })), 40); };
  const release = () => { for (const c of [...down]) key(c, false); };
  P.find = (type, msg, extra) => { const s = window.__ppState; const f = { type, msg, level: s && s.level, wave: s && s.wave, t: +(performance.now() / 1000).toFixed(1), ...(extra || {}) }; P.findings.push(f); return f; };
  const blocked = () => { const W = window; return (W.__ppCinema && W.__ppCinema.isActive()) || (W.__ppScreens && W.__ppScreens.active()) || (W.__ppBonus && W.__ppBonus.active()) || (W.__ppShop && W.__ppShop.active()) || (W.__ppPause && W.__ppPause.isOpen()) || (W.__ppTitle && W.__ppTitle.isActive && W.__ppTitle.isActive()); };
  let menuT = 0, shopT = 0, bonusT = 0, scrT = 0, lastProg = null, progT = 0, stuck = new Map(), lastLv = null, bossAlive = false, phase = 0;
  P.drive = (keys, body, enemies, prefix) => {
    // walk to the nearest live enemy on the same plane, attack when close; with nobody around, walk right.
    const [L, R, U, D, PUNCH, KICK, JUMP] = keys; const s = window.__ppState;
    let best = null, bd = 1e9; for (const n of enemies) { if (n.dead || n.grabbed) continue; const d = Math.abs(n.x - body.x) + Math.abs((n.y || 0) - body.y) * 1.5; if (d < bd) { bd = d; best = n; } }
    phase++;
    // blocked by a crate or prop while walking: step around it vertically for a moment, like a player would
    const bk = prefix || keys[0]; P.blk = P.blk || {}; const b = P.blk[bk] || (P.blk[bk] = { x: body.x, n: 0, side: 0 });
    if (b.side > 0) { b.side--; key(L, false); key(R, false); key(b.dir, true); key(b.dir === D ? U : D, false); return; }
    if (Math.abs(body.x - b.x) < 2 && (down.has(L) || down.has(R))) { if (++b.n > 30) { b.n = 0; b.side = 18; b.dir = body.y < 420 ? D : U; } } else { b.n = 0; b.x = body.x; }
    if (!best) { key(L, false); key(U, false); key(D, false); key(R, true); if (phase % 25 === 0) tap(JUMP); if (phase % 9 === 0) tap(PUNCH); return; }
    const dx = best.x - body.x, dy = (best.y || body.y) - body.y, fly = best.kind === 'drone' || (best.z || 0) > 40;
    key(R, dx > 46); key(L, dx < -46); key(D, dy > 12); key(U, dy < -12);
    if (Math.abs(dx) < 80 && Math.abs(dy) < 30) { key(R, false); key(L, false); if (Math.abs(dx) > 8) key(dx > 0 ? R : L, true), setTimeout(() => key(dx > 0 ? R : L, false), 30); tap(phase % 4 === 3 ? KICK : PUNCH); if (fly && phase % 3 === 0) tap(JUMP); }
    else if (fly && Math.abs(dx) < 120 && phase % 6 === 0) tap(JUMP);
  };
  setInterval(() => {
    const W = window, s = W.__ppState; if (!s || !W.__ppScreens) return; P.tick++;
    const now = performance.now() / 1000;
    { const ba = (s.ninjas || []).some(n => n.kind === 'boss' && !n.dead); if (ba && !bossAlive) P.bossSpawn++; if (!ba && bossAlive) P.bossDie++; bossAlive = ba;
      const m = W.__ppScreens.mode(); if (m) P.modes[m] = (P.modes[m] || 0) + 1; if (W.__ppBonus && W.__ppBonus.active()) P.modes.bonus = 1; if (W.__ppShop && W.__ppShop.active()) P.modes.shop = 1; if (W.__ppWipe && W.__ppWipe.playing) P.modes.wipe = 1; if (W.__ppCoach && W.__ppCoach.active) P.modes.coach = 1; }
    // ---- menus and screens, driven by key presses (real paths) ----
    if (W.__ppSelect && W.__ppSelect.active) return; // the harness drives the select screen
    if (W.__ppCinema.isActive()) { release(); if (now - menuT > 0.5) { menuT = now; tap('Escape'); } return; }
    if (W.__ppPause && W.__ppPause.isOpen()) { release(); if (now - menuT > 0.5) { menuT = now; tap('Escape'); } return; }
    if (W.__ppShop && W.__ppShop.active()) { release(); if (!shopT) shopT = now; if (now - menuT > 0.6) { menuT = now; tap(now - shopT < 1.5 ? 'Enter' : 'Escape'); } if (now - shopT > 12) { P.find('shop', 'shop did not close on Escape within 12 s'); W.__ppShop.leave(); } return; } else shopT = 0;
    if (W.__ppBonus && W.__ppBonus.active()) { if (!bonusT) bonusT = now; const m = W.__ppBonus.mode; if (m === 'results') { release(); if (now - menuT > 1.2) { menuT = now; tap('Enter'); } } else { key('ArrowRight', true); if (P.tick % 8 === 0) tap(P.tick % 16 ? 'ArrowUp' : 'ArrowDown'); }
      if (now - bonusT > 60) { P.find('bonus', 'bonus stage still open after 60 s'); try { W.__ppBonus.finish(); W.__ppBonus.close(); } catch {} } return; } else bonusT = 0;
    if (W.__ppScreens.active()) { release(); if (!scrT) scrT = now; if (now - menuT > 0.9) { menuT = now; tap('Enter'); } if (now - scrT > 40) { P.find('screen', `screen '${W.__ppScreens.mode()}' did not advance on Enter within 40 s`); scrT = now; } return; } else scrT = 0;
    if (W.__ppCoach && W.__ppCoach.active) { if (now - menuT > 0.7) { menuT = now; tap('Enter'); } }
    // ---- god mode: HP floor ----
    const max = s.maxHp || 100; if (!(P.noGod > now) && s.hp < max * 0.35 && !s.over) s.hp = max;
    const co = W.__ppCoop && W.__ppCoop.p2; if (!(P.noGod > now) && co && co.hp != null && co.hp < (co.maxHp || 100) * 0.35) co.hp = co.maxHp || 100;
    // ---- drive ----
    const enemies = s.ninjas || [];
    if (P.passive > now) { release(); if (P.tick % 30 === 0) tap('ArrowRight'); } // stand in the fight and take the hits
    else P.drive(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyJ', 'KeyK', 'KeyL'], s.player, enemies);
    if (P.tick % 90 === 0 && enemies.some(n => !n.dead)) { tap('KeyJ'); tap('KeyL'); } // J+L special now and then
    if (P.tick % 400 === 0) { s.super = 100; tap('KeyU'); }
    if (co && co.player) P.drive(['Numpad4', 'Numpad6', 'Numpad8', 'Numpad5', 'Numpad1', 'Numpad2', 'Numpad3'], co.player, enemies, 'p2');
    // ---- monitor ----
    if (s.level !== lastLv && s.wave > 0 && !(W.__ppTitle && W.__ppTitle.isActive())) { P.levels.push({ level: s.level, wave: s.wave, at: +now.toFixed(1) }); lastLv = s.level; P.lastLevelT = now; stuck.clear(); }
    const live = enemies.filter(n => !n.dead);
    for (const [k, v] of [['player.x', s.player.x], ['player.y', s.player.y], ['hp', s.hp], ['score', s.score]]) if (!Number.isFinite(v)) { if (!P['nan' + k]) P.find('nan', `${k} is ${v}`); P['nan' + k] = 1; }
    const cam = W.__ppCamX || 0, lvW = 5442;
    for (const n of live) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) { if (!n.__soakNaN) { n.__soakNaN = 1; P.find('nan', `${n.kind} position NaN (${n.x},${n.y})`); } continue; }
      const off = n.x < cam - 260 || n.x > cam + 1000 || n.y < -400 || n.y > 900;
      const id = n.__soakId || (n.__soakId = Math.random().toString(36).slice(2, 8));
      if (off) { const t0 = stuck.get(id) || now; stuck.set(id, t0); if (now - t0 > 12 && !n.__soakStuck) { n.__soakStuck = 1; P.find('stuck', `${n.kind} off-screen/out of bounds for 12 s at x ${Math.round(n.x)} y ${Math.round(n.y)} (cam ${Math.round(cam)})`, { state: n.state || n.mode || null, scripted: !!n.scripted }); } }
      else stuck.delete(id);
    }
    for (const [k, v] of Object.entries(s)) if (Array.isArray(v)) P.maxCounts[k] = Math.max(P.maxCounts[k] || 0, v.length);
    if (P.tick % 100 === 0 && performance.memory) P.heap.push([+now.toFixed(0), Math.round(performance.memory.usedJSHeapSize / 1e6), s.level, (s.ninjas || []).length]);
    // ---- softlock: nothing moves (level, wave, player x, enemy HP, events) for 20 s ----
    const prog = [s.level, s.wave, Math.round(s.player.x / 40), live.length, live.reduce((a, n) => a + (n.hp || 0), 0), s.events ? s.events.firedCount : 0, s.score].join('|');
    if (prog !== lastProg) { lastProg = prog; progT = now; }
    else if (now - progT > 20 && !s.over && !s.runComplete) {
      const e = s.events || {}; P.nudges++;
      P.find('softlock', `no progress for 20 s (player ${Math.round(s.player.x)},${Math.round(s.player.y)} cam ${Math.round(cam)})`, { x: Math.round(s.player.x), cam: Math.round(cam), live: live.map(n => `${n.kind}@${Math.round(n.x)},${Math.round(n.y)} hp${n.hp}${n.scripted ? ' scripted' : ''}`).slice(0, 6), combat: (() => { const c = s.combat || {}; return { atk: c.attack && c.attack.name, phase: c.phase, moving: c.moving, grab: !!c.grab, stun: c.stun, down: s.playerDown, keys: [...down] }; })(), lock: e.lock ? { L: Math.round(e.lock.L), R: Math.round(e.lock.R), t: Math.round(e.lock.t) } : null, holdWave: s.holdWave, walkLevel: s.walkLevel });
      live.forEach(n => { n.hp = 0; n.dead = true; }); progT = now;
    }
  }, 33);
  // co-op double-KO probe (run once on request): both players drop to 0 HP on the same frame
  P.doubleKO = () => { const s = window.__ppState, v = window.__ppCoop && window.__ppCoop.p2; if (!s || !v) return 'no p2'; P.noGod = performance.now() / 1000 + 8; return import('./logic.js').then(L => { s.invuln = 0; v.invuln = 0; s.player.shield = false; v.player.shield = false; const a = L.damagePlayer(s, 9999), b = L.damagePlayer(v, 9999); P.dko = performance.now() / 1000; return { a, b, lives: s.lives, p2lives: v.lives }; }); };
  P.dieOnce = () => { P.noGod = performance.now() / 1000 + 25; P.passive = performance.now() / 1000 + 25; const s = window.__ppState; s.hp = 1; return 'set'; };
};

async function runOne(name) {
  const diff = name === 'coop' ? 'normal' : name, coopRun = name === 'coop';
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });
  const ctx = await browser.newContext({ viewport: { width: 740, height: 510 } });
  const errs = []; const log = m => console.log(`[${name}] ${m}`);
  const watch = page => {
    page.on('pageerror', e => errs.push({ kind: 'pageerror', text: String(e && e.stack || e).slice(0, 500) }));
    page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push({ kind: m.type(), text: m.text().slice(0, 300) }); });
    page.on('response', r => { if (r.status() >= 400) errs.push({ kind: 'http', text: `HTTP ${r.status()} ${r.url()}` }); });
  };
  await ctx.addInitScript(INIT, SPEED);
  let page = await ctx.newPage(); watch(page);
  const ev = (f, a) => page.evaluate(f, a);
  await page.goto(URL0 + '?coach=1'); await wait(1500);
  for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await wait(150); }
  await page.keyboard.press({ easy: 'KeyE', normal: 'KeyN', hard: 'KeyH' }[diff]); await wait(150);
  const heroKey = { easy: 'Digit2', normal: 'Digit3', hard: 'Digit6', coop: 'Digit1' }[name]; await page.keyboard.press(heroKey); await wait(150);
  if (coopRun) { await page.keyboard.press('NumpadEnter'); await wait(200); await page.keyboard.press('Numpad6'); await wait(150); await page.keyboard.press('NumpadEnter'); await wait(200); }
  await page.keyboard.press('Enter'); await wait(800);
  const t0 = Date.now(); let continued = false, dkoDone = false, dkoRes = null, dieDone = false, dieRes = null, endReason = 'timeout', lastLog = 0;
  const info0 = await ev(() => ({ diff: window.__ppState.difficulty, hero: window.__ppState.selectedHero, p2: !!(window.__ppCoop && window.__ppCoop.joined) }));
  log(`start ${JSON.stringify(info0)}`);
  while (Date.now() - t0 < RUN_MIN * 60000) {
    await wait(1000);
    let st;
    try { st = await ev(() => { const s = window.__ppState, P = window.__soak; return { level: s.level, wave: s.wave, over: s.over, done: !!s.runComplete, mode: window.__ppScreens.mode(), levels: P.levels.length, seq: P.levels.map(l => l.level), saved: window.__ppSave.has(), p2: !!(window.__ppCoop && window.__ppCoop.p2), x: Math.round(s.player.x) }; }); }
    catch (e) { errs.push({ kind: 'harness', text: 'evaluate failed: ' + e.message }); break; }
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log(`${((Date.now() - t0) / 60000).toFixed(1)} min level ${st.level} wave ${st.wave} x ${st.x} mode ${st.mode} seq ${st.seq.join(',')}`); }
    if (st.mode === 'ending' || st.mode === 'credits' || st.mode === 'scores' || (st.done && st.over)) { endReason = 'ending:' + st.mode; break; }
    if (st.over && st.mode == null && !st.done) { endReason = 'game over (no screen)'; break; }
    // co-op: the same-frame double KO, once, on the street
    if (coopRun && !dkoDone && st.p2 && st.wave >= 2 && st.mode == null) { dkoDone = true; const d0 = await ev(() => window.__soak.doubleKO()); await wait(6000);
      const r0 = await ev(() => ({ mode: window.__ppScreens.mode(), over: window.__ppState.over, hp: window.__ppState.hp, p2hp: window.__ppCoop.p2 && window.__ppCoop.p2.hp, lives: window.__ppState.lives }));
      const r = { ...r0, at: d0 }; dkoRes = r; log('double-KO probe -> ' + JSON.stringify(r)); }
    // hard: let the hero actually fall once on the street (no HP floor for 25 s) and see the run carry on
    if (name === 'hard' && !dieDone && st.wave >= 2 && st.mode == null) { dieDone = true; const l0 = await ev(() => window.__ppState.lives); await ev(() => window.__soak.dieOnce()); await wait(26000);
      dieRes = await ev(l0 => ({ livesBefore: l0, lives: window.__ppState.lives, modes: { ...window.__soak.modes }, over: window.__ppState.over, level: window.__ppState.level }), l0); log('die-once probe -> ' + JSON.stringify(dieRes)); }
    // CONTINUE: once the 4th level is under way and saved, reload the page and continue from the save
    if (!continued && st.levels >= 4 && st.saved && st.mode == null) {
      continued = true; const before = await ev(() => ({ soak: window.__soak, level: window.__ppState.level, wave: window.__ppState.wave, save: window.__ppSave.load() }));
      log(`reload + CONTINUE at level ${before.level} wave ${before.wave} (save wave ${before.save && before.save.wave})`);
      await page.close(); page = await ctx.newPage(); watch(page);
      await page.goto(URL0 + '?coach=1'); await wait(1500);
      await page.keyboard.press('KeyX'); await wait(600);
      for (let i = 0; i < 40 && !(await page.evaluate(() => window.__ppTitle && window.__ppTitle.ready && window.__ppTitle.ready())); i++) { await page.keyboard.press('Escape'); await wait(250); }
      await page.keyboard.press('Enter'); await wait(1500);
      for (let i = 0; i < 20 && await page.evaluate(() => !!(window.__ppSelect && window.__ppSelect.active)); i++) { await page.keyboard.press('Enter'); await wait(300); }
      if (coopRun) for (let i = 0; i < 3 && !(await page.evaluate(() => !!(window.__ppCoop && window.__ppCoop.p2))); i++) { await page.keyboard.press('NumpadEnter'); await wait(400); await page.keyboard.press('NumpadEnter'); await wait(400); }
      const after = await page.evaluate(() => ({ level: window.__ppState && window.__ppState.level, wave: window.__ppState && window.__ppState.wave, diff: window.__ppState && window.__ppState.difficulty, hero: window.__ppState && window.__ppState.selectedHero }));
      await page.evaluate(b => { const P = window.__soak; P.prev = { modes: b.modes, findings: b.findings, levels: b.levels, bossSpawn: b.bossSpawn, bossDie: b.bossDie, nudges: b.nudges, maxCounts: b.maxCounts, heap: b.heap }; P.cont = { from: { level: b.level, wave: b.wave, saveWave: b.save && b.save.wave }, to: null }; }, before.soak ? { ...before.soak, level: before.level, wave: before.wave, save: before.save } : {});
      await page.evaluate(a => { window.__soak.cont.to = a; }, after);
      log('continued -> ' + JSON.stringify(after));
      if (!(after.wave === (before.save && before.save.wave) && after.diff === diff)) errs.push({ kind: 'continue', text: `CONTINUE resumed ${JSON.stringify(after)} from save wave ${before.save && before.save.wave} (${diff})` });
    }
  }
  const P = await page.evaluate(() => window.__soak).catch(() => ({}));
  const pre = P.prev || { findings: [], levels: [], bossSpawn: 0, bossDie: 0, nudges: 0, maxCounts: {}, heap: [] };
  const findings = [...pre.findings, ...(P.findings || [])];
  const seq = [...pre.levels, ...(P.levels || [])].map(l => l.level).filter((v, i, a) => i === 0 || a[i - 1] !== v);
  const renderErr = await page.evaluate(() => window.__ppRenderErrors ? { count: window.__ppRenderErrors.count, by: window.__ppRenderErrors.by } : null).catch(() => null);
  const res = { name, diff, minutes: +((Date.now() - t0) / 60000).toFixed(1), endReason, seq, expected: LEVEL_ORDER, bossSpawn: pre.bossSpawn + (P.bossSpawn || 0), bossDie: pre.bossDie + (P.bossDie || 0),
    nudges: pre.nudges + (P.nudges || 0), findings, errors: errs, renderErr, cont: P.cont || null, dko: dkoRes, die: dieRes, modes: { ...(pre.modes || {}), ...(P.modes || {}) }, maxCounts: { ...pre.maxCounts, ...(P.maxCounts || {}) }, heap: [...pre.heap, ...(P.heap || [])] };
  await page.screenshot({ path: `/workspace/soak/${name}-final.png` }).catch(() => {});
  await browser.close();
  return res;
}
// Regression (soak finding): an arena edge inside a sewer crate pinned a straggler behind it for the whole lock.
{
  globalThis.window = globalThis.window || {};
  const E = await import(ROOT + 'events.js'); const { resolveWalkable } = await import(ROOT + 'collision.js');
  const s = { level: 0, hpMode: true, walkLevel: true, holdWave: true, player: { x: 517, y: 396, r: 16 }, ninjas: [{ kind: 'brawler', x: 313, y: 384, r: 18, hp: 2, dead: false }], powerups: [] };
  const e = E.ensureEvents(s); e.lock = { L: 445, R: 1185, t: 0, key: 'soak' }; e.cooldown = 99; const n = s.ninjas[0]; let t = 0;
  for (; t < 10 && n.x < 460; t += 1 / 120) { E.stepEvents(s, 1 / 120); const r = resolveWalkable(0, n.x, n.y, n.r); n.x = r.x; n.y = r.y; }
  console.log((n.x >= 460 ? 'PASS' : 'FAIL') + ` a straggler pinned behind the sewer crate walks into the arena (x ${Math.round(n.x)} after ${t.toFixed(1)} s)`); if (n.x < 460) process.exitCode = 1;
}
// In the suite loop (no run names, 300 s budget) only the regression above runs; the browser soak is ~10 min.
if (!argv.some(a => /^(easy|normal|hard|coop)/.test(a))) { console.log('soak skipped: pass easy,normal,hard,coop (about 10 min, runs in parallel) to play the campaign'); server.close(); process.exit(process.exitCode ? 1 : 0); }
fs.mkdirSync('/workspace/soak', { recursive: true });
const results = await Promise.all(RUNS.map(runOne));
server.close();
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
for (const r of results) {
  console.log(`\n== ${r.name} (${r.diff}) ${r.minutes} min, end: ${r.endReason}; levels ${r.seq.join(',')}; boss spawn/die ${r.bossSpawn}/${r.bossDie}; nudges ${r.nudges}; heap MB ${r.heap.length ? r.heap[0][1] + ' -> ' + r.heap[r.heap.length - 1][1] : '-'}`);
  for (const f of r.findings.slice(0, 30)) console.log(`   finding [${f.type}] L${f.level} w${f.wave}: ${f.msg}${f.live ? ' ' + JSON.stringify(f.live) : ''}${f.lock ? ' lock ' + JSON.stringify(f.lock) : ''}${f.combat ? ' p1 ' + JSON.stringify(f.combat) : ''}`);
  const uniq = [...new Set(r.errors.map(e => e.kind + ': ' + e.text))];
  for (const e of uniq.slice(0, 20)) console.log('   error ' + e);
  ok(r.errors.filter(e => e.kind !== 'warning').length === 0, `${r.name}: 0 console/page/http errors (${r.errors.filter(e => e.kind !== 'warning').length})`);
  ok(r.errors.filter(e => e.kind === 'warning').length === 0, `${r.name}: 0 console warnings (${r.errors.filter(e => e.kind === 'warning').length})`);
  ok(!r.renderErr || r.renderErr.count === 0, `${r.name}: 0 errors caught inside the frame (${r.renderErr ? r.renderErr.count + ' ' + JSON.stringify(r.renderErr.by) : '-'})`);
  ok(JSON.stringify(r.seq) === JSON.stringify(LEVEL_ORDER), `${r.name}: every stage transition fired in order (${r.seq.join(',')} vs ${LEVEL_ORDER.join(',')})`);
  ok(r.bossSpawn >= 1 && r.bossDie >= 1 && /^ending/.test(r.endReason), `${r.name}: final boss spawned and died, ending reached (${r.bossSpawn}/${r.bossDie}, ${r.endReason})`);
  ok(r.findings.filter(f => f.type === 'softlock').length === 0, `${r.name}: no softlocks (${r.findings.filter(f => f.type === 'softlock').length})`);
  ok(r.findings.filter(f => f.type === 'stuck' || f.type === 'nan').length === 0, `${r.name}: no stuck / NaN enemies (${r.findings.filter(f => f.type === 'stuck' || f.type === 'nan').length})`);
  ok(r.cont && r.cont.to && r.cont.to.wave === r.cont.from.saveWave, `${r.name}: reload + CONTINUE resumed the saved stage (${r.cont ? JSON.stringify(r.cont) : 'not reached'})`);
  ok(['clear', 'bonus', 'shop', 'wipe', 'coach'].every(m => r.modes[m]), `${r.name}: stage-clear, bonus, shop, wipe and coach all played (${Object.keys(r.modes).join(',')})`);
  if (r.name === 'hard') ok(r.die && r.die.lives < r.die.livesBefore && !r.die.over, `hard: a real KO costs a life and the run carries on (${JSON.stringify(r.die)})`);
  if (r.name === 'coop') ok(r.dko && (r.dko.mode != null || r.dko.hp > 0 || r.dko.p2hp > 0), `coop: same-frame double KO (both through damagePlayer on one frame) does not softlock (${JSON.stringify(r.dko)})`);
}
if (process.exitCode) fails++; console.log(fails ? `\n${fails} FAILED` : "\nALL PASS"); process.exit(fails ? 1 : 0);
