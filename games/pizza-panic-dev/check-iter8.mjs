// Iteration 8 checks: rig joints (every pivot / attach on the art, back limbs
// share the front elbow and knee, the re-sliced purple turtle, native-right
// facing), cinematic dialogue pacing, the title attract sequence, and no wave
// after the final boss.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() {} };
globalThis.Event = globalThis.Event || class { constructor(n) { this.type = n; } };
const G = new URL('../pizza-panic/', import.meta.url);
const H = await import(new URL('hero-rigs.js', G).href);
const EN = await import(new URL('enemy-rigs.js', G).href);
const CI = await import(new URL('cinematics.js', G).href);
const { holdFor } = CI;
const TI = await import(new URL('title.js', G).href);
const L = await import(new URL('logic.js', G).href);
const C = await import(new URL('combat.js', G).href);
const E = await import(new URL('events.js', G).href);
const K = await import(new URL('collision.js', G).href);
let pass = 0, total = 0; const t = async (name, fn) => { total++; await fn(); pass++; console.log('PASS', name); };
const src = f => readFileSync(new URL(f, G), 'utf8');

await t('rig audit: every pivot and attach point sits on the art (heroes, enemies, drone)', () => {
  const out = execFileSync('python3', [new URL('tools/rig_audit.py', import.meta.url).pathname], { encoding: 'utf8' });
  const rows = out.trim().split('\n').map(l => l.split(' '));
  assert.ok(rows.length >= 15, 'all types audited');
  const bad = rows.filter(r => r[1] !== '0'); assert.deepEqual(bad, [], out);
});
await t('back limbs: shoulder/hip nudge only; back elbow and knee use the front joint exactly', () => {
  for (const tables of [H.HERO_RIGS, EN.ENEMY_RIGS]) for (const [k, r] of Object.entries(tables)) {
    for (const [b, f] of [['farm_b', 'farm'], ['shin_b', 'shin']]) {
      if (!r[b] || !r[f]) continue;
      assert.equal(r[b].ax, r[f].ax, k + ' ' + b + '.ax'); assert.equal(r[b].ay, r[f].ay, k + ' ' + b + '.ay');
      assert.equal(r[b].px, r[f].px, k + ' ' + b + ' pivot');
    }
    for (const [b, f] of [['uarm_b', 'uarm'], ['thigh_b', 'thigh']]) if (r[b] && r[f]) assert.ok(Math.abs(r[b].ax - r[f].ax) <= 8 && Math.abs(r[b].ay - r[f].ay) <= 4, k + ' ' + b + ' nudge');
  }
});
await t('purple turtle is re-sliced and segmented (68px torso, 7 parts, bo in hand)', () => {
  const r = H.HERO_RIGS.turtle_purple; assert.ok(r, 'in HERO_RIGS');
  assert.equal(r.torso.h, 68);
  for (const p of ['head', 'torso', 'uarm', 'farm', 'thigh', 'shin', 'weapon']) assert.ok(existsSync(new URL('assets/heroes/turtle_purple/' + r[p].file, G)), p);
  assert.equal(r.weapon.parent, 'farm_b'); assert.ok(r.weapon.w > r.weapon.h * 4, 'staff is level');
  assert.ok(!/LEGACY_RIG = new Set\([^)]*turtle_purple/.test(src('game.js')), 'not on the legacy rig');
});
await t('facing: all enemy art faces right natively and mirrors when facing left; foot rig retired', () => {
  const g = src('game.js');
  assert.match(g, /n\.face != null \? n\.face < 0/);
  assert.match(g, /LEGACY_KIND = \{ foot: 'striker'/);
  assert.match(src('skate.js'), /if \(face < 0\) ctx\.scale\(-1, 1\);[\s\S]*drone art faces RIGHT|drone art faces RIGHT[\s\S]*if \(face < 0\) ctx\.scale\(-1, 1\);/);
  assert.match(src('assets/enemies/MANIFEST.md'), /face \*\*right\*\* natively/);
});
// ---- cinematics pacing
function runCine(ids, onStep) {
  const c = CI.createCinematics(null); c.setHero('Leo');
  ids.forEach(id => c.play(id));
  const log = []; let last = '', t = 0;
  return { c, async run(maxT = 200) {
    for (let i = 0; i < maxT * 120; i++) {
      if (onStep) onStep(c, t);
      c.update(1 / 120); t += 1 / 120;
      const d = c.debug(), k = c.scene() + '|' + d.phase + '|' + d.li;
      if (k !== last) { log.push({ ...d, t, scene: c.scene() }); last = k; }
      if (!c.isActive()) { await new Promise(r => setTimeout(r, 25)); if (!c.isActive()) break; }
    }
    return log;
  } };
}
await t('dialogue: each line holds 1.2s + 40ms/char, a readable linger after the last line, then a 0.5s fade', async () => {
  const s = CI.createCinematics(null); // read the scene text the same way the engine does
  const lines = s.panels().intro_2.lines; // story-v2: read the panel copy from the module instead of hardcoding it
  const log = await runCine(['intro_2']).run();
  const at = (ph, li) => log.find(e => e.phase === ph && e.li === li).t;
  for (let i = 1; i <= 3; i++) {
    const held = (i < 3 ? at('type', i + 1) : at('tail', 3)) - at('hold', i);
    assert.ok(Math.abs(held - CI.holdFor(lines[i - 1])) < 0.02, `line ${i} held ${held.toFixed(3)}`);
  }
  // The tail is a readable linger sized to the last line, not a flat 1.5s, so read it
  // from the module rather than hardcoding the number here.
  const linger = CI.lingerFor(lines);
  assert.ok(Math.abs(at('out', 3) - at('tail', 3) - linger) < 0.02, `tail hold ${linger.toFixed(2)}s`);
  const end = log[log.length - 1]; assert.equal(end.scene, null);
  assert.ok(Math.abs(end.t - at('out', 3) - 0.5) < 0.03, 'fade to black');
  assert.equal(CI.holdFor('x'.repeat(50)), 1.2 + 2.0);
});
await t('dialogue: intro panels crossfade (no hard cut) and the last one fades to black', async () => {
  const seen = [];
  const r = runCine(['intro'], c => { const d = c.debug(); if (d.prev) seen.push(c.scene()); });
  const log = await r.run();
  const order = [...new Set(log.map(e => e.scene).filter(Boolean))]; assert.deepEqual(order, ['intro_1', 'intro_2', 'intro_don', 'intro_3']); // baba_booey: Don Piedro's FANBOY panel
  assert.ok(seen.includes('intro_2') && seen.includes('intro_3'), 'crossfade into panels 2 and 3');
  assert.ok(log.some(e => e.scene === 'intro_3' && e.phase === 'out'), 'last panel fades out');
});
await t('dialogue keys: first press finishes the line, second advances; Esc skips everything', async () => {
  const c = CI.createCinematics(null); c.play('intro');
  for (let i = 0; i < 120 * 1.2; i++) c.update(1 / 120); // into line 1
  let d = c.debug(); assert.equal(d.phase, 'type'); assert.equal(d.li, 1);
  c.advance(); d = c.debug(); assert.equal(d.phase, 'hold', 'line finished'); assert.equal(d.li, 1);
  c.advance(); d = c.debug(); assert.equal(d.phase, 'type'); assert.equal(d.li, 2, 'advanced');
  c.advance(); c.advance(); c.advance(); c.advance(); d = c.debug(); // finish 2, next 3, finish 3, last -> next panel
  assert.equal(c.scene(), 'intro_2', 'last press moves on to the next panel');
  c.skip(); assert.equal(c.debug().phase, 'out');
  for (let i = 0; i < 60; i++) c.update(1 / 120);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(c.isActive(), false, 'skip-all ends the intro'); assert.equal(c.debug().queue.length, 0);
});
await t('title beats: five narrated beats, characters enter one by one, 35-45 s, pacing rules', () => {
  const B = TI.BEATS; assert.deepEqual(B.map(b => b.id), ['city', 'overlord', 'nous', 'turtles', 'logo']);
  assert.equal(B[0].line, 'Ten thousand forgotten claws woke up hungry.'); // story-v2 copy
  assert.equal(B[4].line, 'Eight heroes. One city. The claw is NOT the law.'); // story-v2 copy
  assert.deepEqual(B[2].enter.map(e => e[0]), ['teknium', 'nous_girl', 'turbofit']);
  assert.deepEqual(B[3].enter.map(e => e[0]), ['turtle_purple', 'turtle_blue', 'turtle_red', 'turtle_orange', 'don_piedro']); // baba_booey: 8th hero
  for (const b of B) for (let i = 1; i < (b.enter || []).length; i++) assert.ok(b.enter[i][1] - b.enter[i - 1][1] >= 0.9, 'entrances are separate');
  const total = TI.runTime(); assert.ok(total >= 35 && total <= 45, 'runtime ' + total.toFixed(1));
  // simulate: each beat lasts at least lineAt + typing + hold(1.2 + 0.04/char)
  const ti = TI.createTitle(null); ti.start(() => {}); const seen = []; let last = '', t = 0, lineDoneAt = {}, beatAt = {};
  while (!ti.ready() && t < 60) {
    ti.update(1 / 120); t += 1 / 120; const d = ti.debug();
    if (d.beat !== last) { beatAt[d.beat] = t; seen.push({ beat: d.beat, on: d.onStage.length }); last = d.beat; }
    if (d.lineDone && lineDoneAt[d.beat] == null) lineDoneAt[d.beat] = t;
  }
  assert.ok(ti.ready() && ti.slammed(), 'ends on PRESS START with the logo landed');
  assert.ok(Math.abs(t - total) < 0.1, `ran ${t.toFixed(2)} vs ${total.toFixed(2)}`);
  const ids = B.map(b => b.id);
  for (let i = 0; i < ids.length - 1; i++) {
    const line = B[i].line, held = beatAt[ids[i + 1]] - lineDoneAt[ids[i]];
    assert.ok(held >= holdFor(line) - 0.02, `${ids[i]} line held ${held.toFixed(2)}s`);
  }
  assert.ok(t - lineDoneAt.logo >= holdFor(B[4].line) - 0.02, 'tagline holds before PRESS START');
  assert.deepEqual(seen.map(s => s.on), [0, 0, 0, 3, 8], 'cast on stage at each beat start');
  for (const f of ['plate.jpg', 'overlord.png', 'logo.png', ...Object.keys(TI.CAST).map(n => n + '.png')]) assert.ok(existsSync(new URL('assets/cine/title/' + f, G)), f);
  assert.ok(!existsSync(new URL('assets/cine/title.jpg', G)), 'old flat title.jpg is retired (not in assets/cine/; _archive now lives outside the app bundle)');
});
await t('title keys: first press finishes the line, next advances a beat, Esc skips all, then start', () => {
  let started = 0; const ti = TI.createTitle(null); ti.start(() => started++);
  for (let i = 0; i < 120 * 2; i++) ti.update(1 / 120);
  let d = ti.debug(); assert.equal(d.beat, 'city'); assert.equal(d.lineDone, false);
  ti.press(); d = ti.debug(); assert.equal(d.lineDone, true, 'line finished'); assert.equal(d.beat, 'city');
  ti.press(); d = ti.debug(); assert.equal(d.beat, 'overlord', 'advanced'); assert.equal(started, 0);
  ti.press(); ti.press(); assert.equal(ti.debug().beat, 'nous');
  ti.skipAll(); d = ti.debug(); assert.equal(d.beat, 'logo'); assert.ok(d.ready && d.slammed); assert.equal(d.onStage.length, 8); assert.equal(started, 0);
  ti.press(); assert.equal(started, 1, 'press at PRESS START starts'); assert.equal(ti.isActive(), false);
  const g = src('game.js'); assert.match(g, /title\.skipAll\(\)/); assert.ok(!/cinema\.play\('title'/.test(g));
});
await t('intro panels follow on from the title instead of re-explaining it', () => {
  const c = src('cinematics.js');
  assert.ok(!/The OpenClaw overlords have clawed into the city/.test(c) && !/We need you/.test(c), 'no repeated recruitment pitch');
  assert.match(c, /Shredclaw has claws in your pipes\. I hear them\./); // story-v2 copy
});
await t('no sewer wave after the final boss dies (ending owns the screen)', () => {
  const s = L.createState(); s.hpMode = true; C.createCombat(s); E.ensureEvents(s);
  s.wave = 4; s.level = 2; s.walkLevel = true; s.holdWave = true;
  const ev = s.events; for (const tr of E.TRIGGERS.filter(x => x.level === 2)) ev.fired[tr.level + ':' + tr.x] = true;
  s.bossSeen = true; s.ninjas = [];
  s.player.x = K.LEVELS[2].width - 100; s.player.y = K.LEVELS[2].walkables[0].y + 40;
  for (let i = 0; i < 600; i++) { E.stepEvents(s, 1 / 120); L.update(s, 1 / 120); }
  assert.equal(s.wave, 4, 'no new wave'); assert.equal(s.level, 2); assert.equal(s.ninjas.length, 0); assert.equal(s.runComplete, true);
});
console.log(`${pass}/${total} passed`);
