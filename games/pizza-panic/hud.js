// hud.js — world-space bars plus a screen-space, world-class readable HUD.
// Public surface kept stable for game.js and worker modules: drawBar,
// createHud -> { player, enemy, boss, drawBar, top, controls, status, track }.
import { LEVELS } from './collision.js';

const THEME = {
  ember: '#ffe86b', jade: '#63f7a0', cyan: '#68e8ff', rose: '#ff6e8f',
  violet: '#a46bff', smoke: '#0b1410', ivory: '#f4f7f2', dim: 'rgba(255,255,255,0.18)',
};
const ENEMY_TINT = { brawler: '#ff6262', striker: '#ffc95c', blocker: '#66d3ff', thrower: '#ff9054', charger: '#a46bff', acrobat: '#ff77da', skater: '#7cff6b', drone: '#9a8cff', elite: '#ff52d7', boss: '#d23be0' };

function roundRectPath(ctx, x, y, w, h, r) {
  const s = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + s, y);
  ctx.arcTo(x + w, y, x + w, y + h, s);
  ctx.arcTo(x + w, y + h, x, y + h, s);
  ctx.arcTo(x, y + h, x, y, s);
  ctx.arcTo(x, y, x + w, y, s);
  ctx.closePath();
}
function panel(ctx, x, y, w, h, options = {}) {
  ctx.save();
  ctx.fillStyle = options.fill || '#06120f';
  roundRectPath(ctx, x, y, w, h, options.radius || 10);
  ctx.fill();
  const gradient = ctx.createLinearGradient(x, y, x, y + h);
  gradient.addColorStop(0, options.glow || 'rgba(255,232,107,0.08)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  roundRectPath(ctx, x, y, w, h, options.radius || 10);
  ctx.fill();
  ctx.lineWidth = options.line || 1.5;
  ctx.strokeStyle = options.stroke || 'rgba(143,240,154,0.55)';
  roundRectPath(ctx, x, y, w, h, options.radius || 10);
  ctx.stroke();
  ctx.restore();
}
function stat(ctx, text, x, y, size = 11, color = THEME.ivory, align = 'left', weight = 'normal') {
  ctx.font = `${weight === 'bold' ? 'bold ' : ''}${size}px monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}
function pct(value, max) {
  return Math.max(0, Math.min(1, max > 0 ? value / max : 0));
}
function easeLerp(current, target, dt, rate = 12) {
  const step = 1 - Math.exp(-rate * Math.max(0.0001, dt));
  return current + (target - current) * step;
}
export function drawBar(ctx, x, y, w, h, o) {
  const frac = pct(o.frac, 1), trail = pct(o.trail == null ? frac : o.trail, 1);
  let t = frac, tl = trail;
  ctx.save();
  roundRectPath(ctx, x - 2, y - 2, w + 4, h + 4, 6);
  ctx.fillStyle = 'rgba(2,7,6,0.65)'; ctx.fill();
  roundRectPath(ctx, x, y, w, h, 4);
  ctx.fillStyle = o.trackColor || '#231212'; ctx.fill();
  // Subtle unit ticks give the bar a cockpit instrument feel.
  if (o.ticks) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 1; i < o.ticks; i++) {
      const px = x + (w * i) / o.ticks;
      ctx.fillRect(px - 0.5, y + 1, 1, h - 2);
    }
  }
  roundRectPath(ctx, x, y, Math.max(0, w * tl), h, 3);
  ctx.fillStyle = o.trailColor || '#ffe9a8'; ctx.globalAlpha = 0.75; ctx.fill();
  ctx.globalAlpha = 1;
  roundRectPath(ctx, x, y, Math.max(0, w * t), h, 3);
  ctx.fillStyle = o.fillLight || 'rgba(255,255,255,0.18)'; ctx.fill();
  let col = o.color || '#56e06a';
  if (o.flash) col = o.flash > 0.5 ? '#ff3b3b' : (o.lowColor || '#ff8a3b');
  roundRectPath(ctx, x, y, Math.max(0, w * t), h, 3);
  ctx.fillStyle = col; ctx.fill();
  if (o.glow && w * t > 4) {
    const G = ctx.createLinearGradient(x, y, x, y + h);
    G.addColorStop(0, o.glow); G.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = G; roundRectPath(ctx, x, y, Math.max(0, w * t), h, 3); ctx.fill();
  }
  ctx.restore();
  return { frac: t, trail: tl };
}

import { HEROES } from './heroes.js';
export function createHud() {
  const tracks = new WeakMap();
  // Wrap-up fix: the hero card shows the hero's real portrait (assets/heroes/portraits/<id>.png),
  // the three-letter initials stay only as a fallback while the image loads.
  const portraits = {};
  if (typeof Image !== 'undefined') for (const h of HEROES) { try { const im = new Image(); im.src = 'assets/heroes/portraits/' + h.id + '.png'; portraits[h.id] = im; } catch (_) { } }
  const imgOk = im => !!(im && im.complete && im.naturalWidth);
  const numeric = { score: 0, combo: 0, boss: 0, low: 0 };
  function track(key, value, max, dt) {
    let t = tracks.get(key);
    if (!t) { t = { shown: value, trail: value, hold: 0, last: value, low: 0, lastValue: value, score: 0 }; tracks.set(key, t); }
    if (value !== t.last || Math.abs(value - t.last) > 0.000001) {
      t.hold = 0.45; t.flash = 0.3;
    }
    if (value > t.trail) t.trail = value;
    t.last = value;
    t.shown = easeLerp(t.shown, value, dt, 14);
    if (t.hold > 0) { t.hold = Math.max(0, t.hold - dt); }
    else t.trail = Math.max(value, t.trail - max * 0.9 * dt);
    if (t.shown > value && Math.abs(t.shown - value) < 0.05) t.shown = value;
    if (t.trail < t.shown) t.trail = t.shown;
    return { frac: pct(t.shown, max), trail: pct(t.trail, max), shown: t.shown, trailRaw: t.trail };
  }
  function levelName(level, skate) {
    if (skate) return 'SKATE RUN';
    const id = LEVELS[level]?.id || LEVELS[0].id;
    return { sewer: 'SEWER', street: 'STREET', rooftop: 'ROOFTOP' }[id] || id.toUpperCase();
  }
  function heroName(id) {
    return id ? id.replace(/^turtle_/, '').replace(/_/g, ' ').toUpperCase() : 'HERO';
  }
  function drawMeter(ctx, x, y, w, h, tr, options) {
    drawBar(ctx, x, y, w, h, tr instanceof Object && 'shown' in tr ? { ...tr, frac: tr.frac, trail: tr.trail, ...options } : { ...tr, ...options });
  }
  function drawTimers(ctx, x, y, s) {
    const bars = [];
    if (s.rapidTimer > 0) bars.push({ label: 'RAPID', value: s.rapidTimer, max: Math.max(s.rapidTimer, 10 + s.wave + 1), color: '#38c9ff' });
    if (s.spreadTimer > 0) bars.push({ label: 'SPREAD', value: s.spreadTimer, max: Math.max(s.spreadTimer, 15 + s.wave + 1), color: '#ff8f32' });
    bars.forEach((bar, index) => {
      const bx = x, by = y + index * 13, bw = 78, bh = 6;
      ctx.save();
      roundRectPath(ctx, bx, by, bw, bh, 3);
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
      roundRectPath(ctx, bx, by, bw * pct(bar.value, bar.max), bh, 3);
      ctx.fillStyle = bar.color; ctx.fill();
      stat(ctx, `${bar.label} ${Math.ceil(bar.value)}`, bx + 2, by - 5, 7, bar.color, 'left', 'bold');
      ctx.restore();
    });
  }
  function drawWeapon(ctx, x, y, level) {
    for (let i = 0; i < 5; i++) {
      const ix = x + i * 13, filled = i < level;
      roundRectPath(ctx, ix, y, 9, 20, 3);
      ctx.fillStyle = filled ? 'rgba(255,232,107,0.95)' : 'rgba(255,255,255,0.12)'; ctx.fill();
      ctx.fillStyle = filled ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.04)';
      roundRectPath(ctx, ix, y, 9, 8, 3); ctx.fill();
      if (filled) { ctx.fillStyle = 'rgba(255,140,0,0.75)'; ctx.fillRect(ix + 3, y + 13, 3, 3); }
    }
  }
  function player(ctx, s, dt, x = 12, y = 34, opts = {}) {
    const max = Math.max(1, s.maxHp || 100), hp = Math.max(0, s.hp == null ? max : s.hp);
    const tr = track(s, hp, max, dt);
    const low = hp / max <= 0.3 && !s.over;
    const combo = s.combo || 0;
    const cardX = x - 10, cardY = y - 22, cardW = 318, cardH = opts.score ? 134 : 116;
    // Low health makes the whole card breathe and tint, without hiding the bars.
    const pulse = low ? (Math.sin((numeric.low += dt * 9) * 1.2) * 0.5 + 0.5) : 0;
    if (low) { ctx.save(); ctx.globalAlpha = 0.13 + pulse * 0.22; ctx.fillStyle = '#ff3344'; roundRectPath(ctx, cardX, cardY, cardW, cardH, 12); ctx.fill(); ctx.restore(); }
    panel(ctx, cardX, cardY, cardW, cardH, { fill: low ? 'rgba(45,10,14,0.78)' : 'rgba(8,24,18,0.80)', stroke: low ? 'rgba(255,90,90,0.75)' : 'rgba(130,250,150,0.45)', radius: 12, glow: low ? 'rgba(255,80,80,0.12)' : 'rgba(150,240,255,0.08)' });

    // Left status rail: hero portrait initial + shield.
    ctx.save();
    const shieldActive = !!s.player?.shield;
    const railX = cardX + 12;
    roundRectPath(ctx, railX, cardY + 16, 34, 48, 8);
    ctx.fillStyle = shieldActive ? 'rgba(120,140,255,0.28)' : 'rgba(255,255,255,0.07)'; ctx.fill();
    roundRectPath(ctx, railX, cardY + 16, 34, 48, 8);
    ctx.strokeStyle = shieldActive ? '#9db2ff' : 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.5; ctx.stroke();
    // Reaction bust, cropped straight out of BABA BOOEY's atlas. Hurt shows
    // while damage is landing, win shows on a completed run; otherwise the
    // defender stays on the normal portrait and the rail text remains in place.
    const react = (typeof window !== 'undefined' && window.__ppReactionAtlas) || null;
    let mood = null;
    if (s && s.reaction === 'hurt' || (s && (s.hurtT || 0) > 0) || (s && (s.playerDown || 0) > 0)) mood = 0;
    else if (s && (s.reaction === 'win' || s.runComplete)) mood = 1;
    const face = portraits[s.selectedHero];
    let drewFace = false;
    if (imgOk(face) && !(react && react.complete && react.naturalWidth && mood != null)) {
      ctx.save();
      roundRectPath(ctx, railX, cardY + 16, 34, 48, 8);
      ctx.clip();
      ctx.drawImage(face, 0, 0, 240, 300, railX - 2, cardY + 15, 38, 48);
      ctx.restore();
      drewFace = true;
    }
    if (react && react.complete && react.naturalWidth && mood != null) {
      drewFace = true;
      const row = Math.max(0, HEROES.findIndex(h => h.id === s.selectedHero));
      ctx.save();
      roundRectPath(ctx, railX - 2, cardY + 16, 38, 48, 8);
      ctx.clip();
      ctx.drawImage(react, mood * 240, row * 300, 240, 300, railX - 10, cardY + 14, 54, 52);
      ctx.restore();
    }
    if (!drewFace) stat(ctx, heroName(s.selectedHero).slice(0, 3), railX + 17, cardY + 38, 12, shieldActive ? '#cfe0ff' : THEME.ember, 'center', 'bold');
    roundRectPath(ctx, railX, cardY + 16, 34, 48, 8);
    ctx.strokeStyle = shieldActive ? '#9db2ff' : 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1.5; ctx.stroke();

    if (shieldActive) {
      ctx.save(); ctx.globalAlpha = 0.55 + pulse * 0.35;
      roundRectPath(ctx, railX - 2, cardY + 14, 38, 52, 9);
      ctx.lineWidth = 2; ctx.strokeStyle = '#96a8ff'; ctx.stroke();
      ctx.restore();
      stat(ctx, 'SHIELD', railX + 17, cardY + 74, 8, '#96a8ff', 'center', 'bold');
    }
    ctx.restore();

    // Hero label and weapon tier.
    ctx.save();
    stat(ctx, opts.tag ? opts.tag + ' HERO' : 'HERO', cardX + 58, cardY + 12, 8, opts.tag === '2P' ? 'rgba(61,240,255,0.85)' : 'rgba(130,240,150,0.65)', 'left', 'bold');
    stat(ctx, heroName(s.selectedHero), cardX + 58, cardY + 25, 12, shieldActive ? '#D8E5FF' : THEME.ember, 'left', 'bold');
    stat(ctx, 'WEAPON', cardX + 202, cardY + 14, 8, 'rgba(130,240,150,0.65)', 'left', 'bold');
    drawWeapon(ctx, cardX + 204, cardY + 26, Math.max(0, s.weaponLevel || 0));
    if (s.weaponDurability > 0) stat(ctx, `${s.weaponDurability}`, cardX + 248, cardY + 25, 9, 'rgba(255,232,107,0.75)', 'left', 'bold');
    drawTimers(ctx, cardX + 58, cardY + 38, s);
    ctx.restore();

    // HP bar: segmented, eased, readable even at a glance.
    const hpX = cardX + 58, hpY = cardY + 70, hpW = 180, hpH = 14;
    drawBar(ctx, hpX, hpY, hpW, hpH, { frac: tr.frac, trail: tr.trail, color: low ? '#ff3b3b' : '#63f7a0', trailColor: low ? '#ffd8d8' : '#ffe9a8', ticks: Math.min(20, Math.max(max, 10)), glow: low ? 'rgba(255,70,70,0.35)' : 'rgba(160,240,140,0.35)' });
    stat(ctx, 'HP', hpX - 8, hpY + hpH / 2, 11, THEME.ivory, 'right', 'bold');
    stat(ctx, `${Math.ceil(hp)} / ${max}`, hpX + hpW + 7, hpY + hpH / 2, 10, THEME.ivory, 'left', 'bold');

    // Lives and combo.
    ctx.save();
    let lx = cardX + 246, ly = cardY + 62;
    stat(ctx, 'x' + Math.max(0, s.lives ?? 0), lx, ly, 16, '#ff4d6d', 'left', 'bold');
    // Four mini-facets make the life count look like a real stock of resources.
    ctx.globalAlpha = 0.75;
    for (let i = 0; i < Math.max(0, s.lives ?? 0); i++) {
      roundRectPath(ctx, lx + 22 + i * 12, ly - 9, 9, 12, 3); ctx.fillStyle = '#ff4d6d'; ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(lx + 22 + i * 12, ly - 9, 9, 3);
    }
    ctx.globalAlpha = 1;
    // The full combo/style counter now lives in style.js, so the hero card no
    // longer carries a duplicate COMBO label here (see t_5556cdb23396497b).
    ctx.restore();
    // Combo expiry is already timed and displayed in pixels, so players can see
    // how long a chain will last before deciding between greed and safety.
    if (combo > 1 && s.comboTimer > 0) {
      const mx = cardX + 58, my = cardY + 104;
      roundRectPath(ctx, mx, my, hpW, 5, 2); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
      let when = Math.min(s.comboTimer / 2.5, 1);
      roundRectPath(ctx, mx, my, hpW * when, 5, 2); ctx.fillStyle = '#ffe86b'; ctx.fill();
      stat(ctx, `${s.comboTimer.toFixed(1)}s`, mx + hpW + 7, my + 3, 8, 'rgba(255,232,107,0.75)', 'left');
    }
    // 2-player layout: each player's score lives inside their own card.
    if (opts.score) {
      const sc = Math.floor(s.score || 0).toString().padStart(6, '0');
      stat(ctx, 'SCORE', cardX + 12, cardY + 122, 9, 'rgba(255,232,107,0.75)', 'left', 'bold');
      stat(ctx, sc, cardX + 58, cardY + 122, 15, THEME.ember, 'left', 'bold');
      if (combo > 1) stat(ctx, `COMBO x${combo}`, cardX + cardW - 12, cardY + 122, 9, combo >= 5 ? '#ff6e8f' : '#ffe86b', 'right', 'bold');
    }
    // A barely-there red edge communicates danger immediately to the peripheral eye.
    if (low) {
      ctx.save(); ctx.globalAlpha = 0.18 + pulse * 0.5;
      ctx.strokeStyle = '#ff3344'; ctx.lineWidth = 2;
      ctx.shadowBlur = 20; ctx.shadowColor = '#ff3344';
      roundRectPath(ctx, cardX, cardY, cardW, cardH, 12); ctx.stroke();
      ctx.restore();
    }
    numeric.low = low ? numeric.low + dt * 5 : 0;
    ctx.restore();
    return { low, shown: tr.shown, trail: tr.trailRaw, active: !low };
  }
  function scoreTop(ctx, s, dt, W, audio, hi, opts = {}) {
    // Keep the badge clear of the left hero card and the sound panel (x 604); both overlapped before.
    const cardX = 428, cardY = 10, cardW = 168, cardH = 62;
    if (opts.twoUp) { // 2-player: scores sit inside each player's card; only the arena badge + HI stay centred
      const stage = levelName(s.level, s.skate === true || s.level === 3);
      const bx = W / 2 - 41, by = 14;
      roundRectPath(ctx, bx, by, 82, 62, 10); ctx.fillStyle = 'rgba(5,18,14,0.82)'; ctx.fill();
      roundRectPath(ctx, bx, by, 82, 62, 10); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(130,240,150,0.35)'; ctx.stroke();
      stat(ctx, 'ARENA', W / 2, by + 11, 8, 'rgba(130,240,150,0.6)', 'center', 'bold');
      stat(ctx, stage, W / 2, by + 28, stage.length > 8 ? 10 : 13, '#9bd6a3', 'center', 'bold');
      stat(ctx, `WAVE ${s.wave || 0}`, W / 2, by + 42, 8, 'rgba(255,255,255,0.72)', 'center', 'bold');
      stat(ctx, `HI ${Math.floor(hi || 0).toString().padStart(6, '0')}`, W / 2, by + 54, 8, 'rgba(255,255,255,0.56)', 'center', 'bold');
      return;
    }
    const lowBoss = false;
    numeric.score = easeLerp(numeric.score, s.score || 0, dt, 10);
    numeric.hi = easeLerp(numeric.hi || 0, hi || 0, dt, 7);
    panel(ctx, cardX, cardY, cardW, cardH, { fill: 'rgba(5,18,14,0.78)', stroke: 'rgba(130,240,150,0.35)', radius: 12, glow: 'rgba(150,240,255,0.10)' });
    ctx.save();
    stat(ctx, 'SCORE', cardX + 14, cardY + 13, 9, 'rgba(255,232,107,0.75)', 'left', 'bold');
    stat(ctx, Math.floor(numeric.score).toString().padStart(6, '0'), cardX + 14, cardY + 36, 26, THEME.ember, 'left', 'bold');
    stat(ctx, `HI ${Math.floor(numeric.hi).toString().padStart(6, '0')}`, cardX + cardW - 12, cardY + 13, 9, 'rgba(255,255,255,0.56)', 'right', 'bold');
    const stage = levelName(s.level, s.skate === true || s.level === 3);
    // Level badge, deliberately high-contrast so the current arena is readable.
    const badgeX = cardX - 92, badgeY = cardY + 7;
    roundRectPath(ctx, badgeX, badgeY, 82, 50, 10); ctx.fillStyle = 'rgba(5,18,14,0.82)'; ctx.fill();
    roundRectPath(ctx, badgeX, badgeY, 82, 50, 10); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(130,240,150,0.35)'; ctx.stroke();
    stat(ctx, 'ARENA', badgeX + 41, badgeY + 12, 8, 'rgba(130,240,150,0.6)', 'center', 'bold');
    stat(ctx, stage, badgeX + 41, badgeY + 34, 14, '#9bd6a3', 'center', 'bold');
    stat(ctx, `WAVE ${s.wave || 0}`, badgeX + 41, badgeY + 50, 9, 'rgba(255,255,255,0.72)', 'center', 'bold');
    // Combo multiplier is separated from the score so it reads as a modifier,
    // not as ordinary digits left behind by the pulses.
    const combo = s.combo || 0;
    roundRectPath(ctx, cardX + 14, cardY + 50, cardW - 28, 6, 3); ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fill();
    if (combo > 1) {
      const width = (cardW - 28) * Math.max(0, Math.min(1, (s.comboTimer || 0) / 2.5));
      roundRectPath(ctx, cardX + 14, cardY + 50, width, 6, 3); ctx.fillStyle = combo >= 5 ? '#ff6e8f' : '#ffe86b'; ctx.fill();
      stat(ctx, `COMBO x${combo}`, cardX + 14, cardY + 45, 9, combo >= 5 ? '#ff6e8f' : '#ffe86b', 'left', 'bold');
    }
    ctx.restore();
  }
  function status(ctx, W, H, audio) {
    const x = 604, y = 10, w = 124, h = 66;
    panel(ctx, x, y, w, h, { fill: 'rgba(5,18,14,0.78)', stroke: 'rgba(130,240,150,0.30)', radius: 10, glow: 'rgba(150,240,255,0.04)' });
    ctx.save();
    stat(ctx, 'SOUND', x + 12, y + 14, 8, 'rgba(130,240,150,0.65)', 'left', 'bold');
    if (audio?.muted) {
      stat(ctx, 'MUTED', x + w - 10, y + 14, 11, '#ff4d5a', 'right', 'bold');
    } else stat(ctx, `${Math.round((audio?.volume || 0) * 100)}%`, x + w - 10, y + 14, 11, THEME.ember, 'right', 'bold');
    roundRectPath(ctx, x + 12, y + 24, w - 24, 8, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill();
    let vol = audio?.muted ? 0 : (audio?.volume || 0);
    roundRectPath(ctx, x + 12, y + 24, (w - 24) * vol, 8, 4);
    ctx.fillStyle = audio?.muted ? '#ff4d5a' : '#63f7a0'; ctx.fill();
    stat(ctx, 'M toggle  [ ] level', x + w / 2, y + 46, 8, 'rgba(255,255,255,0.45)', 'center');
    ctx.restore();
  }
  function controls(ctx, W, H, info) {
    const text = `J PUNCH  K KICK  L JUMP  J+K BACK  J+L SPECIAL  -> RUN${info.chain > 1 ? '   CHAIN x' + info.chain : ''}${info.airborne ? '   AIR' : ''}`;
    ctx.save();
    // The footer legend stays full width so it never clips the score card or status panel.
    ctx.globalAlpha = 0.52;
    stat(ctx, 'CONTROLS', W / 2, H - 24, 8, 'rgba(130,240,150,0.7)', 'center', 'bold');
    ctx.globalAlpha = 0.78;
    stat(ctx, text, W / 2, H - 12, 8, 'rgba(200,230,210,0.78)', 'center', 'normal');
    ctx.globalAlpha = 1; ctx.restore();
  }
  function enemy(ctx, n, dt) {
    if (!(n.maxHp > 1) || n.boss || n.kind === 'boss' || n.rider || n.dead) return;
    const tr = track(n, Math.max(0, n.hp), n.maxHp, dt);
    const color = ENEMY_TINT[n.kind] || ENEMY_TINT[n.elite ? 'elite' : 'brawler'] || '#ff5252';
    const bz = (n.z || 0) + (n.hover || 0), w = Math.max(62, n.r * 3.4), x = n.x - w / 2, y = n.y + n.r - bz - 60 * (n.scale || 1) - 12;
    // World-space bars stay readable even when the rig is animating a strike.
    ctx.save();
    roundRectPath(ctx, x - 2, y - 2, w + 4, 7, 3.5); ctx.fillStyle = 'rgba(5,5,5,0.5)'; ctx.fill();
    roundRectPath(ctx, x, y, w, 5, 3); ctx.fillStyle = 'rgba(35,10,10,0.7)'; ctx.fill();
    roundRectPath(ctx, x, y, w * tr.trail, 5, 3); ctx.fillStyle = 'rgba(235,214,160,0.45)'; ctx.fill();
    roundRectPath(ctx, x, y, w * tr.frac, 5, 3); ctx.fillStyle = color; ctx.fill();
    if (n.maxHp > 2) for (let i = 1; i < n.maxHp && i <= 20; i++) { ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(x + (w * i) / n.maxHp - 0.5, y, 1, 5); }
    roundRectPath(ctx, x - 2, y - 2, w + 4, 9, 4.5); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.24)'; ctx.stroke();
    ctx.restore();
  }
  function boss(ctx, s, dt, W, H) {
    const b = s.ninjas.find(n => !n.dead && (n.kind === 'boss' || n.rider || n.elite) && n.maxHp > 1);
    if (!b) return null;
    const name = b.name || (b.elite ? 'ELITE' : b.kind === 'boss' ? 'OPENCLAW OVERLORD' : 'OPENCLAW BOSS');
    const tr = track(b, Math.max(0, b.hp), b.maxHp, dt);
    const w = W * 0.7, x = (W - w) / 2, y = H - 34, h = 16;
    const phase = b.phase || Math.ceil(b.hp / (b.maxHp / 3 || 1));
    ctx.save();
    // Top banner line with name, centered and framed.
    const headerY = y - 16;
    ctx.fillStyle = 'rgba(5,5,5,0.45)'; roundRectPath(ctx, x - 2, headerY - 12, w + 4, 26, 6); ctx.fill();
    stat(ctx, name, W / 2, headerY, 15, '#ffd7f6', 'center', 'bold');
    stat(ctx, `HP ${Math.ceil(b.hp)} / ${b.maxHp}`, W / 2, headerY + 14, 8, 'rgba(255,255,255,0.65)', 'center', 'bold');
    // Larger, slightly taller boss bar so the bottom HUD has real presence.
    drawBar(ctx, x, y, w, h, { frac: tr.frac, trail: tr.trail, color: '#ff4bd4', trailColor: '#ffd7f4', ticks: Math.min(20, b.maxHp || 1), glow: 'rgba(255,90,200,0.35)', trackColor: '#260824' });
    // Segmented HP notches at 33% intervals show the boss phase structure.
    for (let i = 1; i <= 2; i++) { const px = x + (w * i) / 3; ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(px - 1, y - 2, 2, h + 4); }
    // Phase pips. These stay synced with boss hp rather than combat phase state.
    const pips = 3, px0 = x + 10;
    for (let i = 0; i < pips; i++) {
      const alive = (i + 1 <= phase) ? 1 : 0;
      roundRectPath(ctx, px0 + i * 20, y - 10, 12, 4, 2); ctx.fillStyle = alive ? '#ff88e0' : 'rgba(255,255,255,0.16)'; ctx.fill();
    }
    // Boss telegraph name, if the AI has one queued.
    if (b.atk?.label && b.atk.phase && b.atk.phase !== 'idle') {
      const label = String(b.atk.label).toUpperCase();
      stat(ctx, label, x + w + 12, y + h / 2, 10, '#ffc0ff', 'left', 'bold');
    }
    // A danger line above the arena.
    ctx.fillStyle = 'rgba(255,90,240,0.12)'; ctx.fillRect(x, y - 1, w, 2);
    ctx.restore();
    return b;
  }
  return { player, enemy, boss, drawBar, top: scoreTop, status, controls, track };
}
