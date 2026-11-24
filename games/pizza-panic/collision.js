// Walkable collision maps for AGENT ARMEGEDDON: CLAWPOCALYPSE NOW's side-scrolling stages.  These are
// data-first so MR.INDIA's art and animation can be layered on top without
// changes to the game loop: pipes, ladders and stage edges should match these boxes.
// One full level-strip tile: the world is wider than the viewport so the camera
// can scroll. Art strips are 1814x510 and loop seamlessly.
export const TILE_W = 1814;
// Iteration 7: walking levels are three strip tiles long (~3x). The strip art
// loops seamlessly every 1814px; per-segment props, decals and foreground keep
// the repeats from reading as copies.
export const WORLD_W = TILE_W * 3; // 5442

import { propObstacles } from './props.js';
import { SUBWAY_LEVEL } from './subway-data.js'; // cheese: subway level data
import { HARBOR_LEVEL } from './harbor-data.js'; // mr_india: harbor docks level data
import { ARCADE_LEVEL } from './arcade-data.js'; // mr_india: arcade interior level data

export const LEVELS = [
  {
    id: 'sewer',
    // Side-scroll art order requested by MR.INDIA.  The floor band is read directly
    // from assets/levels/LEVELS.md; the crates are the only authored blockers.
    // x ranges span a full 1814px strip tile (WORLD_W): the earlier 0-740 ranges
    // pinned the world to one screen, which is why nothing could scroll.
    width: WORLD_W,
    walkables: [
      { x: 0, y: 363, w: WORLD_W, h: 93 }
    ],
    obstacles: [
      // The painted crates repeat with every strip tile.
      ...[0, 1, 2].flatMap(k => [{ x: 332 + k * TILE_W, y: 295, w: 168, h: 85 }, { x: 1314 + k * TILE_W, y: 295, w: 168, h: 85 }]),
      // Props (props.js) contribute their footprints so they block where they stand.
      ...propObstacles(0)
    ],
    spawnY: (rand) => 390 + rand() * 45
  },
  {
    id: 'street',
    width: WORLD_W,
    walkables: [
      { x: 0, y: 358, w: WORLD_W, h: 152 }
    ],
    obstacles: [
      ...propObstacles(1)
    ],
    spawnY: (rand) => 380 + rand() * 110
  },
  {
    id: 'rooftop',
    width: WORLD_W,
    walkables: [
      { x: 0, y: 358, w: WORLD_W, h: 67 }
    ],
    obstacles: [
      ...propObstacles(2)
    ],
    spawnY: (rand) => 375 + rand() * 40
  },
  {
    // Iteration 6: auto-scrolling skate highway (skate.js). Played between street
    // and rooftop (logic.LEVEL_ORDER). The road band is endless; the camera, not
    // the level width, bounds the player. Obstacles are cones/barriers you ollie.
    id: 'skate',
    auto: true,
    walkables: [
      { x: -1e5, y: 384, w: 1e7, h: 112 }
    ],
    obstacles: [],
    spawnY: (rand) => 400 + rand() * 80
  },
  {
    // OpenClaw Tower (baba_booey): the final level, after the rooftop. Three
    // strip tiles: lobby, server floor (ends in the elevator arena), penthouse
    // throne room (SHREDCLAW). One band for all three: the painted floors start
    // at y~340 (lobby/server) and y~380 (throne dais), so 384-500 reads as floor
    // on every tile. No painted blockers; the elevator/throne are backdrop.
    id: 'tower',
    width: WORLD_W,
    walkables: [
      { x: 0, y: 384, w: WORLD_W, h: 116 }
    ],
    obstacles: [],
    spawnY: (rand) => 400 + rand() * 84
  }
];
LEVELS[5] = SUBWAY_LEVEL; // cheese: subway train level (index 5; tower is 4)
LEVELS[6] = HARBOR_LEVEL; // mr_india: harbor docks at night (index 6)
LEVELS[7] = ARCADE_LEVEL; // mr_india: retro arcade interior (index 7)

export function levelForIndex(level = 0) {
  const n = LEVELS.length;
  return LEVELS[((level % n) + n) % n];
}

export function isWalkable(levelOrIndex, x, y, radius = 0) {
  const level = typeof levelOrIndex === 'number' ? levelForIndex(levelOrIndex) : levelOrIndex;
  const r = radius > 0 ? radius + 1 : 0;
  const inLane = (level.walkables || []).some(box => (
    x >= box.x + r &&
    x <= box.x + box.w - r &&
    y >= box.y + r &&
    y <= box.y + box.h - r
  ));
  if (!inLane) return false;
  return !(level.obstacles || []).some(box => (
    x >= box.x - r &&
    x <= box.x + box.w + r &&
    y >= box.y - r &&
    y <= box.y + box.h + r
  ));
}

export function resolveWalkable(levelOrIndex, x, y, radius = 0) {
  const level = typeof levelOrIndex === 'number' ? levelForIndex(levelOrIndex) : levelOrIndex;
  const r = radius > 0 ? radius : 0;
  if (isWalkable(level, x, y, r)) {
    return { x, y, allowed: true };
  }
  // Search near the body first (8px grid, widening rings) so a blocked step
  // nudges it aside instead of snapping across a long level.
  let best = null;
  for (const span of [48, 160, 600]) {
    for (let gx = x - span; gx <= x + span; gx += 8) {
      for (let gy = y - span; gy <= y + span; gy += 4) {
        if (!isWalkable(level, gx, gy, r)) continue;
        const d2 = (gx - x) ** 2 + (gy - y) ** 2;
        if (!best || d2 < best.d2) best = { x: Math.round(gx), y: Math.round(gy), d2 };
      }
    }
    if (best) break;
  }
  if (!best) for (const box of level.walkables || []) {
    for (let gx = box.x + r; gx <= box.x + box.w - r; gx += Math.max(1, (box.w - 2 * r + 1) / 40)) {
      for (let gy = box.y + r; gy <= box.y + box.h - r; gy += Math.max(1, (box.h - 2 * r + 1) / 5)) {
        if (!isWalkable(level, gx, gy, r)) continue;
        const d2 = (gx - x) ** 2 + (gy - y) ** 2;
        if (!best || d2 < best.d2) best = { x: Math.round(gx), y: Math.round(gy), d2 };
      }
    }
  }
  return best ? { x: best.x, y: best.y, allowed: false } : { x, y, allowed: false };
}

export function moveWalkable(p, dx, dy, dt, levelOrIndex = 0) {
  const level = typeof levelOrIndex === 'number' ? levelForIndex(levelOrIndex) : levelOrIndex;
  const r = p.r || 0;
  const speed = p.speed || 0;
  const nx = p.x + dx * speed * dt;
  const ny = p.y + dy * speed * dt;
  let x = p.x, y = p.y;
  if (isWalkable(level, nx, ny, r)) {
    x = nx; y = ny;
  } else {
    if (isWalkable(level, nx, y, r)) x = nx;
    if (isWalkable(level, x, ny, r)) y = ny;
  }
  return { x, y, blocked: !(x === nx && y === ny) };
}
