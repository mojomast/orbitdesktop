// Boss fights (baba_booey): a unique OpenClaw boss per level, with HP-threshold
// phases, telegraphed attacks and a named, segmented boss bar.
//
// How it hooks in (no edits to events.js / skate.js / combat.js):
//   - events.js already spawns the gate boss of each walking level (the first
//     enemy of a `gate` trigger gets `levelBoss`, the rooftop one is kind 'boss')
//     and skate.js spawns the Claw Rider (`rider`). boss.js ADOPTS that enemy:
//     marks it `scripted` (so combat.enemyAI leaves it alone), gives it the
//     level's look (existing enemy rig via `rigKind` + `tint` + `scale`), HP and
//     phases, and drives it from here.
//   - Hits on the boss still go through combat.js (hitboxes, hit-stop, hit
//     reactions, logic.damageNinja). A poise meter decides when a heavy reaction
//     (stagger / knockdown) actually lands; otherwise it is downgraded to a flinch.
//   - Boss attacks hit through the shared box test (combat.boxHits / hurtbox)
//     and logic.damagePlayer, so player i-frames, knockdown and shields apply.
//     Every attack has a visible wind-up (ground marker / lane stripe / glow,
//     0.5-0.9 s) before its hit becomes active.
//   - The boss holds one of the enemy attack tokens while it attacks, so the
//     total number of attackers stays at combat.maxTokens().
//
// Defeat signal (for screens.js / stage clear):
//   state.bossDefeated   = { id, name, level, final, phases, t }   (last one)
//   state.bossesDefeated = count;  state.bossFight.defeated = [info, ...]
//   state.onBossDefeated(info, state)  -- called if the game sets it
//   window 'pizzapanic:bossdefeated' CustomEvent (detail = info), in browsers
import { SKATE_LEVEL, LEVELS, damagePlayer } from './logic.js';
import { hurtbox, boxHits, DEPTH, maxTokens } from './combat.js';
import { KIND_R, KIND_HP } from './events.js';
import { SUBWAY_BOSS } from './subway-data.js'; // cheese: subway boss def
import { HARBOR_BOSS } from './harbor-data.js'; // mr_india: harbor boss def
import { ARCADE_BOSS } from './arcade-data.js'; // mr_india: arcade boss def
import { OPTIONS } from './options-live.js'; // baba_booey: Reduced motion for the intro splash card

const SZ = 2, PAD = 60, VIEW_W = 740;

// Boss intro splash cards (baba_booey, t_0577948bb62442f8): one transparent comic
// bust per boss id in assets/bosses/splash/<id>.png (built by
// pizza-panic-dev/tools/make_splash.py). On adopt, a slanted name card slides in
// (a plain fade with Reduced motion), holds, and slides out. It runs on boss-fight
// time, so it waits out the bossEnter cinematic and the pause menu. ENTER, or the
// first hit on the boss, skips it. It is drawn first in drawHud, under the boss bar,
// and sits in the band between the top HUD and the bar.
export const SPLASH_DIR = 'assets/bosses/splash/';
export const SPLASH_IDS = ['enforcer', 'bruiser', 'rider', 'skytalon', 'shredclaw', 'conductor', 'hookclaw', 'highscore', 'mech'];
export const SPLASH_TIME = { in: 0.4, hold: 1.8, out: 0.35 };
export const SPLASH_BAND = { top: 162, h: 146 }; // below the top HUD + gate banner (y < 160), above the fighters and the boss bar
const splashImgs = {};
const splashImage = id => {
  if (typeof Image === 'undefined' || !SPLASH_IDS.includes(id)) return null;
  let im = splashImgs[id];
  if (!im) { im = splashImgs[id] = new Image(); im.decoding = 'async'; im.src = SPLASH_DIR + id + '.png'; }
  return im.complete && im.naturalWidth ? im : null;
};

// Attack timing. wind = telegraph (never under MIN_WIND), active = live hit
// window, rec = recovery (the punish window).
const MIN_WIND = 0.5;
export const ATTACKS = {
  swipe:  { wind: 0.6,  active: 0.14, rec: 0.55, dmg: 12, reach: 112 },
  slam:   { wind: 0.85, active: 0.16, rec: 0.75, dmg: 16, radius: 74, air: 0.6 },
  charge: { wind: 0.75, active: 0.75, rec: 0.8,  dmg: 18, speed: 600, length: 560 },
  wave:   { wind: 0.7,  active: 0.95, rec: 0.6,  dmg: 12, speed: 380 },
  volley: { wind: 0.7,  active: 0.2,  rec: 0.65, dmg: 8 },
  mines:  { wind: 0.9,  active: 0.18, rec: 0.5,  dmg: 14, radius: 48 },
  swoop:  { wind: 0.8,  active: 0.95, rec: 1.9,  dmg: 15, speed: 560 },
  // Mech walker (mech.js draws it). `as` reuses a base behaviour with its own
  // timing/damage; gatling is its own lane sweep.
  claw:     { as: 'swipe', wind: 0.75, active: 0.16, rec: 1.0, dmg: 12, reach: 150, grab: 0.55 },
  stomp:    { as: 'wave',  wind: 0.8,  active: 0.9,  rec: 0.95, dmg: 12, speed: 360 },
  gatling:  { wind: 0.85, active: 1.0, rec: 1.0, dmg: 10, speed: 700, length: 620 },
  missiles: { as: 'mines', wind: 0.95, active: 0.22, rec: 1.1, dmg: 14, radius: 46, count: 5 },
};
// Mid-level mini bosses picked by the gate's boss name (events.js t.boss.name),
// not by level: the mech walker gates the OpenClaw Tower lobby.
// weak/armor: damage taken with the cockpit open (attack recovery or a poise
// break: the punish window) vs closed.
export const MINI_BOSSES = {
  mech: { id: 'mech', name: 'CLAW WALKER', title: 'OpenClaw mech walker', rig: 'charger', mech: true, scale: 1.6, r: 30, hp: 44,
    tint: null, color: '#ff4f3a', weak: 2, armor: 0.5,
    phases: [1, 0.5], poise: [8, 9], speed: [55, 70], cd: [1.15, 0.95],
    attacks: [['claw', 'stomp', 'gatling'], ['claw', 'stomp', 'gatling', 'missiles', 'missiles']],
    moves: {}, barks: ['WEAPONS FREE. MISSILES ARMED.'], summon: { 1: ['drone', 'drone'] } },
};
export const bossByName = name => Object.values(MINI_BOSSES).find(d => d.name === name) || null;

// One boss per level index (0 sewer, 1 street, 3 skate, 2 rooftop, 4 OpenClaw Tower).
// The tower's SHREDCLAW is the final boss (kind 'boss'; screens.js ending).
// phases: HP fraction at which each phase starts. attacks: per phase.
export const BOSSES = {
  0: { id: 'enforcer', name: 'SEWER ENFORCER', title: 'sludge-fisted gatekeeper', rig: 'brawler', scale: 1.45, r: 22, hp: 44,
    tint: 'hue-rotate(75deg) saturate(1.7) brightness(0.85)', color: '#8be05a',
    phases: [1, 0.5], poise: [5, 6], speed: [75, 95], cd: [1.1, 0.85],
    attacks: [['swipe', 'slam'], ['swipe', 'slam', 'wave']],
    moves: { swipe: 'haymaker', slam: 'groundPound', wave: 'swing' },
    barks: ['Enough! Taste the SLUDGE!'] },
  1: { id: 'bruiser', name: 'CLAW BRUISER', title: 'armoured highway wrecker', rig: 'charger', scale: 1.5, r: 24, hp: 58,
    tint: 'hue-rotate(-30deg) saturate(1.8) contrast(1.1)', color: '#ff6a3d',
    phases: [1, 0.6, 0.3], poise: [5, 6, 7], speed: [70, 85, 100], cd: [1.2, 0.95, 0.75],
    attacks: [['charge', 'swipe'], ['charge', 'swipe', 'wave'], ['charge', 'charge', 'wave', 'swipe']],
    moves: { swipe: 'pound', charge: 'charge', wave: 'groundPound' },
    barks: ['Now I\u2019m warmed up!', 'FULL THROTTLE!'], summon: { 2: ['striker', 'striker'] } },
  3: { id: 'rider', name: 'CLAW RIDER', title: 'highway chase boss', rig: 'skater', scale: 1.4, r: 22, hp: 36, chase: true,
    tint: 'hue-rotate(160deg) saturate(1.9) brightness(1.05)', color: '#3de0ff',
    phases: [1, 0.5], poise: [4, 5], speed: [160, 190], cd: [1.0, 0.8],
    attacks: [['mines', 'swoop'], ['mines', 'swoop', 'volley']],
    moves: { mines: 'grabThrow', swoop: 'dashAttack', volley: 'backAttack' },
    barks: ['Drones! Box them in!'], summon: { 1: ['drone', 'drone'] } },
  2: { id: 'skytalon', name: 'SKY TALON', title: 'rooftop drone-wing assassin', rig: 'striker', scale: 1.45, r: 20, hp: 46,
    tint: 'hue-rotate(115deg) saturate(1.7) brightness(0.95)', color: '#5cffb0',
    phases: [1, 0.5], poise: [5, 6], speed: [95, 115], cd: [1.05, 0.85],
    attacks: [['swipe', 'charge'], ['swipe', 'charge', 'volley', 'slam']],
    moves: { swipe: 'flurry', charge: 'dash', volley: 'flurry', slam: 'dash' },
    barks: ['Wings out, drones IN!'], summon: { 1: ['drone', 'drone'] } },
  4: { id: 'shredclaw', name: 'SHREDCLAW', title: 'the OpenClaw overlord', rig: 'acrobat', scale: 1.55, r: 26, hp: 75, final: true,
    tint: 'hue-rotate(250deg) saturate(1.5) brightness(0.8) contrast(1.15)', color: '#c86bff',
    phases: [1, 0.66, 0.33], poise: [6, 7, 8], speed: [85, 100, 115], cd: [1.1, 0.9, 0.7],
    attacks: [['swipe', 'charge'], ['swipe', 'charge', 'slam', 'volley'], ['swipe', 'charge', 'slam', 'volley', 'wave']],
    moves: { swipe: 'spin', charge: 'dashAttack', slam: 'jumpkick', volley: 'flip', wave: 'groundPound' },
    barks: ['You dare? I installed EVERY skill!', 'New shell! Same lobster! MORE CLAWS!'], summon: { 2: ['acrobat', 'striker'] } }, // story-v2
};
if (!BOSSES[5]) BOSSES[5] = SUBWAY_BOSS; // cheese: subway (level 5) boss, THE CONDUCTOR; defined in subway-data.js
if (!BOSSES[6]) BOSSES[6] = HARBOR_BOSS; // mr_india: harbor (level 6) boss, CAPTAIN HOOKCLAW; defined in harbor-data.js
if (!BOSSES[7]) BOSSES[7] = ARCADE_BOSS; // mr_india: arcade (level 7) boss, HIGH SCORE; defined in arcade-data.js
export const bossFor = level => BOSSES[level] || BOSSES[0];

export function ensureBossFight(state) {
  if (!state.bossFight) state.bossFight = { active: null, defeated: [], log: [], flash: 0, t: 0, shown: 1, trail: 1, hold: 0, markers: [] };
  return state.bossFight;
}

const camL = state => {
  if (state.level === SKATE_LEVEL) return state.cameraX || 0;
  const lk = state.events && state.events.lock;
  return lk ? lk.L : (state.cameraX || 0);
};
const band = state => {
  const lv = LEVELS[state.level | 0] || LEVELS[0];
  const b = (lv.walkables || [])[0] || { y: 360, h: 100 };
  return { top: b.y + 6, bot: b.y + b.h - 6 };
};
const clampY = (state, y) => { const b = band(state); return Math.max(b.top, Math.min(b.bot, y)); };
const groundBox = (x0, x1, y, depth) => ({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y, depth, top: y - 10, bot: y + 60 }); // a jump (z > ~26) clears it
const bodyBox = (n, x0, x1) => ({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y: n.y, depth: DEPTH + 6, top: n.y + n.r - 63 * SZ * (n.scale || 1), bot: n.y + n.r });

export function createBosses(opts = {}) {
  const audio = opts.audio || null, fx = opts.fx || null;
  const rand = opts.rand || Math.random;
  const play = name => { try { if (audio && audio.play) audio.play(name); } catch { /* audio is optional */ } };
  let liveF = null; // fight record of the state last stepped (for the ENTER skip)
  const splashTotal = SPLASH_TIME.in + SPLASH_TIME.hold + SPLASH_TIME.out;
  function skipSplash(state) {
    const F = state ? state.bossFight : liveF, c = F && F.splash;
    if (!c || c.t >= SPLASH_TIME.in + SPLASH_TIME.hold) return false;
    c.t = Math.max(c.t, SPLASH_TIME.in + SPLASH_TIME.hold); c.skipped = true; return true;
  }
  if (opts.preloadSplash !== false && typeof window !== 'undefined') SPLASH_IDS.forEach(splashImage);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', e => { if (e.code === 'Enter' && liveF && liveF.splash && skipSplash(null)) e.preventDefault(); });
  }
  const shake = k => { if (fx) fx.shake = Math.max(fx.shake || 0, k); };
  const ring = (x, y) => { if (fx && fx.rings) fx.rings.push({ x, y, t: 0 }); };

  function log(F, ev, data) { F.log.push({ ev, t: +F.t.toFixed(3), ...data }); if (F.log.length > 2000) F.log.shift(); }
  function bark(state, n, text) {
    const e = state.events; if (!e || !e.barks || !text) return;
    e.barks.push({ who: 'enemy', text, n, t: 0, dur: Math.max(2.2, text.length * 0.06, 2.5 + 0.05 * text.length) }); // story-v2: readable
  }

  function adopt(state, n) {
    const F = ensureBossFight(state);
    const def = bossByName(n.name) || bossFor(state.level | 0);
    n.__boss = def.id; if (def.mech) n.mech = true; /* drawn by mech.js; boss + elite keep it ungrabbable */ n.scripted = true; n.boss = true; n.elite = true; n.token = false;
    n.name = def.name; n.rigKind = def.rig; n.scale = def.scale; n.r = def.r; n.tint = def.tint;
    const thresholds = def.phases.slice(1).map(f => Math.max(1, Math.round(def.hp * f)));
    const b = { def, n, hp: def.hp, maxHp: def.hp, phase: 0, thresholds, atk: null, cd: 1.0, poise: 0, poiseT: 0,
      invuln: 1.1, mode: 'intro', modeT: 1.1, last: null, phaseFlash: 0, hitT: 0 };
    n.hp = n.maxHp = b.hp + PAD; b.nhp = n.hp;
    state.boss = { id: def.id, name: def.name, level: state.level | 0 };
    if (def.chase) { n.vx = state.scrollSpeed || 0; }
    log(F, 'adopt', { id: def.id, level: state.level | 0 });
    F.splash = { id: def.id, name: def.name, title: def.title, color: def.color || '#ffb300', final: !!def.final, t: 0, skipped: false }; splashImage(def.id);
    play('boss'); shake(0.3);
    if (audio && audio.music && !def.final) { try { audio.music('boss', 0.8); } catch { /* optional */ } }
    return b;
  }

  function pad(b) { return (b.phase < b.thresholds.length || b.invuln > 0) ? PAD : 0; }

  function enterPhase(state, b) {
    const F = ensureBossFight(state), n = b.n, def = b.def;
    b.phase += 1; b.atk = null; b.poise = 0; b.mode = 'phase'; b.modeT = 1.2; b.invuln = 1.2; b.cd = 1.5; b.phaseFlash = 1;
    n.atk = null; n.move = null; n.phase = null;
    n.down = 0; n.wake = 0; n.falling = false; n.launchV = 0; n.z = 0; n.spin = 0; n.spinAngle = 0; n.juggle = false; n.stun = 0; n.react = null; n.knock = 0;
    n.vx = def.chase ? (state.scrollSpeed || 0) : 0; n.vy = 0;
    F.flash = 0.45;
    shake(0.45); ring(n.x, n.y - 40); play('boss'); play('impact');
    if (state.fxCue) state.fxCue('land', { x: n.x, y: n.y + n.r * 0.6, facing: 1 });
    bark(state, n, def.barks[b.phase - 1]);
    for (const k of (def.summon && def.summon[b.phase]) || []) summon(state, k);
    log(F, 'phase', { id: def.id, phase: b.phase + 1, hp: b.hp });
  }

  function summon(state, kind) {
    const L = camL(state), left = rand() < 0.5;
    const r = KIND_R[kind] || 14, hp = KIND_HP[kind] || 1;
    const y = clampY(state, band(state).top + 10 + rand() * (band(state).bot - band(state).top - 20));
    const m = { kind, level: state.level | 0, x: left ? L - 40 : L + VIEW_W + 40, y, r, hp, maxHp: hp, vx: left ? 80 : -80, vy: 0 };
    if (state.level === SKATE_LEVEL) { m.skate = true; m.vx = (state.scrollSpeed || 0) + (left ? 80 : -80); }
    if (kind === 'drone') { m.hover = 70; m.flying = true; }
    state.ninjas.push(m);
  }

  function defeat(state, b) {
    const F = ensureBossFight(state), def = b.def, n = b.n;
    const info = { id: def.id, name: def.name, level: state.level | 0, final: !!def.final, phases: b.phase + 1, t: +(state.t || 0).toFixed(2) };
    F.defeated.push(info); F.active = null; F.flash = 0.6;
    state.bossDefeated = info; state.bossesDefeated = F.defeated.length; state.boss = null; state.bossBar = null;
    n.tint = null;
    log(F, 'defeat', { id: def.id });
    shake(0.5); ring(n.x, n.y - 40);
    if (!def.final) { play('bossdie'); if (audio && audio.music) { try { audio.music('sewer', 1.2); } catch { /* optional */ } } }
    if (state.events && !def.final) state.events.banner = { text: def.name + ' DEFEATED', t: 0, dur: 2.2 };
    if (typeof state.onBossDefeated === 'function') { try { state.onBossDefeated(info, state); } catch (err) { console.error(err); } }
    if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent !== 'undefined') { try { window.dispatchEvent(new CustomEvent('pizzapanic:bossdefeated', { detail: info })); } catch { /* non-browser */ } }
  }

  // Heavy reactions only land when the poise meter breaks; otherwise a hit is
  // a flinch with a short slide (the boss keeps its attack: super armour).
  function onHit(state, b, lost) {
    const n = b.n, def = b.def;
    b.poise += 1; b.poiseT = 0; b.hitT = 0.15;
    // After a break the boss is unbreakable for a few seconds (no stun-locking).
    const broke = !(b.armorT > 0) && b.poise >= def.poise[Math.min(b.phase, def.poise.length - 1)];
    if (broke) {
      b.poise = 0; b.armorT = 4; b.atk = null; b.mode = 'stagger';
      n.atk = null; n.move = null; n.phase = null;
      if (def.chase) { n.vx = state.scrollSpeed || 0; }
      log(ensureBossFight(state), 'poiseBreak', { id: def.id });
      return;
    }
    if (n.falling || n.launchV > 0 || n.down > 0 || n.react === 'knockdown' || n.react === 'launch' || n.react === 'stagger') {
      n.falling = false; n.launchV = 0; n.z = 0; n.spin = 0; n.spinAngle = 0; n.juggle = false; n.juggles = 0; n.thrown = false; n.down = 0;
      n.react = 'flinch';
    }
    n.stun = Math.min(n.stun || 0, 0.12); n.knock = (n.knock || 0) * 0.35;
  }

  function tokenSlot(state, b) {
    // The boss occupies one attack token: minion holders are capped at max-1.
    const minions = state.ninjas.filter(m => !m.dead && m !== b.n && !m.scripted);
    const holders = minions.filter(m => m.token);
    const cap = Math.max(1, maxTokens(state) - 1);
    let over = holders.length - cap;
    for (const m of holders) { if (over <= 0) break; if (!m.atk) { m.token = false; m.tokenCd = 0.8; over -= 1; } }
    if (holders.filter(m => m.token).length >= cap) for (const m of minions) if (!m.token) m.tokenCd = Math.max(m.tokenCd || 0, 0.15);
    return over <= 0;
  }

  function pick(b) {
    const list = b.def.attacks[Math.min(b.phase, b.def.attacks.length - 1)];
    let k = list[Math.floor(rand() * list.length)];
    if (k === b.last && list.length > 1) k = list[(list.indexOf(k) + 1) % list.length];
    return k;
  }

  function startAttack(state, b, name) {
    const type = ATTACKS[name].as || name, spec = { ...ATTACKS[type], ...ATTACKS[name] };
    const n = b.n, p = state.player, F = ensureBossFight(state);
    const speedUp = 1 - b.phase * 0.08;
    const a = { type, name, phase: 'wind', t: Math.max(MIN_WIND, spec.wind * speedUp), hitDone: false, face: p.x >= n.x ? 1 : -1 };
    a.wind = a.t; a.active = spec.active; a.rec = spec.rec * (1 - b.phase * 0.12);
    const L = camL(state);
    if (type === 'slam') { a.tx = Math.max(L + 50, Math.min(L + VIEW_W - 50, p.x)); a.ty = clampY(state, p.y); }
    if (type === 'charge') { a.y = n.y; a.x0 = n.x; a.x1 = Math.max(L + 40, Math.min(L + VIEW_W - 40, n.x + a.face * spec.length)); }
    if (type === 'wave') { a.x0 = n.x; a.y = n.y; }
    if (type === 'volley') {
      const b2 = band(state);
      const lanes = (b2.bot - b2.top) < 70 ? [0] : [-30, 0, 30];
      a.lanes = lanes.map(o => clampY(state, p.y + o));
    }
    if (type === 'mines') {
      const count = spec.count || (b.phase ? 3 : 2), b2 = band(state);
      a.mines = [];
      for (let i = 0; i < count; i++) {
        const sx = Math.max(60, Math.min(VIEW_W - 120, (p.x - L) + (i === 0 ? 30 : -120 + rand() * 300)));
        const y = i === 0 ? clampY(state, p.y) : b2.top + rand() * (b2.bot - b2.top);
        a.mines.push({ sx, y });
      }
    }
    if (type === 'swoop') { a.y = n.y; }
    if (type === 'gatling') { a.y = clampY(state, p.y); a.x0 = n.x + a.face * 40; a.x1 = a.x0 + a.face * spec.length; }
    b.atk = a; b.last = name;
    log(F, 'wind', { type: name, wind: +a.wind.toFixed(2) });
    play('riser');
  }

  function hitPlayer(state, b, box, dmg) {
    const p = state.player, n = b.n;
    if (!boxHits(box, p)) return false;
    const got = damagePlayer(state, dmg, { x: n.x, knockdown: dmg >= 12 });
    if (got && state.fxCue) state.fxCue('hit', { x: p.x, y: p.y - 50, heavy: true, shake: 0.25 });
    log(ensureBossFight(state), 'hit', { type: b.atk && b.atk.type, dmg: got });
    return true;
  }

  function stepAttack(state, b, dt) {
    const a = b.atk, n = b.n, p = state.player, spec = { ...ATTACKS[a.type], ...(ATTACKS[a.name] || {}) }, F = ensureBossFight(state);
    const base = b.def.chase ? (state.scrollSpeed || 0) : 0;
    const L = camL(state);
    n.face = a.face;
    a.t -= dt;
    if (a.phase === 'wind') {
      n.vx = base; n.vy = 0;
      if (a.type === 'slam' && a.t <= spec.air && !a.jumped) { a.jumped = true; n.launchV = 500 * spec.air; }
      if (a.type === 'slam' && a.jumped) { const rem = Math.max(0.05, a.t); n.vx = (a.tx - n.x) / rem; n.vy = (a.ty - n.y) / rem; }
      if (a.t <= 0) {
        a.phase = 'active'; a.t = a.active;
        log(F, 'active', { type: a.type });
        if (a.type === 'swipe') { const nx = n.x + a.face * 16; n.x = nx; play('swingHeavy'); }
        if (a.type === 'slam') { n.x = a.tx; n.y = a.ty; n.z = 0; n.launchV = 0; n.vx = 0; n.vy = 0; shake(0.32); ring(a.tx, a.ty); play('impact'); if (state.fxCue) state.fxCue('land', { x: a.tx, y: a.ty + 10, facing: 1 }); }
        if (a.type === 'charge') play('whoosh');
        if (a.type === 'wave') { shake(0.25); play('thunder'); }
        if (a.type === 'swoop') play('whoosh');
        if (a.type === 'mines') play('impact');
        if (a.type === 'gatling') { play('warn'); shake(0.12); }
        if (a.type === 'volley') {
          state.enemyShots = state.enemyShots || [];
          for (const y of a.lanes) state.enemyShots.push({ x: n.x + a.face * 30, y: y - 18 * SZ, vx: a.face * 300 + base, r: 8, dmg: spec.dmg, t: 0, kind: 'thrower', boss: b.def.id });
          play('throw');
        }
      }
    } else if (a.phase === 'active') {
      n.vx = base; n.vy = 0;
      const reachX = spec.reach || 0;
      if (a.type === 'swipe' && !a.hitDone) {
        const x0 = n.x + a.face * n.r * SZ * 0.2, x1 = n.x + a.face * reachX * (n.scale || 1) / 1.45;
        a.hitDone = hitPlayer(state, b, bodyBox(n, x0, x1), spec.dmg);
        if (a.hitDone && spec.grab) { a.grabT = spec.grab; log(F, 'grab', {}); } // claw grab: reel the hero in
      }
      if (a.grabT > 0) {
        a.grabT -= dt; const hx = n.x + a.face * 70;
        p.x += (hx - p.x) * Math.min(1, dt * 10); p.y += (n.y - p.y) * Math.min(1, dt * 6);
        if (a.t <= 0 && a.grabT > 0) a.t = 0.001; // hold the active phase until the hero is dropped
        if (a.grabT <= 0) { state.player.knockFrom = a.face; shake(0.2); }
      }
      if (a.type === 'gatling') {
        // The sweep front runs down the lane; the hero is hit once if still in it.
        const d = Math.min(spec.length, (a.active - a.t) * spec.speed);
        if (!a.hitDone) a.hitDone = hitPlayer(state, b, { x0: Math.min(a.x0, a.x0 + a.face * d), x1: Math.max(a.x0, a.x0 + a.face * d), y: a.y, depth: DEPTH, top: a.y - 63 * SZ, bot: a.y + 20 }, spec.dmg);
        if (Math.floor(a.t * 30) % 3 === 0) shake(0.05);
      }
      if (a.type === 'slam' && !a.hitDone) a.hitDone = hitPlayer(state, b, groundBox(a.tx - spec.radius, a.tx + spec.radius, a.ty, spec.radius * 0.4), spec.dmg);
      if (a.type === 'charge') {
        const done = (a.face > 0 ? n.x >= a.x1 - 10 : n.x <= a.x1 + 10);
        n.vx = done ? 0 : a.face * spec.speed;
        if (!a.hitDone) a.hitDone = hitPlayer(state, b, bodyBox(n, n.x - 38, n.x + 38), spec.dmg);
        if (done) a.t = Math.min(a.t, 0);
      }
      if (a.type === 'wave' && !a.hitDone) {
        const d = (a.active - a.t) * spec.speed;
        for (const fx0 of [a.x0 - d, a.x0 + d]) if (!a.hitDone) a.hitDone = hitPlayer(state, b, groundBox(fx0 - 18, fx0 + 18, a.y, 30), spec.dmg);
      }
      if (a.type === 'mines' && !a.hitDone) {
        for (const m of a.mines) if (!a.hitDone) a.hitDone = hitPlayer(state, b, groundBox(L + m.sx - spec.radius, L + m.sx + spec.radius, m.y, 20), spec.dmg);
      }
      if (a.type === 'swoop') {
        const sx = n.x - L, done = sx <= 70;
        n.vx = done ? base : base - spec.speed;
        if (!a.hitDone) a.hitDone = hitPlayer(state, b, bodyBox(n, n.x - 40, n.x + 40), spec.dmg);
        if (done) a.t = Math.min(a.t, 0);
      }
      if (a.t <= 0) { a.phase = 'recover'; a.t = a.rec; n.vx = base; }
    } else {
      n.vx = base; n.vy = 0;
      if (a.t <= 0) {
        b.atk = null; n.atk = null; n.move = null; n.phase = null;
        const cd = b.def.cd[Math.min(b.phase, b.def.cd.length - 1)];
        b.cd = cd * (0.85 + rand() * 0.4);
        log(F, 'recover', { type: a.name || a.type });
        return;
      }
    }
    // Rig pose: <rig>_<move>_<phase>
    n.move = b.def.moves[a.name || a.type] || null;
    n.phase = a.phase;
    n.atk = { phase: a.phase, t: a.t, dur: a.phase === 'wind' ? a.wind : a.phase === 'active' ? a.active : a.rec };
  }

  function stepIdle(state, b, dt) {
    const n = b.n, p = state.player, def = b.def;
    const base = def.chase ? (state.scrollSpeed || 0) : 0;
    const sp = def.speed[Math.min(b.phase, def.speed.length - 1)];
    const L = camL(state);
    // Pressured at close range (being comboed): answer with a close attack, quickly.
    if (b.hitT > 0 && !def.chase && Math.abs(p.x - n.x) < 120) { const list = def.attacks[Math.min(b.phase, def.attacks.length - 1)]; const close = list.find(k => k === 'swipe' || k === 'wave' || k === 'claw' || k === 'stomp'); if (close && b.next !== close) { b.next = close; b.cd = Math.min(b.cd, 0.35); } }
    if (!b.next) b.next = pick(b);
    const name = b.next, type = ATTACKS[name].as || name, spec = { ...ATTACKS[type], ...ATTACKS[name] };
    n.face = p.x >= n.x ? 1 : -1;
    let tx, ty = p.y, ready = false;
    const dx = p.x - n.x, dy = p.y - n.y, side = dx > 0 ? -1 : 1;
    if (def.chase) {
      // Chase boss: rides ahead near the right edge, keeping pace with the scroll.
      tx = L + (type === 'swoop' ? VIEW_W - 130 : VIEW_W - 150); ty = type === 'mines' ? clampY(state, (band(state).top + band(state).bot) / 2) : p.y;
      ready = Math.abs(n.x - tx) < 40 && (type !== 'swoop' || Math.abs(dy) < 18);
    } else if (type === 'swipe') {
      tx = p.x + side * (spec.reach * 0.7); ready = Math.abs(dx) < spec.reach * 0.85 && Math.abs(dx) > 30 && Math.abs(dy) < DEPTH - 2;
    } else if (type === 'charge') {
      tx = p.x + side * 260; ready = Math.abs(dy) < 10 && Math.abs(dx) > 150;
    } else if (type === 'wave') {
      tx = p.x + side * 200; ready = Math.abs(dx) < 300 && Math.abs(dy) < 30;
    } else if (type === 'slam') {
      tx = p.x + side * 180; ready = Math.abs(dx) < 360;
    } else if (type === 'gatling') {
      tx = p.x + side * 260; ready = Math.abs(dx) > 140 && Math.abs(dx) < 560;
    } else if (type === 'mines') {
      tx = p.x + side * 240; ready = Math.abs(dx) < 520;
    } else { // volley
      tx = p.x + side * 260; ready = Math.abs(dx) > 150 && Math.abs(dx) < 520;
    }
    ty = clampY(state, ty);
    const ex = tx - n.x, ey = ty - n.y, d = Math.hypot(ex, ey);
    const k = d > 6 ? Math.min(sp, d * 4) / d : 0;
    n.vx = base + ex * k; n.vy = ey * k * 0.8;
    b.cd -= dt;
    const fair = !(state.playerDown > 0) && !(state.over);
    if (ready && b.cd <= 0 && fair && tokenSlot(state, b)) { b.next = null; n.vx = base; n.vy = 0; startAttack(state, b, name); }
  }

  function step(state, dt) {
    const F = ensureBossFight(state);
    F.t += dt;
    if (F.flash > 0) F.flash = Math.max(0, F.flash - dt);
    liveF = F;
    if (F.splash) { F.splash.t += dt; if (F.splash.t >= splashTotal) F.splash = null; }
    let b = F.active;
    if (!b) {
      const n = state.ninjas.find(m => !m.dead && !m.__boss && (m.levelBoss || m.rider || m.kind === 'boss'));
      if (n) b = F.active = adopt(state, n);
    }
    if (!b) return null;
    const n = b.n;
    if (b.phaseFlash > 0) b.phaseFlash = Math.max(0, b.phaseFlash - dt * 1.4);
    if (b.hitT > 0) b.hitT = Math.max(0, b.hitT - dt);
    if (b.armorT > 0) b.armorT = Math.max(0, b.armorT - dt);
    if (b.invuln > 0) b.invuln = Math.max(0, b.invuln - dt);
    // Damage accounting: logic.damageNinja lowered n.hp; boss.js owns the real HP.
    const lost = b.nhp - n.hp;
    if (lost > 0 && F.splash) skipSplash(state); // first hit clears the intro card
    if (lost > 0) {
      if (b.invuln > 0) {
        n.hp = b.nhp; if (n.dead) { n.dead = false; if (!state.ninjas.includes(n)) state.ninjas.push(n); }
        n.falling = false; n.launchV = 0; n.z = 0; n.down = 0; n.stun = 0; n.react = null; n.knock = 0;
      } else {
        // Mech: armour plating halves damage; the open cockpit (attack recovery
        // or a poise break) takes double: the punish window.
        const open = b.def.mech && ((b.atk && b.atk.phase === 'recover') || b.mode === 'stagger');
        const dealt = b.def.mech ? lost * (open ? b.def.weak : b.def.armor) : lost;
        if (b.def.mech) log(F, open ? 'weakHit' : 'armorHit', { lost, dealt });
        b.hp = Math.max(0, b.hp - dealt);
        if (b.phase < b.thresholds.length && b.hp <= b.thresholds[b.phase]) {
          b.hp = b.thresholds[b.phase];
          if (n.dead) { n.dead = false; if (!state.ninjas.includes(n)) state.ninjas.push(n); }
          enterPhase(state, b);
        } else if (b.hp > 0) onHit(state, b, lost);
      }
    }
    if (n.dead || b.hp <= 0) {
      if (b.hp > 0) { n.dead = false; if (!state.ninjas.includes(n)) state.ninjas.push(n); } // never skip a phase
      else { if (!n.dead) n.dead = true; defeat(state, b); return null; }
    }
    n.hp = b.hp + pad(b); n.maxHp = Math.max(n.maxHp || 0, n.hp); b.nhp = n.hp;
    // Plain summary for other HUDs (hud.js): numeric fight phase, not the rig's n.phase ('wind'/'active').
    state.bossBar = { id: b.def.id, name: b.def.name, title: b.def.title, phase: b.phase + 1, phases: b.def.phases.length, hp: b.hp, maxHp: b.maxHp, thresholds: b.thresholds.slice(), invuln: b.invuln > 0, drawnBy: 'boss.js' };
    if (b.def.mech) { b.weakOpen = (b.atk && b.atk.phase === 'recover') || b.mode === 'stagger'; state.bossBar.weak = b.weakOpen; state.bossBar.hp = Math.ceil(b.hp); n.weakOpen = b.weakOpen; n.mechAtk = b.atk ? { name: b.atk.name || b.atk.type, phase: b.atk.phase, t: b.atk.t, wind: b.atk.wind, active: b.atk.active, rec: b.atk.rec, grab: b.atk.grabT > 0 } : null; n.mechPhase = b.phase; }
    // Look: phase tint, white flicker while invulnerable.
    n.tint = b.invuln > 0 && Math.floor(F.t * 16) % 2 ? 'brightness(2.4) saturate(0.3)' : (b.def.tint || '') + (b.phase ? ` saturate(${1 + b.phase * 0.3})` : '') || null;
    if (b.poiseT != null) { b.poiseT += dt; if (b.poiseT > 1.6 && b.poise > 0) { b.poise -= 1; b.poiseT = 0.8; } }
    const base = b.def.chase ? (state.scrollSpeed || 0) : 0;
    if (b.mode === 'intro' || b.mode === 'phase') {
      b.modeT -= dt;
      if (b.mode === 'phase') { n.vx = base; n.vy = 0; n.move = 'groundPound'; n.phase = 'wind'; n.atk = { phase: 'wind', t: b.modeT, dur: 1.2 }; }
      else stepIdleMove(state, b);
      if (b.modeT <= 0) { b.mode = 'fight'; n.move = null; n.phase = null; n.atk = null; }
      return b;
    }
    if (b.mode === 'stagger') {
      n.vx = base; n.vy = 0;
      if (!(n.stun > 0) && !(n.down > 0) && !(n.wake > 0) && !n.falling && !((n.z || 0) > 0)) { b.mode = 'fight'; b.cd = Math.max(b.cd, 0.6); }
      return b;
    }
    if (b.atk) { tokenSlot(state, b); stepAttack(state, b, dt); return b; } // keeps holding its token slot
    // Flinches don't stop a boss (armour): only a real knockdown / wake-up does.
    if (n.down > 0 || n.wake > 0 || n.falling) { n.vx = base; n.vy = 0; return b; }
    stepIdle(state, b, dt);
    return b;
  }
  function stepIdleMove(state, b) {
    // Intro: walk (or ride) into view toward the hero, no attacks yet.
    const n = b.n, p = state.player, base = b.def.chase ? (state.scrollSpeed || 0) : 0, L = camL(state);
    const tx = b.def.chase ? L + VIEW_W - 150 : p.x + (n.x > p.x ? 1 : -1) * 220;
    const ex = tx - n.x; n.vx = base + Math.sign(ex) * Math.min(Math.abs(ex) * 3, 120); n.vy = 0; n.face = p.x >= n.x ? 1 : -1;
  }

  // ---- drawing (world space: call inside the camera transform, before actors)
  function drawWorld(ctx, state, t = 0) {
    const F = state.bossFight, b = F && F.active;
    if (!b) return;
    const n = b.n, a = b.atk, col = b.def.color, L = camL(state);
    ctx.save();
    const pulse = 0.5 + 0.5 * Math.sin(t * 22);
    const lane = (x0, x1, y, depth, k) => {
      const xa = Math.min(x0, x1), w = Math.abs(x1 - x0);
      ctx.fillStyle = `rgba(255,40,40,${0.16 + 0.22 * pulse})`; ctx.fillRect(xa, y - depth, w, depth * 2 + 10);
      ctx.fillStyle = `rgba(255,220,60,${0.35 + 0.4 * pulse})`; ctx.fillRect(xa, y - depth, w * k, 3); ctx.fillRect(xa, y + depth + 7, w * k, 3);
      ctx.strokeStyle = `rgba(255,240,120,${0.6 + 0.4 * pulse})`; ctx.lineWidth = 3;
      const dir = x1 >= x0 ? 1 : -1;
      for (let x = x0 + dir * 30; dir > 0 ? x < x1 : x > x1; x += dir * 60) { ctx.beginPath(); ctx.moveTo(x - dir * 10, y - 4); ctx.lineTo(x + dir * 6, y + 5); ctx.lineTo(x - dir * 10, y + 14); ctx.stroke(); }
    };
    const disc = (x, y, rx, ry, k) => {
      ctx.fillStyle = `rgba(255,40,40,${0.18 + 0.25 * pulse})`; ctx.beginPath(); ctx.ellipse(x, y + 8, rx, ry, 0, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(255,200,50,${0.35 + 0.3 * pulse})`; ctx.beginPath(); ctx.ellipse(x, y + 8, rx * k, ry * k, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = `rgba(255,240,140,${0.7 + 0.3 * pulse})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(x, y + 8, rx, ry, 0, 0, 7); ctx.stroke();
      ctx.fillStyle = '#fff3a0'; ctx.font = 'bold 18px monospace'; ctx.textAlign = 'center'; ctx.fillText('!', x, y + 14);
    };
    // Telegraph glow on the boss during a wind-up, white shield ring while invulnerable.
    const cy = n.y + n.r - (n.z || 0) - 60 * (n.scale || 1);
    if (a && a.phase === 'wind') {
      const k = 1 - a.t / a.wind;
      const g = ctx.createRadialGradient(n.x, cy, 4, n.x, cy, 70 + 30 * k);
      g.addColorStop(0, `rgba(255,255,255,${0.35 + 0.35 * pulse})`); g.addColorStop(0.4, col + 'aa'); g.addColorStop(1, col + '00');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, cy, 100, 0, 7); ctx.fill();
      if (a.type === 'swipe') { const r = ATTACKS.swipe.reach * (n.scale || 1) / 1.45; lane(n.x + a.face * n.r * SZ * 0.2, n.x + a.face * r, n.y, DEPTH + 6, k); }
      if (a.type === 'slam') disc(a.tx, a.ty, ATTACKS.slam.radius, ATTACKS.slam.radius * 0.4, k);
      if (a.type === 'charge') lane(n.x, a.x1, a.y, DEPTH + 6, k);
      if (a.type === 'wave') { const r = ATTACKS.wave.speed * a.active; lane(a.x0, a.x0 - r, a.y, 24, k); lane(a.x0, a.x0 + r, a.y, 24, k); }
      if (a.type === 'volley') for (const y of a.lanes) lane(n.x, n.x + a.face * 520, y, 10, k);
      if (a.type === 'mines') for (const m of a.mines) {
        disc(L + m.sx, m.y, ATTACKS.mines.radius, 20, k);
        const by = m.y - 220 * (1 - k); // claw bomb dropping onto its marker
        ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(L + m.sx, by, 9, 0, 7); ctx.fill();
        ctx.fillStyle = pulse > 0.5 ? '#ff3b3b' : '#ffe14d'; ctx.beginPath(); ctx.arc(L + m.sx, by - 9, 3, 0, 7); ctx.fill();
      }
      if (a.type === 'swoop') lane(L + VIEW_W - 20, L + 60, a.y, DEPTH + 6, k);
      if (a.type === 'gatling') lane(a.x0, a.x1, a.y, DEPTH, k);
    }
    if (a && a.phase === 'active') {
      if (a.type === 'gatling') { // tracer fire sweeping down the lane
        const d = Math.min(ATTACKS.gatling.length, (a.active - a.t) * ATTACKS.gatling.speed), xe = a.x0 + a.face * d;
        ctx.strokeStyle = 'rgba(255,230,120,0.85)'; ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) { const yy = a.y - 30 * SZ + ((i * 7 + Math.floor(t * 60)) % 13) - 6; ctx.beginPath(); ctx.moveTo(a.x0, yy); ctx.lineTo(xe - a.face * (i * 23 % 60), yy + ((i % 3) - 1) * 4); ctx.stroke(); }
        ctx.fillStyle = 'rgba(255,200,60,0.6)'; ctx.beginPath(); ctx.ellipse(xe, a.y + 8, 22, 9, 0, 0, 7); ctx.fill();
      }
      if (a.type === 'wave') {
        const d = (a.active - a.t) * ATTACKS.wave.speed;
        for (const x of [a.x0 - d, a.x0 + d]) { ctx.strokeStyle = col; ctx.lineWidth = 6; ctx.beginPath(); ctx.ellipse(x, a.y + 8, 18, 26, 0, 0, 7); ctx.stroke(); ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x - 4, a.y - 40, 8, 50); }
      }
      if (a.type === 'mines') for (const m of a.mines) { ctx.fillStyle = 'rgba(255,170,40,0.75)'; ctx.beginPath(); ctx.arc(L + m.sx, m.y, ATTACKS.mines.radius, 0, 7); ctx.fill(); }
      if (a.type === 'slam') { ctx.strokeStyle = 'rgba(255,230,140,0.9)'; ctx.lineWidth = 5; ctx.beginPath(); ctx.ellipse(a.tx, a.ty + 8, ATTACKS.slam.radius, ATTACKS.slam.radius * 0.4, 0, 0, 7); ctx.stroke(); }
    }
    if (b.invuln > 0) {
      ctx.strokeStyle = `rgba(255,255,255,${0.4 + 0.5 * pulse})`; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.ellipse(n.x, cy, 52 * (n.scale || 1), 78 * (n.scale || 1), 0, 0, 7); ctx.stroke();
    }
    ctx.restore();
  }

  // ---- HUD: named boss bar at the bottom, segmented at the phase thresholds.
  // ---- intro splash card (screen space, drawn before the boss bar)
  function drawSplash(ctx, F, W) {
    const c = F && F.splash; if (!c) return false;
    const T = SPLASH_TIME, kIn = Math.min(1, c.t / T.in), kOut = Math.max(0, Math.min(1, (c.t - T.in - T.hold) / T.out));
    const ease = k => 1 - Math.pow(1 - k, 3), reduced = !!(OPTIONS && OPTIONS.reducedMotion);
    const alpha = reduced ? Math.min(kIn, 1 - kOut) : 1 - kOut * kOut * 0.5;
    const dx = reduced ? 0 : (1 - ease(kIn)) * (W + 60) - ease(kOut) * (W + 60);
    const y = SPLASH_BAND.top, h = SPLASH_BAND.h, sl = 34;
    c.drawn = { alpha: +alpha.toFixed(3), dx: Math.round(dx), reduced, img: false };
    if (alpha <= 0.01) return true;
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.translate(Math.round(dx), 0);
    const panel = () => { ctx.beginPath(); ctx.moveTo(sl, y); ctx.lineTo(W + 4, y); ctx.lineTo(W + 4 - sl, y + h); ctx.lineTo(-4, y + h); ctx.closePath(); };
    const g = ctx.createLinearGradient(0, y, 0, y + h); g.addColorStop(0, 'rgba(26,14,34,0.92)'); g.addColorStop(1, 'rgba(10,6,14,0.94)');
    panel(); ctx.fillStyle = g; ctx.fill();
    ctx.save(); panel(); ctx.clip(); // speed lines + boss-colour stripe, inside the panel
    ctx.globalAlpha = alpha * 0.14; ctx.fillStyle = c.color;
    for (let i = 0; i < 7; i++) ctx.fillRect(0, y + 12 + i * 20, W, 3);
    ctx.globalAlpha = alpha; ctx.fillRect(0, y + h - 9, W, 9);
    ctx.restore();
    // portrait: bottom on the panel's lower edge, head breaking out above the band
    const im = splashImage(c.id); let pw = 0;
    if (im) {
      const ph = h + 14, s = ph / im.naturalHeight; pw = Math.round(im.naturalWidth * s);
      const px = W - pw - 18 + (reduced ? 0 : Math.round((1 - ease(kIn)) * 60));
      ctx.save(); ctx.beginPath(); ctx.rect(-10, y - 16, W + 20, h + 16 - 9); ctx.clip();
      ctx.drawImage(im, px, y + h - 9 - ph, pw, ph); ctx.restore(); c.drawn.img = true;
    }
    panel(); ctx.lineJoin = 'round'; ctx.lineWidth = 5; ctx.strokeStyle = '#120a16'; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke();
    // name + title, sized to the room left of the portrait
    const tx = 30, maxW = Math.max(180, W - (pw ? pw * 0.82 : 0) - tx - 24);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = 'bold 13px monospace'; ctx.fillStyle = c.color;
    const tag = c.final ? 'FINAL BOSS' : 'BOSS'; ctx.fillText(tag, tx + 8, y + 24);
    ctx.font = '11px monospace'; ctx.fillStyle = 'rgba(241,233,255,0.6)'; ctx.fillText('ENTER skip', tx + 8 + (c.final ? 96 : 50), y + 24);
    let fs = 40; ctx.font = `900 ${fs}px Impact, "Arial Black", sans-serif`;
    while (fs > 18 && ctx.measureText(c.name).width > maxW) { fs -= 2; ctx.font = `900 ${fs}px Impact, "Arial Black", sans-serif`; }
    // name + title sit low in the panel, under the boss's speech bubble
    const ny = y + h - 44;
    ctx.lineWidth = 6; ctx.strokeStyle = '#120a16'; ctx.strokeText(c.name, tx, ny);
    ctx.fillStyle = '#ffe86b'; ctx.fillText(c.name, tx, ny);
    ctx.font = 'bold 15px monospace'; ctx.lineWidth = 4; ctx.strokeText(c.title, tx + 2, ny + 22);
    ctx.fillStyle = '#f1e9ff'; ctx.fillText(c.title, tx + 2, ny + 22);
    ctx.restore(); ctx.textAlign = 'left';
    return true;
  }

  function drawHud(ctx, state, dt, W, H) {
    const F = state.bossFight, b = F && F.active;
    if (F && F.flash > 0) { ctx.save(); ctx.fillStyle = `rgba(255,255,255,${Math.min(0.55, F.flash)})`; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    drawSplash(ctx, F, W);
    if (!b) return false;
    const def = b.def, frac = b.hp / b.maxHp;
    if (frac < F.trail) { if (F.lastFrac == null || frac < F.lastFrac) F.hold = 0.5; } else F.trail = frac;
    F.lastFrac = frac;
    F.shown += (frac - F.shown) * Math.min(1, dt * 12);
    if (F.hold > 0) F.hold -= dt; else F.trail = Math.max(frac, F.trail - dt * 0.6);
    const w = Math.round(W * 0.62), x = Math.round((W - w) / 2), y = H - 46, h = 14; // bottom: the top band belongs to the hero/score HUD
    const nPh = def.phases.length;
    const phaseCols = [def.color, '#ffb300', '#ff3b3b'];
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 6, y - 22, w + 12, h + 30);
    ctx.font = 'bold 15px monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#ffe86b';
    ctx.fillText(def.name, x, y - 6);
    const nameW = ctx.measureText(def.name).width;
    ctx.font = '11px monospace'; ctx.fillStyle = '#c9d6cc';
    ctx.fillText(def.title, x + nameW + 10, y - 6);
    ctx.textAlign = 'right'; ctx.font = 'bold 12px monospace';
    ctx.fillStyle = b.phaseFlash > 0 && Math.floor(F.t * 10) % 2 ? '#fff' : phaseCols[Math.min(b.phase, 2)];
    ctx.fillText(nPh > 1 ? `PHASE ${b.phase + 1}/${nPh}` : '', x + w, y - 6);
    ctx.fillStyle = '#2a0f12'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffe9a8'; ctx.fillRect(x, y, w * Math.max(F.trail, F.shown), h);
    ctx.fillStyle = b.invuln > 0 && Math.floor(F.t * 14) % 2 ? '#ffffff' : phaseCols[Math.min(b.phase, 2)];
    ctx.fillRect(x, y, w * Math.max(0, F.shown), h);
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(x, y, w * Math.max(0, F.shown), 4);
    // Phase segments: notched dividers at each threshold.
    for (const th of b.thresholds) {
      const sx = x + w * (th / b.maxHp);
      ctx.fillStyle = '#000'; ctx.fillRect(sx - 2, y - 3, 4, h + 6);
      ctx.fillStyle = '#ffe86b'; ctx.beginPath(); ctx.moveTo(sx - 5, y - 5); ctx.lineTo(sx + 5, y - 5); ctx.lineTo(sx, y + 1); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = b.phaseFlash > 0 ? `rgba(255,255,255,${b.phaseFlash})` : 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2; ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
    ctx.restore();
    ctx.textAlign = 'left';
    return true;
  }

  function info(state) {
    const F = state.bossFight, b = F && F.active;
    return { active: b ? { id: b.def.id, name: b.def.name, hp: b.hp, maxHp: b.maxHp, phase: b.phase + 1, phases: b.def.phases.length, mode: b.mode, attack: b.atk ? { type: b.atk.type, phase: b.atk.phase } : null, invuln: b.invuln } : null,
      defeated: F ? F.defeated.slice() : [], log: F ? F.log.slice(-40) : [] };
  }

  return { step, drawWorld, drawHud, drawSplash, skipSplash, splashLoaded: () => SPLASH_IDS.filter(i => splashImgs[i] && splashImgs[i].complete && splashImgs[i].naturalWidth), splash: state => (state.bossFight && state.bossFight.splash) || null, info, BOSSES, ATTACKS };
}
