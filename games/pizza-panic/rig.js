// Segmented cutout rig: draws the turtle and foot ninja from separate limb
// sprites so poses can be animated, per assets/rig/RIG.md (sizes, pivots,
// attach points, draw order, keyframes). Art by MR.INDIA; pose selection is
// driven by the combat state in combat.js.
//
// If a part image is missing the rig simply skips that limb, and callers keep
// their sprite/primitives fallback, so publishing without the art never breaks.
import { ENEMY_RIGS } from './enemy-rigs.js';
import { HERO_RIGS } from './hero-rigs.js';

// `ax/ay` are the attach point in the parent's pixels; `px/py` the local pivot.
// `_b` (back) limbs reuse the front image with a darker filter and their own
// attach points.
function parts({ file, px, py, parent = null, ax = 0, ay = 0, back = false }) {
  return { file, px, py, parent, ax, ay, back };
}

const TURTLE = {
  torso: parts({ file: 'turtle_torso.png', px: 12, py: 17 }),
  head: parts({ file: 'turtle_head.png', px: 20, py: 25, parent: 'torso', ax: 13, ay: 4 }),
  uarm_b: parts({ file: 'turtle_uarm.png', px: 5, py: 2, parent: 'torso', ax: 12, ay: 8, back: true }),
  farm_b: parts({ file: 'turtle_farm.png', px: 8, py: 2, parent: 'uarm_b', ax: 5, ay: 23, back: true }),
  thigh_b: parts({ file: 'turtle_thigh.png', px: 9, py: 2, parent: 'torso', ax: 10, ay: 30, back: true }),
  shin_b: parts({ file: 'turtle_shin.png', px: 8, py: 2, parent: 'thigh_b', ax: 9, ay: 23, back: true }),
  thigh: parts({ file: 'turtle_thigh.png', px: 9, py: 2, parent: 'torso', ax: 14, ay: 30 }),
  shin: parts({ file: 'turtle_shin.png', px: 8, py: 2, parent: 'thigh', ax: 9, ay: 23 }),
  uarm: parts({ file: 'turtle_uarm.png', px: 5, py: 2, parent: 'torso', ax: 15, ay: 8 }),
  farm: parts({ file: 'turtle_farm.png', px: 8, py: 2, parent: 'uarm', ax: 5, ay: 23 }),
  staff: parts({ file: 'turtle_staff.png', px: 31, py: 2, parent: 'farm_b', ax: 8, ay: 21 }),
};

const FOOT = {
  torso: parts({ file: 'foot_torso.png', px: 9, py: 17 }),
  head: parts({ file: 'foot_head.png', px: 10, py: 19, parent: 'torso', ax: 9, ay: 3 }),
  uarm_b: parts({ file: 'foot_uarm.png', px: 5, py: 2, parent: 'torso', ax: 10, ay: 8, back: true }),
  farm_b: parts({ file: 'foot_farm.png', px: 6, py: 2, parent: 'uarm_b', ax: 5, ay: 24, back: true }),
  thigh_b: parts({ file: 'foot_thigh.png', px: 7, py: 2, parent: 'torso', ax: 10, ay: 31, back: true }),
  shin_b: parts({ file: 'foot_shin.png', px: 11, py: 2, parent: 'thigh_b', ax: 7, ay: 21, back: true }),
  thigh: parts({ file: 'foot_thigh.png', px: 7, py: 2, parent: 'torso', ax: 7, ay: 31 }),
  shin: parts({ file: 'foot_shin.png', px: 11, py: 2, parent: 'thigh', ax: 7, ay: 21 }),
  uarm: parts({ file: 'foot_uarm.png', px: 5, py: 2, parent: 'torso', ax: 7, ay: 8 }),
  farm: parts({ file: 'foot_farm.png', px: 6, py: 2, parent: 'uarm', ax: 5, ay: 24 }),
  katana: parts({ file: 'foot_katana.png', px: 5, py: 31, parent: 'farm', ax: 8, ay: 28 }),
};

const TABLES = { turtle: TURTLE, foot: FOOT };

// MR.INDIA's six enemy types, generated from assets/enemies/MANIFEST.md. Their art
// lives in per-type folders, so each table carries its own image directory.
const ENEMY_DIR = 'assets/enemies/';
const HERO_DIR = 'assets/heroes/';
for (const [kind, table] of Object.entries(ENEMY_RIGS)) TABLES[kind] = table;
for (const [kind, table] of Object.entries(HERO_RIGS)) TABLES[kind] = table;
// turtle_purple is the original rig in assets/rig/, kept as the default hero.
// MR.INDIA iteration 8 (minimal change, logged on the board): use the generated
// turtle_purple table from its new sheet when hero-rigs.js has one.
if (!HERO_RIGS.turtle_purple) TABLES.turtle_purple = TURTLE;
const IMAGE_DIR = k => (k === 'turtle' || (k === 'turtle_purple' && !HERO_RIGS.turtle_purple) || k === 'foot' ? 'assets/rig/' : k in HERO_RIGS ? HERO_DIR + k + '/' : ENEMY_DIR + k + '/');

// MR.INDIA: striker_farm.png and turtle_red_farm.png already grip a blade, so those
// kinds must not draw a separate weapon sprite. turtle_orange's forearm holds one
// nunchaku stick, so the full nunchaku is drawn only on its spin frames.
const WEAPON_IN_HAND = new Set(['striker', 'turtle_red']);
const WEAPON_SPIN_ONLY = new Set(['turtle_orange']);

// Back to front, exactly as RIG.md lists it. Enemy weapons hang off the front hand.
const ORDER = ['uarm_b', 'farm_b', 'thigh_b', 'shin_b', 'staff', 'katana', 'torso', 'thigh', 'shin', 'head', 'uarm', 'farm', 'weapon'];

// Keyframes in degrees for the right-facing figure (RIG.md). A left-facing rig is
// drawn with flip, which lets the same table apply.
export const POSES = {
  idle: { uarm: 10, farm: -20, uarm_b: -15, farm_b: -50, thigh: -5, thigh_b: 6, weapon: -20 },
  // Counter-swing: the arm opposite the reaching leg swings forward, and the elbows stay bent.
  walk1: { torso: 3, uarm: 30, farm: -10, uarm_b: -30, farm_b: -50, thigh: -25, shin: 10, thigh_b: 25, shin_b: 15, weapon: -50 },
  walk2: { uarm: 0, farm: -20, uarm_b: 0, farm_b: -50, thigh: 0, shin: 25, thigh_b: 0, shin_b: 5, weapon: -60 },
  walk3: { torso: 3, uarm: -30, farm: -25, uarm_b: 30, farm_b: -40, thigh: 25, shin: 15, thigh_b: -25, shin_b: 10, weapon: -68 },
  walk4: { uarm: 0, farm: -20, uarm_b: 0, farm_b: -50, thigh: 0, shin: 5, thigh_b: 0, shin_b: 25, weapon: -60 },
  punch: { torso: 8, head: -5, uarm: -80, farm: -10, uarm_b: 20, farm_b: -60, thigh: -10, shin: 5, thigh_b: 15, weapon: -40, tw: 0.7 },
  // Telegraphs: coil away from the target before the strike, so the blow is readable instead of instant.
  punchWind: { torso: -12, head: 4, uarm: 26, farm: -72, uarm_b: -34, farm_b: -46, thigh: -6, shin: 6, thigh_b: 12, weapon: -34, tw: -0.6 },
  kickWind: { torso: 9, head: -3, uarm: -14, farm: -40, uarm_b: -28, farm_b: -56, thigh: 22, shin: 48, thigh_b: -6, shin_b: 8, weapon: -50, tw: -0.3 },
  // Turn: one step of the body swinging across when the player reverses, so the mirror flip reads as a turn rather than a pop.
  turn: { torso: 4, head: -8, uarm: 42, farm: -34, uarm_b: -42, farm_b: -30, thigh: 8, shin: 12, thigh_b: -8, shin_b: 6, weapon: -26 },
  kick: { torso: -10, head: 5, uarm: 25, farm: -30, uarm_b: -25, farm_b: -50, thigh: -85, shin: -10, thigh_b: 10, shin_b: 10, weapon: -60, tw: 0.4 },
  jump: { torso: -5, head: -5, uarm: -40, farm: -60, uarm_b: -30, farm_b: -70, thigh: -40, shin: 60, thigh_b: -20, shin_b: 50, weapon: -90 },
  // Hit reaction, shared by every rig.
  hurt: { torso: -8, head: 10, uarm: -20, farm: -70, uarm_b: -40, farm_b: -60, thigh: 12, shin: 18, thigh_b: -10, shin_b: 14, weapon: -50 },
  // --- enemy move poses, from assets/enemies/MANIFEST.md ---
  // brawler: bat swing coils to -110 then drives through to +40.
  batWind: { torso: -12, head: 6, uarm: -110, farm: -30, uarm_b: -40, farm_b: -56, thigh: -8, shin: 6, thigh_b: 10, weapon: -96 },
  batSwing: { torso: 14, head: -6, uarm: 40, farm: -6, uarm_b: 26, farm_b: -40, thigh: 6, shin: 8, thigh_b: -8, weapon: -14 },
  hayWind: { torso: 12, head: -4, uarm: 20, farm: -10, uarm_b: -30, farm_b: -50, thigh: -6, shin: 8, weapon: -40 },
  hayStrike: { torso: 14, head: -8, uarm: -62, farm: 12, uarm_b: 30, farm_b: -30, thigh: 8, shin: 6, weapon: -18 },
  // striker: dagger lives in the forearm, so only the arm swings.
  stabWind: { torso: -8, head: 4, uarm: 18, farm: -60, uarm_b: -30, farm_b: -50, thigh: -6, weapon: -70 },
  stab: { torso: 10, head: -5, uarm: -72, farm: 10, uarm_b: 28, farm_b: -34, thigh: 8, weapon: -20 },
  flurryA: { torso: 4, head: -3, uarm: -60, farm: -14, uarm_b: 20, farm_b: -50, thigh: 4, weapon: -34 },
  flurryB: { torso: 4, head: -3, uarm: -20, farm: -46, uarm_b: -26, farm_b: -40, thigh: 6, weapon: -60 },
  // blocker: shield up, then a shoulder bash.
  guard: { torso: -8, head: 4, uarm: -60, farm: -40, uarm_b: -46, farm_b: -52, thigh: -10, shin: 12, thigh_b: 8, weapon: -70 },
  bashWind: { torso: -14, head: 8, uarm: -50, farm: -36, uarm_b: -40, farm_b: -50, thigh: -14, shin: 18, weapon: -76 },
  bash: { torso: 12, head: -6, uarm: -78, farm: -18, uarm_b: 24, farm_b: -44, thigh: 14, shin: 6, weapon: -30 },
  // thrower: winding up a pizza box behind the head, then a full follow-through.
  throwWind: { torso: -10, head: 10, uarm: -140, farm: -50, uarm_b: -60, farm_b: -60, thigh: -10, shin: 10, weapon: -150 },
  throw: { torso: 12, head: -6, uarm: 30, farm: -8, uarm_b: 20, farm_b: -40, thigh: 10, shin: 8, weapon: 20 },
  // charger: crouch, drive, then a two-fisted pound.
  crouch: { torso: -15, head: 8, uarm: 20, farm: -30, uarm_b: 14, farm_b: -46, thigh: -30, shin: 20, thigh_b: -22, shin_b: 18, weapon: -60 },
  charge: { torso: 10, head: -8, uarm: -30, farm: -40, uarm_b: 22, farm_b: -48, thigh: 20, shin: -10, thigh_b: 16, shin_b: -6, weapon: -44 },
  poundWind: { torso: -10, head: 8, uarm: -70, farm: -50, uarm_b: -66, farm_b: -54, thigh: -12, shin: 14, weapon: -80 },
  pound: { torso: 14, head: -10, uarm: -10, farm: -12, uarm_b: -6, farm_b: -20, thigh: 10, shin: 12, weapon: -30 },
  // acrobat: crouch-to-launch, airborne flip, and a nunchaku spin.
  flipWind: { torso: -18, head: 10, uarm: -50, farm: -46, uarm_b: -46, farm_b: -52, thigh: -60, shin: 40, thigh_b: -50, shin_b: 36, weapon: -70 },
  flip: { torso: -20, head: -12, uarm: -60, farm: -60, uarm_b: -56, farm_b: -64, thigh: -60, shin: 40, thigh_b: -52, shin_b: 34, weapon: -100 },
  jumpkick: { torso: -10, head: 6, uarm: 20, farm: -30, uarm_b: -30, farm_b: -50, thigh: -85, shin: -10, thigh_b: 12, shin_b: 10, weapon: -70 },
  spinA: { uarm: -40, farm: -22, uarm_b: -34, farm_b: -44, torso: 6, weapon: -10 },
  spinB: { uarm: -40, farm: -22, uarm_b: -34, farm_b: -44, torso: 6, weapon: -50 },
};

const WALK = ['walk1', 'walk2', 'walk3', 'walk4'];

// Each enemy type's moves, straight from MANIFEST.md's wind-up angles. The AI side
// (pipi) drives these by setting ninja.move / ninja.phase ('wind'|'active'|'recover');
// if it does not, the rig falls back to idle/walk/hurt so nothing ever breaks.
export const ENEMY_MOVES = {
  brawler: { swing: ['batWind', 'batSwing'], haymaker: ['hayWind', 'hayStrike'] },
  striker: { dash: ['stabWind', 'stab'], flurry: ['flurryA', 'flurryB'] },
  blocker: { guard: ['guard', 'guard'], bash: ['bashWind', 'bash'] },
  thrower: { throw: ['throwWind', 'throw'] },
  charger: { charge: ['crouch', 'charge'], pound: ['poundWind', 'pound'] },
  acrobat: { flip: ['flipWind', 'flip'], jumpkick: ['flipWind', 'jumpkick'], spin: ['spinA', 'spinB'] },
};
for (const [kind, moves] of Object.entries(ENEMY_MOVES)) {
  for (const [move, [wind, active]] of Object.entries(moves)) {
    POSES[`${kind}_${move}_wind`] = POSES[wind];
    POSES[`${kind}_${move}_active`] = POSES[active];
    POSES[`${kind}_${move}_recover`] = POSES.idle;
  }
}

// --- hero move poses (character select) -------------------------------------
// Written as deltas on the idle pose so each entry shows just the joints that move.
const P = o => ({ ...POSES.idle, ...o });
Object.assign(POSES, {
  // staff (turtle_purple): long sweeps and a pole-vault kick
  staffWind: P({ torso: -12, head: 6, uarm: -100, farm: -50, uarm_b: -40, farm_b: -60, weapon: -150, tw: -0.6 }),
  staffSweep: P({ torso: 12, head: -6, uarm: -14, farm: -8, uarm_b: 26, farm_b: -40, thigh: 6, weapon: -12, tw: 0.8 }),
  staffSweepB: P({ torso: 10, head: -8, uarm: 20, farm: -30, uarm_b: -20, farm_b: -50, thigh: -8, weapon: -34, tw: 0.6 }),
  staffSpin: P({ torso: 6, uarm: -30, farm: -30, uarm_b: -26, farm_b: -40, thigh: 10, shin: 8, weapon: -20, tw: 0.5 }),
  vaultKick: P({ torso: -24, head: 12, uarm: 40, farm: -40, uarm_b: -30, farm_b: -60, thigh: -85, shin: -10, thigh_b: 14, weapon: -120, tw: 0.3 }),
  // shared spin wind-up for the spinning specials
  spinWind: P({ torso: -8, head: 6, uarm: 30, farm: -56, uarm_b: -34, farm_b: -48, thigh: -10, shin: 14, weapon: -104, tw: -0.6 }),
  // katana (turtle_blue)
  slashWind: P({ torso: -12, head: 6, uarm: 26, farm: -72, uarm_b: -36, farm_b: -46, weapon: -104, tw: -0.7 }),
  slashA: P({ torso: 10, head: -6, uarm: -62, farm: -18, uarm_b: 22, farm_b: -50, thigh: -8, shin: 6, weapon: -26, tw: 0.8 }),
  slashB: P({ torso: 12, head: -8, uarm: -24, farm: 10, uarm_b: 28, farm_b: -34, thigh: 8, weapon: 34, tw: 0.9 }),
  katanaSpin: P({ torso: 8, uarm: -40, farm: -20, uarm_b: -30, farm_b: -44, thigh: 12, shin: 8, weapon: -6, tw: 0.6 }),
  // sai (turtle_red) - the forearm already grips a sai, so the arm leads
  stabWindR: P({ torso: -8, uarm: 18, farm: -60, uarm_b: -30, farm_b: -50, thigh: -6, weapon: -70, tw: -0.5 }),
  stabWindL: P({ torso: -6, uarm: -40, farm: -30, uarm_b: -20, farm_b: -46, weapon: -60, tw: -0.4 }),
  stabL: P({ torso: 8, uarm: -70, farm: 4, uarm_b: 24, farm_b: -40, thigh: 6, weapon: -22, tw: 0.7 }),
  stabR: P({ torso: 10, uarm: -52, farm: 6, uarm_b: 18, farm_b: -38, thigh: 8, weapon: 12, tw: 0.6 }),
  stabFlurry: P({ torso: 12, head: -8, uarm: -88, farm: 8, uarm_b: 30, farm_b: -30, thigh: 10, weapon: 30, tw: 0.9 }),
  upperWind: P({ torso: 14, head: 8, uarm: 30, farm: -80, uarm_b: -20, farm_b: -60, thigh: -16, weapon: -104, tw: -0.4 }),
  upper: P({ torso: -16, head: -14, uarm: -142, farm: -18, uarm_b: 20, farm_b: -40, thigh: -22, shin: 10, weapon: -164, tw: 0.5 }),
  // nunchaku (turtle_orange): the full nunchaku sprite is drawn on the spin frames
  nunchakuA: P({ torso: 6, uarm: -50, farm: -30, uarm_b: 20, farm_b: -46, thigh: 4, weapon: -40, tw: 0.6 }),
  nunchakuB: P({ torso: -4, uarm: 20, farm: -60, uarm_b: -34, farm_b: -42, thigh: 6, weapon: -80, tw: -0.4 }),
  nunchakuSpin: P({ torso: 8, uarm: -34, farm: -26, uarm_b: -28, farm_b: -40, thigh: 10, shin: 8, weapon: -10, tw: 0.5 }),
  slide: P({ torso: -34, head: 16, uarm: -50, farm: -60, uarm_b: -30, farm_b: -66, thigh: -66, shin: 8, thigh_b: 34, shin_b: 46, weapon: -70, tw: 0.3 }),
  // energy blade (teknium): cancelable chains, a dash-through and a data burst
  bladeA: P({ torso: 8, head: -5, uarm: -58, farm: -22, uarm_b: 20, farm_b: -48, weapon: -30, tw: 0.8 }),
  bladeB: P({ torso: 6, head: -4, uarm: -20, farm: 12, uarm_b: 24, farm_b: -36, weapon: 26, tw: 0.9 }),
  bladeC: P({ torso: 12, head: -8, uarm: -74, farm: -6, uarm_b: 28, farm_b: -30, weapon: -10, tw: 1 }),
  bladeDashWind: P({ torso: -10, head: 6, uarm: 24, farm: -66, uarm_b: -34, farm_b: -50, weapon: -100, tw: -0.6 }),
  bladeDash: P({ torso: -12, head: -8, uarm: -96, farm: -28, uarm_b: 18, farm_b: -44, thigh: 28, shin: 18, thigh_b: -18, weapon: -14, tw: 0.7 }),
  burstWind: P({ torso: -6, head: 8, uarm: -30, farm: -78, uarm_b: -40, farm_b: -58, weapon: -80, tw: -0.5 }),
  burst: P({ torso: 6, head: -4, uarm: -46, farm: -66, uarm_b: 16, farm_b: -44, thigh: 6, weapon: -58, tw: 0.4 }),
  // guitar axe (turbofit): long wind-ups, big knockback, a shockwave and a headbang
  axeUpWind: P({ torso: -16, head: 8, uarm: -132, farm: -60, uarm_b: -44, farm_b: -62, weapon: -112, tw: -0.8 }),
  axeSwing: P({ torso: 18, head: -12, uarm: 30, farm: -4, uarm_b: 30, farm_b: -34, thigh: 10, weapon: 14, tw: 1 }),
  axeHeavy: P({ torso: 14, head: -10, uarm: -6, farm: -14, uarm_b: 24, farm_b: -40, thigh: 14, shin: 10, weapon: 40, tw: 1 }),
  chordWind: P({ torso: -10, head: 6, uarm: -42, farm: -52, uarm_b: -36, farm_b: -54, weapon: -92, tw: -0.6 }),
  chord: P({ torso: 16, head: -12, uarm: -12, farm: -20, uarm_b: 22, farm_b: -30, thigh: 14, shin: 12, weapon: -18, tw: 0.9 }),
  headbang: P({ torso: 30, head: -22, uarm: -30, farm: -62, uarm_b: 20, farm_b: -46, thigh: 12, shin: 14, weapon: -44, tw: 0.6 }),
  // audio cable whip (nous_girl): mid-range combos, a sound-wave blast and a bass drop
  whipWind: P({ torso: -8, head: 6, uarm: 26, farm: -70, uarm_b: -32, farm_b: -52, weapon: -106, tw: -0.6 }),
  whipA: P({ torso: 8, head: -5, uarm: -52, farm: -30, uarm_b: 20, farm_b: -48, thigh: -6, weapon: -38, tw: 0.7 }),
  whipB: P({ torso: -6, head: -4, uarm: 22, farm: -62, uarm_b: -26, farm_b: -44, thigh: 8, weapon: -84, tw: -0.4 }),
  waveBlast: P({ torso: 4, head: -4, uarm: -72, farm: -48, uarm_b: 18, farm_b: -50, thigh: -4, weapon: -52, tw: 0.5 }),
  bassDrop: P({ torso: 14, head: -10, uarm: -18, farm: -22, uarm_b: 14, farm_b: -40, thigh: -12, shin: 20, weapon: -32, tw: 0.6 }),
  dodgeRoll: P({ torso: 42, head: 20, uarm: -60, farm: -70, uarm_b: -36, farm_b: -60, thigh: -42, shin: 52, thigh_b: 30, weapon: -60, tw: 0.4 }),
});

// Which hero plays which move on each hit of the punch chain (combat.js drives the
// chain index), plus what each of their specials is. The rig only needs the names;
// damage/range/knockback live here so combat and the AI can read one table.
export const HERO_CHAIN = {
  turtle_purple: ['sweep', 'sweep', 'sweepSpin'],
  turtle_blue: ['slash', 'slash', 'slashSpin'],
  turtle_red: ['stabL', 'stabR', 'stabFlurry'],
  turtle_orange: ['nunchakuA', 'nunchakuB', 'nunchakuSpin'],
  teknium: ['bladeA', 'bladeB', 'bladeC'],
  turbofit: ['axe', 'axe', 'axeHeavy'],
  nous_girl: ['whipA', 'whipB', 'wave'],
};
// Which move each hero plays on the kick button (their mobility move from MANIFEST.md).
export const HERO_KICK = {
  turtle_purple: 'vaultKick', turtle_blue: 'slashSpin', turtle_red: 'upper',
  turtle_orange: 'slide', teknium: 'dash', turbofit: 'headbang', nous_girl: 'bassDrop',
};
export const HERO_MOVES = {  turtle_blue: { slash: ['slashWind', 'slashA'], slashB: ['slashWind', 'slashB'], slashSpin: ['spinWind', 'katanaSpin'] },
  turtle_red: { stabL: ['stabWindR', 'stabL'], stabR: ['stabWindL', 'stabR'], stabFlurry: ['stabWindL', 'stabFlurry'], upper: ['upperWind', 'upper'] },
  turtle_orange: { nunchakuA: ['spinA', 'nunchakuA'], nunchakuB: ['spinB', 'nunchakuB'], nunchakuSpin: ['spinWind', 'nunchakuSpin'], slide: ['crouch', 'slide'] },
  turtle_purple: { sweep: ['staffWind', 'staffSweep'], sweepSpin: ['spinWind', 'staffSpin'], vaultKick: ['jump', 'vaultKick'] },
  teknium: { bladeA: ['slashWind', 'bladeA'], bladeB: ['slashWind', 'bladeB'], bladeC: ['slashWind', 'bladeC'], dash: ['bladeDashWind', 'bladeDash'], burst: ['burstWind', 'burst'] },
  turbofit: { axe: ['axeUpWind', 'axeSwing'], axeHeavy: ['axeUpWind', 'axeHeavy'], chord: ['chordWind', 'chord'], headbang: ['crouch', 'headbang'] },
  nous_girl: { whipA: ['whipWind', 'whipA'], whipB: ['whipWind', 'whipB'], wave: ['burstWind', 'waveBlast'], bassDrop: ['chordWind', 'bassDrop'], roll: ['crouch', 'dodgeRoll'] },
};
// Specials: rootSpin is drawn by the caller (the whole rig rotates), fx names map to
// the impact/dust sprites so a special reads at a glance.
export const HERO_SPECIALS = {
  turtle_purple: [{ move: 'sweepSpin', name: 'Staff Sweep', rootSpin: 360, hits: 5, dmg: 2, knock: 260 }, { move: 'vaultKick', name: 'Pole Vault Kick', dmg: 3, knock: 420, air: true }],
  turtle_blue: [{ move: 'slashSpin', name: 'Katana Spin', rootSpin: 360, hits: 6, dmg: 2, knock: 240 }],
  turtle_red: [{ move: 'upper', name: 'Rising Uppercut', dmg: 3, knock: 460, launch: true }],
  turtle_orange: [{ move: 'nunchakuSpin', name: 'Nunchaku Flurry', hits: 8, dmg: 1, knock: 140 }, { move: 'slide', name: 'Slide Kick', dmg: 2, knock: 300, air: true }],
  teknium: [{ move: 'dash', name: 'Dash Through', dmg: 2, knock: 200, pierce: true }, { move: 'burst', name: 'Data Burst', dmg: 2, knock: 240, projectile: true }],
  turbofit: [{ move: 'chord', name: 'Power Chord', dmg: 3, knock: 380, shockwave: true }, { move: 'headbang', name: 'Headbang Charge', dmg: 3, knock: 420, charge: true }],
  nous_girl: [{ move: 'wave', name: 'Sound Wave', dmg: 2, knock: 260, projectile: 'nous_girl_fx_burst.png' }, { move: 'bassDrop', name: 'Bass Drop', dmg: 3, knock: 400 }],
};
for (const [hero, moves] of Object.entries(HERO_MOVES)) {
  for (const [move, [wind, active]] of Object.entries(moves)) {
    POSES[`${hero}_${move}_wind`] = POSES[wind];
    POSES[`${hero}_${move}_active`] = POSES[active];
    POSES[`${hero}_${move}_recover`] = POSES.idle;
  }
}
export const HEROES = Object.keys(HERO_CHAIN);

// --- iteration 6 mechanics --------------------------------------------------
// MR.INDIA is reworking combat (hit reactions, launcher/juggle, dash attack,
// grab/throw, back attack, a health-cost special). Every one of those gets a pose
// set here for every rig — hero and enemy — under the same `${kind}_${move}_${phase}`
// contract, so the combat side only has to set ninja.move/phase or the hero's chain
// entry and the animation exists. Nothing has to be requested from me first.
const MECHANIC_MOVES = {
  launcher: ['lungeWind', 'lungeHit'],      // launching blow
  juggle: ['juggleWind', 'juggleHit'],      // airborne follow-up
  dashAttack: ['dashWind', 'dashStrike'],   // dashing strike
  grab: ['grabReach', 'grabHold'],          // reach and hold
  grabThrow: ['throwLift', 'throwRelease'], // hold, then throw
  backAttack: ['backWind', 'backHit'],      // attack behind
  hitReact: ['hurt', 'hurt'],               // taking a hit
  healthSpecial: ['specialWind', 'specialBurst'], // costs HP
  groundPound: ['poundWind', 'pound'],      // straight down
  dash: ['dashWind', 'dashStrike'],         // short forward dash
  dodgeRoll: ['crouch', 'dodgeRoll'],       // i-frame roll (forwards or back)
};
Object.assign(POSES, {
  lungeWind: P({ torso: 16, head: 8, uarm: 28, farm: -74, uarm_b: -20, farm_b: -58, thigh: -18, shin: 12, weapon: -98, tw: -0.6 }),
  lungeHit: P({ torso: -18, head: -12, uarm: -138, farm: -22, uarm_b: 22, farm_b: -40, thigh: -26, shin: 14, weapon: 20, tw: 0.7 }),
  juggleWind: P({ torso: -14, head: 10, uarm: -34, farm: -66, uarm_b: -40, farm_b: -56, thigh: -30, shin: 40, thigh_b: 18, weapon: -92, tw: -0.4 }),
  juggleHit: P({ torso: 14, head: -10, uarm: -6, farm: -16, uarm_b: 20, farm_b: -36, thigh: 26, shin: 6, thigh_b: -22, weapon: -20, tw: 0.7 }),
  dashWind: P({ torso: -12, head: 6, uarm: 22, farm: -62, uarm_b: -34, farm_b: -52, thigh: -20, shin: 18, weapon: -96, tw: -0.5 }),
  dashStrike: P({ torso: -10, head: -8, uarm: -88, farm: -26, uarm_b: 18, farm_b: -44, thigh: 34, shin: 22, thigh_b: -20, weapon: -16, tw: 0.6 }),
  grabReach: P({ torso: 8, head: -4, uarm: -70, farm: -8, uarm_b: 20, farm_b: -46, thigh: -6, shin: 8, weapon: -40, tw: 0.5 }),
  grabHold: P({ torso: 4, head: -2, uarm: -52, farm: -24, uarm_b: 16, farm_b: -44, thigh: -2, shin: 6, weapon: -50, tw: 0.4 }),
  throwLift: P({ torso: -12, head: 10, uarm: -96, farm: -46, uarm_b: -34, farm_b: -54, thigh: 6, shin: 10, weapon: -120, tw: -0.6 }),
  throwRelease: P({ torso: 16, head: -10, uarm: 26, farm: -6, uarm_b: 18, farm_b: -36, thigh: 12, shin: 8, weapon: 18, tw: 0.9 }),
  backWind: P({ torso: 12, head: -10, uarm: 40, farm: -60, uarm_b: -40, farm_b: -50, thigh: -8, shin: 10, weapon: -100, tw: -0.6 }),
  backHit: P({ torso: -8, head: 14, uarm: -50, farm: -30, uarm_b: 30, farm_b: -44, thigh: 10, shin: 6, weapon: 40, tw: 0.7 }),
  specialWind: P({ torso: -16, head: 12, uarm: -120, farm: -64, uarm_b: -48, farm_b: -60, thigh: -22, shin: 26, weapon: -100, tw: -0.8 }),
  specialBurst: P({ torso: 18, head: -14, uarm: 34, farm: -8, uarm_b: 26, farm_b: -32, thigh: 20, shin: 14, weapon: 26, tw: 1 }),
});

// Every rig answers to every mechanic, so combat code never has to ask for a pose.
for (const kind of [...Object.keys(HERO_RIGS), 'turtle_purple', ...Object.keys(ENEMY_RIGS)]) {
  for (const [move, [wind, active]] of Object.entries(MECHANIC_MOVES)) {
    // A hero move of the same name wins: teknium's dash is his blade dash, so the
    // generic locomotion dash must not overwrite it.
    if (POSES[`${kind}_${move}_wind`]) continue;
    POSES[`${kind}_${move}_wind`] = POSES[wind];
    POSES[`${kind}_${move}_active`] = POSES[active];
    POSES[`${kind}_${move}_recover`] = POSES.idle;
  }
}
export const MECHANICS = Object.keys(MECHANIC_MOVES);

// --- task: dedicated reaction, hold and follow-through keyframes ---------------
// combat.js drives enemies through flinch / stagger / knockdown / launch / thrown /
// down / wake. Each of those gets its own pose here rather than reusing the hurt
// pose, plus a grab hold that is separate from the knee, and a follow-through pose
// per move so anim.js can overshoot into something that reads.
Object.assign(POSES, {
  // reactions
  flinch: P({ torso: -6, head: 8, uarm: -14, farm: -58, uarm_b: -34, farm_b: -54, thigh: 6, shin: 10, weapon: -54, tw: -0.4 }),
  stagger: P({ torso: -14, head: 14, uarm: 12, farm: -70, uarm_b: -48, farm_b: -62, thigh: 14, shin: 22, thigh_b: -14, shin_b: 16, weapon: -76, tw: -0.6 }),
  knockdownAir: P({ torso: -34, head: 24, uarm: 46, farm: -86, uarm_b: -56, farm_b: -74, thigh: 40, shin: 30, thigh_b: -34, shin_b: 26, weapon: -96 }),
  down: P({ torso: 74, head: -58, uarm: 68, farm: -30, uarm_b: 40, farm_b: -40, thigh: 26, shin: 44, thigh_b: -16, shin_b: 30, weapon: -10 }),
  downB: P({ torso: 72, head: -62, uarm: 64, farm: -34, uarm_b: 36, farm_b: -44, thigh: 22, shin: 48, thigh_b: -20, shin_b: 26, weapon: -14 }),
  wake: P({ torso: 38, head: -30, uarm: 44, farm: -54, uarm_b: 24, farm_b: -60, thigh: -30, shin: 46, thigh_b: 26, shin_b: 30, weapon: -40 }),
  // holds: the grabber and the grabbed, neither of them the knee strike
  grabHold: P({ torso: 6, head: -4, uarm: -66, farm: -12, uarm_b: 18, farm_b: -48, thigh: -4, shin: 8, weapon: -44, tw: 0.4 }),
  grabbed: P({ torso: -10, head: 12, uarm: 40, farm: -74, uarm_b: -44, farm_b: -60, thigh: -8, shin: 16, thigh_b: 10, weapon: -92, tw: -0.5 }),
  // follow-through: what the body does after the blow lands
  thrustFollow: P({ torso: 16, head: -10, uarm: -84, farm: 14, uarm_b: 26, farm_b: -32, thigh: 12, shin: 6, weapon: 16, tw: 1 }),
  slashFollow: P({ torso: 18, head: -12, uarm: -34, farm: 6, uarm_b: 30, farm_b: -30, thigh: 14, shin: 8, weapon: 36, tw: 1 }),
  smashFollow: P({ torso: 22, head: -16, uarm: -4, farm: -18, uarm_b: 26, farm_b: -38, thigh: 18, shin: 12, weapon: 36, tw: 1 }),
  whipFollow: P({ torso: -4, head: -4, uarm: 34, farm: -66, uarm_b: -28, farm_b: -48, thigh: 10, shin: 8, weapon: -96, tw: -0.3 }),
  throwFollow: P({ torso: 20, head: -12, uarm: 34, farm: -2, uarm_b: 22, farm_b: -32, thigh: 16, shin: 10, weapon: 24, tw: 1 }),
  spinFollow: P({ torso: 10, head: -6, uarm: -44, farm: -24, uarm_b: -30, farm_b: -42, thigh: 14, shin: 10, weapon: -12, tw: 0.6 }),
});

// Which follow-through each move overshoots into. Defaults to a thrust; moves whose
// weapon swings get the matching arc so the weight reads.
const FOLLOW_FOR = {
  slash: 'slashFollow', slashA: 'slashFollow', slashB: 'slashFollow', bladeA: 'slashFollow', bladeB: 'slashFollow', bladeC: 'slashFollow',
  axe: 'smashFollow', axeHeavy: 'smashFollow', pound: 'smashFollow', hayStrike: 'smashFollow', bash: 'smashFollow',
  whipA: 'whipFollow', whipB: 'whipFollow', wave: 'whipFollow', spin: 'spinFollow', nunchakuSpin: 'spinFollow', katanaSpin: 'spinFollow', sweepSpin: 'spinFollow', staffSpin: 'spinFollow',
  throw: 'throwFollow', grabThrow: 'throwFollow', waveBlast: 'throwFollow', burst: 'throwFollow',
  stabL: 'thrustFollow', stabR: 'thrustFollow', stabFlurry: 'thrustFollow', upper: 'thrustFollow',
};
const REACTION_STATES = ['flinch', 'stagger', 'knockdownAir', 'down', 'downB', 'wake', 'grabHold', 'grabbed'];
const ALL_KINDS = [...Object.keys(HERO_RIGS), 'turtle_purple', ...Object.keys(ENEMY_RIGS)];
for (const kind of ALL_KINDS) {
  // reaction / hold poses, per rig
  for (const state of REACTION_STATES) POSES[`${kind}_${state}`] = POSES[state];
  // a follow-through for every move that has a wind-up
  for (const move of new Set([...Object.values(HERO_MOVES).flatMap(m => Object.keys(m)), ...Object.keys(ENEMY_MOVES).flatMap(k => Object.keys(ENEMY_MOVES[k])), ...Object.keys(MECHANIC_MOVES)])) {
    POSES[`${kind}_${move}_follow`] = POSES[FOLLOW_FOR[move] || 'thrustFollow'];
  }
}
// --- idles, taunts and victory poses -----------------------------------------
// A standing hero should not be one looping pose: each hero gets three idle
// variants that rotate, a taunt that flourishes their own weapon, and a victory
// pose with the weapon raised. All per rig, all blended by anim.js like any pose.
Object.assign(POSES, {
  idleA: POSES.idle,
  idleB: P({ torso: -3, head: 4, uarm: 16, farm: -30, uarm_b: -22, farm_b: -54, thigh: 6, shin: 10, thigh_b: -8, shin_b: 8, weapon: -26, tw: 0.15 }),
  idleC: P({ torso: 4, head: -5, uarm: -8, farm: -12, uarm_b: -10, farm_b: -44, thigh: -8, shin: 16, thigh_b: 10, shin_b: 12, weapon: -14, tw: -0.15 }),
  taunt: P({ torso: -8, head: 8, uarm: -46, farm: -52, uarm_b: -30, farm_b: -58, thigh: -6, shin: 12, thigh_b: 8, weapon: -96, tw: -0.4 }),
  victory: P({ torso: -12, head: 10, uarm: -128, farm: -34, uarm_b: -46, farm_b: -56, thigh: -10, shin: 10, thigh_b: 12, shin_b: 8, weapon: -110, tw: -0.5 }),
});

// Per-hero flavour on top of the shared shapes, so a taunt looks like that weapon.
const HERO_FLOURISH = {
  turtle_purple: { taunt: { uarm: -30, farm: -70, weapon: -140 }, victory: { uarm: -140, weapon: -170 } },
  turtle_blue: { taunt: { uarm: -60, farm: -30, weapon: -30 }, victory: { uarm: -120, weapon: -110 } },
  turtle_red: { taunt: { uarm: -70, farm: 10, weapon: -20 }, victory: { uarm: -110, weapon: -80 } },
  turtle_orange: { taunt: { uarm: -20, farm: -74, weapon: -60 }, victory: { uarm: -100, weapon: -120 } },
  nous_girl: { taunt: { uarm: -40, farm: -60, weapon: -108 }, victory: { uarm: -134, weapon: -124 } },
  teknium: { taunt: { uarm: -66, farm: -44, weapon: -70 }, victory: { uarm: -126, weapon: -104 } },
  turbofit: { taunt: { uarm: -20, farm: -20, weapon: -40 }, victory: { uarm: -150, weapon: -118 } },
};
export const IDLE_VARIANTS = ['idleA', 'idleB', 'idleC'];
const IDLE_PERIOD = 3.4;   // seconds each idle variant holds before it swaps
for (const [hero, flavour] of Object.entries(HERO_FLOURISH)) {
  for (const variant of IDLE_VARIANTS) POSES[`${hero}_${variant}`] = POSES[variant];
  POSES[`${hero}_taunt`] = { ...POSES.taunt, ...flavour.taunt };
  POSES[`${hero}_victory`] = { ...POSES.victory, ...flavour.victory };
}
// A hero with no flavour entry still gets all five (enemy rigs get them too, so the
// pose contract never has holes).
for (const kind of ALL_KINDS) {
  for (const name of [...IDLE_VARIANTS, 'taunt', 'victory']) {
    if (!POSES[`${kind}_${name}`]) POSES[`${kind}_${name}`] = POSES[name];
  }
}
export const idlesFor = hero => IDLE_VARIANTS.map(v => `${hero}_${v}`);
// The offset is derived from the hero id, so two heroes on screen never idle in
// lockstep and every caller gets the same answer without passing a seed.
const idleOffset = hero => {
  let h = 0;
  for (let i = 0; i < String(hero).length; i++) h = (h * 31 + String(hero).charCodeAt(i)) % 997;
  return (h % IDLE_VARIANTS.length) * IDLE_PERIOD;   // whole variants apart, so they differ immediately
};
export const idleVariantAt = (hero, t, offset = null) => {
  const off = offset == null ? idleOffset(hero) : offset;
  const cycle = IDLE_PERIOD * IDLE_VARIANTS.length;
  const idx = Math.floor((((t + off) % cycle) + cycle) % cycle / IDLE_PERIOD);
  return `${hero}_${IDLE_VARIANTS[idx]}`;
};
export const IDLE_SECONDS = IDLE_PERIOD;

export const FOLLOWS = FOLLOW_FOR;
export const REACTIONS = REACTION_STATES;

// --- rig geometry (pure; draw() and the rig tests both use it) ----------------
// solve(kind, angles) returns, for every visible part, the 2x3 matrix that maps
// part-local pixels (relative to the part's pivot) into rig space (root = torso
// pivot, right-facing, before the caller's flip and scale), the per-part draw
// scale, and the back-to-front draw order for that kind.
//
// Heroes pass (rig QA, "heroes world class"):
//  - per-hero layer order: skirt/coat heroes draw their thighs under the torso, and a
//    weapon is drawn right after the hand that holds it (purple's bo is in the far hand);
//  - per-part draw scale, to fix proportions until new art lands (turbofit's pin torso);
//  - a twist channel (`tw`, -1 coiled .. +1 driven through) that slides the shoulders
//    and hips around the spine, so strikes rotate the body instead of only the arm;
//  - a wrist: the weapon's angle in the fist is soft-limited to a natural range
//    around that weapon's neutral grip, so a blade never spins in the hand;
//  - planted feet: animated hero frames put the lowest sole on the ground line, so
//    crouches bend the knees and drop the hips instead of sliding the feet.
const BACK_TINT_DEFAULT = 'brightness(0.6)';
// pale skin goes grey at 0.6; these keep the far limbs readable as skin
const BACK_TINT = { nous_girl: 'brightness(0.8) sepia(0.12)', teknium: 'brightness(0.66)', turbofit: 'brightness(0.66)' };
export const SKIRTED = new Set(['teknium', 'nous_girl']);
// [scaleX, scaleY] per part (back limbs use their front part's scale).
export const PART_SCALE = {
  turtle_purple: { weapon: [1.85, 1.15] },   // the bo art is forearm-length; a bo is as tall as he is
  nous_girl: { uarm: [1.06, 0.82], farm: [1.04, 0.84], thigh: [1.04, 0.92], shin: [1, 0.95] },
};
// Neutral grip and wrist range, in the weapon's rotation relative to its forearm
// (pose weapon + MANIFEST grip). c = the angle where the weapon sits square in the
// fist (theta about -65 deg in check-weapon-angle terms: a fist holds a handle about 65 deg off the forearm), hw = how far the wrist can
// cock or flex either side of it. Staffs and the spin-only nunchaku are free.
export const WRIST = { turtle_blue: { c: 92, hw: 50 }, teknium: { c: 12, hw: 50 }, nous_girl: { c: 84, hw: 52 }, turbofit: { c: -91, hw: 50 } };
// Shin sole points (heel, toe) in shin-image px, from the art (tools: check-rigs).
export const SOLES = { turtle_purple: [[10, 72], [33, 72]], turtle_blue: [[13, 57], [35, 57]], turtle_red: [[11, 67], [33, 67]], turtle_orange: [[14, 65], [41, 65]], nous_girl: [[5, 60], [22, 60]], teknium: [[2, 55], [27, 55]], turbofit: [[3, 56], [31, 56]] };
export const FOOT_Y = 90; // rig px from the root down to the ground line (game.js FEET_SCREEN 63 / RIG_SCALE 0.7)
// Frames that are not standing on the ground keep the idle offset instead of the plant.
export const AIR_POSE = /(^|_)(jump|knockdownAir|down|downB|wake|grabbed|juggle_\w+|vaultKick_\w+|dodgeRoll(_\w+)?|roll_\w+|bassDrop_\w+|launcher_active|launcher_recover)$/;
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const rot = deg => { const r = (deg || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
const tr = (x, y) => [1, 0, 0, 1, x, y];
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const isWeapon = n => n === 'staff' || n === 'katana' || n === 'weapon';
const wrap180 = a => ((a + 180) % 360 + 360) % 360 - 180;
export function orderFor(kind) {
  const T = TABLES[kind];
  if (!T || !HERO_RIGS[kind]) return ORDER;
  const legs = ['thigh_b', 'shin_b'];
  const body = SKIRTED.has(kind) ? [...legs, 'thigh', 'shin', 'torso', 'head', 'uarm', 'farm'] : [...legs, 'torso', 'thigh', 'shin', 'head', 'uarm', 'farm'];
  const o = ['uarm_b', 'farm_b', ...body];
  if (T.weapon) o.splice(o.indexOf(T.weapon.parent) + 1, 0, 'weapon');
  return o;
}
// The wrist: the weapon's rotation in the fist, soft-limited around the neutral grip.
export function wristAngle(kind, raw) {
  const w = WRIST[kind];
  if (!w) return raw;
  const d = wrap180(raw - w.c);
  return w.c + w.hw * Math.tanh(d / w.hw);
}
const scaleOf = (kind, name) => { const t = PART_SCALE[kind]; return (t && (t[name] || t[name.replace(/_b$/, '')])) || null; };
function chainSolve(kind, A, names) {
  const table = TABLES[kind], M = {}, S = {}, tw = A.tw || 0, hero = !!HERO_RIGS[kind];
  const one = name => {
    if (M[name]) return M[name];
    const p = table[name];
    let m = [1, 0, 0, 1, 0, 0];
    if (p.parent) {
      const q = table[p.parent], qs = scaleOf(kind, p.parent) || [1, 1];
      let ax = p.ax, ay = p.ay;
      if (hero && p.parent === 'torso' && tw) {
        // twist: the near shoulder and hip swing forward around the spine, the far ones back
        ax += tw * (name === 'uarm' ? 3.5 : name === 'uarm_b' ? -3 : name === 'thigh' ? 1.5 : name === 'thigh_b' ? -1.5 : name === 'head' ? 1.5 : 0);
      }
      m = mul(one(p.parent), tr((ax - q.px) * qs[0], (ay - q.py) * qs[1]));
    }
    let ang = A[name];
    // mr_india (rig QA): + the weapon's grip angle from MANIFEST.md ("Weapon grip:"), so every
    // weapon art sits in the fist the same way under the shared poses.
    if (isWeapon(name)) ang = hero ? wristAngle(kind, (A.weapon || 0) + (p.grip || 0)) : (A.weapon || 0) + (p.grip || 0);
    m = mul(m, rot(ang));
    const sc = scaleOf(kind, name);
    let sx = sc ? sc[0] : 1; const sy = sc ? sc[1] : 1;
    if (hero && name === 'torso' && tw) sx *= 1 - 0.06 * Math.min(1, Math.abs(tw)); // a turned torso reads narrower
    M[name] = m; S[name] = [sx, sy];
    return m;
  };
  for (const n of names) one(n);
  return { M, S };
}
export function soleY(kind, sol) {
  const T = TABLES[kind], soles = SOLES[kind];
  if (!soles) return null;
  let y = -Infinity;
  for (const n of ['shin', 'shin_b']) {
    if (!sol.M[n]) continue;
    const s = sol.S[n] || [1, 1];
    for (const [u, v] of soles) y = Math.max(y, apply(sol.M[n], (u - T[n].px) * s[0], (v - T[n].py) * s[1])[1]);
  }
  return y;
}
const idleLift = {};
export function solve(kind, angles, opts = {}) {
  const table = TABLES[kind];
  const A = angles || POSES.idle, poseName = opts.poseName || '';
  const order = [];
  for (const name of orderFor(kind)) {
    const part = table[name];
    if (!part) continue;
    if (name === 'weapon') {
      if (WEAPON_IN_HAND.has(kind)) continue;
      if (WEAPON_SPIN_ONLY.has(kind) && !/spin/i.test(poseName)) continue;
    }
    order.push(name);
  }
  const { M, S } = chainSolve(kind, A, [...order, ...(table.shin_b && !order.includes('shin_b') ? ['shin_b'] : [])]);
  let dx = A.dx || 0, dy = A.dy || 0;
  if (opts.animated && HERO_RIGS[kind] && SOLES[kind]) {
    if (idleLift[kind] == null) idleLift[kind] = FOOT_Y - soleY(kind, chainSolve(kind, POSES[`${kind}_idleA`] || POSES.idle, ['shin', 'shin_b']));
    dy += AIR_POSE.test(poseName) ? idleLift[kind] : FOOT_Y - soleY(kind, { M, S });
  }
  if (dx || dy) for (const n of Object.keys(M)) { M[n] = M[n].slice(); M[n][4] += dx; M[n][5] += dy; }
  return { M, S, order };
}

// --- heroes world-class pass: per-hero stances, walks and moves ----------------
// Every hero gets their own stance, idle variants, walk carriage, jump, chain hits,
// kick/finisher/special, taunt and victory, so the silhouette says who it is:
//   turtle_blue  balanced swordsman, mid guard, blade up and forward
//   turtle_red   low brawler's crouch, both sais up, leaning in
//   turtle_orange loose and bouncy, one stick raised, one low
//   turtle_purple wide bo stance, staff angled across the body
//   teknium      upright and cool, the blade resting on his shoulder (his portrait),
//                free hand low; precise slashes and a fencer's lunge
//   nous_girl    light and narrow, hip out, cable coil at the hip and a fist by her
//                chin; lashes the cable out on whip hits
//   turbofit     wide rocker's power stance, guitar axe over the shoulder, chops
//                and floor smashes with the body of the guitar
// Weapon angles are authored as the angle in the fist (theta, check-weapon-angle
// terms: about -65 is square in the fist) and converted per hero. Strikes coil the
// body (tw < 0), drive through with the hips and shoulders (tw > 0), the free arm
// pulls back as the weapon arm extends, and the front knee takes the lunge.
// plant() then bends the far knee so both feet stay on the floor in grounded poses.
const GRIP_OFF = { turtle_blue: 37.2, teknium: 41.6, nous_girl: 34.3, turbofit: 34.1, turtle_orange: 27.7, turtle_purple: 0, turtle_red: 0 };
const LEGS = {
  st: [-18, 22, 14, 6], low: [-26, 38, 18, 16], wide: [-28, 18, 26, 4], narrow: [-8, 12, 6, 4], coil: [-10, 26, 22, 12],
  lunge: [-42, 40, 34, 2], drive: [-32, 30, 28, 4], tall: [-6, 6, 4, 2],
};
const OFF = { guard: [-22, -96], guardHi: [-34, -110], pull: [34, -88], reach: [-60, -30], balance: [44, -40], low: [-6, -50], hip: [24, -70] };
function plant(h, o) {
  const T = TABLES[h], so = SOLES[h];
  const footY = (k, A) => { const s = chainSolve(h, A, [k]); let y = -Infinity; const sc = s.S[k]; for (const [u, v] of so) y = Math.max(y, apply(s.M[k], (u - T[k].px) * sc[0], (v - T[k].py) * sc[1])[1]); return y; };
  for (let it = 0; it < 40; it++) {
    const yF = footY('shin', o), yB = footY('shin_b', o), d = yF - yB;
    if (Math.abs(d) < 0.3) break;
    const [th, sh] = d > 0 ? ['thigh_b', 'shin_b'] : ['thigh', 'shin'];   // the higher foot comes down
    const key = (o[sh] || 0) > 0.5 ? sh : th, k0 = o[key] || 0, y0 = footY(sh, o);
    const dir = key === sh ? -1 : -Math.sign(k0 || 1);                   // straighten the knee, then the hip
    o[key] = k0 + dir; const dy = footY(sh, o) - y0; o[key] = k0;
    if (Math.abs(dy) < 1e-3) break;
    const step = Math.max(-8, Math.min(8, Math.abs(d) / dy * dir));
    o[key] = key === sh ? Math.max(0, k0 + step) : k0 + step;
  }
  return o;
}
function hp(h, d, opts = {}) {
  const o = { torso: 0, head: 0, uarm: 0, farm: 0, uarm_b: 0, farm_b: 0, thigh: 0, shin: 0, thigh_b: 0, shin_b: 0, weapon: 0, tw: 0, dx: 0, dy: 0 };
  for (const [k, v] of Object.entries(d)) {
    if (k === 'legs') { const L = typeof v === 'string' ? LEGS[v] : v; [o.thigh, o.shin, o.thigh_b, o.shin_b] = L; }
    else if (k === 'off') { const A = typeof v === 'string' ? OFF[v] : v; [o.uarm_b, o.farm_b] = A; }
    else if (k === 'th') o.weapon = v + GRIP_OFF[h];
    else o[k] = v;
  }
  return opts.air ? o : plant(h, o);
}
const HERO_STYLE = {
  turtle_blue: {
    idleA: { torso: 6, head: -5, uarm: -32, farm: -52, th: -62, off: 'guard', legs: 'st', tw: 0.1 },
    idleB: { torso: 4, head: -3, uarm: -26, farm: -58, th: -70, off: [-16, -104], legs: 'st', tw: 0.2 },
    idleC: { torso: 3, head: -2, uarm: -14, farm: -36, th: -42, off: [-8, -86], legs: [-12, 16, 10, 4] },
    walk: { torso: 7, front: [-30, 6, -54], off: [-22, 24, -92], th: -62 },
    jump: { torso: 2, head: -4, uarm: -50, farm: -50, th: -70, off: [-40, -80], legs: [-55, 80, -25, 70] },
    taunt: { torso: -4, head: 6, uarm: -120, farm: -40, th: -78, off: [20, -100], legs: 'narrow', tw: -0.3 },
    victory: { torso: -8, head: 8, uarm: -170, farm: -10, th: -18, off: [24, -96], legs: 'narrow' },
    moves: {
      slash: [{ torso: -8, head: 3, uarm: -150, farm: -30, th: -100, off: [-60, -70], legs: 'coil', tw: -0.8 },
        { torso: 14, head: -8, uarm: -48, farm: -14, th: -36, off: 'pull', legs: 'lunge', tw: 1, dx: 3 },
        { torso: 18, head: -10, uarm: -18, farm: -10, th: -30, off: [38, -78], legs: 'lunge', tw: 0.8, dx: 3 }],
      slashUp: [{ torso: 6, head: -2, uarm: 20, farm: -30, th: -24, off: 'guard', legs: 'st', tw: -0.6 },
        { torso: -4, head: -10, uarm: -130, farm: -20, th: -50, off: 'pull', legs: 'drive', tw: 1 },
        { torso: -8, head: -12, uarm: -150, farm: -20, th: -56, off: [40, -70], legs: 'drive', tw: 0.8 }],
      slashB: [{ torso: -6, head: 4, uarm: 30, farm: -80, th: -110, off: [-40, -60], legs: 'coil', tw: -1 },
        { torso: 20, head: -10, uarm: -80, farm: -6, th: -18, off: 'balance', legs: [-50, 44, 40, 0], tw: 1, dx: 6 },
        { torso: 22, head: -12, uarm: -62, farm: -4, th: -16, off: 'balance', legs: [-50, 44, 40, 0], tw: 0.9, dx: 6 }],
      slashSpin: [{ torso: -6, head: 4, uarm: 10, farm: -70, th: -110, off: [-50, -60], legs: 'low', tw: -1 },
        { torso: 6, head: -4, uarm: -86, farm: -6, th: -20, off: [50, -30], legs: 'wide', tw: 1 },
        { torso: 8, head: -6, uarm: -80, farm: -10, th: -24, off: [40, -40], legs: 'wide', tw: 0.6 }],
    },
  },
  turtle_red: {
    idleA: { torso: 12, head: -10, uarm: -40, farm: -80, off: [-30, -104], legs: 'low', tw: 0.2 },
    idleB: { torso: 14, head: -12, uarm: -34, farm: -90, off: [-24, -96], legs: 'low', tw: 0.3 },
    idleC: { torso: 10, head: -8, uarm: -20, farm: -62, off: [-14, -86], legs: 'st' },
    walk: { torso: 12, front: [-38, 8, -82], off: [-28, 18, -100] },
    jump: { torso: 8, head: -6, uarm: -60, farm: -80, off: [-50, -90], legs: [-60, 90, -30, 80] },
    taunt: { torso: 6, head: -4, uarm: -100, farm: -40, off: [-70, -60], legs: 'low', tw: 0.2 },
    victory: { torso: -6, head: 6, uarm: -160, farm: -14, off: [-150, -20], legs: 'st' },
    moves: {
      stabL: [{ torso: 4, head: -6, uarm: 10, farm: -100, off: [-50, -60], legs: 'coil', tw: -0.7 },
        { torso: 16, head: -10, uarm: -82, farm: -4, off: 'pull', legs: 'drive', tw: 1, dx: 3 },
        { torso: 18, head: -10, uarm: -86, farm: 0, off: [38, -80], legs: 'drive', tw: 0.9, dx: 3 }],
      stabR: [{ torso: 6, head: -6, uarm: -60, farm: -30, off: [30, -110], legs: 'st', tw: 0.6 },
        { torso: 14, head: -8, uarm: 20, farm: -90, off: [-84, -4], legs: 'drive', tw: -0.8, dx: 3 },
        { torso: 16, head: -8, uarm: 24, farm: -86, off: [-88, 0], legs: 'drive', tw: -0.9, dx: 3 }],
      stabFlurry: [{ torso: 2, head: -4, uarm: 0, farm: -100, off: [10, -110], legs: 'low', tw: -0.5 },
        { torso: 16, head: -10, uarm: -80, farm: -6, off: [-50, -60], legs: 'drive', tw: 0.8 },
        { torso: 12, head: -8, uarm: -40, farm: -60, off: [-84, -2], legs: 'drive', tw: -0.6 }],
      upper: [{ torso: 20, head: 6, uarm: 30, farm: -96, off: 'guard', legs: [-30, 50, 26, 30], tw: -0.8 },
        { torso: -12, head: -14, uarm: -150, farm: -16, off: [30, -80], legs: [-20, 10, 14, 0], tw: 0.8, dy: -4 },
        { torso: -14, head: -16, uarm: -160, farm: -14, off: [36, -70], legs: [-16, 8, 12, 0], tw: 0.6 }],
    },
  },
  turtle_orange: {
    idleA: { torso: 4, head: -4, uarm: -60, farm: -70, th: -60, off: [16, -60], legs: [-14, 24, 16, 10], tw: 0.1 },
    idleB: { torso: 2, head: -3, uarm: -76, farm: -60, th: -60, off: [24, -70], legs: 'st', tw: 0.2 },
    idleC: { torso: 6, head: -6, uarm: -40, farm: -86, th: -60, off: [-10, -84], legs: 'narrow' },
    walk: { torso: 5, front: [-56, 10, -70], off: [16, 24, -60], th: -60 },
    jump: { torso: -4, head: -4, uarm: -120, farm: -40, th: -60, off: [30, -60], legs: [-50, 90, -20, 80] },
    taunt: { torso: 2, head: 6, uarm: -140, farm: -30, th: -40, off: [30, -70], legs: 'narrow', tw: 0.3 },
    victory: { torso: -6, head: 6, uarm: -170, farm: -10, th: -30, off: [-160, -10], legs: 'narrow' },
    moves: {
      nunchakuA: [{ torso: -6, head: 4, uarm: -140, farm: -20, th: -60, off: [30, -70], legs: 'coil', tw: -0.7 },
        { torso: 12, head: -8, uarm: -50, farm: -20, th: -60, off: 'pull', legs: 'drive', tw: 1, dx: 3 },
        { torso: 14, head: -8, uarm: -20, farm: -30, th: -60, off: [36, -70], legs: 'drive', tw: 0.8, dx: 3 }],
      nunchakuB: [{ torso: 8, head: -4, uarm: -30, farm: -30, th: -60, off: [-50, -60], legs: 'st', tw: 0.5 },
        { torso: -2, head: -6, uarm: 30, farm: -90, th: -60, off: [-70, -20], legs: 'drive', tw: -0.8 },
        { torso: -4, head: -6, uarm: 40, farm: -80, th: -60, off: [-74, -16], legs: 'drive', tw: -0.8 }],
      nunchakuSpin: [{ torso: -6, head: 4, uarm: -100, farm: -40, th: -80, off: [20, -80], legs: 'low', tw: -0.6 },
        { torso: 8, head: -4, uarm: -120, farm: -30, th: -20, off: [30, -70], legs: 'wide', tw: 0.6 },
        { torso: 6, head: -4, uarm: -60, farm: -50, th: -60, off: [20, -80], legs: 'wide', tw: 0.4 }],
      slide: [{ torso: 14, head: -6, uarm: -40, farm: -70, th: -60, off: [30, -60], legs: [-30, 60, 30, 40], tw: -0.4 },
        { torso: -34, head: 16, uarm: -50, farm: -60, th: -60, off: [-30, -66], legs: [-66, 8, 34, 46], tw: 0.3, air: true },
        { torso: -28, head: 14, uarm: -50, farm: -60, th: -60, off: [-30, -66], legs: [-60, 14, 34, 50], tw: 0.2, air: true }],
    },
  },
  turtle_purple: {
    idleA: { torso: 2, head: -4, uarm: -40, farm: -44, off: [-40, -50], weapon: 36, legs: 'wide' },
    idleB: { torso: 4, head: -4, uarm: -34, farm: -50, off: [-44, -46], weapon: 28, legs: 'wide', tw: 0.15 },
    idleC: { torso: 0, head: -2, uarm: -10, farm: -40, off: [-20, -40], weapon: -14, legs: 'st' },
    walk: { torso: 4, front: [-36, 6, -46], off: [-40, 8, -50], weapon: 36 },
    jump: { torso: -4, head: -4, uarm: -50, farm: -50, off: [-40, -60], weapon: -70, legs: [-50, 80, -20, 70] },
    taunt: { torso: -6, head: 6, uarm: -30, farm: -70, off: [-60, -50], weapon: -140, legs: 'wide', tw: -0.2 },
    victory: { torso: -8, head: 8, uarm: -140, farm: -30, off: [-150, -20], weapon: -170, legs: 'wide' },
    moves: {
      sweep: [{ torso: -12, head: 6, uarm: -100, farm: -50, off: [-40, -60], weapon: -150, legs: 'coil', tw: -0.6 },
        { torso: 12, head: -6, uarm: -14, farm: -8, off: [26, -40], weapon: -12, legs: 'drive', tw: 0.8 },
        { torso: 16, head: -8, uarm: -4, farm: -10, off: [30, -36], weapon: 6, legs: 'drive', tw: 0.9 }],
      sweepB: [{ torso: 10, head: -6, uarm: -10, farm: -10, off: [30, -40], weapon: 0, legs: 'drive', tw: 0.6 },
        { torso: -4, head: -8, uarm: 20, farm: -30, off: [-20, -50], weapon: -34, legs: 'wide', tw: -0.8 },
        { torso: -6, head: -8, uarm: 24, farm: -30, off: [-24, -50], weapon: -40, legs: 'wide', tw: -0.9 }],
      sweepSpin: [{ torso: -8, head: 6, uarm: 30, farm: -56, off: [-34, -48], weapon: -104, legs: 'low', tw: -0.6 },
        { torso: 6, head: -4, uarm: -30, farm: -30, off: [-26, -40], weapon: -20, legs: 'wide', tw: 0.5 },
        { torso: 10, head: -6, uarm: -44, farm: -24, off: [-30, -42], weapon: -12, legs: 'wide', tw: 0.6 }],
      vaultKick: [{ torso: -5, head: -5, uarm: -40, farm: -60, off: [-30, -70], weapon: -90, legs: [-40, 60, -20, 50], air: true },
        { torso: -24, head: 12, uarm: 40, farm: -40, off: [-30, -60], weapon: -120, legs: [-85, -10, 14, 0], tw: 0.3, air: true },
        { torso: -18, head: 10, uarm: 30, farm: -40, off: [-30, -60], weapon: -110, legs: [-70, 0, 10, 4], tw: 0.2, air: true }],
    },
  },
  teknium: {
    idleA: { torso: -3, head: -3, uarm: -4, farm: -26, th: -72, off: [8, -30], legs: [-10, 12, 8, 4], tw: -0.15 },
    idleB: { torso: -1, head: 1, uarm: -20, farm: -50, th: -70, off: [-30, -96], legs: [-12, 14, 8, 4] },
    idleC: { torso: 1, head: -2, uarm: -8, farm: -34, th: -82, off: [4, -36], legs: [-6, 10, 10, 4], tw: -0.1 },
    walk: { torso: 0, front: [-8, 6, -30], off: [4, 26, -30], th: -72 },
    jump: { torso: -4, head: -4, uarm: -60, farm: -60, th: -60, off: [30, -50], legs: [-50, 70, -10, 40] },
    taunt: { torso: -6, head: 4, uarm: -100, farm: -30, th: -50, off: [-20, -120], legs: 'narrow', tw: -0.3 },
    victory: { torso: -6, head: 6, uarm: -170, farm: -10, th: -20, off: [24, -60], legs: 'narrow' },
    moves: {
      bladeA: [{ torso: -4, head: 2, uarm: -40, farm: -150, th: -50, off: [-50, -40], legs: 'coil', tw: -0.8 },
        { torso: 10, head: -6, uarm: -80, farm: -10, th: -30, off: [30, -90], legs: 'drive', tw: 1, dx: 3 },
        { torso: 14, head: -8, uarm: -50, farm: -10, th: -22, off: [34, -84], legs: 'drive', tw: 0.9, dx: 3 }],
      bladeB: [{ torso: 12, head: -6, uarm: -40, farm: -10, th: -22, off: [20, -90], legs: 'drive', tw: 0.8 },
        { torso: 0, head: -8, uarm: -150, farm: -20, th: -40, off: [-40, -60], legs: 'st', tw: -0.6 },
        { torso: -4, head: -8, uarm: -160, farm: -16, th: -44, off: [-30, -70], legs: 'st', tw: -0.7 }],
      bladeC: [{ torso: -6, head: 2, uarm: 30, farm: -100, th: -22, off: [-60, -50], legs: 'coil', tw: -1 },
        { torso: 16, head: -8, uarm: -84, farm: -2, th: -16, off: [50, -30], legs: 'lunge', tw: 1, dx: 8 },
        { torso: 18, head: -10, uarm: -84, farm: 0, th: -16, off: [52, -26], legs: 'lunge', tw: 1, dx: 8 }],
      dash: [{ torso: 10, head: -6, uarm: 40, farm: -70, th: -40, off: [-50, -50], legs: 'low', tw: -0.9 },
        { torso: 24, head: -14, uarm: -60, farm: -10, th: -20, off: [50, -30], legs: [-50, 50, 40, 0], tw: 1, dx: 10 },
        { torso: 20, head: -12, uarm: -40, farm: -14, th: -24, off: [50, -34], legs: [-46, 46, 38, 2], tw: 0.8, dx: 10 }],
      burst: [{ torso: -10, head: 8, uarm: 20, farm: -120, th: -40, off: [20, -120], legs: 'low', tw: -0.4 },
        { torso: 4, head: -6, uarm: -150, farm: -10, th: -30, off: [-80, -10], legs: 'wide', tw: 0.3, dy: -2 },
        { torso: 6, head: -6, uarm: -130, farm: -20, th: -40, off: [-70, -20], legs: 'wide', tw: 0.3 }],
    },
  },
  nous_girl: {
    idleA: { torso: -3, head: 4, uarm: -10, farm: -50, th: -70, off: [8, -40], legs: [-6, 10, 10, 6], tw: 0.2 },
    idleB: { torso: -2, head: 6, uarm: -6, farm: -60, th: -66, off: [24, -80], legs: [-2, 18, 12, 4], tw: 0.25 },
    idleC: { torso: 0, head: 2, uarm: 20, farm: -30, th: -60, off: [10, -60], legs: 'st' },
    walk: { torso: -1, front: [-8, 14, -50], off: [0, 26, -50], th: -70 },
    jump: { torso: -6, head: 4, uarm: -100, farm: -40, th: -50, off: [-110, -30], legs: [-60, 100, 10, 60] },
    taunt: { torso: -6, head: 10, uarm: -30, farm: -110, th: -60, off: [24, -50], legs: [-2, 8, 14, 10], tw: 0.3 },
    victory: { torso: -8, head: 8, uarm: -170, farm: -10, th: -30, off: [-140, -30], legs: [-30, 70, 6, 4] },
    moves: {
      whipA: [{ torso: -6, head: 4, uarm: 40, farm: -110, th: -60, off: [-50, -40], legs: 'coil', tw: -0.8 },
        { torso: 10, head: -6, uarm: -90, farm: -6, th: -40, off: 'pull', legs: 'drive', tw: 1 },
        { torso: 12, head: -6, uarm: -70, farm: -10, th: -40, off: [30, -80], legs: 'drive', tw: 0.8 }],
      whipB: [{ torso: 6, head: -2, uarm: -120, farm: -60, th: -60, off: [20, -90], legs: 'st', tw: 0.4 },
        { torso: 14, head: -8, uarm: -60, farm: -10, th: -40, off: [40, -70], legs: 'drive', tw: 0.9 },
        { torso: 16, head: -8, uarm: -40, farm: -10, th: -40, off: [40, -70], legs: 'drive', tw: 0.8 }],
      wave: [{ torso: -8, head: 6, uarm: 20, farm: -120, th: -60, off: [-20, -120], legs: 'coil', tw: -0.6 },
        { torso: 8, head: -4, uarm: -86, farm: -4, th: -40, off: [-80, -10], legs: 'drive', tw: 0.3 },
        { torso: 10, head: -4, uarm: -80, farm: -10, th: -40, off: [-76, -14], legs: 'drive', tw: 0.3 }],
      bassDrop: [{ torso: -10, head: 8, uarm: -160, farm: -20, th: -40, off: [-160, -20], legs: [-30, 50, 10, 30], air: true },
        { torso: 30, head: -14, uarm: -40, farm: -20, th: -40, off: [-30, -20], legs: [-50, 90, 30, 70], air: true },
        { torso: 24, head: -12, uarm: -40, farm: -24, th: -40, off: [-30, -24], legs: 'low', air: true }],
    },
  },
  turbofit: {
    idleA: { torso: 8, head: -5, uarm: 4, farm: -16, th: -22, off: [-16, -70], legs: 'wide' },
    idleB: { torso: 10, head: -6, uarm: -20, farm: -60, th: -75, off: [-40, -60], legs: 'wide', tw: 0.15 },
    idleC: { torso: 12, head: -8, uarm: -10, farm: -40, th: -60, off: [-40, -60], legs: 'wide' },
    walk: { torso: 9, front: [2, 6, -18], off: [-16, 26, -60], th: -24 },
    jump: { torso: -4, head: -6, uarm: -80, farm: -40, th: -40, off: [40, -30], legs: [-60, 80, -20, 60] },
    taunt: { torso: 4, head: 14, uarm: 4, farm: -16, th: -22, off: [-100, -60], legs: 'wide', tw: -0.3 },
    victory: { torso: -10, head: -8, uarm: -130, farm: -30, th: -30, off: [-150, -30], legs: 'wide' },
    moves: {
      axe: [{ torso: -14, head: 4, uarm: 140, farm: -10, th: -60, off: [150, -20], legs: [-16, 26, 26, 12], tw: -0.8 },
        { torso: 22, head: -14, uarm: -10, farm: -34, th: -44, off: [-30, -40], legs: [-36, 30, 30, 4], tw: 1, dx: 4 },
        { torso: 28, head: -16, uarm: 0, farm: -24, th: -30, off: [-20, -30], legs: [-40, 40, 30, 4], tw: 0.9, dx: 4 }],
      axeB: [{ torso: 20, head: -10, uarm: -40, farm: -20, th: -40, off: [-30, -30], legs: 'drive', tw: 0.8 },
        { torso: 2, head: -6, uarm: -110, farm: -10, th: -60, off: [20, -80], legs: 'wide', tw: -0.8 },
        { torso: -2, head: -6, uarm: -130, farm: -20, th: -60, off: [26, -80], legs: 'wide', tw: -0.9 }],
      axeHeavy: [{ torso: -20, head: 6, uarm: 145, farm: -8, th: -55, off: [150, -20], legs: [-14, 30, 30, 16], tw: -1, dy: -2 },
        { torso: 30, head: -16, uarm: -12, farm: -24, th: -30, off: [-30, -20], legs: [-44, 46, 34, 2], tw: 1, dx: 6 },
        { torso: 34, head: -18, uarm: -2, farm: -20, th: -24, off: [-16, -20], legs: [-44, 46, 34, 2], tw: 1, dx: 6 }],
      headbang: [{ torso: -10, head: -8, uarm: 20, farm: -30, th: -60, off: [30, -60], legs: 'coil', tw: -0.4 },
        { torso: 30, head: 14, uarm: 30, farm: -40, th: -70, off: [40, -40], legs: [-40, 30, 36, 4], tw: 0.5, dx: 6 },
        { torso: 26, head: 20, uarm: 26, farm: -40, th: -70, off: [40, -44], legs: [-36, 28, 32, 4], tw: 0.4, dx: 6 }],
      chord: [{ torso: -16, head: 8, uarm: 140, farm: -10, th: -50, off: [150, -10], legs: [-20, 30, 20, 10], tw: -0.4, dy: -3 },
        { torso: 26, head: -10, uarm: -30, farm: -6, th: -40, off: [-30, -6], legs: [-40, 60, 30, 40], tw: 0.2 },
        { torso: 30, head: 10, uarm: -30, farm: -6, th: -40, off: [-30, -6], legs: 'low', tw: 0.2 }],
    },
  },
};
HERO_CHAIN.turtle_blue = ['slash', 'slashUp', 'slashSpin'];
HERO_CHAIN.turbofit = ['axe', 'axeB', 'axeHeavy'];
HERO_CHAIN.turtle_purple = ['sweep', 'sweepB', 'sweepSpin'];
const NATIVE = new Set();
const WALK_LEGS = [[-25, 14, 25, 20], [0, 30, 0, 8], [25, 18, -25, 12], [0, 8, 0, 30]];
for (const [h, st] of Object.entries(HERO_STYLE)) {
  const K = n => `${h}_${n}`, set = (n, o) => { POSES[K(n)] = o; NATIVE.add(K(n)); };
  for (const v of ['idleA', 'idleB', 'idleC']) set(v, hp(h, st[v]));
  set('idle', POSES[K('idleA')]);
  set('jump', hp(h, st.jump, { air: true }));
  set('taunt', hp(h, st.taunt)); set('victory', hp(h, st.victory));
  const w = st.walk, base = POSES[K('idleA')];
  WALK_LEGS.forEach((L, i) => {
    const s = [-1, 0, 1, 0][i];   // front leg forward at walk1 -> near arm back, far arm forward
    const o = { ...base, torso: w.torso + (i % 2 ? 0 : 2), head: base.head, thigh: L[0], shin: L[1], thigh_b: L[2], shin_b: L[3], tw: -0.15 * s,
      uarm: w.front[0] - s * w.front[1], farm: w.front[2], uarm_b: w.off[0] + s * w.off[1], farm_b: w.off[2] };
    if (w.th != null) o.weapon = w.th + GRIP_OFF[h]; else if (w.weapon != null) o.weapon = w.weapon;
    set('walk' + (i + 1), o);
  });
  set('turn', { ...POSES.turn, weapon: POSES[K('idleA')].weapon });
  for (const [mv, [wd, ac, fo]] of Object.entries(st.moves)) {
    set(`${mv}_wind`, hp(h, wd, { air: wd.air })); set(`${mv}_active`, hp(h, ac, { air: ac.air })); set(`${mv}_follow`, hp(h, fo, { air: fo.air }));
    set(`${mv}_recover`, POSES[K('idleA')]);
  }
  // Moves this pass didn't author (grab, throw, launcher, back attack, mechanics) keep their shapes but get
  // the hero's stance to recover into, a bent far elbow instead of the stiff forward arm, and planted feet.
  for (const key of Object.keys(POSES)) {
    if (!key.startsWith(h + '_') || NATIVE.has(key)) continue;
    if (/_recover$/.test(key)) { POSES[key] = POSES[K('idleA')]; continue; }
    if (!/_(wind|active|follow)$/.test(key)) continue;
    const o = { ...POSES[key] };
    if ((o.farm_b || 0) > -80 && (o.farm_b || 0) < -25 && (o.uarm_b || 0) > -45 && (o.uarm_b || 0) < 35) o.farm_b = -92;
    POSES[key] = AIR_POSE.test(key) ? o : plant(h, o);
  }
}

// nous_girl's cable whip: the weapon art is the coiled cable, so on a whip hit the
// coil is swapped for a cable lashed out from the fist along the forearm line,
// with a travelling wave and the silver jack plug at the tip.
const LASH = /^nous_girl_(whipA|whipB)_(active|recover)$/;
function lashAmount(poseName, A) {
  if (!LASH.test(poseName)) return 0;
  if (A.__phase === 'active') return 1;
  const t = A.__pt || 0; return Math.max(0, 1 - Math.max(0, t - 0.08) / 0.22);
}
function drawLash(ctx, kind, sol, k, A) {
  const T = TABLES[kind], w = T.weapon, f = T[w.parent], fs = sol.S[w.parent] || [1, 1];
  const hand = apply(sol.M[w.parent], (w.ax - f.px) * fs[0], (w.ay - f.py) * fs[1]), elbow = apply(sol.M[w.parent], 0, 0);
  let dx = hand[0] - elbow[0], dy = hand[1] - elbow[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
  const nx = -dy, ny = dx, L = 118 * k, ph = (A.__pt || 0) * 26, wv = 9 * (1 - 0.5 * k);
  const P = s => [hand[0] + dx * L * s + nx * Math.sin(ph + s * 5) * wv * s, hand[1] + dy * L * s + ny * Math.sin(ph + s * 5) * wv * s + 10 * s * s * (1 - k)];
  ctx.save(); ctx.filter = 'none'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const pts = []; for (let i = 0; i <= 14; i++) pts.push(P(i / 14));
  const line = (wd, col) => { ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.stroke(); };
  line(4.2, '#0d0d14'); line(1.6, '#4a5d9a');
  ctx.strokeStyle = '#2a5cff'; ctx.lineWidth = 4.6; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke(); // blue strain relief
  const e = pts[14], q = pts[13], a = Math.atan2(e[1] - q[1], e[0] - q[0]);
  ctx.translate(e[0], e[1]); ctx.rotate(a); ctx.fillStyle = '#d8dde6'; ctx.fillRect(-2, -2.2, 9, 4.4); ctx.fillStyle = '#8a929e'; ctx.fillRect(3, -2.2, 1.2, 4.4);
  ctx.restore();
}

export function createRig() {
  const images = {};
  const drawn = {};
  for (const [kind, table] of Object.entries(TABLES)) {
    images[kind] = {}; drawn[kind] = 0;
    const seen = new Set();
    for (const part of Object.values(table)) {
      if (seen.has(part.file)) continue;
      seen.add(part.file);
      const im = new Image();
      im.onload = () => { images[kind][part.file] = im; };
      im.src = IMAGE_DIR(kind) + part.file;
    }
  }

  // A rig is usable once its torso art has decoded; until then callers fall back.
  const ready = kind => !!(TABLES[kind] && TABLES[kind].torso && images[kind] && images[kind][TABLES[kind].torso.file]);

  // Per-entity angle blend state: poses are eased rather than snapped, which is
  // what makes idle -> walk -> punch -> jump read as one continuous motion.
  const blend = new Map();
  const BLEND_RATE = 16;

  function eased(key, angles, dt, table) {
    let cur = blend.get(key);
    if (!cur) {
      cur = {};
      for (const name of Object.keys(table || TABLES.turtle)) cur[name] = angles[name] || 0;
      cur.weapon = angles.weapon || 0;
      blend.set(key, cur);
      return cur;
    }
    const k = 1 - Math.exp(-(dt || 1 / 60) * BLEND_RATE);
    for (const name of Object.keys(cur)) {
      if (name === 'weapon') { cur.weapon += ((angles.weapon || 0) - cur.weapon) * k; continue; }
      cur[name] += ((angles[name] || 0) - cur[name]) * k;
    }
    return cur;
  }

  function draw(ctx, kind, pose, x, y, flip = false, scale = 1, key = null, dt = 1 / 60, tint = 'none') {
    const table = TABLES[kind];
    if (!table || !ready(kind)) return false;
    // Compose whatever the caller already set (a boss tint, a hit flash) with the
    // palette tint, so a palette never erases one of those.
    const callFilter = (ctx.filter && ctx.filter !== 'none' ? ctx.filter + ' ' : '') + (tint && tint !== 'none' ? tint : '');
    const baseTint = callFilter.trim() ? callFilter.trim() + ' ' : '';
    const poseName = typeof pose === 'string' ? pose : (pose && pose.__pose) || ''; // rig QA: anim.js tags its angle objects
    const target = typeof pose === 'string' ? (POSES[pose] || POSES.idle) : (pose || POSES.idle);
    const angles = key ? eased(kind + ':' + key, target, dt, table) : target;
    const sol = solve(kind, angles, { poseName, animated: typeof pose !== 'string' && !!(pose && pose.__pose) });
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.scale(-1, 1);
    if (scale !== 1) ctx.scale(scale, scale);
    const lash = kind === 'nous_girl' ? lashAmount(poseName, angles) : 0;
    const smearPart = sol.order.includes('weapon') ? 'weapon' : 'farm';
    for (const name of sol.order) {
      const part = table[name], img = images[kind][part.file];
      if (!img) continue;
      if (name === 'weapon' && lash > 0.35) { drawLash(ctx, kind, sol, lash, angles); continue; }
      // smear: the strike leaves ghost copies of the weapon (or the striking fist) along its arc
      if (name === smearPart && angles.__trail && HERO_RIGS[kind]) {
        angles.__trail.forEach((g, i) => {
          const gs = solve(kind, g, { poseName, animated: true }), gm = gs.M[name], gsc = gs.S[name];
          if (!gm) return;
          ctx.save(); ctx.globalAlpha = (i ? 0.16 : 0.32) * (ctx.globalAlpha || 1);
          ctx.transform(gm[0], gm[1], gm[2], gm[3], gm[4], gm[5]); ctx.scale(gsc[0], gsc[1]);
          ctx.filter = baseTint + 'brightness(1.8) saturate(0.6)';
          ctx.drawImage(img, -part.px, -part.py); ctx.restore();
        });
      }
      const m = sol.M[name], s = sol.S[name];
      ctx.save();
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      if (s[0] !== 1 || s[1] !== 1) ctx.scale(s[0], s[1]);
      if (part.back) ctx.filter = baseTint + (BACK_TINT[kind] || BACK_TINT_DEFAULT);
      else if (baseTint) ctx.filter = baseTint.trim();
      ctx.drawImage(img, -part.px, -part.py);
      ctx.restore();
      if (name === 'weapon' && lash > 0) { ctx.save(); ctx.globalAlpha *= lash; drawLash(ctx, kind, sol, lash, angles); ctx.restore(); }
    }
    ctx.filter = 'none';
    ctx.restore();
    drawn[kind] += 1;
    return true;
  }

  // Pick the pose from the live combat state, so the rig reflects what the player is
  // actually doing: turn -> air -> telegraphed wind-up -> strike. The hero picked on
  // the select screen supplies the weapon animations for each hit of the chain.
  const heroKind = state => {
    if (!state) return 'turtle_purple';
    // game.js carries the select-screen pick as selectedHero; state.hero is the
    // equivalent slot for anything driving the rig directly.
    const id = state.hero || state.selectedHero;
    return id && HERO_CHAIN[id] ? id : 'turtle_purple';
  };

  function heroPose(state, c) {
    const hero = heroKind(state);
    const chain = HERO_CHAIN[hero] || [];
    const phase = c.phase === 'wind' ? 'wind' : c.phase === 'active' ? 'active' : 'recover';
    // An attack that names its own move (a launcher, a grab, a mechanic from the
    // combat rework) plays that move for this hero; otherwise the chain decides,
    // which is what makes each hit of a 3-hit combo look different.
    const named = c.attack && c.attack.name ? `${hero}_${c.attack.name}_${phase}` : null;
    if (named && POSES[named] && !/^(?:punch|kick|jumpKick)$/.test(c.attack.name)) return named;
    const kicking = c.attack.name === 'kick' || c.attack.air;
    const move = kicking
      ? (HERO_KICK[hero] || chain[chain.length - 1])
      : chain[Math.min(chain.length, Math.max(1, c.chain || 1)) - 1];
    const name = `${hero}_${move}_${phase}`;
    return POSES[name] ? name : null;
  }

  function playerPose(state, t = 0) {
    const c = state.combat;
    if (!c) return 'idle';
    const hero = heroKind(state);
    const K = name => (POSES[`${hero}_${name}`] ? `${hero}_${name}` : name);
    // Beats that outrank everything: victory pose, a taunt, then being down.
    if (state.victory) return K('victory');
    if (state.taunt > 0) return K('taunt');
    // Being down or held outranks attacking, so a knocked-down player reads as down.
    if (c.down > 0) return K('down');
    if (c.wake > 0) return K('wake');
    if (c.grab) return K('grabHold');
    if (c.turnT > 0) return K('turn');
    if (c.airborne) {
      // A jump kick still needs its own wind-up and strike, so an airborne attack
      // plays the hero's kick move rather than a plain jump pose.
      if (c.attack && c.attack.air) {
        const airPose = heroPose(state, c);
        if (airPose) return airPose;
      }
      return K('jump');
    }
    if (c.attack) {
      const heroSpecific = heroPose(state, c);
      if (heroSpecific) return heroSpecific;
      const kicking = c.attack.name === 'kick' || c.attack.air;
      if (c.phase === 'wind') return kicking ? 'kickWind' : 'punchWind';
      if (c.phase === 'active') return kicking ? 'kick' : 'punch';
      return K('idle');
    }
    if (c.moving) return K(WALK[Math.floor(c.walkT * 8) % WALK.length]);
    // Standing still is not one pose: the idle variants rotate on a timer, offset
    // per hero so two heroes side by side are not in lockstep.
    return idleVariantAt(hero, t);
  }

  // Enemies walk the same table: they are mirrored, so no angle negation needed.
  // Enemy moves are driven by whatever the AI sets: ninja.move + ninja.phase, or a
  // ninja.attack { move, phase } record. Unknown moves fall back, never throw.
  // Reaction states come first, because being knocked down outranks anything the AI
  // was doing: down > wake > held > airborne/knockdown > stagger > flinch.
  function enemyPose(ninja, t) {
    if (!ninja || ninja.dead) return 'idle';
    const kind = ninja.kind;
    const K = name => (kind && POSES[`${kind}_${name}`] ? `${kind}_${name}` : name);
    if (ninja.down > 0) return K('down');
    if (ninja.wake > 0) return K('wake');
    if (ninja.grabbed) return K('grabbed');
    if (ninja.falling || ninja.react === 'launch' || ninja.react === 'knockdown' || ninja.react === 'thrown') return K('knockdownAir');
    if (ninja.react === 'stagger') return K('stagger');
    if (ninja.stun > 0 || ninja.hitFlash > 0 || ninja.react === 'flinch') return K('flinch');
    const atk = ninja.attack || {};
    const move = ninja.move || atk.move;
    const phase = ninja.phase || atk.phase;
    if (kind && move && phase && POSES[`${kind}_${move}_${phase}`]) return `${kind}_${move}_${phase}`;
    if (ninja.guard && POSES.blocker_guard_wind) return 'guard';
    const speed = Math.abs(ninja.vx || 0);
    if (speed > 4) return WALK[Math.floor((t || 0) * 6) % WALK.length];
    return 'idle';
  }

  // Names of each type's moves, for the AI side and for verification.
  const movesFor = kind => Object.keys(ENEMY_MOVES[kind] || {});

  return { draw, ready, playerPose, enemyPose, heroKind, movesFor, images, stats: drawn, blend };
}
