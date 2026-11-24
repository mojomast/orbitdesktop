// Boss fight checks (boss.js, baba_booey):
//  - each level (sewer, street, skate, rooftop) maps to a distinct boss, and the
//    real gate spawn of that level (events.js / skate.js) is adopted as it
//  - phases change exactly at the HP thresholds (overkill never skips a phase,
//    the phase-change beat is invulnerable)
//  - every attack's telegraph (wind-up + drawn marker) precedes its active hitbox
//  - the boss holds an attack token (minion attackers capped at max-1)
//  - defeat sets the signal (state.bossDefeated, onBossDefeated, window event)
//  - a simple punch-spamming bot beats every boss but takes real damage
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent(e) { (globalThis.__events ||= []).push(e); return true; } };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const E = await import(G + 'events.js');
const S = await import(G + 'skate.js');
const B = await import(G + 'boss.js');
let pass = 0, total = 0; const t = (name, fn) => { total++; fn(); pass++; console.log('PASS', name); };
const NAMES = { 0: 'sewer', 1: 'street', 3: 'skate', 2: 'rooftop', 4: 'tower', 5: 'subway' }; // cheese: subway
const DT = 1 / 120;
let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function fresh(level) {
  const s = L.createState(); s.hpMode = true; s.level = level; s.wave = L.LEVEL_ORDER.indexOf(level) + 1;
  C.createCombat(s); E.ensureEvents(s);
  return s;
}
// Bring up the level's real boss spawn: the gate trigger (events.js) or the
// Claw Rider beat (skate.js).
function spawnBoss(level) {
  const s = fresh(level);
  if (level === L.SKATE_LEVEL) {
    s.holdWave = true; s.skateStart = true; S.stepSkate(s, DT);
    s.skate.beat = S.BEATS.length - 1; s.skate.dist = S.BEATS[S.BEATS.length - 1].at; S.stepSkate(s, DT);
  } else {
    s.walkLevel = true; s.holdWave = true;
    const gate = E.TRIGGERS.filter(x => x.level === level).pop();
    for (const tr of E.TRIGGERS.filter(x => x.level === level && x !== gate)) s.events.fired[tr.level + ':' + tr.x] = true;
    s.player.x = gate.x + 5; s.player.y = L.LEVELS[level].walkables[0].y + 40;
    E.stepEvents(s, DT);
    s.ninjas = s.ninjas.filter(n => n.levelBoss); // fight the boss alone in unit checks
  }
  return s;
}
function sim(s, bosses, dt = DT, input = null) {
  if (input) input(s);
  if (!C.inHitStop(s)) { C.combatWalk(s, s.__dx || 0, s.__dy || 0, dt); S.stepSkate(s, dt); }
  C.combatStep(s, dt);
  if (C.inHitStop(s)) return;
  E.stepEvents(s, dt);
  L.update(s, dt);
  bosses.step(s, dt);
}
const mockCtx = () => { const calls = []; const ctx = new Proxy({ calls }, { get(o, k) { if (k in o) return o[k]; if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} }); if (k === 'measureText') return () => ({ width: 60 }); return (...a) => { calls.push(k); }; }, set(o, k, v) { o[k] = v; return true; } }); return ctx; };

t('each level maps to a distinct boss (name, look, phases) and adopts the real gate spawn', () => {
  const ids = new Set(), names = new Set(), looks = new Set();
  for (const lv of L.LEVEL_ORDER) {
    const d = B.bossFor(lv);
    ids.add(d.id); names.add(d.name); looks.add(d.rig + '|' + d.tint);
    assert.ok(d.phases.length >= 2 && d.phases.length <= 3, d.name + ' has 2-3 phases');
    const s = spawnBoss(lv); const bosses = B.createBosses({ rand });
    bosses.step(s, DT);
    const a = bosses.info(s).active;
    assert.ok(a, NAMES[lv] + ': boss adopted'); assert.equal(a.name, d.name);
    const n = s.ninjas.find(m => m.__boss === d.id);
    assert.ok(n.scripted && n.rigKind === d.rig && n.tint === d.tint && n.scale === d.scale, 'look applied');
    console.log(`   ${NAMES[lv]}: ${d.name} (${d.rig} rig x${d.scale}, ${d.phases.length} phases, ${d.hp} HP) attacks ${[...new Set(d.attacks.flat())].join('/')}`);
  }
  const nb = L.LEVEL_ORDER.length; assert.equal(ids.size, nb); assert.equal(names.size, nb); assert.equal(looks.size, nb);
});

t('phase transitions land exactly at the HP thresholds; the change beat is invulnerable; overkill never skips a phase', () => {
  for (const lv of L.LEVEL_ORDER) {
    const s = spawnBoss(lv); const bosses = B.createBosses({ rand }); bosses.step(s, DT);
    const d = B.bossFor(lv);
    const n = s.ninjas.find(m => m.__boss);
    const th = d.phases.slice(1).map(f => Math.max(1, Math.round(d.hp * f)));
    const wait = sec => { for (let i = 0; i < sec / DT; i++) bosses.step(s, DT); };
    wait(1.3); // intro invulnerability
    // During intro/phase invuln a hit is undone.
    let hp = bosses.info(s).active.hp;
    for (let ph = 0; ph < th.length; ph++) {
      // overkill: one huge hit must stop at the threshold, not kill or skip
      L.damageNinja(s, n, 999); bosses.step(s, DT);
      const a = bosses.info(s).active;
      assert.ok(a && !n.dead, NAMES[lv] + ' survives overkill in phase ' + (ph + 1));
      assert.equal(a.hp, th[ph], `${NAMES[lv]} hp clamps to threshold ${th[ph]}`);
      assert.equal(a.phase, ph + 2, 'phase advanced');
      assert.ok(a.invuln > 1, 'phase-change invulnerability');
      L.damageNinja(s, n, 3); bosses.step(s, DT);
      assert.equal(bosses.info(s).active.hp, th[ph], 'no damage while invulnerable');
      wait(1.3);
      hp = bosses.info(s).active.hp;
    }
    // last phase: 1-damage hits walk the bar down, then the boss dies
    for (let i = 0; i < 200 && bosses.info(s).active; i++) { L.damageNinja(s, n, 1); bosses.step(s, DT); }
    assert.equal(bosses.info(s).active, null, NAMES[lv] + ' defeated');
    const log = s.bossFight.log.filter(l => l.ev === 'phase').map(l => l.hp);
    assert.deepEqual(log, th, 'phase log at thresholds');
    console.log(`   ${NAMES[lv]}: thresholds ${th.join(', ')} of ${d.hp}`);
  }
});

t('every attack type telegraphs (>= 0.5 s wind + drawn marker) before its hitbox goes live', () => {
  const seen = {};
  for (const lv of L.LEVEL_ORDER) {
    const d = B.bossFor(lv);
    for (const type of new Set(d.attacks.flat())) {
      const s = spawnBoss(lv); const bosses = B.createBosses({ rand }); bosses.step(s, DT);
      const b = s.bossFight.active, n = b.n;
      b.mode = 'fight'; b.invuln = 0; b.phase = d.phases.length - 1; b.cd = 0;
      // Hero stands in harm's way (in lane, in range) and does nothing.
      if (lv === L.SKATE_LEVEL) { n.x = s.cameraX + 600; n.y = s.player.y; }
      else { n.x = s.player.x + (type === 'swipe' ? 70 : type === 'slam' ? 150 : 240); n.y = s.player.y; }
      s.invuln = 0; s.hp = 100;
      b.next = type; s.bossFight.log.length = 0;
      let wind = null, active = null, hitAt = null, marker = 0, tt = 0;
      for (let i = 0; i < 6 / DT; i++) {
        sim(s, bosses); tt += DT;
        const a = b.atk;
        if (a && a.phase === 'wind' && wind == null) wind = tt;
        if (a && a.phase === 'wind' && wind != null && !marker) { const ctx = mockCtx(); bosses.drawWorld(ctx, s, tt); marker = ctx.calls.filter(c => c === 'fillRect' || c === 'ellipse').length; }
        if (a && a.phase === 'active' && active == null) active = tt;
        if (s.hp < 100 && hitAt == null) { hitAt = tt; break; }
        if (active != null && !b.atk) break;
      }
      assert.ok(wind != null && active != null, `${d.name} ${type}: wind and active seen`);
      assert.ok(active - wind >= 0.5 - 1e-6 && active - wind <= 0.95, `${type} telegraph ${(active - wind).toFixed(2)}s`);
      assert.ok(marker > 0, `${type} draws a telegraph marker`);
      if (hitAt != null) assert.ok(hitAt >= active - 1e-9, `${type}: damage only after the hitbox is active`);
      (seen[type] ||= []).push(`${d.id}:${(active - wind).toFixed(2)}s${hitAt != null ? ' hit' : ''}`);
    }
  }
  for (const [k, v] of Object.entries(seen)) console.log(`   ${k}: ${v.join(', ')}`);
  const mini = new Set(Object.values(B.MINI_BOSSES || {}).flatMap(d => d.attacks.flat())); // mini-boss attacks: check-mech.mjs
  for (const k of Object.keys(B.ATTACKS)) if (!mini.has(k)) assert.ok(seen[k], 'attack used by some boss: ' + k);
});

t('a jump clears ground attacks (shockwave) — telegraphs are reactable', () => {
  const s = spawnBoss(0); const bosses = B.createBosses({ rand }); bosses.step(s, DT);
  const b = s.bossFight.active, n = b.n; b.mode = 'fight'; b.invuln = 0; b.phase = 1; b.cd = 0; b.next = 'wave';
  n.x = s.player.x + 200; n.y = s.player.y; s.hp = 100; s.invuln = 0;
  let jumped = false;
  for (let i = 0; i < 4 / DT; i++) {
    sim(s, bosses);
    if (b.atk && b.atk.phase === 'active' && !jumped) { jumped = true; }
    if (b.atk && b.atk.phase === 'wind' && b.atk.t < 0.12 && !s.combat.airborne) C.combatPress(s, 'jump');
  }
  assert.ok(jumped); assert.equal(s.hp, 100, 'jumped over the shockwave');
});

t('the boss holds an attack token: minion attackers are capped at maxTokens-1 while it attacks', () => {
  const s = spawnBoss(2); const bosses = B.createBosses({ rand }); bosses.step(s, DT);
  for (let i = 0; i < 5; i++) s.ninjas.push({ kind: 'striker', level: 2, x: s.player.x + 120 + i * 40, y: s.player.y, r: 14, hp: 50, maxHp: 50, vx: 0, vy: 0 });
  const b = s.bossFight.active; b.mode = 'fight'; b.invuln = 0;
  let worst = 0, during = 0;
  for (let i = 0; i < 20 / DT; i++) {
    s.hp = 100; s.invuln = 0.5; // keep the hero alive and standing
    sim(s, bosses);
    if (b.atk) { during++; const holders = s.ninjas.filter(m => !m.dead && !m.scripted && m.token).length; worst = Math.max(worst, holders); }
  }
  assert.ok(during > 0, 'boss attacked');
  assert.ok(worst <= C.maxTokens(s) - 1, `minion token holders during boss attacks: ${worst} <= ${C.maxTokens(s) - 1}`);
});

t('defeat sets the signal: state.bossDefeated, onBossDefeated(info), window event; final boss ends the run', () => {
  for (const lv of L.LEVEL_ORDER) {
    const s = spawnBoss(lv); const bosses = B.createBosses({ rand }); let cb = null; s.onBossDefeated = info => { cb = info; };
    globalThis.__events = [];
    bosses.step(s, DT);
    const b = s.bossFight.active; const n = b.n;
    b.phase = b.thresholds.length; b.invuln = 0; b.mode = 'fight'; b.hp = 2; n.hp = 2; b.nhp = 2;
    L.damageNinja(s, n, 5); L.update(s, DT); bosses.step(s, DT);
    const d = B.bossFor(lv);
    assert.ok(s.bossDefeated && s.bossDefeated.id === d.id && s.bossDefeated.name === d.name, NAMES[lv] + ' bossDefeated');
    assert.equal(s.bossDefeated.level, lv); assert.equal(s.bossDefeated.final, !!d.final);
    assert.ok(cb && cb.id === d.id, 'onBossDefeated called');
    assert.ok(globalThis.__events.some(e => e.type === 'pizzapanic:bossdefeated' && e.detail.id === d.id), 'window event');
    assert.equal(s.bossesDefeated, 1); assert.ok(!s.ninjas.includes(n), 'boss removed');
    if (d.final) { E.stepEvents(s, DT); assert.equal(s.runComplete, true, 'final boss: run complete (no wave after it)'); }
    else { E.stepEvents(s, DT); assert.ok(!s.runComplete, NAMES[lv] + ': a mini boss does not end the run'); }
  }
});

t('beatable: a simple bot defeats every boss one-on-one without running out of lives', () => {
  for (const lv of L.LEVEL_ORDER) {
    seed = 11 + lv;
    const s = spawnBoss(lv); const bosses = B.createBosses({ rand }); bosses.step(s, DT);
    const d = B.bossFor(lv); const n = s.bossFight.active.n;
    let tt = 0, cd = 0, minHp = 100, lost = 0, lastLives = s.lives;
    const input = st => {
      const p = st.player, live = st.ninjas.filter(m => !m.dead && !m.flyover);
      const tgt = live.filter(m => m.kind !== 'drone').sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0] || live[0];
      st.__dx = 0; st.__dy = 0;
      if (!tgt) return;
      const dx = tgt.x - p.x, dy = tgt.y - p.y;
      const a = st.bossFight.active && st.bossFight.active.atk;
      // dodge: step out of a telegraphed lane, jump ground waves
      if (a && a.phase === 'wind' && (a.type === 'charge' || a.type === 'swoop' || a.type === 'volley') && Math.abs((a.y ?? p.y) - p.y) < 30) { st.__dy = p.y > 420 ? -1 : 1; return; }
      if (a && a.phase === 'wind' && (a.type === 'wave' || a.type === 'mines' || a.type === 'slam') && a.t < 0.15 && !st.combat.airborne) { C.combatPress(st, 'jump'); return; }
      st.__dy = Math.abs(dy) > 6 ? Math.sign(dy) : 0;
      if (Math.abs(dx) > 70) st.__dx = Math.sign(dx);
      else if (Math.abs(dx) < 34) st.__dx = -Math.sign(dx || 1);
      else if (st.combat.facing !== Math.sign(dx)) st.__dx = Math.sign(dx);
      if (Math.abs(dx) < 110 && Math.abs(dy) < 12 && cd <= 0) { C.combatPress(st, 'punch'); cd = 0.16; }
    };
    for (let i = 0; i < 240 / DT && !s.over; i++) {
      cd -= DT; tt += DT;
      sim(s, bosses, DT, input);
      minHp = Math.min(minHp, s.hp); if (s.lives < lastLives) { lost += lastLives - s.lives; lastLives = s.lives; }
      if (!bosses.info(s).active && s.bossDefeated) break;
    }
    assert.ok(s.bossDefeated && s.bossDefeated.id === d.id, `${NAMES[lv]}: bot beat ${d.name} (t=${tt.toFixed(0)}s, hp ${s.hp}, lives ${s.lives})`);
    assert.ok(!s.over, 'bot survived');
    console.log(`   ${NAMES[lv]}: ${d.name} beaten in ${tt.toFixed(0)}s, min hp ${minHp}, continues used ${lost}, phases ${s.bossDefeated.phases}`);
  }
});
console.log(`${pass}/${total} passed`);
