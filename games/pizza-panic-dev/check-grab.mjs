// MR.INDIA grab & throw (t_fa795054a3024540): grab only stunned enemies, knee x3
// releases with a knockdown, lane throw damages + knocks down the lane, screen
// throw KOs and flies at the camera, hold timeout break-free, bosses/guards immune.
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const GR = await import(G + 'grab.js');
let fails = 0; const t = (name, fn) => { try { const d = fn(); console.log('PASS', name + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', name, '-', e.message); } };
const DT = 1 / 60;
const fresh = () => { const s = L.createState(); s.hpMode = true; s.level = 1; s.wave = 2; C.createCombat(s); s.player.x = 400; s.player.y = 420; return s; };
const foe = (s, dx, extra = {}) => ({ kind: 'brawler', level: 1, x: s.player.x + dx, y: s.player.y, r: 15, hp: 10, maxHp: 10, vx: 0, vy: 0, ...extra });
const step = (s, n) => { for (let i = 0; i < n; i++) C.combatStep(s, DT); };
const grab = (s, n) => { s.ninjas.push(n); C.combatWalk(s, 1, 0, DT); return s.combat.grab && s.combat.grab.n === n; };

t('grab only on stunned enemies (walk-in)', () => {
  const s = fresh(); assert.ok(!grab(s, foe(s, 30)), 'healthy enemy not grabbed');
  const s2 = fresh(); assert.ok(grab(s2, foe(s2, 30, { stun: 1 })), 'stunned enemy grabbed');
  assert.ok(s2.ninjas[0].grabbed);
});

t('knee x3: 1 dmg each, the 3rd releases with a knockdown', () => {
  const s = fresh(); const n = foe(s, 30, { stun: 1 }); grab(s, n);
  const hp = [];
  for (let k = 0; k < 3; k++) { C.combatPress(s, 'punch'); step(s, 30); hp.push(n.hp); }
  assert.deepEqual(hp, [9, 8, 7], 'hp after knees');
  assert.ok(!s.combat.grab && !n.grabbed, 'released after 3rd knee');
  assert.ok(n.falling || n.down > 0, 'knocked down');
  return `(hp ${hp.join('>')})`;
});

t('lane throw (punch + away): 2 to the thrown enemy, 2 + knockdown to each enemy in its lane; hero i-frames', () => {
  const s = fresh(); const n = foe(s, 30, { stun: 1 }); grab(s, n);
  const a = foe(s, -70), b = foe(s, -130), off = foe(s, -90, { y: s.player.y + 60 }); s.ninjas.push(a, b, off);
  C.combatWalk(s, -1, 0, DT); // hold away from the grabbed enemy
  C.combatPress(s, 'punch');
  assert.ok(s.invuln > 0.45, 'i-frames during the throw');
  step(s, 90);
  assert.equal(n.hp, 8, 'thrown enemy took 2');
  assert.ok(a.hp === 8 && b.hp === 8, `lane enemies took 2 each (${a.hp}, ${b.hp})`);
  assert.ok((a.down > 0 || a.falling) && (b.down > 0 || b.falling) || a.thrownBy === n && b.thrownBy === n, 'lane enemies knocked down');
  assert.equal(off.hp, 10, 'enemy outside the lane untouched');
  return `(thrown ${n.hp}, lane ${a.hp}/${b.hp}, off-lane ${off.hp})`;
});

t('grabbed enemies take no damage from a thrown body', () => {
  const s = fresh(); const held = foe(s, 30, { stun: 1 }); grab(s, held);
  const body = foe(s, 30, { thrown: true, z: 20, launchV: 100, knock: 1 }); s.ninjas.push(body);
  step(s, 2); assert.equal(held.hp, 10);
});

t('screen throw (kick or jump): KO, removed from play, flies at the camera', () => {
  for (const btn of ['kick', 'jump']) {
    const s = fresh(); const n = foe(s, 30, { stun: 1, hp: 6, maxHp: 6 }); grab(s, n);
    C.combatPress(s, btn);
    assert.ok(s.invuln >= 0.7, 'i-frames for the screen throw');
    step(s, 40);
    assert.ok(n.dead, `${btn}: KO`); assert.ok(!s.combat.grab);
    assert.equal(s.screenThrows.length, 1, 'fly-at-camera effect queued');
    step(s, 70); assert.equal(s.screenThrows.length, 0, 'effect finishes');
  }
});

t(`hold timeout: the enemy breaks free after ${GR.GRAB_HOLD}s`, () => {
  const s = fresh(); const n = foe(s, 30, { stun: 1 }); grab(s, n);
  step(s, Math.round((GR.GRAB_HOLD - 0.2) * 60)); assert.ok(s.combat.grab, 'still held before the timeout');
  step(s, 20); assert.ok(!s.combat.grab && !n.grabbed, 'broke free');
});

t('bosses, drones and a guarding shield brute cannot be grabbed', () => {
  for (const extra of [{ kind: 'boss', boss: true, elite: true }, { boss: true, elite: true, kind: 'acrobat' }, { kind: 'drone' }, { kind: 'blocker', ext: 'shieldbrute', guard: true }]) {
    const s = fresh(); assert.ok(!grab(s, foe(s, 30, { stun: 1, ...extra })), JSON.stringify(extra));
  }
  assert.ok(GR.canGrab({ kind: 'blocker', ext: 'shieldbrute', guard: false, stun: 0.7, hp: 6 }), 'rattled shield brute is grabbable');
});

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
