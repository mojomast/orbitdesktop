// OpenClaw Tower checks (baba_booey): the final level (index 4) after the rooftop.
//  - level data: band, width, final place in LEVEL_ORDER, art strips in format
//  - beats: lobby -> server floor -> elevator arena -> penthouse, segmented
//    types incl. skater + drone, rising waves, scripted events, ext types
//  - final boss: the only kind 'boss' gate is the tower's; SHREDCLAW adopted
//    as the final boss; its defeat completes the run (no wave after it);
//    the rooftop now ends on a mini boss that hands over to the tower
//  - elevator: the arena stays locked across the climb's drops, the counter
//    climbs, it arrives, and it survives a same-frame wipe (relock)
//  - a bot plays the whole tower (bosses + new enemies + elevator) to the end
import assert from 'node:assert/strict';
import fs from 'node:fs';
const G = new URL('../pizza-panic/', import.meta.url);
const L = await import(G.href + 'logic.js');
const C = await import(G.href + 'combat.js');
const E = await import(G.href + 'events.js');
const K = await import(G.href + 'collision.js');
const B = await import(G.href + 'boss.js');
const X = await import(G.href + 'enemies-ext.js');
const T = await import(G.href + 'tower.js');
const S = await import(G.href + 'skate.js');
let pass = 0, total = 0; const t = (name, fn) => { total++; fn(); pass++; console.log('PASS', name); };
const DT = 1 / 120, TW = T.TOWER_LEVEL;
let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const fresh = () => { const s = L.createState(); s.hpMode = true; s.level = TW; s.wave = L.LEVEL_ORDER.indexOf(TW) + 1; s.walkLevel = true; s.holdWave = true; C.createCombat(s); E.ensureEvents(s); s.player.x = 80; s.player.y = K.LEVELS[TW].walkables[0].y + 50; return s; };
const beats = E.TRIGGERS.filter(b => b.level === TW).sort((a, b) => a.x - b.x);
const fireUpTo = (s, x) => { for (const b of beats) if (b.x < x) s.events.fired[b.level + ':' + b.x] = true; };
const mockCtx = () => new Proxy({}, { get(o, k) { if (k in o) return o[k]; if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} }); if (k === 'measureText') return () => ({ width: 60 }); return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
const pngInfo = f => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: b[25] }; };
const jpgSize = f => { const b = fs.readFileSync(f); let i = 2; while (i < b.length) { const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + len; } return null; };

t('tower is level 4, the final level, right after the rooftop; band covers the 3-tile world', () => {
  const lv = K.LEVELS[TW]; assert.equal(lv.id, 'tower'); assert.equal(lv.width, K.WORLD_W);
  const o = L.LEVEL_ORDER; assert.equal(o[o.length - 1], TW, 'tower is last'); assert.ok(o.indexOf(TW) > o.indexOf(2), 'after the rooftop');
  const b = lv.walkables[0]; assert.ok(b.x <= 0 && b.x + b.w >= lv.width);
  for (let x = 100; x < lv.width; x += 400) assert.ok(K.isWalkable(TW, x, b.y + b.h / 2, 16), 'walkable at ' + x);
  assert.ok(!K.isWalkable(TW, 1000, 300, 0) && !K.isWalkable(TW, 1000, 505, 0), 'walls / below the floor blocked');
  for (let i = 0; i < 20; i++) { const y = lv.spawnY(rand); assert.ok(y > b.y && y < b.y + b.h, 'spawnY in band'); }
});

t('art: lobby / server floor / throne strips (1814x510 with alpha) and the far layer', () => {
  const dir = new URL('assets/levels/', G).pathname;
  for (const f of ['tower_mid.png', 'tower_server_mid.png', 'tower_throne_mid.png']) { const i = pngInfo(dir + f); assert.deepEqual([i.w, i.h], [1814, 510], f); assert.ok(i.type === 6 || (i.type === 3 && fs.readFileSync(dir + f).includes('tRNS')), f + ' has alpha (RGBA or palette+tRNS)'); }
  assert.deepEqual(jpgSize(dir + 'far/tower.jpg'), { w: 1814, h: 510 }); assert.deepEqual(jpgSize(dir + 'tower.jpg'), { w: 1814, h: 510 });
  const src = fs.readFileSync(new URL('parallax.js', G), 'utf8');
  assert.ok(/tower_server_mid\.png/.test(src) && /far\/tower\.jpg/.test(src), 'parallax wires the tower strips');
});

t('beats: lobby -> server floor -> elevator -> penthouse; 8 types, rising waves, scripted events', () => {
  const plan = E.levelPlan(TW), tile = x => Math.floor(x / K.TILE_W);
  assert.ok(plan.kinds.length >= 6 && plan.kinds.includes('skater') && plan.kinds.includes('drone'), plan.kinds.join());
  for (const ev of ['ambushBoth', 'flyover', 'breach', 'elevator', 'gate', 'bark']) assert.ok(plan.events.includes(ev), ev);
  const elev = beats.find(b => b.event === 'elevator'), gate = beats[beats.length - 1];
  assert.equal(elev.level + ':' + elev.x, T.ELEVATOR_KEY);
  assert.ok(beats.some(b => tile(b.x) === 0 && b.kinds.length), 'lobby fights'); assert.ok(beats.some(b => tile(b.x) === 1 && b.kinds.length && b !== elev), 'server floor fights');
  const elL = elev.cam - L.W / 2; assert.ok(elL >= K.TILE_W && elL + L.W <= 2 * K.TILE_W, 'elevator arena on the server floor tile');
  const gL = gate.cam - L.W / 2; assert.ok(gL >= 2 * K.TILE_W, 'boss arena in the penthouse tile');
  assert.ok(beats.filter(b => b.type === 'breather' && b.pickup).length >= 2, 'two pizza breathers');
  const segs = [[]]; for (const b of beats) { if (b.type === 'breather') segs.push([]); else if (b.type !== 'boss' && b.kinds.length) segs[segs.length - 1].push(b.kinds.length); }
  for (const sg of segs) for (let i = 1; i < sg.length; i++) assert.ok(sg[i] >= sg[i - 1], 'rising ' + sg);
  for (let i = 1; i < segs.length; i++) assert.ok(Math.max(...segs[i]) >= Math.max(...segs[i - 1]), 'peaks rise');
  console.log('   waves: ' + segs.map(s => s.join('>')).join(' | breather | ') + ' | SHREDCLAW');
  const extKeys = Object.keys(X.EXT_SPAWNS).filter(k => k.startsWith(TW + ':'));
  assert.deepEqual(new Set(extKeys.flatMap(k => X.EXT_SPAWNS[k])), new Set(['clawninja', 'flamebot', 'shieldbrute']), 'all 3 new types in the tower');
  for (const k of extKeys) assert.ok(beats.some(b => b.level + ':' + b.x === k), 'ext key on a real beat ' + k);
});

t('final boss: the only kind-boss gate is the tower penthouse; SHREDCLAW (final) is adopted there', () => {
  const finals = E.TRIGGERS.filter(b => b.type === 'boss' || b.kinds.includes('boss'));
  assert.equal(finals.length, 1); assert.equal(finals[0].level, TW); assert.deepEqual(finals[0].kinds, ['boss']);
  const roof = E.TRIGGERS.filter(b => b.level === 2).sort((a, b) => b.x - a.x)[0]; assert.equal(roof.type, 'miniBoss'); assert.ok(!roof.kinds.includes('boss'));
  assert.equal(B.bossFor(TW).name, 'SHREDCLAW'); assert.ok(B.bossFor(TW).final); assert.ok(!B.bossFor(2).final, 'rooftop boss is not final');
  assert.equal(Object.values(B.BOSSES).filter(d => d.final).length, 1);
  const s = fresh(); fireUpTo(s, finals[0].x); s.player.x = finals[0].x + 5; E.stepEvents(s, DT);
  const n = s.ninjas.find(m => m.kind === 'boss'); assert.ok(n && n.name === 'SHREDCLAW' && s.bossSeen);
  const bosses = B.createBosses({ rand }); bosses.step(s, DT);
  const a = bosses.info(s).active; assert.ok(a && a.name === 'SHREDCLAW');
  assert.ok(s.bossBar && s.bossBar.name === 'SHREDCLAW' && s.bossBar.phases === 3);
});

t('SHREDCLAW down -> run complete, no wave after it; the level before it hands over to the tower', () => {
  const s = fresh(); const fin = beats[beats.length - 1]; fireUpTo(s, fin.x); s.player.x = fin.x + 5; E.stepEvents(s, DT);
  s.ninjas = s.ninjas.filter(n => n.kind === 'boss'); const bosses = B.createBosses({ rand }); bosses.step(s, DT);
  const b = s.bossFight.active; b.phase = b.thresholds.length; b.invuln = 0; b.mode = 'fight'; b.hp = 2; b.n.hp = 2; b.nhp = 2;
  L.damageNinja(s, b.n, 5); L.update(s, DT); bosses.step(s, DT);
  assert.ok(s.bossDefeated && s.bossDefeated.final && s.bossDefeated.name === 'SHREDCLAW' && s.bossDefeated.level === TW);
  const w = s.wave; s.player.x = K.WORLD_W - 100;
  for (let i = 0; i < 600; i++) { E.stepEvents(s, DT); L.update(s, DT); }
  assert.equal(s.runComplete, true); assert.equal(s.wave, w, 'no new wave'); assert.equal(s.level, TW); assert.equal(s.ninjas.filter(n => !n.dead).length, 0);
  // the level before the tower (rooftop, or whatever is slotted in after it) hands over to the tower
  const r = L.createState(); r.hpMode = true; C.createCombat(r); E.ensureEvents(r);
  r.wave = L.LEVEL_ORDER.indexOf(TW); r.level = L.LEVEL_ORDER[r.wave - 1]; r.ninjas = []; r.holdWave = false; L.update(r, DT);
  assert.equal(r.level, TW); assert.ok(r.walkLevel && r.player.x < 200);
  assert.ok(!r.runComplete);
});

function elevatorState() {
  const s = fresh(); const el = beats.find(b => b.event === 'elevator'); fireUpTo(s, el.x);
  s.player.x = el.x + 2; s.cameraX = el.x - L.W / 2; E.stepEvents(s, DT); return s;
}
t('elevator: arena held through the climb (2 drops), counter climbs, doors open on the penthouse', () => {
  const s = elevatorState(), tower = T.createTower({ rand }), ext = X.createEnemiesExt({ rand });
  assert.ok(s.events.lock && s.events.lock.key === T.ELEVATOR_KEY, 'elevator arena locked');
  tower.step(s, DT); ext.step(s, DT); assert.ok(tower.info(s).elev, 'ride started');
  let floors = [], lockedAll = true, guard = 0;
  while (!tower.info(s).elev.done && guard++ < 6000) {
    // the hero knocks out one enemy every 0.25 s
    if (guard % 30 === 0) { const n = s.ninjas.find(m => !m.dead); if (n) { n.hp = 0; n.dead = true; } }
    E.stepEvents(s, DT); L.update(s, DT); ext.step(s, DT); tower.step(s, DT);
    const e = tower.info(s).elev; floors.push(e.floor);
    if (!e.done && !s.events.lock) lockedAll = false;
  }
  const e = tower.info(s).elev;
  assert.ok(e.done && e.drops === T.ELEVATOR_DROPS.length, JSON.stringify(e)); assert.ok(lockedAll, 'lock held during the ride');
  for (let i = 1; i < floors.length; i++) assert.ok(floors[i] >= floors[i - 1], 'counter never goes down');
  assert.equal(e.floor, T.FLOORS.to); assert.ok(s.events.banner && /PENTHOUSE/.test(s.events.banner.text));
  assert.ok(!s.events.log.some(l => l.type === 'lockTimeout'));
  const spawned = tower.info(s).log.filter(l => l.ev === 'drop').flatMap(l => l.kinds);
  assert.ok(spawned.includes('clawninja') && spawned.includes('shieldbrute') && spawned.includes('drone'), spawned.join());
  console.log(`   ride: ${floors.length} steps, floors ${T.FLOORS.from}->${e.floor}, drops ${spawned.join(', ')}`);
  // draw paths run (ride + arrival)
  const ctx = mockCtx(); tower.drawBack(ctx, s, s.events.lock ? s.events.lock.L : 2870, 740, 510); tower.drawFront(ctx, s, 740, 510);
});
t('elevator: a same-frame wipe of a drop does not end the ride early (relock)', () => {
  const s = elevatorState(), tower = T.createTower({ rand });
  for (let i = 0; i < 200; i++) { E.stepEvents(s, DT); L.update(s, DT); tower.step(s, DT); }
  for (const n of s.ninjas) { n.hp = 0; n.dead = true; }
  E.stepEvents(s, DT); assert.equal(s.events.lock, null, 'events let go');
  tower.step(s, DT);
  assert.ok(s.events.lock && s.events.lock.key === T.ELEVATOR_KEY, 'relocked'); assert.equal(tower.info(s).elev.drops, 1);
  assert.ok(!s.events.go, 'no GO arrow mid-ride');
});

t('bot plays the whole tower (bosses, new enemies, elevator) and beats SHREDCLAW', () => {
  seed = 3; const s = fresh(); s.lives = 3; const bosses = B.createBosses({ rand }), ext = X.createEnemiesExt({ rand }), tower = T.createTower({ rand });
  let i = 0, cd = 0, minHp = 100; const seenExt = new Set();
  while (i++ < 60 * 120 * 8 && !s.over && !s.runComplete) {
    const p = s.player, live = s.ninjas.filter(n => !n.dead && !n.down && !n.flyover);
    const n = live.sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
    let dx = 1, dy = 0; cd -= DT;
    const ba = s.bossFight && s.bossFight.active && s.bossFight.active.atk;
    if (n) {
      dy = Math.abs(n.y - p.y) > 6 ? Math.sign(n.y - p.y) : 0; const ax = Math.abs(n.x - p.x);
      dx = ax > 80 ? Math.sign(n.x - p.x) : ax < 40 ? -Math.sign(n.x - p.x) : 0;
      if (!dx && s.combat.facing !== Math.sign(n.x - p.x)) dx = Math.sign(n.x - p.x);
      if (ba && ba.phase === 'wind' && (ba.type === 'charge' || ba.type === 'volley') && Math.abs((ba.y ?? p.y) - p.y) < 30) { dx = 0; dy = p.y > 430 ? -1 : 1; }
      else if (ba && ba.phase === 'wind' && (ba.type === 'wave' || ba.type === 'slam') && ba.t < 0.15 && !s.combat.airborne) C.combatPress(s, 'jump');
      else if (ax < 110 && Math.abs(n.y - p.y) < 12 && cd <= 0) { cd = 0.16; if (n.kind === 'blocker' && !n.stun && !s.combat.airborne) C.combatPress(s, 'jump'); else C.combatPress(s, s.combat.airborne ? 'kick' : i % 5 === 0 ? 'kick' : 'punch'); }
    }
    if (!C.inHitStop(s)) C.combatWalk(s, dx, dy, DT);
    C.combatStep(s, DT); if (C.inHitStop(s)) continue;
    E.stepEvents(s, DT); L.update(s, DT); bosses.step(s, DT); ext.step(s, DT); tower.step(s, DT);
    for (const m of s.ninjas) if (m.ext) seenExt.add(m.ext);
    minHp = Math.min(minHp, s.hp);
  }
  const log = s.events.log, el = tower.info(s).elev;
  console.log('   bot:', JSON.stringify({ seconds: Math.round(i * DT), lives: s.lives, minHp, beats: log.filter(l => l.type === 'arenaLock').length, ext: [...seenExt], elevator: el && { drops: el.drops, done: el.done }, boss: s.bossDefeated && s.bossDefeated.name, px: Math.round(s.player.x), live: s.ninjas.filter(n => !n.dead).map(n => [n.ext || n.kind, Math.round(n.x)]) }));
  assert.ok(!s.over, 'bot survived'); assert.ok(s.runComplete, 'run complete');
  assert.ok(s.bossDefeated && s.bossDefeated.name === 'SHREDCLAW' && s.bossDefeated.final);
  assert.ok(el && el.done && el.drops === T.ELEVATOR_DROPS.length, 'rode the elevator');
  assert.equal(seenExt.size, 3, 'met all three new types');
  assert.ok(!log.some(l => l.type === 'lockTimeout'), 'no arena had to time out');
});
console.log(`${pass}/${total} passed`);
