// Iteration 7 animation layer (MR.INDIA). Wraps Hermes' pose table (rig.js
// POSES, untouched) with timing: eased cross-fades between states (100 ms),
// attack phases driven by the move's own wind/active/recovery timers
// (ease-in anticipation, overshoot follow-through on the strike, ease-out
// recovery), heavier anticipation on big hits, a continuous walk cycle that
// interpolates between walk keyframes, and idle breathing. The result is an
// angle object handed to rig.draw with no key, so rig.js does not ease again.
import { POSES } from './rig.js';

const WALK = ['walk1', 'walk2', 'walk3', 'walk4'];
export const BLEND = 0.1; // seconds for a state-to-state cross-fade
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeIn = t => t * t * t;
const easeOutBack = (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);
const KEYS = ['torso', 'head', 'uarm', 'farm', 'uarm_b', 'farm_b', 'thigh', 'shin', 'thigh_b', 'shin_b', 'weapon', 'tw', 'dx', 'dy'];
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
// Wind-up: settle into the coil over the first 75% and hold it, so the anticipation reads before the strike.
const windEase = t => (t < 0.75 ? easeOutCubic(t / 0.75) : 1);
// Per-hero walk keyframes (`turbofit_walk1`...) cycle like the shared walk1..walk4.
const walkKey = name => { const m = /^(?:(.+)_)?walk([1-4])$/.exec(name || ''); return m ? { pre: m[1] ? m[1] + '_' : '', i: +m[2] - 1 } : null; };
const get = name => POSES[name] || POSES.idle;
function mix(a, b, t, out = {}) { for (const k of KEYS) out[k] = (a[k] || 0) + ((b[k] || 0) - (a[k] || 0)) * t; return out; }
function scale(a, k, base) { const o = {}; for (const key of KEYS) o[key] = (base[key] || 0) + ((a[key] || 0) - (base[key] || 0)) * k; return o; }

export function createAnim() {
  const tracks = new Map();
  // Pose families that need their own timing rather than the generic cross-fade:
  // reactions snap in, a downed body settles, a wake-up pushes up slowly, and a
  // strike overshoots into its follow-through before recovering.
  const REACT = [
    { re: /_down(_b)?$|^down(_b)?$/, dur: 0.12, ease: t => easeOutBack(t, 1.5) },
    { re: /_wake$|^wake$/, dur: 0.3, ease: easeInOut },
    { re: /_knockdownAir$|^knockdownAir$/, dur: 0.07, ease: t => easeOutBack(t, 2.4) },
    { re: /_grabbed$|^grabbed$/, dur: 0.05, ease: easeInOut },
    { re: /_flinch$|^flinch$/, dur: 0.05, ease: t => easeOutBack(t, 1.2) },
    { re: /_stagger$|^stagger$/, dur: 0.09, ease: t => easeOutBack(t, 1.6) },
    { re: /_taunt$|^taunt$/, dur: 0.18, ease: t => easeOutBack(t, 1.25) },
    { re: /_victory$|^victory$/, dur: 0.35, ease: t => easeOutBack(t, 1.15) },
  ];
  const reactTiming = name => REACT.find(r => r.re.test(name));
  const followFor = name => POSES[name.replace(/_(?:active|recover)$/, '_follow')];
  const isDownPose = name => /_down(_b)?$|^down(_b)?$/.test(name);
  // Target angles for a pose name plus an attack-phase hint.
  function target(name, info, t) {
    const wk = walkKey(name);
    if (wk && info && info.walkT != null) {
      // Continuous walk: interpolate between neighbouring keyframes by phase.
      const ph = (info.walkT * (info.walkRate || 8)) % 4, i = Math.floor(ph), f = easeInOut(ph - i);
      return mix(get(wk.pre + WALK[i]), get(wk.pre + WALK[(i + 1) % 4]), f);
    }
    let pose = get(name);
    if (isDownPose(name)) {
      // A body on the floor is not frozen: it settles and breathes out slowly.
      const s = 0.5 - 0.5 * Math.cos(t * 1.6 + (info && info.seed || 0));
      pose = mix(get(String(name).replace(/(_down_b|_down)$/, '_down')), get(String(name).replace(/(_down_b|_down)$/, '_downB')), s);
    }
    if (info && info.phase === 'wind' && info.heavy) pose = scale(pose, 1.18, POSES.idle); // deeper coil on big hits
    // rig QA: the per-hero idle variants (turtle_blue_idleA...) breathe too, not only the bare 'idle'.
    if (name === 'idle' || /_idle[ABC]$/.test(name) || (info && info.breathe)) {
      const b = Math.sin(t * 2.4 + (info && info.seed || 0));
      pose = { ...pose, torso: (pose.torso || 0) + b * 1.5, head: (pose.head || 0) - b * 1.2, uarm: (pose.uarm || 0) + b * 2.5, uarm_b: (pose.uarm_b || 0) + b * 2, weapon: (pose.weapon || 0) + b * 3 }; // rig QA: the weapon breathes with the arm
      // Weight shift: a slow sway from leg to leg under the breath. The loaded knee bends a little more, and the
      // planted-feet solve in rig.js drops the hip on that side, so the stance is alive and not a statue.
      const w = Math.sin(t * 1.15 + (info && info.seed || 0) * 0.7);
      pose.thigh = (pose.thigh || 0) - w * 2.2; pose.shin = (pose.shin || 0) + w * 3.5;
      pose.thigh_b = (pose.thigh_b || 0) - w * 1.6; pose.shin_b = (pose.shin_b || 0) - w * 3;
      pose.torso += w * 1.2; pose.head -= w * 0.8; pose.tw = (pose.tw || 0) + w * 0.12;
    }
    return pose;
  }
  // key: entity key; name: pose name from rig.playerPose/enemyPose; info: phase data
  function step(key, name, info, dt, t) {
    let tr = tracks.get(key);
    const react = reactTiming(name);
    // The first stretch of a recovery plays the move's follow-through pose, then the
    // body eases back to its recover pose, so a strike finishes instead of snapping.
    const follow = (!react && info && info.phase === 'rec' && followFor(name)) || null;
    const goal = follow ? follow : target(name, info, t);
    if (!tr) { tr = { name, from: goal, cur: { ...goal }, k: 1, dur: BLEND, ease: easeInOut, phase: info && info.phase }; tracks.set(key, tr); }
    const phase = info && info.phase;
    const isWalk = !!walkKey(name) && !!walkKey(tr.name);
    if (name !== tr.name || phase !== tr.phase) {
      tr.from = { ...tr.cur }; tr.k = 0;
      if (isWalk && phase === tr.phase) { tr.k = 1; }
      if (react) { tr.dur = react.dur; tr.ease = react.ease; }                                  // reactions snap
      // Phase timing: wind-up eases in over the move's wind time (anticipation),
      // the strike snaps out with overshoot, recovery eases back.
      else if (phase === 'wind') { tr.dur = Math.max(0.05, info.dur || BLEND); tr.ease = windEase; }
      else if (phase === 'active') {
        // Rig QA (mr_india): a big swing (any joint travelling > 120 deg, e.g. a launcher or an overhead
        // smash) gets a little longer and a softer overshoot, so the arm arcs through instead of popping.
        const big = KEYS.reduce((m, k) => Math.max(m, Math.abs((goal[k] || 0) - (tr.from[k] || 0))), 0) > 120;
        tr.dur = Math.max(0.05, Math.min(big ? 0.12 : 0.09, info.dur || 0.08)); const s = info.heavy ? (big ? 1.2 : 2.2) : (big ? 0.7 : 1.4); tr.ease = t => easeOutBack(t, s);
      }
      else if (phase === 'rec') { tr.dur = follow ? Math.max(0.06, (info.dur || 0.2) * 0.45) : Math.max(0.08, info.dur || BLEND); tr.ease = follow ? (x => easeOutBack(x, 1.3)) : easeInOut; tr.recLeft = follow ? Math.max(0.06, (info.dur || 0.2) * 0.55) : 0; }
      else { tr.dur = BLEND; tr.ease = easeInOut; }
      tr.name = name; tr.phase = phase; tr.pt = 0; tr.hist = [];
    } else if (tr.recLeft > 0) {
      // Switch from the follow-through to the recover pose for the tail of recovery.
      tr.recLeft -= dt;
      if (tr.recLeft <= 0) { tr.from = { ...tr.cur }; tr.k = 0; tr.dur = BLEND; tr.ease = easeInOut; }
    }
    tr.k = clamp01(tr.k + dt / tr.dur);
    const finalGoal = tr.recLeft > 0 ? goal : target(name, info, t);
    tr.cur = tr.k >= 1 ? { ...finalGoal } : mix(tr.from, finalGoal, tr.ease(tr.k));
    if (tr.k < 1 && isWalk) tr.cur = finalGoal;
    // Phase clock and smear history: rig.draw ghosts the weapon along the last two frames of the strike.
    tr.pt = (tr.pt || 0) + dt;
    const smear = phase === 'active' || (phase === 'rec' && tr.pt < 0.06);
    if (smear) { tr.hist = [tr.prev, ...(tr.hist || [])].filter(Boolean).slice(0, 2); tr.cur.__trail = tr.hist; } else tr.hist = [];
    tr.prev = { ...tr.cur }; delete tr.prev.__trail;
    tr.cur.__phase = phase; tr.cur.__pt = tr.pt;
    tr.cur.__pose = name; // rig QA: rig.draw reads the pose name (turtle_orange draws its nunchaku on spin frames)
    return tr.cur;
  }
  function forget(key) { tracks.delete(key); }
  // Root offsets: breathing lift in idle (screen px at the drawn scale).
  function breath(t, seed = 0) { return Math.sin(t * 2.4 + seed) * 1.5; }
  return { step, forget, breath, tracks, easeInOut, easeOutBack };
}
