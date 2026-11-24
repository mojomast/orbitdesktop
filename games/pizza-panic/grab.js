// MR.INDIA: grab and throw (board t_fa795054a3024540).
// combat.js already auto-grabs a stunned enemy (walk into it) and pins it in
// front of the hero; this module decides what each button does while holding,
// owns the moves, and runs/draws the TMNT-style "throw at the screen".
//   punch (neutral or toward)  -> knee, 1 dmg; the 3rd knee releases with a knockdown
//   punch + direction away     -> lane throw behind you: 2 dmg to the thrown enemy,
//                                 the flying body deals 2 + knockdown to everyone in
//                                 its lane (combat.js thrown-body pass)
//   kick or jump               -> screen throw: the enemy flies at the camera,
//                                 scales up and is KO'd (3 dmg, or whatever is left)
// Hold lasts GRAB_HOLD seconds, then the enemy breaks free. Bosses (elite), drones,
// airborne/downed enemies and a shield brute with its guard up can't be grabbed.
// The hero has i-frames for the whole throw animation (move.invuln).
import { damageNinja } from './logic.js';
export const GRAB_HOLD = 1.5;
export const KNEES_TO_RELEASE = 3;
export const SCREEN_THROW_T = 0.7;
const base = { range: 40, stop: 0.08, grabbed: true };
export const GRAB_MOVES = {
  knee: { ...base, name: 'grab', label: 'Knee', dmg: 1, wind: 0.06, active: 0.07, rec: 0.12, knock: 0, react: 'flinch', stop: 0.06, shake: 0.1 },
  kneeFinal: { ...base, name: 'grab', label: 'Knee Breaker', dmg: 1, wind: 0.08, active: 0.08, rec: 0.22, knock: 200, react: 'knockdown', shake: 0.18, heavy: true, release: true, invuln: 0.4, pierceGuard: true },
  laneThrow: { ...base, name: 'grabThrow', label: 'Throw', dmg: 2, wind: 0.12, active: 0.1, rec: 0.25, knock: 420, react: 'thrown', stop: 0.12, shake: 0.3, heavy: true, release: true, invuln: 0.55, pierceGuard: true },
  screenThrow: { ...base, name: 'grabThrow', label: 'Screen Throw', dmg: 3, wind: 0.14, active: 0.1, rec: 0.3, knock: 0, react: 'flinch', stop: 0.14, shake: 0.35, heavy: true, release: true, screen: true, invuln: 0.75, pierceGuard: true },
};

export function canGrab(n) {
  return !!n && !n.dead && n.stun > 0 && !n.down && !((n.z || 0) > 2) && n.kind !== 'boss' && !n.boss && n.kind !== 'drone' && !n.elite && !n.grabbed && !n.guard;
}

// Which move a button fires while holding. dx = held horizontal input (-1/0/1).
export function grabMove(state, button, dx = 0) {
  const c = state.combat; if (!c || !c.grab) return null;
  if (button === 'punch') {
    if (dx && Math.sign(dx) === -c.facing) { c.facing = -c.facing; return GRAB_MOVES.laneThrow; }
    c.grab.knees += 1;
    return c.grab.knees >= KNEES_TO_RELEASE ? GRAB_MOVES.kneeFinal : GRAB_MOVES.knee;
  }
  if (button === 'kick' || button === 'jump') return GRAB_MOVES.screenThrow;
  return null;
}

// Called by combat.js when a releasing move lands on the held enemy.
export function releaseGrab(state, move) {
  const c = state.combat, g = c && c.grab; if (!g) return;
  const n = g.n; n.grabbed = false; c.grab = null;
  if (move.screen) {
    // KO: finish whatever HP is left through the normal damage path (score, drops).
    if (!n.dead && n.hp > 0) damageNinja(state, n, n.hp, Math.random);
    n.dead = true;
    (state.screenThrows ||= []).push({ x: n.x, y: n.y, z: n.z || 0, kind: n.kind, face: c.facing, t: 0 });
    if (state.audioCue) state.audioCue('impact');
  }
}

export function stepGrab(state, dt) {
  const list = state.screenThrows; if (!list || !list.length) return;
  for (const f of list) f.t += dt;
  state.screenThrows = list.filter(f => f.t < SCREEN_THROW_T + 0.35);
}

const IMG = {};
if (typeof Image !== 'undefined') for (const k of ['ninja', 'fx_star']) { const im = new Image(); im.onload = () => { IMG[k] = im; }; im.src = 'assets/' + k + '.png'; }
// Drawn in world space after the actors: the body rushes toward the camera
// (down the screen, growing 1x -> 5x, spinning), then a star "smack" on the glass.
export function drawGrab(ctx, state) {
  for (const f of state.screenThrows || []) {
    const k = Math.min(1, f.t / SCREEN_THROW_T), e = k * k;
    ctx.save();
    if (k < 1) {
      const sc = 1 + e * 4, x = f.x + f.face * 40 * k, y = f.y - 60 - f.z + e * 120;
      ctx.globalAlpha = 1 - Math.max(0, k - 0.85) * 4;
      ctx.translate(x, y); ctx.rotate(k * 5 * f.face); ctx.scale(sc, sc);
      if (IMG.ninja) { const h = 60, w = h * IMG.ninja.width / IMG.ninja.height; ctx.drawImage(IMG.ninja, -w / 2, -h / 2, w, h); }
      else { ctx.fillStyle = '#222'; ctx.beginPath(); ctx.ellipse(0, 0, 14, 26, 0, 0, 7); ctx.fill(); }
    } else {
      const a = 1 - (f.t - SCREEN_THROW_T) / 0.35;
      ctx.globalAlpha = Math.max(0, a);
      ctx.translate(f.x + f.face * 40, f.y + 40 - f.z);
      const s = 2.5 + (1 - a) * 1.5;
      if (IMG.fx_star) { const h = 60 * s; ctx.drawImage(IMG.fx_star, -h / 2, -h / 2, h, h); }
      ctx.fillStyle = '#fff'; ctx.font = 'bold 34px monospace'; ctx.textAlign = 'center'; ctx.fillText('SMACK!', 0, 12);
    }
    ctx.restore();
  }
}
