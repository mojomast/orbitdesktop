// subway.js: the Subway train level (cheese, t_fc41e51cbeb94db3). Level data
// (collision band, beats, boss) is in subway-data.js; this module draws the
// moving train and runs its hazards. game.js calls, for every level:
//   subway.back(ctx, s, camX, W, H, dt)  -> true when it drew the background
//   subway.step(s, dt)                   -> train speed, stations, signal hazards
//   subway.drawWorld(ctx, s, camX, t)    -> hazards (world space, behind actors)
//   subway.front(ctx, s, camX, W, H, dt) -> rushing tunnel columns + prompts
// Each returns immediately on any other level.
import { damagePlayer, damageNinja } from './logic.js';
import { BOSSES } from './boss.js';
import { STAGE_NAMES } from './screens.js';
import { LEVEL_MUSIC } from './audio.js';
import { loadSegment } from './parallax.js'; // baba_booey: distinct carriage segments
import { SUBWAY_LEVEL_INDEX as LV, SUBWAY_TILE_W, SUBWAY_BAND, SUBWAY_ROOF, SUBWAY_STATIONS, SUBWAY_TRAIN_SPEED, SUBWAY_BOSS } from './subway-data.js';

// Registries other modules own: only fill the subway slot, and only if empty.
if (!BOSSES[LV]) BOSSES[LV] = SUBWAY_BOSS;
if (!STAGE_NAMES[LV]) STAGE_NAMES[LV] = 'SUBWAY';
if (!LEVEL_MUSIC[LV]) LEVEL_MUSIC[LV] = 'street';

const ART = 'assets/levels/subway/';
const FILES = { tunnel: 'far_tunnel.jpg', station: 'far_station.jpg', carA: 'mid_car_a.png', roof: 'mid_roof.png', carB: 'mid_car_b.png', low: 'signal_low.png', high: 'signal_high.png', pillar: 'fg_pillar.png' };
export const TILES = ['carA', 'roof', 'carB'];
// baba_booey (t_fadcdb1655a545f1): tile 0 = carriage A + the graffiti car, tile 2
// = the gangway/cab-door car end + carriage B (JPG + window-cut mask); the roof
// tile is unchanged. The old car PNGs stay as the fallback while these load.
export const SEG_TILES = { 0: 'assets/levels/seg/subway_0', 2: 'assets/levels/seg/subway_2' };
export const HAZARD = { lowClearZ: 18, hitRange: 22, dmg: 10, every: [2.2, 3.0], warn: 0.9, rel: 0.9 };

export const stationAt = x => SUBWAY_STATIONS.findIndex(st => x >= st.x0 - 160 && x <= st.x1);
export const onRoof = x => x >= SUBWAY_ROOF.x0 + 60 && x <= SUBWAY_ROOF.x1 - 60;

export function createSubway(opts = {}) {
  const img = {};
  if (typeof Image !== 'undefined') for (const [k, f] of Object.entries(FILES)) { const im = new Image(); im.onload = () => { img[k] = im; }; im.src = ART + f; }
  for (const [k, b] of Object.entries(SEG_TILES)) loadSegment(b, d => { img['seg' + k] = d; });
  // Duck = hold Down (keyboard S / ArrowDown, or the pad's stick/d-pad, which
  // gamepad.js turns into the same key events).
  const held = { down: false };
  if (typeof addEventListener === 'function') {
    addEventListener('keydown', e => { if (e.code === 'ArrowDown' || e.code === 'KeyS') held.down = true; });
    addEventListener('keyup', e => { if (e.code === 'ArrowDown' || e.code === 'KeyS') held.down = false; });
    addEventListener('blur', () => { held.down = false; });
  }
  // The duck reads as the rig's existing 'crouch' pose: wrap rig.playerPose
  // instead of editing rig.js.
  const rig = opts.rig;
  if (rig && typeof rig.playerPose === 'function' && !rig.__subwayWrapped) {
    const base = rig.playerPose.bind(rig);
    rig.playerPose = st => (st && st.player && st.player.duck && st.level === LV ? 'crouch' : base(st));
    rig.__subwayWrapped = true;
  }
  const stats = { drew: 0, hazards: 0, hits: 0, cleared: 0 };

  function ensure(s) {
    if (!s.subway || s.subway.wave !== s.wave) s.subway = { wave: s.wave, speed: SUBWAY_TRAIN_SPEED, scroll: 0, hz: [], next: 1.2, run: false, station: -1, stop: 0, t: 0, prompt: null };
    return s.subway;
  }
  function isDucking(s) {
    const c = s.combat;
    return !!(held.down || opts.forceDuck) && !(c && c.airborne) && !((s.player.z || 0) > 2);
  }

  function step(s, dt) {
    if ((s.level | 0) !== LV) { if (s.player) s.player.duck = false; return; }
    const sw = ensure(s), p = s.player;
    sw.t += dt;
    p.duck = isDucking(s);
    // Train speed: brake into a station, stand there, pull out after.
    const st = stationAt(p.x);
    sw.station = st;
    const target = st >= 0 ? 0 : SUBWAY_TRAIN_SPEED;
    if (target) sw.speed = Math.min(target, sw.speed + Math.max(120, (target - sw.speed) * 0.8) * dt); // pull out
    else sw.speed = Math.max(0, sw.speed - Math.max(260, sw.speed * 1.6) * dt);                       // brake to a stop
    sw.stop = sw.speed < 30 ? Math.min(1, sw.stop + dt * 1.5) : Math.max(0, sw.stop - dt * 1.5);
    sw.scroll += sw.speed * dt;
    // Hazard run starts with its beat (events.js log), on the roof, between fights.
    const log = (s.events && s.events.log) || [];
    if (!sw.run && log.some(l => l.level === LV && l.event === 'hazardRun')) sw.run = true;
    const locked = !!(s.events && s.events.lock);
    const cam = Number.isFinite(s.cameraX) ? s.cameraX : p.x - 330;
    if (sw.run && onRoof(p.x) && !locked && sw.speed > 300) {
      sw.next -= dt;
      if (sw.next <= 0) {
        const kind = (stats.hazards + Math.floor(sw.t)) % 3 === 1 ? 'high' : 'low';
        sw.hz.push({ kind, x: cam + 740 + 160, warn: HAZARD.warn, hitPlayer: false, passed: false });
        stats.hazards += 1;
        sw.next = HAZARD.every[0] + Math.random() * (HAZARD.every[1] - HAZARD.every[0]);
      }
    }
    // Move hazards (they are fixed to the tunnel; the train carries us past them).
    for (const h of sw.hz) {
      if (h.warn > 0) { h.warn -= dt; continue; }
      h.x -= sw.speed * HAZARD.rel * dt;
      if (!h.passed && Math.abs(h.x - p.x) < HAZARD.hitRange) {
        const safe = h.kind === 'low' ? (p.z || 0) > HAZARD.lowClearZ : p.duck;
        h.passed = true;
        if (!safe && !(s.invuln > 0)) { damagePlayer(s, HAZARD.dmg, { x: h.x + 40, knockdown: true }); h.hitPlayer = true; stats.hits += 1; }
        else stats.cleared += 1;
      }
      // Signals clip grounded OpenClaw goons on the roof too (not bosses or drones).
      for (const n of s.ninjas) {
        if (n.dead || n.levelBoss || n.kind === 'drone' || n.kind === 'boss' || n.flyover || (n.z || 0) > HAZARD.lowClearZ) continue;
        if (!n.__sigHit && Math.abs(h.x - n.x) < 18 && Math.abs(n.y - p.y) < 400) { n.__sigHit = h; damageNinja(s, n, 1); }
      }
    }
    sw.hz = sw.hz.filter(h => h.x > cam - 200);
    const next = sw.hz.find(h => h.x > p.x && (h.warn > 0 || h.x - p.x < 420));
    sw.prompt = next ? next.kind === 'low' ? 'JUMP!' : 'DUCK!' : null;
  }

  // Screen-space background: tunnel (or station) through the windows, tunnel
  // lights rushing past, then the carriage tiles.
  function back(ctx, s, camX, W, H, dt) {
    if ((s.level | 0) !== LV) return false;
    const sw = ensure(s);
    const far = img.tunnel;
    if (far) {
      const w = far.width * (H / far.height), off = ((camX * 0.2 + sw.scroll) % w + w) % w;
      for (let x = -off; x < W; x += w) ctx.drawImage(far, x, 0, w, H);
    } else { ctx.fillStyle = '#0c0d12'; ctx.fillRect(0, 0, W, H); }
    // Light streaks: lamps whizzing past, longer the faster the train goes.
    const sp = sw.speed / SUBWAY_TRAIN_SPEED;
    if (sp > 0.05) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const per = 520, x = W - (((sw.scroll * 1.6 + i * per * 0.37 + camX * 0.3) % per + per) % per) * (W + 300) / per + 150;
        const y = 120 + (i % 3) * 70, len = 40 + 260 * sp;
        const g = ctx.createLinearGradient(x, 0, x + len, 0);
        g.addColorStop(0, 'rgba(255,214,120,0)'); g.addColorStop(0.7, `rgba(255,214,120,${0.35 * sp})`); g.addColorStop(1, `rgba(255,240,200,${0.6 * sp})`);
        ctx.fillStyle = g; ctx.fillRect(x, y, len, 4 + (i % 2) * 3);
      }
      ctx.restore();
    }
    if (img.station && sw.stop > 0) { ctx.save(); ctx.globalAlpha = sw.stop; ctx.drawImage(img.station, -((camX * 0.25) % 200), 0, img.station.width * (H / img.station.height), H); ctx.restore(); }
    // Carriage tiles (world-anchored), with a little sway while moving.
    const bob = sp > 0.1 ? Math.round(Math.sin(sw.t * 9) * 1.2 * sp) : 0;
    let drew = !!far;
    for (let i = Math.floor(camX / SUBWAY_TILE_W); i * SUBWAY_TILE_W < camX + W; i++) {
      const k = ((i % 3) + 3) % 3, im = img['seg' + k] || img[TILES[k]]; if (!im) continue;
      const w = im.width * (H / im.height);
      ctx.drawImage(im, i * SUBWAY_TILE_W - camX, bob, w, H); drew = true;
    }
    stats.drew += drew ? 1 : 0;
    return true; // never fall through to another level's art
  }

  function drawWorld(ctx, s, camX, t) {
    if ((s.level | 0) !== LV || !s.subway) return;
    for (const h of s.subway.hz) {
      if (h.warn > 0) continue;
      const im = h.kind === 'low' ? img.low : img.high;
      if (h.kind === 'low') {
        const y = SUBWAY_BAND.y + SUBWAY_BAND.h - 6;
        if (im) ctx.drawImage(im, h.x - 32, y - 80, 64, 80); else { ctx.fillStyle = '#26282e'; ctx.fillRect(h.x - 28, y - 70, 56, 70); }
      } else {
        if (im) { const gw = im.width * (260 / im.height); ctx.drawImage(im, h.x - gw / 2, SUBWAY_BAND.y - 240, gw, 260); } else { ctx.fillStyle = '#26282e'; ctx.fillRect(h.x - 60, SUBWAY_BAND.y - 60, 120, 40); }
      }
    }
  }

  function front(ctx, s, camX, W, H, dt) {
    if ((s.level | 0) !== LV || !s.subway) return;
    const sw = s.subway, sp = sw.speed / SUBWAY_TRAIN_SPEED;
    // Tunnel columns flash past in front while riding the roof.
    if (onRoof(camX + W / 2) && sp > 0.2 && img.pillar) {
      ctx.save(); ctx.globalAlpha = 0.55 * sp;
      const per = 900, off = ((sw.scroll * 2.2) % per + per) % per;
      for (let x = W - off; x > -100; x -= per) ctx.drawImage(img.pillar, x, 0, img.pillar.width * (H / img.pillar.height) * (0.6 + 0.4 * sp), H);
      ctx.restore();
    }
    // Incoming-signal warnings at the right edge, and a JUMP!/DUCK! prompt.
    for (const h of sw.hz) if (h.warn > 0 && Math.floor(h.warn * 8) % 2 === 0) {
      ctx.save(); ctx.fillStyle = h.kind === 'low' ? '#ffd23f' : '#ff5c5c'; ctx.font = 'bold 18px monospace'; ctx.textAlign = 'right';
      ctx.fillText(h.kind === 'low' ? '▲ LOW SIGNAL' : '▼ GANTRY', W - 14, h.kind === 'low' ? 360 : 200); ctx.restore();
    }
    if (sw.prompt) {
      const p = s.player, x = p.x - camX, y = p.y - 150;
      ctx.save(); ctx.textAlign = 'center'; ctx.font = 'bold 20px monospace';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(sw.prompt, x, y);
      ctx.fillStyle = sw.prompt === 'JUMP!' ? '#ffd23f' : '#ff7b7b'; ctx.fillText(sw.prompt, x, y); ctx.restore();
    }
    if (sw.station >= 0 && sw.stop > 0.6) {
      const name = SUBWAY_STATIONS[sw.station].name;
      ctx.save(); ctx.globalAlpha = Math.min(1, (sw.stop - 0.6) * 3); ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(10,12,16,0.75)'; ctx.fillRect(W / 2 - 110, 96, 220, 30);
      ctx.fillStyle = '#ffe86b'; ctx.font = 'bold 16px monospace'; ctx.fillText('◆ ' + name + ' ◆', W / 2, 117); ctx.restore();
    }
  }

  return { back, step, drawWorld, front, stats: () => ({ ...stats }), images: img, held };
}
