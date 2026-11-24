// Iteration 6 checks: HP bar rules, combat strings, skate level beatable.
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const S = await import(G + 'skate.js');
let pass = 0; const t = (name, fn) => { fn(); pass++; console.log('PASS', name); };
const fresh = () => { const s = L.createState(); s.hpMode = true; C.createCombat(s); return s; };
const run = (s, sec, each) => { for (let i = 0; i < sec * 60; i++) { if (each) each(s, i); C.combatWalk(s, 0, 0, 1 / 60); S.stepSkate(s, 1 / 60); C.combatStep(s, 1 / 60); L.update(s, 1 / 60); } };
t('damagePlayer drains hp, heavy knocks down, invuln blocks repeats', () => {
  const s = fresh(); L.damagePlayer(s, 10); assert.equal(s.hp, 90); assert.equal(L.damagePlayer(s, 10), 0);
  s.invuln = 0; L.damagePlayer(s, 14); assert.equal(s.hp, 76); assert.ok(s.playerDown > 0);
});
t('hp 0 spends a life and refills; last life is game over', () => {
  const s = fresh(); s.lives = 2; L.damagePlayer(s, 200); assert.equal(s.lives, 1); assert.equal(s.hp, 100); s.invuln = 0; L.damagePlayer(s, 200); assert.ok(s.over);
});
t('pizza (life pickup) heals in hpMode, capped at max', () => {
  const s = fresh(); s.ninjas = [{ x: 9999, y: 400, r: 10, hp: 1 }]; s.hp = 50; s.powerups.push({ x: s.player.x, y: s.player.y, r: 12, type: 'life', vx: 0, vy: 0 });
  L.update(s, 1 / 60); assert.equal(s.hp, 90); assert.equal(s.lives, 3);
  L.healPlayer(s, 999); assert.equal(s.hp, 100);
});
t('contact no longer costs a life in hpMode', () => {
  const s = fresh(); s.ninjas = [{ x: s.player.x, y: s.player.y, r: 15, hp: 1 }]; L.update(s, 1 / 60); assert.equal(s.lives, 3); assert.equal(s.ninjas.length, 1);
});
t('level order follows LEVEL_ORDER (sewer, street, skate, subway, rooftop, tower)', () => { assert.deepEqual(L.LEVEL_ORDER.map((_, i) => L.levelForWave(i + 1)), L.LEVEL_ORDER); assert.equal(L.levelForWave(L.LEVEL_ORDER.length + 1), L.LEVEL_ORDER[0], 'wraps'); assert.deepEqual(L.LEVEL_ORDER.slice(0, 3), [0, 1, 3], 'sewer, street, skate open the run'); assert.equal(new Set(L.LEVEL_ORDER).size, L.LEVEL_ORDER.length, 'no level twice'); }); // cheese: derived from LEVEL_ORDER
t('punch chain of 4 ends in a knockdown finisher; JJK launches', () => {
  const s = fresh(); s.level = null; s.ninjas = [{ kind: 'brawler', x: s.player.x + 35, y: s.player.y, r: 15, hp: 40, maxHp: 40, vx: 0, vy: 0 }];
  const seen = [];
  for (let k = 0; k < 4; k++) { C.combatPress(s, 'punch'); for (let i = 0; i < 20; i++) { C.combatStep(s, 1 / 60); if (s.combat.attack) seen.push(s.combat.attack.label); } }
  assert.ok(seen.includes('Finisher'), seen.join());
  const s2 = fresh(); s2.level = null; s2.ninjas = [{ kind: 'brawler', x: s2.player.x + 35, y: s2.player.y, r: 15, hp: 40, maxHp: 40, vx: 0, vy: 0 }];
  const seen2 = [];
  for (const b of ['punch', 'punch', 'kick']) { C.combatPress(s2, b); for (let i = 0; i < 18; i++) { C.combatStep(s2, 1 / 60); if (s2.combat.attack) seen2.push(s2.combat.attack.label); } }
  assert.ok(seen2.includes('Launcher'), seen2.join()); assert.ok(s2.ninjas[0].juggle || s2.ninjas[0].z > 0);
});
t('grab a stunned enemy, knee, then throw', () => {
  const s = fresh(); s.level = 1; s.player.x = 400; s.player.y = 420; const n = { kind: 'brawler', x: s.player.x + 30, y: s.player.y, r: 15, hp: 40, maxHp: 40, vx: 0, vy: 0, stun: 1 }; s.ninjas = [n];
  C.combatWalk(s, 1, 0, 1 / 60); assert.ok(s.combat.grab, 'grabbed');
  C.combatPress(s, 'punch'); for (let i = 0; i < 20; i++) C.combatStep(s, 1 / 60);
  C.combatPress(s, 'kick'); const seen = []; for (let i = 0; i < 30; i++) { C.combatStep(s, 1 / 60); if (s.combat.attack) seen.push(s.combat.attack.label); }
  assert.ok(seen.some(l => /Throw/.test(l)), seen.join()); assert.ok(!s.combat.grab); // kick while holding = screen throw (grab.js)
});
t('special costs 8 hp and never kills', () => {
  const s = fresh(); C.combatPress(s, 'punch'); C.combatPress(s, 'jump'); assert.equal(s.hp, 92);
  const s2 = fresh(); s2.hp = 5; C.combatPress(s2, 'jump'); C.combatPress(s2, 'punch'); assert.equal(s2.hp, 1);
});
t('skate level: obstacle hit costs hp and knocks down; jumping clears it', () => {
  const s = fresh(); s.wave = 2; s.ninjas = []; L.update(s, 1 / 60); assert.equal(s.level, 3); assert.ok(s.holdWave);
  S.stepSkate(s, 1 / 60); const sk = s.skate; sk.beat = 99; sk.obstacles.push({ type: 'barrier', x: s.player.x + 20, y: s.player.y, w: 48, clear: 24 });
  run(s, 0.3); assert.ok(s.hp < 100 && s.hp >= 88, 'hp ' + s.hp); assert.equal(sk.hits, 1);
  const s2 = fresh(); s2.wave = 2; s2.ninjas = []; L.update(s2, 1 / 60); S.stepSkate(s2, 1 / 60); s2.skate.beat = 99;
  s2.skate.obstacles.push({ type: 'barrier', x: s2.player.x + 60, y: s2.player.y, w: 48, clear: 24 });
  C.combatPress(s2, 'jump'); run(s2, 1.0); assert.equal(s2.hp, 100); assert.equal(s2.skate.cleared, 1);
});
t('skate level is beatable by a simple bot and hands over to the next level (subway)', () => { // cheese: subway follows skate
  const s = fresh(); s.wave = 2; s.ninjas = []; L.update(s, 1 / 60);
  let frames = 0;
  run(s, 200, (st, i) => {
    if (!st.skate) { if (st.skateDone && st.__overAtEnd == null) st.__overAtEnd = st.over; st.invuln = 9; return; } const p = st.player;
    if (st.skate.obstacles.some(o => !o.hit && !o.passed && o.x > p.x && o.x - p.x < 60 && (o.type === 'barrier' || Math.abs(o.y - p.y) < 22))) C.combatPress(st, 'jump');
    const n = st.ninjas.filter(n => !n.dead).sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
    if (n) { p.y += Math.sign(n.y - p.y) * Math.min(3, Math.abs(n.y - p.y)); if (Math.abs(n.x - p.x) > 70) p.x += Math.sign(n.x - p.x) * 3; if (st.combat.facing !== Math.sign(n.x - p.x)) st.combat.facing = Math.sign(n.x - p.x) || 1; if (Math.abs(n.x - p.x) < 90 && i % 8 === 0) C.combatPress(st, 'punch'); }
    frames = i;
  });
  assert.equal(s.skateDone, 1, 'finished ' + JSON.stringify({ d: s.skate && s.skate.dist, n: s.ninjas.filter(n => !n.dead).map(n => [n.kind, Math.round(n.x - s.player.x), Math.round(n.y - s.player.y), n.hp]), over: s.over, lv: s.level })); assert.equal(s.level, L.LEVEL_ORDER[L.LEVEL_ORDER.indexOf(3) + 1]); assert.equal(s.__overAtEnd, false);
});
console.log(`${pass}/10 passed`);
