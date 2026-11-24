// assist.js — Team-up super meter + Nous gang assist (DOLAN).
// s.super (0-100) fills from landed hits (+4 per enemy hp drop), KOs (+8) and
// damage taken (+6). Full meter + KeyU (or the pad's left-stick click, L3) calls
// a Nous gang hero who is not the player's pick: a 1.2s cut-in banner, then a
// screen-wide strike (4 dmg + knockdown on every on-screen ninja; bosses capped
// at 3 so boss.js keeps its phase/defeat flow). Pad Back stays mute (gamepad.js).
import { damageNinja } from './logic.js';
import { react } from './combat.js';

export const ASSISTS = [
  { id: 'teknium', name: 'TEKNIUM', move: 'DATA STORM!', color: '#38f0ff' },
  { id: 'turbofit', name: 'TURBOFIT', move: 'POWER CHORD!', color: '#ffb02e' },
  { id: 'nous_girl', name: 'NOUS GIRL', move: 'SOUND WAVE!', color: '#ff5ce1' },
];
export const GAIN = { hit: 4, ko: 8, hurt: 6 };
const CUT = 1.2, FLASH = 0.6, L3 = 10;

export function createAssist({ audio } = {}) {
  const img = {};
  const load = (k, src) => { try { const im = new Image(); im.src = src; img[k] = im; } catch (_) {} };
  load('banner', 'assets/assist/banner.png'); load('strike', 'assets/assist/strike.png'); load('coin', 'assets/shop/coin.png');
  for (const a of ASSISTS) load(a.id, 'assets/heroes/portraits/' + a.id + '.png');
  const play = n => { try { audio && audio.play(n); } catch (_) {} };
  const ready = im => im && im.complete && im.naturalWidth;
  let owner = null, seen = new WeakMap(), lastHp = null, lastSpecial = 0, pick = 0, padPrev = false;
  let cut = null, flash = 0, pulse = 0;
  const stats = { fired: 0, hits: 0, last: null };

  function reset(s) { owner = s; s.super = 0; seen = new WeakMap(); lastHp = s.hp; lastSpecial = s.hpHit || 0; cut = null; flash = 0; for (const n of s.ninjas || []) seen.set(n, { hp: n.hp, dead: !!n.dead }); }
  const own = s => { if (owner !== s) reset(s); };
  const gain = (s, v) => { s.super = Math.max(0, Math.min(100, (s.super || 0) + v)); };
  const snapshot = s => { for (const n of s.ninjas) seen.set(n, { hp: n.hp, dead: !!n.dead }); lastHp = s.hp; lastSpecial = s.hpHit || 0; };

  function camX(s) {
    if (typeof window !== 'undefined' && Number.isFinite(window.__ppCamX)) return window.__ppCamX;
    return Number.isFinite(s.cameraX) ? s.cameraX : s.player.x - 333;
  }
  const isBoss = n => !!(n.boss || n.__boss || n.kind === 'boss' || n.levelBoss || n.rider);

  function hero(s) {
    const pool = ASSISTS.filter(a => a.id !== s.selectedHero);
    return pool[(pick++) % pool.length];
  }
  function press(s) {
    own(s);
    if (cut || s.over || (s.super || 0) < 100) return false;
    const a = hero(s);
    cut = { a, t: 0, struck: false };
    s.super = 0; stats.fired++; stats.last = a.id;
    s.invuln = Math.max(s.invuln || 0, CUT + 0.3);
    play('sting');
    return true;
  }
  function strike(s) {
    const x0 = camX(s) - 10, x1 = x0 + 760, px = s.player.x;
    let n0 = 0;
    for (const n of s.ninjas.slice()) {
      if (n.dead || n.x < x0 || n.x > x1) continue;
      const boss = isBoss(n), dir = Math.sign(n.x - px) || 1;
      damageNinja(s, n, boss ? 3 : 4, Math.random);
      if (n.kind !== 'drone' && !n.grabbed) react(s, n, 'knockdown', dir, boss ? 120 : 380 * 1.5);
      n.hitFlash = 0.12; n0++;
    }
    stats.hits += n0;
    s.invuln = Math.max(s.invuln || 0, 1.5);
    if (s.fxCue) s.fxCue('hit', { x: s.player.x, y: s.player.y - 40, heavy: true, shake: 0.4 });
    play('smash');
    flash = FLASH;
    snapshot(s); // the assist's own damage never refills the meter
  }

  function step(s, dt) {
    own(s);
    pulse += dt;
    // Meter gains: enemy hp drops (landed hits) and KOs, player damage taken.
    for (const n of s.ninjas) {
      const p = seen.get(n);
      if (p && !p.dead) { if (n.dead) gain(s, GAIN.ko); else if (n.hp < p.hp) gain(s, GAIN.hit); }
      seen.set(n, { hp: n.hp, dead: !!n.dead });
    }
    const sp = s.hpHit || 0;
    if (lastHp != null && s.hp < lastHp && sp === lastSpecial) gain(s, GAIN.hurt);
    lastHp = s.hp; lastSpecial = sp;
    // Gamepad left-stick click (L3), edge-triggered.
    let pad = false;
    try { const gp = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []; for (const g of gp || []) { const b = g && g.buttons && g.buttons[L3]; if (b && (b.pressed || b.value > 0.5)) pad = true; } } catch (_) {}
    if (pad && !padPrev) press(s);
    padPrev = pad;
    if (cut) { cut.t += dt; if (!cut.struck && cut.t >= CUT) { cut.struck = true; strike(s); } if (cut.t >= CUT + 0.05) cut = null; }
    if (flash > 0) flash = Math.max(0, flash - dt);
  }
  function handleKey(e, s) {
    if (e.code !== 'KeyU' || e.repeat) return false;
    return press(s);
  }

  function meter(ctx, s, W, H) {
    const v = Math.max(0, Math.min(100, s.super || 0)), full = v >= 100;
    const x = 10, y = H - 66, w = 98, h = 30, segs = 10, sw = 7.4, gap = 1.4;
    ctx.save();
    const glow = full ? 0.5 + 0.5 * Math.sin(pulse * 8) : 0;
    ctx.fillStyle = 'rgba(8,14,30,0.78)'; ctx.strokeStyle = full ? `rgba(255,${200 + 55 * glow | 0},90,${0.6 + 0.4 * glow})` : 'rgba(120,200,255,0.35)';
    ctx.lineWidth = full ? 2 : 1;
    if (full) { ctx.shadowBlur = 8 + 10 * glow; ctx.shadowColor = '#ffd84a'; }
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, 7) : ctx.rect(x, y, w, h); ctx.fill(); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = 'bold 8px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = full ? '#ffe86b' : 'rgba(150,220,255,0.8)';
    ctx.fillText('TEAM UP', x + 7, y + 11);
    ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillText(full ? '' : (v | 0) + '%', x + w - 6, y + 11);
    for (let i = 0; i < segs; i++) {
      const sx = x + 7 + i * (sw + gap), fill = Math.max(0, Math.min(1, v / 10 - i));
      ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(sx, y + 16, sw, 8);
      if (fill > 0) { ctx.fillStyle = full ? `hsl(${45 + 10 * Math.sin(pulse * 8 + i)},100%,${60 + 15 * glow}%)` : `hsl(${190 + i * 9},90%,58%)`; ctx.fillRect(sx, y + 16, sw * fill, 8); }
    }
    // Pizza coins (shop.js currency): hud.js has no coin slot, so it rides above the TEAM UP panel.
    { const cy = y - 20; if (ready(img.coin)) ctx.drawImage(img.coin, x + 2, cy - 1, 16, 16); else { ctx.fillStyle = '#ffd84a'; ctx.beginPath(); ctx.arc(x + 10, cy + 7, 7, 0, 7); ctx.fill(); }
      ctx.font = 'bold 12px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#000'; ctx.fillText('x ' + (s.coins || 0), x + 23, cy + 12); ctx.fillStyle = '#ffd84a'; ctx.fillText('x ' + (s.coins || 0), x + 22, cy + 11); }
    if (full) {
      const kx = x + w - 22, ky = y - 26; // above the panel, clear of the boss-bar header
      ctx.shadowBlur = 10 + 8 * glow; ctx.shadowColor = '#ffd84a';
      ctx.fillStyle = '#ffe86b'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(kx, ky, 22, 22, 5) : ctx.rect(kx, ky, 22, 22); ctx.fill();
      ctx.shadowBlur = 0; ctx.fillStyle = '#201400'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center'; ctx.fillText('U', kx + 11, ky + 16);
    }
    ctx.restore();
  }
  function banner(ctx, W, H) {
    const a = cut.a, t = cut.t;
    const inT = Math.min(1, t / 0.18), outT = Math.max(0, (t - (CUT - 0.18)) / 0.18);
    const slide = (1 - inT) * -W + outT * W;
    const y = H * 0.36 - 70;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${0.45 * (1 - outT)})`; ctx.fillRect(0, 0, W, H);
    ctx.translate(slide, 0);
    if (ready(img.banner)) ctx.drawImage(img.banner, 0, y, W, 140);
    else { ctx.fillStyle = 'rgba(70,20,160,0.92)'; ctx.beginPath(); ctx.moveTo(60, y + 8); ctx.lineTo(W, y + 8); ctx.lineTo(W - 60, y + 132); ctx.lineTo(0, y + 132); ctx.fill(); ctx.strokeStyle = '#38f0ff'; ctx.lineWidth = 3; ctx.stroke(); }
    // Portrait in a slanted frame on the left.
    const px = 70, pw = 132;
    ctx.save(); ctx.beginPath(); ctx.moveTo(px + 30, y + 12); ctx.lineTo(px + pw + 30, y + 12); ctx.lineTo(px + pw, y + 128); ctx.lineTo(px, y + 128); ctx.closePath(); ctx.clip();
    if (ready(img[a.id])) ctx.drawImage(img[a.id], px, y - 4, pw + 30, (pw + 30) * 1.25);
    else { ctx.fillStyle = a.color; ctx.fillRect(px, y, pw + 30, 140); }
    ctx.restore();
    ctx.strokeStyle = a.color; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(px + 30, y + 12); ctx.lineTo(px + pw + 30, y + 12); ctx.lineTo(px + pw, y + 128); ctx.lineTo(px, y + 128); ctx.closePath(); ctx.stroke();
    // Name + move.
    const tx = px + pw + 52, shake = t < 0.3 ? (Math.random() - 0.5) * 3 : 0;
    ctx.textAlign = 'left'; ctx.font = 'bold 13px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillText('NOUS GANG ASSIST', tx, y + 42);
    ctx.font = 'italic bold 34px monospace'; ctx.lineWidth = 6; ctx.strokeStyle = '#0a0420'; ctx.lineJoin = 'round';
    const line = a.name + ': ' + a.move;
    ctx.strokeText(line, tx + shake, y + 84); ctx.fillStyle = a.color; ctx.fillText(line, tx + shake, y + 84);
    ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.55; ctx.fillText(line, tx + shake - 1, y + 82); ctx.globalAlpha = 1;
    ctx.restore();
  }
  function draw(ctx, s, W, H) {
    own(s);
    meter(ctx, s, W, H);
    if (flash > 0) {
      const k = flash / FLASH;
      ctx.save();
      ctx.fillStyle = `rgba(220,250,255,${0.55 * k * k})`; ctx.fillRect(0, 0, W, H);
      if (ready(img.strike)) {
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, k * 1.4);
        const sz = 300 + (1 - k) * 420;
        for (let i = 0; i < 3; i++) { const cx = W * (0.2 + 0.3 * i), cy = H * (0.55 + 0.08 * Math.sin(i * 2.1)); ctx.drawImage(img.strike, cx - sz / 2, cy - sz / 2, sz, sz); }
      }
      ctx.restore();
    }
    if (cut && cut.t < CUT) banner(ctx, W, H);
  }
  function drawWorld() { /* screen-space only */ }

  const api = { step, draw, drawWorld, handleKey, press, stats, ASSISTS, get cut() { return cut ? { id: cut.a.id, name: cut.a.name, t: cut.t } : null; }, get flash() { return flash; } };
  if (typeof window !== 'undefined') window.__ppAssist = api;
  return api;
}
