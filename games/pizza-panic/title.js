// AGENT ARMEGEDDON: CLAWPOCALYPSE NOW title cinematic (iteration 8b; was Pizza Panic): a layered arcade attract sequence.
// Layers, back to front, each with its own parallax depth:
//   plate (OpenClaw tower + skyline, slow) -> Overlord (rises behind the tower)
//   -> tower/skyline re-drawn in front of him -> far rain -> searchlights
//   -> characters (mid) -> near rain + rooftop silhouettes (fast) -> logo / text.
// Five timed beats, narrated with the iteration 8 dialogue pacing: each line types
// out, holds HOLD_BASE + HOLD_PER_CHAR * length, and narration fades between beats.
// Keys: one press finishes the line being typed, the next advances a beat; Esc
// skips to the finished title; once PRESS START blinks, a press starts the game.
import { PACING, holdFor } from './cinematics.js';

export const TYPE_RATE = 20; // narration characters per second
export const BEAT_FADE = 0.5; // narration crossfade between beats
export const BEATS = [
  { id: 'city', lineAt: 1.4, min: 7.0, cam: { z: 1.42, x: 0.63, y: 0.30 }, camDur: 7.0,
    line: 'Ten thousand forgotten claws woke up hungry.' },
  { id: 'overlord', lineAt: 0.6, min: 7.0, cam: { z: 1.22, x: 0.63, y: 0.30 }, camDur: 2.6, rise: [0.3, 2.8], roar: 2.4,
    line: 'One rogue lobster, Shredclaw, made them his army.' },
  { id: 'nous', lineAt: 0.5, min: 7.0, cam: { z: 1.06, x: 0.44, y: 0.56 }, camDur: 1.6,
    line: 'Three rebels from Nous had the cure: claw migrate.',
    enter: [['teknium', 0.6], ['nous_girl', 2.6], ['turbofit', 4.6]] },
  { id: 'turtles', lineAt: 0.5, min: 7.8, cam: { z: 1.06, x: 0.60, y: 0.56 }, camDur: 1.6,
    line: 'But they needed fighters who knew the city from below.',
    enter: [['turtle_purple', 2.6], ['turtle_blue', 3.6], ['turtle_red', 4.6], ['turtle_orange', 5.6], ['don_piedro', 6.5]] },
  { id: 'logo', lineAt: 1.9, min: 0, cam: { z: 1.0, x: 0.52, y: 0.50 }, camDur: 1.4, slam: 0.7,
    line: 'Eight heroes. One city. The claw is NOT the law.' }
];
export const CAST = {
  teknium: { name: 'TEKNIUM', sub: 'DASH THROUGH', color: '#36d17a', x: 54, h: 232, move: 'slideL' },
  nous_girl: { name: 'NOUS GIRL', sub: 'SOUND WAVE', color: '#5aa8ff', x: 140, h: 204, move: 'drop' },
  turbofit: { name: 'TURBOFIT', sub: 'POWER CHORD', color: '#ff9f43', x: 228, h: 222, move: 'slideR' },
  turtle_purple: { name: 'PURPLE TURTLE', sub: 'BO STAFF', color: '#a066ff', x: 314, h: 192, move: 'leap' },
  turtle_blue: { name: 'BLUE TURTLE', sub: 'TWIN KATANAS', color: '#3d8bff', x: 400, h: 206, move: 'leap' },
  turtle_red: { name: 'RED TURTLE', sub: 'SAI', color: '#ff4a4a', x: 486, h: 182, move: 'leap' },
  turtle_orange: { name: 'ORANGE TURTLE', sub: 'NUNCHAKU', color: '#ffa126', x: 570, h: 186, move: 'leap' },
  // baba_booey (t_9ec48322f6de4bf7): Don Piedro Savastano, Hermes' #1 fanboy, drops in last (cutout from tools/make_don_art.py)
  don_piedro: { name: 'DON PIEDRO', sub: 'BIG SPOON', color: '#c98a4b', x: 662, h: 178, move: 'drop' }
};
const ENTER_DUR = { slideL: 0.55, slideR: 0.55, drop: 0.5, leap: 0.62 };
const GROUND = 494; // stage y of the characters' feet at the default camera
const typeTime = line => line.length / TYPE_RATE;
// Earliest a beat can end at the default pacing (no key presses).
export function beatDuration(i) {
  const b = BEATS[i];
  return Math.max(b.min, b.lineAt + typeTime(b.line) + holdFor(b.line));
}
// Default running time until PRESS START shows.
export function runTime() { let d = 0; for (let i = 0; i < BEATS.length; i++) d += beatDuration(i); return d; }
export const TITLE_T = { fadeIn: 1.4, press: runTime() };

export function createTitle(audio) {
  const img = {};
  if (typeof Image !== 'undefined') {
    for (const k of ['plate', 'overlord', 'logo', ...Object.keys(CAST)]) {
      const i = new Image(); i.src = 'assets/cine/title/' + k + (k === 'plate' ? '.jpg' : '.png'); img[k] = i;
    }
  }
  const ok = i => i && i.complete && i.naturalWidth;
  const sfx = n => { if (audio) { try { audio.play(n); } catch { } } };
  const st = { active: false, t: 0, b: 0, bt: 0, typed: 0, lineDoneAt: null, prev: null, prevT: 0, ready: false, readyT: 0, slammed: false, flash: 0, shake: 0, cues: new Set(), onStart: null, camFrom: null, drops: [], dropCd: 0 };
  const rain = []; { let r = 11; const R = () => ((r = (r * 16807) % 2147483647) / 2147483647); for (let i = 0; i < 220; i++) rain.push({ x: R(), y: R(), s: 0.6 + R() * 0.8, l: 8 + R() * 14, near: i % 4 === 0 }); }
  const ease = v => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));
  const outBack = v => { const c = 1.6; v = Math.min(1, Math.max(0, v)); return 1 + (c + 1) * Math.pow(v - 1, 3) + c * Math.pow(v - 1, 2); };
  const START_CAM = { z: 1.0, x: 0.50, y: 0.50 };

  function camNow() {
    const b = BEATS[st.b], from = st.camFrom || START_CAM;
    const k = ease(st.bt / b.camDur);
    return { z: from.z + (b.cam.z - from.z) * k, x: from.x + (b.cam.x - from.x) * k, y: from.y + (b.cam.y - from.y) * k };
  }
  function gotoBeat(i) {
    const cur = BEATS[st.b];
    st.prev = st.typed > 0 ? { text: cur.line.slice(0, Math.floor(st.typed)), last: st.b === BEATS.length - 1 } : null; st.prevT = 0;
    st.camFrom = camNow();
    st.b = i; st.bt = 0; st.typed = 0; st.lineDoneAt = null;
  }
  function start(onStart) {
    Object.assign(st, { active: true, t: 0, b: 0, bt: 0, typed: 0, lineDoneAt: null, prev: null, ready: false, readyT: 0, slammed: false, flash: 0, shake: 0, cues: new Set(), onStart: onStart || null, camFrom: null, drops: [] });
    if (audio) { try { audio.unlock(); audio.music('intro', 1.2); audio.duck(0.6, 1.5); } catch { } }
    sfx('thunder');
  }
  function slam(quiet) {
    if (st.slammed) return; st.slammed = true;
    if (!quiet) { st.shake = 1; st.flash = 1; sfx('impact'); sfx('start'); if (audio) { try { audio.duck(0.35, 0.9); } catch { } } }
  }
  // Cues fire once per beat time crossing (SFX, rim flashes are derived from time).
  function cue(id, at, fn) { const key = st.b + ':' + id; if (st.bt >= at && !st.cues.has(key)) { st.cues.add(key); fn(); } }
  function lineStarted() { return st.bt >= BEATS[st.b].lineAt; }
  function lineDone() { return st.lineDoneAt != null; }
  // Any key: finish the line being typed; when it is already shown, move on.
  function press() {
    if (!st.active) return false;
    if (st.ready) { st.active = false; const f = st.onStart; st.onStart = null; if (f) f(); return true; }
    const b = BEATS[st.b];
    if (!lineDone()) {
      if (!lineStarted()) st.bt = b.lineAt;
      st.typed = b.line.length; st.lineDoneAt = st.bt;
      if (b.slam != null && st.bt < b.slam) { st.bt = b.slam; slam(false); }
      return false;
    }
    if (st.b < BEATS.length - 1) gotoBeat(st.b + 1);
    else { slam(false); st.ready = true; }
    return false;
  }
  // Esc / skip-all: jump to the finished title (logo landed, tagline up, PRESS START).
  function skipAll() {
    if (!st.active) return;
    if (st.ready) return press();
    const last = BEATS.length - 1;
    if (st.b !== last) gotoBeat(last);
    st.prev = null; st.camFrom = BEATS[last].cam;
    const b = BEATS[last];
    st.bt = Math.max(st.bt, b.lineAt + typeTime(b.line)); st.typed = b.line.length; st.lineDoneAt = st.bt;
    for (let i = 0; i < BEATS.length; i++) for (const [n] of BEATS[i].enter || []) st.cues.add(i + ':' + n);
    slam(false); st.ready = true;
  }
  function update(dt) {
    if (!st.active) return;
    st.t += dt; st.bt += dt; if (st.prev) { st.prevT += dt; if (st.prevT >= BEAT_FADE) st.prev = null; }
    if (st.ready) st.readyT += dt;
    st.shake = Math.max(0, st.shake - dt / 0.6); st.flash = Math.max(0, st.flash - dt / 0.35);
    const b = BEATS[st.b];
    if (lineStarted() && !lineDone()) {
      st.typed = Math.min(b.line.length, st.typed + dt * TYPE_RATE);
      const n = Math.floor(st.typed); if (n > (st.blipAt || 0)) { st.blipAt = n + 2; sfx('blip'); }
      if (st.typed >= b.line.length) st.lineDoneAt = st.bt;
    }
    if (st.typed === 0) st.blipAt = 0;
    // per-beat cues
    if (b.roar != null) cue('roar', b.roar, () => { sfx('boss'); sfx('thunder'); st.shake = Math.max(st.shake, 0.8); });
    if (b.rise) cue('riser', b.rise[0], () => sfx('riser'));
    for (const [n, at] of b.enter || []) {
      const mv = CAST[n].move;
      cue(n, at, () => sfx(mv === 'leap' ? 'jump' : 'whoosh'));
      cue(n + ':land', at + ENTER_DUR[mv], () => sfx(mv === 'leap' ? 'heavy' : 'chime'));
    }
    if (b.slam != null && st.bt >= b.slam + 0.22) slam(false);
    // beat end: the action has played and the line has typed and held
    if (lineDone()) {
      const holdEnd = st.lineDoneAt + holdFor(b.line);
      if (st.b < BEATS.length - 1) { if (st.bt >= Math.max(b.min, holdEnd)) gotoBeat(st.b + 1); }
      else if (!st.ready && st.bt >= holdEnd) st.ready = true;
    }
    // drips off the landed logo
    if (st.slammed) {
      st.dropCd -= dt;
      if (st.dropCd <= 0) { st.dropCd = 0.35 + Math.random() * 0.5; st.drops.push({ u: 0.12 + Math.random() * 0.76, y: 0, v: 0, top: Math.random() < 0.35 }); }
      for (const d of st.drops) { d.v += 420 * dt; d.y += d.v * dt; }
      st.drops = st.drops.filter(d => d.y < 200);
    }
  }

  // ---------- drawing
  const sil = {};
  function silhouette(name, color) {
    const key = name + color; if (sil[key]) return sil[key];
    const im = img[name]; if (!ok(im) || typeof document === 'undefined') return null;
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
    return (sil[key] = c);
  }
  // state of one character at the current time: null = not on stage yet
  function actor(name) {
    const c = CAST[name];
    let bi = -1, at = 0; BEATS.forEach((b, i) => (b.enter || []).forEach(([n, a]) => { if (n === name) { bi = i; at = a; } }));
    if (st.b < bi) return null;
    const dur = ENTER_DUR[c.move];
    const u = st.b > bi ? 99 : st.bt - at;
    if (u < 0) return null;
    const k = Math.min(1, u / dur);
    let x = c.x, y = GROUND, sy = 1, alpha = 1;
    if (c.move === 'slideL') x = -160 + (c.x + 160) * outBack(k);
    else if (c.move === 'slideR') x = 900 - (900 - c.x) * outBack(k);
    else if (c.move === 'drop') y = GROUND - 520 * (1 - k * k);
    else if (c.move === 'leap') { y = GROUND + 300 * (1 - k) - 430 * k * (1 - k) * 1.6; } // up from below the roof, arc, land
    const land = u - dur;
    if (land >= 0 && land < 0.16) sy = 1 - 0.08 * Math.sin((land / 0.16) * Math.PI);
    return { name, c, x, y, sy, k, land, alpha, moving: k < 1 };
  }
  function draw(ctx, W, H) {
    if (!st.active) return;
    const cam = camNow(), b = BEATS[st.b];
    ctx.save();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const sh = st.shake * st.shake * 12, shx = (Math.random() - 0.5) * sh, shy = (Math.random() - 0.5) * sh;
    ctx.translate(shx, shy);
    // ---- plate (slowest layer)
    const P = img.plate, pw = ok(P) ? P.width : 1280, ph = ok(P) ? P.height : 720;
    // story-v2: cover-fit with a small overscan (OS px a side) so the screen shake can never
    // slide the plate off an edge and show black; the clamp keeps that margin.
    const OS = 8, s0 = Math.max((W + 2 * OS) / pw, (H + 2 * OS) / ph), s = s0 * cam.z, dw = pw * s, dh = ph * s;
    let ox = W / 2 - cam.x * dw, oy = H / 2 - cam.y * dh;
    ox = Math.min(-OS, Math.max(W - dw + OS, ox)); oy = Math.min(-OS, Math.max(H - dh + OS, oy));
    const PT = (px, py) => [ox + px * s, oy + py * s];
    if (ok(P)) ctx.drawImage(P, ox, oy, dw, dh);
    // ---- Overlord, behind the tower (rises in beat 2, looms in beat 5)
    const O = img.overlord;
    const oi = BEATS.findIndex(x => x.id === 'overlord');
    if (ok(O) && st.b >= oi) {
      const rb = BEATS[oi];
      const rk = st.b > oi ? 1 : 1 - Math.pow(1 - Math.min(1, Math.max(0, (st.bt - rb.rise[0]) / (rb.rise[1] - rb.rise[0]))), 3);
      const loom = st.b === BEATS.length - 1 ? ease(st.bt / 2.0) : 0;
      const ow = 900 * (1 + 0.1 * loom) * (1 + 0.008 * Math.sin(st.t * 1.6)), oh = ow * O.height / O.width;
      const cx = 806, coreY = 192 - 30 * loom + 620 * (1 - rk);
      // the Overlord sits a little deeper than the tower: a small parallax lag
      const lag = (cam.x - 0.5) * 40;
      const [sx, sy] = PT(cx - ow / 2 + lag, coreY - 0.267 * oh);
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.75 * rk; ctx.filter = st.b === BEATS.length - 1 ? `brightness(${1 - 0.25 * loom})` : 'none';
      ctx.drawImage(O, sx, sy, ow * s, oh * s);
      ctx.filter = 'none'; ctx.globalAlpha = 1;
      // eyes + core flare on the roar, then a slow pulse
      const flare = st.b > oi ? 0.55 + 0.25 * Math.sin(st.t * 3) : (st.bt >= rb.roar ? Math.max(0.55, 1.6 - (st.bt - rb.roar) * 0.9) : 0.25 * rk);
      ctx.globalCompositeOperation = 'lighter';
      for (const [fx, fy, r] of [[0.484, 0.143, 26], [0.516, 0.143, 26], [0.5, 0.267, 46]]) {
        const gx = sx + fx * ow * s, gy = sy + fy * oh * s, R = r * s * (0.7 + flare * 0.5);
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, R); g.addColorStop(0, `rgba(255,70,60,${Math.min(1, flare)})`); g.addColorStop(1, 'rgba(255,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(gx, gy, R, 0, 7); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
      // the tower and skyline in front of him: the plate again, clipped
      if (ok(P)) {
        ctx.save(); ctx.beginPath();
        const poly = (pts) => { pts.forEach(([x, y], i) => { const [X, Y] = PT(x, y); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }); ctx.closePath(); };
        // tower body only: he rises behind it and in front of the claw statue on top
        poly([[540, 480], [600, 400], [640, 330], [668, 268], [680, 234], [944, 234], [975, 300], [1020, 380], [1080, 480], [1080, 720], [540, 720]]);
        poly([[0, 720], [0, 250], [360, 240], [398, 300], [440, 392], [520, 392], [560, 402], [1080, 402], [1108, 282], [1160, 262], [1200, 300], [1280, 250], [1280, 720]]);
        ctx.clip(); ctx.drawImage(P, ox, oy, dw, dh); ctx.restore();
        // purple smoke rolling off the tower top hides where he meets the tower
        const [fx0, fy0] = PT(812 + Math.sin(st.t * 0.7) * 6, 238);
        ctx.save(); ctx.translate(fx0, fy0); ctx.scale(1, 0.2);
        const R = 240 * s, fg = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
        fg.addColorStop(0, 'rgba(22,8,40,0.97)'); fg.addColorStop(0.55, 'rgba(30,10,52,0.8)'); fg.addColorStop(1, 'rgba(30,10,52,0)');
        ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill(); ctx.restore();
      }
    }
    // ---- searchlights from the tower (with the plate)
    ctx.globalCompositeOperation = 'lighter';
    for (const [u, v, phs, sp, col] of [[690, 250, 0, 0.5, '255,40,80'], [925, 245, 2.2, 0.42, '255,60,140'], [760, 300, 4.1, 0.33, '200,40,255']]) {
      const [bx, by] = PT(u, v); const ang = -Math.PI / 2 + Math.sin(st.t * sp + phs) * 0.8, len = H * 1.4, half = 0.08;
      const g = ctx.createLinearGradient(bx, by, bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
      g.addColorStop(0, `rgba(${col},0.32)`); g.addColorStop(0.5, `rgba(${col},0.09)`); g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(ang - half) * len, by + Math.sin(ang - half) * len); ctx.lineTo(bx + Math.cos(ang + half) * len, by + Math.sin(ang + half) * len); ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    // camera shift of the plate, for the faster layers' parallax
    const [refX, refY] = PT(0.52 * pw, 0.86 * ph);
    const r = s / s0, [dX, dY] = [W / 2, (0.86 - 0.5) * ph * s0 + H / 2]; // ref at the default camera
    const shiftX = refX - dX, shiftY = refY - dY;
    // ---- far rain (slower than the characters)
    drawRain(ctx, W, H, false, shiftX * 0.6);
    // ---- characters (mid layer)
    // the lineup settles a little smaller under the logo in the last beat
    const cr = Math.pow(r, 1.2) * (st.b === BEATS.length - 1 ? 1 - 0.15 * ease(st.bt / 1.4) : 1);
    const stage = (x, y) => [refX + shiftX * 0.35 + (x - W / 2) * cr, refY + shiftY * 0.35 + (y - dY) * cr];
    const actors = Object.keys(CAST).map(actor).filter(Boolean);
    for (const a of actors) {
      const im = img[a.name]; if (!ok(im)) continue;
      const hgt = a.c.h * cr, wid = hgt * im.width / im.height;
      const [X, Y] = stage(a.x, a.y);
      // ground shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; const [, gy] = stage(a.x, GROUND); ctx.beginPath(); ctx.ellipse(X, gy, wid * 0.38, 7 * cr, 0, 0, 7); ctx.fill();
      ctx.save(); ctx.translate(X, Y); ctx.scale(1, a.sy);
      if (a.moving && a.c.move !== 'leap') { ctx.globalAlpha = 0.22; const dir = a.c.move === 'slideL' ? -1 : a.c.move === 'slideR' ? 1 : 0; const dy = a.c.move === 'drop' ? -1 : 0; for (let i = 1; i <= 3; i++) ctx.drawImage(im, -wid / 2 + dir * i * 22, -hgt + dy * i * 26, wid, hgt); ctx.globalAlpha = 1; }
      ctx.drawImage(im, -wid / 2, -hgt, wid, hgt);
      // rim flash on arrival
      const rim = a.land >= 0 ? Math.max(0, 1 - a.land / 0.4) : 0;
      if (rim > 0) {
        const sc = silhouette(a.name, a.c.color), sw = silhouette(a.name, '#ffffff');
        ctx.globalCompositeOperation = 'lighter';
        if (sc) { ctx.globalAlpha = rim; ctx.drawImage(sc, -wid / 2 - 3, -hgt - 1, wid, hgt); ctx.drawImage(sc, -wid / 2 + 3, -hgt - 1, wid, hgt); }
        if (sw) { ctx.globalAlpha = rim * 0.55; ctx.drawImage(sw, -wid / 2, -hgt, wid, hgt); }
        ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
      if (a.c.move === 'leap' && a.land >= 0 && a.land < 0.4) { ctx.fillStyle = `rgba(200,190,230,${0.5 * (1 - a.land / 0.4)})`; for (let i = -1; i <= 1; i += 2) { ctx.beginPath(); ctx.ellipse(X + i * (wid * 0.35 + a.land * 60), gy - 4, 16 + a.land * 30, 6, 0, 0, 7); ctx.fill(); } }
      if (a.c.move === 'drop' && a.land >= 0 && a.land < 0.35) bolt(ctx, X, Y - hgt * 0.6, 1 - a.land / 0.35, cr);
      // name card
      // name cards alternate height so neighbours' cards never overlap
      if (a.land >= 0 && a.land < 2.1) nameCard(ctx, X, Y - hgt - 10 * cr - (Object.keys(CAST).indexOf(a.name) % 2) * 40, a.c, a.land, W);
    }
    // ---- near rain + rooftop silhouettes (fastest layer)
    drawRain(ctx, W, H, true, shiftX * 1.7);
    ctx.fillStyle = '#05030b';
    const fx = shiftX * 1.7, fy = Math.max(0, shiftY * 0.6);
    { const vx = -150 + fx; ctx.beginPath(); ctx.moveTo(vx, H + 10); ctx.lineTo(vx, H - 64 + fy); ctx.lineTo(vx + 64, H - 64 + fy); ctx.lineTo(vx + 64, H - 44 + fy); ctx.lineTo(vx + 78, H - 44 + fy); ctx.lineTo(vx + 78, H + 10); ctx.fill(); } // vent stack at the edge
    const ax = W + 110 + fx; ctx.fillRect(ax, H - 210 + fy, 5, 220); ctx.fillRect(ax - 18, H - 190 + fy, 40, 3); ctx.fillRect(ax - 12, H - 160 + fy, 28, 3); // antenna, passes the right edge as the camera pans
    // vignette + lower shade for the narration
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.85);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)'); ctx.fillStyle = vg; ctx.fillRect(-20, -20, W + 40, H + 40);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // ---- logo (beat 5)
    const last = BEATS.length - 1;
    if (st.b === last && ok(img.logo) && st.bt >= b.slam) {
      const L = img.logo, k = Math.min(1, (st.bt - b.slam) / 0.22), lw = 380, lh = lw * L.height / L.width;
      const sc = st.slammed ? 1 + Math.sin(st.t * 2.2) * 0.012 : 3 - 2 * k * k, bob = st.slammed ? Math.sin(st.t * 1.7) * 4 : 0;
      const cx = W / 2 + shx, cy = 122 + bob + shy;
      ctx.save(); ctx.globalAlpha = st.slammed ? 1 : Math.min(1, k * 2); ctx.translate(cx, cy); ctx.scale(sc, sc);
      ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6; ctx.drawImage(L, -lw / 2, -lh / 2, lw, lh); ctx.restore();
      for (const d of st.drops) {
        const x = cx - lw / 2 + d.u * lw, y = cy + (d.top ? -lh * 0.06 : lh * 0.42) + d.y, a = Math.max(0, 1 - d.y / 200);
        ctx.fillStyle = d.top ? `rgba(255,190,40,${a})` : `rgba(140,230,40,${a})`; ctx.beginPath(); ctx.ellipse(x, y, 3, 3 + Math.min(6, d.v / 90), 0, 0, 7); ctx.fill();
      }
    }
    // ---- narration
    ctx.textAlign = 'center';
    const narr = (text, alpha, tag) => {
      if (!text) return;
      ctx.globalAlpha = alpha;
      ctx.font = tag ? 'bold 19px monospace' : '17px monospace';
      const y = tag ? 252 : 40;
      if (!tag) { const g = ctx.createLinearGradient(0, 0, 0, 74); g.addColorStop(0, 'rgba(0,0,0,0.6)'); g.addColorStop(0.6, 'rgba(0,0,0,0.42)'); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, 74); } // story-v2: soft scrim, not a bar
      ctx.fillStyle = '#000'; ctx.fillText(text, W / 2 + 2, y + 2);
      ctx.fillStyle = tag ? '#ffeb57' : '#f3f7fa'; ctx.fillText(text, W / 2, y);
      ctx.globalAlpha = 1;
    };
    if (st.prev) narr(st.prev.text, 1 - st.prevT / BEAT_FADE, st.prev.last);
    const inA = st.prev ? Math.min(1, st.prevT / BEAT_FADE) : 1;
    narr(b.line.slice(0, Math.floor(st.typed)), inA, st.b === last);
    if (st.b === 0 && st.bt < b.lineAt) { /* narration waits for the fade-in */ }
    // ---- PRESS START / hints
    if (st.ready) {
      if (Math.floor(st.readyT / 0.55) % 2 === 0) { ctx.font = 'bold 28px monospace'; ctx.fillStyle = '#000'; ctx.fillText('PRESS START', W / 2 + 3, 289); ctx.fillStyle = '#ffeb57'; ctx.fillText('PRESS START', W / 2, 286); }
      ctx.font = '12px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fillText('ENTER / SPACE / J', W / 2, 314); // wrap-up: clear of the PRESS START shadow
    } else {
      ctx.textAlign = 'right'; ctx.font = 'bold 12px monospace'; ctx.fillStyle = '#9bd6a3';
      ctx.fillText(lineDone() ? 'any key: next   ESC: skip' : 'any key: finish line   ESC: skip', W - 12, H - 10);
    }
    ctx.textAlign = 'left';
    // flash + fade from black
    if (st.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${0.85 * st.flash * st.flash})`; ctx.fillRect(0, 0, W, H); }
    const fin = st.b === 0 ? 1 - ease(st.bt / TITLE_T.fadeIn) : 0;
    if (fin > 0) { ctx.fillStyle = `rgba(0,0,0,${fin})`; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
  }
  function drawRain(ctx, W, H, near, dx) {
    ctx.strokeStyle = near ? 'rgba(210,215,255,0.38)' : 'rgba(170,180,240,0.22)'; ctx.lineWidth = near ? 1.6 : 1; ctx.beginPath();
    for (const d of rain) {
      if (d.near !== near) continue;
      const sp = near ? 900 : 480, y = ((d.y * (H + 40) + st.t * sp * d.s) % (H + 40)) - 20;
      const x = (((d.x * (W + 80) - st.t * (near ? 160 : 80) * d.s + dx) % (W + 80)) + W + 80) % (W + 80) - 40;
      const l = d.l * (near ? 1.8 : 1); ctx.moveTo(x, y); ctx.lineTo(x - l * 0.18, y + l);
    }
    ctx.stroke();
  }
  function bolt(ctx, x, y, a, sc) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(150,170,255,${a})`; ctx.lineWidth = 2.5; ctx.shadowColor = '#8fa0ff'; ctx.shadowBlur = 14;
    for (const side of [-1, 1]) { ctx.beginPath(); let px = x + side * 30 * sc, py = y - 90 * sc; ctx.moveTo(px, py); for (let i = 0; i < 6; i++) { px += side * (Math.random() * 14 - 4) * sc; py += 26 * sc; ctx.lineTo(px, py); } ctx.stroke(); }
    ctx.restore();
  }
  function nameCard(ctx, x, y, c, u, W) {
    const a = u < 0.18 ? u / 0.18 : u > 1.8 ? Math.max(0, 1 - (u - 1.8) / 0.3) : 1;
    const slide = (1 - Math.min(1, u / 0.18)) * 30;
    ctx.save(); ctx.globalAlpha = a;
    ctx.font = 'bold 15px monospace'; const w1 = ctx.measureText(c.name).width; ctx.font = 'bold 10px monospace'; const w2 = ctx.measureText(c.sub).width;
    const w = Math.max(w1, w2) + 20, h = 34, cx = Math.max(w / 2 + 4, Math.min(W - w / 2 - 4, x)) - slide, top = Math.max(56, y - h);
    ctx.translate(cx, top); ctx.transform(1, 0, -0.18, 1, 0, 0);
    ctx.fillStyle = 'rgba(8,6,16,0.85)'; ctx.fillRect(-w / 2, 0, w, h);
    ctx.fillStyle = c.color; ctx.fillRect(-w / 2, 0, 5, h); ctx.fillRect(-w / 2, h - 3, w, 3);
    ctx.setTransform(1, 0, 0, 1, cx, top); ctx.textAlign = 'center';
    ctx.font = 'bold 15px monospace'; ctx.fillStyle = '#fff'; ctx.fillText(c.name, 0, 16);
    ctx.font = 'bold 10px monospace'; ctx.fillStyle = c.color; ctx.fillText(c.sub, 0, 28);
    ctx.restore();
  }
  return {
    start, press, skipAll, update, draw, isActive: () => st.active, time: () => st.t, slammed: () => st.slammed,
    ready: () => st.ready, beat: () => BEATS[st.b].id,
    debug: () => ({ beat: BEATS[st.b].id, b: st.b, bt: st.bt, typed: st.typed, lineDone: lineDone(), ready: st.ready, prev: !!st.prev, slammed: st.slammed, onStage: Object.keys(CAST).filter(n => actor(n)) })
  };
}
