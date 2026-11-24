// harbor.js: Harbor docks at night (mr_india, t_86364aad0b7746c4). Level data is in
// harbor-data.js; this module draws the level and runs its hazards.
//   harbor.back(ctx, s, camX, W, H)     -> true when it drew the background (far + mid)
//   harbor.step(s, dt)                  -> crane crate drops, wet-plank sliding, foghorn
//   harbor.drawWorld(ctx, s, camX, t)   -> dock props, crane shadows and falling crates (world space)
import { HARBOR_LEVEL_INDEX as LV, HARBOR_TILE_W as TW, HARBOR_BAND as BAND, SHIP_X, CRANES, CRANE, WET_ZONES, SLIDE, HARBOR_EXT_SPAWNS } from './harbor-data.js';
import { damagePlayer, isWalkable } from './logic.js';
import { loadSegment } from './parallax.js'; // baba_booey: distinct second pier tile
import { STAGE_NAMES } from './screens.js';
import { EXT_SPAWNS } from './enemies-ext.js';
import { LEVEL_MUSIC } from './audio.js';

// Registries other modules own: only fill the harbor slot, and only if empty.
if (!STAGE_NAMES[LV]) STAGE_NAMES[LV] = 'HARBOR';
if (LEVEL_MUSIC && LEVEL_MUSIC[LV] == null) LEVEL_MUSIC[LV] = 'street';
for (const [k, v] of Object.entries(HARBOR_EXT_SPAWNS)) if (!EXT_SPAWNS[k]) EXT_SPAWNS[k] = v;

export const inWet = x => WET_ZONES.some(z => x >= z.x0 && x <= z.x1);
const SLIDE_MAX = SLIDE.max || 800, SLIDE_JUMP = SLIDE.jump || 8; // px/s cap (dash is 760) and per-frame slack before a move counts as a jump
export const onShip = x => x >= SHIP_X;
const ART = 'assets/levels/harbor/';
// Decorative props behind the walk band (bottom = band top), per pier tile.
const PROPS = [['containers', 180], ['drum', 620], ['bollard', 760], ['rope', 1060], ['crate', 1500], ['lifering', 1700],
  ['containers', 180 + TW], ['fishcrate', 700 + TW], ['bollard', 1000 + TW], ['drum', 1600 + TW], ['crate', 3800], ['crate', 3860], ['drum', 4600], ['rope', 5000]];

export function ensureHarbor(s) {
  if (!s.harbor || s.harbor.wave !== s.wave) s.harbor = { wave: s.wave, drops: [], cd: {}, sv: 0, px: null, horn: 2, log: [] };
  return s.harbor;
}

export function createHarbor(opts = {}) {
  const audio = opts.audio || null, fx = opts.fx || null;
  const img = {};
  if (typeof Image !== 'undefined') for (const n of ['docks_far.jpg', 'docks_mid.png', 'ship_mid.png', 'hook.png', 'crate.png', 'containers.png', 'drum.png', 'bollard.png', 'rope.png', 'lifering.png', 'fishcrate.png']) {
    const im = new Image(); im.onload = () => { img[n.split('.')[0]] = im; }; im.src = ART + n;
  }
  // baba_booey (t_fadcdb1655a545f1): tile 1 is its own painting (fish market | loading
  // bay, cranes repainted at CRANES x); docks_mid stays the fallback and tile 0.
  loadSegment('assets/levels/seg/harbor_1', d => { img.pier2 = d; });
  // ship_mid with its deck holes filled (the quantize had keyed the puddles clear)
  loadSegment('assets/levels/seg/harbor_2', d => { img.ship2 = d; });
  const play = n => { try { if (audio && audio.play) audio.play(n); } catch { /* optional */ } };
  // Procedural foghorn (audio.js is DOLAN's): two detuned low saws, guarded.
  let ac = null;
  function foghorn() {
    try {
      if (audio && audio.muted) return;
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext); if (!AC) return;
      ac = ac || new AC(); if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime, g = ac.createGain(), lp = ac.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 420; g.gain.setValueAtTime(0, t);
      const vol = 0.18 * (audio && audio.volume != null ? audio.volume : 1);
      g.gain.linearRampToValueAtTime(vol, t + 0.35); g.gain.setValueAtTime(vol, t + 1.8); g.gain.linearRampToValueAtTime(0, t + 2.8);
      for (const f of [73, 73.8, 110]) { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(t); o.stop(t + 2.9); }
      lp.connect(g); g.connect(ac.destination);
    } catch { /* no audio */ }
  }

  function step(s, dt) {
    if ((s.level | 0) !== LV || !s.hpMode) return;
    const h = ensureHarbor(s), p = s.player, c = s.combat;
    // Foghorn every ~20 s.
    h.horn -= dt; if (h.horn <= 0) { h.horn = 20; foghorn(); h.log.push('foghorn'); }
    // Cranes: when the hero walks under one, a shadow marks the floor, then a crate drops.
    for (const cx of CRANES) {
      h.cd[cx] = Math.max(0, (h.cd[cx] || 0) - dt);
      if (h.cd[cx] > 0 || Math.abs(p.x - cx) > CRANE.reach || s.over) continue;
      h.cd[cx] = CRANE.cd;
      h.drops.push({ cx, x: p.x, y: p.y, t: 0, hit: false, landed: false });
      h.log.push('telegraph');
      play('warn');
    }
    for (const d of h.drops) {
      d.t += dt;
      if (!d.landed && d.t >= CRANE.telegraph + CRANE.fall) {
        d.landed = true; h.log.push('drop');
        if (fx) fx.shake = Math.max(fx.shake || 0, 0.25);
        play('impact');
        if (Math.abs(p.x - d.x) <= CRANE.radius + p.r && Math.abs(p.y - d.y) <= CRANE.depth + 6 && !((p.z || 0) > 20)) {
          const got = damagePlayer(s, CRANE.dmg, { knockdown: true, x: d.x });
          if (got) { d.hit = true; h.log.push('crateHit'); if (s.fxCue) s.fxCue('hit', { x: p.x, y: p.y - 40, heavy: true, shake: 0.3 }); }
        }
        // Enemies under the crate get flattened too.
        for (const n of s.ninjas) if (!n.dead && !n.boss && Math.abs(n.x - d.x) <= CRANE.radius + n.r && Math.abs(n.y - d.y) <= CRANE.depth + 6) { n.hp -= 2; if (n.hp <= 0) n.dead = true; else { n.down = 0.8; n.react = 'down'; } }
      }
    }
    h.drops = h.drops.filter(d => d.t < CRANE.telegraph + CRANE.fall + 1.2);
    // Wet planks: momentum carries after you let go, dash or get knocked back.
    if (h.px == null) h.px = p.x;
    // t_7dabfde5245b4d9d: a frame jump bigger than any real move (teleport, arena snap, big lunge, scripted pull) is not
    // momentum: drop it and reset the slide. Real moves are clamped to dash speed so nothing can rocket across the docks.
    const dx = p.x - h.px, jump = Math.abs(dx) > SLIDE_JUMP + SLIDE_MAX * dt;
    const v = jump ? 0 : Math.max(-SLIDE_MAX, Math.min(SLIDE_MAX, dx / Math.max(dt, 1e-3)));
    if (jump) { h.sv = 0; h.jumps = (h.jumps || 0) + 1; }
    if (inWet(p.x) && !(c && c.grab)) {
      const pushing = c ? c.moving && !(s.playerDown > 0) : false;
      if (pushing) h.sv = v;
      else if (Math.abs(h.sv) > SLIDE.min) {
        const nx = p.x + h.sv * dt;
        if (isWalkable(LV, nx, p.y, p.r)) p.x = nx; else h.sv = 0;
        h.sv *= Math.exp(-SLIDE.decay * dt);
        h.sliding = true;
      } else { h.sv = v; h.sliding = false; }
    } else { h.sv = v; h.sliding = false; }
    h.sv = Math.max(-SLIDE_MAX, Math.min(SLIDE_MAX, h.sv || 0));
    h.px = p.x;
  }

  function back(ctx, s, camX, W, H) {
    if ((s.level | 0) !== LV) return false;
    const far = img.docks_far;
    if (far) { const off = camX * 0.2; let x0 = -((off % TW) + TW) % TW; for (let x = x0; x < W; x += TW) ctx.drawImage(far, x, 0, TW, H); }
    else { ctx.fillStyle = '#120c2a'; ctx.fillRect(0, 0, W, H); }
    for (let i = Math.floor(camX / TW); i * TW < camX + W; i++) {
      const im = i >= 2 ? img.ship2 || img.ship_mid : (i === 1 && img.pier2) || img.docks_mid;
      if (im) ctx.drawImage(im, i * TW - camX, 0, TW, H);
    }
    return true;
  }

  function drawWorld(ctx, s, camX, t) {
    if ((s.level | 0) !== LV) return;
    for (const [k, x] of PROPS) { const im = img[k]; if (im && x > camX - 300 && x < camX + 1100) ctx.drawImage(im, x - im.width / 2, BAND.y - im.height + 4); }
    // Wet sheen on the slick planks.
    ctx.save(); ctx.globalAlpha = 0.12 + 0.05 * Math.sin((t || 0) * 2);
    ctx.fillStyle = '#9fd8ff';
    for (const z of WET_ZONES) if (z.x1 > camX && z.x0 < camX + 800) ctx.fillRect(z.x0, BAND.y + 4, z.x1 - z.x0, BAND.h - 8);
    ctx.restore();
    const h = s.harbor; if (!h) return;
    for (const d of h.drops) {
      if (d.t < CRANE.telegraph + CRANE.fall) {
        // Shadow telegraph grows as the crate nears.
        const k = Math.min(1, d.t / (CRANE.telegraph + CRANE.fall));
        ctx.save(); ctx.globalAlpha = 0.25 + 0.45 * k; ctx.fillStyle = '#000';
        ctx.beginPath(); ctx.ellipse(d.x, d.y + 14, CRANE.radius * (0.5 + 0.6 * k), 9 * (0.5 + 0.6 * k), 0, 0, 7); ctx.fill();
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(d.t * 18); ctx.strokeStyle = '#ffcf33'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
        if (d.t >= CRANE.telegraph) {
          const f = (d.t - CRANE.telegraph) / CRANE.fall, cy = d.y - 420 + 420 * f * f;
          if (img.crate) ctx.drawImage(img.crate, d.x - 30, cy - 60, 60, 60); else { ctx.fillStyle = '#8a5a2b'; ctx.fillRect(d.x - 30, cy - 60, 60, 60); }
        } else if (img.hook) { const sway = Math.sin(d.t * 6) * 6; ctx.drawImage(img.hook, d.x - img.hook.width / 2 + sway, d.y - 420 - img.hook.height * 0.2); }
      } else if (d.t < CRANE.telegraph + CRANE.fall + 1.2) {
        const a = 1 - (d.t - CRANE.telegraph - CRANE.fall) / 1.2;
        ctx.save(); ctx.globalAlpha = Math.max(0, a); if (img.crate) ctx.drawImage(img.crate, d.x - 30, d.y - 46, 60, 60); ctx.restore();
      }
    }
  }
  return { step, back, drawWorld, images: img, info: s => s.harbor ? { drops: s.harbor.drops.length, log: s.harbor.log.slice(-20), sv: s.harbor.sv, sliding: !!s.harbor.sliding } : null };
}
