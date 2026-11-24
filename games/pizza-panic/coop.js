// coop.js: local 2-player co-op (cheese, board t_3a33c55607144558).
//
// Player 2 is a *view* of the shared game state: Object.create(state) with its
// own player body, combat state, HP, lives, score, timers and enemy shots, so the
// existing combat.js functions (combatWalk / combatPress / combatStep / enemyAI)
// run for P2 unchanged. Everything else (ninjas, level, events, pickups) is read
// through the prototype from the one shared state.
//
// Single player: until P2 joins, every entry point returns at once and no state
// is touched (no coopFilter, no extra fields), so the game runs exactly as before.
//
// P2 controls: keyboard numpad (8/4/5/6 move, 1 punch, 2 kick, 3 jump, 0 dash,
// . throw, + taunt, Enter = Start: join / continue) or a second gamepad (same
// layout as pad 1; gamepad.js hands pad 2 to us as `pad2`).
//
// game.js hooks (one line each): createCoop, coop.step after P1's combatStep,
// coop.after after the world step, coop.drawWorld after P1 is drawn,
// coop.drawHud after the P1 card, coop.drawSelect on the select screen.
// combat.js hooks: combatStep returns before the shared enemy half for P2
// (state.coopSecondary), and enemyAI honours state.coopFilter.
import { createCombat, combatTap, combatPress, combatStep, combatWalk, combatDash, enemyAI } from './combat.js';
import { throwPizza, healPlayer, damagePlayer, damageNinja, hurtR, SKATE_LEVEL, W as LW, CAMERA_EASE_RATE } from './logic.js';
import { LEVELS, WORLD_W } from './collision.js';
import { HEROES } from './heroes.js';
import { drawShots, drawBoard } from './skate.js';
import { HAZARD } from './subway.js';
import { SUBWAY_LEVEL_INDEX } from './subway-data.js';
import { CRANE, HARBOR_LEVEL_INDEX } from './harbor-data.js';
import { PICKUPS } from './breakables.js';
import { drawGrab } from './grab.js';

export const P2_KEYS = {
  left: 'Numpad4', right: 'Numpad6', up: 'Numpad8', down: 'Numpad5',
  punch: 'Numpad1', kick: 'Numpad2', jump: 'Numpad3', dash: 'Numpad0', throw: 'NumpadDecimal', taunt: 'NumpadAdd', start: 'NumpadEnter',
};
// Pad 2 (standard mapping), same layout as pad 1 in gamepad.js.
export const P2_PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, START: 9 };
export const COOP = {
  margin: 24,            // players stay this far inside the screen edges
  lives: 3, continueT: 10, reviveR: 56, reviveT: 1.5, reviveHp: 0.5,
  continues: 3,          // shared continue pool (spec: revives and shared continues); refills on a continue-screen continue
  retarget: [0.8, 1.2],  // seconds an enemy keeps its target
  extraEvery: 2,         // co-op: one extra enemy for every N spawned (enemy count scales with players)
};
const EXTRA_KINDS = new Set(['brawler', 'striker', 'blocker', 'thrower', 'charger', 'acrobat', 'skater', 'foot', 'runner', 'trooper']);

export function createCoop(opts = {}) {
  const rig = opts.rig, hud = opts.hud; let anim = opts.anim;
  const rand = opts.rand || Math.random;
  const selecting = opts.selecting || (() => false);
  const playing = opts.playing || (() => true);
  const selectIndex = opts.selectIndex || (() => 0);
  let owner = null, v = null;                    // shared state and P2's view of it
  let coopCam = null;                            // baba_booey: the co-op camera as shown last frame
  let joined = false, ready = false, pick = 0;   // select-screen / drop-in picker
  let picking = false;                           // mid-level drop-in hero picker open
  let throwCd = 0, cont = 0, revive = 0, lastWave = -1, lastLevel = -1, extraN = 0;
  let p1Out = false, revive1 = 0, cont1 = 0, pool = COOP.continues, handed = false, seenCont = 0; const tgt = {};
  const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : new Set();
  const keys = {}; let pad = { buttons: [], dirs: {} }, padPrev = [], padDirPrev = {};
  const stats = { joins: 0, continues: 0, revives: 0, extras: 0, p2Hits: 0 };
  let img = null;
  if (typeof Image !== 'undefined') { const im = new Image(); im.onload = () => { img = im; }; im.src = 'assets/pizza.png'; }

  const heroAt = i => HEROES[((i % HEROES.length) + HEROES.length) % HEROES.length];
  const p1Hero = () => (owner && owner.selectedHero) || (HEROES[selectIndex()] || HEROES[0]).id;
  function nextFree(i, dir = 1) { // a hero index that is not P1's pick
    const taken = selecting() ? (HEROES[selectIndex()] || {}).id : p1Hero();
    for (let k = 0; k < HEROES.length; k++) { const h = heroAt(i + k * dir); if (h.id !== taken) return HEROES.indexOf(h); }
    return ((i % HEROES.length) + HEROES.length) % HEROES.length;
  }

  // P2's own slice of the state. Writes made by combat/logic code land on the
  // view (own properties); reads of shared things fall through to `s`.
  function makeView(s, heroId, x, y) {
    const view = Object.create(s);
    Object.assign(view, {
      coopSecondary: true, coopP: 2, selectedHero: heroId,
      player: { x, y, r: s.player.r, speed: s.player.speed, shield: false, level: s.level, z: 0 },
      hp: s.maxHp || 100, maxHp: s.maxHp || 100, lives: COOP.lives, over: false, invuln: 2,
      combo: 0, comboTimer: 0, bestCombo: 0, rapidTimer: 0, spreadTimer: 0, weaponLevel: 1, weaponDurability: 0,
      hurtT: 0, playerDown: 0, score: 0, hpHit: 0, taunt: 0, lifeLost: 0, enemyShots: [], screenThrows: [], t: 0, pizzas: [],
    });
    view.coopFilter = n => n.coopT === 2;
    createCombat(view);
    return view;
  }
  const active = () => !!(v && owner);
  const skating = s => s.level === SKATE_LEVEL;
  const benched = s => !s.walkLevel && !skating(s); // level transitions: P2 rides along
  const inPlay = s => active() && !benched(s) && !v.over;

  function spawnP2(s, heroId) {
    const p = s.player, lv = LEVELS[s.level | 0], band = lv && lv.walkables && lv.walkables[0];
    const y = band ? Math.max(band.y + 12, Math.min(band.y + band.h - 12, p.y + 18)) : p.y;
    v = makeView(s, heroId, Math.max(40, p.x - 70), y);
    s.coopFilter = n => n.coopT !== 2;
    joined = true; picking = false; cont = 0; revive = 0; stats.joins++; seenCont = s.continues | 0;
    lastWave = s.wave; lastLevel = s.level;
    return v;
  }
  function drop(s) { v = null; if (s) delete s.coopFilter; }

  // Public join: from the select screen (ready), mid-level, or a test.
  function join(s, heroId) {
    if (!s) { joined = true; ready = !!heroId; if (heroId) pick = Math.max(0, HEROES.findIndex(h => h.id === heroId)); return null; }
    owner = s;
    const id = heroId && heroId !== s.selectedHero ? heroId : heroAt(nextFree(pick)).id;
    return spawnP2(s, id);
  }
  function continueP2(s = owner, free = false) {
    if (!v || !v.over) return false;
    if (!free) { if (pool <= 0) return false; pool--; }
    const p = s.player;
    Object.assign(v, { over: false, lives: COOP.lives, hp: v.maxHp, invuln: 2, playerDown: 0, hurtT: 0 });
    v.player.x = Math.max(40, p.x - 60); v.player.y = p.y; stats.continues++; cont = 0; revive = 0;
    return true;
  }

  // ---- input -------------------------------------------------------------
  const p2Code = code => Object.values(P2_KEYS).includes(code);
  function onPress(name) {
    const s = owner;
    if (name === 'start') {
      if (selecting()) { if (!joined) { joined = true; ready = false; pick = nextFree(selectIndex() + 1); } else ready = !ready; return; }
      if (!playing() || !s) return;
      if (!joined || (!v && !picking)) { joined = true; picking = true; pick = nextFree(pick); return; }
      if (picking) { spawnP2(s, heroAt(pick).id); return; }
      if (v && v.over) continueP2(s);
      return;
    }
    if (name === 'p1continue') { if (p1Out && pool > 0 && playing()) continueP1(s); return; }
    if (selecting()) {
      if (!joined) return;
      if (name === 'left' || name === 'right') { if (!ready) pick = nextFree(pick + (name === 'right' ? 1 : -1), name === 'right' ? 1 : -1); return; }
      if (name === 'punch' || name === 'jump') { ready = true; return; }
      if (name === 'kick') { ready = false; return; }
      return;
    }
    if (picking) {
      if (name === 'left' || name === 'right') pick = nextFree(pick + (name === 'right' ? 1 : -1), name === 'right' ? 1 : -1);
      else if ((name === 'punch' || name === 'jump') && s && playing()) spawnP2(s, heroAt(pick).id);
      return;
    }
    if (!s || !inPlay(s) || !playing()) return;
    if (name === 'left') combatTap(v, -1);
    else if (name === 'right') combatTap(v, 1);
    else if (name === 'punch' || name === 'kick' || name === 'jump') combatPress(v, name);
    else if (name === 'dash') combatDash(v, dirX() || 0);
    else if (name === 'taunt') v.taunt = 0.9;
  }
  const nameOf = code => Object.keys(P2_KEYS).find(k => P2_KEYS[k] === code);
  if (typeof addEventListener === 'function') {
    addEventListener('keydown', e => {
      if (!p2Code(e.code)) return;
      e.preventDefault && e.preventDefault();
      keys[e.code] = true;
      if (!e.repeat) onPress(nameOf(e.code));
    });
    addEventListener('keyup', e => { if (p2Code(e.code)) keys[e.code] = false; });
    // P1 out of lives while P2 plays on: J or Enter (pad 1: X / A) spends a shared continue.
    addEventListener('keydown', e => { if (p1Out && !e.repeat && (e.code === 'KeyJ' || e.code === 'Enter' || e.code === 'KeyL')) onPress('p1continue'); });
    addEventListener('blur', () => { for (const k of Object.keys(keys)) keys[k] = false; });
  }
  // Pad 2: gamepad.js publishes its read as window.__ppGamepad.pad2.
  function pollPad() {
    let st = null;
    try { st = typeof window !== 'undefined' && window.__ppGamepad ? window.__ppGamepad.pad2 : null; } catch (_) { st = null; }
    if (opts.pad2) st = opts.pad2();
    pad = st || { buttons: [], dirs: {} };
    const b = pad.buttons || [], d = pad.dirs || {};
    const edge = i => b[i] && !padPrev[i];
    if (edge(P2_PAD.START)) onPress('start');
    for (const dir of ['left', 'right']) if (d[dir] && !padDirPrev[dir]) onPress(dir);
    if (edge(P2_PAD.X)) onPress('punch');
    if (edge(P2_PAD.B)) onPress('kick');
    if (edge(P2_PAD.A)) onPress('jump');
    if (edge(P2_PAD.LB)) { onPress('punch'); onPress('kick'); }
    if (edge(P2_PAD.RB)) { onPress('punch'); onPress('jump'); }
    if (edge(P2_PAD.LT) || edge(P2_PAD.RT)) onPress('dash');
    padPrev = b.slice(); padDirPrev = { ...d };
  }
  const dirX = () => ((keys[P2_KEYS.right] || pad.dirs.right) ? 1 : 0) - ((keys[P2_KEYS.left] || pad.dirs.left) ? 1 : 0);
  const dirY = () => ((keys[P2_KEYS.down] || pad.dirs.down) ? 1 : 0) - ((keys[P2_KEYS.up] || pad.dirs.up) ? 1 : 0);
  const throwing = () => !!(keys[P2_KEYS.throw] || (pad.buttons || [])[P2_PAD.Y]);

  // ---- simulation ----------------------------------------------------------
  // New run (new state object): carry a joined P2 over with a fresh body.
  function adopt(s) {
    if (owner === s) return;
    const had = joined && (ready || v);
    owner = s; v = null; picking = false; p1Out = false; handed = false; pool = COOP.continues; revive1 = 0; seenCont = s.continues | 0;
    if (had && s.walkLevel !== undefined) {
      const id = heroAt(pick).id !== s.selectedHero ? heroAt(pick).id : heroAt(nextFree(pick)).id;
      spawnP2(s, id);
    }
  }
  // Each enemy targets one player: the nearer one, unless that player already
  // has two more attackers than the other. Sticky for ~1 s so they don't dither.
  function assign(s, dt) {
    const p1 = s.player, p2 = v.player;
    const p1Ok = !s.over && !p1Out, p2Ok = !v.over && !(v.playerDown > 0.5);
    const live = s.ninjas.filter(n => !n.dead && !n.scripted);
    const count = { 1: 0, 2: 0 };
    for (const n of live) if (n.coopT) count[n.coopT]++;
    for (const n of live) {
      if (n.coopRe > 0) n.coopRe -= dt;
      let want;
      if (!p2Ok) want = 1; else if (!p1Ok) want = 2;
      else {
        if (n.atk || (n.coopT && n.coopRe > 0)) continue;
        const d1 = Math.abs(n.x - p1.x) + Math.abs(n.y - p1.y) * 2, d2 = Math.abs(n.x - p2.x) + Math.abs(n.y - p2.y) * 2;
        want = d2 < d1 ? 2 : 1;
        const other = want === 1 ? 2 : 1;
        if (count[want] - (n.coopT === want ? 1 : 0) > count[other] + 1 && Math.abs(d1 - d2) < 420) want = other;
      }
      if (n.coopT !== want) { if (n.coopT) count[n.coopT]--; count[want]++; if (n.coopT && !n.atk) n.token = false; n.coopT = want; }
      n.coopRe = COOP.retarget[0] + rand() * (COOP.retarget[1] - COOP.retarget[0]);
    }
  }
  // Co-op enemy scaling: every second fresh spawn gets a twin.
  function scale(s) {
    for (const n of s.ninjas.slice()) {
      if (seen.has(n)) continue; seen.add(n);
      if (n.dead || n.scripted || n.boss || n.levelBoss || n.xs || n.coopExtra || !EXTRA_KINDS.has(n.kind)) continue;
      if (++extraN % COOP.extraEvery) continue;
      const t = { ...n, coopExtra: true, x: n.x + (n.vx > 0 ? -56 : 56), y: n.y + (n.y > 400 ? -16 : 16), token: false, atk: null, move: null, phase: null, coopT: 0, __rigId: undefined, stun: 0, down: 0, z: 0 };
      seen.add(t); s.ninjas.push(t); stats.extras++;
    }
  }
  function pickups(s) {
    const p = v.player;
    for (const pw of s.powerups) {
      if (pw.dead || Math.abs(pw.x - p.x) > (pw.r || 10) + p.r || Math.abs(pw.y - p.y) > (pw.r || 10) + 16) continue;
      pw.dead = true;
      if (pw.type === 'life') healPlayer(v, 40);
      else if (pw.type === 'rapid') v.rapidTimer = Math.max(v.rapidTimer, 10 + s.wave);
      else if (pw.type === 'spread') v.spreadTimer = Math.max(v.spreadTimer, 15 + s.wave);
      else if (pw.type === 'shield') v.player.shield = true;
      else if (pw.type === 'weapon') { v.weaponLevel = Math.min(5, v.weaponLevel + 1); v.weaponDurability = Math.max(v.weaponDurability || 0, 24 * v.weaponLevel); }
      else if (pw.type === 'score') v.score += 350 * s.wave;
    }
  }

  // P1 out of lives while P2 is still up: no game over; P1 lies down until a
  // shared continue (J / Enter) or a revive. Both out: hand over to the normal
  // continue screen (screens.js) by leaving state.over set.
  function checkOut(s) {
    // baba_booey (t_72c55578c7774b62): a continue taken on that screen (screens.js bumps s.continues)
    // is shared even when the double KO landed where checkOut never saw s.over (game.js's
    // top-of-step game-over catch), so the hand-off was never latched and P2 stayed at 0 lives.
    if ((s.continues | 0) !== seenCont) { seenCont = s.continues | 0; if (!s.over) handed = true; }
    if (handed) { if (!s.over) { handed = false; pool = COOP.continues; if (v && v.over) continueP2(s, true); } return; }
    if (!v) return;
    if (s.over && !p1Out && !s.runComplete) { if (v.over) { handed = true; return; } p1Out = true; s.over = false; s.lives = 0; s.hp = 0; cont1 = 0; revive1 = 0; }
    if (p1Out && v.over) { p1Out = false; s.lives = 0; s.over = true; handed = true; }
  }
  function continueP1(s) {
    if (!p1Out) return false;
    if (pool <= 0) return false; pool--;
    Object.assign(s, { over: false, lives: COOP.lives, hp: s.maxHp || 100, invuln: 2, playerDown: 0, hurtT: 0 });
    p1Out = false; stats.continues++; return true;
  }
  function holdP1(s, dt) { // P1's body stays down while out
    s.playerDown = Math.max(s.playerDown || 0, 0.3); s.invuln = Math.max(s.invuln || 0, 0.5); cont1 += dt;
    const near = Math.abs(s.player.x - v.player.x) < COOP.reviveR && Math.abs(s.player.y - v.player.y) < COOP.reviveR * 0.6 && !v.over;
    revive1 = near ? revive1 + dt : Math.max(0, revive1 - dt * 2);
    if (revive1 >= COOP.reviveT) { Object.assign(s, { lives: 1, hp: Math.round((s.maxHp || 100) * COOP.reviveHp), invuln: 2, playerDown: 0.6 }); p1Out = false; revive1 = 0; stats.revives++; }
  }

  // Player slice: what a system means by "the player". coop.as() swaps P2's
  // slice into the shared state around one system step (bosses, the new enemy
  // types), so those systems fight whichever player is the valid nearest target.
  const SLICE = ['player', 'combat', 'hp', 'maxHp', 'lives', 'invuln', 'playerDown', 'hurtT', 'hpHit', 'combo', 'comboTimer', 'score', 'over', 'selectedHero', 'taunt'];
  function swap(s) { for (const k of SLICE) { const a = s[k]; s[k] = v[k]; v[k] = a; } }
  const ENTS = { boss: n => n.boss || n.levelBoss, ext: n => !!n.xs };
  function targetFor(s, sys) {
    const ok1 = !p1Out && !s.over, ok2 = !v.over && !benched(s);
    if (!ok2) return 1; if (!ok1) return 2;
    const ents = s.ninjas.filter(n => !n.dead && (ENTS[sys] || (() => false))(n));
    if (!ents.length) return tgt[sys] || 1;
    const d = p => Math.min(...ents.map(n => Math.abs(n.x - p.x) + Math.abs(n.y - p.y) * 2));
    const d1 = d(s.player) + (v.playerDown > 0 ? 0 : 0), d2 = d(v.player);
    const cur = tgt[sys] || 1;
    // Hysteresis: only switch when the other player is clearly nearer, or the current one is down.
    const curDown = cur === 1 ? s.playerDown > 0.5 : v.playerDown > 0.5;
    if (curDown) return cur === 1 ? 2 : 1;
    if (cur === 1 && d2 < d1 - 90) return 2;
    if (cur === 2 && d1 < d2 - 90) return 1;
    return cur;
  }
  function as(s, sys, fn) {
    if (!v || owner !== s || benched(s) || s.over) return fn();
    const t = targetFor(s, sys); tgt[sys] = t;
    if (t !== 2) return fn();
    swap(s); try { return fn(); } finally { swap(s); }
  }

  // P2's own pizzas: flown and scored here, so P2 gets the credit.
  function stepPizzas(s, dt) {
    for (const z of v.pizzas) {
      z.x += z.vx * dt; z.y += (z.vy || 0) * dt;
      if (z.dead) continue;
      for (const n of s.ninjas) {
        if (n.dead || !(Math.abs(z.x - n.x) < z.r + hurtR(n) * 0.55 && Math.abs(z.y - n.y) <= 14 + z.r)) continue;
        z.dead = !z.piercing; damageNinja(v, n, v.weaponLevel - 1);
        if (z.dead) break;
      }
    }
    v.pizzas = v.pizzas.filter(z => !z.dead && Math.abs(z.x - (z.x0 ?? z.x)) < 380);
  }
  // Hazards that check "the player" in their own module: P2 gets the same rule.
  function hazards(s) {
    const p = v.player, lv = s.level | 0;
    if (lv === SUBWAY_LEVEL_INDEX && s.subway) {
      for (const h of s.subway.hz) {
        if (h.warn > 0 || h.p2done || Math.abs(h.x - p.x) >= HAZARD.hitRange) continue;
        h.p2done = true;
        const safe = h.kind === 'low' ? (p.z || 0) > HAZARD.lowClearZ : p.duck;
        if (!safe && !(v.invuln > 0)) { damagePlayer(v, HAZARD.dmg, { x: h.x + 40, knockdown: true }); h.hitP2 = true; }
      }
    }
    if (lv === HARBOR_LEVEL_INDEX && s.harbor) {
      for (const d of s.harbor.drops || []) {
        if (!d.landed || d.p2done) continue; d.p2done = true;
        if (Math.abs(p.x - d.x) <= CRANE.radius + p.r && Math.abs(p.y - d.y) <= CRANE.depth + 6 && !((p.z || 0) > 20)) { if (damagePlayer(v, CRANE.dmg, { knockdown: true, x: d.x })) d.hitP2 = true; }
      }
    }
  }
  // Breakable drops go to whoever picks them up (breakables.js publishes its list).
  function collect(s) {
    let br = opts.breakables; try { if (!br && typeof window !== 'undefined') br = window.__ppBreak; } catch (_) {}
    const list = br && br.pickups; if (!list) return;
    const p = v.player;
    for (const k of list) {
      if (k.got || !(k.t > 0.35) || (k.z || 0) >= 12 || Math.abs(k.x - p.x) >= 30 || Math.abs(k.y - p.y) >= 26) continue;
      k.got = true; k.byP2 = true; stats.p2Pickups = (stats.p2Pickups || 0) + 1;
      const d = PICKUPS[k.type] || {};
      if (d.heal) healPlayer(v, d.heal); if (d.score) v.score += d.score;
      if (opts.audio) try { opts.audio.play(d.heal ? 'life' : 'pickup'); } catch (_) {}
    }
  }

  // After P1's combatStep, before the world update.
  function step(s, dt) {
    pollPad();
    if (selecting()) return; // the select screen simulates an attract state underneath
    if (!joined && !v) { if (owner !== s) owner = s; return; }
    adopt(s);
    if (!v) return;
    checkOut(s);
    if (s.wave !== lastWave || s.level !== lastLevel) { // new level: regroup next to P1
      lastWave = s.wave; lastLevel = s.level;
      v.player.x = Math.max(40, s.player.x - 60); v.player.y = s.player.y; v.player.level = s.level; v.pizzas = [];
      if (v.combat) { v.combat.airborne = false; v.combat.jumpZ = 0; v.player.z = 0; }
    }
    if (benched(s) || handed) return;
    if (p1Out) holdP1(s, dt);
    if (v.over) { // out of lives: continue (shared pool), or a revive from P1 standing close
      cont += dt;
      const near = Math.abs(s.player.x - v.player.x) < COOP.reviveR && Math.abs(s.player.y - v.player.y) < COOP.reviveR * 0.6 && !s.over && !p1Out;
      revive = near ? revive + dt : Math.max(0, revive - dt * 2);
      if (revive >= COOP.reviveT) { Object.assign(v, { over: false, lives: 1, hp: Math.round(v.maxHp * COOP.reviveHp), invuln: 2, playerDown: 0.6 }); revive = 0; cont = 0; stats.revives++; }
      return;
    }
    if (!skating(s)) scale(s);
    assign(s, dt);
    // P2's timers (update() only ticks P1's).
    v.invuln = Math.max(0, v.invuln - dt); v.comboTimer = Math.max(0, v.comboTimer - dt); if (v.comboTimer === 0) v.combo = 0;
    v.rapidTimer = Math.max(0, v.rapidTimer - dt); v.spreadTimer = Math.max(0, v.spreadTimer - dt); if (v.taunt > 0) v.taunt = Math.max(0, v.taunt - dt);
    const before = v.hp + v.lives * 1000;
    if (skating(s)) v.player.x += (s.scrollSpeed || 0) * dt; // P2 rides a board alongside the scroll
    if (!(v.combat.hitStop > 0)) combatWalk(v, dirX(), dirY(), dt);
    v.player.duck = (s.level | 0) === SUBWAY_LEVEL_INDEX && dirY() > 0 && !v.combat.airborne && !((v.player.z || 0) > 2);
    combatStep(v, dt);                 // P2's own half (combat.js returns before the shared enemy half)
    enemyAI(v, dt);                    // the enemies targeting P2, with P2's own token pool
    throwCd -= dt;
    if (throwing() && throwCd <= 0) {
      throwPizza(v);
      if (opts.audio) try { opts.audio.play('throw'); } catch (_) {}
      throwCd = Math.max(0.1, (v.rapidTimer > 0 ? 0.16 : 0.3) - (v.weaponLevel - 1) * 0.025);
    }
    stepPizzas(s, dt);
    pickups(s);
    if (v.hp + v.lives * 1000 < before) { stats.p2Hits++; if (opts.audio) try { opts.audio.play('hurt'); } catch (_) {} }
    if (v.over) { cont = 0; revive = 0; }
    checkOut(s);
  }

  // After the world step: shared camera on the midpoint, both players kept on
  // screen (the leader is held back rather than dragging the other along).
  function after(s, dt) {
    if (!active() || owner !== s) return;
    checkOut(s);
    if (benched(s) || handed) return;
    if (!v.over) { hazards(s); collect(s); }
    checkOut(s);
    if (handed) return;
    const lv = LEVELS[s.level | 0], width = (lv && lv.width) || WORLD_W, M = COOP.margin, Wd = LW;
    const p1 = s.player, p2 = v.player, both = !v.over;
    if (skating(s)) { const cam = s.cameraX || 0; p2.x = Math.max(cam + M, Math.min(cam + Wd - M, p2.x)); return; }
    const ev = s.events && s.events.camX != null ? Math.max(0, Math.min(width - Wd, s.events.camX - Wd / 2)) : null;
    // baba_booey (t_9ec48322f6de4bf7): logic.js owns the camera (spring + eased framing). Co-op hands it the
    // midpoint as the focus for the next frame (smoothed there) instead of setting/snapping s.cameraX here;
    // holds (ev) blend in through events.camX the same way. Players are then held inside the shown camera.
    if (both) s.camFocusX = (p1.x + p2.x) / 2;
    const cam = Math.max(0, Math.min(width - Wd, Number.isFinite(s.cameraX) ? s.cameraX : 0));
    void ev; coopCam = cam;
    const clampX = p => { p.x = Math.max(cam + M, Math.min(cam + Wd - M, p.x)); };
    if (both) { clampX(p1); clampX(p2); }
    const lk = s.events && s.events.lock;
    if (lk) p2.x = Math.max(lk.L + 30, Math.min(lk.R - 30, p2.x));
  }

  // ---- drawing -------------------------------------------------------------
  function tag(ctx, p, label, color) {
    const x = p.x, y = p.y - (p.z || 0) - 128;
    ctx.save(); ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 15, y - 12, 30, 15);
    if (label.length > 2) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 32, y - 12, 64, 15); }
    ctx.fillStyle = color; ctx.fillText(label, x, y); ctx.beginPath(); ctx.moveTo(x - 5, y + 4); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x, y + 9); ctx.fill(); ctx.restore();
  }
  // World space, right after P1 (game.js translate(-camX)).
  function drawWorld(ctx, s, animT, dt) {
    if (!active() || owner !== s || benched(s)) return;
    const p = v.player, c = v.combat;
    drawShots(ctx, v, img);
    for (const z of v.pizzas) { if (img) { const h = z.r * 3.2, w2 = h * img.width / img.height; ctx.save(); ctx.translate(z.x, z.y - 55); ctx.rotate(animT * 14 + z.x * 0.02); ctx.drawImage(img, -w2 / 2, -h / 2, w2, h); ctx.restore(); } else { ctx.fillStyle = '#e8b04a'; ctx.beginPath(); ctx.arc(z.x, z.y - 55, z.r, 0, 7); ctx.fill(); } }
    tag(ctx, s.player, p1Out ? '1P DOWN' : '1P', p1Out ? '#ff6b6b' : '#ffe86b');
    if (p1Out && revive1 > 0) { ctx.save(); ctx.strokeStyle = '#ffe86b'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(s.player.x, s.player.y - 30, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (revive1 / COOP.reviveT)); ctx.stroke(); ctx.restore(); }
    if (v.over) {
      ctx.save(); ctx.globalAlpha = 0.55; ctx.translate(p.x, p.y + p.r); ctx.rotate(-Math.PI / 2 * (c.facing || 1));
      drawHero(ctx, v, 'idle', 0, 0 - p.r + 0, animT, dt, true); ctx.restore();
      if (revive > 0) { ctx.save(); ctx.strokeStyle = '#3df0ff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(p.x, p.y - 30, 22, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (revive / COOP.reviveT)); ctx.stroke(); ctx.restore(); }
      return;
    }
    if (c.airborne) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(p.x, p.y + p.r * 0.7, p.r * 0.9, p.r * 0.34, 0, 0, 7); ctx.fill(); }
    if (!(v.invuln > 0 && Math.floor(v.invuln * 10) % 2)) {
      const face = c.facing < 0 ? -1 : 1;
      const downA = v.playerDown > 0 ? Math.min(1, v.playerDown / 0.25) * (Math.PI / 2) * -face : 0;
      const y = p.y - (p.z || 0);
      if (skating(s)) drawBoard(ctx, p.x, p.y + p.r + 2, p.z || 0, face, 1.8);
      if (downA) { ctx.save(); ctx.translate(p.x, y + p.r); ctx.rotate(downA); ctx.translate(-p.x, -(y + p.r)); }
      drawHero(ctx, v, null, p.x, y, animT, dt, false);
      if (downA) ctx.restore();
    }
    tag(ctx, p, '2P', '#3df0ff');
    drawGrab(ctx, v);
  }
  function drawHero(ctx, view, forcePose, x, y, animT, dt, local) {
    if (!rig || !anim) { ctx.fillStyle = '#3df0ff'; ctx.beginPath(); ctx.arc(x, y, 16, 0, 7); ctx.fill(); return; }
    const p = view.player, c = view.combat;
    const kind = rig.heroKind(view), sc = kind === 'turtle' || kind === 'foot' ? 1.4 : 0.7;
    const pose = forcePose || rig.playerPose(view, animT);
    const a = c && c.attack;
    const info = { phase: a && !a.hold ? c.phase : null, dur: a ? (c.phase === 'wind' ? a.wind : c.phase === 'active' ? a.active : a.rec) : 0, heavy: !!(a && a.heavy), walkT: c && c.moving ? c.walkT : null, walkRate: c && c.running ? 10 : 8 };
    const angles = anim.step('p2:' + kind, pose, info, dt, animT);
    const rootY = (local ? 0 : y + p.r) - 63;
    rig.draw(ctx, kind, angles, local ? 0 : x, rootY, !!(c && c.facing < 0), sc, null, dt);
  }
  // Screen space, after the P1 card: P2's card (pipi's hud.player at 3/4 size),
  // score, continue / revive prompts and the drop-in picker.
  function drawHud(ctx, s, dt, Wd, Hd) {
    if (owner !== s) return;
    if (picking) {
      const h = heroAt(pick);
      panel(ctx, Wd - 250, 84, 238, 70);
      ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = '#3df0ff'; ctx.font = 'bold 13px monospace';
      ctx.fillText('2P JOIN: ◀ ' + h.name + ' ▶', Wd - 131, 110); ctx.fillStyle = '#dce8e0'; ctx.font = '11px monospace';
      ctx.fillText('4/6 or stick picks, 1 / Start joins', Wd - 131, 132); ctx.restore();
      return;
    }
    if (!active() || benched(s)) { if (active()) { ctx.save(); ctx.font = 'bold 12px monospace'; ctx.textAlign = 'right'; ctx.fillStyle = '#3df0ff'; ctx.fillText('2P riding along', Wd - 14, 96); ctx.restore(); } return; }
    // Wrap-up layout: P2 gets the same hero card as P1 (portrait, HP, lives, score inside the
    // card), both at 0.9x so the two cards sit side by side with the arena badge between them.
    if (hud && hud.player) {
      const k = 0.9, cw = 318 * k, ch = 134 * k, cx = Wd - 6 - cw, cy = 6;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(k, k); hud.player(ctx, v, dt, 10, 22, { score: true, tag: '2P' }); ctx.restore();
      if (v.over) {
        ctx.save(); ctx.fillStyle = 'rgba(10,12,20,0.88)'; ctx.fillRect(cx, cy, cw, ch);
        ctx.textAlign = 'center'; ctx.fillStyle = '#ff6b6b'; ctx.font = 'bold 13px monospace'; ctx.fillText('2P DOWN', cx + cw / 2, cy + 40);
        ctx.fillStyle = '#ffe86b'; ctx.font = '11px monospace'; ctx.fillText(pool > 0 ? `START: continue (${pool} left)` : 'no continues left', cx + cw / 2, cy + 62);
        ctx.fillStyle = '#9fe7ff'; ctx.fillText('or 1P stands close: revive', cx + cw / 2, cy + 80); ctx.restore();
      }
      drawP1Out(ctx);
      return;
    }
    // Fallback compact 2P strip (no hud module): hero, HP bar, lives, score.
    const x = Wd - 200, y = 82, w = 188, max = Math.max(1, v.maxHp || 100), hp = Math.max(0, v.hp || 0);
    panel(ctx, x, y, w, 44);
    ctx.save(); ctx.textAlign = 'left'; ctx.font = 'bold 11px monospace';
    ctx.fillStyle = '#3df0ff'; ctx.fillText('2P ' + (heroAt(HEROES.findIndex(h => h.id === v.selectedHero)).name || '').replace(' TURTLE', ''), x + 7, y + 14);
    ctx.textAlign = 'right'; ctx.fillStyle = '#ff4d6d'; ctx.fillText('x' + Math.max(0, v.lives || 0), x + w - 7, y + 14);
    const frac = hp / max;
    if (hud && hud.drawBar && hud.track) { try { const tr = hud.track(v, hp, max, dt); hud.drawBar(ctx, x + 7, y + 20, w - 14, 8, { frac: tr.frac, trail: tr.trail, color: frac <= 0.3 ? '#ff3b3b' : '#63f7a0', trailColor: '#ffe9a8', ticks: 10 }); } catch (_) { bar(ctx, x + 7, y + 20, w - 14, 8, frac); } }
    else bar(ctx, x + 7, y + 20, w - 14, 8, frac);
    ctx.textAlign = 'left'; ctx.fillStyle = '#dce8e0'; ctx.font = '10px monospace'; ctx.fillText('SCORE ' + String(Math.floor(v.score || 0)).padStart(6, '0'), x + 7, y + 40);
    if ((v.combo || 0) > 1) { ctx.textAlign = 'right'; ctx.fillStyle = '#ffe86b'; ctx.fillText(v.combo + 'x', x + w - 7, y + 40); }
    if (v.over) {
      ctx.fillStyle = 'rgba(10,12,20,0.88)'; ctx.fillRect(x, y, w, 44);
      ctx.textAlign = 'center'; ctx.fillStyle = '#ff6b6b'; ctx.font = 'bold 11px monospace'; ctx.fillText('2P DOWN', x + w / 2, y + 13);
      ctx.fillStyle = '#ffe86b'; ctx.font = '10px monospace';
      ctx.fillText(pool > 0 ? `START: continue (${pool} left)` : 'no continues left', x + w / 2, y + 27);
      ctx.fillStyle = '#9fe7ff'; ctx.fillText('or 1P stands close: revive', x + w / 2, y + 40);
    }
    ctx.restore();
    drawP1Out(ctx);
  }
  function drawP1Out(ctx) {
    if (p1Out) { // P1 waiting on a continue / revive
      ctx.save(); ctx.fillStyle = 'rgba(10,12,20,0.88)'; ctx.fillRect(12, 132, 300, 40); ctx.strokeStyle = '#ff6b6b'; ctx.strokeRect(12, 132, 300, 40);
      ctx.textAlign = 'center'; ctx.fillStyle = '#ff6b6b'; ctx.font = 'bold 12px monospace'; ctx.fillText('1P DOWN', 162, 147);
      ctx.fillStyle = '#ffe86b'; ctx.font = '10px monospace'; ctx.fillText(pool > 0 ? `J / ENTER: continue (${pool} left)  or 2P revive` : 'no continues left: 2P stand close to revive', 162, 164); ctx.restore();
    }
  }
  function bar(ctx, x, y, w, h, f) { ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x, y, w, h); ctx.fillStyle = f <= 0.3 ? '#ff3b3b' : '#63f7a0'; ctx.fillRect(x, y, w * Math.max(0, Math.min(1, f)), h); }
  function panel(ctx, x, y, w, h) { ctx.save(); ctx.fillStyle = 'rgba(8,18,30,0.82)'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = 'rgba(61,240,255,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); ctx.restore(); }
  // Select screen: P2's cursor on the grid (same geometry as game.js) and a join hint.
  function drawSelect(ctx, Wd, Hd) {
    pollPad();
    ctx.save(); ctx.textAlign = 'right'; ctx.font = '11px monospace';
    if (!joined) { ctx.fillStyle = 'rgba(61,240,255,0.8)'; ctx.fillText('2P: NUMPAD ENTER or PAD 2 START', Wd - 10, Hd - 4); ctx.restore(); return; }
    if (HEROES[pick] && HEROES[pick].id === (HEROES[selectIndex()] || {}).id && !ready) pick = nextFree(pick);
    const cols = 4, cellW = 170, cellH = 172, k = 0.82, sx = Wd / 2 - (cols * cellW) / 2 + cellW / 2, sy = 158;
    const cx = sx + (pick % cols) * cellW, cy = sy + Math.floor(pick / cols) * cellH;
    ctx.strokeStyle = '#3df0ff'; ctx.lineWidth = ready ? 5 : 3; ctx.setLineDash(ready ? [] : [8, 5]);
    ctx.strokeRect(cx - 66 * k, cy - 81 * k, 132 * k, 162 * k); ctx.setLineDash([]);
    ctx.fillStyle = '#3df0ff'; ctx.font = 'bold 13px monospace'; ctx.textAlign = 'center';
    { const lb = ready ? '2P READY' : '2P', ly = cy - 81 * k + 14; ctx.fillStyle = 'rgba(5,12,20,0.85)'; ctx.fillRect(cx - 40, ly - 12, 80, 16); ctx.fillStyle = '#3df0ff'; ctx.fillText(lb, cx, ly); } // wrap-up: inside the card, clear of the subtitle
    ctx.textAlign = 'right'; ctx.font = '11px monospace';
    ctx.fillText(ready ? '2P: ' + heroAt(pick).name + ' (2 / B to change)' : '2P: 4/6 pick, 1 or A confirm', Wd - 10, Hd - 4);
    ctx.restore();
  }

  const api = {
    setAnim: a => { anim = a; }, step, after, drawWorld, drawHud, drawSelect, join, continueP2, onPress, keys, stats: () => ({ ...stats }),
    leave: () => { joined = false; ready = false; picking = false; drop(owner); },
    get p2() { return v; }, get joined() { return joined; }, get ready() { return ready; }, get picking() { return picking; }, get pick() { return pick; }, set pick(i) { pick = i; },
    as, hudTwoUp: s => owner === s && active() && !benched(s), get p1Out() { return p1Out; }, get pool() { return pool; }, get handed() { return handed; }, continueP1: (s = owner) => continueP1(s), targetFor: (s, sys) => targetFor(s, sys),
    get revive() { return revive; }, get continueLeft() { return Math.max(0, COOP.continueT - cont); },
  };
  return api;
}
