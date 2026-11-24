// MR.INDIA harbor docks level (t_86364aad0b7746c4): registration, floor band,
// crane telegraph -> drop -> damage, wet-plank sliding, ship gate, variety, beats.
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const B = await import(G + 'boss.js');
const E = await import(G + 'events.js');
const HD = await import(G + 'harbor-data.js');
const H = await import(G + 'harbor.js');
let fails = 0; const t = (name, fn) => { try { const d = fn(); console.log('PASS', name + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', name, '-', e.message); } };
const LV = HD.HARBOR_LEVEL_INDEX, DT = 1 / 60;
const fresh = x => { const s = L.createState(); s.hpMode = true; s.level = LV; s.wave = L.LEVEL_ORDER.indexOf(LV) + 1; C.createCombat(s); s.player.x = x; s.player.y = 430; return s; };

t('harbor is registered (LEVELS, LEVEL_ORDER before the tower, boss, stage name)', () => {
  assert.equal(L.LEVELS[LV].id, 'harbor');
  const o = L.LEVEL_ORDER; assert.ok(o.includes(LV) && o.indexOf(LV) < o.indexOf(4), o.join());
  assert.ok(B.BOSSES[LV] && B.BOSSES[LV].name === 'CAPTAIN HOOKCLAW');
  assert.ok(Object.values(B.BOSSES).some(d => d.name === 'SHREDCLAW' && d.final), 'SHREDCLAW still final');
  return `(order ${o.join(',')})`;
});

t('floor band is walkable across the whole pier and ship; water/sky is not', () => {
  for (let x = 60; x < HD.HARBOR_W - 60; x += 200) assert.ok(L.isWalkable(LV, x, 430, 14), 'x ' + x);
  assert.ok(!L.isWalkable(LV, 800, 360, 14) && !L.isWalkable(LV, 800, 500, 14));
});

t('crane: shadow telegraph >= 1 s before the crate lands, then 10 dmg + knockdown', () => {
  const h = H.createHarbor(), s = fresh(HD.CRANES[0]);
  h.step(s, DT);
  assert.ok(s.harbor.log.includes('telegraph') && s.harbor.drops.length === 1, 'telegraph');
  let tt = DT; while (!s.harbor.log.includes('drop') && tt < 3) { h.step(s, DT); tt += DT; }
  assert.ok(tt >= HD.CRANE.telegraph, `landed after ${tt.toFixed(2)}s`);
  assert.equal(s.hp, 90, 'drop damage'); assert.ok(s.playerDown > 0, 'knockdown');
  return `(lands ${tt.toFixed(2)}s after the shadow, hp ${s.hp})`;
});

t('crane: stepping out of the shadow avoids the crate', () => {
  const h = H.createHarbor(), s = fresh(HD.CRANES[1]);
  h.step(s, DT); s.player.y = 470 - 16; s.player.x += 120;
  for (let i = 0; i < 100; i++) h.step(s, DT);
  assert.equal(s.hp, 100);
});

t('wet planks: momentum carries after letting go; dry planks stop dead', () => {
  const h = H.createHarbor();
  const wet = fresh(1100); h.step(wet, DT); wet.harbor.sv = 220; wet.combat.moving = false; const x0 = wet.player.x;
  for (let i = 0; i < 30; i++) h.step(wet, DT);
  const dry = fresh(700); h.step(dry, DT); dry.harbor.sv = 220; dry.combat.moving = false; const d0 = dry.player.x;
  for (let i = 0; i < 30; i++) h.step(dry, DT);
  assert.ok(wet.player.x - x0 > 40, `wet slide ${wet.player.x - x0}`); assert.equal(dry.player.x, d0, 'no slide on dry planks');
  return `(slid ${Math.round(wet.player.x - x0)}px in 0.5 s)`;
});

t('ship boarding section has the mini-boss gate', () => {
  const g = HD.HARBOR_TRIGGERS.find(tr => tr.type === 'miniBoss');
  assert.ok(g && g.x >= HD.SHIP_X && g.event === 'gate' && g.boss, JSON.stringify(g && g.boss));
  assert.ok(E.TRIGGERS ? E.TRIGGERS.some(tr => tr.level === LV && tr.type === 'miniBoss') : true, 'in events TRIGGERS');
});

t('6+ enemy types (incl. claw ninja, shield brute, flamethrower bot) and 2+ scripted beats', () => {
  const kinds = new Set(HD.HARBOR_TRIGGERS.flatMap(tr => tr.kinds)); Object.values(HD.HARBOR_EXT_SPAWNS).flat().forEach(k => kinds.add(k));
  for (const k of ['clawninja', 'shieldbrute', 'flamebot']) assert.ok(kinds.has(k), k);
  const beats = HD.HARBOR_TRIGGERS.filter(tr => tr.event).length;
  assert.ok(kinds.size >= 6 && beats >= 2);
  return `(${kinds.size} types, ${beats} scripted beats)`;
});

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
