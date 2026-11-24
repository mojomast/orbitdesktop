// shop.js — Between-stage shop: spend pizza coins on run upgrades (DOLAN).
// Opens after a stage-clear card closes (after the bonus stage on stage 2),
// except after the final stage. The world is frozen while it is open.
// Currency s.coins: +1 per enemy KO (stepWorld), +5 per stage clear (screens.js),
// +1 per 1000 delivery-bonus points (bonus.js), ruby +3 / emerald +1 (breakables.js).
// Damage upgrades never touch combat.js: stepWorld diffs enemy hp each sim step
// and removes an extra (dmgMult - 1) x the loss, carrying fractions per enemy.
// Everything lives on the state object, so a new run starts clean.
import { damageNinja, LEVEL_ORDER } from './logic.js';

export const ITEMS = [
  { id: 'hp', name: 'MAX HP +20', desc: 'Raises max HP by 20 and heals 20.', prices: [8, 14, 22], max: 3 },
  { id: 'dmg', name: 'DAMAGE +15%', desc: 'Every hit you land deals 15% more.', prices: [10, 18, 28], max: 3 },
  { id: 'life', name: 'EXTRA LIFE', desc: 'One more life in the bank.', prices: [12, 20, 30, 45, 65], max: 99 },
  { id: 'meter', name: 'TEAM UP START', desc: 'The TEAM UP meter starts the next stage at 50.', prices: [6, 9, 12, 16, 20], max: 99, perVisit: 1 },
  { id: 'ammo', name: 'PIZZA POWER', desc: 'Pizza weapon level +1 (max 5).', prices: [7, 11, 16, 22], max: 99 },
];
export const KO_COIN = 1, DMG_STEP = 0.15, WEAPON_CAP = 5, IDLE_SECS = 30;
const LINES = {
  open: ['Welcome back! Upgrades, hot from the oven!', 'Coins on the counter, power in the box!', 'You look hungry. For POWER!'],
  hp: 'Extra cheese, extra heart!', dmg: 'Now you hit like a rolling pin!', life: 'A spare shell. Don\'t drop it!',
  meter: 'Charged up like a turbo oven!', ammo: 'Hot pies, flying faster!',
  poor: ['No coins, no toppings!', 'That costs more dough than you have!', 'Come back with a fatter wallet!'],
  max: 'Sold out! Even my oven has limits.', perVisit: 'One per visit, champ!', leave: 'Go get \'em! Come back hungry!',
};
const pick = v => Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v;

export function createShop({ audio, onDone } = {}) {
  const img = {};
  for (const k of ['bg', 'hp', 'dmg', 'life', 'meter', 'ammo', 'coin']) { try { const im = new Image(); im.src = 'assets/shop/' + k + (k === 'bg' ? '.jpg' : '.png'); img[k] = im; } catch (_) {} }
  const ready = im => im && im.complete && im.naturalWidth;
  const play = n => { try { audio && audio.play(n); } catch (_) {} };
  let owner = null, hpSeen = new WeakMap(), carry = new WeakMap(), kos = new WeakSet(), tracked = [];
  let ui = null; // { s, sel, t, idle, shown, shake, line, lineT, visit: {} }
  const stats = { opened: 0, bought: 0, refused: 0, extraDmg: 0 };

  function ensure(s) {
    if (owner === s) return;
    owner = s; hpSeen = new WeakMap(); carry = new WeakMap(); kos = new WeakSet(); tracked = [];
    if (!Number.isFinite(s.coins)) s.coins = 0;
    s.shopBuys = { hp: 0, dmg: 0, life: 0, meter: 0, ammo: 0 }; s.dmgMult = 1; s.superStart = 0;
    for (const n of s.ninjas || []) { hpSeen.set(n, n.hp); if (n.dead) kos.add(n); }
  }
  // Per sim step (game.js, after bosses.step): KO coins + the damage multiplier.
  function stepWorld(s) {
    ensure(s);
    const mult = s.dmgMult || 1;
    for (const n of s.ninjas) {
      const prev = hpSeen.get(n);
      if (mult > 1 && prev != null && !n.dead && n.hp < prev) {
        const want = (prev - n.hp) * (mult - 1) + (carry.get(n) || 0), extra = Math.floor(want);
        carry.set(n, want - extra);
        if (extra > 0) { stats.extraDmg += extra; if (n.hp - extra <= 0) damageNinja(s, n, extra); else n.hp -= extra; }
      }
      hpSeen.set(n, n.hp);
    }
    // KOs: logic.js drops dead enemies from s.ninjas, so also check last step's list.
    for (const n of tracked.concat(s.ninjas)) if ((n.dead || n.hp <= 0) && !kos.has(n)) { kos.add(n); s.coins += KO_COIN; }
    tracked = s.ninjas.slice();
  }
  const price = (s, it) => it.prices[Math.min(it.prices.length - 1, s.shopBuys[it.id] || 0)];
  function blocked(s, it) {
    if ((s.shopBuys[it.id] || 0) >= it.max) return 'max';
    if (it.id === 'ammo' && (s.weaponLevel || 1) >= WEAPON_CAP) return 'max';
    if (it.perVisit && ui && (ui.visit[it.id] || 0) >= it.perVisit) return 'perVisit';
    return null;
  }

  function open(s, info = {}) {
    if (!s || ui || s.over || s.runComplete || s.hpMode === false) return false;
    const last = LEVEL_ORDER[LEVEL_ORDER.length - 1];
    if (info.level != null && info.level === last) return false; // no shop after the final stage
    ensure(s);
    ui = { s, sel: 0, t: 0, idle: 0, shown: s.coins, shake: 0, shakeSel: -1, line: pick(LINES.open), lineT: 0, visit: {}, flash: 0 };
    stats.opened++; play('chime');
    return true;
  }
  const active = () => !!ui;
  function say(text) { ui.line = text; ui.lineT = 0; }
  function buy(i) {
    const s = ui.s;
    if (i === ITEMS.length) { leave(); return true; }
    const it = ITEMS[i], why = blocked(s, it), cost = price(s, it);
    if (why) { ui.shake = 0.35; ui.shakeSel = i; play('whiff'); say(LINES[why]); stats.refused++; return false; }
    if (s.coins < cost) { ui.shake = 0.35; ui.shakeSel = i; play('warn'); say(pick(LINES.poor)); stats.refused++; return false; }
    s.coins -= cost; s.shopBuys[it.id] = (s.shopBuys[it.id] || 0) + 1; ui.visit[it.id] = (ui.visit[it.id] || 0) + 1; stats.bought++;
    if (it.id === 'hp') { s.maxHp = (s.maxHp || 100) + 20; s.hp = Math.min(s.maxHp, (s.hp || 0) + 20); }
    else if (it.id === 'dmg') s.dmgMult = +(1 + DMG_STEP * s.shopBuys.dmg).toFixed(2);
    else if (it.id === 'life') s.lives = (s.lives || 0) + 1;
    else if (it.id === 'meter') s.superStart = 50;
    else if (it.id === 'ammo') { s.weaponLevel = Math.min(WEAPON_CAP, (s.weaponLevel || 1) + 1); s.weaponDurability = s.weaponLevel > 1 ? 24 * s.weaponLevel : 0; }
    play('chime'); play('pickup'); ui.flash = 0.3; say(LINES[it.id]);
    return true;
  }
  function leave() {
    if (!ui) return;
    const s = ui.s; ui = null;
    if (s.superStart) { s.super = Math.max(s.super || 0, s.superStart); s.superStart = 0; } // the next stage starts with it
    play('start');
    if (onDone) { try { onDone(s); } catch (_) {} }
  }
  function handleKey(e) {
    if (!ui) return false;
    if (e.repeat) return true;
    ui.idle = 0;
    const c = e.code, n = ITEMS.length + 1, col = ui.sel % 3, row = Math.floor(ui.sel / 3);
    if (c === 'Escape') { say(LINES.leave); leave(); return true; }
    if (c === 'ArrowLeft' || c === 'KeyA') { ui.sel = row * 3 + (col + 2) % 3; play('menuMove'); }
    else if (c === 'ArrowRight' || c === 'KeyD') { ui.sel = row * 3 + (col + 1) % 3; play('menuMove'); }
    else if (c === 'ArrowUp' || c === 'KeyW' || c === 'ArrowDown' || c === 'KeyS') { ui.sel = (ui.sel + 3) % n; play('menuMove'); }
    else if (c === 'KeyJ' || c === 'Enter' || c === 'Space') buy(ui.sel);
    return true;
  }
  function update(dt) {
    if (!ui) return;
    ui.t += dt; ui.idle += dt; ui.lineT += dt;
    ui.shake = Math.max(0, ui.shake - dt); ui.flash = Math.max(0, ui.flash - dt);
    const target = ui.s.coins; // coin count ticks toward the real value
    if (ui.shown !== target) { const step = Math.max(1, Math.abs(target - ui.shown) * 6 * dt); ui.shown = ui.shown > target ? Math.max(target, ui.shown - step) : Math.min(target, ui.shown + step); }
    if (ui.idle >= IDLE_SECS) { say(LINES.leave); leave(); }
  }

  // --- drawing ------------------------------------------------------------
  const TX = 262, TY = 74, TW = 148, TH = 128, GAP = 10;
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
  function bubble(ctx, text) {
    const k = Math.min(1, ui.lineT / 0.15), x = 14, y = 16, w = 236;
    ctx.save(); ctx.font = 'bold 13px monospace';
    const words = text.split(' '), lines = []; let cur = '';
    for (const wd of words) { const tryL = cur ? cur + ' ' + wd : wd; if (ctx.measureText(tryL).width > w - 24) { lines.push(cur); cur = wd; } else cur = tryL; }
    if (cur) lines.push(cur);
    const h = 18 + lines.length * 17;
    ctx.translate(x + w / 2, y + h); ctx.scale(0.85 + 0.15 * k, 0.85 + 0.15 * k); ctx.translate(-(x + w / 2), -(y + h));
    ctx.fillStyle = 'rgba(255,250,235,0.96)'; ctx.strokeStyle = '#3a1d0a'; ctx.lineWidth = 3;
    rr(ctx, x, y, w, h, 12); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 92, y + h - 1); ctx.lineTo(x + 104, y + h + 22); ctx.lineTo(x + 122, y + h - 1); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + 92, y + h); ctx.lineTo(x + 104, y + h + 22); ctx.lineTo(x + 122, y + h); ctx.stroke();
    ctx.fillStyle = '#2a1405'; ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, x + 12, y + 22 + i * 17));
    ctx.restore();
  }
  function draw(ctx, W, H) {
    if (!ui) return;
    const s = ui.s;
    ctx.save();
    if (ready(img.bg)) ctx.drawImage(img.bg, 0, 0, W, H); else { ctx.fillStyle = '#1c120c'; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = 'rgba(8,6,14,0.5)'; rr(ctx, TX - 12, 14, W - TX + 4, 344, 14); ctx.fill();
    // Header: title + coin purse.
    ctx.textAlign = 'left'; ctx.font = 'bold 26px monospace'; ctx.lineWidth = 5; ctx.strokeStyle = '#1a0b02';
    ctx.strokeText('PIZZA SHOP', TX, 50); ctx.fillStyle = '#ffd84a'; ctx.fillText('PIZZA SHOP', TX, 50);
    const coinY = 26; if (ready(img.coin)) ctx.drawImage(img.coin, W - 132, coinY - 4, 32, 32);
    ctx.font = 'bold 22px monospace'; ctx.textAlign = 'right'; ctx.strokeText('x ' + Math.round(ui.shown), W - 22, coinY + 21); ctx.fillStyle = ui.shown !== s.coins ? '#fff' : '#ffd84a'; ctx.fillText('x ' + Math.round(ui.shown), W - 22, coinY + 21);
    // Tiles.
    for (let i = 0; i <= ITEMS.length; i++) {
      const it = ITEMS[i], col = i % 3, row = Math.floor(i / 3), sel = i === ui.sel;
      let x = TX + col * (TW + GAP), y = TY + row * (TH + GAP);
      if (ui.shake > 0 && ui.shakeSel === i) x += Math.sin(ui.t * 70) * 7 * (ui.shake / 0.35);
      const why = it ? blocked(s, it) : null, cost = it ? price(s, it) : 0, poor = it && !why && s.coins < cost, dim = !!(it && (why || poor));
      ctx.save(); ctx.globalAlpha = dim && !sel ? 0.5 : 1;
      ctx.fillStyle = sel ? 'rgba(70,40,10,0.94)' : 'rgba(26,16,10,0.88)'; rr(ctx, x, y, TW, TH, 10); ctx.fill();
      ctx.lineWidth = sel ? 3 : 1.5; ctx.strokeStyle = sel ? (dim ? '#ff6b5a' : '#ffd84a') : 'rgba(255,220,150,0.3)';
      if (sel) { ctx.shadowColor = dim ? '#ff4030' : '#ffb020'; ctx.shadowBlur = 10 + 4 * Math.sin(ui.t * 6); }
      ctx.stroke(); ctx.shadowBlur = 0;
      ctx.textAlign = 'center';
      if (it) {
        const im = img[it.id], bob = sel ? Math.sin(ui.t * 5) * 3 : 0;
        if (ready(im)) ctx.drawImage(im, x + TW / 2 - im.naturalWidth / 2, y + 12 + bob, im.naturalWidth, im.naturalHeight);
        ctx.font = 'bold 13px monospace'; ctx.fillStyle = '#fff3d6'; ctx.fillText(it.name, x + TW / 2, y + 88);
        const owned = s.shopBuys[it.id] || 0;
        if (it.max <= 3) { for (let k = 0; k < it.max; k++) { ctx.fillStyle = k < owned ? '#ffd84a' : 'rgba(255,255,255,0.18)'; ctx.fillRect(x + TW / 2 - 22 + k * 16, y + 95, 12, 4); } }
        else if (it.id === 'ammo') { ctx.font = 'bold 10px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillText('LV ' + (s.weaponLevel || 1) + ' / ' + WEAPON_CAP, x + TW / 2, y + 100); }
        else if (it.id === 'life') { ctx.font = 'bold 10px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillText('LIVES ' + (s.lives || 0), x + TW / 2, y + 100); }
        else if (it.id === 'meter') { ctx.font = 'bold 10px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillText(ui.visit.meter ? 'READY' : 'NEXT STAGE', x + TW / 2, y + 100); }
        ctx.font = 'bold 15px monospace';
        if (why) { ctx.fillStyle = '#ff9a8a'; ctx.fillText(why === 'max' ? 'SOLD OUT' : 'BOUGHT', x + TW / 2, y + 120); }
        else { ctx.fillStyle = poor ? '#ff7a6a' : '#ffd84a'; if (ready(img.coin)) ctx.drawImage(img.coin, x + TW / 2 - 30, y + 106, 16, 16); ctx.fillText(String(cost), x + TW / 2 + 8, y + 120); }
      } else {
        ctx.font = 'bold 20px monospace'; ctx.fillStyle = sel ? '#7cff6b' : '#cfe8c8'; ctx.fillText('CONTINUE', x + TW / 2, y + 64);
        ctx.font = 'bold 22px monospace'; ctx.fillText('\u2192', x + TW / 2, y + 94);
      }
      ctx.restore();
    }
    // Counter: selected item description.
    const it = ITEMS[ui.sel];
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(10,6,2,0.55)'; rr(ctx, TX - 12, 372, W - TX + 4, 84, 10); ctx.fill();
    ctx.font = 'bold 17px monospace'; ctx.fillStyle = '#ffd84a'; ctx.fillText(it ? it.name : 'BACK TO THE STREETS', TX, 398);
    ctx.font = '14px monospace'; ctx.fillStyle = '#f2e6d0'; ctx.fillText(it ? it.desc : 'Leave the shop and start the next stage.', TX, 422);
    if (it) { const why = blocked(s, it), cost = price(s, it); ctx.fillStyle = why ? '#ff9a8a' : s.coins < cost ? '#ff7a6a' : '#9bd6a3'; ctx.fillText(why === 'max' ? 'Sold out.' : why ? 'Already bought this visit.' : s.coins < cost ? `Costs ${cost} coins: not enough coins.` : `Costs ${cost} coins.`, TX, 444); }
    ctx.textAlign = 'center'; ctx.font = '12px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText('\u2190\u2191\u2192\u2193 SELECT    J / ENTER / SPACE BUY    ESC LEAVE', W / 2 + 120, H - 14);
    bubble(ctx, ui.line);
    if (ui.flash > 0) { ctx.fillStyle = `rgba(255,230,120,${ui.flash * 0.5})`; ctx.fillRect(0, 0, W, H); }
    ctx.restore(); ctx.textAlign = 'left';
  }

  const api = { open, active, handleKey, update, draw, stepWorld, leave, buy: i => ui ? buy(i) : false, ITEMS, stats, price: (s, id) => price(s, ITEMS.find(i => i.id === id)),
    get ui() { return ui ? { sel: ui.sel, idle: ui.idle, shown: ui.shown, line: ui.line, coins: ui.s.coins } : null; } };
  if (typeof window !== 'undefined') window.__ppShop = api;
  return api;
}
