// drones.js: OpenClaw hover-drone packs (mr_india, t_ead25b0d4f1a417e).
// A new segmented aerial enemy, kind 'hoverdrone' (distinct from the skate/flyover
// 'drone' rig in enemy-rigs.js). Packs of 3-4 swoop in from off-screen on a staggered
// arc, hover and bob above the lane around the hero, and take turns attacking:
//   dive  - red eye flashes for 0.55 s (lane marked on the floor), then a swoop along it (7 dmg)
//   laser - eye flash + marked lane, then a red bolt down that lane (6 dmg)
// They are `scripted` (combat.enemyAI leaves them alone) and hover at z ~70, so the
// shared combat rules make them hittable only by air attacks and the launcher, by thrown
// pizzas and thrown bodies; ground hits land only at the dive's low point (z < 40).
// 3 HP; they explode into a debris burst. z > 2 keeps them ungrabbable (grab.canGrab).
// Packs ride on existing events.js beats (DRONE_PACKS keys 'level:x'); no events edits.
import { damagePlayer, LEVELS } from './logic.js';

export const HOVERDRONE = { kind: 'hoverdrone', name: 'HOVER DRONE', r: 12, hp: 3, hoverZ: 70, bob: 6, lowZ: 10,
  tele: 0.55, dive: 0.7, recover: 0.6, diveDmg: 7, laserDmg: 6, boltSpeed: 380, turnGap: 0.9, enter: 1.1 };
// Packs layered onto flyover beats: street, rooftop, harbor (mine) and arcade (mine).
export const DRONE_PACKS = { '1:2300': 4, '2:2300': 3, '6:2900': 3, '7:3000': 3 };
const SLOTS = [-170, 170, -250, 250];
const VIEW_W = 740;

export function makeHoverDrone(x, y, level, slot = 0) {
  const T = HOVERDRONE;
  return { kind: T.kind, name: T.name, scripted: true, hoverdrone: true, level, x, y, r: T.r, hp: T.hp, maxHp: T.hp, z: T.hoverZ, vx: 0, vy: 0, face: -1,
    hd: { phase: 'enter', t: 0, slot, sx: x, sy: y, tilt: 0, eye: 0, hp: T.hp, spin: Math.random() * 6, delay: 0 } };
}
export function ensureDrones(s) {
  if (!s.drones || s.drones.wave !== s.wave || s.drones.level !== (s.level | 0)) s.drones = { wave: s.wave, level: s.level | 0, applied: {}, list: [], bolts: [], fx: [], turnCd: 1.2, next: 0, log: [] };
  return s.drones;
}
const bandOf = s => { const lv = LEVELS[s.level | 0] || LEVELS[0]; const b = (lv.walkables || [])[0] || { y: 360, h: 100 }; return { top: b.y + 8, bot: b.y + b.h - 8 }; };
const camLeft = s => { const lk = s.events && s.events.lock; return lk ? lk.L : (s.cameraX || 0); };

export function createDrones(opts = {}) {
  const audio = opts.audio || null, fx = opts.fx || null;
  const T = HOVERDRONE, img = {};
  if (typeof Image !== 'undefined') for (const n of ['body', 'rotor_l', 'rotor_r', 'arm', 'claw', 'laser', 'flame', 'burst', 'missile']) {
    const im = new Image(); im.onload = () => { img[n] = im; }; im.src = 'assets/enemies/hoverdrone/' + n + '.png';
  }
  const play = n => { try { if (audio && audio.play) audio.play(n); } catch { /* optional */ } };

  function spawnPack(s, D, count, key) {
    const L = camLeft(s), fromRight = (Object.keys(D.applied).length % 2) === 0, W = (LEVELS[s.level | 0] || {}).width || 5442;
    const b = bandOf(s);
    for (let i = 0; i < count; i++) {
      const x = Math.max(10, Math.min(W - 10, fromRight ? L + VIEW_W + 60 + i * 50 : L - 60 - i * 50));
      const y = b.top + (b.bot - b.top) * ((i + 0.5) / count);
      const n = makeHoverDrone(x, y, s.level | 0, i); n.hd.delay = i * 0.3; n.face = fromRight ? -1 : 1;
      s.ninjas.push(n); D.list.push(n);
    }
    D.log.push({ ev: 'pack', key, count }); play('whoosh');
  }
  const attacking = D => D.list.some(n => !n.dead && ['tele', 'dive', 'aim'].includes(n.hd.phase));

  function step(s, dt) {
    if (!s.hpMode || s.over) return;
    const D = ensureDrones(s), p = s.player, fired = (s.events && s.events.fired) || {};
    for (const [key, count] of Object.entries(DRONE_PACKS)) if (!D.applied[key] && fired[key] && key.split(':')[0] === String(s.level | 0)) { D.applied[key] = true; spawnPack(s, D, count, key); }
    // Deaths (logic.update drops dead ninjas from the array): explode into the debris burst.
    for (const n of D.list) if (n.dead && !n.hd.boom) { n.hd.boom = true; D.fx.push({ x: n.x, y: n.y - n.z - 20, t: 0, life: 0.6 }); D.log.push({ ev: 'explode' }); play('explode'); if (fx) fx.shake = Math.max(fx.shake || 0, 0.12); }
    D.list = D.list.filter(n => !n.dead);
    D.turnCd -= dt;
    const live = D.list.filter(n => !n.dead);
    if (live.length && !attacking(D) && D.turnCd <= 0) {
      const ready = live.filter(n => n.hd.phase === 'hover');
      if (ready.length) {
        const n = ready[D.next++ % ready.length], h = n.hd;
        h.mode = (D.next % 2) ? 'dive' : 'laser'; h.phase = h.mode === 'dive' ? 'tele' : 'aim'; h.t = 0;
        h.tx = p.x; h.ty = p.y; h.x0 = n.x; h.y0 = n.y; n.face = p.x >= n.x ? 1 : -1;
        D.log.push({ ev: 'telegraph', mode: h.mode, t: +(s.t || 0) }); play('charge');
      }
    }
    for (const n of live) {
      const h = n.hd; h.t += dt; h.spin += dt * 40;
      // Combat hit reactions would launch/drop a hovering body: drones just wobble instead.
      if (n.hp < h.hp) { h.hp = n.hp; h.wob = 0.35; if (h.phase !== 'enter') { h.phase = 'recover'; h.t = 0; } D.log.push({ ev: 'hurt', hp: n.hp }); }
      n.launchV = 0; n.falling = false; n.juggle = false; n.juggles = 0; n.spin = 0; n.spinAngle = 0; n.down = 0; n.wake = 0; n.thrown = false; n.vx = 0; n.vy = 0;
      h.wob = Math.max(0, (h.wob || 0) - dt); h.eye = Math.max(0, h.eye - dt);
      const bob = Math.sin((s.t || h.t) * 4 + h.slot * 1.7) * T.bob;
      if (h.phase === 'enter') {
        const u = Math.max(0, Math.min(1, (h.t - h.delay) / T.enter)), ax = p.x + SLOTS[h.slot % 4], ay = p.y;
        if (h.t < h.delay) continue;
        n.x = h.sx + (ax - h.sx) * u; n.y = h.sy + (ay - h.sy) * u; n.z = T.hoverZ + Math.sin(Math.PI * u) * 70; h.tilt = 0.25 * (1 - u);
        if (u >= 1) { h.phase = 'hover'; h.t = 0; }
      } else if (h.phase === 'hover' || h.phase === 'recover') {
        const ax = p.x + SLOTS[h.slot % 4], ay = p.y, k = Math.min(1, dt * 2.2);
        n.x += (ax - n.x) * k; n.y += (ay - n.y) * k; n.z += (T.hoverZ + bob - n.z) * Math.min(1, dt * 4); h.tilt *= 0.9;
        n.face = p.x >= n.x ? 1 : -1;
        if (h.phase === 'recover' && h.t >= T.recover) { h.phase = 'hover'; h.t = 0; }
      } else if (h.phase === 'tele' || h.phase === 'aim') {
        h.eye = 0.12; n.z = T.hoverZ + bob * 0.3; h.tilt = -0.15;
        if (h.t >= T.tele) {
          if (h.phase === 'tele') { h.phase = 'dive'; h.t = 0; h.x0 = n.x; h.y0 = n.y; h.hit = false; D.log.push({ ev: 'dive' }); play('whoosh'); }
          else { h.phase = 'recover'; h.t = 0; D.bolts.push({ x: n.x + n.face * 20, y: h.ty, z: n.z - 10, vx: n.face * T.boltSpeed, t: 0 }); D.log.push({ ev: 'laser' }); play('throw'); }
        }
      } else if (h.phase === 'dive') {
        const u = Math.min(1, h.t / T.dive), ex = h.tx + n.face * 90;
        n.x = h.x0 + (ex - h.x0) * u; n.y = h.y0 + (h.ty - h.y0) * Math.min(1, u * 1.6);
        n.z = T.lowZ + (T.hoverZ - T.lowZ) * Math.pow(Math.abs(u - 0.5) * 2, 1.6); h.tilt = 0.45 * (1 - Math.abs(u - 0.5) * 2);
        if (!h.hit && u > 0.3 && u < 0.8 && Math.abs(n.x - p.x) < 28 && Math.abs(n.y - p.y) < 16 && !((p.z || 0) > 40)) {
          h.hit = true; const got = damagePlayer(s, T.diveDmg, { x: n.x });
          if (got && s.fxCue) s.fxCue('hit', { x: p.x, y: p.y - 50, heavy: false, shake: 0.15 }); D.log.push({ ev: 'hit', mode: 'dive', dmg: got });
        }
        if (u >= 1) { h.phase = 'recover'; h.t = 0; D.turnCd = T.turnGap; }
      }
      if (h.phase === 'recover' && h.mode === 'laser' && h.t < dt * 1.5) D.turnCd = T.turnGap;
    }
    for (const b of D.bolts) {
      b.t += dt; b.x += b.vx * dt; b.z = Math.max(18, b.z - 140 * dt);
      if (!b.dead && Math.abs(b.x - p.x) < 18 && Math.abs(b.y - p.y) < 14 && !((p.z || 0) > 30)) {
        b.dead = true; const got = damagePlayer(s, T.laserDmg, { x: b.x }); D.log.push({ ev: 'hit', mode: 'laser', dmg: got });
        if (got && s.fxCue) s.fxCue('hit', { x: p.x, y: p.y - 40, heavy: false, shake: 0.1 });
      }
    }
    D.bolts = D.bolts.filter(b => !b.dead && b.t < 2.5);
    for (const f of D.fx) f.t += dt;
    D.fx = D.fx.filter(f => f.t < f.life);
  }

  // One drone, world space: shadow, rotors (spinning by scale flicker), claw arm, tilted body.
  function draw(ctx, n, t = 0) {
    const h = n.hd || {}, x = n.x, y = n.y, z = n.z || 0, by = y - z - 30, f = n.face > 0 ? -1 : 1; // art faces left
    ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(x, y + n.r * 0.6, 18 * (1 - z / 220), 5, 0, 0, 7); ctx.fill(); ctx.restore();
    if (!img.body) { ctx.fillStyle = '#333'; ctx.fillRect(x - 24, by - 14, 48, 28); ctx.fillStyle = h.eye > 0 ? '#ff2a2a' : '#a00'; ctx.fillRect(x - 20 * f, by - 4, 6, 6); return; }
    ctx.save(); ctx.translate(x, by); ctx.scale(f, 1);
    ctx.rotate(-(h.tilt || 0) + Math.sin((h.wob || 0) * 40) * (h.wob || 0) * 0.6);
    if (n.hitFlash > 0) ctx.filter = 'brightness(2.2)';
    // claw arm swings under the body; the pincer opens on the dive
    const sw = Math.sin(t * 3 + (h.slot || 0)) * 0.35 + (h.phase === 'dive' ? -0.7 : 0);
    if (img.arm) { ctx.save(); ctx.translate(2, 8); ctx.rotate(sw); ctx.drawImage(img.arm, -img.arm.width / 2, 0);
      if (img.claw) { ctx.translate(0, img.arm.height - 4); ctx.rotate(-sw * 0.6); const op = h.phase === 'dive' ? 1.15 : 1; ctx.drawImage(img.claw, -img.claw.width / 2 * op, -2, img.claw.width * op, img.claw.height * 0.8); }
      ctx.restore(); }
    // thruster flame behind (art faces left, so behind is +x)
    if (img.flame) { ctx.save(); ctx.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(t * 30 + (h.slot || 0))); ctx.scale(-1, 1); ctx.drawImage(img.flame, -img.body.width / 2 - img.flame.width + 6, -4, img.flame.width * (0.8 + 0.3 * Math.sin(t * 25)), img.flame.height); ctx.restore(); }
    ctx.drawImage(img.body, -img.body.width / 2, -img.body.height / 2);
    // rotors: arm + propeller, propeller blur by horizontal scale flicker
    const flick = 0.35 + 0.65 * Math.abs(Math.sin(h.spin || t * 40));
    for (const [k, ox] of [['rotor_l', -24], ['rotor_r', 6]]) { const im = img[k]; if (!im) continue;
      ctx.save(); ctx.translate(ox + im.width / 2, -img.body.height / 2 + 4); ctx.scale(flick, 1); ctx.drawImage(im, -im.width / 2, -im.height + 6); ctx.restore(); }
    // red eye flash = the telegraph
    if (h.eye > 0) { const a = 0.6 + 0.4 * Math.sin(t * 40); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = `rgba(255,40,40,${a})`; ctx.beginPath(); ctx.arc(-img.body.width / 2 + 9, -1, 7, 0, 7); ctx.fill(); }
    ctx.restore();
  }

  // Over the actors: telegraph lane markers, laser bolts, explosion bursts.
  function drawOver(ctx, s, t = 0) {
    const D = s.drones; if (!D || D.level !== (s.level | 0)) return;
    for (const n of D.list) { const h = n.hd; if (n.dead || !(h.phase === 'tele' || h.phase === 'aim')) continue;
      const k = Math.min(1, h.t / T.tele), x1 = h.phase === 'tele' ? h.tx + n.face * 90 : n.x + n.face * 600;
      ctx.save(); ctx.globalAlpha = 0.35 + 0.4 * k; ctx.strokeStyle = '#ff3030'; ctx.lineWidth = 3; ctx.setLineDash([10, 8]); ctx.lineDashOffset = -t * 60;
      ctx.beginPath(); ctx.moveTo(n.x, h.ty + 10); ctx.lineTo(x1, h.ty + 10); ctx.stroke(); ctx.restore(); }
    for (const b of D.bolts) { const im = img.laser; const sx = b.x, sy = b.y - b.z;
      if (im) { ctx.save(); ctx.translate(sx, sy); ctx.scale(b.vx > 0 ? -1 : 1, 1); ctx.drawImage(im, -im.width / 2, -im.height / 2); ctx.restore(); } else { ctx.fillStyle = '#f33'; ctx.fillRect(sx - 14, sy - 3, 28, 6); } }
    for (const f of D.fx) { const im = img.burst, k = f.t / f.life;
      if (im) { ctx.save(); ctx.globalAlpha = 1 - k * k; const sc = 0.6 + 0.8 * k; ctx.drawImage(im, f.x - im.width * sc / 2, f.y - im.height * sc / 2, im.width * sc, im.height * sc); ctx.restore(); } }
  }

  return { step, draw, drawOver, spawnPack: (s, count = 3) => spawnPack(s, ensureDrones(s), count, 'manual'),
    info: s => s.drones ? { live: s.drones.list.filter(n => !n.dead).map(n => ({ phase: n.hd.phase, hp: n.hp, z: Math.round(n.z) })), bolts: s.drones.bolts.length, fx: s.drones.fx.length, log: s.drones.log.slice(-30) } : null };
}
