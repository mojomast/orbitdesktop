// Iteration 7 checks: long levels, hitboxes (reach / facing / depth lane),
// facing flips, and a bot that finishes every level end to end.
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const S = await import(G + 'skate.js');
const E = await import(G + 'events.js');
const K = await import(G + 'collision.js');
let pass = 0, total = 0; const t = (name, fn) => { total++; fn(); pass++; console.log('PASS', name); };
const fresh = () => { const s = L.createState(); s.hpMode = true; C.createCombat(s); E.ensureEvents(s); return s; };
const dummy = (s, dx, dy = 0, extra = {}) => ({ kind: 'brawler', x: s.player.x + dx, y: s.player.y + dy, r: 17, hp: 50, maxHp: 50, vx: 0, vy: 0, ...extra });
// Fire one move and run its frames; returns the dummies that took damage.
function swing(s, button, dummies, chord) {
  s.ninjas = dummies; const hp0 = dummies.map(n => n.hp);
  if (chord) { C.combatPress(s, button); C.combatPress(s, chord); } else C.combatPress(s, button);
  for (let i = 0; i < 60; i++) C.combatStep(s, 1 / 60);
  return dummies.filter((n, i) => n.hp < hp0[i]);
}
const at = (lv) => { const s = fresh(); s.level = lv; s.player.x = 1200; s.player.y = K.LEVELS[lv].walkables[0].y + 40; s.combat.facing = 1; return s; };

t('walking levels are ~3x long and collision covers the full length', () => {
  for (const lv of [0, 1, 2]) {
    const w = K.LEVELS[lv].width; assert.ok(w >= 5400, 'width ' + w);
    const band = K.LEVELS[lv].walkables[0];
    assert.ok(band.x <= 0 && band.x + band.w >= w, 'band covers');
    for (const x of [100, w / 2, w - 100]) assert.ok(K.isWalkable(lv, x + 60, band.y + band.h / 2, 16) || K.isWalkable(lv, x - 60, band.y + band.h / 2, 16), 'walkable near ' + x);
    const beats = E.TRIGGERS.filter(t => t.level === lv);
    assert.ok(beats.length >= 7 && Math.max(...beats.map(b => b.x)) > w * 0.85, 'beats span the level');
    assert.ok(beats.some(b => b.type === 'breather' && b.pickup) && beats.some(b => b.type === 'setpiece') && beats.some(b => b.type === 'ambush'));
    const last = beats.reduce((a, b) => (b.x > a.x ? b : a));
    assert.ok(last.type === 'miniBoss' || last.type === 'boss', 'boss at the end');
  }
  assert.ok(S.SKATE.length >= 9000);
  const kinds = new Set(E.TRIGGERS.flatMap(t => t.kinds)); for (const k of ['brawler', 'striker', 'blocker', 'thrower', 'charger', 'acrobat']) assert.ok(kinds.has(k), k);
});
t('a punch never lands beyond reach', () => {
  const s = at(1); const hit = swing(s, 'punch', [dummy(s, 260)]); assert.equal(hit.length, 0);
  const s2 = at(1); assert.equal(swing(s2, 'punch', [dummy(s2, 60)]).length, 1, 'in reach');
});
t('no hit lands behind you (except the back attack)', () => {
  for (const b of ['punch', 'kick']) { const s = at(1); assert.equal(swing(s, b, [dummy(s, -50)]).length, 0, b + ' behind'); }
  const s = at(1); assert.equal(swing(s, 'punch', [dummy(s, -50)], 'kick').length, 1, 'back attack hits behind');
  const s2 = at(1); s2.combat.facing = -1; assert.equal(swing(s2, 'punch', [dummy(s2, -60)]).length, 1, 'facing left hits left');
});
t('no hit lands in a different depth lane (+-14px)', () => {
  const s = at(1); assert.equal(swing(s, 'punch', [dummy(s, 60, 30)]).length, 0);
  const s2 = at(1); assert.equal(swing(s2, 'kick', [dummy(s2, 60, -22)]).length, 0);
  const s3 = at(1); assert.equal(swing(s3, 'punch', [dummy(s3, 60, 12)]).length, 1, 'inside the lane');
});
t('hits only during active frames', () => {
  const s = at(1); const n = dummy(s, 300); s.ninjas = [n]; C.combatPress(s, 'punch');
  // move the dummy into reach after the active window has passed
  for (let i = 0; i < 14; i++) C.combatStep(s, 1 / 60); n.x = s.player.x + 50; for (let i = 0; i < 30; i++) C.combatStep(s, 1 / 60);
  assert.equal(n.hp, 50);
});
t('pizzas fly the way you face, in your lane, with limited range', () => {
  const s = at(1); s.ninjas = [dummy(s, -200), dummy(s, 200, 40)]; s.combat.facing = -1; L.throwPizza(s);
  assert.ok(s.pizzas[0].vx < 0); for (let i = 0; i < 120; i++) L.update(s, 1 / 60);
  assert.equal(s.ninjas[0].hp < 50, true); assert.equal(s.ninjas[1].hp, 50);
  const s2 = at(1); s2.ninjas = [dummy(s2, 600)]; L.throwPizza(s2); for (let i = 0; i < 120; i++) L.update(s2, 1 / 60); assert.equal(s2.ninjas[0].hp, 50, 'out of range');
});
t('facing follows left/right input and locks mid-attack', () => {
  const s = at(1); C.combatWalk(s, -1, 0, 1 / 60); assert.equal(s.combat.facing, -1); C.combatWalk(s, 1, 0, 1 / 60); assert.equal(s.combat.facing, 1);
  C.combatPress(s, 'kick'); C.combatStep(s, 1 / 60); C.combatWalk(s, -1, 0, 1 / 60); assert.equal(s.combat.facing, 1, 'locked in wind-up');
});
// Bot: walk right, align with the nearest enemy, face it and attack.
function bot(s, i) {
  const p = s.player, live = s.ninjas.filter(n => !n.dead && !n.down);
  const n = live.sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
  let dx = 1, dy = 0; { const b = K.LEVELS[s.level].walkables[0]; const mid = Math.max(b.y, 0) + Math.min(b.h, 600) * 0.6; if (b.h < 1000 && Math.abs(p.y - mid) > 8) dy = Math.sign(mid - p.y); }
  if (n) {
    dy = Math.abs(n.y - p.y) > 6 ? Math.sign(n.y - p.y) : 0;
    const ax = Math.abs(n.x - p.x);
    dx = ax > 80 ? Math.sign(n.x - p.x) : ax < 40 ? -Math.sign(n.x - p.x) : 0;
    if (!dx && s.combat.facing !== Math.sign(n.x - p.x)) dx = Math.sign(n.x - p.x);
    if (ax < 110 && Math.abs(n.y - p.y) < 12 && i % 10 === 0) {
      // Blockers guard the front: open with a jump kick on them.
      if (n.kind === 'blocker' && !n.stun && !s.combat.airborne) C.combatPress(s, 'jump');
      else C.combatPress(s, s.combat.airborne ? 'kick' : i % 50 === 0 ? 'kick' : 'punch');
    }
  }
  if (s.skate) {
    const ob = s.skate.obstacles.some(o => !o.hit && !o.passed && o.x > p.x && o.x - p.x < 70 && (o.type === 'barrier' || Math.abs(o.y - p.y) < 22));
    if (ob) C.combatPress(s, 'jump');
  }
  return [dx, dy];
}
t('a bot walks every level end to end and finishes it', () => {
  const s = fresh(); L.spawnWave(s); const order = []; const dt = 1 / 60;
  let i = 0, minHp = 100; const levelsSeen = new Set([s.level]);
  while (i++ < 60 * 60 * 12 && !s.over) {
    const [dx, dy] = bot(s, i);
    C.combatWalk(s, dx, dy, dt); S.stepSkate(s, dt); C.combatStep(s, dt); E.stepEvents(s, dt); L.update(s, dt);
    levelsSeen.add(s.level); minHp = Math.min(minHp, s.hp);
    if (s.wave > L.LEVEL_ORDER.length || (s.level === L.LEVEL_ORDER[L.LEVEL_ORDER.length - 1] && !s.ninjas.some(n => n.kind === 'boss' && !n.dead) && E.eventsInfo(s).log.some(l => l.type === 'boss' && l.x > 4000) && s.ninjas.every(n => n.dead))) break;
  }
  const log = E.eventsInfo(s).log;
  console.log('   bot:', JSON.stringify({ seconds: Math.round(i / 60), levelsDone: s.levelsDone, skateDone: s.skateDone, wave: s.wave, level: s.level, lives: s.lives, minHp, beats: log.length, px: Math.round(s.player.x), py: Math.round(s.player.y), live: s.ninjas.filter(n => !n.dead).map(n => [n.kind, Math.round(n.x), Math.round(n.y), n.z|0, n.hp, n.down, n.stun, !!n.atk, n.grabbed, n.falling]) }));
  assert.ok(!s.over, 'bot survived'); assert.ok(s.levelsDone >= 2, 'sewer + street done'); assert.equal(s.skateDone, 1, 'skate done');
  assert.ok(log.some(l => l.type === 'boss'), 'reached the final boss (OpenClaw Tower)');
  assert.ok(!s.ninjas.some(n => n.kind === 'boss' && !n.dead), 'boss beaten');
});
console.log(`${pass}/${total} passed`);
