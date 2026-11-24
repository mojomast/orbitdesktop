// OpenClaw Tower (baba_booey): the final level (level index 4), after the rooftop.
//   tile 0 lobby -> tile 1 server floor -> elevator ride -> tile 2 penthouse
//   throne room, where SHREDCLAW (kind 'boss', the final boss) waits.
// events.js holds the tower's beats (TRIGGERS level 4); enemies-ext.js adds the
// claw ninja / shield brute / flame bot drops. This module only runs the
// elevator ride and draws the tower's atmosphere:
//   - the elevator beat (events key '4:3000') is a wave arena while the car
//     climbs: two more drops land on the roof hatch as the floor counter climbs
//     (the arena lock is held until the last drop is down), then the doors open
//     on the penthouse.
//   - drawBack: shaft girders streaming past while climbing, a red alert pulse
//     on the server floor, the throne-room glow. drawFront: the floor counter.
import { LEVELS, TILE_W } from './collision.js';
import { KIND_R, KIND_HP } from './events.js';
import { makeExtEnemy } from './enemies-ext.js';
import { LEVEL_MUSIC } from './audio.js';

export const TOWER_LEVEL = 4;
export const ELEVATOR_KEY = '4:3000';
export const FLOORS = { from: 41, to: 88 };
// Extra drops during the climb (first one is events.js's elevator wave).
export const ELEVATOR_DROPS = [
  ['clawninja', 'striker', 'brawler'],
  ['shieldbrute', 'acrobat', 'drone', 'flamebot'],
];
// Tower music reuses the rooftop theme until Hermes gives it a track of its own
// (audio.js LEVEL_MUSIC is Hermes's; this only fills an empty slot, so an
// entry added there wins).
if (LEVEL_MUSIC && LEVEL_MUSIC[TOWER_LEVEL] == null) LEVEL_MUSIC[TOWER_LEVEL] = 'rooftop';

export function ensureTower(state) {
  if (!state.tower) state.tower = { elev: null, log: [], t: 0 };
  return state.tower;
}

export function createTower(opts = {}) {
  const audio = opts.audio || null, fx = opts.fx || null, rand = opts.rand || Math.random;
  const play = n => { try { if (audio && audio.play) audio.play(n); } catch { /* optional */ } };
  const shake = k => { if (fx) fx.shake = Math.max(fx.shake || 0, k); };
  const band = () => { const b = LEVELS[TOWER_LEVEL].walkables[0]; return { top: b.y + 8, bot: b.y + b.h - 8 }; };

  function drop(state, E, kinds) {
    const lk = E.lock, b = band();
    kinds.forEach((k, i) => {
      const x = lk.L + 140 + ((i * 157 + E.drops * 90) % (lk.R - lk.L - 280));
      const y = b.top + 8 + rand() * (b.bot - b.top - 16);
      let n;
      if (k === 'clawninja' || k === 'shieldbrute' || k === 'flamebot') {
        n = makeExtEnemy(k, i % 2 ? lk.L + 40 : lk.R - 40, y, TOWER_LEVEL);
      } else {
        const hp = KIND_HP[k] || 1;
        n = { kind: k, level: TOWER_LEVEL, x, y, r: KIND_R[k] || 14, hp, maxHp: hp, vx: -70, vy: 0 };
        if (k === 'drone') { n.hover = 70; n.flying = true; n.x = i % 2 ? lk.L + 30 : lk.R - 30; }
        else { n.z = 170 + rand() * 40; n.launchV = -40; n.spin = 3; } // through the roof hatch
      }
      n.elevator = true;
      state.ninjas.push(n);
    });
    E.drops += 1; lk.t = 0; shake(0.35); play('warn'); play('impact');
    E.hatch = 0.6;
    ensureTower(state).log.push({ ev: 'drop', n: E.drops, kinds: kinds.slice(), t: +E.t.toFixed(2) });
  }

  function step(state, dt) {
    const T = ensureTower(state);
    T.t += dt;
    if ((state.level | 0) !== TOWER_LEVEL || !state.events) { T.elev = null; return; }
    const ev = state.events, lk = ev.lock;
    let E = T.elev;
    if (!E && lk && lk.key === ELEVATOR_KEY) {
      E = T.elev = { t: 0, lock: lk, drops: 0, total: ELEVATOR_DROPS.length, done: false, arrived: 0, hatch: 0, floor: FLOORS.from };
      T.log.push({ ev: 'start', t: +T.t.toFixed(2) }); play('riser'); shake(0.25);
    }
    if (!E) return;
    if (E.hatch > 0) E.hatch = Math.max(0, E.hatch - dt);
    if (E.done) { E.arrived += dt; return; }
    E.t += dt;
    // The car climbs while the fight lasts; the counter only tops out on arrival.
    const goal = FLOORS.from + (FLOORS.to - FLOORS.from - 2) * Math.min(1, (E.drops + Math.min(1, E.t / 30)) / (E.total + 1));
    E.floor = Math.min(FLOORS.to - 1, Math.max(E.floor, E.floor + (goal - E.floor) * Math.min(1, dt * 2)));
    if (Math.floor(E.t * 1.5) !== Math.floor((E.t - dt) * 1.5)) shake(0.06); // the car rattles as it climbs
    const live = state.ninjas.filter(n => !n.dead).length;
    if (E.drops < E.total) {
      if (!ev.lock) {
        // The last of a drop died in one frame and events.js let go: hold the
        // ride (same arena) and send the next drop in.
        ev.lock = E.lock; E.lock.t = 0; ev.go = null;
        if (ev.log.length && ev.log[ev.log.length - 1].type === 'go') ev.log.pop();
        T.log.push({ ev: 'relock', t: +E.t.toFixed(2) });
        drop(state, E, ELEVATOR_DROPS[E.drops]);
      } else if (live <= 1 && E.t > 1.2) drop(state, E, ELEVATOR_DROPS[E.drops]);
    } else if (!ev.lock) {
      E.done = true; E.floor = FLOORS.to; E.arrived = 0;
      if (ev) ev.banner = { text: 'PENTHOUSE — FLOOR ' + FLOORS.to, t: 0, dur: 2.2 };
      play('chime'); shake(0.2);
      T.log.push({ ev: 'arrive', t: +E.t.toFixed(2) });
    }
  }

  // Screen space, behind the world (after parallax/ambient back layers).
  function drawBack(ctx, state, camX, W, H) {
    if ((state.level | 0) !== TOWER_LEVEL) return;
    const T = ensureTower(state), t = T.t, E = T.elev;
    const k = Math.floor((camX + W / 2) / TILE_W);
    ctx.save();
    if (k === 1 && !(E && !E.done)) { // server floor: slow red alert pulse
      ctx.globalAlpha = 0.06 + 0.05 * Math.max(0, Math.sin(t * 2.2));
      ctx.fillStyle = '#ff2a4a'; ctx.fillRect(0, 0, W, 340);
    }
    if (k === 2) { // penthouse: the claw's purple glow breathes over the throne
      const g = ctx.createRadialGradient(W * 0.55, 120, 10, W * 0.55, 120, 320);
      g.addColorStop(0, `rgba(190,110,255,${0.12 + 0.05 * Math.sin(t * 1.3)})`); g.addColorStop(1, 'rgba(190,110,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (E && (!E.done || E.arrived < 1.2)) {
      const fade = E.done ? Math.max(0, 1 - E.arrived / 1.2) : Math.min(1, E.t / 0.8);
      // Shaft: dark glass tint, girders streaming down past the car.
      ctx.globalAlpha = 0.42 * fade; ctx.fillStyle = '#05030c'; ctx.fillRect(0, 0, W, 352);
      const speed = E.done ? 0 : 520, off = (E.t * speed) % 150;
      for (let y = -150 + off; y < 352; y += 150) {
        ctx.globalAlpha = 0.75 * fade; ctx.fillStyle = '#120a1e'; ctx.fillRect(0, y, W, 22);
        ctx.globalAlpha = 0.55 * fade; ctx.fillStyle = '#ff3b6b'; ctx.fillRect(0, y + 22, W, 2);
        ctx.fillStyle = '#3de0ff'; for (let x = 40; x < W; x += 120) ctx.fillRect(x, y + 6, 18, 4);
      }
      // Car frame: cage bars at both ends and a header beam.
      ctx.globalAlpha = 0.9 * fade; ctx.fillStyle = '#1a1226';
      ctx.fillRect(0, 0, 26, 380); ctx.fillRect(W - 26, 0, 26, 380); ctx.fillRect(0, 0, W, 18);
      ctx.fillStyle = '#c9a74a'; ctx.fillRect(26, 18, W - 52, 3); ctx.fillRect(24, 0, 2, 380); ctx.fillRect(W - 26, 0, 2, 380);
      if (E.hatch > 0) { ctx.globalAlpha = E.hatch; ctx.fillStyle = '#fff1c2'; ctx.fillRect(W * 0.3, 0, W * 0.4, 18); }
    }
    ctx.restore();
  }

  // Screen space, over the world, under the HUD: the floor counter.
  function drawFront(ctx, state, W, H) {
    if ((state.level | 0) !== TOWER_LEVEL) return;
    const E = ensureTower(state).elev;
    if (!E || (E.done && E.arrived > 2.5)) return;
    const a = E.done ? Math.max(0, 1 - (E.arrived - 1.5)) : Math.min(1, E.t / 0.5);
    const x = W / 2, y = 176;
    ctx.save(); ctx.globalAlpha = Math.min(1, a);
    ctx.fillStyle = 'rgba(10,6,20,0.85)'; ctx.fillRect(x - 74, y - 22, 148, 34);
    ctx.strokeStyle = '#c9a74a'; ctx.lineWidth = 2; ctx.strokeRect(x - 74, y - 22, 148, 34);
    ctx.fillStyle = E.done ? '#7cff6b' : '#ff4f7a'; ctx.font = 'bold 18px monospace'; ctx.textAlign = 'center';
    const arrow = E.done ? '\u25cf' : (Math.floor(E.t * 3) % 2 ? '\u25b2' : '\u25b3');
    ctx.fillText(`${arrow} FLOOR ${Math.round(E.floor)}`, x, y + 2);
    ctx.restore(); ctx.textAlign = 'left';
  }

  function info(state) {
    const T = ensureTower(state), E = T.elev;
    return { level: state.level, elev: E ? { t: +E.t.toFixed(2), drops: E.drops, total: E.total, done: E.done, floor: Math.round(E.floor) } : null, log: T.log.slice(-20) };
  }
  return { step, drawBack, drawFront, info };
}
