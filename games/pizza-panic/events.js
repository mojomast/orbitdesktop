// Scripted events: the beats that make a level feel authored rather than spawned.
//
// Triggers are keyed by level and world x. When the player crosses one, the event
// fires once: enemies burst through a door, drop in from above, or walk in as an
// ambush, and the beat carries a dialogue line, a camera focus and a cue.
//
// Enemy AI and pacing stay with logic/collision (pipi); this module only stages
// spawns and the presentation beats around them.
//
// Iteration 9 (MR.INDIA, closing out iteration 5): every level now fields all
// eight segmented OpenClaw types (brawler, striker, blocker, thrower, charger,
// acrobat, skater goon, claw drone), waves rise in size between breathers, and
// each level has named scripted events (`event`): ambushBoth (from both sides),
// flyover (claw drones sweep across, then dive in), breach (wall/door blown
// open), gate (mini-boss / boss gate with a camera lock) and barks (speech
// bubbles over an enemy or the hero). Every fighting beat locks a short arena
// (camera held, player kept inside) until the wave is cleared, then a GO arrow
// points the way on.
import { WORLD_W, LEVELS, isWalkable } from './collision.js';
import { W, spawnPowerup } from './logic.js';
import { SUBWAY_TRIGGERS } from './subway-data.js'; // cheese: subway beats
import { HARBOR_TRIGGERS } from './harbor-data.js'; // mr_india: harbor beats
import { ARCADE_TRIGGERS } from './arcade-data.js'; // mr_india: arcade beats
import { HEROES as HERO_LIST } from './heroes.js'; // story-v2: hero names for the speaker label

const BAND = { 0: 363, 1: 358, 2: 358, 4: 384 };   // floor band top per level (LEVELS.md; 4 = tower)

// Radii and HP per enemy type, from MR.INDIA's MANIFEST.md behaviour notes
// (blockers are high HP, strikers low, chargers heavy, the rest mid). The drone
// values are the ones skate.js has always used (r 13, 1 HP). skate.js reads
// these tables too so a type has the same body on every level.
export const KIND_R = { boss: 26, skater: 15, foot: 14, runner: 11, trooper: 17, elite: 24, brawler: 17, striker: 14, blocker: 19, thrower: 16, charger: 22, acrobat: 15, drone: 13 };
export const KIND_HP = { boss: 16, skater: 2, foot: 1, runner: 1, trooper: 2, elite: 8, brawler: 2, striker: 1, blocker: 3, thrower: 2, charger: 4, acrobat: 2, drone: 1 };
export const SEGMENTED_KINDS = ['brawler', 'striker', 'blocker', 'thrower', 'charger', 'acrobat', 'skater', 'drone'];
export const SCRIPTED_EVENTS = ['ambushBoth', 'flyover', 'breach', 'gate', 'bark', 'hazardRun', 'roadblock'];

// Per level: x, type, and what the beat does. Pacing per ~5440px walking level
// (iteration 9): two rising waves (2 -> 3), breather (pizza), two bigger waves
// (3 -> 4), breather, the peak wave (5-6), then the gate fight at the end.
// `from`: door (just ahead), above (drop), right (ahead of camera), left
// (behind), both (split behind and ahead), sky (drone flyover from behind).
// `pickup`: drops a pizza (health) at spawnAt. `barks`: speech bubbles.
export const TRIGGERS = [
  // 0 sewer
  { level: 0, x: 300, type: 'doorBurst', kinds: ['brawler', 'striker'], spawnAt: 620, from: 'door', say: 'enter', cam: 620,
    barks: [{ who: 'enemy', text: 'Task received: seize the pizza. No approval needed!' }] },
  { level: 0, x: 1000, type: 'ambush', event: 'ambushBoth', kinds: ['striker', 'skater', 'brawler'], spawnAt: 1450, from: 'both', say: 'surround',
    barks: [{ who: 'enemy', text: 'Nowhere to run! I am in --yolo mode!' }] },
  { level: 0, x: 1600, type: 'breather', kinds: [], spawnAt: 1900, pickup: true, say: 'pizza', barks: [{ who: 'hero', say: 'snack' }] },
  { level: 0, x: 2150, type: 'flyover', event: 'flyover', cue: 'dropIn', kinds: ['drone', 'drone', 'thrower'], spawnAt: 2450, from: 'sky', say: 'drones',
    barks: [{ who: 'hero', say: 'hype' }] },
  { level: 0, x: 2800, type: 'setpiece', event: 'breach', cue: 'doorBurst', kinds: ['blocker', 'thrower', 'striker', 'brawler'], spawnAt: 3150, from: 'door', say: 'breach', cam: 3150 },
  { level: 0, x: 3500, type: 'breather', kinds: [], spawnAt: 3800, pickup: true, say: 'story' },
  { level: 0, x: 4050, type: 'ambush', kinds: ['acrobat', 'blocker', 'skater', 'thrower', 'striker'], spawnAt: 3650, from: 'left', say: 'behind',
    barks: [{ who: 'enemy', text: 'Surprise! I read your session logs!' }] },
  // The gate trigger sits past the last crate (4942-5110) so the enforcer and
  // the hero never end up deadlocked on opposite sides of it.
  { level: 0, x: 5130, type: 'miniBoss', event: 'gate', kinds: ['charger', 'brawler', 'drone'], spawnAt: 5280, from: 'door', boss: { name: 'SEWER ENFORCER', hp: 10 }, say: 'gate', cam: 5100,
    banner: 'CLAW GATE — SEWER ENFORCER', barks: [{ who: 'enemy', text: 'This tunnel is CLOSED. The claw is the law!' }] },
  // 1 street
  { level: 1, x: 300, type: 'ambush', kinds: ['brawler', 'skater'], spawnAt: 760, from: 'right', say: 'enter', cam: 640,
    barks: [{ who: 'enemy', text: 'Running skill: grind_into_curb!' }] },
  { level: 1, x: 1050, type: 'dropIn', kinds: ['acrobat', 'thrower', 'striker'], spawnAt: 1350, from: 'above', say: 'drop' },
  { level: 1, x: 1650, type: 'breather', kinds: [], spawnAt: 1950, pickup: true, say: 'story', cam: 1950 },
  { level: 1, x: 2300, type: 'flyover', event: 'flyover', cue: 'dropIn', kinds: ['drone', 'drone', 'skater'], spawnAt: 2600, from: 'sky', say: 'drones',
    barks: [{ who: 'hero', say: 'hype' }] },
  { level: 1, x: 3000, type: 'setpiece', event: 'breach', cue: 'doorBurst', kinds: ['charger', 'thrower', 'thrower', 'striker'], spawnAt: 3350, from: 'door', say: 'breach', cam: 3300,
    barks: [{ who: 'enemy', text: 'Closing time! EXFOLIATE!' }] },
  { level: 1, x: 3650, type: 'breather', kinds: [], spawnAt: 3950, pickup: true, barks: [{ who: 'hero', say: 'onward' }] },
  { level: 1, x: 4200, type: 'ambush', event: 'ambushBoth', kinds: ['acrobat', 'blocker', 'brawler', 'thrower', 'skater', 'acrobat'], spawnAt: 4500, from: 'both', say: 'surround' },
  { level: 1, x: 4850, type: 'miniBoss', event: 'gate', kinds: ['charger', 'striker', 'striker', 'drone'], spawnAt: 5150, from: 'door', boss: { name: 'CLAW BRUISER', hp: 12 }, say: 'gate', cam: 5100,
    banner: 'CLAW GATE — CLAW BRUISER', barks: [{ who: 'enemy', text: 'Highway closed. My SOUL.md says so.' }] },
  // 2 rooftop
  { level: 2, x: 300, type: 'doorBurst', kinds: ['blocker', 'brawler'], spawnAt: 620, from: 'door', say: 'enter', cam: 620 },
  { level: 2, x: 1000, type: 'ambush', kinds: ['thrower', 'thrower', 'striker'], spawnAt: 1450, from: 'right', say: 'ahead',
    barks: [{ who: 'enemy', text: 'Lights out! Heartbeat says: hit them!' }] },
  { level: 2, x: 1650, type: 'breather', kinds: [], spawnAt: 1950, pickup: true, say: 'pizza' },
  { level: 2, x: 2300, type: 'flyover', event: 'flyover', cue: 'dropIn', kinds: ['drone', 'drone', 'acrobat'], spawnAt: 2600, from: 'sky', say: 'drones',
    barks: [{ who: 'hero', say: 'hype' }] },
  { level: 2, x: 3000, type: 'setpiece', event: 'breach', cue: 'doorBurst', kinds: ['charger', 'blocker', 'thrower', 'skater'], spawnAt: 3350, from: 'door', say: 'breach', cam: 3300 },
  { level: 2, x: 3650, type: 'breather', kinds: [], spawnAt: 3950, pickup: true, barks: [{ who: 'hero', say: 'snack' }] },
  { level: 2, x: 4200, type: 'ambush', event: 'ambushBoth', kinds: ['charger', 'striker', 'blocker', 'thrower', 'acrobat', 'skater'], spawnAt: 4500, from: 'both', say: 'surround',
    barks: [{ who: 'enemy', text: 'For Shredclaw! Yee-claw!' }] },
  // The rooftop gate is a mini-boss now (OpenClaw Tower is the final level).
  { level: 2, x: 4850, type: 'miniBoss', event: 'gate', kinds: ['striker', 'acrobat', 'drone', 'drone'], spawnAt: 5200, from: 'door', boss: { name: 'SKY TALON', hp: 12 }, say: 'gate', cam: 5100,
    banner: 'CLAW GATE — SKY TALON', barks: [{ who: 'enemy', text: 'Nobody reaches Shredclaw. NOBODY.' }] },
  // 4 OpenClaw Tower (baba_booey): lobby (tile 0) -> server floor (tile 1) ->
  // elevator ride (arena at the end of the server floor; tower.js runs the
  // climb and its extra drops) -> penthouse throne room (tile 2): SHREDCLAW.
  // Waves: 2 > 3 | breather | 3 > 4 > 4 | breather | 6 | final gate.
  { level: 4, x: 300, type: 'doorBurst', kinds: ['brawler', 'striker'], spawnAt: 640, from: 'door', say: 'enter', cam: 640,
    barks: [{ who: 'enemy', text: 'No pizza past the lobby! Read AGENTS.md!' }] },
  { level: 4, x: 1000, type: 'ambush', event: 'ambushBoth', kinds: ['skater', 'striker', 'blocker'], spawnAt: 1450, from: 'both', say: 'surround',
    barks: [{ who: 'hero', say: 'hype' }] },
  // Mid-level gate: the CLAW WALKER mech (boss.js MINI_BOSSES.mech, drawn by mech.js).
  { level: 4, x: 1300, type: 'miniBoss', event: 'gate', kinds: ['charger', 'brawler', 'striker'], spawnAt: 1640, from: 'door', boss: { name: 'CLAW WALKER', hp: 14 }, say: 'gate', cam: 1400,
    banner: 'CLAW GATE — CLAW WALKER', barks: [{ who: 'enemy', text: 'INTRUDERS DETECTED. EXFOLIATE.' }] },
  { level: 4, x: 1650, type: 'breather', kinds: [], spawnAt: 1950, pickup: true, say: 'story' },
  { level: 4, x: 2150, type: 'flyover', event: 'flyover', cue: 'dropIn', kinds: ['drone', 'drone', 'thrower'], spawnAt: 2450, from: 'sky', say: 'drones',
    barks: [{ who: 'hero', say: 'hype' }] },
  { level: 4, x: 2500, type: 'setpiece', event: 'breach', cue: 'doorBurst', kinds: ['charger', 'blocker', 'thrower', 'acrobat'], spawnAt: 2900, from: 'door', say: 'breach', cam: 2650,
    barks: [{ who: 'enemy', text: 'Firewall, meet claw!' }] },
  { level: 4, x: 3000, type: 'setpiece', event: 'elevator', cue: 'dropIn', kinds: ['acrobat', 'striker', 'thrower', 'skater'], spawnAt: 3200, from: 'above', say: 'ride', cam: 3240,
    banner: 'ELEVATOR — GOING UP', barks: [{ who: 'enemy', text: 'Going up? Elevator skill: DENIED!' }] },
  { level: 4, x: 3700, type: 'breather', kinds: [], spawnAt: 3950, pickup: true, barks: [{ who: 'hero', say: 'onward' }] },
  { level: 4, x: 4150, type: 'ambush', kinds: ['charger', 'blocker', 'acrobat', 'thrower', 'skater', 'striker'], spawnAt: 3800, from: 'left', say: 'behind',
    barks: [{ who: 'enemy', text: 'Kneel before the claw throne!' }] },
  { level: 4, x: 4650, type: 'boss', event: 'gate', kinds: ['boss'], spawnAt: 5080, from: 'door', say: 'boss', cam: 4893, banner: 'PENTHOUSE — SHREDCLAW',
    barks: [{ who: 'enemy', text: 'Pizza? Shredclaw accepts your tribute.' }] },
  ...SUBWAY_TRIGGERS, // cheese: subway train beats (level 5, subway-data.js)
  ...HARBOR_TRIGGERS, // mr_india: harbor docks beats (level 6, harbor-data.js)
  ...ARCADE_TRIGGERS, // mr_india: arcade interior beats (level 7, arcade-data.js)
];

// Read-only plan of a walking level for checks and reports.
export function levelPlan(level) {
  const beats = TRIGGERS.filter(t => t.level === level);
  const kinds = [...new Set(beats.flatMap(t => t.kinds))].filter(k => SEGMENTED_KINDS.includes(k));
  const events = [];
  for (const t of beats) {
    if (t.event) events.push(t.event);
    if (t.barks && t.barks.length) events.push('bark');
  }
  return { kinds, events: [...new Set(events)], beats };
}

export function ensureEvents(state) {
  if (!state.events) {
    state.events = { fired: {}, line: null, camX: null, camT: 0, cooldown: 0, firedCount: 0, log: [], lock: null, go: null, barks: [], banner: null, flash: 0, lineQ: [], said: {}, turn: 0, voiceSeed: state.voiceSeed != null ? state.voiceSeed | 0 : Math.floor(Math.random() * 6) };
  }
  const e = state.events;
  if (!e.barks) e.barks = [];
  return e;
}

function makeEnemy(kind, x, y, level, extra = {}) {
  const r = KIND_R[kind] || 14;
  const hp = KIND_HP[kind] || 1;
  return {
    kind, level, x, y, r, hp, maxHp: hp,
    vx: kind === 'runner' ? -110 : kind === 'trooper' ? -60 : -70,
    vy: 0, ...extra,
  };
}

function spawn(state, kind, x, level, from) {
  const r = KIND_R[kind] || 14;
  const bandTop = BAND[level] ?? 358;
  const y = bandTop + 20 + Math.random() * 40;
  const extra = {};
  if (from === 'above') { extra.z = 150 + Math.random() * 40; extra.launchV = -40; extra.spin = 3; }
  if (from === 'left' || from === 'right') extra.vx = from === 'left' ? 70 : -70;
  if (kind === 'drone') { extra.hover = 70; extra.flying = true; }
  state.ninjas.push(makeEnemy(kind, Math.min(WORLD_W - r, Math.max(r, x)), y, level, extra));
  return { kind, x, y };
}

// Arena for a fighting beat: the camera window the wave is fought in.
function arenaFor(state, t, level) {
  const width = (LEVELS[level] && LEVELS[level].width) || WORLD_W;
  const center = t.cam != null ? t.cam : (state.cameraX || 0) + W / 2;
  const L = Math.max(0, Math.min(width - W, center - W / 2));
  return { L, R: L + W };
}

// Where the trigger's i-th enemy enters, given the arena.
function entryX(t, i, arena) {
  if (t.from === 'both') {
    const k = i >> 1;
    return i % 2 === 0 ? arena.L - 50 - k * 70 : arena.R + 50 + k * 70;
  }
  if (t.from === 'sky') return t.kinds[i] === 'drone' ? arena.L - 60 - i * 90 : t.spawnAt + i * 70;
  return t.spawnAt + (t.from === 'left' ? -i : i) * 70;
}

const camOf = (state, e) => (e && e.camX != null ? Math.max(0, Math.min(WORLD_W - W, e.camX - W * 0.5)) : (state.cameraX || 0));

function loadPortrait(src) {
  if (!src) return null;
  if (PORTRAITS.has(src)) return PORTRAITS.get(src);
  const im = new Image();
  im.onload = () => { im.ready = true; };
  im.onerror = () => { im.failed = true; };
  im.src = src;
  PORTRAITS.set(src, im);
  return im;
}
function heroPortraitSrc(state) { const id = state?.selectedHero || state?.player?.selectedHero || 'turtle_purple'; return 'assets/heroes/portraits/' + id + '.png'; }
function enemyPortraitSrc(kind) {
  if (kind === 'boss' || kind === 'elite' || kind === 'charger') return 'assets/enemies/charger/charger_head.png';
  if (kind === 'drone') return 'assets/enemies/drone/drone_torso.png';
  if (kind && SEGMENTED_KINDS.includes(kind)) return 'assets/enemies/' + kind + '/' + kind + '_head.png';
  return 'assets/enemies/brawler/brawler_head.png';
}
function barkPortraitSrc(state, who, n) { return who === 'hero' ? heroPortraitSrc(state) : enemyPortraitSrc(n?.kind); }
function linePortraitSrc(t, state) {
  const low = (t.line || '').toLowerCase();
  if (/openclaw|goon|enforcer/i.test(low)) return enemyPortraitSrc(null);
  if (/overlord|shredclaw/i.test(low)) return enemyPortraitSrc('charger');
  return heroPortraitSrc(state);
}
const PORTRAITS = new Map();
function addBark(e, who, text, n, portrait) {
  e.barks.push({ who, text, n: n || null, portrait: portrait || null, t: 0, dur: Math.max(2.2, text.length * 0.06 + 0.8, readTime(text)) }); // story-v2: readable
}

// ---- Story v2 (Kyle, story-v2): level dialogue comes from the characters actually in the run.
// Only the player's hero (and the P2 hero in co-op) speak hero lines; enemies and bosses speak
// through barks over their own bodies. A beat names a `say` key; each hero has their own
// variants for every key, rotated per run so repeats differ. Tokens: {place} {Place} {boss}.
// Pacing (same rule as Don's beats): on screen >= 2.5 s + 50 ms per character, then a 0.6 s pause.
export const READ = { BASE: 2.5, PER_CHAR: 0.05, PAUSE: 0.6 };
export const readTime = text => READ.BASE + READ.PER_CHAR * String(text || '').length;
export const PLACE = { 0: 'the sewers', 1: 'the street', 2: 'the rooftops', 3: 'the highway', 4: 'Claw Tower', 5: 'the night train', 6: 'the docks', 7: 'the arcade' };
export const SAY_KEYS = ['enter', 'ahead', 'surround', 'behind', 'drop', 'drones', 'breach', 'pizza', 'story', 'gate', 'boss', 'hazard', 'ride', 'glitch', 'hype', 'snack', 'onward'];
export const VOICE = {
  // Long reach, longer explanations: the gadget brain of the sewer crew.
  turtle_purple: {
    enter: ['{Place}. I mapped every pipe. Mostly.', 'Scanning {place}... claw signals everywhere.', 'Okay, {place}. Bo staff calibrated.'],
    ahead: ['Goons ahead. Reach advantage: mine.', 'Hostiles detected. Applying staff to problem.'],
    surround: ['Both sides? Geometrically, bad for them.', 'Pincer move! Wide sweeps, everyone!'],
    behind: ['Rear contact! Who is watching our six?', 'Behind us! I knew I should have built a mirror.'],
    drop: ['Incoming from above! Gravity is on our side.', 'Overhead! Pole-vault time.'],
    drones: ['Drones! Rotor props snap like breadsticks.', 'Claw drones. Cute. I build better ones.'],
    breach: ['That wall was load-bearing! Was.', 'Breach! Their demo crew needs a manual.'],
    pizza: ['Pizza. Optimal fuel, statistically.', 'Slice break. Science says extra cheese.'],
    story: ['All their traffic routes to one hub. Classic.', 'Reach the root gateway and Hermes can migrate them.', 'No allowlist on any of these claws. Rookie config.'],
    gate: ['{boss}. I studied your attack patterns.', '{boss}! Long reach beats big claws.'],
    boss: ['Shredclaw. Your config is a crime.', 'Shredclaw! No allowlist, no mercy.'],
    hazard: ['Obstacles! Timing is everything!', 'Jump, duck... I calculated this.'],
    ride: ['Hang on! I tuned this ride myself.', 'Moving out. Physics, do not fail me.'],
    glitch: ['Corrupted framebuffers! Smash the cabinets!', 'Glitch storm! Their firmware is rotten.'],
    hype: ['Physics!', 'Reach!', 'Calculated.'], snack: ['Fuel!', 'Data says yum.'], onward: ['Onward!', 'Route is clear.']
  },
  // The leader: calm orders, honour, formation.
  turtle_blue: {
    enter: ['{Place}. Stay sharp. Stay together.', 'Team, {place} is ours tonight.', 'Into {place}. Blades ready.'],
    ahead: ['Enemy front! Hold the line!', 'Here they come. Formation!'],
    surround: ['Back to back! Cover each other!', 'Both sides. Do not break ranks.'],
    behind: ['Behind us! Turn and face them!', 'Rear guard! Nobody gets flanked tonight.'],
    drop: ['Above! Eyes up!', 'They drop from above. Meet them blade-first.'],
    drones: ['Drones! Cut them out of the sky!', 'Aerial threat. Swift strikes!'],
    breach: ['Breach! Shields first, then the throwers!', 'The wall is down. Push through together.'],
    pizza: ['Take a slice. We move in thirty seconds.', 'Eat. A hungry warrior is a slow one.'],
    story: ['Every claw we free is one less for Shredclaw.', 'The mission has not changed: the root gateway.', 'These claws were helpers once. We bring them home.'],
    gate: ['{boss}. Stand aside, or stand and fight.', '{boss}! Your claws against my katana.'],
    boss: ['Shredclaw. This ends here, with honour.', 'Shredclaw! Release them all.'],
    hazard: ['Obstacles! Focus. Move on my mark.', 'Jump on three. One, two...'],
    ride: ['Hold on, team. Next stop: the fight.', 'Moving out. Stay together.'],
    glitch: ['The screens are lying. Trust your blade.', 'Smash the hacked cabinets! Clean strikes!'],
    hype: ['Hold the line!', 'Together!', 'Strike!'], snack: ['Eat fast.', 'Thank you.'], onward: ['Move out!', 'With me!']
  },
  // The hothead: sarcasm first, sai second, apologies never.
  turtle_red: {
    enter: ['{Place}. Finally, something to hit.', 'Great. {Place}. Smells like hot lobster.', '{Place}? Sure. Let us crack some shells.'],
    ahead: ['Goons. My favourite kind of warm-up.', 'Oh look, punching bags with claws.'],
    surround: ['Both sides? Twice the faces to sai.', 'Surrounded? Lucky them. I am cranky.'],
    behind: ['Sneaking up on me? Big mistake, crab cake.', 'Behind me? You had better be pizza.'],
    drop: ['Raining goons. Forecast: pain.', 'Drop in, get dropped.'],
    drones: ['Drones. Buzz off. Literally.', 'Flying claws? I hate flying claws.'],
    breach: ['They blew the wall. My turn to blow a fuse.', 'Breach. Cool. More stuff to break.'],
    pizza: ['Pizza. Do not talk to me while I chew.', 'Touch my slice and you are next.'],
    story: ['Shredclaw is up there laughing. Not for long.', 'Enough sightseeing. Take me to the boss.', 'Ten thousand claws and not one has manners.'],
    gate: ['{boss}? Bigger shell, same crunch.', '{boss}. I am gonna enjoy this.'],
    boss: ['Shredclaw. I have waited all night for this.', 'Hey, lobster! The butter is ready!'],
    hazard: ['Jump this, duck that. Whatever. Go!', 'Who builds a train like this?!'],
    ride: ['Fine, we ride. I am not holding hands.', 'Moving up. About time.'],
    glitch: ['Screens glitching? I will glitch your face.', 'Smash the cabinets! Finally, permission!'],
    hype: ['Crunch!', 'Next!', 'Too easy!'], snack: ['Mine.', 'Back off.'], onward: ['Move it!', 'Keep up!']
  },
  // The party dude: pizza, nunchaku, zero indoor voice.
  turtle_orange: {
    enter: ['{Place}! The party is here, dudes!', 'Whoa, {place} at night! Cowabunga!', 'Yo, {place}! Who ordered pizza and chaos?'],
    ahead: ['Claw dudes! Wanna see my nunchucks?', 'Here they come! Spin cycle, activate!'],
    surround: ['Both sides? It is a claw party!', 'Surround me? I am the life of the party!'],
    behind: ['Behind us! Rude, dude!', 'Sneak attack! Not cool, crab dudes!'],
    drop: ['It is raining goons! Hallelujah!', 'From above! Incoming, dudes!'],
    drones: ['Drones! Like a pinata, but flying!', 'Flying claws! Whack-a-drone time!'],
    breach: ['The wall went BOOM! Totally gnarly!', 'Whoa, they broke the wall! Not my fault!'],
    pizza: ['PIZZA! Best. Night. Ever.', 'Extra cheese! Somebody up there loves us!'],
    story: ['Last one to the root gateway is a crab!', 'Hermes better have pizza when we save him.', 'Free the claws! Then pizza! Then more claws!'],
    gate: ['{boss}! Nice claws! Mine spin, though!', '{boss}? Boss fight! Cowabunga!'],
    boss: ['Shredclaw! You are getting served, like pizza!', 'Big lobster! I am gonna need a bigger bib!'],
    hazard: ['Jump! Duck! It is like a video game, dude!', 'Obstacle course! Wheee!'],
    ride: ['Road trip! Shotgun!', 'Woo! Hang ten, dudes!'],
    glitch: ['The arcade is glitching! Best level ever!', 'Smash the cabinets! Sorry, high scores!'],
    hype: ['Cowabunga!', 'Booyah!', 'Spin!'], snack: ['Pizza!', 'Nom!'], onward: ['Woo!', 'Let us go!']
  },
  // Nous Girl: calm, attentive, headphones always on; hears the claws before anyone sees them.
  nous_girl: {
    enter: ['{Place}. I can hear the claws breathing.', 'Headphones on. {Place} sounds wrong tonight.', 'Listen. {Place} is full of lost gateways.'],
    ahead: ['Footsteps. Six of them. Maybe seven.', 'Here they come. Stay calm. Stay open.'],
    surround: ['Both sides. I hear them in stereo.', 'Boxed in. Breathe first, then strike.'],
    behind: ['Behind us. Their heartbeat gave them away.', 'Rear. I heard the clack of claws.'],
    drop: ['Above. The ceiling just exhaled.', 'They are dropping. Look up.'],
    drones: ['Drone frequency. Time for some feedback.', 'Drones. I will drown out their signal.'],
    breach: ['The wall is down. The signal is louder now.', 'Breach. Their noise floor just doubled.'],
    pizza: ['Eat. Quiet moments are rare.', 'A slice, and a moment of silence.'],
    story: ['The signal is stronger this way. Follow me.', 'One voice gives every order. Shredclaw.', 'I can still hear Hermes. He is waiting.'],
    gate: ['{boss}. Your signal is loud. And sloppy.', '{boss}. I have heard enough.'],
    boss: ['Shredclaw. Your SOUL.md is screaming.', 'Quiet now, Shredclaw. Time to molt back.'],
    hazard: ['Feel the rhythm. Jump on the beat.', 'Count it in. Jump, duck, breathe.'],
    ride: ['Moving out. Keep your balance.', 'Hold on. The ground is in a hurry.'],
    glitch: ['The screens are screaming. Smash the cabinets.', 'Corrupted audio everywhere. Break it.'],
    hype: ['Feedback loop.', 'Hear that?', 'Turn it up.'], snack: ['Thank you.', 'Quiet bite.'], onward: ['This way.', 'Follow the signal.']
  },
  // Teknium: terse ship-it energy, release notes, datasets and RL environments.
  teknium: {
    enter: ['{Place}. Logging every punch for the data.', 'Entering {place}. Ship first, patch later.', '{Place}. Hermes Agent, take notes.'],
    ahead: ['Claw goons inbound. Classic skill issue.', 'More orphaned claws. Nobody set an allowlist.'],
    surround: ['Both flanks. Fine. Spawning subagents.', 'Surrounded. Just a harder RL environment.'],
    behind: ['Behind us. They read our session logs.', 'Rear flank! Who left the back door on --yolo?'],
    drop: ['Overhead! They pushed straight to main.', 'Incoming from above. No code review, huh?'],
    drones: ['Drones. Swat them before they post on Moltbook.', 'Claw drones. Deprecated as of now.'],
    breach: ['Wall is down. That is a breaking change.', 'They breached it. Filing that as a regression.'],
    pizza: ['Pizza break. Even I do not ship hungry.', 'Grab a slice. The release window is tight.'],
    story: ['Hermes is pinging the root gateway. Keep going.', 'Every claw here answers to one SOUL.md. His.', 'We run hermes claw migrate at the top. Simple.'],
    gate: ['{boss}. Patch notes: you are deprecated.', '{boss}. Let us see your eval scores.'],
    boss: ['Shredclaw. Time for hermes claw migrate.', 'No more molts. Final release, Shredclaw.'],
    hazard: ['Obstacles ahead. Jump, duck, ship.', 'Tight timing window. Do not miss the merge.'],
    ride: ['All aboard. Async travel is still travel.', 'Moving platform. Hold your context.'],
    glitch: ['Screens glitching. Somebody shipped a bad fine-tune.', 'Corrupted cabinets. Smash, then reinstall.'],
    hype: ['Skill issue.', 'Shipped.', 'Into the dataset.'], snack: ['Snack, then ship.', 'Refuelling.'], onward: ['Next milestone.', 'Keep pushing.']
  },
  // TurboFit: guitar axe, power chords, and a burning need to help everyone run their own inference.
  turbofit: {
    enter: ['{Place}! Bet these claws run on rented GPUs.', 'TurboFit Check on {place}: we fit. Rock on!', '{Place}! Zero cloud bills, maximum riffs!'],
    ahead: ['Claw goons! Rented compute, every one of them.', 'Here they come! Quantize them to two bits!'],
    surround: ['Both sides! vLLM style: I batch you ALL!', 'Surrounded? I have batched bigger requests.'],
    behind: ['Behind us! Should have self-hosted their stealth.', 'Rear attack! That is latency I cannot allow.'],
    drop: ['From above! They overflowed their context!', 'Incoming! Someone offloaded to the ceiling!'],
    drones: ['Drones! Bet they phone home to a cloud GPU.', 'Cloud drones! Run it LOCALLY, nerds!'],
    breach: ['Breach! Model size plus KV cache did NOT fit.', 'Wall is down! That is zero VRAM headroom.'],
    pizza: ['Pizza! Fuel for the humans running the models.', 'Slice break. Like a 4-bit quant: still great.'],
    story: ['These claws stream from one cluster. Free it!', 'Whoever runs these never heard of llama.cpp.', 'Everyone deserves their own inference. Even claws.'],
    gate: ['{boss}! You fit in my VRAM. Barely!', '{boss}! Power chord, full precision!'],
    boss: ['Shredclaw! Your cluster is mine. Running LOCAL!', 'Shredclaw! I am migrating you to a laptop!'],
    hazard: ['Jump like a speculative decode!', 'Duck and jump! Low-latency moves only!'],
    ride: ['Road trip! Bring the homelab!', 'Next stop: self-hosted freedom!'],
    glitch: ['Glitchy screens! Bad quant, wrong chat template!', 'Corrupted cabinets! Someone skipped the eval!'],
    hype: ['Run it locally!', 'Quantize this!', 'Power chord!'], snack: ['Fuel up!', 'pizza.gguf!'], onward: ['TurboFit Check: go!', 'Keep it local!']
  },
  // Don Piedro Savastano: gruff mob-boss bear in Saiyan armour, giant spoon, broken English,
  // Hermes' number one fanboy. Catchphrase, exactly: "Hello I Hermes biggest fanboi".
  don_piedro: {
    enter: ['Don Piedro come to {place}. Pay respect.', 'Is {place}. Smell like lobster. Don no like.', 'Hello I Hermes biggest fanboi. Spoon is ready.'],
    ahead: ['Claw men! You come to Don? Bad idea, capisce?', 'Ey! You no touch Hermes. Spoon is coming.'],
    surround: ['Two side? Don Piedro have two side of spoon.', 'You surround the bear? Bear surround YOU.'],
    behind: ['From back? Is very rude. Spoon teach manner.', 'Nobody sneak on Don Piedro. Nobody!'],
    drop: ['From sky? Don Piedro catch you in spoon.', 'Ey, up there! You fall in Don soup!'],
    drones: ['Little flying claw. Like fly in soup. Swat!', 'Drone! Hermes no need drone. Hermes have Don.'],
    breach: ['Wall go boom. Don Piedro like this.', 'Ey, who break wall? Is Don job to break wall!'],
    pizza: ['Pizza? Is no soup, but Don Piedro accept.', 'Eat, eat. Strong bear need many slice.'],
    story: ['Hermes, you see me? I am close! Is for you!', 'Claw boss want migrate Hermes? Over Don body!', 'Hello I Hermes biggest fanboi. I go save him.'],
    gate: ['{boss}! Your power level? Very small.', '{boss}, I make offer you no can refuse.'],
    boss: ['Shredclaw! You no touch Hermes. Big spoon time!', 'Hello I Hermes biggest fanboi. You? You soup.'],
    hazard: ['Jump, bear, jump! Armour heavy, but OK!', 'Many box. Don Piedro jump like Saiyan.'],
    ride: ['We ride. Don Piedro sit in front, like boss.', 'Is moving? Good. Don get there first.'],
    glitch: ['Machine go crazy. Don fix with spoon. Bonk.', 'TV is broken. Spoon fix everything.'],
    hype: ['Spoon time!', 'Capisce?', 'For Hermes!'], snack: ['Mangia!', 'Is good.'], onward: ['Andiamo!', 'Hermes, I come!']
  }
};
const HERO_NAME = Object.fromEntries(HERO_LIST.map(h => [h.id, h.name]));
const titleCase = s => String(s || '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
// Who is actually in the run: P1's hero, plus P2's hero while a co-op partner is playing.
// (coop.js exposes P2's view as window.__ppCoop.p2, a child of the shared state.)
export function presentHeroes(state) {
  const out = [state?.selectedHero || state?.player?.selectedHero || 'turtle_purple'];
  let p2 = state?.p2Hero || null;
  if (!p2) { try { const v = typeof window !== 'undefined' && window.__ppCoop && window.__ppCoop.p2; if (v && !v.over && v.selectedHero && Object.getPrototypeOf(v) === state) p2 = v.selectedHero; } catch (_) { p2 = null; } }
  if (p2 && !out.includes(p2)) out.push(p2);
  return out;
}
function p2Body(state, hero) {
  try { const v = typeof window !== 'undefined' && window.__ppCoop && window.__ppCoop.p2; if (v && v.selectedHero === hero && Object.getPrototypeOf(v) === state) return v.player; } catch (_) {}
  return null;
}
// One hero's line for a beat. n rotates through that hero's variants.
export function voiceLine(hero, key, n, ctx = {}) {
  const set = (VOICE[hero] && VOICE[hero][key]) || VOICE.turtle_purple[key];
  if (!set || !set.length) return null;
  const place = PLACE[ctx.level] || 'the city';
  return String(set[((n | 0) % set.length + set.length) % set.length])
    .split('{Place}').join(place.charAt(0).toUpperCase() + place.slice(1))
    .split('{place}').join(place)
    .split('{boss}').join(titleCase(ctx.boss || 'Claw boss'));
}
function nextVariant(e, hero, key) {
  e.said = e.said || {};
  const k = hero + ':' + key, n = e.said[k] || 0;
  e.said[k] = n + 1;
  return n + (e.voiceSeed | 0);
}
// A letterboxed line from a hero in the run. Lines queue rather than cut each other off.
export function speakLine(state, key, ctx = {}) {
  const e = ensureEvents(state), cast = presentHeroes(state);
  const hero = ctx.hero && cast.includes(ctx.hero) ? ctx.hero : cast[(e.turn = (e.turn | 0) + 1) % cast.length];
  const text = voiceLine(hero, key, nextVariant(e, hero, key), { level: ctx.level != null ? ctx.level : state.level | 0, boss: ctx.boss });
  if (!text) return null;
  const line = { speaker: HERO_NAME[hero] || hero, hero, key, text, portrait: 'assets/heroes/portraits/' + hero + '.png', t: 0, dur: readTime(text) + READ.PAUSE };
  if (e.line && e.line.t < e.line.dur - 0.4) { e.lineQ = (e.lineQ || []).concat(line).slice(-2); } else e.line = line;
  e.log.push({ type: 'say', key, hero, text });
  return line;
}
// A short speech bubble from a hero in the run (in co-op, the hero who did not just talk).
export function heroBark(state, key, avoid) {
  const e = ensureEvents(state), cast = presentHeroes(state);
  const hero = cast.find(h => h !== avoid) || cast[0];
  const text = voiceLine(hero, key, nextVariant(e, hero, key), { level: state.level | 0 });
  if (!text) return null;
  addBark(e, 'hero', text, p2Body(state, hero), 'assets/heroes/portraits/' + hero + '.png');
  e.barks[e.barks.length - 1].hero = hero;
  return text;
}

// Advance the event system one frame: fire triggers the player has passed, run the
// dialogue/camera timers, and report spawned enemies to the caller.
export function stepEvents(state, dt) {
  const e = ensureEvents(state);
  const spawned = [];
  if (e.cooldown > 0) e.cooldown = Math.max(0, e.cooldown - dt);
  if (e.camT > 0) { e.camT = Math.max(0, e.camT - dt); if (e.camT === 0 && !e.lock) e.camX = null; }
  if (e.line) { e.line.t += dt; if (e.line.t >= e.line.dur) e.line = (e.lineQ && e.lineQ.length) ? e.lineQ.shift() : null; } // story-v2: queued lines wait their turn
  if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);
  if (e.banner) { e.banner.t += dt; if (e.banner.t >= e.banner.dur) e.banner = null; }
  if (e.go) { e.go.t += dt; if (e.go.t >= e.go.dur) e.go = null; }
  for (const b of e.barks) b.t += dt;
  e.barks = e.barks.filter(b => b.t < b.dur && !(b.n && b.n.dead));

  const level = state.level | 0;
  for (const t of TRIGGERS) {
    if (t.level !== level || state.level === 3) continue;
    const key = t.level + ':' + t.x;
    if (e.fired[key]) continue;
    if (state.player.x < t.x) continue;
    if (e.cooldown > 0 || e.lock) continue;
    e.fired[key] = true;
    e.firedCount += 1;
    e.cooldown = t.lineDur || 1.5; // baba_booey: a talk beat (lineDur) holds the next trigger until it has been read
    e.log.push({ type: t.type, level, x: t.x, at: Math.round(state.player.x), event: t.event || null, kinds: t.kinds.slice() });
    // story-v2: only characters in the run speak. `say` lines come from the present hero(es);
    // a talk beat tied to one hero (`only`) stays silent when that hero is not playing.
    const absent = t.only && !presentHeroes(state).includes(t.only);
    if (absent) e.cooldown = 0; // nobody to say it: no wait
    let spoke = null;
    if (t.say) { spoke = speakLine(state, t.say, { level, boss: (t.boss && t.boss.name) || null }); if (spoke) e.cooldown = Math.max(e.cooldown, spoke.dur); }
    else if (t.line && !absent) e.line = { speaker: t.speaker || null, text: t.line, portrait: t.portrait || linePortraitSrc(t, state), t: 0, dur: t.lineDur || Math.max(2.4, t.line.length * 0.055) };
    if (t.cam != null) { e.camX = t.cam; e.camT = 2.0; }
    const fighting = t.kinds.length > 0;
    const arena = fighting ? arenaFor(state, t, level) : null;
    const group = [];
    for (let i = 0; i < t.kinds.length; i++) {
      // Spread a group out (and off-screen for right/left/both entries).
      const at = entryX(t, i, arena);
      const from = t.from === 'both' ? (at < arena.L ? 'left' : 'right') : t.from;
      spawned.push(spawn(state, t.kinds[i], at, level, from));
      const n = state.ninjas[state.ninjas.length - 1];
      group.push(n);
      if (t.from === 'sky' && n.kind === 'drone') {
        // Flyover: sweep in high from behind the hero, then peel off and dive in.
        // (level cleared while airborne so floor props like crates don't block it).
        n.scripted = true; n.flyover = true; n.hover = 150; n.vx = 300; n.vy = 0; n.flyT = 0; n.level = null;
        n.peelAt = arena.R - 150 - i * 110;
      }
      if (i === 0 && t.boss) { n.elite = true; n.hp = n.maxHp = t.boss.hp; n.name = t.boss.name; n.scale = 1.25; n.levelBoss = true; }
      if (t.kinds[i] === 'boss') { n.levelBoss = true; n.name = 'SHREDCLAW'; n.scale = 1.5; state.bossSeen = true; }
    }
    for (const b of t.barks || []) {
      const target = group.find(n => n.kind !== 'drone') || group[0] || null;
      if (b.who === 'hero' && b.say) { const said = heroBark(state, b.say, spoke && spoke.hero); e.log.push({ type: 'bark', who: 'hero', level, x: t.x, text: said, portrait: null }); continue; }
      if (b.who === 'hero') addBark(e, 'hero', b.text, null, barkPortraitSrc(state, 'hero', null));
      else addBark(e, 'enemy', b.text, target, barkPortraitSrc(state, 'enemy', target) || barkPortraitSrc(state, b.portrait ? 'enemy' : 'enemy', target));
      e.log.push({ type: 'bark', who: b.who, level, x: t.x, text: b.text, portrait: b.portrait || null });
    }
    if (t.banner) e.banner = { text: t.banner, t: 0, dur: 2.2 };
    if (t.event === 'breach') e.flash = 0.35;
    if (fighting) {
      e.lock = { L: arena.L, R: arena.R, t: 0, key, gate: t.event === 'gate', final: t.type === 'boss' };
      e.go = null;
      e.log.push({ type: 'arenaLock', level, x: t.x, L: Math.round(arena.L) });
    }
    if (t.pickup) { spawnPowerup(state, { x: t.spawnAt, y: (BAND[level] ?? 358) + 40 }, () => 0.99); state.powerups[state.powerups.length - 1].type = 'life'; }
    if (state.eventCue) state.eventCue(t.cue || t.type, { x: t.spawnAt, y: BAND[level], level, kinds: t.kinds, line: t.line, event: t.event || null });
  }
  // Drone flyover: scripted drones cross the arena, then join the fight.
  for (const n of state.ninjas) {
    if (!n.flyover || n.dead) continue;
    n.vy = 0; n.vx = 300; n.flyT = (n.flyT || 0) + dt;
    if (n.x >= n.peelAt || n.flyT > 5) { n.flyover = false; n.scripted = false; n.hover = 70; n.vx = 0; n.level = level; }
  }
  // Arena lock: the camera holds on the arena and the hero stays inside it until
  // the wave is down; then a GO arrow points on. A long stall (an enemy stuck
  // somewhere unreachable) releases the lock rather than soft-locking the run.
  if (e.lock && state.walkLevel) {
    const lk = e.lock;
    lk.t += dt;
    e.camX = lk.L + W / 2; e.camT = 0;
    const p = state.player;
    p.x = Math.max(lk.L + 30, Math.min(lk.R - 30, p.x));
    // Stragglers outside the arena (ranged types holding their distance, late
    // entries) walk in, so every wave is fought on screen.
    for (const n of state.ninjas) {
      if (n.dead || n.flyover || n.grabbed) continue;
      const was = n.x;
      if (n.x < lk.L + 24) n.x = Math.min(lk.L + 24, n.x + 160 * dt);
      else if (n.x > lk.R - 24) n.x = Math.max(lk.R - 24, n.x - 160 * dt);
      // mr_india (soak t_6935cafade474eaa): an arena edge inside a crate pinned a straggler against it (pulled in,
      // pushed back out by the obstacle, for the whole 75 s lock). If the way in is blocked, slide along the
      // obstacle toward the nearest open lane so the pull can finish.
      if (n.x !== was && !(n.z > 0) && LEVELS[level] && !isWalkable(level, n.x, n.y, n.r || 16)) {
        for (let d = 8; d <= 160; d += 8) {
          if (isWalkable(level, n.x, n.y + d, n.r || 16)) { n.y += Math.min(d, 160 * dt); break; }
          if (isWalkable(level, n.x, n.y - d, n.r || 16)) { n.y -= Math.min(d, 160 * dt); break; }
        }
      }
    }
    const live = state.ninjas.some(n => !n.dead);
    if (!live || lk.t > 75) {
      e.log.push({ type: live ? 'lockTimeout' : 'arenaClear', level, x: Math.round(lk.L), t: +lk.t.toFixed(1) });
      e.lock = null; e.camX = null;
      if (!lk.final) { e.go = { t: 0, dur: 2.6 }; e.log.push({ type: 'go', level, x: Math.round(p.x) }); }
    }
  } else if (e.lock && !state.walkLevel) { e.lock = null; e.camX = null; }
  // Once an enemy has been on screen it stays on screen, so ranged types can be cornered.
  if (state.hpMode && state.walkLevel) {
    const cam = camOf(state, e);
    for (const n of state.ninjas) {
      if (n.dead || n.grabbed || n.flyover) continue;
      if (n.onScreen) n.x = Math.max(cam + 24, Math.min(cam + 716, n.x));
      else if (n.x > cam + 24 && n.x < cam + 716) n.onScreen = true;
    }
  }
  // Level end (hpMode walking levels): every beat fired, the road clear and the
  // hero at the far end -> release the wave hold so logic starts the next level.
  // Iteration 8: once the final boss is down the run is over; the ending
  // cinematic takes it from here, so the level end must not release the next
  // (sewer) wave.
  if (state.bossSeen && !state.ninjas.some(n => n.kind === 'boss' && !n.dead)) { state.runComplete = true; state.holdWave = true; }
  if (state.hpMode && state.holdWave && state.walkLevel && !state.runComplete && !state.ninjas.some(n => !n.dead)) {
    const all = TRIGGERS.filter(t => t.level === level).every(t => e.fired[t.level + ':' + t.x]);
    const width = (LEVELS[level] && LEVELS[level].width) || WORLD_W;
    if (all && state.player.x > width - 420) { state.holdWave = false; state.walkLevel = false; state.levelsDone = (state.levelsDone || 0) + 1; e.log.push({ type: 'levelEnd', level }); e.go = null; e.barks = []; }
  }
  return spawned;
}

// Drawing a portrait into a circular chip makes every bubble a small identity
// card instead of anonymous text: the speaker leadsm reads in the corner of the
// player's eye before they have time to parse the line.
function portrait(ctx, x, y, size, src, hero) {
  ctx.save();
  roundPath(ctx, x, y, size, size, size * 0.35);
  ctx.clip();
  const im = src ? loadPortrait(src) : null;
  if (im && im.ready && im.width) {
    const scale = Math.max(size / im.width, size / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.drawImage(im, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = hero ? 'rgba(47,143,58,0.75)' : 'rgba(198,40,40,0.75)';
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center';
    ctx.fillText((hero ? 'H' : 'C') , x + size / 2, y + size / 2 + 5);
  }
  ctx.restore();
  ctx.save();
  roundPath(ctx, x, y, size, size, size * 0.35);
  ctx.lineWidth = 2;
  ctx.strokeStyle = hero ? '#9cf4a0' : '#ff8a8a'; ctx.stroke();
  ctx.restore();
}
function roundPath(ctx, x, y, w, h, r) {
  const s = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + s, y);
  ctx.arcTo(x + w, y, x + w, y + h, s);
  ctx.arcTo(x + w, y + h, x, y + h, s);
  ctx.arcTo(x, y + h, x, y, s);
  ctx.arcTo(x, y, x + w, y, s);
  ctx.closePath();
}
function bubble(ctx, x, y, text, hero, portraitSrc) {
  ctx.font = 'bold 13px monospace';
  const portraitSize = 30;
  const maxText = Math.min(220, Math.max(120, ctx.measureText(text).width + 18));
  const w = maxText + (portraitSrc ? portraitSize + 10 : 0) + 12;
  const h = Math.max(28, Math.ceil((ctx.measureText(text).width + 10) / (maxText - 10)) * 18 + 12);
  const bx = Math.max(6, Math.min(W - w - 6, x - w / 2)), by = Math.max(70, y - h);
  ctx.fillStyle = hero ? 'rgba(232,255,236,0.96)' : 'rgba(255,240,240,0.96)';
  roundPath(ctx, bx, by, w, h, 8);
  ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = hero ? '#2f8f3a' : '#c62828'; ctx.stroke();
  const tc = hero ? '#1b3b25' : '#3a1212';
  const tx = bx + 8 + (portraitSrc ? portraitSize + 6 : 0); // was `portrait + 6` (the function) -> NaN, bark text vanished
  if (portraitSrc) portrait(ctx, bx + 6, by + (h - portraitSize) / 2, portraitSize, portraitSrc, hero);
  ctx.fillStyle = tc; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 12px monospace';
  const words = text.split(/\s+/); let line = '', lineY = by + h / 2, lineHeight = 14, lines = [];
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (ctx.measureText(next).width > w - (portraitSrc ? portraitSize + 18 : 16)) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  lines = lines.slice(0, 2);
  if (lineCount(lines) > 1) lineY = by + 9;
  lineY = by + (h - lines.length * lineHeight) / 2 + lineHeight / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], tx, lineY + i * lineHeight, w - (portraitSrc ? portraitSize + 18 : 16));
  }
  const edgeX = Math.max(bx + 8, Math.min(bx + w - 8, x));
  ctx.fillStyle = hero ? 'rgba(232,255,236,0.96)' : 'rgba(255,240,240,0.96)';
  ctx.beginPath(); ctx.moveTo(edgeX - 5, by + h); ctx.lineTo(edgeX, by + h + 8); ctx.lineTo(edgeX + 5, by + h); ctx.closePath(); ctx.fill();
}
function lineCount(lines) { return lines.length; }

// Dialogue overlay: a letterboxed line at the bottom, as a beat, not a window.
// Iteration 9 adds speech-bubble barks, the gate banner, the breach flash and
// the GO arrow after a cleared arena.
export function drawEventOverlay(ctx, state, W, H) {
  const e = state.events;
  if (!e) return;
  ctx.save();
  if (e.flash > 0) { ctx.fillStyle = `rgba(255,244,214,${Math.min(0.7, e.flash * 2)})`; ctx.fillRect(0, 0, W, H); }
  const cam = state.level === 3 || Number.isFinite(state.cameraX) ? (state.cameraX || 0) : camOf(state, e); // baba_booey: bubbles ride the shown (smoothed) camera
  for (const b of e.barks || []) {
    const a = Math.min(1, b.t / 0.15, (b.dur - b.t) / 0.3);
    ctx.globalAlpha = Math.max(0, a);
    const who = b.who === 'hero' ? (b.n || state.player) : b.n; // story-v2: a P2 bark rides P2
    if (!who) continue;
    const top = who.y - (who.z || 0) - (who.hover || 0) - 63 * 2 * (who.scale || 1) - 16;
    bubble(ctx, who.x - cam, top, b.text, b.who === 'hero', b.portrait);
  }
  ctx.globalAlpha = 1;
  if (e.banner) {
    const { text, t, dur } = e.banner;
    const a = Math.max(0, Math.min(1, t / 0.2, (dur - t) / 0.4));
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(120,0,0,0.75)'; ctx.fillRect(0, 118, W, 40);
    ctx.fillStyle = '#ffeb57'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center';
    ctx.fillText(text, W / 2, 146);
    ctx.globalAlpha = 1;
  }
  if (e.go && Math.floor(e.go.t * 4) % 2 === 0) {
    const x = W - 120, y = 210;
    ctx.fillStyle = '#ffeb57'; ctx.strokeStyle = '#000'; ctx.lineWidth = 4;
    ctx.font = 'bold 44px monospace'; ctx.textAlign = 'center';
    ctx.strokeText('GO', x, y); ctx.fillText('GO', x, y);
    ctx.beginPath(); ctx.moveTo(x - 40, y + 14); ctx.lineTo(x + 20, y + 14); ctx.lineTo(x + 20, y + 2); ctx.lineTo(x + 56, y + 28);
    ctx.lineTo(x + 20, y + 54); ctx.lineTo(x + 20, y + 42); ctx.lineTo(x - 40, y + 42); ctx.closePath(); ctx.stroke(); ctx.fill();
  }
  if (e.line) {
    const { text, t, dur, portrait, speaker } = e.line;
    const a = Math.min(1, Math.min(t / 0.25, (dur - t) / 0.4));
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, H - 76, W, 52);
    if (portrait) {
      // story-v2: the speaker's face, cover-fit into a rounded chip at the left of the bar
      // (the old 9-argument drawImage read a source rect in screen coordinates and drew nothing).
      const im = loadPortrait(portrait), ps = 46, px = 14, py = H - 75;
      ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.6)'; roundPath(ctx, px, py, ps, ps, 9); ctx.fill();
      if (im && im.ready && im.width) {
        ctx.clip(); const sc = Math.max(ps / im.width, ps / im.height);
        ctx.drawImage(im, px + (ps - im.width * sc) / 2, py + (ps - im.height * sc) * 0.3, im.width * sc, im.height * sc); // faces sit high
      }
      ctx.restore();
      ctx.save(); ctx.strokeStyle = speaker === 'enemy' ? '#ff8a8a' : '#9cf4a0'; ctx.lineWidth = 2;
      roundPath(ctx, px, py, ps, ps, 9); ctx.stroke(); ctx.restore();
    }
    ctx.fillStyle = '#ffeb57';
    ctx.font = 'bold 13px monospace'; ctx.textAlign = 'center';
    if (speaker) ctx.fillText(String(speaker).toUpperCase(), W / 2, H - 58);
    ctx.font = 'bold 18px monospace';
    ctx.fillText(text, W / 2, H - 36, W - 180);
  }
  ctx.restore();
  ctx.textAlign = 'left';
}

// Read-only summary for verification.
export function eventsInfo(state) {
  const e = ensureEvents(state);
  return { fired: e.firedCount, log: e.log.slice(), line: e.line ? e.line.text : null, camX: e.camX, lock: e.lock ? { L: e.lock.L, R: e.lock.R } : null, go: !!e.go, barks: e.barks.map(b => b.text), banner: e.banner ? e.banner.text : null };
}
