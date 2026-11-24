// save.js: stage checkpoint save + CONTINUE FROM STAGE N (mr_india, t_1a56b31774f34ff9).
// Saves P1 progress after every stage clear and again when the shop closes: the next
// stage (wave), hero, difficulty, coins, shop upgrades and their effects, score, lives.
// Storage reuses game.js's guarded store ({ get, set } that swallow the SecurityError
// Orbit's sandboxed origin throws) and keeps an in-memory copy, so the save still
// works for the session when nothing persists. Bad data (corrupt JSON, wrong version,
// out-of-range stage, unknown hero) is ignored and dropped, never trusted.
// The title shows a small menu once PRESS START is up and a save exists:
//   CONTINUE FROM STAGE N / NEW GAME / CLEAR SAVE  (Up/Down or W/S, Enter/Space/J; pad via gamepad.js)
// The save is kept after a game over (that is when you want to continue) and cleared
// on final victory or with CLEAR SAVE.
import { LEVEL_ORDER, spawnWave, levelForWave } from './logic.js';
import { STAGE_NAMES } from './screens.js';
import { HEROES } from './heroes.js';

export const SAVE_KEY = 'pizzaPanicCheckpoint';
export const SAVE_VERSION = 1;
const DIFFS = ['easy', 'normal', 'hard'];
const NAMES = { 4: 'TOWER', 5: 'SUBWAY', 6: 'HARBOR', 7: 'ARCADE' }; // levels screens.js STAGE_NAMES does not list
const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d);

// Guarded storage: every access inside try (even reading `localStorage` can throw in a sandbox).
export function guardedStore(store) {
  const mem = new Map();
  const fallback = {
    get(k) { try { const ls = globalThis.localStorage; return ls ? ls.getItem(k) : null; } catch { return null; } },
    set(k, v) { try { const ls = globalThis.localStorage; if (ls) ls.setItem(k, v); } catch { /* sandboxed: memory only */ } },
  };
  const base = store || fallback;
  return {
    get(k) { let v = null; try { v = base.get(k); } catch { v = null; } return v == null ? (mem.has(k) ? mem.get(k) : null) : v; },
    set(k, v) { mem.set(k, v); try { base.set(k, v); } catch { /* memory only */ } },
    remove(k) { mem.delete(k); try { if (base.remove) base.remove(k); else base.set(k, ''); } catch { /* ignore */ } },
  };
}

// Validate a parsed save; returns a clean object or null.
export function validSave(d) {
  if (!d || typeof d !== 'object' || d.v !== SAVE_VERSION) return null;
  const wave = Math.floor(+d.wave);
  if (!Number.isFinite(wave) || wave < 2 || wave > LEVEL_ORDER.length) return null; // stage 1 needs no save
  if (!HEROES.some(h => h.id === d.hero)) return null;
  const buys = {};
  if (d.shopBuys && typeof d.shopBuys === 'object') for (const [k, v] of Object.entries(d.shopBuys)) if (/^[a-z]{1,12}$/.test(k)) buys[k] = num(v, 0, 99, 0) | 0;
  return { v: SAVE_VERSION, wave, hero: d.hero, difficulty: DIFFS.includes(d.difficulty) ? d.difficulty : 'normal',
    coins: num(d.coins, 0, 99999, 0) | 0, score: num(d.score, 0, 1e9, 0) | 0, lives: num(d.lives, 1, 99, 3) | 0,
    maxHp: num(d.maxHp, 50, 400, 100) | 0, dmgMult: num(d.dmgMult, 1, 3, 1), weaponLevel: num(d.weaponLevel, 1, 5, 1) | 0,
    superStart: num(d.superStart, 0, 100, 0) | 0, shopBuys: buys, coop: !!d.coop, at: num(d.at, 0, 9e15, 0) };
}

export function createCheckpoint(opts = {}) {
  const store = guardedStore(opts.store);
  const ui = { sel: 0, toast: null, toastT: 0 };
  let lastWave = 0, lastShop = false, owner = null;

  function load() {
    const raw = store.get(SAVE_KEY);
    if (!raw) return null;
    let d = null; try { d = JSON.parse(raw); } catch { d = null; }
    const ok = validSave(d);
    if (!ok) store.remove(SAVE_KEY); // corrupt / invalid: drop it, never trust it
    return ok;
  }
  function snapshot(s) {
    return validSave({ v: SAVE_VERSION, wave: s.wave, hero: s.selectedHero, difficulty: s.difficulty, coins: s.coins, score: s.score, lives: s.lives,
      maxHp: s.maxHp, dmgMult: s.dmgMult, weaponLevel: s.weaponLevel, superStart: s.superStart, shopBuys: s.shopBuys, coop: !!s.coopJoined, at: Date.now() });
  }
  function save(s) { const d = snapshot(s); if (!d) return false; store.set(SAVE_KEY, JSON.stringify(d)); return true; }
  function clear() { store.remove(SAVE_KEY); ui.sel = 0; }

  // Per-frame watcher (game.js loop): save on stage clear (wave goes up) and when the shop closes.
  function watch(s, env = {}) {
    if (!s || !s.hpMode) return;
    if (owner !== s) { owner = s; lastWave = s.wave; lastShop = false; }
    if (s.runComplete) { if (load()) clear(); lastWave = s.wave; return; } // final victory: the run is over
    if (s.wave > lastWave && !s.over) { lastWave = s.wave; save(s); }
    const shopOpen = !!env.shop;
    if (lastShop && !shopOpen && !s.over) save(s); // coins / upgrades spent at the shop
    lastShop = shopOpen;
  }

  // Continue: called right after a normal run start (wave 1 spawned); jumps to the saved stage.
  let pending = null;
  function arm(d) { pending = d || load(); return !!pending; }
  function resume(s) {
    const d = pending; pending = null;
    if (!d) return false;
    s.ninjas = []; s.pizzas = []; s.powerups = []; s.hazards = [];
    s.selectedHero = d.hero; s.difficulty = d.difficulty; s.coins = d.coins; s.score = d.score; s.lives = d.lives;
    s.shopBuys = { ...d.shopBuys }; s.maxHp = d.maxHp; s.hp = d.maxHp; s.dmgMult = d.dmgMult; s.weaponLevel = d.weaponLevel;
    s.weaponDurability = d.weaponLevel > 1 ? 24 * d.weaponLevel : 0; s.superStart = d.superStart;
    s.events = null; s.bossSeen = false; s.runComplete = false; s.holdWave = false;
    s.wave = d.wave - 1; spawnWave(s); // -> wave d.wave, its level, hero at the left edge
    s.continuedFrom = d.wave; owner = s; lastWave = s.wave;
    return true;
  }

  // Title menu (only while PRESS START is up and a save exists).
  function items(d) { return d ? [`CONTINUE FROM STAGE ${d.wave}`, 'NEW GAME', 'CLEAR SAVE'] : null; }
  function menuKey(e) {
    const d = load(); if (!d) return null;
    const c = e.code, n = 3;
    if (c === 'ArrowUp' || c === 'KeyW') { ui.sel = (ui.sel + n - 1) % n; return 'nav'; }
    if (c === 'ArrowDown' || c === 'KeyS') { ui.sel = (ui.sel + 1) % n; return 'nav'; }
    if (c === 'Enter' || c === 'Space' || c === 'KeyJ') {
      if (ui.sel === 0) { arm(d); return 'continue'; }
      if (ui.sel === 1) return 'new';
      clear(); ui.toast = 'SAVE CLEARED'; ui.toastT = 1.6; return 'clear';
    }
    return 'nav'; // other keys do nothing while the menu is up (no accidental new game)
  }
  function draw(ctx, W, H, show, dt = 1 / 60) {
    if (ui.toastT > 0) ui.toastT = Math.max(0, ui.toastT - dt);
    const d = show ? load() : null;
    ctx.save(); ctx.textAlign = 'center';
    if (d) {
      const list = items(d), name = STAGE_NAMES[levelForWave(d.wave)] || NAMES[levelForWave(d.wave)] || '';
      const x = W / 2, y0 = 336, bw = 330, bh = 26 * list.length + 30;
      ctx.fillStyle = 'rgba(6,10,16,0.82)'; ctx.fillRect(x - bw / 2, y0 - 22, bw, bh);
      ctx.strokeStyle = '#ffeb57'; ctx.lineWidth = 2; ctx.strokeRect(x - bw / 2, y0 - 22, bw, bh);
      list.forEach((t, i) => {
        const on = i === ui.sel; ctx.font = (on ? 'bold ' : '') + '16px monospace'; ctx.fillStyle = on ? '#ffeb57' : '#cfd8dc';
        ctx.fillText((on ? '> ' : '  ') + t + (on ? ' <' : '  '), x, y0 + i * 26);
      });
      ctx.font = '11px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
      const heroName = (HEROES.find(h => h.id === d.hero) || {}).name || d.hero;
      ctx.fillText(`${heroName} - ${name} - ${d.difficulty.toUpperCase()} - ${d.coins} coins - ${d.score} pts`, x, y0 + list.length * 26 + 2);
    }
    if (ui.toastT > 0) { ctx.globalAlpha = Math.min(1, ui.toastT * 2); ctx.font = 'bold 18px monospace'; ctx.fillStyle = '#7cff6b'; ctx.fillText(ui.toast, W / 2, 360); }
    ctx.restore();
  }

  return { load, save, clear, watch, arm, resume, menuKey, draw, has: () => !!load(), get sel() { return ui.sel; }, set sel(v) { ui.sel = v | 0; }, items: () => items(load()), store };
}
