// check-aggro: attacker-token fairness (baba_booey, t_fa98e68e0b7b4fc4).
// combat.enemyAI hands out attack tokens (combat.maxTokens: 2, 3 from wave 4). Proves:
//  - at most N token holders / N live attacks at any frame (N = maxTokens; a boss attack
//    takes one of them; co-op: N per player pool)
//  - waiting enemies rotate: everyone in a crowd gets a token and attacks, nobody waits
//    forever, and a holder that can't land its attack hands the token on (max hold time)
//  - waiters keep moving (orbit) instead of standing still
// usage: node check-aggro.mjs
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
const G = new URL('../pizza-panic/', import.meta.url).href;
const L = await import(G + 'logic.js'), C = await import(G + 'combat.js'), E = await import(G + 'events.js');
const B = await import(G + 'boss.js'), CO = await import(G + 'coop.js');
let pass = 0, fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const DT = 1 / 120;
function seeded(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }
const fresh = (wave = 1, level = 0) => { const s = L.createState(); s.hpMode = true; s.level = level; s.wave = wave; s.walkLevel = true; s.holdWave = true; C.createCombat(s); E.ensureEvents(s);
  for (const tr of E.TRIGGERS) s.events.fired[tr.level + ':' + tr.x] = true; s.player.x = 700; s.player.y = L.LEVELS[level].walkables[0].y + 40; s.ninjas.length = 0; return s; };
const enemy = (s, kind, x, y) => { const n = { kind, level: s.level, x, y, r: E.KIND_R[kind] || 14, hp: 999, maxHp: 999, vx: 0, vy: 0 }; s.ninjas.push(n); return n; };
const crowd = (s, kinds) => kinds.map((k, i) => enemy(s, k, s.player.x + (i % 2 ? 1 : -1) * (120 + 45 * i), s.player.y + ((i * 37) % 60) - 30));
const isAtk = n => n.atk && (n.atk.phase === 'wind' || n.atk.phase === 'active');
const keepAlive = s => { s.hp = s.maxHp || 100; s.lives = 3; s.over = false; s.playerDown = 0; };

function track(list, s0) {
  const T = new Map(list.map(n => [n, { attacks: 0, wait: 0, maxWait: 0, hold: 0, maxHold: 0, moved: 0, still: 0, maxStill: 0, lx: n.x, ly: n.y, wasAtk: false, gap: Infinity }]));
  return { T, frame(dt) {
    for (const [n, r] of T) {
      const a = !!(n.atk && n.atk.phase === 'wind');
      if (a && !r.wasAtk) r.attacks++; r.wasAtk = !!n.atk;
      if (n.token || n.atk) { r.wait = 0; } else { r.wait += dt; r.maxWait = Math.max(r.maxWait, r.wait); }
      // idle hold: holding a token without attacking and without closing in on the hero
      const p = s0.player, gap = Math.abs(n.x - p.x) + Math.abs(n.y - p.y), closing = gap < r.gap - 0.25; r.gap = gap;
      if (n.token && !n.atk) { if (!closing) r.hold += dt; r.maxHold = Math.max(r.maxHold, r.hold); } else r.hold = 0;
      const mv = Math.hypot(n.x - r.lx, n.y - r.ly); r.lx = n.x; r.ly = n.y;
      if (!n.token && !n.atk && mv < 0.05) { r.still += dt; r.maxStill = Math.max(r.maxStill, r.still); } else r.still = 0;
    }
  } };
}
const sum = (T) => { const v = [...T.values()]; return { attacks: v.map(r => r.attacks), maxWait: Math.max(...v.map(r => r.maxWait)), maxHold: Math.max(...v.map(r => r.maxHold)), maxStill: Math.max(...v.map(r => r.maxStill)) }; };
const HOLD = C.TOKEN_HOLD_MAX ?? Infinity;
ok(Number.isFinite(HOLD) && HOLD >= 1.5 && HOLD <= 4, `tokens have a max hold time (combat.TOKEN_HOLD_MAX = ${HOLD}s)`);

function run(name, { wave = 1, kinds, secs = 40, input = null, seed = 1 }) {
  const save = Math.random; Math.random = seeded(seed);
  try {
    const s = fresh(wave), list = crowd(s, kinds), tr = track(list, s), N = C.maxTokens(s);
    let maxHolders = 0, maxAtk = 0;
    for (let i = 0; i < secs / DT; i++) {
      keepAlive(s); const d = input ? input(s, i * DT) : 0;
      C.combatWalk(s, d, 0, DT); C.combatStep(s, DT); L.update(s, DT); tr.frame(DT);
      maxHolders = Math.max(maxHolders, s.ninjas.filter(n => !n.dead && n.token).length);
      maxAtk = Math.max(maxAtk, s.ninjas.filter(n => !n.dead && isAtk(n)).length);
    }
    const r = sum(tr.T);
    ok(maxHolders <= N && maxAtk <= N, `${name}: at most ${N} token holders (max ${maxHolders}) and ${N} live attacks (max ${maxAtk})`);
    ok(Math.min(...r.attacks) >= 2, `${name}: everyone gets turns: attacks per enemy [${r.attacks.join(', ')}] in ${secs}s`);
    ok(r.maxWait <= 9, `${name}: nobody waits forever (longest wait for a token ${r.maxWait.toFixed(1)}s <= 9s)`);
    ok(Math.max(...r.attacks) <= 4 * Math.max(1, Math.min(...r.attacks)), `${name}: no permanent pile-on (most/least attacks ${Math.max(...r.attacks)}/${Math.min(...r.attacks)})`);
    return r;
  } finally { Math.random = save; }
}
const r1 = run('sewer crowd (wave 1, cap 2)', { kinds: ['brawler', 'brawler', 'striker', 'brawler', 'blocker', 'striker'] });
ok(r1.maxStill < 1.5, `waiters keep orbiting (longest standstill while waiting ${r1.maxStill.toFixed(2)}s)`);
run('late crowd (wave 5, cap 3)', { wave: 5, kinds: ['brawler', 'charger', 'striker', 'brawler', 'acrobat', 'blocker', 'striker', 'thrower'], seed: 2 });
const kite = run('kited crowd (hero backpedals, holders often out of reach)', { kinds: ['brawler', 'brawler', 'blocker', 'charger', 'brawler'], seed: 3,
  input: (s, t) => (Math.floor(t / 1.2) % 2 ? 1 : -1) });
ok(kite.maxHold <= HOLD + 0.1, `a holder that can't start its attack hands the token on (longest idle hold ${kite.maxHold.toFixed(2)}s <= ${HOLD}s)`);
// balance caps unchanged
{ const a = fresh(1), b = fresh(4); ok(C.maxTokens(a) === 2 && C.maxTokens(b) === 3, 'balance caps kept: 2 tokens, 3 from wave 4'); }

// ---- boss: the boss's attack occupies a token; minion holders stay at N-1 while it attacks
{
  const save = Math.random; Math.random = seeded(4);
  const s = fresh(1), bosses = B.createBosses({ rand: seeded(5) });
  const boss = enemy(s, 'brawler', s.player.x + 160, s.player.y); boss.levelBoss = true; boss.name = 'SEWER ENFORCER';
  const list = crowd(s, ['brawler', 'striker', 'brawler', 'blocker']); const tr = track(list, s);
  let worst = 0, bossTok = false, during = 0;
  for (let i = 0; i < 30 / DT; i++) {
    keepAlive(s); C.combatWalk(s, 0, 0, DT); C.combatStep(s, DT); L.update(s, DT); bosses.step(s, DT); tr.frame(DT);
    const b = s.bossFight && s.bossFight.active; if (boss.token) bossTok = true;
    const minionAtk = s.ninjas.filter(n => !n.dead && n !== boss && (n.token || isAtk(n))).length;
    if (b && b.atk) { during++; worst = Math.max(worst, s.ninjas.filter(n => !n.dead && n !== boss && isAtk(n)).length + 1); }
    else worst = Math.max(worst, s.ninjas.filter(n => !n.dead && n !== boss && isAtk(n)).length);
  }
  Math.random = save;
  const r = sum(tr.T);
  ok(!bossTok && during > 0, `boss never takes a mook token itself (it attacked for ${(during * DT).toFixed(1)}s)`);
  ok(worst <= C.maxTokens(s), `boss fight: boss attack + minion attacks <= ${C.maxTokens(s)} (max ${worst})`);
  ok(Math.min(...r.attacks) >= 1 && r.maxWait <= 12, `boss fight: minions still rotate [${r.attacks.join(', ')}], longest wait ${r.maxWait.toFixed(1)}s`);
}

// ---- co-op: each player has its own token pool, both pools rotate
{
  const save = Math.random; Math.random = seeded(6);
  const s = fresh(1), coop = CO.createCoop({ rand: () => 0.5 }); coop.step(s, DT); const v = coop.join(s);
  v.player.x = s.player.x + 260; v.player.y = s.player.y;
  const list = crowd(s, ['brawler', 'brawler', 'striker', 'brawler', 'blocker', 'striker', 'brawler', 'charger']); const tr = track(list, s);
  let worst1 = 0, worst2 = 0, both = 0;
  for (let i = 0; i < 40 / DT; i++) {
    keepAlive(s); v.hp = 100; s.player.x = 700; v.player.x = 960; C.combatWalk(s, 0, 0, DT); C.combatStep(s, DT); coop.step(s, DT); L.update(s, DT); coop.after(s, DT); tr.frame(DT);
    // an attack counts against the pool it was started in: when a player is knocked down coop.js hands
    // their enemies to the other player, and swings already in flight finish before joining that pool
    for (const n of s.ninjas) { if (n.atk && !n.__pool) n.__pool = n.coopT === 2 ? 2 : 1; if (!n.atk) n.__pool = 0; }
    const pool = n => (n.atk ? n.__pool : (n.coopT === 2 ? 2 : 1));
    const h1 = s.ninjas.filter(n => !n.dead && pool(n) === 1 && (n.atk ? isAtk(n) : n.token)).length, h2 = s.ninjas.filter(n => !n.dead && pool(n) === 2 && (n.atk ? isAtk(n) : n.token)).length;
    worst1 = Math.max(worst1, h1); worst2 = Math.max(worst2, h2); if (h1 && h2) both++;
  }
  Math.random = save;
  const r = sum(tr.T), N = C.maxTokens(s);
  ok(worst1 <= N && worst2 <= N && both > 0, `co-op: per-player pools, P1 max ${worst1}, P2 max ${worst2} (<= ${N} each), both pressured`);
  ok(Math.min(...r.attacks) >= 1 && r.maxWait <= 12, `co-op: everyone rotates [${r.attacks.join(', ')}], longest wait ${r.maxWait.toFixed(1)}s`);
}
console.log(`${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
