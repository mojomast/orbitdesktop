// Level props: the dressing MR.INDIA cut (props/*.png) placed where he specified,
// with the collision footprints from assets/props/PROPS.md.
//
// Placement rule: each prop's base sits on the back edge of the level's floor
// band, so the art stands on the floor the way the collision map describes it.
// Bands mirror assets/levels/LEVELS.md (sewer 363, street 358, rooftop 358).
//
// Objects are drawn bottom-anchored at (x, baseY) and their footprints become
// world obstacles for the collision map, so props block walking exactly where
// they look like they should (and stay jumpable, since barriers are jumpable in
// combat.js).

const PROPS = {
  crate: { file: 'crate.png', w: 62, h: 64, foot: [6, 43, 50, 21] },
  barrel: { file: 'barrel.png', w: 34, h: 56, foot: [3, 37, 28, 19] },
  valve: { file: 'valve.png', w: 39, h: 48, foot: [4, 32, 31, 16] },
  trashcan: { file: 'trashcan.png', w: 37, h: 56, foot: [4, 37, 29, 19] },
  hydrant: { file: 'hydrant.png', w: 29, h: 52, foot: [3, 35, 23, 17] },
  pizzaboxes: { file: 'pizzaboxes.png', w: 59, h: 48, foot: [6, 32, 47, 16] },
  acunit: { file: 'acunit.png', w: 55, h: 56, foot: [6, 37, 43, 19] },
};

// level id -> [prop, world x] (positions from MR.INDIA's list).
// Iteration 7: three segments per level, each dressed differently so the looping
// strip reads as new ground (segment 1 = original list, 2 and 3 vary the mix).
export const PLACEMENTS = {
  sewer: [['barrel', 700], ['valve', 1050], ['crate', 1650],
    ['valve', 2050], ['barrel', 2290], ['barrel', 2340], ['pizzaboxes', 2900], ['crate', 3450],
    ['barrel', 3950], ['valve', 4380], ['crate', 4700], ['barrel', 5150]],
  street: [['hydrant', 250], ['trashcan', 800], ['pizzaboxes', 1350],
    ['trashcan', 2000], ['trashcan', 2045], ['crate', 2550], ['hydrant', 3100], ['pizzaboxes', 3500],
    ['barrel', 3900], ['hydrant', 4300], ['trashcan', 4750], ['crate', 5200]],
  rooftop: [['acunit', 400], ['crate', 900], ['acunit', 1500],
    ['barrel', 2000], ['acunit', 2500], ['pizzaboxes', 3000], ['crate', 3400], ['crate', 3460],
    ['acunit', 3900], ['valve', 4400], ['barrel', 4800], ['acunit', 5200]],
};

const LEVEL_ORDER = ['sewer', 'street', 'rooftop', 'skate', 'tower', 'subway', 'harbor', 'arcade']; // skate/tower/subway: no placements (cheese: subway); mr_india: harbor (6) / arcade (7) draw their own props
const BAND_TOP = { sewer: 363, street: 358, rooftop: 358 };
export const PROP_WORLD_W = 1814 * 3;

export function placementsFor(levelIndex) {
  const id = LEVEL_ORDER[((levelIndex | 0) % LEVEL_ORDER.length + LEVEL_ORDER.length) % LEVEL_ORDER.length];
  return (PLACEMENTS[id] || []).map(([name, x]) => ({ name, x, spec: PROPS[name], baseY: BAND_TOP[id], level: id }));
}

// Footprint boxes in world coordinates, for the level collision maps.
export function propObstacles(levelIndex) {
  return placementsFor(levelIndex)
    .filter(p => p.spec)
    .map(({ x, spec, baseY }) => {
      const [fx, fy, fw, fh] = spec.foot;
      return { x: Math.round(x - spec.w / 2 + fx), y: Math.round(baseY - spec.h + fy), w: fw, h: fh };
    });
}

export function createProps() {
  const images = {};
  for (const [name, spec] of Object.entries(PROPS)) {
    const im = new Image();
    im.onload = () => { images[name] = im; };
    im.src = 'assets/props/' + spec.file;
  }
  let drawn = 0;
  // Draw every prop standing on its band, behind the actors (called before them).
  // mod (optional, breakables.js): mod(i) -> null to skip a smashed prop, or {rot, flash}.
  function draw(ctx, levelIndex, camL, camR, mod) {
    placementsFor(levelIndex).forEach((p, i) => {
      const im = images[p.name];
      if (!im || !p.spec) return;
      // Cheap culling: skip props fully outside the visible window.
      if (p.x + p.spec.w / 2 < camL - 20 || p.x - p.spec.w / 2 > camR + 20) return;
      const m = mod ? mod(i) : null;
      if (mod && m === null) return;
      if (m && (m.rot || m.flash)) {
        ctx.save(); ctx.translate(p.x, p.baseY); ctx.rotate(m.rot || 0);
        ctx.drawImage(im, -p.spec.w / 2, -p.spec.h, p.spec.w, p.spec.h);
        if (m.flash) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.5; ctx.drawImage(im, -p.spec.w / 2, -p.spec.h, p.spec.w, p.spec.h); }
        ctx.restore();
      } else ctx.drawImage(im, Math.round(p.x - p.spec.w / 2), Math.round(p.baseY - p.spec.h), p.spec.w, p.spec.h);
      drawn += 1;
    });
  }
  return { draw, images, stats: () => drawn };
}
