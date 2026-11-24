// Iteration 9 checks (closing out iteration 5): enemy variety, pacing and
// scripted events on every level (sewer, street, skate, rooftop).
//  - each level fields >= 6 distinct segmented enemy types, skater goon and
//    claw drone included, both in the plan and in an actual bot playthrough
//  - each level has >= 2 distinct scripted events, and they really fire
//  - rising wave rhythm: waves grow between breathers, every level has breathers
//  - arena lock after every fighting beat (camera held, hero kept inside) that
//    releases with a GO arrow once the wave is cleared; the skate roadblock
//    stops the scroll until its convoy is down
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const S = await import(G + 'skate.js');
const E = await import(G + 'events.js');
const K = await import(G + 'collision.js');
let pass = 0, total = 0; const t = (name, fn) => { total++; fn(); pass++; console.log('PASS', name); };
const fresh = () => { const s = L.createState(); s.hpMode = true; C.createCombat(s); E.ensureEvents(s); return s; };
const NAMES = { 0: 'sewer', 1: 'street', 3: 'skate', 2: 'rooftop', 4: 'tower', 5: 'subway' }; // cheese: subway
const SEG = new Set(E.SEGMENTED_KINDS);
const EVENTS = new Set(E.SCRIPTED_EVENTS);
const plan = lv => (lv === L.SKATE_LEVEL ? S.skatePlan() : E.levelPlan(lv));

t('the 8 segmented OpenClaw types are the drawn rig types (incl. skater goon and claw drone)', () => {
  for (const k of ['brawler', 'striker', 'blocker', 'thrower', 'charger', 'acrobat', 'skater', 'drone']) assert.ok(SEG.has(k), k);
  for (const k of E.SEGMENTED_KINDS) assert.ok(E.KIND_R[k] > 0 && E.KIND_HP[k] > 0, 'body for ' + k);
});

t('every level plans >= 6 distinct segmented enemy types, skater and drone included', () => {
  for (const lv of L.LEVEL_ORDER) {
    const kinds = plan(lv).kinds.filter(k => SEG.has(k));
    assert.ok(kinds.length >= 6, `${NAMES[lv]}: ${kinds.join(',')}`);
    assert.ok(kinds.includes('skater') && kinds.includes('drone'), `${NAMES[lv]} has skater + drone`);
    console.log(`   ${NAMES[lv]}: ${kinds.length} types — ${kinds.join(', ')}`);
  }
});

t('every level has >= 2 distinct scripted events', () => {
  for (const lv of L.LEVEL_ORDER) {
    const ev = plan(lv).events.filter(e => EVENTS.has(e));
    assert.ok(ev.length >= 2, `${NAMES[lv]}: ${ev.join(',')}`);
    console.log(`   ${NAMES[lv]}: ${ev.join(', ')}`);
  }
  // Walking levels: a gate fight closes every level; each has a drone flyover and a breach.
  for (const lv of [0, 1, 2]) {
    const beats = E.levelPlan(lv).beats, last = beats.reduce((a, b) => (b.x > a.x ? b : a));
    assert.equal(last.event, 'gate', NAMES[lv] + ' ends on a gate'); assert.ok(last.cam != null, 'gate holds the camera');
    for (const ev of ['flyover', 'breach', 'ambushBoth']) assert.ok(beats.some(b => b.event === ev), NAMES[lv] + ' ' + ev);
  }
  for (const ev of ['hazardRun', 'roadblock', 'flyover', 'gate']) assert.ok(S.BEATS.some(b => b.event === ev), 'skate ' + ev);
});

t('pacing: waves rise between breathers, peaks rise across the level, >= 2 breathers', () => {
  const check = (name, seq) => {
    // seq: [{size, breather, boss}] in level order. Split into segments at breathers.
    const segs = [[]];
    for (const b of seq) { if (b.breather) segs.push([]); else if (!b.boss && b.size) segs[segs.length - 1].push(b.size); }
    const used = segs.filter(s => s.length);
    assert.ok(seq.filter(b => b.breather).length >= 2, name + ' breathers');
    assert.ok(used.length >= 3, name + ' segments');
    for (const s of used) for (let i = 1; i < s.length; i++) assert.ok(s[i] >= s[i - 1], `${name} wave sizes rise ${s}`);
    for (let i = 1; i < used.length; i++) assert.ok(Math.max(...used[i]) >= Math.max(...used[i - 1]), `${name} peaks rise ${JSON.stringify(used)}`);
    assert.ok(Math.max(...used[used.length - 1]) > Math.max(...used[0]), name + ' ends harder than it starts');
    console.log(`   ${name}: ${used.map(s => s.join('>')).join(' | breather | ')} | gate`);
  };
  for (const lv of [0, 1, 2]) check(NAMES[lv], E.levelPlan(lv).beats.map(b => ({ size: b.kinds.length, breather: b.type === 'breather', boss: b.type === 'miniBoss' || b.type === 'boss' })));
  check('skate', S.BEATS.map(b => ({ size: (b.spawn || []).length, breather: !!b.breather, boss: b.event === 'gate' })));
});

// Walk a state to a trigger and fire it.
function fireAt(lv, x) {
  const s = fresh(); s.level = lv; s.walkLevel = true; s.holdWave = true; s.wave = 1;
  for (const b of E.TRIGGERS) if (b.level === lv && b.x < x) s.events.fired[b.level + ':' + b.x] = true;
  s.player.x = x; s.player.y = K.LEVELS[lv].walkables[0].y + 40; s.cameraX = Math.max(0, x - L.W / 2);
  E.stepEvents(s, 1 / 60); return s;
}
const trig = (lv, ev) => E.TRIGGERS.find(b => b.level === lv && b.event === ev);

t('arena lock: every fighting beat holds the camera and the hero until cleared, then GO', () => {
  for (const b of E.TRIGGERS.filter(b => b.kinds.length && b.type !== 'boss')) {
    const s = fireAt(b.level, b.x), e = s.events;
    assert.ok(e.lock, `lock at ${b.level}:${b.x}`);
    s.player.x += 2000; E.stepEvents(s, 1 / 60);
    assert.ok(s.player.x <= e.lock.R - 30, 'hero kept inside the arena');
    assert.equal(e.camX, e.lock.L + L.W / 2, 'camera held on the arena');
    for (let i = 0; i < 300; i++) { E.stepEvents(s, 1 / 60); L.update(s, 1 / 60); }
    for (const n of s.ninjas) { assert.ok(n.x >= e.lock.L && n.x <= e.lock.R, `${n.kind} walked into the arena (${Math.round(n.x)})`); n.dead = true; }
    E.stepEvents(s, 1 / 60);
    assert.equal(e.lock, null, 'released'); assert.ok(e.go || e.log.some(l => l.type === 'levelEnd'), 'GO arrow'); assert.equal(e.camX, null, 'camera follows again');
    assert.ok(e.log.some(l => l.type === 'arenaClear') && e.log.some(l => l.type === 'go'));
  }
  const br = fireAt(0, 1600); assert.equal(br.events.lock, null, 'breathers do not lock');
});

t('ambush from both sides: the wave enters left and right of the arena', () => {
  for (const lv of [0, 1, 2]) {
    const s = fireAt(lv, trig(lv, 'ambushBoth').x), { L: a, R: z } = s.events.lock;
    const fresh = s.ninjas.slice(-trig(lv, 'ambushBoth').kinds.length);
    assert.ok(fresh.some(n => n.x < a) && fresh.some(n => n.x > z), NAMES[lv]);
  }
});

t('drone flyover: drones sweep across high and scripted, then peel off and fight', () => {
  for (const lv of [0, 1, 2]) {
    const s = fireAt(lv, trig(lv, 'flyover').x);
    const drones = s.ninjas.filter(n => n.kind === 'drone');
    assert.ok(drones.length >= 2 && drones.every(n => n.flyover && n.scripted && n.hover > 100 && n.x < s.events.lock.L), NAMES[lv] + ' sweep in from behind');
    for (let i = 0; i < 240; i++) { E.stepEvents(s, 1 / 60); L.update(s, 1 / 60); }
    assert.ok(drones.every(n => !n.flyover && !n.scripted && n.hover === 70 && n.x > s.events.lock.L), NAMES[lv] + ' peeled off into the fight');
  }
});

t('breach flashes, gates show a banner, barks put a bubble over the enemy or hero', () => {
  for (const lv of [0, 1, 2]) {
    const b = fireAt(lv, trig(lv, 'breach').x); assert.ok(b.events.flash > 0, 'flash');
    const g = fireAt(lv, trig(lv, 'gate').x); assert.ok(g.events.banner && /GATE/.test(g.events.banner.text), 'banner');
    assert.ok(g.events.barks.some(k => k.who === 'enemy' && k.n && !k.n.dead), 'enemy bark on a live enemy');
    const h = E.TRIGGERS.find(x => x.level === lv && (x.barks || []).some(k => k.who === 'hero'));
    assert.ok(h, NAMES[lv] + ' has a hero bark'); assert.ok(fireAt(lv, h.x).events.barks.some(k => k.who === 'hero'));
  }
});

t('skate roadblock: the scroll stops until the convoy is down, then GO and roll on', () => {
  const s = fresh(); s.wave = 2; s.level = L.SKATE_LEVEL; s.skateStart = true; s.holdWave = true;
  S.stepSkate(s, 1 / 60); const rb = S.BEATS.find(b => b.event === 'roadblock');
  s.skate.dist = rb.at - 1; s.skate.beat = S.BEATS.indexOf(rb); s.ninjas = [];
  S.stepSkate(s, 1 / 60);
  assert.ok(s.skate.lock, 'locked'); const kinds = s.ninjas.map(n => n.kind); assert.ok(kinds.includes('charger') && kinds.includes('drone'), kinds.join());
  const cam = s.skate.cam; for (let i = 0; i < 60; i++) S.stepSkate(s, 1 / 60);
  assert.equal(s.skate.cam, cam, 'scroll held'); assert.equal(s.scrollSpeed, 0);
  for (const n of s.ninjas) n.dead = true; S.stepSkate(s, 1 / 60);
  assert.equal(s.skate.lock, null); assert.ok(s.events.go, 'GO arrow');
  S.stepSkate(s, 1 / 60); assert.ok(s.skate.cam > cam, 'rolling again');
  assert.ok(s.events.log.some(l => l.type === 'skate' && l.event === 'roadblock'));
});

// Full run: the iteration 7 bot plays every level; record the types that
// actually spawned and the scripted events that actually fired per level.
function bot(s, i) {
  const p = s.player, live = s.ninjas.filter(n => !n.dead && !n.down && !n.flyover);
  const n = live.sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x))[0];
  let dx = 1, dy = 0; { const b = K.LEVELS[s.level].walkables[0]; const mid = Math.max(b.y, 0) + Math.min(b.h, 600) * 0.6; if (b.h < 1000 && Math.abs(p.y - mid) > 8) dy = Math.sign(mid - p.y); }
  if (n) {
    dy = Math.abs(n.y - p.y) > 6 ? Math.sign(n.y - p.y) : 0;
    const ax = Math.abs(n.x - p.x);
    dx = ax > 80 ? Math.sign(n.x - p.x) : ax < 40 ? -Math.sign(n.x - p.x) : 0;
    if (!dx && s.combat.facing !== Math.sign(n.x - p.x)) dx = Math.sign(n.x - p.x);
    if (ax < 110 && Math.abs(n.y - p.y) < 12 && i % 10 === 0) {
      if (n.kind === 'blocker' && !n.stun && !s.combat.airborne) C.combatPress(s, 'jump');
      else C.combatPress(s, s.combat.airborne ? 'kick' : i % 50 === 0 ? 'kick' : 'punch');
    }
  }
  if (s.skate) {
    const ob = s.skate.obstacles.some(o => !o.hit && !o.passed && o.x > p.x && o.x - p.x < 70 && (o.type === 'barrier' || Math.abs(o.y - p.y) < 22));
    if (ob) C.combatPress(s, 'jump');
  }
  return [dx, dy];
}
t('bot playthrough: each level spawns >= 6 segmented types and fires its scripted events', () => {
  const s = fresh(); L.spawnWave(s); const dt = 1 / 60;
  const seen = {}, fired = {}, seenSet = new WeakSet(); let logAt = 0, i = 0, gos = 0, locks = 0;
  while (i++ < 60 * 60 * 12 && !s.over) {
    const [dx, dy] = bot(s, i);
    C.combatWalk(s, dx, dy, dt); S.stepSkate(s, dt); C.combatStep(s, dt); E.stepEvents(s, dt); L.update(s, dt);
    const lv = s.level;
    for (const n of s.ninjas) if (!seenSet.has(n)) { seenSet.add(n); (seen[lv] = seen[lv] || new Set()).add(n.kind); }
    const log = s.events.log;
    for (; logAt < log.length; logAt++) {
      const l = log[logAt], at = l.level != null ? l.level : lv;
      if (l.event) (fired[at] = fired[at] || new Set()).add(l.event);
      if (l.type === 'bark') (fired[at] = fired[at] || new Set()).add('bark');
      if (l.type === 'go') gos++; if (l.type === 'arenaLock') locks++;
    }
    if (s.runComplete) break;
  }
  if (!s.runComplete || s.over) console.log('   end:', JSON.stringify({ i, lv: s.level, px: Math.round(s.player.x), lock: s.events.lock, tail: s.events.log.slice(-4), live: s.ninjas.filter(n => !n.dead).map(n => [n.kind, Math.round(n.x), n.hp, !!n.flyover]) }));
  assert.ok(!s.over, 'bot survived'); assert.ok(s.runComplete, 'final boss beaten');
  for (const lv of L.LEVEL_ORDER) {
    const kinds = [...(seen[lv] || [])].filter(k => SEG.has(k)), ev = [...(fired[lv] || [])];
    console.log(`   ${NAMES[lv]}: spawned ${kinds.length} types (${kinds.join(', ')}); fired ${ev.join(', ')}`);
    assert.ok(kinds.length >= 6 && kinds.includes('skater') && kinds.includes('drone'), NAMES[lv] + ' spawned types');
    assert.ok(ev.length >= 2, NAMES[lv] + ' events fired');
    for (const e of plan(lv).events) assert.ok(ev.includes(e), `${NAMES[lv]} fired ${e}`);
  }
  console.log(`   ${locks} arena locks, ${gos} GO arrows, ${Math.round(i / 60)}s, lives ${s.lives}`);
  assert.ok(!s.events.log.some(l => l.type === 'lockTimeout'), 'no arena lock had to time out');
  assert.ok(locks >= 18 && gos >= locks - 1, 'a GO after every cleared arena (except the final boss)');
});
console.log(`${pass}/${total} passed`);
