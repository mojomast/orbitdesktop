// Iteration 10 enemies (baba_booey): claw ninja, shield brute, flamethrower bot.
//
// Each type has its own AI here (they are `scripted`, so combat.enemyAI leaves
// them alone) but uses the shared systems:
//   - hits on them go through combat.js (hitboxes, hit-stop, hit reactions,
//     logic.damageNinja); any reaction (flinch/stagger/knockdown/grab) cancels
//     their attack
//   - their attacks hit through combat.boxHits(box, player) + logic.damagePlayer
//     after a visible wind-up (0.5-0.8 s marker / glow)
//   - attack tokens: one of them only attacks when it can take a token (total
//     holders < combat.maxTokens, a boss attack counts as one), and blocks new
//     grants to the regular AI while it holds one
// Bodies reuse the existing segmented rigs (rigKind + tint + scale; game.js
// honours both); FX sprites are generated (tools/gen_ext_fx.py ->
// assets/enemies/ext/). Spawns are layered onto events.js beats from here: when
// a listed trigger fires, its extra enemies join that arena.
import { SKATE_LEVEL, LEVELS, damagePlayer } from './logic.js';
import { boxHits, DEPTH, maxTokens } from './combat.js';
import { WORLD_W } from './collision.js';

const SZ = 2, VIEW_W = 740;
export const EXT_TYPES = {
  clawninja: { kind: 'clawninja', rig: 'acrobat', name: 'CLAW NINJA', scale: 0.95, r: 14, hp: 2, speed: 150,
    tint: 'hue-rotate(300deg) saturate(1.9) brightness(0.62) contrast(1.25)' },
  // kind 'blocker': combat.js already guards frontal ground hits for that kind
  // (spark, no damage) unless the hit pierces guard (jump kick, back attack,
  // throw, special) or the brute is mid-attack / stunned.
  shieldbrute: { kind: 'blocker', rig: 'blocker', name: 'SHIELD BRUTE', scale: 1.3, r: 20, hp: 6, speed: 45,
    tint: 'sepia(0.7) hue-rotate(-25deg) saturate(1.7) brightness(0.8) contrast(1.15)' },
  flamebot: { kind: 'flamebot', rig: 'thrower', name: 'FLAMETHROWER BOT', scale: 1.05, r: 16, hp: 3, speed: 70,
    tint: 'hue-rotate(185deg) saturate(1.5) brightness(0.9) contrast(1.15)' },
};
export const EXT_ATTACKS = {
  stars: { wind: 0.5, active: 0.12, rec: 0.45, dmg: 6, speed: 360 },
  blink: { wind: 0.55, active: 0.14, rec: 0.5, dmg: 8, reach: 84 },
  slam:  { wind: 0.8, active: 0.15, rec: 0.85, dmg: 16, reach: 100 },
  rush:  { wind: 0.7, active: 0.8, rec: 0.9, dmg: 12, speed: 280, length: 260 },
  flame: { wind: 0.75, active: 0.9, rec: 0.9, dmg: 9, length: 170, burn: 2.2, burnDmg: 4 },
};
// Extra enemies per events.js trigger (level:x). Walking levels only.
export const EXT_SPAWNS = {
  '0:1000': ['clawninja'], '0:2800': ['shieldbrute'], '0:4050': ['flamebot', 'clawninja'],
  '1:1050': ['clawninja'], '1:3000': ['flamebot'], '1:4200': ['shieldbrute', 'clawninja'], '1:4850': ['flamebot'],
  '2:1000': ['flamebot'], '2:3000': ['shieldbrute', 'clawninja'], '2:4200': ['clawninja', 'flamebot', 'shieldbrute'],
  // 4 OpenClaw Tower (the elevator's later drops come from tower.js).
  '4:1000': ['clawninja'], '4:2500': ['flamebot', 'clawninja'], '4:3000': ['shieldbrute'], '4:4150': ['clawninja', 'flamebot', 'shieldbrute'],
};

const IMG = {};
if (typeof Image !== 'undefined') for (const n of ['flame_0', 'flame_1', 'flame_2', 'flame_3', 'burn', 'shuriken', 'smoke', 'slash', 'pilot']) { const im = new Image(); im.onload = () => { IMG[n] = im; }; im.src = 'assets/enemies/ext/' + n + '.png'; }
export const extImages = IMG;

export function ensureExt(state) {
  if (!state.ext) state.ext = { applied: {}, shots: [], burns: [], fx: [], log: [], t: 0 };
  return state.ext;
}
const band = state => { const lv = LEVELS[state.level | 0] || LEVELS[0]; const b = (lv.walkables || [])[0] || { y: 360, h: 100 }; return { top: b.y + 6, bot: b.y + b.h - 6 }; };
const clampY = (state, y) => { const b = band(state); return Math.max(b.top, Math.min(b.bot, y)); };
const camL = state => { if (state.level === SKATE_LEVEL) return state.cameraX || 0; const lk = state.events && state.events.lock; return lk ? lk.L : (state.events && state.events.camX != null ? Math.max(0, state.events.camX - VIEW_W / 2) : (state.cameraX || 0)); };
const clampX = (state, x) => { const L = camL(state); return Math.max(L + 30, Math.min(L + VIEW_W - 30, x)); };
const bodyBox = (n, x0, x1) => ({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y: n.y, depth: DEPTH + 4, top: n.y + n.r - 63 * SZ * (n.scale || 1), bot: n.y + n.r });
const groundBox = (x0, x1, y, depth) => ({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y, depth, top: y - 10, bot: y + 60 });
export const isExt = n => !!(n && n.ext && EXT_TYPES[n.ext]);

export function makeExtEnemy(type, x, y, level) {
  const T = EXT_TYPES[type];
  return { kind: T.kind, ext: type, name: T.name, rigKind: T.rig, tint: T.tint, scale: T.scale, level, x, y, r: T.r, hp: T.hp, maxHp: T.hp,
    vx: 0, vy: 0, scripted: true, face: -1, xs: { cd: 0.8 + Math.random() * 0.6, atk: null, turnT: 0, dodgeCd: 0, guardHits: 0, lastGuard: 0, hp: T.hp } };
}

export function createEnemiesExt(opts = {}) {
  const audio = opts.audio || null, fx = opts.fx || null, rand = opts.rand || Math.random;
  const play = n => { try { if (audio && audio.play) audio.play(n); } catch { /* optional */ } };
  const log = (X, ev, d) => { X.log.push({ ev, t: +X.t.toFixed(3), ...d }); if (X.log.length > 600) X.log.shift(); };
  const puff = (X, x, y, life = 0.5) => X.fx.push({ type: 'smoke', x, y, t: 0, life });

  function bossAttacking(state) { const b = state.bossFight && state.bossFight.active; return !!(b && b.atk); }
  function holders(state, except) { return state.ninjas.filter(m => !m.dead && m.token && m !== except).length + (bossAttacking(state) ? 1 : 0); }
  function takeToken(state, n) {
    if (holders(state, n) >= maxTokens(state)) {
      // Regular holders that are only waiting (not winding up) pass one over,
      // so idle token holders can't lock the new types out of the rotation.
      const idle = state.ninjas.find(m => !m.dead && m.token && !m.scripted && !m.atk && m !== n);
      if (!idle) return false;
      idle.token = false; idle.tokenCd = 0.6;
      if (holders(state, n) >= maxTokens(state)) return false;
    }
    n.token = true; return true;
  }
  function holdTokens(state) {
    // While our enemies hold tokens, the regular AI may not grant past the cap
    // (combat.enemyAI only counts its own holders): trim idle regular holders.
    let over = holders(state, null) - maxTokens(state);
    for (const m of state.ninjas) { if (over <= 0) break; if (!m.dead && m.token && !m.scripted && !m.atk) { m.token = false; m.tokenCd = 0.6; over -= 1; } }
    if (holders(state, null) < maxTokens(state)) return;
    for (const m of state.ninjas) if (!m.dead && !m.token && !m.scripted) m.tokenCd = Math.max(m.tokenCd || 0, 0.15);
  }
  function release(n) { n.token = false; n.tokenCd = 0.6; }
  function cancel(n) { const st = n.xs; if (st.atk) { st.atk = null; st.cd = Math.max(st.cd, 0.6); } n.move = null; n.phase = null; n.atk = null; if (n.token) release(n); }

  function hitPlayer(state, n, box, dmg, X, type) {
    const p = state.player;
    if (!boxHits(box, p)) return false;
    const got = damagePlayer(state, dmg, { x: n.x, knockdown: dmg >= 12 });
    if (got && state.fxCue) state.fxCue('hit', { x: p.x, y: p.y - 50, heavy: dmg >= 12, shake: 0.18 });
    log(X, 'hit', { type, dmg: got, kind: n.ext });
    return true;
  }

  function start(state, n, type, extra = {}) {
    const X = ensureExt(state), sp = EXT_ATTACKS[type];
    n.xs.atk = { type, phase: 'wind', t: sp.wind, wind: sp.wind, active: sp.active, rec: sp.rec, hitDone: false, face: n.face, ...extra };
    n.guard = false; n.move = MOVES[type]; n.phase = 'wind'; n.atk = { phase: 'wind', t: sp.wind, dur: sp.wind };
    log(X, 'wind', { type, kind: n.ext });
  }

  // ---- per-type wind/active behaviour
  const MOVES = { stars: 'jumpkick', blink: 'spin', slam: 'bash', rush: 'dashAttack', flame: 'throw' };
  function stepAttack(state, n, dt, X) {
    const a = n.xs.atk, sp = EXT_ATTACKS[a.type], p = state.player;
    n.face = a.face; n.vx = 0; n.vy = 0;
    a.t -= dt;
    if (a.phase === 'wind') {
      if (a.t <= 0) {
        a.phase = 'active'; a.t = a.active;
        log(X, 'active', { type: a.type, kind: n.ext });
        if (a.type === 'stars') {
          X.shots.push({ x: n.x + a.face * 24, y: n.y, vx: a.face * sp.speed, t: 0, dmg: sp.dmg, owner: n });
          play('throw');
        }
        if (a.type === 'blink') {
          puff(X, n.x, n.y - 50); n.x = a.dx; n.y = a.dy; puff(X, n.x, n.y - 50, 0.4);
          a.face = n.face = p.x >= n.x ? 1 : -1;
          X.fx.push({ type: 'slash', x: n.x + a.face * 40, y: n.y - 70, face: a.face, t: 0, life: 0.22 });
          play('swingHeavy');
        }
        if (a.type === 'slam') { play('impact'); if (fx) fx.shake = Math.max(fx.shake || 0, 0.22); if (state.fxCue) state.fxCue('land', { x: n.x + a.face * 60, y: n.y + 10, facing: a.face }); }
        if (a.type === 'rush') play('whoosh');
        if (a.type === 'flame') { play('thunder'); a.burned = false; }
      }
    } else if (a.phase === 'active') {
      if (a.type === 'blink' && !a.hitDone) a.hitDone = hitPlayer(state, n, bodyBox(n, n.x + a.face * 8, n.x + a.face * sp.reach), sp.dmg, X, a.type);
      if (a.type === 'slam' && !a.hitDone) a.hitDone = hitPlayer(state, n, bodyBox(n, n.x + a.face * 10, n.x + a.face * sp.reach), sp.dmg, X, a.type);
      if (a.type === 'rush') {
        const done = a.face > 0 ? n.x >= a.x1 - 8 : n.x <= a.x1 + 8;
        n.vx = done ? 0 : a.face * sp.speed;
        if (!a.hitDone) a.hitDone = hitPlayer(state, n, bodyBox(n, n.x - 30, n.x + 30), sp.dmg, X, a.type);
        if (done) a.t = Math.min(a.t, 0);
      }
      if (a.type === 'flame') {
        const x0 = n.x + a.face * 26;
        if (!a.hitDone) for (let i = 0; i < 5 && !a.hitDone; i++) {
          const s0 = x0 + a.face * sp.length * i / 5, s1 = x0 + a.face * sp.length * (i + 1) / 5;
          a.hitDone = hitPlayer(state, n, { x0: Math.min(s0, s1), x1: Math.max(s0, s1), y: n.y, depth: 10 + 26 * (i + 1) / 5, top: n.y - 120, bot: n.y + 20 }, sp.dmg, X, a.type);
        }
        if (!a.burned && a.t < a.active * 0.5) {
          a.burned = true;
          for (const f of [0.35, 0.65, 0.95]) X.burns.push({ x: x0 + a.face * sp.length * f, y: n.y, t: sp.burn, cd: 0 });
          log(X, 'burn', { kind: n.ext });
        }
      }
      if (a.t <= 0) { a.phase = 'recover'; a.t = a.rec; n.vx = 0; if (a.type === 'flame') puff(X, n.x - a.face * 10, n.y - 60, 0.7); }
    } else if (a.t <= 0) {
      n.xs.atk = null; n.move = null; n.phase = null; n.atk = null; release(n);
      n.xs.cd = (n.ext === 'clawninja' ? 1.0 : n.ext === 'flamebot' ? 1.6 : 1.4) * (0.8 + rand() * 0.5);
      log(X, 'recover', { type: a.type, kind: n.ext });
      return;
    }
    n.move = MOVES[a.type]; n.phase = a.phase;
    n.atk = { phase: a.phase, t: a.t, dur: a.phase === 'wind' ? a.wind : a.phase === 'active' ? a.active : a.rec };
  }

  function seek(state, n, tx, ty, sp) {
    ty = clampY(state, ty); tx = Math.max(20, Math.min(WORLD_W - 20, tx));
    const ex = tx - n.x, ey = ty - n.y, d = Math.hypot(ex, ey), k = d > 6 ? Math.min(sp, d * 4) / d : 0;
    n.vx = ex * k; n.vy = ey * k * 0.75;
  }

  function stepNinja(state, n, dt, X) {
    const p = state.player, st = n.xs, T = EXT_TYPES.clawninja, c = state.combat;
    const dx = p.x - n.x, dy = p.y - n.y, side = dx > 0 ? -1 : 1;
    n.face = dx > 0 ? 1 : -1;
    // Dodge: reads the hero's wind-up and blinks away (smoke), on a cooldown.
    if (c && c.attack && c.phase === 'wind' && Math.abs(dx) < 110 && Math.abs(dy) < 22 && Math.sign(-dx) === c.facing && st.dodgeCd <= 0) {
      st.dodgeCd = 2.4;
      if (rand() < 0.6) {
        puff(X, n.x, n.y - 50);
        // Blink 150 px away; if the screen edge is in the way (the camera dead-zone lets the
        // hero stand near it, so a ninja on that side used to get clamped to a ~40 px hop that
        // stayed inside the kick), blink behind the hero instead, which clears the strike too.
        const away = Math.sign(-dx || 1), L = camL(state);
        let tx = n.x + away * 150;
        if (tx < L + 30 || tx > L + VIEW_W - 30) tx = p.x - away * 90;
        n.x = clampX(state, tx); n.y = clampY(state, n.y + (rand() - 0.5) * 40);
        puff(X, n.x, n.y - 50, 0.4); play('whoosh'); log(X, 'dodge', { kind: n.ext });
        return;
      }
    }
    const ring = 190 + Math.sin(X.t * 1.3 + n.x * 0.01) * 30;
    seek(state, n, p.x + side * ring, p.y + Math.sin(X.t * 2 + n.y) * 20, T.speed);
    if (st.cd > 0 || state.playerDown > 0) return;
    const blink = rand() < 0.012 && Math.abs(dx) < 340;
    if (blink && takeToken(state, n)) {
      const pf = c && c.facing ? c.facing : 1;
      start(state, n, 'blink', { dx: clampX(state, p.x - pf * 72), dy: clampY(state, p.y) });
    } else if (Math.abs(dy) < 9 && Math.abs(dx) > 120 && Math.abs(dx) < 320 && rand() < 0.03 && takeToken(state, n)) start(state, n, 'stars');
  }

  function stepBrute(state, n, dt, X) {
    const p = state.player, st = n.xs, T = EXT_TYPES.shieldbrute;
    const dx = p.x - n.x, dy = p.y - n.y, want = dx > 0 ? 1 : -1;
    n.guard = true;
    // Slow turn: get behind it and it takes 0.7 s to face you again.
    if (want !== n.face) { st.turnT += dt; if (st.turnT > 0.7) { n.face = want; st.turnT = 0; } } else st.turnT = 0;
    seek(state, n, p.x - want * 72, p.y, T.speed);
    if (st.cd > 0 || state.playerDown > 0 || want !== n.face) return;
    if (Math.abs(dx) < 105 && Math.abs(dy) < DEPTH - 2 && takeToken(state, n)) start(state, n, 'slam');
    else if (Math.abs(dx) > 150 && Math.abs(dx) < 300 && Math.abs(dy) < 10 && rand() < 0.02 && takeToken(state, n)) start(state, n, 'rush', { x1: clampX(state, n.x + n.face * EXT_ATTACKS.rush.length) });
  }

  function stepFlamer(state, n, dt, X) {
    const p = state.player, st = n.xs, T = EXT_TYPES.flamebot;
    const dx = p.x - n.x, dy = p.y - n.y, side = dx > 0 ? -1 : 1;
    n.face = dx > 0 ? 1 : -1;
    const close = Math.abs(dx) < 110;
    seek(state, n, p.x + side * (close ? 240 : 190), p.y, close ? T.speed * 1.3 : T.speed);
    if (st.cd > 0 || state.playerDown > 0) return;
    if (Math.abs(dy) < 14 && Math.abs(dx) > 100 && Math.abs(dx) < 230 && takeToken(state, n)) start(state, n, 'flame');
  }

  function guard(state, n, X) {
    // Shield brute: three blocked hits rattle the guard (stagger: grab or punish).
    if (n.ext !== 'shieldbrute') return;
    const st = n.xs;
    if (n.guardHit > 0 && st.lastGuard <= 0) {
      st.guardHits += 1; log(X, 'blocked', { kind: n.ext });
      if (st.guardHits >= 3) { st.guardHits = 0; n.stun = 0.75; n.react = 'stagger'; n.guard = false; cancel(n); log(X, 'guardBreak', { kind: n.ext }); play('impact'); }
    }
    st.lastGuard = n.guardHit || 0;
    // Pizzas hit the shield too (frontal, not mid-attack, not stunned).
    const lost = st.hp - n.hp;
    const melee = state.combat && state.combat.phase === 'active';
    if (lost > 0 && !melee && !n.stun && !st.atk && n.thrownBy === st.thrownBy && Math.sign(state.player.x - n.x) === n.face) {
      n.hp = st.hp; if (n.dead) { n.dead = false; if (!state.ninjas.includes(n)) state.ninjas.push(n); }
      if (state.fxCue) state.fxCue('hit', { x: n.x + n.face * 20, y: n.y - 60, heavy: false, blocked: true });
      log(X, 'blocked', { kind: n.ext, by: 'projectile' });
    }
    st.thrownBy = n.thrownBy; st.hp = n.hp;
  }

  function spawnFor(state, X) {
    if (!state.hpMode || state.level === SKATE_LEVEL || !state.events) return;
    const lv = state.level | 0;
    for (const [key, kinds] of Object.entries(EXT_SPAWNS)) {
      if (X.applied[key] || !key.startsWith(lv + ':') || !state.events.fired[key]) continue;
      X.applied[key] = true;
      const lk = state.events.lock, L = lk ? lk.L : camL(state), R = L + VIEW_W, b = band(state);
      kinds.forEach((k, i) => {
        const right = i % 2 === 0;
        const x = Math.max(20, Math.min(WORLD_W - 20, right ? R + 40 + i * 50 : L - 40 - i * 50));
        const n = makeExtEnemy(k, x, b.top + 10 + rand() * (b.bot - b.top - 20), lv);
        n.vx = right ? -60 : 60;
        state.ninjas.push(n);
        log(X, 'spawn', { kind: k, key });
      });
    }
  }

  function step(state, dt) {
    const X = ensureExt(state);
    X.t += dt;
    spawnFor(state, X);
    const p = state.player;
    for (const n of state.ninjas) {
      if (!isExt(n) || n.dead) continue;
      const st = n.xs || (n.xs = makeExtEnemy(n.ext, 0, 0, 0).xs);
      guard(state, n, X);
      if (st.cd > 0) st.cd -= dt;
      if (st.dodgeCd > 0) st.dodgeCd -= dt;
      // Any hit reaction cancels the attack (react() clears n.atk).
      if (n.stun > 0 || n.down > 0 || n.wake > 0 || n.falling || n.grabbed || (n.z || 0) > 4 || (st.atk && !n.atk)) {
        cancel(n); if (!n.grabbed) { n.vx = 0; n.vy = 0; } continue;
      }
      if (st.atk) { stepAttack(state, n, dt, X); continue; }
      if (n.ext === 'clawninja') stepNinja(state, n, dt, X);
      else if (n.ext === 'shieldbrute') stepBrute(state, n, dt, X);
      else stepFlamer(state, n, dt, X);
    }
    holdTokens(state);
    // Shuriken
    for (const s of X.shots) {
      s.x += s.vx * dt; s.t += dt;
      if (!s.dead && boxHits({ x0: s.x - 8, x1: s.x + 8, y: s.y, depth: DEPTH + 6, top: s.y - 72, bot: s.y - 48 }, p)) {
        s.dead = true; const got = damagePlayer(state, s.dmg, { x: s.x - s.vx * 0.05 }); log(X, 'hit', { type: 'stars', dmg: got, kind: 'clawninja' });
      }
      if (s.t > 2.2) s.dead = true;
    }
    X.shots = X.shots.filter(s => !s.dead);
    // Burning ground: short-lived, ticks on touch (a jump clears it).
    for (const g of X.burns) {
      g.t -= dt; if (g.cd > 0) g.cd -= dt;
      if (g.cd <= 0 && boxHits(groundBox(g.x - 36, g.x + 36, g.y, 16), p)) { g.cd = 0.8; const got = damagePlayer(state, EXT_ATTACKS.flame.burnDmg, { x: g.x }); if (got) log(X, 'hit', { type: 'burn', dmg: got, kind: 'flamebot' }); }
    }
    X.burns = X.burns.filter(g => g.t > 0);
    for (const f of X.fx) f.t += dt;
    X.fx = X.fx.filter(f => f.t < f.life);
  }

  // ---- drawing (world space). drawWorld: ground layer before actors.
  function drawWorld(ctx, state, t = 0) {
    const X = state.ext; if (!X) return;
    ctx.save();
    for (const g of X.burns) {
      const a = Math.min(1, g.t / 0.4);
      ctx.globalAlpha = a;
      if (IMG.burn) ctx.drawImage(IMG.burn, g.x - 42, g.y - 8, 84, 30); else { ctx.fillStyle = 'rgba(120,30,0,0.6)'; ctx.beginPath(); ctx.ellipse(g.x, g.y + 6, 40, 12, 0, 0, 7); ctx.fill(); }
      const fr = IMG['flame_' + (Math.floor(t * 12 + g.x) % 4)];
      if (fr) for (const o of [-22, 0, 22]) ctx.drawImage(fr, g.x + o - 12, g.y - 26 + Math.sin(t * 9 + o) * 2, 24, 30);
    }
    ctx.globalAlpha = 1;
    const pulse = 0.5 + 0.5 * Math.sin(t * 22);
    for (const n of state.ninjas) {
      const a = isExt(n) && !n.dead && n.xs && n.xs.atk; if (!a || a.phase !== 'wind') continue;
      const k = 1 - a.t / a.wind, f = a.face;
      ctx.fillStyle = `rgba(255,40,40,${0.15 + 0.22 * pulse})`; ctx.strokeStyle = `rgba(255,230,110,${0.55 + 0.4 * pulse})`; ctx.lineWidth = 3;
      if (a.type === 'flame') {
        const x0 = n.x + f * 26, L = EXT_ATTACKS.flame.length;
        ctx.beginPath(); ctx.moveTo(x0, n.y - 2); ctx.lineTo(x0 + f * L, n.y - 30); ctx.lineTo(x0 + f * L, n.y + 42); ctx.lineTo(x0, n.y + 18); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = `rgba(255,170,40,${0.35 + 0.3 * pulse})`;
        ctx.beginPath(); ctx.moveTo(x0, n.y + 4); ctx.lineTo(x0 + f * L * k, n.y + 4 - 26 * k); ctx.lineTo(x0 + f * L * k, n.y + 12 + 26 * k); ctx.lineTo(x0, n.y + 12); ctx.closePath(); ctx.fill();
      } else if (a.type === 'slam') {
        const x1 = n.x + f * EXT_ATTACKS.slam.reach;
        ctx.fillRect(Math.min(n.x, x1), n.y - DEPTH, Math.abs(x1 - n.x), DEPTH * 2 + 10); ctx.strokeRect(Math.min(n.x, x1), n.y - DEPTH, Math.abs(x1 - n.x) * k, DEPTH * 2 + 10);
      } else if (a.type === 'rush') {
        ctx.fillRect(Math.min(n.x, a.x1), n.y - DEPTH, Math.abs(a.x1 - n.x), DEPTH * 2 + 10);
        ctx.fillStyle = `rgba(255,220,60,${0.4 + 0.4 * pulse})`; ctx.fillRect(Math.min(n.x, a.x1), n.y + DEPTH + 7, Math.abs(a.x1 - n.x) * k, 3);
      } else if (a.type === 'blink') {
        ctx.beginPath(); ctx.ellipse(a.dx, a.dy + 8, 34, 12, 0, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ff5c7a'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center'; ctx.fillText('!', a.dx, a.dy + 14);
      } else if (a.type === 'stars') {
        ctx.fillRect(Math.min(n.x, n.x + f * 420), n.y - 4, 420, 8 * k + 2);
      }
    }
    ctx.restore(); ctx.textAlign = 'left';
  }

  // drawOver: projectiles, flames, glints and smoke over the actors.
  function drawOver(ctx, state, t = 0) {
    const X = state.ext; if (!X) return;
    ctx.save();
    for (const n of state.ninjas) {
      const a = isExt(n) && !n.dead && n.xs && n.xs.atk; if (!a) continue;
      const f = a.face, handY = n.y + n.r - 70 * (n.scale || 1);
      if (a.phase === 'wind' && (a.type === 'flame' || a.type === 'stars' || a.type === 'blink' || a.type === 'slam')) {
        const s = 22 + 16 * (1 - a.t / a.wind) + 6 * Math.sin(t * 30);
        if (IMG.pilot) ctx.drawImage(IMG.pilot, n.x + f * 26 - s / 2, handY - s / 2, s, s);
      }
      if (a.type === 'flame' && a.phase === 'active') {
        const x0 = n.x + f * 26, L = EXT_ATTACKS.flame.length;
        for (let i = 0; i < 9; i++) {
          const q = ((t * 3 + i / 9) % 1), x = x0 + f * L * q, sz = 18 + 46 * q, fr = IMG['flame_' + ((i + Math.floor(t * 14)) % 4)];
          const y = handY + 20 + (n.y - handY - 20) * q * 0.8 + Math.sin(t * 20 + i) * 4;
          ctx.globalAlpha = 1 - q * 0.35;
          if (fr) ctx.drawImage(fr, x - sz / 2, y - sz / 2, sz, sz); else { ctx.fillStyle = 'orange'; ctx.beginPath(); ctx.arc(x, y, sz / 3, 0, 7); ctx.fill(); }
        }
        ctx.globalAlpha = 1;
      }
    }
    for (const s of X.shots) {
      ctx.save(); ctx.translate(s.x, s.y - 60); ctx.rotate(s.t * 22);
      if (IMG.shuriken) ctx.drawImage(IMG.shuriken, -11, -11, 22, 22); else { ctx.fillStyle = '#ccd'; ctx.fillRect(-6, -6, 12, 12); }
      ctx.restore();
    }
    for (const e of X.fx) {
      const k = e.t / e.life;
      ctx.globalAlpha = 1 - k;
      if (e.type === 'smoke') { const sz = 50 + 60 * k; if (IMG.smoke) ctx.drawImage(IMG.smoke, e.x - sz / 2, e.y - sz / 2 - 20 * k, sz, sz); }
      if (e.type === 'slash' && IMG.slash) { ctx.save(); ctx.translate(e.x, e.y); if (e.face < 0) ctx.scale(-1, 1); ctx.drawImage(IMG.slash, -55, -20, 110, 40); ctx.restore(); }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function info(state) {
    const X = state.ext;
    return { live: state.ninjas.filter(n => isExt(n) && !n.dead).map(n => ({ ext: n.ext, hp: n.hp, atk: n.xs && n.xs.atk ? n.xs.atk.type + ':' + n.xs.atk.phase : null })), burns: X ? X.burns.length : 0, shots: X ? X.shots.length : 0, log: X ? X.log.slice(-40) : [] };
  }
  return { step, drawWorld, drawOver, info, spawn: (state, type, x, y) => { const n = makeExtEnemy(type, x, clampY(state, y), state.level | 0); state.ninjas.push(n); return n; } };
}
