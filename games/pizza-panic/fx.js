import { fxPraise } from './style.js'; // mr_india: praise words on the style.js combo milestones
import { createSpecialFX } from './specialfx.js'; const sfx = createSpecialFX(); // mr_india: per-hero special FX sheets (t_fd630e9e9b1c4c85)
import { OPTIONS } from './options-live.js';
// Purely visual effects. Events are derived by diffing game state between
// frames (like audio), so logic.js and gameplay rules are untouched.
export function createFX() {
  const fx = { t: 0, shake: 0, shakeEnabled: true, flash: 0, squash: 0, face: 1, moving: 0, parts: [], pops: [], banner: null, seen: new Map(), prev: null, hold: 0, hop: 0, rings: [], shown: 0, overT: 0, ui: 0 };
  const trails = new WeakMap();
  let IM = {}; fx.setImages = im => { IM = im; };
  const sprite = (ctx, im, x, y, h) => { const w = h * im.width / im.height; ctx.drawImage(im, x - w / 2, y - h / 2, w, h); };
  const drips = Array.from({ length: 14 }, (_, i) => ({ x: 25 + i * 52 + (i * 37) % 20, y: Math.random() * 510, v: 40 + (i * 17) % 50, l: 6 + (i % 4) * 3 }));
  fx.reset = () => { fx.rings = []; fx.shown = 0; fx.overT = 0; fx.hop = 0; fx.parts = []; fx.pops = []; fx.seen.clear(); fx.prev = null; fx.shake = fx.flash = 0; };
  fx.step = (s, dt) => {
    sfx.step(s, dt); // mr_india: special FX sheets (before the hit-pause early return)
    if (fx.hold > 0) { fx.hold -= dt; return; } // visual hit-pause
    fx.t += dt; fx.hop = Math.max(0, fx.hop - dt);
    for (const r of fx.rings) r.t += dt; fx.rings = fx.rings.filter(r => r.t < 0.6);
    const p = s.player, pv = fx.prev;
    if (pv && pv.powerups && s.powerups.length < pv.powerups) fx.pops.push({ x: p.x, y: p.y - 30, text: 'PICKUP', t: 0, c: '#ffe14d' });
    if (pv) {
      const dx = p.x - pv.px, dy = p.y - pv.py;
      if (Math.abs(dx) > 0.01) fx.face = dx > 0 ? 1 : -1;
      fx.moving = Math.abs(dx) + Math.abs(dy) > 0.01 ? 1 : 0;
      if (s.pizzas.length > pv.pz) fx.squash = 0.15;
      if (s.lives < pv.lives) { fx.shake = 0.35 * OPTIONS.shakeScale; fx.flash = 0.4; }
      if (s.wave > pv.wave) {
        const boss = s.ninjas.some(n => n.kind === 'boss');
        fx.hop = 0.6; fx.banner = { text: boss ? 'BOSS INCOMING!' : 'WAVE ' + s.wave, boss, t: 0 };
      }
      const gained = s.score - pv.score;
      if (gained > 0) {
        // place popup at the ninja that died or got damaged this frame
        let at = null;
        for (const [n, m] of fx.seen) if (!s.ninjas.includes(n) && m.x > -10) at = at || m;
        for (const n of s.ninjas) { const m = fx.seen.get(n); if (m && n.hp < m.hp) at = at || n; }
        at = at || { x: p.x + 60, y: p.y };
        fx.pops.push({ x: at.x, y: at.y - 20, text: '+' + gained, t: 0, c: '#ffe14d' });
        if (s.combo > 1) fx.pops.push({ x: at.x, y: at.y - 42, text: 'COMBO x' + s.combo, t: 0, c: '#ff8a1e' });
        // Escalating praise on the style.js milestones (10 RADICAL, 25 TUBULAR, 50 COWABUNGA); the live counter pops on the same hits.
        const praise = fxPraise(pv.combo || 0, s.combo || 0);
        if (praise) { fx.pops.push({ x: at.x, y: at.y - 66, text: praise, t: -0.15, c: s.combo >= 25 ? '#7CFC5A' : '#ffe14d' }); }
      }
    }
    // ninja hits (hp down) and deaths (vanished, not off the left edge)
    for (const n of s.ninjas) {
      const m = fx.seen.get(n);
      if (m && n.hp < m.hp) { m.hit = 0.15; m.kb = 10; fx.parts.push({ x: n.x - n.r * 0.5, y: n.y, vx: 0, vy: 0, r: 0, star: 1, t: 0, life: 0.25 }); }
      if (m) { m.x = n.x; m.y = n.y; m.hp = n.hp; m.hit = Math.max(0, m.hit - dt); m.kb *= 0.8; }
      else fx.seen.set(n, { boss: n.kind === 'boss', x: n.x, y: n.y, hp: n.hp, hit: 0, kb: 0, ph: Math.random() * 6 });
    }
    for (const [n, m] of fx.seen) if (!s.ninjas.includes(n)) {
      if (m.x > -10 && !s.over) {
        fx.hold = 0.04;
        if (m.boss) { fx.shake = Math.max(fx.shake, 0.4 * OPTIONS.shakeScale); fx.rings.push({ x: m.x, y: m.y, t: 0 });
          for (let i = 0; i < 36; i++) { const a = Math.random() * 6.28, v = 120 + Math.random() * 260; fx.parts.push({ x: m.x, y: m.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80, r: 3 + Math.random() * 5, t: 0, life: 0.7 + Math.random() * 0.5, c: ['#ff5252', '#ffb300', '#444', '#fff3a0'][i % 4] }); } }
        fx.parts.push({ x: m.x, y: m.y, vx: 0, vy: 0, r: 6, smoke: 1, t: 0, life: 0.5 });
        for (let i = 0; i < 12; i++) { const a = Math.random() * 6.28, v = 60 + Math.random() * 140; fx.parts.push({ x: m.x, y: m.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: 2 + Math.random() * 2, t: 0, life: 0.4 + Math.random() * 0.3, c: i % 2 ? '#d23b2a' : '#e8b04a' }); }
      }
      fx.seen.delete(n);
    }
    for (const q of fx.parts) { q.t += dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 200 * dt * (q.smoke ? 0 : 1); }
    fx.parts = fx.parts.filter(q => q.t < q.life);
    for (const q of fx.pops) { q.t += dt; q.y -= 40 * dt; }
    fx.pops = fx.pops.filter(q => q.t < 0.9);
    for (const d of drips) { d.y += d.v * dt; if (d.y > 520) d.y = -10; }
    if (fx.banner && (fx.banner.t += dt) > 1.8) fx.banner = null;
    fx.shake = Math.max(0, fx.shake - dt); fx.flash = Math.max(0, fx.flash - dt); fx.squash = Math.max(0, fx.squash - dt);
    fx.prev = { px: p.x, py: p.y, pz: s.pizzas.length, pw: s.powerups.length, lives: s.lives, wave: s.wave, score: s.score, combo: s.combo || 0 };
  };
  fx.begin = ctx => { ctx.save(); if (fx.shake > 0 && fx.shakeEnabled !== false) { const k = fx.shake * 24; ctx.translate((Math.random() - .5) * k, (Math.random() - .5) * k); } };
  fx.bg = (ctx, W) => {
    ctx.fillStyle = 'rgba(120,200,90,0.55)';
    for (const d of drips) ctx.fillRect(d.x, d.y, 2, d.l);
    ctx.fillStyle = 'rgba(160,230,255,0.06)';
    const o = (fx.t * 30) % 80; for (let x = -80 + o; x < W; x += 80) ctx.fillRect(x, 0, 30, 510);
  };
  // draw fn in a local transform around (x, y)
  const at = (ctx, x, y, sx, sy, rot, fn) => { ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sx, sy); ctx.translate(-x, -y); fn(); ctx.restore(); };
  fx.player = (ctx, p, fn) => {
    sfx.mark(ctx); // mr_india: world transform for the special FX sheets
    const hopY = fx.hop > 0 ? -Math.sin((fx.hop / 0.6) * Math.PI) * 26 : 0;
    const bob = hopY + (fx.moving ? Math.abs(Math.sin(fx.t * 14)) * -4 : Math.sin(fx.t * 3) * 1);
    const sq = fx.squash > 0 ? 1 + fx.squash * 2 : 1;
    // Facing is the rig's job (combat.facing); a second mirror here cancelled it.
    at(ctx, p.x, p.y + hopY, sq, 1 / sq, 0, () => { ctx.translate(0, hopY); fn(); });
  };
  fx.pizza = (ctx, z, fn) => {
    let tr = trails.get(z); if (!tr) trails.set(z, tr = []);
    if (!tr.length || tr[tr.length - 1].x !== z.x) { tr.push({ x: z.x, y: z.y }); if (tr.length > 6) tr.shift(); }
    tr.forEach((q, i) => { ctx.fillStyle = `rgba(255,190,80,${(i + 1) / tr.length * 0.35})`; ctx.beginPath(); ctx.arc(q.x, q.y, z.r * (0.4 + i / tr.length * 0.6), 0, 7); ctx.fill(); });
    at(ctx, z.x, z.y, 1, 1, fx.t * 14 + z.x * 0.02, fn); };
  fx.ninja = (ctx, n, fn) => {
    const m = fx.seen.get(n) || { hit: 0, kb: 0, ph: 0 };
    const bob = Math.sin(fx.t * 10 + m.ph) * 3;
    ctx.save(); ctx.translate(m.kb, bob);
    if (m.hit > 0) ctx.filter = 'brightness(4) saturate(0)';
    at(ctx, n.x, n.y, 1, 1, Math.sin(fx.t * 10 + m.ph) * 0.06, fn);
    ctx.restore();
  };
  fx.over = (ctx, W, H) => {
    sfx.draw(ctx); // mr_india: special FX sheets at the hero
    for (const r of fx.rings) { const k = r.t / 0.6; ctx.strokeStyle = `rgba(255,220,120,${1 - k})`; ctx.lineWidth = 8 * (1 - k) + 1; ctx.beginPath(); ctx.arc(r.x, r.y, 20 + k * 160, 0, 7); ctx.stroke(); }
    ctx.lineWidth = 1;
    for (const q of fx.parts) {
      const a = 1 - q.t / q.life;
      if (q.star) { if (IM.fx_star) { ctx.globalAlpha = a; sprite(ctx, IM.fx_star, q.x, q.y, 22 + q.t * 80); ctx.globalAlpha = 1; } continue; }
      if (q.smoke && IM.fx_smoke) { ctx.globalAlpha = a * 0.9; sprite(ctx, IM.fx_smoke, q.x, q.y, 24 + q.t * 90); ctx.globalAlpha = 1; continue; }
      if (q.smoke) { ctx.fillStyle = `rgba(200,200,200,${a * 0.7})`; ctx.beginPath(); ctx.arc(q.x, q.y, q.r + q.t * 60, 0, 7); ctx.fill(); }
      else { ctx.fillStyle = q.c; ctx.globalAlpha = a; ctx.fillRect(q.x, q.y, q.r, q.r); ctx.globalAlpha = 1; }
    }
    ctx.textAlign = 'center'; ctx.font = 'bold 16px monospace';
    for (const q of fx.pops) { ctx.globalAlpha = 1 - q.t / 0.9; ctx.fillStyle = q.c; ctx.fillText(q.text, q.x, q.y); }
    ctx.globalAlpha = 1;
    const b = fx.banner;
    if (b) {
      const k = Math.min(1, b.t / 0.25), out = Math.max(0, (b.t - 1.4) / 0.4);
      ctx.globalAlpha = 1 - out;
      ctx.fillStyle = b.boss ? 'rgba(120,0,0,0.6)' : 'rgba(0,0,0,0.5)'; ctx.fillRect(0, H / 2 - 40, W, 70);
      ctx.save(); ctx.translate(W / 2 + (1 - k) * -W, H / 2); const sc = b.boss ? 1 + Math.sin(b.t * 20) * 0.04 : 1; ctx.scale(sc, sc);
      ctx.font = 'bold 46px monospace'; ctx.fillStyle = b.boss ? '#ff5252' : '#7CFC5A'; ctx.fillText(b.text, 0, 12); ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
  };
  fx.end = (ctx, W, H) => { ctx.restore(); if (fx.flash > 0) { ctx.fillStyle = `rgba(255,0,0,${fx.flash * 0.8})`; ctx.fillRect(0, 0, W, H); } };
  // per-frame UI animation (runs on game over too, not while paused)
  fx.tickUI = (s, dt) => {
    fx.ui += dt;
    fx.shown = s.score < fx.shown ? s.score : Math.min(s.score, fx.shown + Math.max(1, (s.score - fx.shown) * 8 * dt));
    fx.overT = s.over ? fx.overT + dt : 0;
  };
  fx.score = () => Math.floor(fx.shown);
  fx.hearts = (ctx, lives, x, y) => {
    ctx.save(); ctx.textAlign = 'center'; ctx.font = 'bold 18px monospace'; ctx.fillStyle = '#ff4d6d';
    for (let i = 0; i < lives; i++) {
      const sc = lives === 1 ? 1 + Math.max(0, Math.sin(fx.ui * 9)) * 0.45 : 1 + Math.sin(fx.ui * 4 + i) * 0.08;
      ctx.save(); ctx.translate(x + 10 + i * 20, y - 6); ctx.scale(sc, sc); if (IM.ui_heart) sprite(ctx, IM.ui_heart, 0, 0, 16); else ctx.fillText('♥', 0, 6); ctx.restore();
    }
    ctx.restore();
  };
  fx.gameOver = (ctx, W, H) => {
    const t = fx.overT, a = Math.min(1, t / 0.6);
    ctx.fillStyle = `rgba(0,0,0,${a * 0.6})`; ctx.fillRect(0, 0, W, H);
    const d = Math.min(1, t / 0.7), ease = 1 - Math.abs(Math.cos(d * Math.PI * 2.5)) * (1 - d);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ff5252'; ctx.font = 'bold 52px monospace';
    if (IM.logo) { ctx.globalAlpha = a; sprite(ctx, IM.logo, W / 2, 95, 110); ctx.globalAlpha = 1; }
    ctx.fillText('GAME OVER', W / 2, -40 + (H / 2 - 10 + 40) * ease);
    if (t > 0.8) { ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 5); ctx.fillStyle = '#fff'; ctx.font = '18px monospace'; ctx.fillText('press SPACE to restart', W / 2, H / 2 + 30); ctx.globalAlpha = 1; }
    ctx.textAlign = 'left';
  };
  return fx;
}
