// subway-data.js: data for the Subway train level (cheese, t_fc41e51cbeb94db3).
// Pure data, no imports, so collision.js / logic.js / events.js can pull it in
// with one-line hooks and Node checks see the same level as the browser.
//
// The level is index 5 (tower keeps 4). Play order: sewer, street, skate,
// SUBWAY, rooftop, tower. World is three 1814px tiles: carriage A (interior),
// the carriage ROOF run (signal hazards), carriage B (interior). The floor band
// is the same on all three: the roof tile is drawn so the roof sits at the
// band, so collision stays one box.
export const SUBWAY_LEVEL_INDEX = 5;
export const SUBWAY_TILE_W = 1814;
export const SUBWAY_W = SUBWAY_TILE_W * 3; // 5442, same length as the other walking levels
export const SUBWAY_BAND = { y: 372, h: 80 }; // walkable floor (car floor / roof walkway)
export const SUBWAY_ROOF = { x0: SUBWAY_TILE_W, x1: SUBWAY_TILE_W * 2 }; // the roof run
// Stations: the train brakes as you reach one and stands with doors open while
// OpenClaw boards; it pulls out once you are past the zone.
export const SUBWAY_STATIONS = [
  { name: 'CANAL ST', x0: 900, x1: 1500 },
  { name: 'PIZZA SQ', x0: 4000, x1: 4620 },
];
export const SUBWAY_TRAIN_SPEED = 640; // px/s the tunnel rushes past

export const SUBWAY_LEVEL = {
  id: 'subway',
  width: SUBWAY_W,
  walkables: [{ x: 0, y: SUBWAY_BAND.y, w: SUBWAY_W, h: SUBWAY_BAND.h }],
  obstacles: [],
  spawnY: rand => SUBWAY_BAND.y + 14 + rand() * (SUBWAY_BAND.h - 28),
};

// events.js beats for level 5 (same schema as the other walking levels): rising
// waves, two station boardings (breach from the doors), the roof hazard run, a
// drone flyover, a both-sides ambush, breathers with pizza, and the gate boss.
const L = SUBWAY_LEVEL_INDEX;
export const SUBWAY_TRIGGERS = [
  { level: L, x: 300, type: 'ambush', kinds: ['brawler', 'skater'], spawnAt: 760, from: 'right', say: 'enter', cam: 640, // story-v2: spoken by the hero(es) in the run (events.js VOICE)
    barks: [{ who: 'enemy', text: 'Tickets! I already auto-replied for you!' }] },
  { level: L, x: 950, type: 'setpiece', event: 'breach', cue: 'doorBurst', kinds: ['blocker', 'thrower', 'striker'], spawnAt: 1250, from: 'door', say: 'breach', banner: 'CANAL ST', cam: 1200, station: 0 },
  { level: L, x: 1560, type: 'breather', kinds: [], spawnAt: 1700, pickup: true, say: 'ride', banner: 'UP THE HATCH — RIDE THE ROOF' },
  { level: L, x: 1900, type: 'hazardRun', event: 'hazardRun', kinds: [], spawnAt: 2100, say: 'hazard', banner: 'JUMP THE BOXES — HOLD DOWN TO DUCK',
    barks: [{ who: 'hero', say: 'hype' }] },
  { level: L, x: 2500, type: 'flyover', event: 'flyover', cue: 'dropIn', kinds: ['drone', 'drone', 'acrobat'], spawnAt: 2800, from: 'sky', say: 'drones',
    barks: [{ who: 'hero', say: 'hype' }] },
  { level: L, x: 3150, type: 'ambush', event: 'ambushBoth', kinds: ['charger', 'skater', 'striker', 'acrobat'], spawnAt: 3400, from: 'both', say: 'surround',
    barks: [{ who: 'enemy', text: 'End of the line! Context window full!' }] },
  { level: L, x: 3700, type: 'breather', kinds: [], spawnAt: 3900, pickup: true, say: 'pizza' },
  { level: L, x: 4050, type: 'setpiece', event: 'breach', cue: 'doorBurst', kinds: ['thrower', 'blocker', 'brawler', 'skater', 'striker'], spawnAt: 4350, from: 'door', say: 'ahead', banner: 'PIZZA SQ', cam: 4300, station: 1 },
  { level: L, x: 4880, type: 'miniBoss', event: 'gate', kinds: ['brawler', 'blocker', 'drone'], spawnAt: 5150, from: 'door', boss: { name: 'THE CONDUCTOR', hp: 12 }, say: 'gate', cam: 5100,
    banner: 'LAST STOP — THE CONDUCTOR', barks: [{ who: 'enemy', text: 'No fare? No ride. No refunds.' }] },
];

// Boss definition in boss.js's BOSSES format (offered to baba_booey; subway.js
// registers it as BOSSES[5] only if boss.js doesn't define one).
export const SUBWAY_BOSS = { id: 'conductor', name: 'THE CONDUCTOR', title: 'OpenClaw line enforcer', rig: 'blocker', scale: 1.45, r: 22, hp: 50,
  tint: 'hue-rotate(195deg) saturate(1.6) brightness(0.95)', color: '#4fc3ff',
  phases: [1, 0.5], poise: [5, 6], speed: [80, 100], cd: [1.1, 0.85],
  attacks: [['swipe', 'charge'], ['swipe', 'charge', 'wave']],
  moves: { swipe: 'pound', charge: 'charge', wave: 'groundPound' },
  barks: ['All aboard the PAIN train!'], summon: { 1: ['striker', 'skater'] } };
