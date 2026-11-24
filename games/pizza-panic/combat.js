// AGENT ARMEGEDDON: CLAWPOCALYPSE NOW melee combat + movement (iteration 6: combat feel).
//
// Owns input-driven locomotion (walk, lane depth, jump, dash) and the attack
// state machine, plus the shared beat 'em up systems:
//   - hit-stop and shake scaled by move weight (shake via state.fxCue 'hit')
//   - a 0.25 s input buffer and recovery cancels, so strings flow
//   - 4-hit punch string with a distinct knockdown finisher; kick; launcher
//     (kick after 2+ punches) and air juggles (cap 3); dash attack (double-tap);
//     auto-grab of a stunned enemy (knees, throw); back attack (J+K); a
//     health-cost, invulnerable special (J+L)
//   - enemy hit reactions: flinch, stagger, knockdown (with wake-up i-frames)
//     and launch; blockers guard frontal hits
//   - enemy attack tokens, so only 2-3 enemies attack at once while the rest
//     hold their distance and circle (state.hpMode only)
// Damage to enemies goes through logic.js damageNinja(); damage to the player
// through logic.js damagePlayer() (the HP bar).
//
// Animation contract (Hermes, rig.js): c.attack.name is a mechanic name
// (launcher, juggle, dashAttack, grab, grabThrow, backAttack, healthSpecial) or
// punch/kick/jumpKick; enemies set ninja.move / ninja.phase.
import { CHAR_SCALE, movePlayer, damageNinja, damagePlayer, isWalkable, resolveWalkable, levelForIndex, clamp } from './logic.js';

const GRAVITY = 1400, JUMP_V = 560; // taller jump to match the 2x characters
const SZ = CHAR_SCALE, RANGE_K = 1.8; // attack reach scales a touch under body size
const WALK_AIR = 1.9;
const LANE_TOLERANCE = 30, CHAIN_WINDOW = 0.55, BUFFER = 0.25, CHORD = 0.1, TAP = 0.25;
const JUGGLE_CAP = 5, SPECIAL_COST = 8, RUN = 1.75;

export function snapToLevel(state, body = state.player) {
  if (state.level == null || !body) return body;
  if (isWalkable(state.level, body.x, body.y, body.r)) return body;
  const fixed = resolveWalkable(state.level, body.x, body.y, body.r || 0);
  if (fixed) { body.x = fixed.x; body.y = fixed.y; }
  return body;
}

// wind / active / rec are seconds; react is the enemy hit reaction; stop is
// hit-stop seconds; shake feeds the camera. Light hits are short and cancel
// into the next; heavy hits hold longer and knock down.
import { heroMove } from './hero-moves.js';
import { GRAB_HOLD, canGrab, grabMove, releaseGrab, stepGrab } from './grab.js'; // MR.INDIA grab/throw

export const MOVES = {
  punch: [
    { name: 'punch', label: 'Jab', dmg: 1, range: 36, wind: 0.07, active: 0.08, rec: 0.14, knock: 70, react: 'flinch', stop: 0.05, shake: 0.08 },
    { name: 'punch', label: 'Jab 2', dmg: 1, range: 36, wind: 0.07, active: 0.08, rec: 0.14, knock: 80, react: 'flinch', stop: 0.05, shake: 0.08 },
    { name: 'punch', label: 'Hook', dmg: 1, range: 40, wind: 0.09, active: 0.09, rec: 0.17, knock: 130, react: 'stagger', stop: 0.07, shake: 0.12 },
    { name: 'punch', label: 'Finisher', dmg: 2, range: 46, wind: 0.13, active: 0.12, rec: 0.3, knock: 330, react: 'knockdown', stop: 0.11, shake: 0.26, heavy: true },
  ],
  kick: { name: 'kick', label: 'Kick', dmg: 2, range: 50, wind: 0.15, active: 0.11, rec: 0.24, knock: 240, react: 'stagger', stop: 0.08, shake: 0.16, heavy: true },
  launcher: { name: 'launcher', label: 'Launcher', dmg: 2, range: 42, wind: 0.1, active: 0.11, rec: 0.18, knock: 40, react: 'launch', stop: 0.1, shake: 0.2, heavy: true },
  jumpKick: { name: 'jumpKick', label: 'Jump kick', dmg: 2, range: 44, wind: 0.05, active: 0.18, rec: 0.1, knock: 300, react: 'knockdown', stop: 0.08, shake: 0.18, heavy: true, air: true, pierceGuard: true },
  juggle: { name: 'juggle', label: 'Air juggle', dmg: 1, range: 46, wind: 0.05, active: 0.1, rec: 0.08, knock: 50, react: 'launch', stop: 0.07, shake: 0.12, air: true, juggle: true, pierceGuard: true },
  dashAttack: { name: 'dashAttack', label: 'Dash attack', dmg: 2, range: 48, wind: 0.06, active: 0.16, rec: 0.26, knock: 360, react: 'knockdown', stop: 0.1, shake: 0.22, heavy: true, lunge: 60 },
  backAttack: { name: 'backAttack', label: 'Back attack', dmg: 2, range: 44, wind: 0.08, active: 0.12, rec: 0.22, knock: 260, react: 'knockdown', stop: 0.09, shake: 0.18, heavy: true, behind: true, pierceGuard: true },
  healthSpecial: { name: 'healthSpecial', label: 'Special', dmg: 3, range: 78, wind: 0.12, active: 0.22, rec: 0.3, knock: 380, react: 'knockdown', stop: 0.14, shake: 0.4, heavy: true, around: true, cost: SPECIAL_COST, invuln: 0.7, pierceGuard: true },
  knee: { name: 'grab', label: 'Knee', dmg: 1, range: 40, wind: 0.06, active: 0.07, rec: 0.12, knock: 0, react: 'flinch', stop: 0.06, shake: 0.1, grabbed: true },
  grabThrow: { name: 'grabThrow', label: 'Throw', dmg: 3, range: 40, wind: 0.12, active: 0.1, rec: 0.25, knock: 420, react: 'thrown', stop: 0.12, shake: 0.3, heavy: true, grabbed: true, invuln: 0.5, pierceGuard: true },
  // Locomotion: a short dash forward and a longer dodge roll that can go backwards.
  // Both are invulnerable, carry no hitbox, and travel while their window is open.
  dash: { name: 'dash', label: 'Dash', dmg: 0, range: 0, wind: 0.02, active: 0.18, rec: 0.16, invuln: 0.3, speed: 760, roll: true, noHit: true },
  dodgeRoll: { name: 'dodgeRoll', label: 'Dodge Roll', dmg: 0, range: 0, wind: 0.03, active: 0.3, rec: 0.16, invuln: 0.58, speed: 470, roll: true, rollBack: true, noHit: true },
};

export function createCombat(state) {
  state.combat = {
    facing: 1, attack: null, phase: 'idle', timer: 0, hitDone: false, attackFacing: 1,
    chain: 0, chainTimer: 0, lastMove: null, jumpZ: 0, jumpV: 0, airborne: false, hits: 0,
    moveRamp: 0, hitStop: 0, walkT: 0, moving: false, buffer: null, press: {}, now: 0,
    running: false, tap: null, grab: null, landed: 0, log: [],
  };
  if (state.player.z == null) state.player.z = 0;
  snapToLevel(state, state.player);
  state.combat.level = state.level;
  return state.combat;
}

const busy = c => c.phase === 'wind' || c.phase === 'active';
const playerLocked = state => (state.playerDown > 0) || (state.hurtT > 0);

// Double-tap a direction to run (dash). Called on arrow/AD keydown.
export function combatTap(state, dir) {
  const c = state.combat;
  if (!c || !dir) return false;
  if (c.tap && c.tap.dir === dir && c.now - c.tap.t < TAP && !c.airborne) { c.running = true; c.facing = dir; c.tap = null; return true; }
  c.tap = { dir, t: c.now };
  return false;
}

// One press from the key handler. Returns the move name actually started (or
// 'buffered' when it was queued for the first legal frame).
export function combatPress(state, button, opts = {}) {
  const c = state.combat;
  if (!c || state.over) return null;
  const at = c.now;
  const prevPress = { ...c.press };
  c.press[button] = at;
  // Chords: J+K back attack, J+L special. A chord pressed just after its first
  // button upgrades the move that button started (it is still winding up).
  const chordWith = other => prevPress[other] != null && at - prevPress[other] <= CHORD;
  let chord = null;
  if ((button === 'kick' && chordWith('punch')) || (button === 'punch' && chordWith('kick'))) chord = 'backAttack';
  if ((button === 'jump' && chordWith('punch')) || (button === 'punch' && chordWith('jump'))) chord = 'healthSpecial';
  if (chord && !c.grab) {
    if (c.phase === 'wind' || c.phase === 'idle' || c.phase === 'rec' || c.airborne) {
      if (chord === 'healthSpecial' && c.airborne) { c.airborne = false; c.jumpZ = 0; c.jumpV = 0; state.player.z = 0; }
      c.buffer = null; c.chain = 0;
      return start(state, MOVES[chord]);
    }
    // MR.INDIA (t_03fb1fa4bff742d5): a chord finished in an active frame (or hit-stop) is
    // buffered as the chord, not as its 2nd button (that overwrote the J and ate the special).
    c.buffer = { button: chord, t: BUFFER }; return 'buffered';
  }
  if (playerLocked(state)) { c.buffer = { button, t: BUFFER }; return 'buffered'; }
  // Mid-attack presses are buffered and fire the first legal frame.
  if (c.grab && c.attack && c.attack.hold) return fire(state, button, opts);
  if (busy(c)) { c.buffer = { button, t: BUFFER }; return 'buffered'; }
  return fire(state, button, opts);
}

function fire(state, button) {
  const c = state.combat;
  if (c.grab) { const m = grabMove(state, button, c.grabDx || 0); return m ? start(state, m) : null; } // grab.js
  if (button === 'healthSpecial' || button === 'backAttack') { c.chain = 0; return start(state, MOVES[button]); } // buffered chord
  if (button === 'jump') {
    if (c.airborne) return null;
    // Jump cancels recovery (and a buffered jump fires out of hit recovery).
    c.attack = null; c.phase = 'idle';
    c.jumpV = JUMP_V; c.airborne = true; c.running = false;
    if (state.audioCue) state.audioCue('jump');
    return 'jump';
  }
  if (c.airborne) {
    // A launched enemy nearby turns the air attack into a juggle hit.
    const juggled = state.ninjas.some(n => !n.dead && n.juggle && (n.z || 0) > 6 && Math.abs(n.x - state.player.x) < 70 * RANGE_K && Math.abs(n.y - state.player.y) < 40);
    return start(state, juggled ? MOVES.juggle : MOVES.jumpKick);
  }
  if (c.running && button === 'punch') { c.running = false; c.chain = 0; return start(state, MOVES.dashAttack); }
  if (button === 'punch') {
    c.chain = c.chainTimer > 0 && c.chain < MOVES.punch.length ? c.chain + 1 : 1;
    return start(state, { ...MOVES.punch[c.chain - 1], chainKey: 'punch' + c.chain });
  }
  if (button === 'kick') {
    const launch = c.chainTimer > 0 && c.chain >= 2;
    c.chain = 0;
    return start(state, launch ? MOVES.launcher : MOVES.kick);
  }
  return null;
}

function start(state, baseMove) {
  const c = state.combat, p = state.player;
  const move = heroMove(state, baseMove);
  if (move.cost) {
    // Classic beat 'em up desperation special: costs a little health, never lethal.
    const hp = state.hp == null ? null : state.hp;
    if (hp != null) state.hp = Math.max(1, hp - move.cost);
    state.hpHit = (state.hpHit || 0) + 1;
  }
  if (move.invuln) state.invuln = Math.max(state.invuln || 0, move.invuln);
  c.attack = move;
  c.phase = 'wind';
  c.timer = move.wind;
  c.hitDone = false;
  c.lastMove = move.name;
  c.attackFacing = move.behind ? -c.facing : c.facing;
  c.chainTimer = CHAIN_WINDOW;
  c.log.push(move.label || move.name); if (c.log.length > 30) c.log.shift();
  const step = move.lunge || (move.heavy ? 12 : 7);
  if (!move.behind && !move.grabbed && !move.around) {
    const nx = p.x + step * c.facing;
    if (state.level == null || isWalkable(state.level, nx, p.y, p.r)) p.x = nx;
  }
  if (state.audioCue) state.audioCue(move.name === 'punch' ? (move.heavy ? 'finisher' : 'punch') : move.heavy ? 'finisher' : move.name);
  if (state.fxCue) state.fxCue('swing', { x: p.x + 22 * c.attackFacing, y: p.y - 4, facing: c.attackFacing });
  return move.label || move.name;
}

// Dash / dodge roll entry point. dir > 0 dashes forward, dir < 0 dashes forward the
// other way, and 0 rolls backwards away from the way you are facing.
export function combatDash(state, dir = 0) {
  const c = state.combat;
  if (!c || state.over || c.grab || playerLocked(state)) return null;
  if (c.phase === 'wind' || c.phase === 'active') return null;
  if (dir) c.facing = dir > 0 ? 1 : -1;
  const back = !dir;
  if (c.airborne) return null;
  return start(state, back ? MOVES.dodgeRoll : MOVES.dash);
}
export const dashMoves = () => ({ dash: MOVES.dash, dodgeRoll: MOVES.dodgeRoll });

export function combatWalk(state, dx, dy, dt) {
  const p = state.player, c = state.combat;
  c.moving = !!(dx || dy);
  if (playerLocked(state)) { c.moving = false; c.running = false; return; }
  if (c.grab) { c.moving = false; c.grabDx = dx; return; }
  if (dx) {
    const want = dx > 0 ? 1 : -1;
    if (want !== c.facing && !busy(c)) { c.facing = want; c.turnT = 0.12; c.running = false; }
  } else c.running = false;
  if (!c.airborne) {
    if (c.level !== state.level) { c.level = state.level; snapToLevel(state, p); }
    else if (!isWalkable(state.level, p.x, p.y, p.r)) snapToLevel(state, p);
  }
  const mobile = c.phase === 'idle' || (c.airborne && c.attack && c.attack.air);
  if (!mobile) { c.moveRamp = Math.max(0, c.moveRamp - Math.min(1, dt * 14)); return; }
  const target = (dx || dy) ? 1 : 0;
  c.moveRamp += (target - c.moveRamp) * Math.min(1, dt * 12);
  const r = c.airborne ? 1 : c.moveRamp;
  const run = c.running && !c.airborne ? RUN : 1;
  if (c.airborne) {
    if (!c.freeLevel || c.freeLevelIndex !== state.level) {
      c.freeLevel = { ...levelForIndex(state.level), obstacles: [] };
      c.freeLevelIndex = state.level;
    }
    movePlayer(p, dx * WALK_AIR * r, dy * WALK_AIR * r, dt, c.freeLevel);
    return;
  }
  movePlayer(p, dx * r * run, dy * r, dt, state.level);
  // Auto-grab: walking into a stunned enemy grabs it (Final Fight / SoR rule).
  if (dx && c.phase === 'idle' && !c.running) tryGrab(state);
}

function grabbable(n) { return canGrab(n); }
function tryGrab(state) {
  const c = state.combat, p = state.player;
  for (const n of state.ninjas) {
    if (!grabbable(n)) continue;
    const dx = (n.x - p.x) * c.facing;
    if (dx < 0 || dx > (p.r + n.r) * SZ * 0.8 + 10 || Math.abs(n.y - p.y) > 20) continue;
    c.grab = { n, t: GRAB_HOLD, knees: 0 };
    n.grabbed = true; n.vx = 0; n.vy = 0; n.token = false;
    c.attack = { name: 'grab', label: 'Grab', hold: true }; c.phase = 'active'; c.timer = GRAB_HOLD; c.lastMove = 'grab';
    c.log.push('Grab');
    if (state.audioCue) state.audioCue('grab');
    return n;
  }
  return null;
}

// Attack hitboxes (iteration 7 rebuild). A hit needs the attack's box, placed in
// front of the attacker (behind for the back attack, both sides for the special),
// to overlap the target's hurtbox, inside the same depth lane (+-DEPTH px), and
// only during the attack's active frames. Boxes are world coordinates.
export const DEPTH = 14;
export const hurtbox = n => { const hw = n.r * SZ * 0.55; const h = 63 * SZ; const z = n.z || 0; return { x0: n.x - hw, x1: n.x + hw, y: n.y, top: n.y + n.r - h - z, bot: n.y + n.r - z }; };
export function attackBox(state, move) {
  const p = state.player, c = state.combat;
  const reach = move.range * RANGE_K;
  const body = p.r * SZ * 0.3;           // box starts just inside the front of the body
  const f = c.attackFacing;
  let x0, x1;
  if (move.around) { x0 = p.x - reach; x1 = p.x + reach; }
  else if (f > 0) { x0 = p.x + body; x1 = p.x + body + reach; }
  else { x0 = p.x - body - reach; x1 = p.x - body; }
  const z = p.z || 0, h = 63 * SZ;
  return { x0, x1, y: p.y, depth: move.around ? DEPTH * 2 : DEPTH, top: p.y + p.r - h - z - (move.air ? 20 : 0), bot: p.y + p.r - z + (move.air ? 30 : 0) };
}
export function boxHits(box, n) {
  const hb = hurtbox(n);
  if (hb.x1 < box.x0 || hb.x0 > box.x1) return false;
  if (Math.abs(n.y - box.y) > box.depth) return false;
  // Vertical (height) overlap: launched/hovering bodies above a ground attack miss.
  if (hb.bot < box.top || hb.top > box.bot) return false;
  return true;
}
function targets(state, move) {
  const c = state.combat;
  if (move.grabbed) return c.grab ? [c.grab.n] : [];
  const box = attackBox(state, move);
  c.hitbox = { ...box, t: 0.12, move: move.name };
  const p = state.player;
  const out = [];
  for (const n of state.ninjas) {
    if (n.dead || n.down || n.wake > 0 || n.grabbed) continue;
    if (c.struck && c.struck.has(n)) continue;
    if (move.juggle && !n.juggle) continue;
    const nz = n.z || 0;
    if (nz > 20 * SZ && !move.air && move.name !== 'launcher') continue;
    if (boxHits(box, n)) out.push(n);
  }
  out.sort((a, b) => Math.abs(a.x - p.x) - Math.abs(b.x - p.x));
  // Most attacks hit the nearest enemy; heavy ones and specials hit everyone in the box.
  return move.around || move.heavy ? out.slice(0, move.around ? 8 : 3) : out.slice(0, 1);
}

// Apply a hit reaction. Exported for tests and for thrown bodies / hazards.
export function react(state, n, kind, dir, knock) {
  n.hitFlash = 0.12;
  n.atk = null; n.move = null; n.phase = null; n.token = false;
  n.knock = (knock || 60) * dir;
  n.face = -dir;
  if (kind === 'flinch') { n.stun = Math.max(n.stun || 0, 0.26); n.react = 'flinch'; }
  else if (kind === 'stagger') { n.stun = Math.max(n.stun || 0, 0.5); n.react = 'stagger'; }
  else if (kind === 'knockdown' || kind === 'thrown') {
    n.stun = 0.3; n.react = 'knockdown'; n.launchV = kind === 'thrown' ? 300 : 230; n.spin = kind === 'thrown' ? 8 : 0; n.falling = true; n.thrown = kind === 'thrown';
  } else if (kind === 'launch') {
    n.stun = 0.5; n.react = 'launch'; n.launchV = Math.max(n.launchV || 0, n.juggle ? 330 : 520); n.juggle = true; n.falling = true;
    n.juggles = (n.juggles || 0) + 1;
    if (n.juggles > JUGGLE_CAP) { n.juggle = false; n.react = 'knockdown'; }
  }
  // Armored heavies (charger, boss, elites) shrug off flinches.
  if ((n.kind === 'charger' || n.kind === 'boss' || n.elite) && kind === 'flinch') { n.stun = 0.08; n.knock *= 0.3; }
  n.bounce = (kind === 'knockdown' || kind === 'thrown' || kind === 'launch') && Math.abs(knock || 0) >= 120;
  n.groundBounce = false;
}

function land(state, move, quiet = false) {
  const c = state.combat;
  if (move.noHit) return null;                 // locomotion: no hitbox at all
  const list = targets(state, move);
  if (!list.length) { if (!quiet && state.audioCue) state.audioCue('whiff'); return null; }
  c.hits += 1;
  if (c.struck) for (const n of list) c.struck.add(n);
  let hitAny = false;
  for (const n of list) {
    // Blockers guard frontal ground hits: hit them from behind, with a jump
    // kick, a back attack, a throw or the special.
    const front = Math.sign(state.player.x - n.x) === Math.sign(n.face || -1);
    if (n.kind === 'blocker' && !n.stun && !move.pierceGuard && front && !n.atk) {
      n.hitFlash = 0.06; n.knock = 60 * c.attackFacing; n.stun = 0.08; n.guardHit = 0.25;
      // A perfect block is one caught at the heart of the swing's first impact frame.
      n.parry = !!(move.heavy || (c.timer <= 0.05));
      if (n.parry) { n.stun = 0.18; n.knock *= 2; }
      if (state.audioCue) state.audioCue(n.parry ? 'pause' : 'block');
      if (state.fxCue) state.fxCue('hit', { x: n.x, y: n.y, heavy: n.parry, shake: n.parry ? 0.1 : 0.05, blocked: true, parry: n.parry });
      c.hitStop = Math.max(c.hitStop, n.parry ? 0.06 : 0.04);
      if (n.parry) c.chain += 0;
      continue;
    }
    hitAny = true;
    damageNinja(state, n, move.dmg, Math.random);
    react(state, n, move.react, c.attackFacing, move.knock * 1.5); // knock/throw distance scaled for 2x bodies
    if (state.fxCue) state.fxCue('hit', { x: n.x, y: n.y - (n.z || 0), heavy: !!move.heavy, shake: move.shake });
  }
  if (move.release && c.grab) releaseGrab(state, move);
  else if (move.name === 'grabThrow' && c.grab) { c.grab.n.grabbed = false; c.grab = null; }
  if (hitAny && move.juggle) state.score += 75 * Math.max(1, state.combo || 1);   // keep them up, get paid
  if (hitAny) {
    c.hitStop = Math.max(c.hitStop, move.stop || 0.05);
    c.landed += 1;
    if (state.audioCue) {
      if (move.heavy) { state.audioCue('melee'); state.audioCue('heavy'); }
      else state.audioCue('melee');
    }
  }
  return list[0];
}

// Enemy AI with attack tokens (hpMode only). Each enemy either holds a token and
// closes in to attack with a telegraphed wind-up, or waits at a distance and
// circles. Tokens go to the nearest enemies, capped by wave.
const KIND_ATTACK = {
  brawler: { move: 'swing', wind: 0.5, dmg: 9, range: 44 }, striker: { move: 'dash', wind: 0.4, dmg: 6, range: 52 },
  blocker: { move: 'bash', wind: 0.45, dmg: 8, range: 40 }, thrower: { move: 'throw', wind: 0.5, dmg: 7, range: 260, ranged: true },
  charger: { move: 'charge', wind: 0.65, dmg: 12, range: 60, lunge: 90 }, acrobat: { move: 'jumpkick', wind: 0.42, dmg: 8, range: 50 },
  skater: { move: 'swing', wind: 0.45, dmg: 9, range: 46 }, boss: { move: null, wind: 0.5, dmg: 16, range: 52 },
  drone: { move: null, wind: 0.5, dmg: 7, range: 240, ranged: true },
};
const DEFAULT_ATTACK = { move: null, wind: 0.45, dmg: 8, range: 40 };
// Balance: longer telegraphs early (sewer x1.3, street x1.15), base speed from the skate level on.
export const WIND_SCALE = { 0: 1.3, 1: 1.15 };
export const windFor = (state, spec) => spec.wind * (WIND_SCALE[state.level | 0] || 1);
const reachOf = spec => spec.ranged ? spec.range : spec.range * RANGE_K;
const SPEED = { striker: 120, runner: 120, acrobat: 105, charger: 70, blocker: 60, boss: 65, thrower: 75, skater: 110, drone: 90 };

export function maxTokens(state) { return state.wave >= 4 ? 3 : 2; }
// Token fairness (baba_booey, t_fa98e68e0b7b4fc4): a holder that can't start its attack
// for this long (out of reach, kited) hands the token to the longest waiter.
export const TOKEN_HOLD_MAX = 2.5;

export function enemyAI(state, dt) {
  const p = state.player;
  const live = state.ninjas.filter(n => !n.dead && !n.scripted && (!state.coopFilter || state.coopFilter(n))); // cheese: co-op target split (coop.js)
  // Taunt aggro (t_4c09d44981a04666): a taunt gives nearby enemies credit time,
  // so the token passes to those closest to the hero and one extra can attack.
  if (state.taunt && state.taunt > 0) {
    for (const n of live) {
      if (Math.hypot(n.x - p.x, n.y - p.y) < 320) n.waitT = Math.max(n.waitT || 0, 2.25);
    }
  }
  // Release tokens from enemies that can't use them; grant to the longest waiter
  // (waitT; 500 px of distance counts as 1 s, so a fresh wave still goes nearest-first).
  // Idle holders time out after TOKEN_HOLD_MAX, so nobody holds or waits forever.
  const ready = n => !(n.stun > 0) && !n.down && !n.grabbed && !((n.z || 0) > 4);
  for (const n of live) {
    if (n.token && !ready(n)) n.token = false;
    const gap = Math.abs(n.x - p.x) + Math.abs(n.y - p.y), closing = gap < (n.tokGap ?? Infinity) - 0.25; n.tokGap = gap;
    n.holdT = n.token && !n.atk ? (closing ? n.holdT || 0 : (n.holdT || 0) + dt) : 0; // walking in doesn't count
    if (!n.token && !n.atk && ready(n)) n.waitT = (n.waitT || 0) + dt;
  }
  const want = live.filter(n => !n.token && !n.atk && ready(n) && !(n.tokenCd > 0))
    .sort((a, b) => ((b.waitT || 0) - Math.abs(b.x - p.x) / 500) - ((a.waitT || 0) - Math.abs(a.x - p.x) / 500));
  if (want.length) { const stale = live.find(n => n.token && !n.atk && n.holdT > TOKEN_HOLD_MAX); if (stale) { stale.token = false; stale.holdT = 0; stale.tokenCd = 0.6; } }
  const tokenCap = (state.taunt && state.taunt > 0) ? maxTokens(state) + 1 : maxTokens(state);
  let free = tokenCap - live.filter(n => n.token).length;
  for (const n of want) { if (free <= 0) break; n.token = true; n.waitT = 0; free -= 1; }
  // over the cap (an attacker switched co-op pools mid-swing keeps its token): idle holders step back
  for (const n of live) { if (free >= 0) break; if (n.token && !n.atk) { n.token = false; n.tokenCd = 0.6; free += 1; } }
  // own property: coop.js's P2 view inherits from the shared state, and a shared tracker made both pools read a
  // ~260 px/frame 'player speed' (P1/P2 alternating), so lead-aim pushed every melee holder just out of reach
  if (!Object.prototype.hasOwnProperty.call(state, '__enemyPlayerPrev')) state.__enemyPlayerPrev = { x: p.x, y: p.y };
  const _pdt = Math.max(dt, 1 / 120);
  const pSpeedX = Math.max(-260, Math.min(260, (p.x - state.__enemyPlayerPrev.x) / _pdt));
  state.__enemyPlayerPrev.x = p.x; state.__enemyPlayerPrev.y = p.y;
  const aimX = p.x + Math.max(-26, Math.min(26, pSpeedX * 0.12));
  const base = state.scrollSpeed || 0;
  let idx = 0;
  for (const n of live) {
    idx += 1;
    if (n.tokenCd > 0) n.tokenCd -= dt;
    if (n.cool > 0) n.cool -= dt;
    if (n.grabbed) { n.vx = 0; n.vy = 0; continue; }
    if (n.stun > 0 || n.down || (n.z || 0) > 4) { n.vx = base; n.vy = 0; continue; }
    const spec = KIND_ATTACK[n.kind] || DEFAULT_ATTACK;
    const dx = p.x - n.x, dy = p.y - n.y;
    const side = dx > 0 ? -1 : 1; // which side of the player this enemy stands on
    if (!n.atk) n.face = dx > 0 ? 1 : -1; // facing locks for the whole attack
    const sp = SPEED[n.kind] || 80;
    if (n.atk) {
      n.vx = base; n.vy = 0;
      n.atk.t -= dt;
      if (n.atk.phase === 'wind' && n.atk.t <= 0) {
        n.atk.phase = 'active'; n.atk.t = 0.12; n.atk.dur = 0.12; n.phase = 'active';
        if (spec.lunge) n.x += spec.lunge * n.face * 0.5;
        if (spec.ranged) {
          state.enemyShots = state.enemyShots || [];
          state.enemyShots.push({ x: n.x + n.face * 16 * SZ, y: n.y - 18 * SZ, vx: n.face * 260, r: 7, dmg: spec.dmg, t: 0, kind: n.kind });
        } else if (Math.abs(p.x - n.x) <= reachOf(spec) + (spec.lunge || 0) * 0.6 && Math.abs(p.y - n.y) <= DEPTH && Math.sign(p.x - n.x) === (n.face || -1) && !((p.z || 0) > 16 * SZ)) {
          damagePlayer(state, spec.dmg, n);
        }
      } else if (n.atk.phase === 'active' && n.atk.t <= 0) { n.atk.phase = 'recover'; n.atk.t = 0.35; n.atk.dur = 0.35; n.phase = 'recover'; }
      else if (n.atk.phase === 'recover' && n.atk.t <= 0) {
        n.atk = null; n.move = null; n.phase = null; n.cool = 1.1 + Math.random() * 0.8;
        // Pass the token on after an attack so the pressure rotates.
        n.token = false; n.tokenCd = 0.6;
      }
      continue;
    }
    let tx, ty;
    if (n.token) {
      const dist = spec.ranged ? spec.range - 24 : Math.max(40, reachOf(spec) - 16); // ranged: stand inside range (260 sat on the edge)
      tx = aimX + side * dist; ty = p.y;
      const inRange = Math.abs(dx) <= reachOf(spec) && Math.abs(dy) < DEPTH - 3 && (spec.ranged || Math.abs(dx) >= 24);
      if (inRange && !(n.cool > 0)) {
        n.atk = { phase: 'wind', t: spec.wind, dur: spec.wind }; n.move = spec.move; n.phase = 'wind';
        n.vx = base; n.vy = 0; continue;
      }
    } else {
      // Waiting: hold a ring around the player and drift (circling), so the crowd
      // stays readable and doesn't stack.
      const ring = 190 + (idx % 3) * 50;
      tx = p.x + side * ring; ty = p.y + Math.sin((state.t || 0) * 0.8 + idx * 1.7) * 30;
    }
    const ex = tx - n.x, ey = ty - n.y;
    const d = Math.hypot(ex, ey);
    const k = d > 6 ? sp / d : 0;
    n.vx = base + ex * k; n.vy = ey * k * 0.7;
  }
  // Enemy projectiles (thrower cutters, drone bolts).
  // Enemy projectiles (thrower cutters, drone bolts).
  if (state.enemyShots) {
    for (const s of state.enemyShots) {
      s.x += s.vx * dt; s.t += dt;
      if (!s.dead && Math.abs(s.x - p.x) < s.r + p.r * SZ * 0.6 && Math.abs(s.y + 18 * SZ - p.y) <= DEPTH + s.r && !((p.z || 0) > 18 * SZ)) { s.dead = true; damagePlayer(state, s.dmg, s); }
      if (s.t > 3) s.dead = true;
    }
    state.enemyShots = state.enemyShots.filter(s => !s.dead);
  }
}

export function combatStep(state, dt) {
  const c = state.combat;
  if (!c) return;
  const p = state.player;
  c.now += dt;
  state.t = (state.t || 0) + dt;
  if (c.hitStop > 0) { c.hitStop = Math.max(0, c.hitStop - dt); return; }
  if (c.turnT > 0) c.turnT = Math.max(0, c.turnT - dt);
  if (state.hurtT > 0) state.hurtT = Math.max(0, state.hurtT - dt);
  if (state.playerDown > 0) { state.playerDown = Math.max(0, state.playerDown - dt); if (!state.playerDown) state.invuln = Math.max(state.invuln || 0, 0.6); }
  if (c.buffer) { c.buffer.t -= dt; if (c.buffer.t <= 0) c.buffer = null; }

  if (c.airborne) {
    c.jumpV -= GRAVITY * dt;
    c.jumpZ += c.jumpV * dt;
    if (c.jumpZ <= 0) {
      c.jumpZ = 0; c.jumpV = 0; c.airborne = false;
      if (c.attack && c.attack.air) { c.attack = null; c.phase = 'idle'; }
      if (state.level != null && !isWalkable(state.level, p.x, p.y, p.r)) {
        let landed = null;
        for (let step = 8; step <= 160; step += 8) {
          const nx = p.x + step * c.facing;
          if (isWalkable(state.level, nx, p.y, p.r)) { landed = nx; break; }
        }
        if (landed !== null) p.x = landed;
        else { const fixed = resolveWalkable(state.level, p.x, p.y, p.r); if (fixed) { p.x = fixed.x; p.y = fixed.y; } }
      }
      if (state.fxCue) state.fxCue('land', { x: p.x, y: p.y + p.r * 0.6, facing: c.facing });
    }
    p.z = c.jumpZ;
    state.invuln = Math.max(state.invuln || 0, 0.06);
  } else p.z = 0;

  if (c.chainTimer > 0) c.chainTimer = Math.max(0, c.chainTimer - dt);
  else if (c.phase === 'idle') c.chain = 0;
  if (c.moving && !c.attack && !c.airborne) c.walkT = (c.walkT || 0) + dt * (c.running ? 1.6 : 1);
  else c.walkT = 0;

  // Grab hold: the enemy is pinned in front; it slips free when the timer runs out.
  stepGrab(state, dt);
  if (c.grab) {
    const n = c.grab.n;
    if (n.dead) { c.grab = null; c.attack = null; c.phase = 'idle'; }
    else {
      n.x = p.x + c.facing * ((p.r + n.r) * SZ * 0.7); n.y = p.y; n.vx = 0; n.vy = 0; n.stun = Math.max(n.stun, 0.2);
      c.grab.t -= dt;
      if (c.grab.t <= 0) { n.grabbed = false; c.grab = null; c.attack = null; c.phase = 'idle'; }
    }
  }

  if (c.attack && !c.attack.hold) {
    c.timer -= dt;
    if (c.phase === 'wind' && c.timer <= 0) { c.phase = 'active'; c.timer = c.attack.active; }
    else if (c.phase === 'active') {
      if (!c.hitDone) { if (!c.struck) c.struck = new Set(); const hit = land(state, c.attack, true); if (hit) c.hitDone = true; }
      // Multi-hit moves (flurries, spinning specials) re-arm their hit window on a
      // tick, so each swing in the animation actually lands.
      if (c.attack.multi > 1) {
        c.multiT = (c.multiT || 0) + dt;
        if (c.multiT >= (c.attack.tick || 0.08)) {
          c.multiT = 0; c.linked = (c.linked || 0) + 1;
          if (c.linked < c.attack.multi) { c.hitDone = false; if (c.struck) c.struck.clear(); }
        }
      }
      if (c.timer <= 0) { if (!c.hitDone && state.audioCue && !c.attack.noHit) state.audioCue('whiff'); c.hitDone = true; c.struck = null; c.multiT = 0; c.linked = 0; c.phase = 'rec'; c.timer = c.attack.rec; }
      // A roll/dash travels while its active window is open, with i-frames held for
      // the whole trip, so it is a real dodge rather than a teleport.
      if (c.attack.roll) {
        const sign = c.attack.rollBack ? -c.facing : c.facing;
        const dist = (c.attack.speed || 520) * dt * sign;
        const nx = p.x + dist;
        if (state.level == null || isWalkable(state.level, nx, p.y, p.r)) p.x = nx;
        else { const half = p.x + dist * 0.35; if (state.level == null || isWalkable(state.level, half, p.y, p.r)) p.x = half; }
        state.invuln = Math.max(state.invuln || 0, 0.08);
      }
    } else if (c.phase === 'rec') {
      // Cancel window: a buffered press during recovery fires right away.
      if (c.buffer && c.hitDone) { const b = c.buffer; c.buffer = null; c.phase = 'idle'; c.attack = c.grab ? { name: 'grab', label: 'Grab', hold: true } : null; if (c.grab) c.phase = 'active'; fire(state, b.button); }
      else if (c.timer <= 0) { c.attack = c.grab ? { name: 'grab', label: 'Grab', hold: true } : null; c.phase = c.grab ? 'active' : 'idle'; }
    }
  } else if (!c.grab) c.phase = c.airborne && c.attack ? c.phase : 'idle';
  if (c.phase === 'idle' && c.buffer && !playerLocked(state)) { const b = c.buffer; c.buffer = null; fire(state, b.button); }
  if (c.grab && c.phase === 'active' && c.buffer && (!c.attack || c.attack.hold)) { const b = c.buffer; c.buffer = null; fire(state, b.button); }

  if (state.coopSecondary) return; // cheese: co-op P2 view (coop.js) runs only its own half; enemies step once, with P1
  // Enemy reactions: stun slide, launch arcs, knockdown and wake-up.
  for (const n of state.ninjas) {
    if (n.dead) continue;
    if (n.hitFlash > 0) n.hitFlash = Math.max(0, n.hitFlash - dt);
    if (n.guardHit > 0) n.guardHit = Math.max(0, n.guardHit - dt);
    if (n.z > 0 || n.launchV) {
      n.z = Math.max(0, (n.z || 0) + (n.launchV || 0) * dt);
      n.launchV = (n.launchV || 0) - 1000 * dt;
      if (n.spin) n.spinAngle = (n.spinAngle || 0) + n.spin * dt;
      if (n.z <= 0) {
        n.z = 0; n.launchV = 0; n.spinAngle = 0; n.spin = 0;
        if (n.falling && !n.groundBounce && Math.abs(n.launchV || 0) >= 260 && n.z < 40) { n.launchV = Math.abs(n.launchV || 0) * 0.45 + 80; n.groundBounce = true; if (state.fxCue) state.fxCue('land', { x: n.x, y: n.y + n.r * 0.6, facing: 1 }); }
        else if (n.falling) { n.falling = false; n.juggle = false; n.juggles = 0; n.down = n.airTech ? 0.5 : 0.85; n.invuln = n.airTech ? Math.max(n.invuln || 0, 0.35) : (n.invuln || 0); n.react = 'down'; if (state.fxCue) state.fxCue('land', { x: n.x, y: n.y + n.r * 0.6, facing: 1 }); if (state.audioCue) state.audioCue('thud'); }

        n.thrown = false;
      }
    }
    // Thrown bodies knock down whoever they hit.
    if (n.thrown) {
      for (const o of state.ninjas) {
        if (o === n || o.dead || o.down || o.falling || o.grabbed || o.thrownBy === n || Math.abs(o.x - n.x) > (o.r + n.r) * SZ * 0.55 || Math.abs(o.y - n.y) > DEPTH) continue;
        o.thrownBy = n;
        damageNinja(state, o, 2, Math.random); react(state, o, 'knockdown', Math.sign(n.knock || 1), 240);
      }
    }
    if (n.down > 0) {
      n.down = Math.max(0, n.down - dt); n.knock = (n.knock || 0) * 0.9;
      n.x += (n.knock || 0) * dt * 0.4;
      if (n.down === 0) { n.wake = 0.45; n.react = 'wake'; }
      continue;
    }
    if (n.wake > 0) { n.wake = Math.max(0, n.wake - dt); if (!n.wake) n.react = null; }
    if (n.stun > 0) {
      n.stun = Math.max(0, n.stun - dt);
      n.x += (n.knock || 0) * dt;
      n.knock = (n.knock || 0) * Math.max(0, 1 - dt * 4);
      if (n.stun === 0) { n.knock = 0; if (n.react === 'flinch' || n.react === 'stagger') n.react = null; }
    }
  }
  if (state.hpMode) enemyAI(state, dt);
}

export function combatInfo(state) {
  const c = state.combat;
  if (!c) return { chain: 0, phase: 'idle', airborne: false, last: null, hitStop: 0 };
  return { chain: c.chain, phase: c.phase, airborne: c.airborne, last: c.lastMove, hitStop: c.hitStop, running: c.running, grab: !!c.grab, label: c.attack && c.attack.label };
}

export const inHitStop = state => !!(state.combat && state.combat.hitStop > 0);
