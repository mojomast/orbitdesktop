import { LEVELS, levelForIndex, resolveWalkable, isWalkable, moveWalkable } from './collision.js';
export { LEVELS, levelForIndex, isWalkable, resolveWalkable, moveWalkable } from './collision.js';
export const W = 740, H = 510;
// Every hazard telegraphs for this long before it can hit. One number, shared with
// the level modules and the tests, so warnings cannot drift apart.
export const HAZARD_TELEGRAPH_DEFAULT = 0.65;

export function createState() {
  return {
    player: { x: 60, y: H - 130, r: 16, speed: 220, shield: false, level: 0 },
    cameraX: 0,
    pizzas: [], ninjas: [], powerups: [], hazards: [], wave: 0, score: 0, lives: 3,
    over: false, invuln: 0, combo: 0, comboTimer: 0, bestCombo: 0,
    rapidTimer: 0, spreadTimer: 0, weaponLevel: 1, weaponDurability: 0, difficulty: 'normal',
    // Health bar (iteration 6). hpMode is switched on by the game; plain states
    // (dev checks) keep the original touch-to-lose-a-life rules.
    hp: 100, maxHp: 100, hpMode: false, hurtT: 0, playerDown: 0, holdWave: false
  };
}
// Play order of the level strips: sewer, street, skate (auto-scroll), rooftop,
// then the OpenClaw Tower (4, final level: SHREDCLAW).
export const LEVEL_ORDER = [0, 1, 3, 5, 2, 7, 6, 4]; // cheese: subway (5) after skate; mr_india: arcade (7) after the rooftop, harbor (6) before the tower
export const TOWER_LEVEL = 4;
export const SKATE_LEVEL = 3;
// Camera feel: how wide the still band in the middle of the screen is (as a fraction
// of the viewport), and how fast the camera eases onto its new target once you leave it.
export const CAMERA_DEAD_ZONE = 0.16;
export const CAMERA_EASE_RATE = 6;
// baba_booey (t_9ec48322f6de4bf7): the camera is a critically damped spring (position + velocity, fixed 1/240 s
// substeps, so any dt gives the same motion) chasing an eased framing target. Framing changes (a scripted hold on a
// spawn, the arena lock and its release when the last enemy drops, the co-op midpoint) blend in over
// ~1/CAMERA_FRAME_BLEND s instead of snapping, the speed is capped, and the level edges still clamp.
export const CAMERA_SPRING = 7;          // rad/s natural frequency (damping ratio 1)
export const CAMERA_MAX_SPEED = 900;     // px/s
export const CAMERA_FRAME_BLEND = 4;     // 1/s: how fast a new framing target is blended in
export const CAMERA_STEP = 1 / 240;
// Advance state.cameraX one frame toward `desired` (already the camera-left target) inside [0, maxX].
export function cameraFollow(state, desired, maxX, dt) {
  let c = state.__cam;
  if (!c || !Number.isFinite(c.x) || Math.abs(c.x - state.cameraX) > 0.5) c = state.__cam = { x: state.cameraX, v: 0 };
  if (Math.abs(desired - c.x) > W * 1.5) { c.x = desired; c.v = 0; }   // a teleport (respawn, level start, resume) cuts
  let t = Math.min(Math.max(dt, 0), 0.1);
  const k = CAMERA_SPRING;
  while (t > 1e-7) {
    const h = Math.min(CAMERA_STEP, t); t -= h;
    c.v += (k * k * (desired - c.x) - 2 * k * c.v) * h;
    c.v = Math.max(-CAMERA_MAX_SPEED, Math.min(CAMERA_MAX_SPEED, c.v));
    c.x += c.v * h;
    if (c.x < 0) { c.x = 0; if (c.v < 0) c.v = 0; } else if (c.x > maxX) { c.x = maxX; if (c.v > 0) c.v = 0; }
  }
  if (Math.abs(desired - c.x) < 0.05 && Math.abs(c.v) < 0.5) { c.x = desired; c.v = 0; }   // settle exactly
  state.cameraX = c.x;
  return c.x;
}

export const levelForWave = wave => LEVEL_ORDER[((wave - 1) % LEVEL_ORDER.length + LEVEL_ORDER.length) % LEVEL_ORDER.length];
// One damage path for the player. Shield absorbs a hit; heavy hits knock down;
// at 0 HP a life (continue) is spent and the bar refills.
export function damagePlayer(state, amount, source = null) {
  const sc = state && state.difficulty === 'easy' ? 0.75 : (state && state.difficulty === 'hard' ? 1.25 : 1);
  amount = amount * sc;
  if (state.over || amount <= 0) return 0;
  if (state.invuln > 0) return 0;
  if (state.player.shield) { state.player.shield = false; state.invuln = 0.6; return 0; }
  state.hp = Math.max(0, (state.hp == null ? 100 : state.hp) - amount);
  state.hpHit = (state.hpHit || 0) + 1;
  state.combo = 0; state.comboTimer = 0;
  state.invuln = 0.75;
  state.hurtT = 0.28;
  if (amount >= 12 || (source && source.knockdown)) { state.playerDown = 0.7; state.invuln = 1.2; }
  if (source && Number.isFinite(source.x)) state.player.knockFrom = Math.sign(state.player.x - source.x) || 1;
  if (state.hp <= 0) {
    state.lives -= 1;
    if (state.lives <= 0) { state.lives = 0; state.over = true; }
    else { state.hp = state.maxHp; state.invuln = 2; state.playerDown = 0.9; state.lifeLost = (state.lifeLost || 0) + 1; }
  }
  return amount;
}
export function healPlayer(state, amount) {
  const before = state.hp;
  state.hp = Math.min(state.maxHp, state.hp + amount);
  return state.hp - before;
}
export function spawnWave(state, rand = Math.random) {
  state.wave += 1;
  state.level = state.hpMode ? levelForWave(state.wave) : (state.wave - 1) % 3;
  const level = LEVELS[state.level];
  // The skate level runs its own scripted waves (skate.js); hold the normal
  // wave-clear rule until it reports the run is over.
  if (state.level === SKATE_LEVEL) { state.holdWave = true; state.skateStart = true; return 0; }
  if (state.hpMode) {
    // Iteration 7: a walking level is one long authored run (events.js beats);
    // start at the left edge with an opening pair and hold until the end beat.
    state.player.x = 80; state.player.y = level.walkables[0].y + Math.min(50, level.walkables[0].h / 2); state.cameraX = 0;
    state.holdWave = true; state.walkLevel = true;
    const kinds = [['brawler', 17, 2], ['striker', 14, 1]];
    const dsc = state.difficulty === 'easy' ? .7 : (state.difficulty === 'hard' ? 1.35 : 1);
    kinds.forEach(([kind, r, hp], i) => state.ninjas.push({ kind, level: state.level, x: 520 + i * 90, y: level.spawnY(rand), r, hp: Math.max(1, Math.round(hp * dsc)), maxHp: Math.max(1, Math.round(hp * dsc)), vx: -60, vy: 0 }));
    return kinds.length;
  }
  const n = 2 + state.wave * 2;
  const speed = 50 + state.wave * 12;
  for (let i = 0; i < n; i++) {
    state.ninjas.push({
      kind: 'foot', level: state.level, x: (state.hpMode ? (state.cameraX || 0) : 0) + W + 20 + i * 45, y: level.spawnY(rand),
      r: 14, hp: 1, maxHp: 1, vx: -(speed + rand() * 30), vy: (rand() - 0.5) * 80
    });
  }
  // Faster, smaller threats start appearing once the player has room to move.
  if (state.wave >= 2) {
    const runners = Math.min(state.wave - 1, 4);
    for (let i = 0; i < runners; i++) {
      state.ninjas.push({
        kind: 'runner', level: state.level, x: (state.hpMode ? (state.cameraX || 0) : 0) + W + 40 + i * 55, y: level.spawnY(rand),
        r: 11, hp: 1, maxHp: 1,
        vx: -(speed + 55 + rand() * 45), vy: (rand() - 0.5) * 170
      });
    }
  }
  // Armored troopers soak two hits and arrive in waves 3+.
  if (state.wave >= 3) {
    const troopers = Math.min(Math.floor(state.wave / 3), 3);
    for (let i = 0; i < troopers; i++) {
      state.ninjas.push({
        kind: 'trooper', level: state.level, x: (state.hpMode ? (state.cameraX || 0) : 0) + W + 55 + i * 70, y: level.spawnY(rand),
        r: 17, hp: 2, maxHp: 2,
        vx: -(36 + state.wave * 4), vy: (rand() - 0.5) * 45
      });
    }
  }
  // Hazards always telegraph before they can hurt you: a crusher is harmless (and
  // flagged for the warning ring) while its warn timer is running.
  // Pressure from above: a few slow alternating crushers. Dropping below them is risky,
  // and they reset if their wave is cleared.
  state.hazards = state.hazards || [];
  for (let i = 0; i < (state.wave >= 4 ? 2 : 1); i++) {
    state.hazards.push({
      kind: 'crusher', x: 110 + i * 250 + (state.wave * 37 % 120),
      y: -40 - ((i + state.wave) % 3) * 55, r: 18,
      vx: (i % 2 ? 1 : -1) * 18, vy: 55 + state.wave * 7, phase: Math.random() * 6.28,
      // Telegraph: out of play until this runs out, so a crusher is never silently
      // lethal. Re-armed on every bounce by the step below.
      warn: HAZARD_TELEGRAPH_DEFAULT, dead: false
    });
  }
  if (state.wave % 5 === 0) {
    state.ninjas.push({
      kind: 'boss', level: state.level, x: (state.hpMode ? (state.cameraX || 0) : 0) + W + 60, y: level.spawnY(rand), r: 26,
      vx: -(38 + state.wave * 3), vy: (rand() - 0.5) * 35,
      hp: 4 + Math.floor(state.wave / 5), maxHp: 4 + Math.floor(state.wave / 5)
    });
  }
  // A care package every even wave gives the player something to chase.
  if (state.wave % 2 === 0) spawnPowerup(state, { x: (state.hpMode ? state.player.x + 140 : W / 2), y: 60 + rand() * (H - 120) }, rand);
  return n;
}
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function movePlayer(p, dx, dy, dt, level = undefined) {
  if (level === undefined) {
    p.x = clamp(p.x + dx * p.speed * dt, p.r, W - p.r);
    p.y = clamp(p.y + dy * p.speed * dt, p.r, H - p.r);
    return p;
  }
  const next = moveWalkable(p, dx, dy, dt, level);
  p.x = next.x; p.y = next.y;
  return p;
}
// Iteration 7: characters draw at 2x (parts re-sliced at torso 68px). Body r stays
// the floor footprint for walkability; hit/hurt checks use r * CHAR_SCALE.
export const CHAR_SCALE = 2;
function hitsBody(a, b) {
  // Tall bodies: the hurt box spans from the feet up the whole drawn figure.
  // Same rule as melee hitboxes: x overlap with the hurtbox and the same depth
  // lane (+-14px plus the projectile radius); pizzas fly in the thrower's lane.
  const R = hurtR(b) * 0.55;
  return Math.abs(a.x - b.x) < a.r + R && Math.abs(a.y - b.y) <= 14 + a.r;
}
export const hurtR = b => (b && b.r || 0) * CHAR_SCALE;
export function collides(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy < (a.r + b.r) ** 2;
}
export function throwPizza(state) {
  const p = state.player;
  const n = state.spreadTimer > 0 ? 3 : 1;
  const speed = 420 + state.weaponLevel * 25;
  // Thrown the way the hero faces; in the beat 'em up (hpMode) a spread fans out
  // in depth only slightly and every pizza has a limited flight range.
  const face = state.hpMode && state.combat && state.combat.facing < 0 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const a = (i - (n - 1) / 2) * (state.hpMode ? 0.06 : 0.28);
    state.pizzas.push({ x: p.x + p.r * face, y: p.y, r: 8, vx: Math.cos(a) * speed * face, vy: Math.sin(a) * speed, piercing: state.weaponLevel >= 3, x0: p.x, face });
  }
}
export function loseLife(state) {
  if (state.hpMode) { damagePlayer(state, 25); return state; }
  if (state.over || state.player.shield) return state;
  state.lives -= 1; state.invuln = 1.5;
  if (state.lives <= 0) { state.lives = 0; state.over = true; }
  return state;
}
export function spawnPowerup(state, at, rand = Math.random) {
  const types = ['rapid', 'rapid', 'spread', 'shield', 'weapon', 'score', 'life'];
  const type = types[Math.floor(rand() * types.length)];
  state.powerups.push({
    x: at.x, y: at.y, r: 12, type,
    vx: (rand() - 0.5) * 35,
    vy: 20 + rand() * 25
  });
  return type;
}
function normalize(ninja) {
  if (!ninja.kind) ninja.kind = 'foot';
  if (ninja.hp == null) ninja.hp = 1;
  if (ninja.maxHp == null) ninja.maxHp = ninja.hp;
  if (ninja.vy == null) ninja.vy = 0;
}
function dropPowerupFor(state, ninja, rand) {
  const chance = ninja.kind === 'boss' ? 1 : ninja.kind === 'trooper' ? 0.55 : 0.22;
  if (rand() <= chance) spawnPowerup(state, { x: ninja.x, y: ninja.y }, rand);
}
// One damage path for every source (pizza, punch, kick, jump kick), so combo,
// scoring and power-up drop rules can never drift apart between subsystems.
export function damageNinja(state, ninja, dmg, rand = Math.random) {
  if (!ninja || ninja.dead) return null;
  normalize(ninja);
  state.combo += 1;
  state.comboTimer = 2.5;
  state.bestCombo = Math.max(state.bestCombo || 0, state.combo);
  if (state.weaponLevel > 1 && !isFinite(state.weaponDurability || 0)) state.weaponDurability = 24 * state.weaponLevel;
  if (ninja.kind === 'boss') {
    ninja.hp -= Math.max(1, dmg);
    state.score += (ninja.hp <= 0 ? 600 : 90) * state.wave * state.combo;
    if (ninja.hp <= 0) { ninja.dead = true; state.weaponLevel = Math.min(5, state.weaponLevel + 1); dropPowerupFor(state, ninja, rand); dropPowerupFor(state, ninja, rand); }
  } else {
    // hp, not kind, decides survival: keeps one-hit mooks unchanged while letting
    // scripted elites (hp > 1) take several hits.
    ninja.hp -= Math.max(1, dmg);
    if (ninja.hp > 0) { state.score += 40 * state.wave * state.combo; return ninja; }
    ninja.dead = true;
    if (state.weaponLevel > 1) state.weaponDurability = Math.max(state.weaponDurability || 0, 24 * state.weaponLevel);
    const base = ninja.kind === 'trooper' ? 180 : ninja.kind === 'runner' ? 150 : 100;
    state.score += base * state.wave * state.combo;
    dropPowerupFor(state, ninja, rand);
  }
  if (state.weaponLevel > 1 && (state.weaponDurability || 0) > 0) {
    state.weaponDurability = Math.max(0, (state.weaponDurability || 0) - 1);
    if (state.weaponDurability <= 0) { state.weaponLevel = Math.max(1, state.weaponLevel - 1); state.weaponDurability = state.weaponLevel > 1 ? 24 * state.weaponLevel : 0; }
  }
  return ninja;
}
export function update(state, dt, rand = Math.random) {
  if (state.over) return state;
  if (state.level === undefined) state.level = 0;
  for (const n of state.ninjas) normalize(n);
  state.invuln = Math.max(0, state.invuln - dt);
  state.comboTimer = Math.max(0, state.comboTimer - dt);
  state.rapidTimer = Math.max(0, state.rapidTimer - dt);
  state.spreadTimer = Math.max(0, state.spreadTimer - dt);
  if (state.comboTimer === 0) state.combo = 0;
  for (const z of state.pizzas) {
    z.x += z.vx * dt;
    if (z.vy == null) z.vy = 0;
    z.y += z.vy * dt;
    if (z.y < z.r || z.y > H - z.r) { z.vy = -z.vy; z.y = clamp(z.y, z.r, H - z.r); }
  }
  for (const n of state.ninjas) {
    // Manual test actors keep their caller-supplied coordinates; spawned actors carry their own level.
    const beforeX = n.x, beforeY = n.y;
    n.x += n.vx * dt;
    n.y = clamp(n.y + n.vy * dt, n.r, H - n.r);
    if (n.level != null && !isWalkable(n.level, n.x, n.y, n.r)) {
      const fixed = resolveWalkable(n.level, n.x, n.y, n.r);
      if (n.bounce && Math.abs(n.knock || 0) >= 120 && n.x === beforeX) {
        n.knock = -Math.sign(n.knock || 1) * Math.max(80, Math.abs(n.knock || 0) * 0.62);
        n.stun = Math.max(n.stun || 0, 0.22);
        if (!n.react || n.react === 'flinch') n.react = 'stagger';
        if (state.fxCue) state.fxCue('hit', { x: n.x, y: n.y - (n.z || 0), heavy: true, shake: 0.12 });
      }
      n.x = fixed.x; n.y = fixed.y;
      if (n.x === beforeX) n.vx = -n.vx;
      if (n.y === beforeY) n.vy = -n.vy;
    }
    if (n.y <= n.r || n.y >= H - n.r) n.vy = -n.vy;
  }
  for (const z of state.pizzas) {
    if (z.dead) continue;
    for (const n of state.ninjas) {
      if (n.dead || !(state.hpMode ? hitsBody(z, n) : collides(z, n))) continue;
      z.dead = !z.piercing;
      damageNinja(state, n, state.weaponLevel - 1, rand);
    }
  }
  for (const n of state.ninjas) {
    if (n.dead) continue;
    if (state.hpMode) { if (n.x < -40 || n.x > (LEVELS[state.level || 0].width || 1e9) + 300) n.dead = true; continue; }
    if (state.invuln <= 0 && collides(n, state.player)) {
      if (state.player.shield) {
        state.player.shield = false; n.dead = true; dropPowerupFor(state, n, rand);
      } else {
        state.combo = 0; state.comboTimer = 0; n.dead = true; loseLife(state);
      }
    } else if (n.x < -20) {
      state.combo = 0; state.comboTimer = 0; n.dead = true; loseLife(state);
    }
  }
  for (const pw of state.powerups) {
    if (state.hpMode) {
      // Side-scroller: pickups drop to the floor band where they landed and stay.
      const lv = LEVELS[state.level || 0], band = (lv.walkables || [])[0];
      if (pw.floorY == null) pw.floorY = band ? Math.min(band.y + band.h - pw.r, Math.max(band.y + pw.r, state.player.y)) : H - 60;
      if (pw.y < pw.floorY) pw.y = Math.min(pw.floorY, pw.y + 260 * dt); else pw.y = pw.floorY;
      pw.vx = 0;
    } else {
    pw.x = clamp(pw.x + pw.vx * dt, pw.r, W - pw.r);
    pw.y = clamp(pw.y + pw.vy * dt, pw.r, H - pw.r);
    if (pw.y <= pw.r || pw.y >= H - pw.r) pw.vy = -pw.vy;
    }
    if (state.hpMode ? hitsBody(pw, state.player) : collides(pw, state.player)) {
      pw.dead = true;
      switch (pw.type) {
        case 'life': if (state.hpMode) { healPlayer(state, 40); pw.healed = true; } else state.lives = Math.min(5, state.lives + 1); break;
        case 'rapid': state.rapidTimer = Math.max(state.rapidTimer, 10 + state.wave); break;
        case 'spread': state.spreadTimer = Math.max(state.spreadTimer, 15 + state.wave); break;
        case 'shield': state.player.shield = true; break;
        case 'weapon': state.weaponLevel = Math.min(5, state.weaponLevel + 1); state.weaponDurability = Math.max(state.weaponDurability || 0, 24 * state.weaponLevel); break;
        case 'score': state.score += 350 * state.wave; break;
      }
    }
  }
  for (const h of state.hazards) {
    h.x = clamp(h.x + h.vx * dt, h.r, W - h.r);
    h.y += h.vy * dt;
    if (h.y < -h.r || h.y > H + h.r) {
      h.vx = -h.vx; h.y = h.y < 0 ? -h.r : H + h.r;
      h.warn = HAZARD_TELEGRAPH_DEFAULT * 0.7;              // telegraph again after every bounce
    }
    if (h.warn > 0) { h.warn = Math.max(0, h.warn - dt); continue; }   // safe while it warns
    if (!h.dead && state.invuln <= 0 && collides(h, state.player)) {
      if (state.player.shield) { state.player.shield = false; h.vy = -Math.abs(h.vy); }
      else {
        state.combo = 0; state.comboTimer = 0; h.vy = -Math.abs(h.vy);
        if (state.fxCue) state.fxCue('hit', { x: h.x, y: h.y, heavy: true, shake: 0.3 });
        if (state.audioCue) state.audioCue('thud');
        loseLife(state);
      }
    }
  }
  state.hazards = state.hazards.filter(h => h && !h.dead);
  state.pizzas = state.pizzas.filter(z => !z.dead && (state.hpMode ? Math.abs(z.x - (z.x0 ?? z.x)) < 380 : z.x < W + 30) && z.y > -30 && z.y < H + 30);
  state.ninjas = state.ninjas.filter(n => !n.dead);
  state.powerups = state.powerups.filter(p => !p.dead && (state.hpMode || (p.x > -30 && p.x < W + 30 && p.y > -30 && p.y < H + 30)));
  const __level = LEVELS[state.level || 0];
  // Camera framing: a dead-zone in the middle of the screen, so walking does not slide
  // the whole world for every step. The camera only moves once the player pushes past
  // the band, then eases so there is no frame-to-frame jitter; the edges still clamp.
  // Fight holds (state.events.camX and the arena lock) are blended in below as framing targets and the result
  // follows through cameraFollow's spring (baba_booey, t_9ec48322f6de4bf7); game.js renders s.cameraX as is.
  if (__level.width && !__level.auto) {
    const maxX = Math.max(0, __level.width - W);
    const dead = W * CAMERA_DEAD_ZONE;
    if (state.cameraX == null) state.cameraX = Math.max(0, Math.min(maxX, state.player.x - W / 2));
    // focus: the player (dead-zone band), or the co-op midpoint coop.js left for this frame (centred)
    const fr = state.__camFrame || (state.__camFrame = { focus: null, hold: null, w: 0 });
    const blend = 1 - Math.exp(-Math.max(0, dt) * CAMERA_FRAME_BLEND);
    let target;
    if (Number.isFinite(state.camFocusX)) {
      fr.focus = fr.focus == null || Math.abs(fr.focus - state.camFocusX) > W ? state.camFocusX : fr.focus + (state.camFocusX - fr.focus) * blend;
      target = fr.focus - W / 2; state.camFocusX = null;
    } else {
      fr.focus = null;
      const screenX = state.player.x - state.cameraX;
      target = state.cameraX;
      if (screenX < W / 2 - dead) target = state.player.x - (W / 2 - dead);
      else if (screenX > W / 2 + dead) target = state.player.x - (W / 2 + dead);
    }
    // scripted holds / the arena lock (events.camX) are a second framing target, blended in and out
    const ev = state.events && state.events.camX != null ? state.events.camX - W / 2 : null;
    if (ev != null) fr.hold = fr.hold == null ? ev : fr.hold + (ev - fr.hold) * blend;
    fr.w += ((ev != null ? 1 : 0) - fr.w) * blend;
    if (fr.w < 0.002 && ev == null) { fr.w = 0; fr.hold = null; }
    if (fr.hold != null) { const w = fr.w * fr.w * (3 - 2 * fr.w); target = target + (fr.hold - target) * w; }
    target = Math.max(0, Math.min(maxX, target));
    cameraFollow(state, target, maxX, dt);
  }
  if (!state.over && state.ninjas.length === 0 && !state.holdWave && !state.runComplete) {
    if (state.hpMode) healPlayer(state, state.wave >= 2 ? 20 : 0);
    else state.lives = Math.min(5, state.lives + (state.wave >= 2 ? 1 : 0));
    spawnWave(state, rand);
    if (!state.holdWave) spawnPowerup(state, { x: state.hpMode ? state.player.x + 120 : W / 2, y: H / 2 }, rand);
  }
  return state;
}
