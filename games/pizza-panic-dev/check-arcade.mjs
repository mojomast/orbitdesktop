// MR.INDIA retro arcade interior (t_265366e58d3946cf): registration, floor band, smashable
// cabinets (melee + pizzas -> smashed + tickets), ticket-counter arena gate, glitch beats.
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const B = await import(G + 'boss.js');
const E = await import(G + 'events.js');
const AD = await import(G + 'arcade-data.js');
const A = await import(G + 'arcade.js');
const SC = await import(G + 'screens.js');
let fails = 0; const t = (name, fn) => { try { const d = fn(); console.log('PASS', name + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', name, '-', e.message); } };
const LV = AD.ARCADE_LEVEL_INDEX, DT = 1 / 60, FOOT = AD.ARCADE_BAND.y + 10;
const fresh = x => { const s = L.createState(); s.hpMode = true; s.level = LV; s.wave = L.LEVEL_ORDER.indexOf(LV) + 1; C.createCombat(s); s.player.x = x; s.player.y = FOOT + 4; s.ninjas = []; return s; };
const run = (a, s, n) => { for (let i = 0; i < n; i++) { C.combatStep(s, DT); a.step(s, DT); } };

t('arcade is registered (LEVELS, order after the rooftop and before the harbor, tower last, boss, stage name)', () => {
  assert.equal(L.LEVELS[LV].id, 'arcade');
  const o = L.LEVEL_ORDER; assert.ok(o.includes(LV) && o.indexOf(LV) === o.indexOf(2) + 1 && o.indexOf(LV) < o.indexOf(6) && o[o.length - 1] === 4, o.join());
  assert.equal(B.BOSSES[LV].name, 'HIGH SCORE'); assert.ok(Object.values(B.BOSSES).some(d => d.name === 'SHREDCLAW' && d.final));
  assert.equal(SC.STAGE_NAMES[LV], 'ARCADE');
  return `(order ${o.join(',')})`;
});

t('floor band is walkable end to end; the back wall is not', () => {
  for (let x = 60; x < AD.ARCADE_W - 60; x += 200) assert.ok(L.isWalkable(LV, x, 425, 14), 'x ' + x);
  assert.ok(!L.isWalkable(LV, 900, 340, 14) && !L.isWalkable(LV, 900, 500, 14));
});

t('cabinets smash under punches: intact -> smashed, score, prize tickets you can collect', () => {
  const a = A.createArcade({ rand: () => 0.5 }), s = fresh(AD.CABINETS[0] - 40); a.step(s, DT);
  const cab = s.arcade.cabs[0], sc0 = s.score;
  for (let k = 0; k < 8 && !cab.broken; k++) { C.combatPress(s, 'punch'); run(a, s, 30); }
  assert.ok(cab.broken, `hp ${cab.hp}`); assert.ok(s.score - sc0 >= AD.CABINET.score, 'smash score');
  assert.equal(s.arcade.tickets.length, AD.CABINET.tickets);
  for (let i = 0; i < 200 && s.arcade.tickets.length; i++) { const k = s.arcade.tickets[0]; s.player.x = k.x; s.player.y = k.y; a.step(s, DT); }
  assert.equal(s.arcade.collected, AD.CABINET.tickets);
  return `(score +${s.score - sc0})`;
});

t('thrown pizzas also break cabinets; far cabinets stay intact', () => {
  const a = A.createArcade(), s = fresh(100); a.step(s, DT);
  for (let k = 0; k < AD.CABINET.hp; k++) { s.pizzas = [{ x: AD.CABINETS[1], y: FOOT + 4, vx: 300 }]; a.step(s, DT); }
  assert.ok(s.arcade.cabs[1].broken && !s.arcade.cabs[2].broken);
});

t('ticket counter: a mini arena (arena-lock wave) and the HIGH SCORE gate in the ticket section', () => {
  const tr = AD.ARCADE_TRIGGERS.filter(x => x.x >= AD.TICKET_X);
  const arena = tr.find(x => /^TICKET COUNTER/.test(x.banner || '')) /* banner text was reworded by the story pass (12:53) */, gate = tr.find(x => x.type === 'miniBoss');
  assert.ok(arena && arena.kinds.length >= 3, 'arena wave'); assert.ok(gate && gate.event === 'gate' && gate.boss.name === 'HIGH SCORE');
  assert.ok(E.TRIGGERS.some(x => x.level === LV && x.type === 'miniBoss'), 'in events TRIGGERS');
});

t('glitch: scripted beats start a 1.5-3 s palette hack once each; reduced-flash shortens it', () => {
  const a = A.createArcade(), s = fresh(1000); s.events = { fired: { [LV + ':1000']: true } };
  a.step(s, DT); assert.ok(s.arcade.glitch, 'glitch on');
  let tt = DT; while (s.arcade.glitch && tt < 5) { a.step(s, DT); tt += DT; }
  assert.ok(tt >= 1.5 && tt <= 3, 'dur ' + tt.toFixed(2));
  a.step(s, DT); assert.equal(s.arcade.glitch, null, 'fires once per beat');
  const r = A.createArcade({ fx: { shakeEnabled: false } }), s2 = fresh(1000); s2.events = { fired: { [LV + ':1000']: true } }; r.step(s2, DT);
  assert.equal(s2.arcade.glitch.dur, AD.GLITCH.reducedDur);
  assert.ok(AD.ARCADE_GLITCH_KEYS.length >= 2);
  return `(${tt.toFixed(2)} s, ${AD.ARCADE_GLITCH_KEYS.length} glitch beats)`;
});

t('6+ enemy types (incl. clawninja/shieldbrute/flamebot) and 2+ scripted beats', () => {
  const kinds = new Set(AD.ARCADE_TRIGGERS.flatMap(x => x.kinds)); Object.values(AD.ARCADE_EXT_SPAWNS).flat().forEach(k => kinds.add(k));
  for (const k of ['clawninja', 'shieldbrute', 'flamebot']) assert.ok(kinds.has(k), k);
  const beats = AD.ARCADE_TRIGGERS.filter(x => x.event).length; assert.ok(kinds.size >= 6 && beats >= 2);
  return `(${kinds.size} types, ${beats} scripted beats)`;
});

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
