// arcade.js: Retro arcade interior (mr_india, t_265366e58d3946cf). Level data is in
// arcade-data.js; this module draws the level and runs its gimmicks.
//   arcade.back(ctx, s, camX, W, H)    -> true when it drew the background (dark layer + mid)
//   arcade.step(s, dt)                 -> smashable cabinets, ticket drops, glitch timing
//   arcade.drawWorld(ctx, s, camX, t)  -> machines, cabinets, debris piles, tickets (world space)
//   arcade.post(ctx, s, W, H)          -> overlords' glitch: palette swap + RGB split + scanline jitter
// breakables.js (DOLAN) is tied to props.js levels 0-2, so the cabinets live here.
import { ARCADE_LEVEL_INDEX as LV, ARCADE_TILE_W as TW, ARCADE_BAND as BAND, CABINETS, CABINET, DECOR, GLITCH, ARCADE_GLITCH_KEYS, ARCADE_EXT_SPAWNS } from './arcade-data.js';
import { attackBox, DEPTH } from './combat.js';
import { STAGE_NAMES } from './screens.js';
import { EXT_SPAWNS } from './enemies-ext.js';
import { LEVEL_MUSIC } from './audio.js';
import { loadSegment } from './parallax.js'; // baba_booey: distinct second cabinet-row tile

// Registries other modules own: only fill the arcade slot, and only if empty.
if (!STAGE_NAMES[LV]) STAGE_NAMES[LV] = 'ARCADE';
if (LEVEL_MUSIC && LEVEL_MUSIC[LV] == null) LEVEL_MUSIC[LV] = 'street';
for (const [k, v] of Object.entries(ARCADE_EXT_SPAWNS)) if (!EXT_SPAWNS[k]) EXT_SPAWNS[k] = v;

const ART = 'assets/levels/arcade/';
const FOOT = BAND.y + 10; // cabinets stand on the back edge of the floor

export function ensureArcade(s) {
  if (!s.arcade || s.arcade.wave !== s.wave) {
    s.arcade = { wave: s.wave, cabs: CABINETS.map(x => ({ x, hp: CABINET.hp, broken: false, wob: 0, flash: 0, swing: -1, t: 0 })),
      tickets: [], glitch: null, glitched: {}, swing: 0, lastPhase: null, smashed: 0, collected: 0, log: [] };
  }
  return s.arcade;
}
export const reducedFlash = fx => !!((fx && fx.shakeEnabled === false) ||
  (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));

export function createArcade(opts = {}) {
  const audio = opts.audio || null, fx = opts.fx || null, rand = opts.rand || Math.random;
  const img = {};
  if (typeof Image !== 'undefined') for (const n of ['arcade_mid.jpg', 'ticket_mid.jpg', 'cabinet.png', 'cabinet_smashed.png', 'debris.png', 'tickets.png', 'pinball.png', 'claw.png', 'skeeball.png', 'token.png']) {
    const im = new Image(); im.onload = () => { img[n.split('.')[0]] = im; }; im.src = ART + n;
  }
  // baba_booey (t_fadcdb1655a545f1): tile 1 is its own painting (racing/dance/plush |
  // air hockey/pinball/party room); arcade_mid stays tile 0 and the fallback.
  loadSegment('assets/levels/seg/arcade_1', d => { img.row2 = d; });
  const play = n => { try { if (audio && audio.play) audio.play(n); } catch { /* optional */ } };

  function hitCab(s, a, cab, dmg, dir) {
    cab.hp -= dmg; cab.wob = 0.3 * (dir || 1); cab.flash = 0.1; play('crunch');
    if (s.fxCue) s.fxCue('hit', { x: cab.x, y: FOOT - 60, heavy: dmg > 1, shake: 0.06 });
    if (cab.hp > 0) return;
    cab.broken = true; cab.t = 0; a.smashed++; a.log.push('smash'); play('smash');
    s.score = (s.score || 0) + CABINET.score;
    for (let k = 0; k < CABINET.tickets; k++) a.tickets.push({ x: cab.x + (k - 1) * 14, y: FOOT + 14 + rand() * 20, z: 40, vz: 200 + rand() * 80, vx: (dir || 1) * (30 + rand() * 60) * (k === 1 ? 0.3 : 1), t: 0 });
  }

  function step(s, dt) {
    if ((s.level | 0) !== LV || !s.hpMode) return;
    const a = ensureArcade(s), p = s.player, c = s.combat;
    // Glitch: the overlords' hack hits at scripted beats (once per beat).
    const fired = (s.events && s.events.fired) || {};
    for (const k of ARCADE_GLITCH_KEYS) if (fired[k] && !a.glitched[k]) {
      a.glitched[k] = true; a.glitch = { t: 0, dur: reducedFlash(fx) ? GLITCH.reducedDur : GLITCH.dur, key: k }; a.log.push('glitch'); play('wave');
    }
    if (a.glitch) { a.glitch.t += dt; if (a.glitch.t >= a.glitch.dur) a.glitch = null; }
    // Cabinets take melee (one hit per swing) and thrown pizzas.
    const phase = c && c.attack && !c.attack.hold ? c.phase : null;
    if (phase === 'active' && a.lastPhase !== 'active') a.swing++;
    a.lastPhase = phase;
    if (phase === 'active' && c.attack) {
      const box = attackBox(s, c.attack);
      for (const cab of a.cabs) {
        if (cab.broken || cab.swing === a.swing) continue;
        if (box.x1 < cab.x - CABINET.halfW || box.x0 > cab.x + CABINET.halfW) continue;
        if (Math.abs(p.y - FOOT) > box.depth + 26) continue;
        cab.swing = a.swing; hitCab(s, a, cab, c.attack.heavy || c.attack.around ? 2 : 1, c.attackFacing || 1);
      }
    }
    for (const z of s.pizzas || []) {
      if (z.dead) continue;
      for (const cab of a.cabs) if (!cab.broken && Math.abs(z.x - cab.x) < CABINET.halfW && Math.abs(z.y - FOOT) < DEPTH + 26) { z.dead = true; hitCab(s, a, cab, 1, Math.sign(z.vx || 1) || 1); break; }
    }
    for (const cab of a.cabs) { cab.wob *= Math.max(0, 1 - dt * 9); cab.flash = Math.max(0, cab.flash - dt); cab.t += dt; }
    // Prize tickets: pop out, bounce, collect for score.
    for (const k of a.tickets) {
      k.t += dt; k.vz -= 700 * dt; k.z = Math.max(0, k.z + k.vz * dt); if (k.z === 0) { k.vz = Math.abs(k.vz) > 60 ? -k.vz * 0.4 : 0; k.vx *= 0.8; }
      k.x += k.vx * dt;
      if (!k.got && k.t > 0.35 && k.z < 12 && Math.abs(k.x - p.x) < 30 && Math.abs(k.y - p.y) < 30) {
        k.got = true; a.collected++; s.score = (s.score || 0) + CABINET.ticketScore; play('pickup'); a.log.push('ticket');
        if (fx && fx.pops) fx.pops.push({ x: k.x, y: k.y - 40, text: 'TICKET', t: 0, c: '#ffd27a' });
      }
    }
    a.tickets = a.tickets.filter(k => !k.got && k.t < 14);
  }

  function back(ctx, s, camX, W, H) {
    if ((s.level | 0) !== LV) return false;
    ctx.fillStyle = '#07040d'; ctx.fillRect(0, 0, W, H); // subtle dark layer: an interior has no sky
    for (let i = 0; i < 3; i++) {
      if (i * TW - camX > W || (i + 1) * TW - camX < 0) continue;
      const im = i >= 2 ? img.ticket_mid : (i === 1 && img.row2) || img.arcade_mid;
      if (im) ctx.drawImage(im, i * TW - camX, 0, TW, H);
    }
    // Hacked screens flicker: faint magenta/cyan wash pulses over the back wall.
    const tt = (typeof performance !== 'undefined' ? performance.now() : 0) / 1000;
    ctx.save(); ctx.globalAlpha = 0.05 + 0.04 * Math.max(0, Math.sin(tt * 7.3) * Math.sin(tt * 2.1));
    ctx.fillStyle = Math.sin(tt * 0.9) > 0 ? '#ff2fd0' : '#2ff3ff'; ctx.fillRect(0, 0, W, BAND.y - 40); ctx.restore();
    return true;
  }

  function drawWorld(ctx, s, camX) {
    if ((s.level | 0) !== LV) return;
    const a = s.arcade;
    for (const [k, x] of DECOR) { const im = img[k]; if (im && x > camX - 200 && x < camX + 1000) ctx.drawImage(im, x - im.width / 2, FOOT - im.height); }
    if (!a) return;
    for (const cab of a.cabs) {
      if (cab.x < camX - 200 || cab.x > camX + 1000) continue;
      if (cab.broken) {
        const sm = img.cabinet_smashed, db = img.debris;
        if (sm) ctx.drawImage(sm, cab.x - sm.width / 2, FOOT - sm.height);
        if (db) ctx.drawImage(db, cab.x - db.width * 0.35 + 18, FOOT - db.height * 0.7 + 10, db.width * 0.7, db.height * 0.7);
        if (cab.t < 0.25) { ctx.save(); ctx.globalAlpha = 1 - cab.t / 0.25; ctx.fillStyle = '#bff'; ctx.beginPath(); ctx.arc(cab.x, FOOT - 70, 40 + cab.t * 200, 0, 7); ctx.fill(); ctx.restore(); }
      } else {
        const im = img.cabinet; if (!im) continue;
        ctx.save(); ctx.translate(cab.x, FOOT); ctx.rotate(cab.wob * Math.sin((cab.t || 0) * 40) * 0.15);
        ctx.drawImage(im, -im.width / 2, -im.height);
        if (cab.flash > 0) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5; ctx.drawImage(im, -im.width / 2, -im.height); }
        ctx.restore();
      }
    }
    const tk = img.tickets;
    for (const k of a.tickets) {
      const bob = k.z + Math.sin(k.t * 6) * 2;
      if (tk) ctx.drawImage(tk, k.x - tk.width / 2, k.y - tk.height - bob); else { ctx.fillStyle = '#ffd27a'; ctx.fillRect(k.x - 10, k.y - 20 - bob, 20, 14); }
    }
  }

  // Glitch overlay over the whole canvas (drawImage only; no pixel reads, the canvas is tainted).
  let buf = null;
  function post(ctx, s) {
    const a = s && s.arcade, g = a && a.glitch;
    if (!g || (s.level | 0) !== LV || typeof document === 'undefined') return;
    const cv = ctx.canvas, W = cv.width, H = cv.height;
    if (!buf) buf = document.createElement('canvas');
    if (buf.width !== W || buf.height !== H) { buf.width = W; buf.height = H; }
    const bx = buf.getContext('2d'); bx.setTransform(1, 0, 0, 1, 0, 0); bx.clearRect(0, 0, W, H); bx.drawImage(cv, 0, 0);
    const reduced = reducedFlash(fx), k = Math.sin(Math.PI * Math.min(1, g.t / g.dur)); // ease in and out
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Palette swap: hue rotate + saturation (gentler when reduced flash is on).
    ctx.filter = reduced ? `hue-rotate(${Math.round(GLITCH.hue * 0.6 * k)}deg) saturate(${1 + 0.3 * k})`
      : `hue-rotate(${Math.round(GLITCH.hue * k)}deg) saturate(${1 + 0.8 * k}) contrast(${1 + 0.15 * k})`;
    ctx.drawImage(buf, 0, 0); ctx.filter = 'none';
    if (!reduced) {
      // RGB split: red and cyan ghosts offset sideways, added with low alpha.
      const off = Math.round(3 + 4 * k);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.22 * k;
      ctx.filter = 'sepia(1) saturate(6) hue-rotate(-40deg)'; ctx.drawImage(buf, off, 0);
      ctx.filter = 'sepia(1) saturate(6) hue-rotate(150deg)'; ctx.drawImage(buf, -off, 0);
      ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      // Scanline jitter: a few horizontal slices shifted (changes every ~70 ms).
      const seed = Math.floor(g.t * 14);
      for (let i = 0; i < 6; i++) {
        const r1 = Math.abs(Math.sin(seed * 12.9898 + i * 78.233)) % 1, r2 = Math.abs(Math.sin(seed * 39.3468 + i * 11.135)) % 1;
        const y = Math.floor(r1 * H), h = 4 + Math.floor(r2 * 14), dx = Math.round((r2 - 0.5) * 30 * k);
        ctx.drawImage(buf, 0, y, W, h, dx, y, W, h);
      }
    }
    // Faint scanlines keep it readable as "a screen" without a flash.
    ctx.globalAlpha = 0.12 * k; ctx.fillStyle = '#000';
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    ctx.restore();
  }

  return { step, back, drawWorld, post, images: img, info: s => s.arcade ? { smashed: s.arcade.smashed, collected: s.arcade.collected, tickets: s.arcade.tickets.length, glitch: s.arcade.glitch ? +s.arcade.glitch.t.toFixed(2) : null, log: s.arcade.log.slice(-20) } : null };
}
