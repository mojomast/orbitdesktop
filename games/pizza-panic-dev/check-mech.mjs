// Mech walker mini boss checks (baba_booey): CLAW WALKER, the OpenClaw Tower
// lobby gate. Art (sliced parts, size budget), placement, adoption by boss.js
// (bar + defeat signal, not final), telegraphs before every hitbox, jumpable
// stomp, lane gatling, phase-2 missile markers, claw grab, the cockpit weak
// point (double damage in the punish window, half otherwise), attack tokens,
// the part-rig poses (mech.js) and a bot that beats it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const G = new URL('../pizza-panic/', import.meta.url);
const L = await import(G.href + 'logic.js');
const C = await import(G.href + 'combat.js');
const E = await import(G.href + 'events.js');
const B = await import(G.href + 'boss.js');
const M = await import(G.href + 'mech.js');
let pass = 0, total = 0; const t = (name, fn) => { total++; fn(); pass++; console.log('PASS', name); };
const DT = 1 / 120;
let seed = 9; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const MECH = B.MINI_BOSSES.mech;
const gate = E.TRIGGERS.find(b => b.boss && b.boss.name === MECH.name);
const mockCtx = () => { const calls = []; return new Proxy({ calls, filter: 'none' }, { get(o, k) { if (k in o) return o[k]; if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} }); if (k === 'measureText') return () => ({ width: 60 }); return (...a) => { calls.push(k); }; }, set(o, k, v) { o[k] = v; return true; } }); };
function spawnMech() {
  const s = L.createState(); s.hpMode = true; s.level = gate.level; s.wave = L.LEVEL_ORDER.indexOf(gate.level) + 1; s.walkLevel = true; s.holdWave = true;
  C.createCombat(s); E.ensureEvents(s);
  for (const tr of E.TRIGGERS.filter(x => x.level === gate.level && x.x < gate.x)) s.events.fired[tr.level + ':' + tr.x] = true;
  s.player.x = gate.x + 5; s.player.y = L.LEVELS[gate.level].walkables[0].y + 50; E.stepEvents(s, DT);
  s.ninjas = s.ninjas.filter(n => n.levelBoss);
  const bosses = B.createBosses({ rand }); bosses.step(s, DT);
  return { s, bosses, b: s.bossFight.active, n: s.bossFight.active.n };
}
function sim(s, bosses, input) {
  if (input) input(s);
  if (!C.inHitStop(s)) C.combatWalk(s, s.__dx || 0, s.__dy || 0, DT);
  C.combatStep(s, DT); if (C.inHitStop(s)) return;
  E.stepEvents(s, DT); L.update(s, DT); bosses.step(s, DT);
}
// Force an attack with the hero parked at dx, run until it recovers.
function runAttack(name, dx, opts = {}) {
  const { s, bosses, b, n } = spawnMech();
  b.mode = 'fight'; b.invuln = 0; b.cd = 0; b.phase = opts.phase ?? (name === 'missiles' ? 1 : 0);
  n.x = s.player.x + dx; n.y = s.player.y + (opts.dy || 0); s.invuln = 0; s.hp = 100; b.next = name;
  const r = { s, b, n, wind: null, active: null, hitAt: null, marker: 0, tt: 0, minDist: 1e9 };
  for (let i = 0; i < 6 / DT; i++) {
    if (opts.each) opts.each(s, b, r);
    sim(s, bosses); r.tt += DT;
    const a = b.atk;
    if (a && a.phase === 'wind' && r.wind == null) { r.wind = r.tt; r.a = a; }
    if (a && a.phase === 'wind' && !r.marker) { const ctx = mockCtx(); bosses.drawWorld(ctx, s, r.tt); r.marker = ctx.calls.filter(c => c === 'fillRect' || c === 'ellipse').length; }
    if (a && a.phase === 'active' && r.active == null) r.active = r.tt;
    if (s.hp < 100 && r.hitAt == null) r.hitAt = r.tt;
    r.minDist = Math.min(r.minDist, Math.abs(s.player.x - n.x)); if (s.playerDown > 0) r.wasDown = true;
    if (r.active != null && !b.atk) break;
  }
  return r;
}

t('art: 7 sliced parts with alpha, sizes match mech.js pivots, under the 400 KB budget', () => {
  let bytes = 0;
  for (const [k, p] of Object.entries(M.PARTS)) {
    const f = new URL('assets/enemies/mech/' + p.file, G), buf = fs.readFileSync(f); bytes += buf.length;
    assert.deepEqual([buf.readUInt32BE(16), buf.readUInt32BE(20)], [p.w, p.h], k + ' size');
    assert.ok(buf[25] === 6 || (buf[25] === 3 && buf.includes('tRNS')), k + ' has alpha');
  }
  assert.ok(bytes < 400 * 1024, bytes); console.log(`   parts: ${Object.keys(M.PARTS).length} files, ${(bytes / 1024).toFixed(0)} KB`);
});

t('placement: a mid-level gate in the OpenClaw Tower lobby; mini boss (not final), 2 phases', () => {
  assert.ok(gate && gate.type === 'miniBoss' && gate.event === 'gate', 'gate beat');
  const lv = E.TRIGGERS.filter(b => b.level === gate.level).sort((a, b) => a.x - b.x);
  assert.ok(lv.indexOf(gate) > 0 && lv.indexOf(gate) < lv.length - 1, 'mid-level, not the level end');
  assert.ok(gate.x < 1814, 'lobby tile'); assert.ok(!MECH.final); assert.equal(MECH.phases.length, 2);
  assert.deepEqual(new Set(MECH.attacks[0]), new Set(['claw', 'stomp', 'gatling'])); assert.ok(MECH.attacks[1].includes('missiles') && !MECH.attacks[0].includes('missiles'), 'missiles in phase 2');
});

t('boss.js adopts it as CLAW WALKER with the shared boss bar (mech part rig, ungrabbable)', () => {
  const { s, n } = spawnMech();
  assert.ok(n.mech && n.scripted && n.boss && n.elite, 'mech flags'); assert.equal(n.name, 'CLAW WALKER');
  assert.ok(s.bossBar && s.bossBar.name === 'CLAW WALKER' && s.bossBar.phases === 2 && s.bossBar.drawnBy === 'boss.js');
  const ctx = mockCtx(); const bosses = B.createBosses(); assert.ok(bosses.drawHud(ctx, s, DT, 740, 510), 'bar drawn');
});

t('every attack telegraphs >= 0.5 s with a marker; damage only once the hitbox is live', () => {
  for (const [name, dx] of [['claw', 90], ['stomp', 150], ['gatling', 260], ['missiles', 240]]) {
    const r = runAttack(name, dx);
    assert.ok(r.wind != null && r.active != null, name + ' ran');
    assert.ok(r.active - r.wind >= 0.5 - 1e-6 && r.active - r.wind <= 0.95, `${name} wind ${(r.active - r.wind).toFixed(2)}`);
    assert.ok(r.marker > 0, name + ' marker'); assert.ok(r.hitAt != null && r.hitAt >= r.active - 1e-9, name + ' hit after active');
    console.log(`   ${name}: ${(r.active - r.wind).toFixed(2)}s wind, hit ${(100 - r.s.hp)} hp`);
  }
});

t('stomp shockwave is jumpable; gatling only hits its lane; invulnerable hero is not hit', () => {
  // a real jump, timed to the wave front reaching the hero (150 px at the stomp speed)
  const jump = runAttack('stomp', 150, { each: (s, b) => { const a = b.atk; if (a && a.phase === 'active' && (a.active - a.t) > 150 / B.ATTACKS.stomp.speed - 0.2 && !s.combat.airborne && !s.__j) { s.__j = 1; C.combatPress(s, 'jump'); } } });
  assert.equal(jump.hitAt, null, 'airborne hero clears the stomp wave');
  // the sweep is aimed down the hero's lane at wind-up; stepping out of it during the wind-up dodges
  const lane = runAttack('gatling', 260, { each: (s, b) => { if (b.atk && b.atk.phase === 'wind' && !s.__moved) { s.__moved = 1; s.player.y -= 40; } } });
  assert.equal(lane.hitAt, null, 'out of the lane: no hit');
  const stay = runAttack('gatling', 260); assert.ok(stay.hitAt != null, 'in the lane: hit');
  const inv = runAttack('claw', 90, { each: s => { s.invuln = 1; } });
  assert.equal(inv.hitAt, null, 'player i-frames respected');
});

t('phase-2 missile barrage: 5 ground markers, one on the hero', () => {
  const r = runAttack('missiles', 240);
  assert.equal(r.a.mines.length, 5);
  const L0 = r.s.events.lock ? r.s.events.lock.L : r.s.cameraX;
  assert.ok(r.a.mines.some(m => Math.abs(L0 + m.sx - r.s.player.x) < 60), 'a marker on the hero');
});

t('claw grab: a hit reels the hero in and knocks them down', () => {
  const r = runAttack('claw', 120);
  assert.ok(r.hitAt != null, 'grabbed'); assert.ok(r.s.bossFight.log.some(l => l.ev === 'grab'));
  assert.ok(r.minDist < 85, 'pulled in to ' + r.minDist.toFixed(0)); assert.ok(r.wasDown, 'knockdown');
});

t('weak point: the cockpit opens after an attack (double damage), armour halves damage otherwise', () => {
  const { s, bosses, b, n } = spawnMech(); b.mode = 'fight'; b.invuln = 0;
  const hit = dmg => { const before = b.hp; L.damageNinja(s, n, dmg); bosses.step(s, DT); return before - b.hp; };
  b.atk = null; b.cd = 99; const closed = hit(2);
  assert.ok(!s.bossBar.weak && !n.weakOpen); assert.equal(closed, 2 * MECH.armor);
  b.atk = { type: 'swipe', name: 'claw', phase: 'recover', t: 0.8, wind: 0.7, active: 0.16, rec: 0.9, face: 1 };
  const open = hit(2); assert.equal(open, 2 * MECH.weak); assert.ok(n.weakOpen && s.bossBar.weak, 'cockpit glows');
  assert.ok(open >= 4 * closed, 'punish window is worth 4x');
  b.atk = null; b.mode = 'stagger'; assert.equal(hit(1), MECH.weak, 'open after a poise break (stagger) too');
  const ctx = mockCtx(); for (const k of Object.keys(M.PARTS)) M.mechImages[k] = { width: 10, height: 10 };
  assert.ok(M.drawMech(ctx, n, 1), 'draws'); assert.ok(ctx.calls.includes('drawImage') && ctx.calls.includes('strokeText'), 'glow + weak-point arrow drawn while open');
  n.weakOpen = false; const c2 = mockCtx(); M.drawMech(c2, n, 1); assert.ok(!c2.calls.includes('strokeText'), 'no arrow when closed');
});

t('attack token: minion attackers stay at maxTokens-1 while the mech attacks', () => {
  const { s, bosses, b, n } = spawnMech(); s.wave = 4; b.mode = 'fight'; b.invuln = 0; b.cd = 0;
  for (let i = 0; i < 4; i++) s.ninjas.push({ kind: 'brawler', level: s.level, x: s.player.x - 60 - i * 30, y: s.player.y, r: 17, hp: 99, maxHp: 99, vx: 0, vy: 0 });
  let worst = 0, during = 0;
  for (let i = 0; i < 12 / DT; i++) { s.hp = 100; s.invuln = 0; sim(s, bosses); if (b.atk) { during++; worst = Math.max(worst, s.ninjas.filter(m => !m.dead && !m.scripted && m.token).length); } }
  assert.ok(during > 0); assert.ok(worst <= C.maxTokens(s) - 1, `${worst} <= ${C.maxTokens(s) - 1}`);
});

t('phase 2 at half HP (drones join), defeat signal is non-final; the run goes on to SHREDCLAW', () => {
  const { s, bosses, b, n } = spawnMech(); b.mode = 'fight'; b.invuln = 0;
  b.hp = b.thresholds[0] + 0.5; L.damageNinja(s, n, 1); bosses.step(s, DT);
  assert.equal(b.phase, 1); assert.ok(s.ninjas.filter(m => m.kind === 'drone').length >= 2, 'drones');
  let info = null; s.onBossDefeated = i => { info = i; };
  b.invuln = 0; b.mode = 'fight'; b.atk = null; b.hp = 0.5; n.hp = 0.5 + 0; b.nhp = n.hp; L.damageNinja(s, n, 5); bosses.step(s, DT);
  assert.ok(info && info.id === 'mech' && info.name === 'CLAW WALKER' && !info.final);
  assert.ok(s.bossDefeated && !s.bossDefeated.final); s.ninjas = []; E.stepEvents(s, DT); assert.ok(!s.runComplete, 'not the end of the run');
  assert.ok(E.TRIGGERS.some(x => x.level === gate.level && x.x > gate.x && x.kinds.includes('boss')), 'SHREDCLAW later in the level');
});

t('part rig: walk swings the legs and bobs; claw / stomp / missile poses move their parts', () => {
  const n = { x: 0, y: 0, r: 30, vx: 60, vy: 0, face: 1, scale: 1.6 };
  const a = M.mechPose(n, 0), b = M.mechPose(n, 0.2), c = M.mechPose(n, 0.4);
  assert.ok(Math.abs(a.near.th - c.near.th) > 0.05 && Math.sign(a.near.th - a.far.th) !== Math.sign(c.near.th - c.far.th) || Math.abs(b.near.th - a.near.th) > 0.05, 'legs swing');
  assert.ok(new Set([a.bob, b.bob, c.bob].map(v => v.toFixed(2))).size > 1, 'torso bob');
  const at = (name, phase, k, extra = {}) => M.mechPose({ ...n, vx: 0, mechAtk: { name, phase, t: (1 - k), wind: 1, active: 1, rec: 1, ...extra } }, 1);
  assert.ok(at('claw', 'wind', 0.9).claw < -0.5 && at('claw', 'active', 0.9).claw > 0.2, 'claw raises then swipes');
  assert.ok(at('stomp', 'wind', 0.9).near.th > 0.5, 'stomp lifts the leg');
  assert.ok(at('missiles', 'wind', 0.9).pod < -0.4, 'pod tilts up'); assert.ok(at('gatling', 'active', 0.5).muzzle > 0, 'muzzle flash');
});

t('beatable: a simple bot beats the mech one-on-one, using the punish window', () => {
  seed = 21; const { s, bosses, b, n } = spawnMech(); let cd = 0, tt = 0, minHp = 100;
  const input = st => {
    const p = st.player; st.__dx = 0; st.__dy = 0; const a = b.atk, dx = n.x - p.x, dy = n.y - p.y;
    if (a && a.phase === 'wind' && (a.type === 'gatling') && Math.abs(a.y - p.y) < 30) { st.__dy = p.y > 430 ? -1 : 1; return; }
    if (a && a.phase === 'wind' && (a.type === 'wave' || a.type === 'mines') && a.t < 0.15 && !st.combat.airborne) { C.combatPress(st, 'jump'); return; }
    if (a && a.phase === 'wind' && a.type === 'swipe') { st.__dx = -Math.sign(dx || 1); return; }
    st.__dy = Math.abs(dy) > 6 ? Math.sign(dy) : 0;
    if (Math.abs(dx) > 75) st.__dx = Math.sign(dx); else if (Math.abs(dx) < 40) st.__dx = -Math.sign(dx || 1); else if (st.combat.facing !== Math.sign(dx)) st.__dx = Math.sign(dx);
    if (Math.abs(dx) < 110 && Math.abs(dy) < 12 && cd <= 0) { C.combatPress(st, 'punch'); cd = 0.16; }
  };
  for (let i = 0; i < 240 / DT && !s.over; i++) { cd -= DT; tt += DT; sim(s, bosses, input); minHp = Math.min(minHp, s.hp); if (s.bossDefeated) break; }
  const weak = s.bossFight.log.filter(l => l.ev === 'weakHit').length, armor = s.bossFight.log.filter(l => l.ev === 'armorHit').length;
  console.log(`   bot: beat ${MECH.name} in ${tt.toFixed(0)}s, lives ${s.lives}, min hp ${minHp}, hits: ${weak} weak-point / ${armor} armour`);
  assert.ok(s.bossDefeated && s.bossDefeated.id === 'mech', 'beaten'); assert.ok(!s.over); assert.ok(weak > 0, 'punish window used');
});
console.log(`${pass}/${total} passed`);
