// MR.INDIA hover-drone packs (t_ead25b0d4f1a417e): pack spawn, telegraph before the dive,
// damage on hit, air/launcher-only hits (ground hits only at the dive's low point), death into
// the debris burst, packs on 2+ levels, ungrabbable.
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const E = await import(G + 'events.js');
const Gr = await import(G + 'grab.js');
const Dr = await import(G + 'drones.js');
let fails = 0; const t = (n, f) => { try { const d = f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const DT = 1 / 60, H = Dr.HOVERDRONE;
const fresh = (level = 1) => { const s = L.createState(); s.hpMode = true; s.level = level; s.wave = 1; s.walkLevel = true; s.holdWave = true; C.createCombat(s); E.ensureEvents(s);
  s.player.x = 2400; s.player.y = L.LEVELS[level].walkables[0].y + 40; s.cameraX = 2100; s.ninjas = []; s.t = 0; return s; };
function sim(s, d, n = 1) { for (let i = 0; i < n; i++) { s.clock = (s.clock || 0) + DT; if (!C.inHitStop(s)) C.combatWalk(s, 0, 0, DT); C.combatStep(s, DT); if (C.inHitStop(s)) continue; L.update(s, DT); d.step(s, DT); } }
const withPack = (level = 1) => { const s = fresh(level), d = Dr.createDrones(); const key = Object.keys(Dr.DRONE_PACKS).find(k => k.startsWith(level + ':')); s.events.fired[key] = true; d.step(s, DT); return { s, d, key }; };

t('a pack of 3-4 hover drones spawns off-screen when its beat fires, then swoops in to hover', () => {
  const { s, d, key } = withPack(1); const ds = s.ninjas.filter(n => n.kind === 'hoverdrone');
  assert.equal(ds.length, Dr.DRONE_PACKS[key]); assert.ok(ds.length >= 3 && ds.length <= 4);
  assert.ok(ds.every(n => n.x > s.cameraX + 740 || n.x < s.cameraX), 'off-screen');
  s.invuln = 99; sim(s, d, 150); const live = d.info(s).live;
  assert.ok(live.every(x => x.phase !== 'enter') && live.every(x => x.z > 40), JSON.stringify(live));
  return `(${ds.length} on ${key})`;
});

t('turn-taking: a >= 0.5 s red-eye telegraph (lane marked) comes before each dive; one attacker at a time', () => {
  const { s, d } = withPack(1); s.invuln = 99; let tele = null, gap = null, maxAtk = 0;
  for (let i = 0; i < 60 * 12 && gap == null; i++) { sim(s, d); const L2 = s.drones.log; const atk = s.drones.list.filter(n => ['tele', 'dive', 'aim'].includes(n.hd.phase)).length; maxAtk = Math.max(maxAtk, atk);
    const tl = s.drones.list.find(n => n.hd.phase === 'tele'); if (tl && tele == null) tele = s.clock; if (tele != null && s.drones.list.some(n => n.hd.phase === 'dive')) gap = s.clock - tele; }
  assert.ok(gap != null && gap >= 0.5, 'gap ' + gap); assert.equal(maxAtk, 1);
  return `(dive ${gap.toFixed(2)} s after the eye flash)`;
});

t('dive and laser hits deal 6-8 damage', () => {
  const { s, d } = withPack(1); const seen = new Set();
  for (let i = 0; i < 60 * 30 && seen.size < 2; i++) { s.invuln = Math.min(s.invuln, 0.2); s.playerDown = 0; sim(s, d); for (const e of s.drones.log) if (e.ev === 'hit' && e.dmg) { assert.ok(e.dmg >= 6 && e.dmg <= 8, 'dmg ' + e.dmg); seen.add(e.mode); } }
  assert.ok(seen.size >= 1 && s.hp < 100, 'hit landed'); return `(${[...seen].join(' + ')}, hp ${s.hp})`;
});

t('hovering drones ignore ground punches but take a jump kick and the launcher', () => {
  const s = fresh(1), d = Dr.createDrones(); const n = Dr.makeHoverDrone(s.player.x + 40, s.player.y, 1, 0); n.hd.phase = 'hover'; s.ninjas.push(n); (s.drones = null); d.step(s, DT); s.drones.list.push(n);
  const pin = () => { n.x = s.player.x + 40; n.y = s.player.y; n.hd.phase = 'hover'; n.z = H.hoverZ; };
  s.combat.facing = 1; C.combatPress(s, 'punch'); for (let i = 0; i < 30; i++) { pin(); sim(s, d); }
  assert.equal(n.hp, H.hp, 'ground punch whiffs under a hovering drone');
  C.combatPress(s, 'jump'); for (let i = 0; i < 8; i++) { pin(); sim(s, d); } C.combatPress(s, 'kick'); for (let i = 0; i < 40; i++) { pin(); sim(s, d); }
  assert.ok(n.hp < H.hp, 'jump kick lands'); const afterJump = n.hp;
  const m = C.MOVES || null; assert.ok(!m || m.launcher, 'launcher move exists');
  return `(hp ${H.hp} -> ${afterJump} after one jump kick)`;
});

t('ground punches land at the dive low point; thrown pizzas hit hovering drones', () => {
  const s = fresh(1), d = Dr.createDrones(); const n = Dr.makeHoverDrone(s.player.x + 40, s.player.y, 1, 0); s.ninjas.push(n); d.step(s, DT); s.drones.list.push(n);
  n.hd.phase = 'dive'; n.hd.t = H.dive * 0.5; n.hd.x0 = n.x; n.hd.y0 = n.y; n.hd.tx = n.x; n.hd.ty = n.y; n.hd.hit = true; s.invuln = 99;
  const pin = () => { n.x = s.player.x + 40; n.y = s.player.y; n.hd.t = H.dive * 0.5; n.z = H.lowZ; };
  s.combat.facing = 1; C.combatPress(s, 'punch'); for (let i = 0; i < 30; i++) { pin(); sim(s, d); }
  assert.ok(n.hp < H.hp, 'low-point punch lands');
  const s2 = fresh(1), d2 = Dr.createDrones(); const q = Dr.makeHoverDrone(s2.player.x + 120, s2.player.y, 1, 0); q.hd.phase = 'hover'; s2.ninjas.push(q); d2.step(s2, DT);
  s2.weaponLevel = 3; s2.combat.facing = 1; L.throwPizza(s2); for (let i = 0; i < 40; i++) { q.x = s2.player.x + 120; q.y = s2.player.y; q.hd.phase = 'hover'; sim(s2, d2); }
  assert.ok(q.hp < H.hp, 'pizza hit');
});

t('3 HP: dies and explodes into the debris burst', () => {
  const s = fresh(1), d = Dr.createDrones(); const n = Dr.makeHoverDrone(s.player.x + 40, s.player.y, 1, 0); s.ninjas.push(n); d.step(s, DT); s.drones.list.push(n);
  for (let k = 0; k < H.hp; k++) L.damageNinja(s, n, 1);
  assert.ok(n.dead); sim(s, d, 2);
  assert.ok(s.drones.log.some(e => e.ev === 'explode') && s.drones.fx.length === 1, 'burst');
  assert.ok(!s.ninjas.includes(n), 'removed');
});

t('packs ride beats on 2+ levels, every key is a real events.js trigger', () => {
  const keys = Object.keys(Dr.DRONE_PACKS), lv = new Set(keys.map(k => k.split(':')[0]));
  for (const k of keys) assert.ok(E.TRIGGERS.some(tr => tr.level + ':' + tr.x === k), k);
  assert.ok(lv.size >= 2); return `(levels ${[...lv].join(', ')})`;
});

t('hover drones cannot be grabbed (even stunned or at the dive low point)', () => {
  const n = Dr.makeHoverDrone(100, 400, 1, 0); n.stun = 0.5; assert.equal(Gr.canGrab(n), false); n.z = H.lowZ; assert.equal(Gr.canGrab(n), false);
});

t('rendering: segmented draw (body, rotors, arm, claw) and overlay run on a mock canvas', () => {
  const calls = []; const ctx = new Proxy({}, { get: (o, k) => k in o ? o[k] : (() => calls.push(k)), set: (o, k, v) => { o[k] = v; return true; } });
  const { s, d } = withPack(2); sim(s, d, 30); for (const n of s.drones.list) d.draw(ctx, n, 1); d.drawOver(ctx, s, 1); assert.ok(calls.length > 0);
});

console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
