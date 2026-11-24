import './asset-retry.js'; // mr_india: failed images retry until they load (render-bug fix); must stay the first import
import { W, H, createState, spawnWave, movePlayer, throwPizza, update, SKATE_LEVEL } from './logic.js';
import { stepSkate, drawObstacles, drawBoard, drawDrone, drawShots, skateImages } from './skate.js';
import { createHud } from './hud.js';
import { drawOffscreenIndicators } from './offscreen.js';import { createMoveList } from './move-list.js';import { createTouchControls } from './touch-controls.js';
import { createParallax } from './parallax.js';
import { createPause } from './pause.js';
import { createAmbient } from './ambient.js';
import { createAnim } from './anim.js';
import { attackBox, hurtbox, DEPTH } from './combat.js';
import { createAudio, levelMusic } from './audio.js';
import { createFX } from './fx.js';
import { OPTIONS } from './options-live.js';
import { createCinematics } from './cinematics.js';
import { createTitle } from './title.js';
import { createCombat, combatTap, combatPress, combatStep, combatWalk, combatInfo, inHitStop, combatDash } from './combat.js';
import { drawGrab } from './grab.js';
import { WORLD_W } from './collision.js';
import { HEROES, heroFor } from './heroes.js';
import { drawCineSpeaker } from './don.js'; // baba_booey: registers Don Piedro (8th hero) + his cinematic portrait chip
import { createRig, POSES } from './rig.js';
import { tintFor, createPaletteStore } from './palettes.js';
import { createProps } from './props.js';
import { createImpacts } from './impacts.js';
import { ensureEvents, stepEvents, drawEventOverlay } from './events.js';
import { createBreakables } from './breakables.js'; // dolan: smashable props + pickups
import { createAssist } from './assist.js'; // dolan: team-up super meter + Nous gang assist
import { createBonus } from './bonus.js'; // dolan: pizza delivery bonus stage
import { createShop } from './shop.js'; // dolan: between-stage shop (pizza coins)
import { createSubway } from './subway.js'; // cheese: subway train level
import { createHarbor } from './harbor.js'; // mr_india: harbor docks level
import { createArcade } from './arcade.js'; // mr_india: arcade interior level
import { createDrones } from './drones.js'; // mr_india: OpenClaw hover-drone packs
import { createCheckpoint } from './save.js'; // mr_india: stage checkpoint save + CONTINUE
import { createStyle } from './style.js'; // mr_india: combo counter + per-stage STYLE grade
import { createCoach } from './coach.js'; // mr_india: first-run coach marks
import { createWipe } from './wipe.js'; const wipe = createWipe(); // mr_india: claw stage wipe (t_96f516de1275486c), overlay only
import { createWorldMap } from './worldmap.js'; const worldmap = createWorldMap({ audio: { play: n => audio.play(n) } }); // baba_booey: world map interstitial between stages (t_5f5d1eed411041b2)
import { createAmbFx } from './amb-fx.js'; const ambfx = createAmbFx(); // mr_india: animated level ambience in the back layers (t_dd91539751db48a4)
import { createBosses } from './boss.js'; // baba_booey: unique boss per level (phases, telegraphs, boss bar)
import { createEnemiesExt } from './enemies-ext.js'; // baba_booey: claw ninja, shield brute, flamethrower bot
import { createTower } from './tower.js';
import { drawMech } from './mech.js'; // baba_booey: mech walker mini boss part rig
import { createScreens } from './screens.js';
import { pollGamepad } from './gamepad.js'; // cheese: pad -> same key events as the keyboard
import { createCoop } from './coop.js'; // cheese: local 2-player co-op
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
cv.width = W; cv.height = H;
const keys = {}; let s = createState(), paused = false, last = 0, cd = 0, heartCd = 0;
// Exposed for live verification and debugging (see window.__ppAudio.stats).
const audio = createAudio(); window.__ppAudio = audio;
const fx = createFX(); window.__ppFx = fx;
const cinema = createCinematics(audio); window.__ppCinema = cinema;
const title = createTitle(audio); window.__ppTitle = title; // arcade attract sequence (iteration 8)
const rig = createRig(); window.__ppRig = rig; window.__ppPoses = POSES; // pose table, for live verification
// Alternate palettes: a filter over the hero's rig draw, so no extra art is needed.
const paletteStore = createPaletteStore(); window.__ppPalettes = paletteStore;
const progressRecord = s => ({ stagesCleared: s.stagesCleared || s.wave - 1 || 0, coins: s.coins || 0, bonusRuns: s.bonusRuns || 0, assists: s.assists || 0, bestCombo: s.bestCombo || s.combo || 0, noDamageClears: s.noDamageClears || 0 });
let selectedHero = 'turtle_blue', selecting = false, selectIndex = 0;
let selectedDifficulty = 'normal';
try { selectedDifficulty = (localStorage.getItem('pizzaDifficulty') || 'normal'); } catch { /* sandboxed storage throws SecurityError */ }
const SELECT_COLS = 4;
// Select-screen keyboard map; returns the new index, or null when the key is not navigation.
function selectNav(code, i) {
  const n = HEROES.length, row = Math.floor(i / SELECT_COLS), col = i % SELECT_COLS, rows = Math.ceil(n / SELECT_COLS);
  if (/^Digit[1-9]$/.test(code)) { const k = Number(code.slice(5)) - 1; return k < n ? k : i; }
  if (code === 'ArrowLeft' || code === 'KeyA') return (i - 1 + n) % n;
  if (code === 'ArrowRight' || code === 'KeyD') return (i + 1) % n;
  if (code === 'ArrowUp' || code === 'KeyW' || code === 'ArrowDown' || code === 'KeyS') {
    const r = (row + ((code === 'ArrowUp' || code === 'KeyW') ? rows - 1 : 1)) % rows;
    const inRow = Math.min(SELECT_COLS, n - r * SELECT_COLS);
    const offset = (SELECT_COLS - inRow) / 2; // short rows are centred, so keep the column visually
    return r * SELECT_COLS + Math.max(0, Math.min(inRow - 1, Math.round(col - offset)));
  }
  return null;
}
window.__ppSelect = { get index() { return selectIndex; }, get active() { return selecting; }, get hero() { return selectedHero; }, nav: selectNav };
const props = createProps(); window.__ppProps = props;
const impacts = createImpacts(); window.__ppImpacts = impacts;
const breakables = createBreakables({ audio }); window.__ppBreak = breakables;
const assist = createAssist({ audio }); window.__ppAssist = assist; // dolan: team-up assist
const shop = createShop({ audio }); window.__ppShop = shop; // dolan: between-stage shop (owns input + screen while open)
const bonus = createBonus({ audio, onDone: st => shop.open(st) }); window.__ppBonus = bonus; // dolan: bonus stage (owns input + screen while active); the shop follows it
const subway = createSubway({ rig, audio }); window.__ppSubway = subway; // cheese: subway
const harbor = createHarbor({ audio, fx }); window.__ppHarbor = harbor; // mr_india: harbor
const arcade = createArcade({ audio, fx }); window.__ppArcade = arcade; // mr_india: arcade
const drones = createDrones({ audio, fx }); window.__ppDrones = drones; // mr_india: hover-drone packs
const bosses = createBosses({ audio, fx }); window.__ppBoss = bosses; // defeat signal: state.bossDefeated / state.onBossDefeated
const extEnemies = createEnemiesExt({ audio, fx }); window.__ppExt = extEnemies;
const tower = createTower({ audio, fx }); window.__ppTower = tower; // OpenClaw Tower: elevator ride + atmosphere
const hud = createHud(); window.__ppHud = hud;
const moveList = createMoveList(); window.__ppMoves = moveList;
const coop = createCoop({ rig, anim: null, hud, audio, selecting: () => selecting, selectIndex: () => selectIndex, playing: () => started && !paused && !selecting && !cinema.isActive() && !title.isActive() && !screens.active() && !pause.isOpen() }); window.__ppCoop = coop; // cheese: co-op (anim set below)
const parallax = createParallax(); window.__ppParallax = parallax;
const ambient = createAmbient(); window.__ppAmbient = ambient;
const pause = createPause(W, H, { audio, fx, defaults: { musicVolume: 0.82, sfxVolume: 0.95, shakeEnabled: true } }); window.__ppPause = pause;
const anim = createAnim(); window.__ppAnim = anim;
coop.setAnim(anim); // cheese: co-op P2 uses the same animator
// Stage clear / continue / ending + credits (screens.js). Quit returns to the title.
const screens = createScreens({ audio, onClearClose: (n, d) => { if (n === 2 && bonus.start(s)) return; shop.open(s, { level: d && d.level }); }, onQuit: () => { paused = false; pause.close(); title.start(() => { selecting = true; cineFade = 0.4; }); } }); window.__ppScreens = screens; // dolan: bonus stage after the 2nd stage clear
// The rig's root is the torso pivot and its feet sit ~45px below that, so the
// root is placed above the entity's feet line. Scaled to match the old sprites.
// Iteration 7: characters are 2x. Hero/enemy parts were re-sliced at torso 68px,
// so they draw at RIG_SCALE 0.7 (~126px tall). The legacy assets/rig parts
// (turtle_purple, foot) have no source sheet and draw at 2x RIG_SCALE instead.
const RIG_SCALE = 0.7, FEET_SCREEN = 63, LEGACY_RIG = new Set(['turtle', 'foot']); // turtle_purple re-sliced in iteration 8
const rigScale = kind => (LEGACY_RIG.has(kind) ? RIG_SCALE * 2 : RIG_SCALE);
const DEBUG = /[?&]debug=1/.test(location.search);
window.__ppCombat = null;
// Melee move names -> cues, so combat.js never needs to know about audio.
function setAudioCue(state) {
  state.audioCue = (name) => {
    if (name === 'whiff') return audio.play('whiff');
    if (name === 'melee') return audio.play('melee');
    if (name === 'heavy') return audio.play('heavy');
    if (name === 'jump') return audio.play('jump');
    if (name === 'grab') return audio.play('grab');
    if (name === 'block') return audio.play('block');
    if (name === 'pause') return audio.play('parry'); // combat sends 'pause' for a parry
    if (name === 'thud') return audio.play('impact');
    if (state.combat && state.combat.attack && state.combat.attack.cost) return audio.play('special'); // health-cost desperation special
    if (name === 'kick' || name === 'jumpkick') return audio.play('kick');
    if (name === 'finisher') return audio.play('swingHeavy');
    return audio.play('swing');
  };
}
// Each enemy type has its own rig and its own blend key, so fifteen enemies on
// screen still read as individuals. Unknown kinds fall back to the foot ninja.
const ENEMY_RIG_KINDS = new Set(['brawler', 'striker', 'blocker', 'thrower', 'charger', 'acrobat', 'skater']);
// Iteration 8: the legacy foot-ninja rig is retired. Older kinds map onto the
// segmented types; the overlord boss is a scaled-up charger.
const LEGACY_KIND = { foot: 'striker', runner: 'acrobat', trooper: 'blocker', elite: 'brawler', boss: 'charger' };
const enemyRigKind = n => (n && n.rigKind && ENEMY_RIG_KINDS.has(n.rigKind) ? n.rigKind : n && ENEMY_RIG_KINDS.has(n.kind) ? n.kind : (n && LEGACY_KIND[n.kind]) || 'brawler');
const GRUNT_SKIN = { 6: 'brawler_harbor', 7: 'brawler_arcade', 4: 'brawler_tower' }; const skinKind = (k, lvl) => { const v = k === 'brawler' && GRUNT_SKIN[lvl]; return v && rig.ready(v) ? v : k; }; // mr_india: per-level grunt reskins (harbor/arcade/tower), default brawler until loaded
window.__ppBossKind = 'charger';

function initCombat(state) {
  const c = createCombat(state);
  state.hpMode = true; // health bar rules (logic.damagePlayer); lives become continues
  setAudioCue(state);
  ensureEvents(state);
  // Scripted-event presentation: each beat gets its own sound, shake and dust.
  state.eventCue = (type, data) => {
    const at = { x: data.x || 0, y: (data.y || 0) + 40, facing: 1 };
    if (type === 'doorBurst') { audio.play('impact'); audio.play('swingHeavy'); fx.shake = Math.max(fx.shake, 0.34 * OPTIONS.shakeScale); impacts.onEvent('dust', at); }
    else if (type === 'dropIn') { audio.play('whoosh'); audio.play('impact'); fx.shake = Math.max(fx.shake, 0.28 * OPTIONS.shakeScale); impacts.onEvent('dust', at); }
    else if (type === 'ambush') { audio.play('thunder'); fx.shake = Math.max(fx.shake, 0.2 * OPTIONS.shakeScale); }
    else if (type === 'miniBoss') { audio.play('sting'); audio.play('boss'); audio.music('miniboss', 0.4); fx.shake = Math.max(fx.shake, 0.4 * OPTIONS.shakeScale); fx.rings.push({ x: at.x, y: at.y, t: 0 }); }
    else if (type === 'setpiece') audio.play('chime');
  };
  // Impact feedback owned by the render side: shake + shockwave on hits, plus
  // MR.INDIA's hit sprites from the same event.
  state.fxCue = (name, data) => {
    impacts.onEvent(name, data || {});
    if (name !== 'hit') return;
    fx.shake = Math.max(fx.shake, (data && data.heavy ? 0.24 : 0.13) * OPTIONS.shakeScale);
    if (data && data.heavy) fx.rings.push({ x: data.x, y: data.y, t: 0 });
  };
  window.__ppCombat = c;
  return c;
}
initCombat(s);
window.__ppEvents = () => (s.events ? { fired: s.events.firedCount, log: s.events.log.slice(), line: s.events.line ? s.events.line.text : null, camX: s.events.camX } : null);
// Orbit serves apps from a sandboxed (opaque) origin, so localStorage throws
// SecurityError there. Persist the high score when we can, keep it in memory otherwise.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* no storage in sandboxed apps */ } },
};
let hi = +(store.get('pizzaPanicHi') || 0);
const style = createStyle(); window.__ppStyle = style; // mr_india: combo/style tracking
const coach = createCoach({ store }); window.__ppCoach = coach; // mr_india: first-run coach marks (guarded store + memory)
const checkpoint = createCheckpoint({ store }); window.__ppSave = checkpoint; // mr_india: checkpoint save (guarded store + memory fallback)
spawnWave(s);
window.__ppState = s;
// Sounds are driven by diffing game state between frames, so gameplay changes in
// logic.js never have to know about audio.
let prev = { score: s.score, lives: s.lives, wave: s.wave, over: s.over };
let prevBossAlive = false, bossDefeats = 0, endingQueued = false, started = false, lastStepPhase = 0, cineFade = 0;
addEventListener('keydown', e => {
  audio.unlock(); // first key press starts the AudioContext
  if (cinema.isActive()) {
    // Escape skips the whole cinematic; any other key finishes the line being
    // typed, and a second press advances to the next line.
    if (e.code === 'KeyM') { audio.toggle(); return; }
    if (e.code === 'Escape') { e.preventDefault(); cinema.skip(); return; }
    if (!e.repeat && !/^(Shift|Control|Alt|Meta)/.test(e.code)) { e.preventDefault(); cinema.advance(); }
    return;
  }
  if (!started) {
    // First key unlocks audio and starts the arcade attract sequence.
    audio.unlock();
    started = true;
    e.preventDefault();
    title.start(() => { selecting = true; cineFade = 0.4; });
    return;
  }
  if (title.isActive()) {
    if (e.code === 'KeyM') { audio.toggle(); return; }
    e.preventDefault();
    if (e.repeat || /^(Shift|Control|Alt|Meta)/.test(e.code)) return;
    // Esc skips to the finished title; any other key finishes the narration line,
    // then advances a beat; once PRESS START shows, a press starts the game.
    if (title.ready() && checkpoint.has()) { const act = checkpoint.menuKey(e); if (act === 'continue') { const d = checkpoint.load() || {}; selectedDifficulty = d.difficulty || selectedDifficulty; selectIndex = Math.max(0, HEROES.findIndex(h => h.id === d.hero)); title.press(); dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); } else if (act === 'new') title.press(); return; } // mr_india: CONTINUE / NEW GAME / CLEAR SAVE
    if (e.code === 'Escape') title.skipAll(); else title.press();
    return;
  }
  if (screens.active()) { if (screens.handleKey(e)) { e.preventDefault(); return; } }
  if (shop.active()) { if (e.code === 'KeyM') audio.toggle(); else { e.preventDefault(); shop.handleKey(e); } return; } // dolan: shop input
  if (bonus.active()) { keys[e.code] = true; if (e.code === 'KeyM') audio.toggle(); else { e.preventDefault(); bonus.handleKey(e); } return; } // dolan: bonus stage input
  if (worldmap.active()) { if (e.code === 'KeyM') audio.toggle(); else { e.preventDefault(); worldmap.handleKey(e); } return; } // baba_booey: any key skips the world map
  if (pause.isOpen()) { if (pause.handleKey(e)) { e.preventDefault && e.preventDefault(); return; } }
  if (!selecting && !paused && !cinema.isActive() && !screens.active() && coach.handleKey(e)) { e.preventDefault(); return; } // mr_india: coach marks: Enter next card, Esc skip all
  if (!paused && (e.code === 'Escape' || e.code === 'KeyP')) { paused = true; pause.open('main'); audio.play('pause'); e.preventDefault && e.preventDefault(); return; }
  if (selecting) {
    // Grid navigation (4 + 3 cards): Left/Right step through the roster, Up/Down jump
    // rows, number keys 1-7 pick directly. A/D/W/S mirror the arrows.
    const nav = selectNav(e.code, selectIndex);
    if (nav !== null) { e.preventDefault(); if (nav !== selectIndex) { selectIndex = nav; audio.play('menuMove'); } return; }
    if (e.code === 'KeyJ' || e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      selectedHero = HEROES[selectIndex].id;
      s = createState();
      s.selectedHero = selectedHero;
      s.difficulty = selectedDifficulty;
      s.difficulty = selectedDifficulty;
      s.level = 0;
      fx.reset();
      prev = { score: 0, lives: s.lives, wave: 0, over: false };
      prevBossAlive = false; bossDefeats = 0; endingQueued = false; heartCd = 0;
      initCombat(s);
      spawnWave(s);
      screens.reset(s);
      audio.play('start'); audio.play('fight'); audio.music(levelMusic(s.level), 0.8);
      window.__ppState = s;
      selecting = false;
      if (checkpoint.resume(s)) { prev.score = s.score; prev.lives = s.lives; screens.reset(s); audio.music(levelMusic(s.level), 0.8); return; } // mr_india: continue at the saved stage, skipping the intro
      coach.begin(s); // mr_india: first-run coach marks (NEW GAME only; CONTINUE returned above)
      cinema.setHero(heroFor(selectedHero).name);
      cinema.play('intro');
      return;
    }
    // mr_india (soak): Digit1-7 pick heroes in selectNav above and return first, so 1/2/3 never reached
    // difficulty: E / N / H set it instead (no other select-screen meaning).
    if (e.code === 'KeyE') { selectedDifficulty = 'easy'; try { store.set('pizzaDifficulty', selectedDifficulty); } catch { /* no persistent storage in sandboxed apps */ } }
    if (e.code === 'KeyN') { selectedDifficulty = 'normal'; try { store.set('pizzaDifficulty', selectedDifficulty); } catch { /* no persistent storage in sandboxed apps */ } }
    if (e.code === 'KeyH') { selectedDifficulty = 'hard'; try { store.set('pizzaDifficulty', selectedDifficulty); } catch { /* no persistent storage in sandboxed apps */ } }
    if (e.code === 'KeyM') audio.toggle();
    if (e.code.startsWith('Arrow')) e.preventDefault();
    return;
  }
  if (!e.repeat) { if (e.code === 'ArrowLeft' || e.code === 'KeyA') combatTap(s, -1); if (e.code === 'ArrowRight' || e.code === 'KeyD') combatTap(s, 1); }
  keys[e.code] = true;
  // First key press also starts the gameplay score (cinematics set their own).
  if (!audio.musicName) audio.music(levelMusic(s.level), 1.0);
  if (e.code === 'Space') { e.preventDefault(); if (s.over) { s = createState(); s.selectedHero = selectedHero; pause.close(); paused = false; spawnWave(s); fx.reset(); prev = { score: 0, lives: s.lives, wave: s.wave, over: false }; prevBossAlive = false; bossDefeats = 0; endingQueued = false; heartCd = 0; initCombat(s); screens.reset(s); audio.play('start'); audio.play('fight'); audio.music(levelMusic(s.level), 0.8); window.__ppState = s; } }
  // Beat 'em up melee: J punch (3-hit chain), K kick (jump kick in the air), L jump.
  // Taunt: a flex that outranks idling and nothing else.
  if (e.code === 'KeyT') { e.preventDefault(); s.taunt = 0.9; audio.play('pickup'); }
  if (e.code === 'KeyJ') { e.preventDefault(); combatPress(s, 'punch'); }
  if (e.code === 'KeyK') { e.preventDefault(); combatPress(s, 'kick'); }
  if (e.code === 'KeyL') { e.preventDefault(); combatPress(s, 'jump'); }
  // Dash / dodge roll: Shift or C. Holding a direction rolls that way, no direction
  // rolls backwards, away from whatever you are facing.
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyC') {
    e.preventDefault();
    const dir = (keys.ArrowRight || keys.KeyD) ? 1 : (keys.ArrowLeft || keys.KeyA) ? -1 : 0;
    combatDash(s, dir);
  }
  if (e.code === 'KeyF') { e.preventDefault(); moveList.toggle(selectedHero); }
  if (e.code === 'KeyU') { e.preventDefault(); if (!paused && !s.over && !screens.active() && !cinema.isActive()) assist.handleKey(e, s); } // dolan: team-up assist
  if (e.code === 'KeyM') audio.toggle();
  if (e.code === 'BracketRight') audio.nudgeVolume(0.08);
  if (e.code === 'BracketLeft') audio.nudgeVolume(-0.08);
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', e => keys[e.code] = false);
function fit() { const k = Math.min(innerWidth / W, innerHeight / H); cv.style.width = W * k + 'px'; cv.style.height = H * k + 'px'; }
addEventListener('resize', fit); fit();
const IMG = {}; for (const k of ['turtle', 'ninja', 'pizza', 'sewer']) { const im = new Image(); im.onload = () => { IMG[k] = im; }; im.src = 'assets/' + k + (k === 'sewer' ? '.jpg' : '.png'); }
const PW_ICON = {}; for (const k of ['shield', 'rapid', 'weapon']) { const im = new Image(); im.onload = () => { PW_ICON[k] = im; }; im.src = 'assets/icons/' + k + '_64.png'; } // mr_india: power-up icons (t_bb55902aff9746ff); the circles below stay as the fallback
const LVIMG = []; let camX = 0, animT = 0, rigSeq = 0; ['sewer', 'street', 'rooftop'].forEach((k, i) => { const im = new Image(); im.onload = () => { LVIMG[i] = im; }; im.src = 'assets/levels/' + k + '.jpg'; });
const heroPortraits = {};
const BOOT_ART = {}; for (const [k, f] of [['plate', 'plate.jpg'], ['logo', 'logo.png']]) { const im = new Image(); im.src = 'assets/cine/title/' + f; BOOT_ART[k] = im; }
HEROES.forEach(h => { const im = new Image(); im.src = 'assets/heroes/portraits/' + h.id + '.png'; heroPortraits[h.id] = im; });
const REACT_ATLAS = new Image(); REACT_ATLAS.src = 'assets/heroes/portraits/reactions.png'; REACT_ATLAS.onload = () => { window.__ppReactionAtlas = REACT_ATLAS; }; window.__ppReactionAtlas = REACT_ATLAS;
// Verification hook: the camera is otherwise module-private.
Object.defineProperty(window, '__ppCamX', { get: () => camX });
function spr(im, x, y, h) { const w = h * im.width / im.height; ctx.drawImage(im, x - w / 2, y - h / 2, w, h); }
function circle(x, y, r, c) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
// mr_india (render-bug fix, t_04ffd001df3944ed): every frame starts from a clean,
// cleared canvas, and every subsystem draws inside save/restore + try/catch. The
// frame used to rely on the background art covering the whole screen, so when
// that art was missing nothing cleared and every frame smeared over the last.
// A subsystem that throws is skipped for that frame (logged once, counted in
// window.__ppRenderErrors) instead of breaking the frame or stopping the loop.
const renderErrors = { count: 0, by: {} }; window.__ppRenderErrors = renderErrors;
function reportError(name, e) {
  renderErrors.count++;
  if (renderErrors.by[name]) { renderErrors.by[name].n++; return; }
  renderErrors.by[name] = { n: 1, msg: String((e && e.message) || e) };
  console.error('[pizza-panic] ' + name + ' failed, skipped so the game keeps running:', e);
}
function attempt(name, fn) { try { return fn(); } catch (e) { reportError(name, e); return undefined; } }
function guard(name, fn) { ctx.save(); try { return fn(); } catch (e) { reportError(name, e); return undefined; } finally { ctx.restore(); } }
function resetFrame() {
  if (typeof ctx.reset === 'function') ctx.reset(); // also drops any unbalanced save() stack
  else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)'; }
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
}
function draw(dt = 1 / 60) {
  fx.begin(ctx);
  // One camera, owned by logic.js: s.cameraX is derived from the level width and
  // the player each tick, so collision, camera and art share a single value. A
  // scripted beat can take the camera for a moment (ambush/door/mini-boss).
  const eventCam = s.events && s.events.camX != null
    ? Math.max(0, Math.min(WORLD_W - W, s.events.camX - W * 0.5))
    : null;
  const skating = s.level === SKATE_LEVEL;
  // baba_booey (t_9ec48322f6de4bf7): holds are blended into s.cameraX by logic.js's spring camera, so the
  // render no longer cuts to eventCam (it is only the fallback before the first camera frame).
  camX = skating ? (s.cameraX || 0) : Number.isFinite(s.cameraX) ? Math.max(0, Math.min(WORLD_W - W, s.cameraX)) : eventCam != null ? eventCam
    : Number.isFinite(s.cameraX)
      ? Math.max(0, Math.min(WORLD_W - W, s.cameraX))
      : Math.max(0, Math.min(WORLD_W - W, s.player.x - W * 0.45));
  const drewBack = guard('background', () => subway.back(ctx, s, camX, W, H, dt) || harbor.back(ctx, s, camX, W, H) || arcade.back(ctx, s, camX, W, H) || parallax.back(ctx, s.level | 0, camX, W, H)); // cheese: subway
  guard('ambient.back', () => ambient.drawBack(ctx, s.level | 0, camX, W, H, dt)); guard('tower.back', () => tower.drawBack(ctx, s, camX, W, H));  ctx.save();
  if (drewBack) guard('ambfx', () => ambfx.draw(ctx, s, camX, W, H, dt)); // mr_india: level ambience after far/mid parallax, before props and fighters
  ctx.translate(-camX, 0);
  const LV = LVIMG[((s.level | 0) % 3 + 3) % 3];
  if (drewBack) { /* parallax layers drew the level */ }
  else if (LV) { for (let x = 0; x < WORLD_W; x += LV.width) ctx.drawImage(LV, x, 0, LV.width, H); }
  else if (IMG.sewer) { for (let x = Math.floor(camX / W) * W; x < camX + W; x += W) ctx.drawImage(IMG.sewer, x, 0, W, H); } else {
  // No level art yet (still loading or retrying): cover the visible world, not just x 0..W.
  ctx.fillStyle = '#1d2b1f'; ctx.fillRect(camX, 0, W, H);
  ctx.strokeStyle = '#2c3d2e'; for (let y = 0; y < H; y += 34) for (let x = Math.floor(camX / 60) * 60 - 60 + (y / 34 % 2) * 30; x < camX + W; x += 60) ctx.strokeRect(x, y, 60, 34);
  ctx.fillStyle = '#2f8f3a'; ctx.fillRect(camX, H / 2 - 30, W, 60); }
  fx.bg(ctx, W);
  // Props stand on the floor band behind the actors (world coordinates, so they
  // scroll with the level and line up with their collision footprints).
  guard('props', () => { if (!skating) { props.draw(ctx, s.level, camX, camX + W, breakables.propMod(s.level)); breakables.draw(ctx, s, camX, camX + W); }
  else drawObstacles(ctx, s); });
  guard('subway.world', () => subway.drawWorld(ctx, s, camX, animT)); // cheese: subway signal hazards
  guard('harbor.world', () => harbor.drawWorld(ctx, s, camX, animT)); // mr_india: harbor props, crane drops
  guard('arcade.world', () => arcade.drawWorld(ctx, s, camX, animT)); // mr_india: arcade machines, smashable cabinets, tickets
  guard('impacts', () => impacts.draw(ctx));
  guard('boss.world', () => bosses.drawWorld(ctx, s, animT)); // boss telegraph markers under the actors
  guard('enemies-ext.world', () => extEnemies.drawWorld(ctx, s, animT)); // new-enemy telegraphs + burning ground
  const p = s.player;
  const pv = p.z ? { ...p, y: p.y - p.z } : p;
  guard('player', () => {
  if (s.combat && s.combat.airborne) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + p.r * 0.7, p.r * 0.9, p.r * 0.34, 0, 0, 7); ctx.fill();
  }
  if (!(s.invuln > 0 && Math.floor(s.invuln * 10) % 2)) {
    const pFace = s.combat && s.combat.facing < 0 ? -1 : 1;
    if (skating) drawBoard(ctx, p.x, p.y + p.r + 2, p.z || 0, pFace, 1.8);
    const downA = s.playerDown > 0 ? Math.min(1, s.playerDown / 0.25) * (Math.PI / 2) * -pFace : 0;
    if (downA) { ctx.save(); ctx.translate(pv.x, pv.y + pv.r); ctx.rotate(downA); ctx.translate(-pv.x, -(pv.y + pv.r)); }
    fx.player(ctx, pv, () => {
      const kind = rig.heroKind(s), c = s.combat, sc = rigScale(kind);
      const poseName = rig.playerPose(s, animT);
      const a = c && c.attack;
      const info = { phase: a && !a.hold ? c.phase : null, dur: a ? (c.phase === 'wind' ? a.wind : c.phase === 'active' ? a.active : a.rec) : 0, heavy: !!(a && a.heavy), walkT: c && c.moving ? c.walkT : null, walkRate: c && c.running ? 10 : 8 };
      const angles = anim.step('player:' + kind, poseName, info, dt, animT);
      const rootY = pv.y + pv.r - FEET_SCREEN + (poseName === 'idle' ? anim.breath(animT) : 0);
      // Mirror the whole rig around the hero's x by facing (heroes face right natively).
      const heroPalette = s.palette || paletteStore.pickedFor(kind);
      if (rig.draw(ctx, kind, angles, pv.x, rootY, !!(c && c.facing < 0), sc, null, dt, tintFor(kind, heroPalette, progressRecord(s)))) return;
      if (IMG.turtle) spr(IMG.turtle, pv.x, pv.y, pv.r * 3); else {
      circle(pv.x - 4, pv.y, pv.r, '#6b4a1e'); circle(pv.x + 6, pv.y, pv.r * .7, '#3fae3f');
      ctx.fillStyle = '#1e5fd0'; ctx.fillRect(pv.x, pv.y - 5, 18, 5); circle(pv.x + 10, pv.y - 2, 2, '#fff'); } });
    if (downA) ctx.restore();
  }
  });
  guard('coop.world', () => coop.drawWorld(ctx, s, animT, dt)); // cheese: co-op P2 (no-op until P2 joins)
  guard('shots', () => {
  for (const h of s.hazards) {
    // A warning ring while the telegraph runs: the crusher cannot hurt you yet.
    if (h.warn > 0) {
      const k = Math.min(1, h.warn / 0.65);
      ctx.strokeStyle = `rgba(255,92,92,${0.35 + 0.45 * k})`; ctx.lineWidth = 3; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.arc(h.x, h.y, h.r + 10 + 8 * k, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1;
      ctx.fillStyle = `rgba(255,225,77,${0.25 + 0.4 * k})`;
      ctx.beginPath(); ctx.arc(h.x, h.y + h.r + 26, h.r * 0.9, 0, Math.PI * 2); ctx.fill();
    }
    circle(h.x, h.y, h.r, h.warn > 0 ? '#9a5c5c' : '#ff5c5c');
    ctx.fillStyle = '#ffe14d'; ctx.fillRect(h.x - 6, h.y - 3, 12, 6);
    circle(h.x, h.y - h.r - 4, 4, 'rgba(255,255,255,0.35)');
  }
  for (const z of s.pizzas) { if (IMG.pizza) { const zz = { ...z, y: z.y - 55 }; fx.pizza(ctx, zz, () => spr(IMG.pizza, zz.x, zz.y, z.r * 3.2)); continue; } circle(z.x, z.y, z.r, '#e8b04a'); circle(z.x, z.y, z.r - 3, '#d23b2a'); circle(z.x + 2, z.y - 1, 1.5, '#fde'); }
  });
  guard('enemies', () => {
  const order = s.ninjas.slice().sort((a, b) => a.y - b.y);
  for (const n of order) { if (n.kind === 'hoverdrone') { fx.ninja(ctx, n, () => drones.draw(ctx, n, animT)); hud.enemy(ctx, n, dt); continue; } /* mr_india: hover drones */ if (n.kind === 'drone') { if (n.__rigId == null) n.__rigId = ++rigSeq; drawDrone(ctx, n, animT); continue; }
    if (n.mech) { let drew = false; fx.ninja(ctx, n, () => { drew = drawMech(ctx, n, animT); }); if (drew) continue; } // mech walker (mech.js), boss bar via boss.js
    if (n.skate) drawBoard(ctx, n.x, n.y + n.r + 2, n.z || 0, n.face || -1, 1.8 * (n.scale || 1));
    fx.ninja(ctx, n, () => {
    // The foot art faces left natively, so it only flips when one turns around.
    const nz = n.z || 0;
    const spin = (n.spinAngle || 0) + (n.down > 0 ? (Math.PI / 2) * (n.face || -1) : 0);
    if (n.__rigId == null) n.__rigId = ++rigSeq;
    if (nz || spin) { ctx.save(); if (spin) { ctx.translate(n.x, n.y - nz); ctx.rotate(spin); ctx.translate(-n.x, -(n.y - nz)); } }
    const ek = enemyRigKind(n), sc = rigScale(ek) * (n.scale || 1);
    { const tf = n.tint || (n.kind === 'boss' ? 'hue-rotate(250deg) saturate(1.3) brightness(0.9)' : null); if (tf && ctx.filter === 'none') ctx.filter = tf; } // overlord / boss.js tint (keeps the hit flash)
    const ename = rig.enemyPose(n.rigKind ? { ...n, kind: n.rigKind } : n, animT);
    const eatk = n.atk;
    const eangles = anim.step('ninja' + n.__rigId, ename, { phase: eatk ? (eatk.phase === 'recover' ? 'rec' : eatk.phase) : null, dur: eatk ? (eatk.dur || 0.3) : 0, heavy: n.kind === 'charger' || n.kind === 'boss', walkT: Math.abs(n.vx || 0) > 4 ? animT : null, walkRate: 6, seed: n.__rigId }, dt, animT);
    // Enemies face left natively: mirror when facing right.
    const drew = rig.draw(ctx, skinKind(ek, s.level), eangles, n.x, n.y - nz + n.r - FEET_SCREEN * (n.scale || 1), n.face != null ? n.face < 0 : (n.vx || 0) < -2, sc, null, dt); // enemy art faces RIGHT natively (iteration 8 audit)
    if (nz || spin) ctx.restore();
    if (drew) return;
    if (IMG.ninja) spr(IMG.ninja, n.x, n.y - nz, n.r * 3); else { circle(n.x, n.y - nz, n.r, '#2b2b35'); ctx.fillStyle = '#c62828'; ctx.fillRect(n.x - n.r, n.y - nz - 4, n.r * 2, 4); circle(n.x - 5, n.y - nz - 2, 2, '#fff'); } }); hud.enemy(ctx, n, dt); }
  for (const n of s.ninjas) if (n.kind === 'drone') hud.enemy(ctx, n, dt);
  });
  guard('skate.shots', () => drawShots(ctx, s, IMG.pizza));
  guard('enemies-ext.over', () => extEnemies.drawOver(ctx, s, animT)); // flames, shuriken, smoke over the actors
  guard('drones.over', () => drones.drawOver(ctx, s, animT)); // mr_india: drone lane telegraphs, laser bolts, explosions
  guard('grab', () => drawGrab(ctx, s)); // MR.INDIA: screen throws fly at the camera
  guard('powerups', () => {
  for (const pw of s.powerups) {
    if ((pw.age || 0) >= 12 && Math.floor(animT * 8) % 2) continue; // despawn blink
    // Pizza pickups restore health: draw them as a pizza box.
    if (pw.type === 'life' && skateImages.pizzabox) { const im = skateImages.pizzabox; ctx.drawImage(im, pw.x - 21, pw.y - 14 + Math.sin(animT * 5) * 2, 42, 25); ctx.fillStyle = '#7cff6b'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center'; ctx.fillText('+HP', pw.x, pw.y - 18); ctx.textAlign = 'left'; continue; }
    if (PW_ICON[pw.type]) { ctx.drawImage(PW_ICON[pw.type], pw.x - 15, pw.y - 15 + Math.sin(animT * 5) * 2, 30, 30); continue; } // mr_india: icon set
    const colors = { life: '#7cff6b', rapid: '#38c9ff', spread: '#ff9632', shield: '#b76fff', weapon: '#ffe14d', score: '#fff' };
    circle(pw.x, pw.y, pw.r, colors[pw.type] || '#7cff6b');
    ctx.fillStyle = '#102215'; ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center'; ctx.fillText(pw.type === 'life' ? '+' : pw.type === 'rapid' ? 'R' : pw.type === 'spread' ? '3' : pw.type === 'shield' ? 'S' : pw.type === 'weapon' ? 'W' : '$', pw.x, pw.y + 4);
    ctx.textAlign = 'left';
  }
  });
  if (DEBUG) guard('debug', drawDebug);
  ctx.restore();
  guard('ambient.front', () => ambient.drawFront(ctx, s.level | 0, camX, W, H, dt));
  guard('parallax.front', () => parallax.front(ctx, s.level | 0, camX, W, H, p.x - camX, p.y - 60));
  guard('subway.front', () => subway.front(ctx, s, camX, W, H, dt)); // cheese: subway
  guard('tower.front', () => tower.drawFront(ctx, s, W, H));
  guard('fx.over', () => fx.over(ctx, W, H));
  fx.end(ctx, W, H);
  if (!selecting && !paused && !s.over && !pause.isOpen()) drawOffscreenIndicators(ctx, s, W, H, camX);
  moveList.draw(ctx, W, H, selectedHero);
  const info = combatInfo(s);
  // Screen-space world-class HUD: the score staging runs above the playfield,
  // while the combat legend keeps the beat 'em up inputs discoverable.
  // Wrap-up: with 2P in play both hero cards sit side by side (0.9x, score inside each card),
  // the arena badge sits between them and the sound panel steps aside.
  const twoUp = !!(coop.hudTwoUp && coop.hudTwoUp(s));
  guard('hud.top', () => hud.top(ctx, s, dt, W, audio, hi, { twoUp }));
  if (!twoUp) guard('hud.status', () => hud.status(ctx, W, H, audio));
  guard('hud.controls', () => hud.controls(ctx, W, H, info));
  guard('hud.player', () => { if (twoUp) { ctx.save(); ctx.translate(6, 6); ctx.scale(0.9, 0.9); hud.player(ctx, s, dt, 10, 22, { score: true, tag: '1P' }); ctx.restore(); } else hud.player(ctx, s, dt, 12, 32); });
  guard('coop.hud', () => coop.drawHud(ctx, s, dt, W, H)); // cheese: co-op P2 card / join picker
  guard('boss.hud', () => bosses.drawHud(ctx, s, dt, W, H)); // named, phase-segmented boss bar
  if (!selecting) guard('assist', () => assist.draw(ctx, s, W, H)); // dolan: TEAM UP meter + assist cut-in
  // Controls live in the HUD footer now, where they stay out of the combat coaching bar.
  ctx.textAlign = 'center';
  if (screens.active()) { /* screens.js draws last, below */ }
  else if (s.over) fx.gameOver(ctx, W, H);
  else if (paused) { ctx.font = 'bold 40px monospace'; ctx.fillText('PAUSED', W / 2, H / 2); }
  ctx.textAlign = 'left';
  if (selecting) {
    ctx.fillStyle = 'rgba(0,0,0,0.88)'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe86b'; ctx.font = 'bold 40px monospace'; ctx.fillText('CHARACTER SELECT', W / 2, 52);
    ctx.fillStyle = '#dce8e0'; ctx.font = '13px monospace'; ctx.fillText('Left / Right changes, Enter or Space confirms, M toggles sound', W / 2, 80);
    const cols = 4, cellW = 170, cellH = 172, cardScale = 0.82; // two rows fit between the subtitle and the READY lines
    const sx = W / 2 - (cols * cellW) / 2 + cellW / 2;
    const sy = 158; // leaves room for the subtitle above the top row of cards
    HEROES.forEach((h, i) => {
      const selected = i === selectIndex;
      const cx = sx + (i % cols) * cellW;
      const cy = sy + Math.floor(i / cols) * cellH;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(cardScale, cardScale);
      if (selected) { ctx.shadowBlur = 24; ctx.shadowColor = '#ffd95e'; ctx.scale(1.06, 1.06); }
      ctx.globalAlpha = selected ? 1 : 0.56;
      const im = heroPortraits[h.id]; if (im && im.complete && im.width) ctx.drawImage(im, -60, -75, 120, 150);
      else { ctx.fillStyle = '#233628'; ctx.fillRect(-60, -75, 120, 150); ctx.fillStyle = selected ? '#ffe86b' : '#9fb8a5'; ctx.font='bold 20px monospace'; ctx.fillText('?', 0, 5); }
      ctx.shadowBlur = 0;
      ctx.strokeStyle = selected ? '#ffe86b' : '#708878'; ctx.lineWidth = selected ? 4 : 2; ctx.strokeRect(-62, -77, 124, 154);
      ctx.fillStyle = selected ? '#fff' : '#9fb8a5'; ctx.font = 'bold 13px monospace'; ctx.fillText(h.name, 0, 98);
      // Full stat line is drawn once below the grid; per-card stats overlapped neighbouring cards.
      ctx.restore();
    });
    const cur = HEROES[selectIndex];
    ctx.globalAlpha = 1; ctx.fillStyle = '#9bd6a3'; ctx.font = 'bold 15px monospace';
    ctx.fillText('READY: ' + cur.name, W / 2, H - 78); // mr_india (soak): lines re-spaced, DIFFICULTY no longer overprints START
    ctx.fillStyle = '#f5f5f5'; ctx.font = '13px monospace';
    ctx.fillText(cur.stat, W / 2, H - 60);
    ctx.fillStyle = '#9bd6a3'; ctx.font = 'bold 13px monospace';
    ctx.fillText(`DIFFICULTY: ${selectedDifficulty.toUpperCase()}  (E easy / N normal / H hard)`, W / 2, H - 40);
    ctx.fillStyle = '#ffe86b'; ctx.font = 'bold 18px monospace'; ctx.fillText('PRESS ENTER / SPACE TO START', W / 2, H - 18);
    ctx.textAlign = 'left';
    coop.drawSelect(ctx, W, H); // cheese: co-op P2 cursor + join hint
    return;
  }
  guard('arcade.post', () => arcade.post(ctx, s)); // mr_india: arcade glitch overlay (palette swap, RGB split), under dialogue/screens
  // Scripted-beat dialogue sits above everything except the game-over card.
  if (!s.over && !screens.active()) guard('events.overlay', () => drawEventOverlay(ctx, s, W, H));
  guard('screens', () => screens.draw(ctx, W, H));
  guard('style', () => style.draw(ctx, W, H, s, screens, dt)); // mr_india: live combo counter + STYLE line on the clear card
  if (!paused && !screens.active() && !cinema.isActive()) guard('coach', () => coach.draw(ctx, W, H)); // mr_india: coach marks overlay
  guard('bonus', () => bonus.draw(ctx, W, H)); // dolan: bonus stage draws over the frozen world
  shop.draw(ctx, W, H); // dolan: shop draws over the frozen world
  guard('worldmap', () => worldmap.draw(ctx, W, H, s, dt, !paused && !s.over && !screens.active() && !cinema.isActive() && !bonus.active() && !shop.active())); // baba_booey: map between stages, before the wipe
  guard('wipe', () => wipe.draw(ctx, W, H, s, dt, !paused && !s.over && !screens.active() && !cinema.isActive() && !bonus.active() && !shop.active() && !worldmap.active())); // mr_india: claw stage wipe when play resumes on a new stage
  if (pause.isOpen()) guard('pause', () => pause.draw(ctx)); // mr_india: pause menu overlay (draw call had been dropped)
}
function drawDebug() {
  ctx.save(); ctx.lineWidth = 1.5;
  const box = (x0, x1, top, bot, col) => { ctx.strokeStyle = col; ctx.strokeRect(x0, top, x1 - x0, bot - top); };
  const lane = (x0, x1, y, d, col) => { ctx.fillStyle = col; ctx.fillRect(x0, y - d, x1 - x0, d * 2); };
  for (const n of [s.player, ...s.ninjas.filter(n => !n.dead)]) { const hb = hurtbox(n); box(hb.x0, hb.x1, hb.top, hb.bot, '#3cf'); lane(hb.x0, hb.x1, n.y, 2, '#3cf'); }
  const c = s.combat;
  if (c && c.attack && !c.attack.hold) {
    const b = attackBox(s, c.attack);
    const live = c.phase === 'active';
    box(b.x0, b.x1, b.top, b.bot, live ? '#f33' : 'rgba(255,200,60,0.7)');
    lane(b.x0, b.x1, b.y, b.depth, live ? 'rgba(255,40,40,0.25)' : 'rgba(255,200,60,0.12)');
  }
  for (const sh of s.enemyShots || []) box(sh.x - sh.r, sh.x + sh.r, sh.y - sh.r, sh.y + sh.r, '#f6f');
  for (const z of s.pizzas) box(z.x - z.r, z.x + z.r, z.y - DEPTH, z.y + DEPTH, '#fa3');
  ctx.fillStyle = '#fff'; ctx.font = '10px monospace'; ctx.fillText(`facing ${c ? c.facing : '?'}  phase ${c ? c.phase : '-'}  depth +-${DEPTH}`, s.player.x - 60, s.player.y + 40);
  ctx.restore();
}
window.__ppDebug = DEBUG;
function simStep(dt) {
  if (screens.blocking()) return; // screens.js: results / continue / credits hold the world
  if (bonus.active()) return; // dolan: the bonus stage freezes the main world
  if (shop.active()) return; // dolan: the shop freezes the main world
  if (worldmap.active()) return; // baba_booey: the world map interstitial freezes the main world
  // Game over can land outside the sim step too (a cinematic callback, a debug hook).
  if (s.over && !prev.over && s.hpMode && !endingQueued && !s.runComplete) { prev.over = true; screens.gameOver(s); return; }
  if (!paused && !s.over) {
    const dx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    const dy = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
    // Impact frames: the world holds still for a few frames on a landed hit, so
    // the blow reads as weight. combatStep still runs so the stop can expire.
    const frozen = inHitStop(s);
    if (!frozen) { combatWalk(s, dx, dy, dt); stepSkate(s, dt); }
    combatStep(s, dt);
    if (frozen) return;
    coop.step(s, dt); // cheese: co-op P2 input, combat, its enemies (no-op until P2 joins)
    cd -= dt; if (keys.Space && cd <= 0) { throwPizza(s); audio.play('throw'); cd = Math.max(0.1, (s.rapidTimer > 0 ? 0.16 : 0.3) - (s.weaponLevel - 1) * 0.025); }
    const beforePowerups = s.powerups.length;
    const beforeBoost = { weaponLevel: s.weaponLevel, shield: s.player.shield, lives: s.lives };
    if (!screens.active()) screens.before(s);
    // Scripted beats run before the world steps, so spawns join this frame.
    stepEvents(s, dt);
    update(s, dt);
    if (s.taunt > 0) s.taunt = Math.max(0, s.taunt - dt);
    attempt('breakables.step', () => breakables.step(s, dt)); // dolan: prop hits, debris, pickups
    attempt('subway.step', () => subway.step(s, dt)); // cheese: subway train, stations, signal hazards
    attempt('harbor.step', () => harbor.step(s, dt)); // mr_india: harbor crane drops, wet planks, foghorn
    attempt('arcade.step', () => arcade.step(s, dt)); // mr_india: arcade cabinets, tickets, glitch timing
    attempt('drones.step', () => drones.step(s, dt)); // mr_india: hover-drone packs (swoop, dive, laser)
    attempt('bosses.step', () => coop.as(s, 'boss', () => bosses.step(s, dt))); // cheese: co-op target (coop.js) // boss AI, phases, defeat signal (after damage, before fx diff)
    if (!screens.active()) attempt('assist.step', () => assist.step(s, dt)); // dolan: team-up meter gains + assist strike
    if (!screens.active()) shop.stepWorld(s, dt); // dolan: KO coins + shop damage multiplier (hp diff, no combat.js edit)
    attempt('extEnemies.step', () => coop.as(s, 'ext', () => extEnemies.step(s, dt))); // cheese: co-op target (coop.js) // new enemy types: AI, spawns layered on event beats
    attempt('tower.step', () => tower.step(s, dt)); // OpenClaw Tower elevator ride (level 4)
    attempt('coop.after', () => coop.after(s, dt)); // cheese: co-op shared camera + screen clamp
    if (!paused) attempt('ambient.step', () => ambient.step(dt, s));
    if (!screens.active()) screens.after(s, dt);
    if (s.hpMode && !screens.active() && prev.wave >= 1 && s.wave > prev.wave && !s.over && !s.runComplete) {
      screens.stageClear(s, prev.level != null ? prev.level : 0);
    }
    if (!endingQueued && s.over && bossDefeats >= 1) { endingQueued = true; cinema.play('ending', () => { s.over = true; screens.ending(s); }); }
    fx.step(s, dt);
    attempt('impacts.step', () => impacts.step(dt));
    // Footstep puffs ride the walk cycle, one per footfall.
    const stepPhase = Math.floor((s.combat.walkT || 0) * 4);
    if (s.combat.moving && stepPhase !== lastStepPhase) {
      lastStepPhase = stepPhase;
      if (s.fxCue) s.fxCue('step', { x: s.player.x, y: s.player.y + s.player.r * 0.6, facing: s.combat.facing });
    }
    if (s.powerups.length < beforePowerups) {
      if (s.lives > beforeBoost.lives) audio.play('life');
      else if (s.weaponLevel > beforeBoost.weaponLevel || (s.player.shield && !beforeBoost.shield)) audio.play('power');
      else audio.play('pickup');
    }
    if (s.score > hi) { hi = s.score; store.set('pizzaPanicHi', hi); }
    if (s.score > prev.score) audio.play('hit', { combo: s.combo });
    if (s.wave > prev.wave) {
      const bossNow = s.ninjas.some(n => n.kind === 'boss');
      audio.play(bossNow ? 'boss' : 'wave');
      audio.music(bossNow ? 'boss' : levelMusic(s.level), 0.8);
    }
    if (s.lives < prev.lives) { audio.play('warn'); }
    if (s.hp < prev.hp) audio.play('hurt');
    if (s.hp > prev.hp && s.lives >= prev.lives) audio.play('life');
    // Music director: boss theme while the boss lives, mini-boss loop at a gate, else the level's track
    // (also corrects cutscene hand-backs, which always resume 'sewer'). Same name is a no-op.
    if (started && !s.over && !selecting && !screens.active() && !cinema.isActive() && !title.isActive()) { audio.setMusicVolume(pause.state.musicVolume); audio.music(s.ninjas.some(n => !n.dead && n.kind === 'boss') ? 'boss' : s.ninjas.some(n => !n.dead && n.levelBoss) ? 'miniboss' : levelMusic(s.level), s.level !== prev.level ? 1.2 : 0.8); }
    if (started) try { audio.update(dt, { cinema, s, started }); } catch (_) {}
    if (s.over && !prev.over) { if (!endingQueued && !s.runComplete && s.hpMode) screens.gameOver(s); else { audio.play('over'); audio.music(null, 1.5); } }
    // Last life: a slow heartbeat under the pulsing hearts.
    if (s.hp <= (s.maxHp || 100) * 0.3 && !s.over) { heartCd -= dt; if (heartCd <= 0) { audio.play('heart'); heartCd = 1.4; } } else heartCd = 0;
    prev = { score: s.score, lives: s.lives, wave: s.wave, over: s.over, hp: s.hp, level: s.level };
  }
}
const STEP = 1 / 120; let acc = 0;
const bodies = () => [s.player, ...s.ninjas];
function snapPrev() { s.__pcam = s.cameraX; for (const b of bodies()) { b.__px = b.x; b.__py = b.y; b.__pz = b.z || 0; } }
function withLerp(a, fn) {
  const saved = [];
  for (const b of bodies()) {
    if (b.__px == null) continue;
    saved.push([b, b.x, b.y, b.z]);
    // Skip interpolation across teleports (level switch, respawn).
    if (Math.abs(b.x - b.__px) > 80 || Math.abs(b.y - b.__py) > 80) continue;
    b.x = b.__px + (b.x - b.__px) * a; b.y = b.__py + (b.y - b.__py) * a; if (b.z != null) b.z = b.__pz + (b.z - b.__pz) * a;
  }
  const camSave = s.cameraX;
  if (Number.isFinite(s.__pcam) && Number.isFinite(camSave) && Math.abs(camSave - s.__pcam) < 80) s.cameraX = s.__pcam + (camSave - s.__pcam) * a;
  try { fn(); } finally { for (const [b, x, y, z] of saved) { b.x = x; b.y = y; if (z !== undefined) b.z = z; } s.cameraX = camSave; }
}
// The rAF chain must survive anything thrown in a frame: tick re-arms it if loop() did not.
function tick(t) { let ok = false; try { loop(t); ok = true; } catch (e) { reportError('loop', e); } if (!ok) requestAnimationFrame(tick); }
function loop(t) {
  if (!loop._ppl) { loop._ppl = 1; const el = document.getElementById('ppLoad'); if (el) { const f = document.getElementById('ppFill'); if (f) f.style.width = '100%'; el.classList.add('done'); setTimeout(() => el.remove(), 300); } }
  const dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
  resetFrame(); // mr_india: clean state + clear, whatever the last frame left behind
  animT += dt;
  // mr_india (review t_38085af9708c4a0a): the pause menu closes itself (Resume/Esc/Quit);
  // clear game.js 'paused' when it does, and honour Quit to Title.
  if (paused && !pause.isOpen()) { paused = false; if (pause.pendingQuit()) { pause.clearQuit(); title.start(() => { selecting = true; cineFade = 0.4; }); } }
  pollGamepad(dt, !started ? 'boot' : cinema.isActive() ? 'cine' : title.isActive() ? 'title' : screens.active() ? screens.mode() : pause.isOpen() ? 'pause' : selecting ? 'select' : s.over ? 'over' : 'play'); // cheese: gamepad
  // Cinematics wait for the first key press: browsers refuse to start audio
  // before a user gesture, so an auto-playing intro would be silent.
  if (!started) {
    // Arcade cabinet power-on: black screen until a key unlocks sound, then the
    // attract sequence fades in from black.
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    // Wrap-up fix: the power-on gate was a bare black screen, so the title art looked missing
    // until a key was pressed. Show the title plate + logo behind the prompt.
    const bootOk = im => im && im.complete && im.naturalWidth;
    if (bootOk(BOOT_ART.plate)) { ctx.globalAlpha = 0.55; ctx.drawImage(BOOT_ART.plate, 0, 0, W, H); ctx.globalAlpha = 1; }
    if (bootOk(BOOT_ART.logo)) { const lw = Math.min(W * 0.62, BOOT_ART.logo.naturalWidth), lh = lw * BOOT_ART.logo.naturalHeight / BOOT_ART.logo.naturalWidth; ctx.drawImage(BOOT_ART.logo, (W - lw) / 2, Math.max(16, H * 0.42 - lh - 20), lw, lh); }
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, H / 2 - 30, W, 70);
    ctx.textAlign = 'center';
    if (Math.floor(animT / 0.6) % 2 === 0) { ctx.fillStyle = '#ffeb57'; ctx.font = 'bold 22px monospace'; ctx.fillText('PRESS ANY KEY', W / 2, H / 2); }
    ctx.fillStyle = 'rgba(243,247,250,0.7)'; ctx.font = '13px monospace';
    ctx.fillText('sound starts here', W / 2, H / 2 + 26);
    ctx.textAlign = 'left';
    requestAnimationFrame(tick);
    return;
  }
  if (title.isActive()) { title.update(dt); title.draw(ctx, W, H); checkpoint.draw(ctx, W, H, title.ready(), dt); requestAnimationFrame(tick); return; } // mr_india: checkpoint menu over the title
  if (cinema.isActive()) { cinema.update(dt); cinema.draw(ctx, W, H); drawCineSpeaker(ctx, W, H, cinema); cineFade = 0.5; requestAnimationFrame(tick); return; }
  // Boss edges are tracked every frame, including while a cinematic plays: if
  // this only ran inside the gameplay block, a skipped entrance scene would see
  // prevBossAlive still false and re-trigger itself forever.
  {
    const bossAliveNow = s.ninjas.some(n => n.kind === 'boss');
    if (!prevBossAlive && bossAliveNow) cinema.play('bossEnter');
    if (prevBossAlive && !bossAliveNow) {
      bossDefeats += 1;
      audio.play('bossdie');
      cinema.play('bossDefeat', () => { if (!endingQueued && bossDefeats >= 1) { endingQueued = true; cinema.play('ending', () => { s.over = true; screens.ending(s); }); } });
    }
    prevBossAlive = bossAliveNow;
  }
  // Fixed-timestep simulation (1/120 s) with render interpolation, so motion and
  // timing are the same at any frame rate.
  if (bonus.active()) bonus.step(dt, keys); // dolan: bonus stage
  shop.update(dt); // dolan: shop UI (no-op when closed)
  checkpoint.watch(s, { shop: shop.active() }); // mr_india: save on stage clear and when the shop closes
  attempt('style.watch', () => style.watch(s, screens)); // mr_india: per-stage combo/juggle/special/damage tracking
  attempt('coach', () => coach.update(s, dt, { live: !paused && !selecting && !title.isActive() && !cinema.isActive() && !screens.active() && !shop.active() && !bonus.active() && !pause.isOpen() })); // mr_india: coach marks
  acc = Math.min(acc + dt, 0.1);
  while (acc >= STEP) { snapPrev(); simStep(STEP); acc -= STEP; }
  const alpha = acc / STEP;
  if (!paused) fx.tickUI(s, dt);
  screens.update(dt);
  withLerp(alpha, () => draw(dt));
  // Cinematics end on black; gameplay fades back up instead of hard-cutting.
  if (cineFade > 0) { ctx.fillStyle = `rgba(0,0,0,${Math.min(1, cineFade / 0.5)})`; ctx.fillRect(0, 0, W, H); cineFade = Math.max(0, cineFade - dt); }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

window.addEventListener('load', () => createTouchControls());

window.__ppOffscreen = { draw: drawOffscreenIndicators };
