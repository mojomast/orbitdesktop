// harbor-data.js: data for the Harbor docks at night level (mr_india, t_86364aad0b7746c4).
// Pure data, no imports (like subway-data.js), so collision.js / events.js /
// boss.js / node checks pull it in with one-line hooks.
// Level index 6. Play order: sewer, street, skate, subway, rooftop, HARBOR, tower.
// World is three 1814px strip tiles: two pier tiles (containers, gantry cranes,
// wet planks) and the OpenClaw smuggler ship deck (boarding finale + gate).
export const HARBOR_LEVEL_INDEX = 6;
export const HARBOR_TILE_W = 1814;
export const HARBOR_W = HARBOR_TILE_W * 3; // 5442
export const HARBOR_BAND = { y: 396, h: 74 }; // pier planks / steel deck (strip y)
export const SHIP_X = HARBOR_TILE_W * 2; // boarding section starts here
// Gantry cranes (painted at strip x ~470 and ~1340 of each pier tile).
export const CRANES = [470, 1340, 470 + HARBOR_TILE_W, 1340 + HARBOR_TILE_W];
export const CRANE = { reach: 260, telegraph: 1.0, fall: 0.25, cd: 3.2, dmg: 10, radius: 34, depth: 16 };
// Slick wet planks: low friction, momentum carries after you stop, dash or get knocked back.
export const WET_ZONES = [{ x0: 900, x1: 1550 }, { x0: 2650, x1: 3350 }, { x0: 4300, x1: 4900 }];
export const SLIDE = { decay: 2.2, min: 15 };

export const HARBOR_LEVEL = {
  id: 'harbor',
  width: HARBOR_W,
  walkables: [{ x: 0, y: HARBOR_BAND.y, w: HARBOR_W, h: HARBOR_BAND.h }],
  obstacles: [],
  spawnY: rand => HARBOR_BAND.y + 12 + rand() * (HARBOR_BAND.h - 24),
};

const L = HARBOR_LEVEL_INDEX;
// events.js beats (same schema as subway-data.js). Ext enemies (clawninja,
// shieldbrute, flamebot) are added per trigger key through enemies-ext EXT_SPAWNS
// by harbor.js.
export const HARBOR_TRIGGERS = [
  { level: L, x: 300, type: 'ambush', kinds: ['brawler', 'striker'], spawnAt: 760, from: 'right', say: 'enter', banner: 'PIER 13', cam: 640, // story-v2: spoken by the hero(es) in the run (events.js VOICE)
    barks: [{ who: 'enemy', text: 'Nobody unloads our GPUs!' }] },
  { level: L, x: 1000, type: 'setpiece', event: 'breach', cue: 'doorBurst', kinds: ['thrower', 'brawler'], spawnAt: 1300, from: 'right', say: 'drop', banner: 'CRANES — CRATES INCOMING', cam: 1250,
    barks: [{ who: 'hero', say: 'hype' }] },
  { level: L, x: 1650, type: 'breather', kinds: [], spawnAt: 1800, pickup: true, say: 'story' },
  { level: L, x: 2200, type: 'ambush', event: 'ambushBoth', kinds: ['charger', 'acrobat', 'striker'], spawnAt: 2500, from: 'both', say: 'surround', cam: 2450,
    barks: [{ who: 'enemy', text: 'Box them in! Containerize them!' }] },
  { level: L, x: 2900, type: 'flyover', event: 'flyover', cue: 'dropIn', kinds: ['drone', 'drone', 'thrower'], spawnAt: 3100, from: 'sky', say: 'drones' },
  { level: L, x: 3500, type: 'breather', kinds: [], spawnAt: 3600, pickup: true, say: 'ride', barks: [{ who: 'hero', say: 'onward' }] },
  { level: L, x: 3900, type: 'setpiece', event: 'breach', cue: 'doorBurst', kinds: ['blocker', 'brawler', 'skater'], spawnAt: 4200, from: 'door', say: 'breach', cam: 4150 },
  { level: L, x: 4880, type: 'miniBoss', event: 'gate', kinds: ['brawler', 'thrower', 'drone'], spawnAt: 5150, from: 'right', boss: { name: 'CAPTAIN HOOKCLAW', hp: 12 }, say: 'gate', cam: 5100,
    banner: 'SHIP DECK — CAPTAIN HOOKCLAW', barks: [{ who: 'enemy', text: 'Walk the plank! These GPUs sail tonight!' }] },
];
// Ext enemy waves keyed by trigger (level:x), merged into enemies-ext EXT_SPAWNS.
export const HARBOR_EXT_SPAWNS = { [L + ':1000']: ['flamebot'], [L + ':2200']: ['clawninja'], [L + ':3900']: ['shieldbrute', 'clawninja'], [L + ':4880']: ['flamebot'] };

// Level boss in boss.js BOSSES format: a mid-tier smuggler captain on the charger rig.
export const HARBOR_BOSS = { id: 'hookclaw', name: 'CAPTAIN HOOKCLAW', title: 'OpenClaw smuggler captain', rig: 'charger', scale: 1.45, r: 23, hp: 50,
  tint: 'hue-rotate(160deg) saturate(1.4) brightness(0.9)', color: '#4fd8c8',
  phases: [1, 0.5], poise: [5, 6], speed: [75, 95], cd: [1.1, 0.85],
  attacks: [['swipe', 'charge'], ['swipe', 'charge', 'mines']],
  moves: { swipe: 'pound', charge: 'charge', mines: 'groundPound' },
  barks: ['This cargo sails tonight!'], summon: { 1: ['striker', 'thrower'] } };
