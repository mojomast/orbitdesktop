// Camera smoothness (baba_booey, t_9ec48322f6de4bf7). logic.js now follows with a critically damped spring
// (CAMERA_SPRING), a capped speed (CAMERA_MAX_SPEED) and framing targets (event cams, arena locks, the co-op
// midpoint) blended in over ~1/CAMERA_FRAME_BLEND s; game.js renders s.cameraX directly.
// Headless real-play drive with the game's own modules in game.js simStep order (P1 walk + combat, coop.step,
// events, world update, coop.after), sampled once per 60 Hz frame: spawns + fighting, a death, an arena lock and
// its release, scripted event cams, then local co-op with the players pulling apart and swapping sides.
// FAIL if any frame-to-frame camera delta differs from the expected scroll (the previous frame's delta, i.e.
// steady scrolling) by more than JERK px, if acceleration spikes above ACC_MAX, if the camera leaves the level
// edges, or if the speed cap is exceeded. The skate auto-scroll level is not touched (checked for identity).
// usage: node check-camera-smooth.mjs
import assert from 'node:assert/strict';
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
const G = new URL('../pizza-panic/', import.meta.url);
const L = await import(new URL('logic.js', G).href);
const E = await import(new URL('events.js', G).href);
const C = await import(new URL('combat.js', G).href);
const { WORLD_W } = await import(new URL('collision.js', G).href);
const CO = await import(new URL('coop.js', G).href);
let pass = 0, total = 0;
const t = async (name, fn) => { total++; try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); } };
const DT = 1 / 120, FRAME = 1 / 60;
const JERK = 4;            // px: max frame delta beyond the expected (steady) scroll
const ACC_MAX = 16000;     // px/s^2: no acceleration spikes (a 4 px/frame^2 change at 60 Hz is 14400)
const W = L.W, MAXX = WORLD_W - L.W;
function seeded(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }
const fresh = (hero = 'turtle_blue', level = 0) => { const s = L.createState(); s.hpMode = true; s.selectedHero = hero; if (level) L.startLevel ? L.startLevel(s, level) : (s.level = level); C.createCombat(s); E.ensureEvents(s); L.spawnWave(s); return s; };
function tick(s, coop, p1 = {}, p2) {
  C.combatWalk(s, p1.dx || 0, p1.dy || 0, DT); C.combatStep(s, DT);
  if (coop) { if (p2 && coop.p2) coop.input && coop.input(p2); coop.step(s, DT); }
  if (s.events) E.stepEvents(s, DT); L.update(s, DT);
  if (coop) coop.after(s, DT);
}
// one recorder per run: frames sampled every 2 ticks
function recorder() {
  const cams = [], tags = [];
  return { cams, tags, sample(s, tag) { cams.push(s.cameraX); tags.push(tag); } };
}
function analyse(rec, label) {
  const c = rec.cams; let worst = { jerk: 0, i: 0 }, acc = 0, v = 0, out = 0;
  for (let i = 2; i < c.length; i++) {
    const d1 = c[i] - c[i - 1], d0 = c[i - 1] - c[i - 2];
    const j = Math.abs(d1 - d0); if (j > worst.jerk) worst = { jerk: j, i };
    acc = Math.max(acc, j / (FRAME * FRAME)); v = Math.max(v, Math.abs(d1) / FRAME);
  }
  for (const x of c) if (!(x >= -0.01 && x <= MAXX + 0.01)) out++;
  return { label, frames: c.length, jerk: +worst.jerk.toFixed(2), at: rec.tags[worst.i], acc: Math.round(acc), vmax: Math.round(v), out };
}
const check = r => {
  console.log('  ', JSON.stringify(r));
  assert.equal(r.out, 0, `${r.label}: camera left the level edges ${r.out}x`);
  assert.ok(r.jerk <= JERK, `${r.label}: frame delta ${r.jerk} px beyond the expected scroll (> ${JERK}) at ${r.at}`);
  assert.ok(r.acc <= ACC_MAX, `${r.label}: acceleration spike ${r.acc} px/s^2 at ${r.at}`);
  assert.ok(r.vmax <= L.CAMERA_MAX_SPEED + 1, `${r.label}: speed ${r.vmax} > cap ${L.CAMERA_MAX_SPEED}`);
};
const calm = s => { s.events.cooldown = 1e9; s.events.lock = null; s.events.camX = null; }; // no more triggers (free roam)
const killAll = s => { for (const n of s.ninjas) { n.hp = 0; } s.ninjas.length = 0; };
const seen = { lock: 0, release: 0, spawns: 0, deaths: 0, eventCam: 0 };

await t('solo real play on level 1: walking, fighting, spawns, a death, event cams, an arena lock and its release', () => {
  const save = Math.random; Math.random = seeded(11);
  try {
    const s = fresh('turtle_blue'), rec = recorder();
    let lastN = s.ninjas.length, wasLock = false, died = false;
    for (let i = 0; i < 120 * 150; i++) {
      const lock = s.events && s.events.lock;
      if (lock && !wasLock) seen.lock++;
      if (!lock && wasLock) seen.release++;
      wasLock = !!lock;
      if (s.events && s.events.camX != null && !lock) seen.eventCam++;
      // fight inside a lock for a few seconds, then clear the arena (releases the lock -> camera pans on)
      if (lock && lock.t > 4) killAll(s);
      if (s.ninjas.length > lastN) seen.spawns++; lastN = s.ninjas.length;
      if (!died && i === 120 * 25) { s.hp = 0; died = true; seen.deaths++; }
      if (s.over) break;
      if (i % 40 === 0) C.combatPress(s, i % 120 === 0 ? 'kick' : 'punch');
      const dx = (i % 1500) < 1150 ? 1 : (i % 1500) < 1300 ? -1 : 0;   // mostly right, with back-steps
      tick(s, null, { dx, dy: Math.sin(i / 90) * 0.4 });
      if (i % 2 === 1) rec.sample(s, `t=${(i * DT).toFixed(2)}s x=${Math.round(s.player.x)}${lock ? ' lock' : ''}`);
    }
    check(analyse(rec, 'solo'));
    assert.ok(seen.lock >= 1 && seen.release >= 1, 'drive went through an arena lock and release ' + JSON.stringify(seen));
    assert.ok(seen.spawns >= 3, 'enemies spawned during the drive ' + JSON.stringify(seen));
    assert.ok(rec.cams[rec.cams.length - 1] > 1500, 'camera travelled with the hero (' + Math.round(rec.cams[rec.cams.length - 1]) + ')');
  } finally { Math.random = save; }
});

await t('local co-op: the midpoint target is smoothed (players separate, cross over, P2 joins and drops out)', () => {
  const save = Math.random; Math.random = seeded(5);
  try {
    const s = fresh('turtle_blue'), coop = CO.createCoop({ rand: () => 0.5 }), rec = recorder();
    coop.step(s, DT);
    let v = null;
    for (let i = 0; i < 120 * 60; i++) {
      if (i === 120 * 2) v = coop.join(s, 'turtle_red');
      if (s.events && s.events.lock && s.events.lock.t > 3) killAll(s);
      const ph = Math.floor(i / 480) % 4;
      const p1dx = ph === 0 ? 1 : ph === 1 ? 0 : ph === 2 ? 1 : -0.5;
      if (v && v.player) { // P2: run away from P1, then back past him
        const dir = ph === 1 ? 1 : ph === 3 ? 1 : ph === 2 ? -1 : 0.5;
        v.player.x = Math.max(0, Math.min(WORLD_W, v.player.x + dir * 190 * DT));
      }
      if (i % 50 === 0) C.combatPress(s, 'punch');
      tick(s, coop, { dx: p1dx });
      if (i % 2 === 1) rec.sample(s, `t=${(i * DT).toFixed(2)}s p1=${Math.round(s.player.x)} p2=${v && v.player ? Math.round(v.player.x) : '-'}`);
    }
    assert.ok(v, 'P2 joined');
    check(analyse(rec, 'coop'));
  } finally { Math.random = save; }
});

await t('framing target step (a scripted event cam / lock 400 px away) eases in instead of snapping', () => {
  const s = fresh('turtle_blue'), rec = recorder();
  for (let i = 0; i < 120; i++) { tick(s, null, {}); }
  const c0 = s.cameraX; s.events.camX = c0 + W / 2 + 400; s.events.camT = 3;
  for (let i = 0; i < 120 * 3; i++) { tick(s, null, {}); if (i % 2 === 1) rec.sample(s, `t=${(i * DT).toFixed(2)}s`); }
  const r = analyse(rec, 'step'); check(r);
  assert.ok(Math.abs(rec.cams[0] - c0) < 20, 'first frame did not jump (' + (rec.cams[0] - c0).toFixed(1) + ' px)');
  assert.ok(Math.abs(s.cameraX - Math.min(MAXX, c0 + 400)) < 40, 'reached the framing target (' + Math.round(s.cameraX - c0) + ' of 400)');
});

await t('edges: driving into both level ends keeps the camera clamped with no bounce', () => {
  const s = fresh('turtle_blue'), rec = recorder(); calm(s);
  for (let i = 0; i < 120 * 6; i++) { tick(s, null, { dx: -1 }); if (i % 2) rec.sample(s, 'left'); }
  assert.equal(Math.min(...rec.cams), Math.max(0, Math.min(...rec.cams)));
  s.player.x = WORLD_W - 900; killAll(s); calm(s);
  const r2 = recorder();
  for (let i = 0; i < 120 * 6; i++) { tick(s, null, { dx: 1 }); s.events.lock = null; if (i % 2) r2.sample(s, 'right'); }
  const tail = r2.cams.slice(-120);
  assert.ok(tail.every(x => x <= MAXX + 0.01 && x >= MAXX - 1), 'settled on the right edge: ' + Math.round(tail[0]) + '..' + Math.round(tail[tail.length - 1]) + ' / ' + MAXX);
  assert.ok(r2.cams.every(x => x <= MAXX + 0.01), 'never past the right edge');
});

await t('a teleport (respawn / checkpoint / level start) cuts instead of crawling at the speed cap', () => {
  const s = fresh('turtle_blue');
  calm(s); for (let i = 0; i < 60; i++) tick(s, null, {});
  s.player.x = 3000; killAll(s); calm(s);
  tick(s, null, {}); tick(s, null, {});
  assert.ok(Math.abs(s.cameraX - Math.max(0, Math.min(MAXX, 3000 - W / 2))) < W * 0.25, 'camera cut to the hero (' + Math.round(s.cameraX) + ')');
});

await t('auto-scroll levels are untouched: the spring / framing code never runs there', async () => {
  const levels = L.LEVELS;
  assert.ok(Array.isArray(levels), 'LEVELS table found');
  const auto = levels.map((l, i) => (l && l.auto ? i : -1)).filter(i => i >= 0);
  assert.ok(auto.length >= 1, 'at least one auto-scroll level');
  for (const lv of auto) {
    const s = L.createState(); s.hpMode = true; s.selectedHero = 'turtle_blue'; C.createCombat(s); E.ensureEvents(s);
    const cam0 = s.cameraX;
    for (let i = 0; i < 240; i++) { s.level = lv; L.update(s, DT); }   // world update only (skate.js owns that level's scroll)
    assert.equal(s.cameraX, cam0, 'logic.js did not move the camera on auto level ' + lv);
    assert.equal(s.__cam, undefined, 'no spring state on auto level ' + lv); assert.equal(s.__camFrame, undefined, 'no framing state on auto level ' + lv);
  }
});

await t('game.js renders the smoothed s.cameraX (the event-cam snap is only a fallback before the first camera frame)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('game.js', G), 'utf8');
  const line = src.split('\n').find(l => /camX = skating \?/.test(l)) || '';
  const iCam = line.indexOf('Number.isFinite(s.cameraX)'), iEv = line.indexOf('eventCam != null');
  assert.ok(iCam > 0 && (iEv < 0 || iCam < iEv), 'render camera prefers s.cameraX over eventCam: ' + line.trim().slice(0, 140));
});

console.log(`\n${pass}/${total} camera-smooth checks passed`, JSON.stringify(seen));
process.exit(pass === total ? 0 : 1);
