// arcade-data.js: data for the Retro arcade interior level (mr_india, t_265366e58d3946cf).
// Pure data, no imports (like harbor-data.js / subway-data.js), so collision.js /
// events.js / boss.js / node checks pull it in with one-line hooks.
// Level index 7. Play order: sewer, street, skate, subway, ARCADE, rooftop, harbor, tower.
// World is three 1814px strip tiles: two hacked cabinet-row tiles (smashable cabinets,
// glitching screens) and the ticket prize counter (mini arena + HIGH SCORE gate).
export const ARCADE_LEVEL_INDEX = 7;
export const ARCADE_TILE_W = 1814;
export const ARCADE_W = ARCADE_TILE_W * 3; // 5442
export const ARCADE_BAND = { y: 392, h: 66 }; // carpet / checkered floor (strip y)
export const TICKET_X = ARCADE_TILE_W * 2; // ticket-counter section starts here
// Smashable cabinets stand on the back edge of the floor (intact -> smashed + debris + tickets).
export const CABINETS = [520, 1180, 1560, 2300, 2740, 3260, 4300, 4660, 5250];
export const CABINET = { hp: 3, halfW: 34, h: 140, score: 300, tickets: 3, ticketScore: 100 };
// Decorative machines (no collision, keeps the floor free for bots and tests).
export const DECOR = [['claw', 820], ['pinball', 1900], ['skeeball', 2980], ['token', 3480], ['pinball', 3980], ['claw', 5050]];
// Glitch: the overlords' hack swaps the palette mid-fight at these scripted beats.
export const GLITCH = { dur: 2.2, reducedDur: 1.5, hue: 150 };

export const ARCADE_LEVEL = {
  id: 'arcade',
  width: ARCADE_W,
  walkables: [{ x: 0, y: ARCADE_BAND.y, w: ARCADE_W, h: ARCADE_BAND.h }],
  obstacles: [],
  spawnY: rand => ARCADE_BAND.y + 10 + rand() * (ARCADE_BAND.h - 20),
};

const L = ARCADE_LEVEL_INDEX;
// events.js beats (same schema as harbor-data.js). Ext enemies are added per trigger key
// through enemies-ext EXT_SPAWNS by arcade.js. `glitch: true` beats fire the palette hack.
export const ARCADE_TRIGGERS = [
  { level: L, x: 300, type: 'ambush', kinds: ['brawler', 'striker'], spawnAt: 760, from: 'right', say: 'enter', cam: 640, // story-v2: spoken by the hero(es) in the run (events.js VOICE)
    barks: [{ who: 'enemy', text: 'Game over! I installed winning as a skill!' }] },
  { level: L, x: 1000, type: 'setpiece', event: 'breach', cue: 'doorBurst', glitch: true, kinds: ['thrower', 'acrobat'], spawnAt: 1300, from: 'right', say: 'glitch', cam: 1250,
    barks: [{ who: 'hero', say: 'hype' }] },
  { level: L, x: 1700, type: 'breather', kinds: [], spawnAt: 1850, pickup: true, say: 'pizza' },
  { level: L, x: 2300, type: 'ambush', event: 'ambushBoth', glitch: true, kinds: ['charger', 'skater', 'striker'], spawnAt: 2600, from: 'both', say: 'surround', cam: 2550,
    barks: [{ who: 'enemy', text: 'Player two has entered! Spawning subagents!' }] },
  { level: L, x: 3000, type: 'flyover', event: 'flyover', cue: 'dropIn', kinds: ['drone', 'drone', 'thrower'], spawnAt: 3200, from: 'sky', say: 'drones' },
  { level: L, x: 3700, type: 'breather', kinds: [], spawnAt: 3780, pickup: true, say: 'story', barks: [{ who: 'hero', say: 'snack' }] },
  { level: L, x: 3950, type: 'setpiece', event: 'breach', cue: 'doorBurst', glitch: true, kinds: ['blocker', 'brawler', 'skater'], spawnAt: 4250, from: 'door', say: 'breach', cam: 4200,
    banner: 'TICKET COUNTER — HOLD IT!' },
  { level: L, x: 4880, type: 'miniBoss', event: 'gate', glitch: true, kinds: ['brawler', 'thrower', 'drone'], spawnAt: 5150, from: 'right', boss: { name: 'HIGH SCORE', hp: 12 }, say: 'gate', cam: 5100,
    banner: 'PRIZE COUNTER — HIGH SCORE', barks: [{ who: 'enemy', text: 'Nobody beats my score! I trained on it!' }] },
];
export const ARCADE_GLITCH_KEYS = ARCADE_TRIGGERS.filter(t => t.glitch).map(t => L + ':' + t.x);
// Ext enemy waves keyed by trigger (level:x), merged into enemies-ext EXT_SPAWNS.
export const ARCADE_EXT_SPAWNS = { [L + ':1000']: ['clawninja'], [L + ':2300']: ['flamebot'], [L + ':3950']: ['shieldbrute', 'clawninja'], [L + ':4880']: ['clawninja'] };

// Level boss in boss.js BOSSES format: a claw ninja captain on the acrobat rig.
export const ARCADE_BOSS = { id: 'highscore', name: 'HIGH SCORE', title: 'claw ninja captain', rig: 'acrobat', scale: 1.4, r: 21, hp: 48,
  tint: 'hue-rotate(95deg) saturate(1.6) brightness(1.05)', color: '#ff5fd2',
  phases: [1, 0.5], poise: [5, 6], speed: [90, 110], cd: [1.0, 0.8],
  attacks: [['swipe', 'charge'], ['swipe', 'charge', 'mines']],
  moves: { swipe: 'pound', charge: 'charge', mines: 'groundPound' },
  barks: ['Enter your initials... on the floor!'], summon: { 1: ['acrobat', 'striker'] } };
