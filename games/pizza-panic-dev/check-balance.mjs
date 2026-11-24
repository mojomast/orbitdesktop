// MR.INDIA balance pass: deterministic asserts on the key difficulty numbers.
//  - attacker cap (2 early, 3 later, never > 3) with a crowd around the player
//  - player i-frames after a hit (second hit inside the window does nothing)
//  - time-to-kill per enemy kind and per boss phase from each hero's punch-string DPS
//  - early telegraphs are longer than late ones; skate hazards give >= 3 s lead
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const E = await import(G + 'events.js');
const S = await import(G + 'skate.js');
const B = await import(G + 'boss.js');
const HM = await import(G + 'hero-moves.js');
const { HEROES } = await import(G + 'heroes.js');
let fails = 0; const t = (name, fn) => { try { const d = fn(); console.log('PASS', name + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', name, e.message); } };
const UPTIME = 0.5, BOSS_UPTIME = 0.35; // share of time an average player is actually landing hits

// DPS of the 4-hit punch string per hero (finisher overridden per hero; multi-hit counted).
const dps = {};
for (const h of HEROES) {
  const st = { hero: h.id };
  const chain = C.MOVES.punch.map((m, i) => HM.heroMove(st, { ...m, chainKey: 'punch' + (i + 1) }));
  const dmg = chain.reduce((a, m) => a + m.dmg * (m.multi || 1), 0), time = chain.reduce((a, m) => a + m.wind + m.active + m.rec, 0);
  dps[h.id] = dmg / time;
}
const avg = Object.values(dps).reduce((a, b) => a + b, 0) / Object.keys(dps).length;
console.log('   punch-string DPS:', Object.entries(dps).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '), `| avg ${avg.toFixed(2)}`);

t('attacker cap: 2 early, 3 later, never more than 3 holding tokens', () => {
  const res = [];
  for (const wave of [1, 4, 9]) {
    const s = L.createState(); s.hpMode = true; s.wave = wave; s.level = L.levelForWave(wave); C.createCombat(s);
    s.player.x = 300; s.player.y = 430;
    for (let i = 0; i < 7; i++) s.ninjas.push({ kind: ['brawler', 'striker', 'charger', 'acrobat'][i % 4], level: s.level, x: 300 + (i % 2 ? 1 : -1) * (60 + i * 15), y: 430, r: 15, hp: 2, maxHp: 2, vx: 0, vy: 0 });
    let maxHeld = 0;
    for (let k = 0; k < 240; k++) { s.invuln = 1; C.enemyAI(s, 1 / 60); maxHeld = Math.max(maxHeld, s.ninjas.filter(n => n.token && !n.dead).length); }
    assert.ok(maxHeld <= C.maxTokens(s) && maxHeld <= 3, `wave ${wave}: ${maxHeld} attackers`);
    res.push(`w${wave}:${maxHeld}/${C.maxTokens(s)}`);
  }
  return res.join(' ');
});

t('i-frames after a hit (>= 0.75 s), and a second hit inside them deals nothing', () => {
  const s = L.createState(); s.hpMode = true;
  const a = L.damagePlayer(s, 8), win = s.invuln, b = L.damagePlayer(s, 8);
  assert.ok(a > 0 && b === 0 && win >= 0.75, `first ${a}, second ${b}, window ${win}`);
  const s2 = L.createState(); s2.hpMode = true; L.damagePlayer(s2, 12);
  assert.ok(s2.invuln >= 1.2, 'knockdown hit grants longer i-frames');
  return `(${win}s, knockdown ${s2.invuln}s)`;
});

t('time-to-kill per enemy kind: mooks die in 1-2 hits, elites in a few seconds', () => {
  const rows = [];
  for (const [kind, hp] of Object.entries(E.KIND_HP)) {
    if (kind === 'boss') continue;
    const ttk = hp / (avg * UPTIME);
    if (['foot', 'runner', 'striker', 'drone', 'brawler', 'skater', 'trooper', 'thrower', 'acrobat'].includes(kind)) assert.ok(hp <= 2, `${kind} hp ${hp}`);
    assert.ok(ttk <= 8, `${kind} ttk ${ttk.toFixed(1)}s`);
    rows.push(`${kind} ${hp}hp ${ttk.toFixed(1)}s`);
  }
  return '\n   ' + rows.join(', ');
});

t('boss phases last about 12-28 s for an average player (no damage sponges)', () => {
  const rows = [];
  for (const [lv, d] of Object.entries(B.BOSSES)) {
    const marks = d.phases.map(f => Math.round(d.hp * f)).concat(0);
    const per = d.phases.map((_, i) => (marks[i] - marks[i + 1]) / (avg * BOSS_UPTIME));
    for (const s of per) assert.ok(s >= 12 && s <= 28, `${d.name} phase ${s.toFixed(1)}s`);
    rows.push(`${d.name} ${d.hp}hp [${per.map(s => s.toFixed(0) + 's').join(' ')}]`);
  }
  assert.ok(Object.values(B.BOSSES).some(d => d.name === 'SHREDCLAW' && d.final), 'SHREDCLAW stays the final boss');
  return '\n   ' + rows.join(', ');
});

t('telegraphs: sewer > street > later levels, every mook wind-up >= 0.4 s', () => {
  const spec = { wind: 0.4 };
  const w = lv => C.windFor({ level: lv }, spec);
  assert.ok(w(0) > w(1) && w(1) > w(2) && w(2) === w(3), 'ramp');
  assert.ok(w(2) >= 0.4, 'base wind');
  return `(0.4 s base -> sewer ${w(0).toFixed(2)}, street ${w(1).toFixed(2)})`;
});

t('skate: scroll speed sane and hazards readable (>= 3 s lead time)', () => {
  const lead = (740 + 60 - 200) / S.SKATE.speed; // spawn at camera right + 60, player rides near x+200
  assert.ok(S.SKATE.speed >= 110 && S.SKATE.speed <= 190, `speed ${S.SKATE.speed}`);
  assert.ok(lead >= 3, `lead ${lead.toFixed(1)}s`);
  return `(speed ${S.SKATE.speed} px/s, lead ${lead.toFixed(1)} s)`;
});

console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
