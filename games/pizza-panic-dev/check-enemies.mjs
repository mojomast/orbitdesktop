// Iteration-10 enemy checks (enemies-ext.js, baba_booey): claw ninja, shield
// brute, flamethrower bot.
//  - three distinct types (look, body, behaviour), layered onto every walking
//    level's event beats
//  - every attack telegraphs (>= 0.5 s wind + drawn marker) before its hitbox
//    is live, and a hit reaction cancels it
//  - ninja dodges / teleports; brute blocks frontal hits, falls to back hits,
//    jump kicks and grabs (3 blocks rattle its guard); flamer keeps its distance
//    and leaves short-lived burning ground that a jump clears
//  - attack tokens hold across regular + new enemies
//  - a simple bot clears a mixed arena
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const E = await import(G + 'events.js');
const S = await import(G + 'skate.js');
const X = await import(G + 'enemies-ext.js');
let pass = 0, total = 0; const t = (name, fn) => { total++; fn(); pass++; console.log('PASS', name); };
const DT = 1 / 120;
let seed = 5; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const fresh = (level = 0) => { const s = L.createState(); s.hpMode = true; s.level = level; s.wave = 1; s.walkLevel = true; s.holdWave = true; C.createCombat(s); E.ensureEvents(s); s.player.x = 600; s.player.y = L.LEVELS[level].walkables[0].y + 40; for (const tr of E.TRIGGERS) s.events.fired[tr.level + ':' + tr.x] = true; return s; }; // no scripted spawns unless a check asks
function sim(s, ext, input) {
  if (input) input(s);
  if (!C.inHitStop(s)) C.combatWalk(s, s.__dx || 0, s.__dy || 0, DT);
  C.combatStep(s, DT);
  if (C.inHitStop(s)) return;
  E.stepEvents(s, DT); L.update(s, DT); ext.step(s, DT);
}
const mockCtx = () => { const calls = []; return new Proxy({ calls }, { get(o, k) { if (k in o) return o[k]; if (k === 'measureText') return () => ({ width: 10 }); return () => calls.push(k); }, set(o, k, v) { o[k] = v; return true; } }); };
const spawnAt = (s, ext, type, dx, dy = 0) => ext.spawn(s, type, s.player.x + dx, s.player.y + dy);

t('three distinct new types with their own look, body and HP', () => {
  const T = X.EXT_TYPES, ids = Object.keys(T);
  assert.deepEqual(ids, ['clawninja', 'shieldbrute', 'flamebot']);
  assert.equal(new Set(ids.map(k => T[k].rig + T[k].tint)).size, 3);
  assert.ok(T.clawninja.hp < T.flamebot.hp && T.flamebot.hp < T.shieldbrute.hp, 'ninja low HP, brute high');
  assert.ok(T.clawninja.speed > T.flamebot.speed && T.flamebot.speed > T.shieldbrute.speed, 'ninja fast, brute slow');
  assert.equal(T.shieldbrute.kind, 'blocker', 'brute uses combat.js frontal guard');
});

t('spawns are layered onto event beats on every walking level (all three types used)', () => {
  const used = new Set();
  for (const lv of [0, 1, 2]) {
    const s = fresh(lv); s.events.fired = {}; const ext = X.createEnemiesExt({ rand });
    const kinds = new Set();
    for (const tr of E.TRIGGERS.filter(x => x.level === lv)) {
      s.events.lock = null; s.events.cooldown = 0; s.ninjas = [];
      s.player.x = tr.x + 2; E.stepEvents(s, DT); ext.step(s, DT);
      for (const n of s.ninjas) if (X.isExt(n)) { kinds.add(n.ext); used.add(n.ext); assert.ok(n.scripted && n.rigKind && n.tint); }
    }
    assert.ok(kinds.size >= 2, `level ${lv}: ${[...kinds].join(',')}`);
    console.log(`   level ${lv}: ${[...kinds].join(', ')}`);
  }
  assert.equal(used.size, 3);
});

t('every attack telegraphs (>= 0.5 s wind + marker) before its hitbox is live', () => {
  const cases = [['clawninja', 'stars', 200], ['clawninja', 'blink', 200], ['shieldbrute', 'slam', 80], ['shieldbrute', 'rush', 220], ['flamebot', 'flame', 160]];
  for (const [type, atk, dx] of cases) {
    seed = 3; const s = fresh(0); const ext = X.createEnemiesExt({ rand: () => (atk === 'blink' ? 0.001 : rand()) });
    const n = spawnAt(s, ext, type, dx); n.face = -1; n.xs.cd = 0;
    let wind = null, active = null, hitAt = null, marker = 0, tt = 0;
    for (let i = 0; i < 8 / DT; i++) {
      s.invuln = 0; if (s.hp < 60) s.hp = 100;
      if (!n.xs.atk && !wind) { n.xs.cd = 0; n.x = s.player.x + dx; n.y = s.player.y; }
      const hp0 = s.hp;
      sim(s, ext); tt += DT;
      const a = n.xs.atk;
      if (a && a.type !== atk && a.phase === 'wind' && wind == null) { n.xs.atk = null; n.atk = null; n.token = false; continue; }
      if (a && a.phase === 'wind' && wind == null) wind = tt;
      if (a && a.phase === 'wind' && !marker) { const ctx = mockCtx(); ext.drawWorld(ctx, s, tt); marker = ctx.calls.length; }
      if (a && a.phase === 'active' && active == null) active = tt;
      if (s.hp < hp0 && hitAt == null && wind != null) { hitAt = tt; break; }
      if (active != null && !a) break;
    }
    assert.ok(wind != null && active != null, `${type} ${atk}: wind + active`);
    assert.ok(active - wind >= 0.5 - 1e-6, `${atk} telegraph ${(active - wind).toFixed(2)}s`);
    assert.ok(marker > 0, atk + ' marker drawn');
    assert.ok(hitAt != null && hitAt >= active - 1e-9, `${atk}: hit lands only once active (${hitAt})`);
    console.log(`   ${type} ${atk}: telegraph ${(active - wind).toFixed(2)}s, hit at +${(hitAt - wind).toFixed(2)}s`);
  }
});

t('a hit reaction during the wind-up cancels the attack (no damage)', () => {
  const s = fresh(0); const ext = X.createEnemiesExt({ rand });
  const n = spawnAt(s, ext, 'flamebot', 160); n.xs.cd = 0;
  for (let i = 0; i < 300 && !(n.xs.atk && n.xs.atk.phase === 'wind'); i++) { n.x = s.player.x + 160; n.y = s.player.y; sim(s, ext); }
  assert.ok(n.xs.atk, 'winding');
  C.react(s, n, 'stagger', 1, 100); const hp = s.hp;
  for (let i = 0; i < 0.4 / DT; i++) sim(s, ext);
  assert.equal(n.xs.atk, null); assert.equal(s.hp, hp); assert.equal(n.token, false, 'token released');
});

t('claw ninja reads the hero wind-up and blinks away', () => {
  let dodges = 0;
  for (let k = 0; k < 6; k++) {
    seed = 20 + k; const s = fresh(0); const ext = X.createEnemiesExt({ rand });
    const n = spawnAt(s, ext, 'clawninja', 70); n.xs.cd = 5;
    ext.step(s, DT); s.combat.facing = 1; C.combatPress(s, 'kick');
    const x0 = n.x; sim(s, ext);
    if (Math.abs(n.x - x0) > 100) dodges++;
  }
  assert.ok(dodges >= 2 && dodges <= 5, 'dodges sometimes, not always: ' + dodges + '/6');
});

t('shield brute: frontal punches blocked, back hits and jump kicks land, 3 blocks rattle the guard (grabbable)', () => {
  const s = fresh(0); const ext = X.createEnemiesExt({ rand });
  const n = spawnAt(s, ext, 'shieldbrute', 70); n.face = -1; n.xs.cd = 99;
  const hp0 = n.hp;
  const punch = () => { s.combat.facing = 1; C.combatPress(s, 'punch'); for (let i = 0; i < 0.36 / DT; i++) { n.x = s.player.x + 70; n.y = s.player.y; n.face = -1; sim(s, ext); } };
  punch();
  assert.equal(n.hp, hp0, 'frontal jab blocked');
  punch(); punch();
  assert.ok(ext.info(s).log.some(l => l.ev === 'guardBreak'), 'guard break after 3 blocks');
  // rattled: grab it by walking in
  const before = s.combat.grab;
  s.combat.attack = null; s.combat.phase = 'idle'; n.x = s.player.x + 45; n.y = s.player.y;
  C.combatWalk(s, 1, 0, DT);
  assert.ok(!before && s.combat.grab && s.combat.grab.n === n, 'grabbed while rattled');
  // from behind
  const s2 = fresh(0); const ext2 = X.createEnemiesExt({ rand });
  const m = spawnAt(s2, ext2, 'shieldbrute', 70); m.face = 1; m.xs.cd = 99; m.xs.turnT = -99; // facing away
  s2.combat.facing = 1; C.combatPress(s2, 'punch');
  for (let i = 0; i < 0.3 / DT; i++) { m.x = s2.player.x + 70; m.y = s2.player.y; m.face = 1; sim(s2, ext2); }
  assert.ok(m.hp < X.EXT_TYPES.shieldbrute.hp, 'hit from behind lands');
  // jump kick
  const s3 = fresh(0); const ext3 = X.createEnemiesExt({ rand });
  const o = spawnAt(s3, ext3, 'shieldbrute', 60); o.face = -1; o.xs.cd = 99;
  s3.combat.facing = 1; C.combatPress(s3, 'jump');
  for (let i = 0; i < 0.12 / DT; i++) sim(s3, ext3);
  C.combatPress(s3, 'kick');
  for (let i = 0; i < 0.4 / DT; i++) { o.x = s3.player.x + 60; o.y = s3.player.y; o.face = -1; sim(s3, ext3); }
  assert.ok(o.hp < X.EXT_TYPES.shieldbrute.hp, 'jump kick pierces the guard');
  // pizzas from the front bounce off
  const s4 = fresh(0); const ext4 = X.createEnemiesExt({ rand });
  const q = spawnAt(s4, ext4, 'shieldbrute', 150); q.face = -1; q.xs.cd = 99; ext4.step(s4, DT);
  s4.weaponLevel = 3; L.throwPizza(s4);
  for (let i = 0; i < 0.5 / DT; i++) { q.x = s4.player.x + 150; q.y = s4.player.y; q.face = -1; sim(s4, ext4); }
  assert.equal(q.hp, X.EXT_TYPES.shieldbrute.hp, 'frontal pizza blocked');
});

t('flamethrower bot keeps its distance; flame leaves burning ground that ticks, expires, and a jump clears', () => {
  const s = fresh(1); const ext = X.createEnemiesExt({ rand });
  const n = spawnAt(s, ext, 'flamebot', 60); n.xs.cd = 99;
  for (let i = 0; i < 1.5 / DT; i++) sim(s, ext);
  assert.ok(Math.abs(n.x - s.player.x) > 140, 'backed off to ' + Math.round(Math.abs(n.x - s.player.x)));
  n.xs.cd = 0; s.hp = 100;
  let burns = 0;
  for (let i = 0; i < 4 / DT; i++) { s.invuln = Math.min(s.invuln, 2); sim(s, ext); burns = Math.max(burns, ext.info(s).burns); }
  assert.ok(burns >= 3 && burns % 3 === 0, 'three burn patches per flame: ' + burns);
  s.ninjas = []; for (let i = 0; i < 2.5 / DT; i++) sim(s, ext);
  assert.equal(ext.info(s).burns, 0, 'burns expire');
  // stand on a burn: ticks; jump over it: no tick
  const X2 = s.ext; X2.burns.push({ x: s.player.x, y: s.player.y, t: 2, cd: 0 }); s.invuln = 0; const hp = s.hp;
  s.ninjas = []; ext.step(s, DT); assert.ok(s.hp < hp, 'burn ticks');
  X2.burns = [{ x: s.player.x, y: s.player.y, t: 2, cd: 0 }]; s.invuln = 0; s.player.z = 60; const hp2 = s.hp; ext.step(s, DT); assert.equal(s.hp, hp2, 'jump clears');
});

t('attack tokens hold across regular and new enemies', () => {
  const s = fresh(2); s.wave = 4; const ext = X.createEnemiesExt({ rand });
  for (const [k, dx] of [['clawninja', 200], ['clawninja', -200], ['flamebot', 180], ['shieldbrute', -90], ['flamebot', -170]]) spawnAt(s, ext, k, dx);
  for (let i = 0; i < 4; i++) s.ninjas.push({ kind: 'brawler', level: 2, x: s.player.x + 100 + i * 30, y: s.player.y, r: 17, hp: 99, maxHp: 99, vx: 0, vy: 0 });
  let worst = 0, extAtk = 0;
  for (let i = 0; i < 25 / DT; i++) { s.hp = 100; s.invuln = 0.3; sim(s, ext); const h = s.ninjas.filter(m => !m.dead && m.token).length; worst = Math.max(worst, h); if (s.ninjas.some(m => X.isExt(m) && m.xs.atk)) extAtk++; }
  assert.ok(extAtk > 0, 'new enemies attacked');
  assert.ok(worst <= C.maxTokens(s), `token holders ${worst} <= ${C.maxTokens(s)}`);
});

t('beatable: a simple bot clears a mixed arena of all three types', () => {
  seed = 9; const s = fresh(0); const ext = X.createEnemiesExt({ rand });
  for (const [k, dx] of [['clawninja', 250], ['shieldbrute', -200], ['flamebot', 300]]) spawnAt(s, ext, k, dx);
  let tt = 0, cd = 0, minHp = 100;
  const input = st => {
    const p = st.player, live = st.ninjas.filter(m => !m.dead);
    st.__dx = 0; st.__dy = 0; if (!live.length) return;
    const tgt = live.sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
    const dx = tgt.x - p.x, dy = tgt.y - p.y;
    st.__dy = Math.abs(dy) > 6 ? Math.sign(dy) : 0;
    if (Math.abs(dx) > 70) st.__dx = Math.sign(dx); else if (st.combat.facing !== Math.sign(dx)) st.__dx = Math.sign(dx);
    if (Math.abs(dx) < 110 && Math.abs(dy) < 12 && cd <= 0) {
      // shield up front? jump kick it
      if (tgt.ext === 'shieldbrute' && Math.sign(p.x - tgt.x) === tgt.face && !st.combat.airborne) { C.combatPress(st, 'jump'); C.combatPress(st, 'kick'); cd = 0.5; }
      else { C.combatPress(st, st.combat.airborne ? 'kick' : 'punch'); cd = 0.16; }
    }
  };
  for (let i = 0; i < 120 / DT && !s.over; i++) { cd -= DT; tt += DT; sim(s, ext, input); minHp = Math.min(minHp, s.hp); if (!s.ninjas.some(n => !n.dead)) break; }
  assert.ok(!s.ninjas.some(n => !n.dead), 'arena cleared'); assert.ok(!s.over);
  console.log(`   cleared in ${tt.toFixed(0)}s, min hp ${minHp}, lives ${s.lives}`);
});
console.log(`${pass}/${total} passed`);
