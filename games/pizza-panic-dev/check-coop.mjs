// Local 2-player co-op checks (cheese, t_3a33c55607144558): join, separate input,
// shared camera bounds, enemies split between both players, P2 death / continue /
// revive, no friendly fire, co-op enemy scaling, pad 2 routing, and a
// single-player regression (a seeded run is bit-identical with the co-op module
// stepping but nobody joined). Then a headless browser run: P2 joins on the select
// screen (numpad) and mid-level, fights next to P1, 0 console errors, screenshots.
// usage: node check-coop.mjs [url] [shotdir]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
const G = new URL('../pizza-panic/', import.meta.url);
const L = await import(new URL('logic.js', G).href);
const E = await import(new URL('events.js', G).href);
const C = await import(new URL('combat.js', G).href);
const H = await import(new URL('heroes.js', G).href);
const GP = await import(new URL('gamepad.js', G).href);
const CO = await import(new URL('coop.js', G).href);
const B = await import(new URL('boss.js', G).href);
const X = await import(new URL('enemies-ext.js', G).href);
const SW = await import(new URL('subway.js', G).href);
const HD = await import(new URL('harbor-data.js', G).href);
const SD = await import(new URL('subway-data.js', G).href);
let pass = 0, total = 0;
const t = async (name, fn) => { total++; try { await fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); } };
const DT = 1 / 120;
function seeded(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }
const fresh = (hero = 'turtle_blue') => { const s = L.createState(); s.hpMode = true; s.selectedHero = hero; C.createCombat(s); E.ensureEvents(s); L.spawnWave(s); return s; };
const mk = (o = {}) => CO.createCoop({ rand: () => 0.5, ...o });
// game.js simStep order: P1 walk + combatStep, coop.step, events, world update, coop.after.
function tick(s, coop, p1 = {}) {
  C.combatWalk(s, p1.dx || 0, p1.dy || 0, DT); C.combatStep(s, DT);
  if (coop) coop.step(s, DT);
  if (s.events) E.stepEvents(s, DT); L.update(s, DT);
  if (coop) coop.after(s, DT);
}
const snapOf = s => JSON.stringify({ p: s.player, hp: s.hp, lives: s.lives, score: s.score, wave: s.wave, cam: s.cameraX, n: s.ninjas.map(n => [n.kind, +n.x.toFixed(3), +n.y.toFixed(3), n.hp, !!n.token]), log: s.events.log.length, c: [s.combat.phase, s.combat.chain, s.combat.facing] });

await t('single player is unchanged: a seeded 20 s run is identical with coop.js stepping and nobody joined', () => {
  const run = withCoop => {
    const save = Math.random; Math.random = seeded(7);
    try {
      const s = fresh(), coop = withCoop ? mk() : null;
      for (let i = 0; i < 120 * 20; i++) { if (i % 50 === 0) C.combatPress(s, 'punch'); tick(s, coop, { dx: i % 600 < 420 ? 1 : 0 }); }
      assert.equal(s.coopFilter, undefined, 'no co-op filter on the state'); assert.ok(s.ninjas.every(n => n.coopT === undefined), 'no enemy carries a co-op target');
      return snapOf(s);
    } finally { Math.random = save; }
  };
  const a = run(false), b = run(true); assert.equal(a, b);
});
await t('join: P2 gets a different hero and its own body, HP, lives and score; the world is shared', () => {
  const s = fresh('turtle_blue'), coop = mk(); coop.step(s, DT);
  const before = JSON.stringify({ p: s.player, hp: s.hp, lives: s.lives, score: s.score });
  const v = coop.join(s, 'turtle_blue');
  assert.ok(v && v.selectedHero !== s.selectedHero, 'P2 hero ' + v.selectedHero);
  assert.notEqual(v.player, s.player); assert.equal(v.ninjas, s.ninjas); assert.equal(v.level, s.level);
  assert.deepEqual([v.hp, v.lives, v.score, v.over], [100, 3, 0, false]);
  assert.equal(JSON.stringify({ p: s.player, hp: s.hp, lives: s.lives, score: s.score }), before, 'P1 untouched');
  const v2 = mk().join(fresh('turtle_red'), 'turtle_purple'); assert.equal(v2.selectedHero, 'turtle_purple');
  assert.ok(Object.values(CO.P2_KEYS).every(k => /^Numpad/.test(k)), 'P2 keys are all on the numpad');
});
await t('separate input: P2 numpad moves/attacks only P2, P1 keys only P1', () => {
  const s = fresh(), coop = mk(); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0;
  for (let i = 0; i < 30; i++) tick(s, coop);
  const x1 = s.player.x, x2 = v.player.x;
  coop.keys[CO.P2_KEYS.right] = true; for (let i = 0; i < 60; i++) tick(s, coop); coop.keys[CO.P2_KEYS.right] = false;
  assert.ok(v.player.x > x2 + 40, 'P2 moved ' + (v.player.x - x2)); assert.equal(s.player.x, x1, 'P1 did not move');
  coop.onPress('punch'); assert.ok(v.combat.attack, 'P2 attacking'); assert.equal(s.combat.attack, null, 'P1 not attacking');
  for (let i = 0; i < 90; i++) tick(s, coop);
  const y2 = v.player.x; C.combatPress(s, 'kick'); assert.ok(s.combat.attack && !v.combat.attack, 'P1 kick is P1 only');
  for (let i = 0; i < 40; i++) tick(s, coop, { dx: 1 }); assert.equal(v.player.x, y2, 'P2 stays while P1 walks');
});
await t('camera: framed on both players, the leader is held at the screen edge', () => {
  const s = fresh(), coop = mk(); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0;
  coop.keys[CO.P2_KEYS.right] = true; for (let i = 0; i < 120 * 5; i++) tick(s, coop); coop.keys[CO.P2_KEYS.right] = false;
  const cam = s.cameraX, M = CO.COOP.margin;
  for (const p of [s.player, v.player]) assert.ok(p.x >= cam + M - 0.01 && p.x <= cam + L.W - M + 0.01, `x ${p.x.toFixed(0)} in [${cam + M}, ${cam + L.W - M}]`);
  assert.ok(v.player.x - s.player.x <= L.W - 2 * M + 0.01 && v.player.x - s.player.x > 300, 'spread ' + (v.player.x - s.player.x).toFixed(0));
  // Walk P1 up to P2: the camera follows the midpoint. On the way P1 crosses the sewer
  // doorBurst beat (x 300, cam 620): its arena lock / camera hold wins, with both players kept on
  // that screen (baba_booey, t_5668d3686e95414f: this used to pass only because logic.js
  // centred s.cameraX on P1, which the dead-zone no longer does).
  let held = 0;
  for (let i = 0; i < 120 * 3; i++) {
    tick(s, coop, { dx: 1 });
    const e = s.events; if (e.camX == null) continue;
    held++; const hc = Math.max(0, e.camX - L.W / 2);
    // baba_booey (t_9ec48322f6de4bf7): the hold used to SNAP the camera (|cam - hold| < 0.01 on the first held
    // frame). The spring camera blends a framing target in, so the hold must win once it has been held ~1.5 s,
    // and both players stay on the screen actually shown (s.cameraX) the whole time.
    if (held > 180) assert.ok(Math.abs(s.cameraX - hc) < 2, `scripted hold wins (cam ${s.cameraX.toFixed(0)} vs hold ${hc})`);
    const sc = s.cameraX;
    for (const p of [s.player, v.player]) assert.ok(p.x >= sc + M - 0.01 && p.x <= sc + L.W - M + 0.01, `on the shown screen: x ${p.x.toFixed(0)}`);
  }
  assert.ok(held > 60, 'the walk crosses the doorBurst camera hold (' + held + ' frames)');
  s.ninjas.length = 0; // clear the doorBurst wave: the lock lifts, then the camera hold times out
  for (let i = 0; i < 120 * 4 && s.events.camX != null; i++) tick(s, coop);
  assert.ok(s.events.camX == null && !s.events.lock, 'hold released');
  let maxStep = 0, last = s.cameraX;
  for (let i = 0; i < 120; i++) { tick(s, coop); maxStep = Math.max(maxStep, Math.abs(s.cameraX - last)); last = s.cameraX; }
  const mid = (s.player.x + v.player.x) / 2; assert.ok(Math.abs(s.cameraX + L.W / 2 - mid) < 8, `centred on the midpoint once the hold ends (cam ${s.cameraX.toFixed(0)}, mid ${mid.toFixed(0)})`);
  assert.ok(maxStep < 20, 'eases off the hold instead of jumping (max ' + maxStep.toFixed(1) + ' px/frame)');
});
await t('enemies split between the players (nearest / least targeted, own token pools) and both get hit', () => {
  const save = Math.random; Math.random = seeded(3);
  try {
    const s = fresh(), coop = mk(); coop.step(s, DT); const v = coop.join(s);
    s.ninjas.length = 0; s.events = null; // no scripted beats in this one
    s.player.x = 250; v.player.x = 640; v.player.y = s.player.y;
    for (const [x, k] of [[220, 'brawler'], [380, 'brawler'], [560, 'brawler'], [720, 'brawler'], [760, 'striker']]) s.ninjas.push({ kind: k, level: s.level, x, y: s.player.y + 4, r: 17, hp: 99, maxHp: 99, vx: 0, vy: 0 });
    let both = false;
    for (let i = 0; i < 120 * 12; i++) { s.invuln = Math.min(s.invuln, 0.2); v.invuln = Math.min(v.invuln, 0.2); tick(s, coop); s.hp = Math.max(s.hp, 60); v.hp = Math.max(v.hp, 60); if (s.hpHit > 0 && v.hpHit > 0) both = true; }
    const by = { 1: 0, 2: 0 }; for (const n of s.ninjas) by[n.coopT]++;
    assert.ok(by[1] >= 1 && by[2] >= 1, `targets ${JSON.stringify(by)}`);
    assert.ok(Math.abs(by[1] - by[2]) <= 2, 'balanced');
    assert.ok(both, `both players were hit (P1 ${s.hpHit}, P2 ${v.hpHit})`);
    assert.ok(s.ninjas.filter(n => n.token && n.coopT === 2).length <= C.maxTokens(s), 'P2 token pool capped');
  } finally { Math.random = save; }
});
await t('no friendly fire: P1 and P2 attacks never damage each other', () => {
  const s = fresh(), coop = mk(); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0;
  v.player.x = s.player.x + 30; v.player.y = s.player.y; v.invuln = 0; s.invuln = 0;
  for (let i = 0; i < 120 * 3; i++) { if (i % 30 === 0) { C.combatPress(s, i % 60 ? 'kick' : 'punch'); coop.onPress('punch'); } tick(s, coop); }
  assert.deepEqual([s.hp, v.hp], [100, 100]); assert.equal(v.hpHit, 0);
});
await t('P2 death: P1 plays on; continue brings P2 back; P1 standing close revives', () => {
  const s = fresh(), coop = mk(); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0;
  for (let k = 0; k < 3; k++) { v.invuln = 0; L.damagePlayer(v, 500); }
  assert.ok(v.over && !s.over, 'P2 out, game not over'); assert.equal(s.lives, 3); assert.equal(v.lives, 0);
  for (let i = 0; i < 60; i++) tick(s, coop); assert.ok(coop.continueLeft < CO.COOP.continueT);
  assert.ok(coop.continueP2(s)); assert.deepEqual([v.over, v.lives, v.hp], [false, 3, 100]);
  for (let k = 0; k < 3; k++) { v.invuln = 0; L.damagePlayer(v, 500); } assert.ok(v.over);
  s.player.x = v.player.x + 10; s.player.y = v.player.y;
  for (let i = 0; i < 120 * 2; i++) tick(s, coop);
  assert.ok(!v.over && v.lives === 1 && v.hp === 50, `revived (over ${v.over}, lives ${v.lives}, hp ${v.hp})`);
  assert.deepEqual(coop.stats().continues + coop.stats().revives, 2);
  // Start (numpad Enter) also continues.
  for (let k = 0; k < 2; k++) { v.invuln = 0; L.damagePlayer(v, 500); } assert.ok(v.over); coop.onPress('start'); assert.ok(!v.over);
});
await t('co-op scales the crowd: event spawns get extra enemies only when P2 is in', () => {
  const run = join => { const save = Math.random; Math.random = seeded(11); try {
    const s = fresh(), coop = mk(); coop.step(s, DT); if (join) coop.join(s);
    let peak = 0; for (let i = 0; i < 120 * 10; i++) { tick(s, coop, { dx: 1 }); s.hp = 100; peak = Math.max(peak, s.ninjas.length); }
    return { peak, extras: coop.stats().extras };
  } finally { Math.random = save; } };
  const solo = run(false), duo = run(true);
  assert.equal(solo.extras, 0); assert.ok(duo.extras >= 1 && duo.peak > solo.peak, JSON.stringify({ solo, duo }));
});
await t('gamepad: with two pads, pad 1 drives P1 keys and pad 2 is handed to coop.js; one pad is unchanged', () => {
  const btn = on => Array.from({ length: 17 }, (_, i) => ({ pressed: on.includes(i), value: on.includes(i) ? 1 : 0 }));
  const padA = { connected: true, buttons: btn([]), axes: [0, 0] }, padB = { connected: true, buttons: btn([2]), axes: [1, 0] };
  const ev = []; const g = GP.createGamepad({ getPads: () => [padA, padB], emit: (ty, c) => ev.push(ty + ':' + c) });
  g.poll(1 / 60, 'play'); g.poll(1 / 60, 'play');
  assert.deepEqual(ev, [], 'pad 2 sends no P1 keys'); assert.ok(g.pad2 && g.pad2.buttons[2] && g.pad2.dirs.right, 'pad2 read');
  const ev1 = []; const g1 = GP.createGamepad({ getPads: () => [null, padB], emit: (ty, c) => ev1.push(ty + ':' + c) });
  g1.poll(1 / 60, 'play'); assert.ok(ev1.includes('keydown:KeyJ') && ev1.includes('keydown:ArrowRight'), 'a single pad (any slot) is still P1'); assert.equal(g1.pad2, null);
  // coop.js reads pad 2: X punches, Start continues.
  const s = fresh(), st = { buttons: [], dirs: {} }, coop = mk({ pad2: () => st }); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0;
  st.buttons = [false, false, true]; tick(s, coop); assert.ok(v.combat.attack, 'pad 2 X punched');
});

// ---- finish pass: bosses / new enemy types / hazards / pickups / pizzas / continues / skate / HUD
function bossFight(level = 0) {
  const s = L.createState(); s.hpMode = true; s.level = level; s.wave = L.LEVEL_ORDER.indexOf(level) + 1; s.selectedHero = 'turtle_blue';
  C.createCombat(s); E.ensureEvents(s); s.walkLevel = true; s.holdWave = true;
  const gate = E.TRIGGERS.filter(x => x.level === level).pop();
  for (const tr of E.TRIGGERS.filter(x => x.level === level && x !== gate)) s.events.fired[tr.level + ':' + tr.x] = true;
  s.player.x = gate.x + 5; s.player.y = L.LEVELS[level].walkables[0].y + 40; E.stepEvents(s, DT);
  s.ninjas = s.ninjas.filter(n => n.levelBoss); return s;
}
function tick2(s, coop, sys) {
  C.combatWalk(s, 0, 0, DT); C.combatStep(s, DT); if (coop) coop.step(s, DT);
  if (s.events) E.stepEvents(s, DT); L.update(s, DT);
  if (sys.bosses) (coop ? coop.as(s, 'boss', () => sys.bosses.step(s, DT)) : sys.bosses.step(s, DT));
  if (sys.ext) (coop ? coop.as(s, 'ext', () => sys.ext.step(s, DT)) : sys.ext.step(s, DT));
  if (coop) coop.after(s, DT);
}
await t('single player is unchanged with bosses + new enemy types routed through coop.as (seeded, nobody joined)', () => {
  const run = withCoop => { const save = Math.random; Math.random = seeded(21); try {
    const s = bossFight(0), coop = withCoop ? mk() : null, sys = { bosses: B.createBosses({ rand: seeded(4) }), ext: X.createEnemiesExt({ rand: seeded(5) }) };
    sys.ext.spawn(s, 'clawninja', s.player.x + 120, s.player.y);
    for (let i = 0; i < 120 * 12; i++) { if (i % 40 === 0) C.combatPress(s, 'punch'); tick2(s, coop, sys); }
    return snapOf(s) + JSON.stringify(s.ninjas.map(n => [n.hp, n.state || n.xs && n.xs.atk && n.xs.atk.id]));
  } finally { Math.random = save; } };
  assert.equal(run(false), run(true));
});
await t('bosses fight the nearer valid player: P2 next to the boss gets attacked, P1 far away does not', () => {
  const save = Math.random; Math.random = seeded(9);
  try {
    const s = bossFight(0), coop = mk(), sys = { bosses: B.createBosses({ rand: seeded(4) }) }; coop.step(s, DT); const v = coop.join(s);
    const boss = s.ninjas.find(n => n.levelBoss); assert.ok(boss, 'boss up');
    v.player.x = boss.x - 40; v.player.y = boss.y; s.player.x = Math.max(30, boss.x - 520);
    for (let i = 0; i < 120 * 10; i++) { tick2(s, coop, sys); v.hp = Math.max(v.hp, 60); s.player.x = Math.max(s.cameraX + 30, Math.min(s.player.x, boss.x - 420)); }
    assert.equal(coop.targetFor(s, 'boss'), 2, 'boss targets P2'); assert.ok(v.hpHit > 0, 'P2 was hit by the boss (' + v.hpHit + ')');
    assert.equal(s.hpHit || 0, 0, 'P1 far away untouched');
    for (let k = 0; k < 5; k++) { v.invuln = 0; L.damagePlayer(v, 999); } assert.ok(v.over);
    assert.equal(coop.targetFor(s, 'boss'), 1, 'P2 out: boss goes back to P1');
  } finally { Math.random = save; }
});
await t('claw ninja / shield brute / flamethrower bot attack P2 when P2 is the nearer player', () => {
  for (const type of ['clawninja', 'shieldbrute', 'flamebot']) {
    const save = Math.random; Math.random = seeded(13);
    try {
      const s = fresh(), coop = mk(), sys = { ext: X.createEnemiesExt({ rand: seeded(6) }) }; coop.step(s, DT); const v = coop.join(s);
      s.ninjas.length = 0; s.events = null; s.player.x = 120; v.player.x = 560; v.player.y = s.player.y;
      sys.ext.spawn(s, type, 620, v.player.y);
      for (let i = 0; i < 120 * 10; i++) { tick2(s, coop, sys); v.hp = Math.max(v.hp, 60); v.invuln = Math.min(v.invuln, 0.3); s.player.x = 120; }
      assert.ok(v.hpHit > 0, type + ' hit P2 (' + v.hpHit + ')'); assert.equal(s.hpHit || 0, 0, type + ' left far P1 alone');
    } finally { Math.random = save; }
  }
});
await t('subway signals and harbor crane drops hit whichever player overlaps (P2 can jump/duck them)', () => {
  const s = fresh(), coop = mk(); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0; s.events = null;
  s.level = SD.SUBWAY_LEVEL_INDEX; v.invuln = 0; s.subway = { hz: [{ kind: 'high', x: v.player.x + 5, warn: 0 }] };
  coop.after(s, DT); assert.equal(v.hp, 100 - SW.HAZARD.dmg, 'high signal hit standing P2'); assert.ok(s.subway.hz[0].hitP2);
  v.invuln = 0; v.player.duck = true; s.subway.hz.push({ kind: 'high', x: v.player.x, warn: 0 }); coop.after(s, DT); assert.equal(v.hp, 100 - SW.HAZARD.dmg, 'ducking P2 clears it');
  v.invuln = 0; v.player.duck = false; v.player.z = 30; s.subway.hz.push({ kind: 'low', x: v.player.x, warn: 0 }); coop.after(s, DT); assert.equal(v.hp, 100 - SW.HAZARD.dmg, 'jumping P2 clears a low one');
  v.player.z = 0; s.level = HD.HARBOR_LEVEL_INDEX; s.subway = null; v.invuln = 0;
  s.harbor = { drops: [{ cx: v.player.x, x: v.player.x + 4, y: v.player.y, t: 0, landed: true }, { x: v.player.x + 400, y: v.player.y, landed: true }] };
  coop.after(s, DT); assert.equal(v.hp, 100 - SW.HAZARD.dmg - HD.CRANE.dmg, 'crane drop on P2'); assert.ok(s.harbor.drops[0].hitP2 && !s.harbor.drops[1].hitP2);
  assert.equal(s.hp, 100, 'P1 untouched');
});
await t('breakable drops go to whoever collects them; P2 pizzas and kills score for P2', () => {
  const list = []; const s = fresh(), coop = mk({ breakables: { get pickups() { return list; } } }); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0; s.events = null;
  v.hp = 50; list.push({ type: 'pizza', x: v.player.x + 5, y: v.player.y, z: 0, t: 1 }, { type: 'ruby', x: v.player.x - 5, y: v.player.y + 4, z: 0, t: 1 }, { type: 'emerald', x: s.player.x + 300, y: s.player.y, z: 0, t: 1 });
  coop.after(s, DT);
  assert.equal(v.hp, 85, 'P2 healed'); assert.equal(v.score, 1000, 'ruby to P2'); assert.equal(s.score, 0, 'P1 score untouched'); assert.ok(!list[2].got, 'far pickup left');
  v.combat.facing = 1; s.player.x = 100; v.player.x = 400; v.player.y = s.player.y;
  s.ninjas.push({ kind: 'brawler', level: s.level, x: 520, y: v.player.y, r: 17, hp: 1, maxHp: 1, vx: 0, vy: 0 });
  coop.keys[CO.P2_KEYS.throw] = true; for (let i = 0; i < 60; i++) tick(s, coop); coop.keys[CO.P2_KEYS.throw] = false;
  assert.ok(s.ninjas.every(n => n.dead || n.hp <= 0) || s.ninjas.length === 0, 'P2 pizza killed the goon');
  assert.ok(v.score > 1000, 'kill scored for P2 (' + v.score + ')'); assert.equal(s.score, 0, 'P1 got no credit'); assert.equal(s.pizzas.length, 0, 'P2 pizzas are its own');
});
await t('game over only when both are out: P1 out keeps the run, shared continue pool, P2 revives P1, both out -> continue screen', () => {
  const s = fresh(), coop = mk(); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0; s.events = null;
  for (let k = 0; k < 4; k++) { s.invuln = 0; L.damagePlayer(s, 999); } assert.ok(s.over);
  tick(s, coop); assert.ok(!s.over && coop.p1Out, 'P1 out, run goes on'); assert.equal(coop.pool, CO.COOP.continues);
  for (let i = 0; i < 30; i++) tick(s, coop); assert.ok(!s.over && s.playerDown > 0, 'P1 lies down');
  assert.ok(coop.continueP1(s)); assert.ok(!coop.p1Out && s.lives === 3 && s.hp === 100); assert.equal(coop.pool, CO.COOP.continues - 1);
  for (let k = 0; k < 4; k++) { s.invuln = 0; L.damagePlayer(s, 999); } tick(s, coop); assert.ok(coop.p1Out);
  v.player.x = s.player.x + 10; v.player.y = s.player.y; for (let i = 0; i < 120 * 2; i++) tick(s, coop);
  assert.ok(!coop.p1Out && s.lives === 1 && s.hp === 50, `P2 revived P1 (lives ${s.lives}, hp ${s.hp})`);
  for (let k = 0; k < 4; k++) { v.invuln = 0; L.damagePlayer(v, 999); } assert.ok(v.over && !s.over);
  assert.ok(coop.continueP2(s)); assert.equal(coop.pool, CO.COOP.continues - 2, 'P2 spends from the same pool');
  coop.continueP2; for (let k = 0; k < 4; k++) { v.invuln = 0; L.damagePlayer(v, 999); } assert.ok(coop.continueP2(s)); assert.equal(coop.pool, 0);
  for (let k = 0; k < 4; k++) { v.invuln = 0; L.damagePlayer(v, 999); } assert.ok(!coop.continueP2(s), 'pool empty: wait for a revive');
  for (let k = 0; k < 4; k++) { s.invuln = 0; L.damagePlayer(s, 999); } tick(s, coop);
  assert.ok(s.over && coop.handed, 'both out -> game over, handed to the continue screen');
  s.over = false; s.lives = 3; s.hp = 100; tick(s, coop); // screens.js continue
  assert.ok(!coop.handed && !v.over && v.lives === 3 && coop.pool === CO.COOP.continues, 'continue screen brings both back and refills the pool');
});
await t('skate level: P2 rides a board alongside the scroll, own combat, kept on screen', () => {
  const s = fresh(), coop = mk(); coop.step(s, DT); const v = coop.join(s); s.ninjas.length = 0; s.events = null;
  s.level = L.SKATE_LEVEL; s.walkLevel = false; s.scrollSpeed = 150; s.cameraX = 0; coop.step(s, DT); s.player.x = 200; v.player.x = 260; // (level change regroups P2 first)
  for (let i = 0; i < 120; i++) { coop.step(s, DT); s.cameraX += 150 * DT; s.player.x += 150 * DT; coop.after(s, DT); }
  assert.ok(Math.abs(v.player.x - 260 - 150) < 8, 'P2 moved with the scroll ' + v.player.x.toFixed(1));
  coop.onPress('punch'); assert.ok(v.combat.attack, 'P2 can attack while skating');
  coop.keys[CO.P2_KEYS.right] = true; for (let i = 0; i < 120 * 6; i++) { coop.step(s, DT); s.cameraX += 150 * DT; s.player.x += 150 * DT; coop.after(s, DT); } coop.keys[CO.P2_KEYS.right] = false;
  assert.ok(v.player.x <= s.cameraX + L.W - CO.COOP.margin + 0.01, 'clamped on screen');
});
await t('P2 HUD is a compact strip (<= 190x46) in the top-right corner, hud.js untouched', () => {
  const s = fresh(), rects = [], ctx = new Proxy({}, { get(o, k) { if (k in o) return o[k]; if (k === 'measureText') return () => ({ width: 10 }); if (k === 'fillRect' || k === 'strokeRect') return (x, y, w, h) => rects.push([x, y, w, h]); return () => {}; }, set(o, k, val) { o[k] = val; return true; } });
  let bars = 0; const coop = mk({ hud: { drawBar() { bars++; }, track: () => ({ frac: 1, trail: 1 }) } }); coop.step(s, DT); coop.join(s);
  coop.drawHud(ctx, s, DT, L.W, L.H);
  assert.ok(rects.length && bars === 1, 'drew a bar via hud.drawBar');
  const x0 = Math.min(...rects.map(r => r[0])), y0 = Math.min(...rects.map(r => r[1])), x1 = Math.max(...rects.map(r => r[0] + r[2])), y1 = Math.max(...rects.map(r => r[1] + r[3]));
  assert.ok(x1 - x0 <= 190 && y1 - y0 <= 46, `strip ${x1 - x0}x${y1 - y0}`); assert.ok(x0 >= L.W - 210 && y0 >= 78 && y1 <= 130, `at ${x0},${y0}`);
});

// ---- browser
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
let url = process.argv[2], server; const shots = process.argv[3] || '/workspace/pizza-qa/';
if (!url || url === '-') {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(G.pathname, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(G.pathname) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); url = `http://127.0.0.1:${server.address().port}/`;
}
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
const w = ms => page.waitForTimeout(ms), ev = f => page.evaluate(f);
const snap = async f => { const d = await ev(() => { try { return document.getElementById('c').toDataURL('image/png'); } catch (_) { return null; } }); if (d) fs.writeFileSync(f, Buffer.from(d.split(',')[1], 'base64')); else await page.screenshot({ path: f }); };
const toSelect = async () => {
  await page.goto(url); await w(1000); await page.keyboard.press('Enter');
  for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect.active)); i++) { await page.keyboard.press('Enter'); await w(100); }
};
const skipCine = async () => { await w(300); for (let i = 0; i < 12 && await ev(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await w(150); } };
await t('browser: P2 joins on the select screen with the numpad, both fight in the sewer, numpad and arrows stay separate', async () => {
  await toSelect();
  await page.keyboard.press('NumpadEnter'); await w(100); await page.keyboard.press('Numpad6'); await w(100);
  assert.ok(await ev(() => window.__ppCoop.joined), 'joined at select');
  await snap(shots + 'coop-0-select.png');
  await page.keyboard.press('Numpad1'); await w(100); assert.ok(await ev(() => window.__ppCoop.ready));
  await page.keyboard.press('Enter'); await skipCine(); await w(400);
  const st = await ev(() => { const v = window.__ppCoop.p2, s = window.__ppState; return v && { h1: s.selectedHero, h2: v.selectedHero, x1: s.player.x, x2: v.player.x }; });
  assert.ok(st && st.h1 !== st.h2, 'P2 in the run with a different hero ' + JSON.stringify(st));
  await page.keyboard.down('Numpad6'); await w(500); await page.keyboard.up('Numpad6');
  const a = await ev(() => ({ x1: window.__ppState.player.x, x2: window.__ppCoop.p2.player.x }));
  assert.ok(a.x2 > st.x2 + 30 && Math.abs(a.x1 - st.x1) < 2, 'numpad moved only P2 ' + JSON.stringify([st, a]));
  await page.keyboard.down('ArrowRight'); await w(500); await page.keyboard.up('ArrowRight');
  const b = await ev(() => ({ x1: window.__ppState.player.x, x2: window.__ppCoop.p2.player.x }));
  assert.ok(b.x1 > a.x1 + 30 && Math.abs(b.x2 - a.x2) < 2, 'arrows moved only P1 ' + JSON.stringify([a, b]));
  // Walk both into the first ambush and brawl.
  await page.keyboard.down('ArrowRight'); await page.keyboard.down('Numpad6');
  for (let i = 0; i < 120 && !(await ev(() => window.__ppState.events && window.__ppState.events.lock && window.__ppState.ninjas.length >= 3)); i++) await w(100);
  await page.keyboard.up('ArrowRight'); await page.keyboard.up('Numpad6');
  for (let i = 0; i < 16; i++) { await page.keyboard.press(i % 2 ? 'KeyJ' : 'Numpad1'); await page.keyboard.press(i % 2 ? 'Numpad1' : 'KeyK'); await w(140); if (i === 9) await snap(shots + 'coop-1-fight.png'); }
  const f = await ev(() => { const s = window.__ppState, v = window.__ppCoop.p2, cam = window.__ppCamX; return { cam, x1: s.player.x, x2: v.player.x, t2: s.ninjas.filter(n => n.coopT === 2).length, t1: s.ninjas.filter(n => n.coopT === 1).length, n: s.ninjas.length, p2score: v.score }; });
  assert.ok(f.x1 >= f.cam && f.x1 <= f.cam + 740 && f.x2 >= f.cam && f.x2 <= f.cam + 740, 'both on screen ' + JSON.stringify(f));
  await snap(shots + 'coop-2-fight.png');
  console.log('   fight', JSON.stringify(f));
});
await t('browser: mid-level drop-in (Start on the numpad, pick, join) and 0 console errors', async () => {
  await toSelect(); await page.keyboard.press('Enter'); await skipCine(); await w(400);
  assert.equal(await ev(() => window.__ppCoop.p2), null, 'solo run');
  await page.keyboard.press('NumpadEnter'); await w(150); assert.ok(await ev(() => window.__ppCoop.picking), 'picker open');
  await snap(shots + 'coop-3-dropin.png');
  await page.keyboard.press('Numpad6'); await page.keyboard.press('Numpad1'); await w(300);
  const j = await ev(() => { const v = window.__ppCoop.p2, s = window.__ppState; return v && { h1: s.selectedHero, h2: v.selectedHero, d: Math.abs(v.player.x - s.player.x) }; });
  assert.ok(j && j.h1 !== j.h2 && j.d < 200, 'dropped in next to P1 ' + JSON.stringify(j));
  assert.deepEqual(errors, []);
});
await browser.close(); if (server) server.close();
console.log(`${pass}/${total} coop checks passed`);
process.exit(pass === total ? 0 : 1);
