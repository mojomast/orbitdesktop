// Parallax and walking-level background segments.
// far:  ~0.2x, drawn behind transparent parts of the mid strip.
// mid:  1x, the side-scrolling level strip. Walking levels (sewer, street,
//       rooftop) draw three DISTINCT paintings, one per 1814 px strip tile
//       (baba_booey; built by pizza-panic-dev/tools/build_backgrounds.py).
// fg:   ~1.4x close-up props in screen space along the top and bottom edges,
//       darkened, fading out over fighters, skipped with Reduced motion
//       (baba_booey, t_1ad03aea0ea3452a; art from pizza-panic-dev/tools/build_fgprops.py).
import { OPTIONS } from './options-live.js'; // Hermes' accessibility store (Reduced motion)
const SRC = {
  far: { night: 'assets/levels/far/night.jpg', dusk: 'assets/levels/far/dusk.jpg', tower: 'assets/levels/far/tower.jpg', sewer: 'assets/levels/far/sewer.jpg' },
  mid: ['assets/levels/sewer_mid.png', 'assets/levels/street_mid.png', 'assets/levels/rooftop_mid.png', 'assets/levels/skate_mid.png', 'assets/levels/tower_mid.png'],
  // OpenClaw Tower (level 4): one painting per strip tile: lobby, server floor, penthouse.
  tower: ['assets/levels/tower_mid.png', 'assets/levels/tower_server_mid.png', 'assets/levels/tower_throne_mid.png'],
  // Tower tile overrides (JPG + mask): the server floor is its own red-alert lab
  // painting; tower_server_mid.png (the recoloured lobby) is only the fallback.
  towerSeg: { 1: 'assets/levels/seg/tower_1' },
  // Walking levels: tile k shows segment k. 'mid' = that level's *_mid.png above
  // (street/rooftop keep their sky-cut originals as tile 0); others are a JPG
  // plus an alpha mask PNG joined once at load.
  seg: [
    ['assets/levels/seg/sewer_a', 'assets/levels/seg/sewer_b', 'assets/levels/seg/sewer_c'],
    ['mid', 'assets/levels/seg/street_b', 'assets/levels/seg/street_c'],
    ['mid', 'assets/levels/seg/rooftop_b', 'assets/levels/seg/rooftop_c'],
  ],
};
export const TOWER_LEVEL = 4;
const FAR_FOR = ['sewer', 'night', 'dusk', 'dusk', 'tower'];
export const FAR_RATE = 0.2, FG_RATE = 1.4;
export const WALK_SEGMENTS = 3;
export const SKATE_PERIOD = 9600; // skate fg layout repeat (fg px): 12 props ~800 apart (baba_booey, t_ff6cf63cc2c04b1e; was 2600 for 3)
// Foreground prop sprites: drawn height h (px), how far they sink past the screen
// edge (negative = hangs that far below the top), optional horizontal stretch sx. 'kind@top' in a theme hangs it from the top.
export const FG_KINDS = {
  sewer_pipe: { h: 190, sink: 50 }, chain: { h: 300, sink: 40 }, sewer_lamp: { h: 300, sink: 20 },
  street_lamp: { h: 470, sink: 10 }, fence: { h: 230, sink: 30 }, hydrant: { h: 170, sink: 14 }, power_cable: { h: 140, sink: -96, sx: 2.2 }, // hangs just under the HUD panels
  cone: { h: 130, sink: 8 }, skate_rail: { h: 210, sink: 30 }, subway_pillar: { h: 530, sink: 10 }, turnstile: { h: 220, sink: 30 },
  water_tower: { h: 420, sink: 60 }, antenna: { h: 480, sink: 10 }, ac_unit: { h: 200, sink: 30 }, bollard: { h: 150, sink: 16 }, crates: { h: 250, sink: 40 },
  dock_lamp: { h: 470, sink: 10 }, cargo_net: { h: 300, sink: 10 }, server_rack: { h: 400, sink: 30 }, claw_banner: { h: 460, sink: 10 }, data_cables: { h: 320, sink: 20 },
  // skate run near-field set, from one atlas (FG_ATLAS); lit = neon, darkened less
  trash_bags: { h: 130, sink: 16 }, barricade: { h: 165, sink: 20 }, dumpster: { h: 210, sink: 26 }, tire_stack: { h: 185, sink: 20 },
  neon_slice: { h: 150, sink: -90, lit: true }, arrow_sign: { h: 340, sink: 10, lit: true }, hanging_cables: { h: 260, sink: 0 }, no_entry: { h: 300, sink: 10 },
};
// Atlas-packed props (one file for the 500-file publish limit): kind -> [x, y, w, h] in the
// atlas; see assets/levels/skate/fg/README.md and pizza-panic-dev/tools/build_skatefg.py.
export const FG_ATLAS = {
  src: 'assets/levels/skate/fg/skate_fg.png',
  frames: { trash_bags: [399, 302, 318, 264], barricade: [0, 0, 273, 300], dumpster: [275, 0, 277, 300], tire_stack: [132, 302, 265, 283],
    neon_slice: [719, 302, 196, 202], arrow_sign: [554, 0, 141, 300], hanging_cables: [697, 0, 250, 300], no_entry: [0, 302, 130, 300] },
};
// Per level (index = level id): the props in order of appearance, cycled. Arcade (7) has none.
export const FG_THEME = {
  0: ['sewer_lamp@top', 'sewer_pipe', 'chain@top', 'sewer_pipe@top'],                                         // sewer
  1: ['street_lamp', 'power_cable@top', 'hydrant', 'fence', 'street_lamp', 'cone', 'power_cable@top'],       // street
  2: ['antenna', 'power_cable@top', 'ac_unit', 'water_tower', 'power_cable@top'],                            // rooftop
  3: ['skate_rail', 'trash_bags', 'neon_slice@top', 'barricade', 'hanging_cables@top', 'tire_stack', 'arrow_sign', 'cone', 'dumpster', 'hanging_cables@top', 'no_entry', 'fence'], // skate run (repeats every SKATE_PERIOD)
  4: ['server_rack', 'data_cables@top', 'claw_banner', 'data_cables@top'],                                    // tower
  5: ['subway_pillar', 'power_cable@top', 'turnstile', 'chain@top'],                                          // subway
  6: ['dock_lamp', 'cargo_net@top', 'bollard', 'crates', 'chain@top'],                                         // harbor
};
// Deterministic sparse placement in foreground px (screen x = x - camX * FG_RATE):
// one prop every ~780-1220 px across the level (5442 world px -> ~7600 fg px).
export const FG = {};
for (const [lv, kinds] of Object.entries(FG_THEME)) {
  const L = +lv, end = L === 3 ? SKATE_PERIOD : 5442 * FG_RATE + 600, out = [];
  for (let i = 0, x = 380 + (L * 173) % 300; x < end; i++) {
    const [k, at] = kinds[i % kinds.length].split('@');
    out.push({ k, x, top: at === 'top' });
    x += L === 3 ? Math.round(SKATE_PERIOD / kinds.length) : 780 + ((i * 7919 + L * 104729) % 9) * 55;
  }
  FG[L] = out;
}
const fgReduced = () => { try { return !!OPTIONS.reducedMotion; } catch (_) { return false; } };

// A segment painting = <base>.jpg + <base>_mask.png (alpha), joined once into a
// canvas. onReady(drawable) gets the canvas (or the bare JPG if the mask fails).
// Shared by the subway/harbor/arcade modules for their per-tile segments.
export function loadSegment(base, onReady, onError) {
  if (typeof Image === 'undefined') return;
  const im = new Image(), mk = new Image(); let n = 0, maskOk = true;
  const done = () => {
    if (++n < 2) return;
    if (!maskOk || typeof document === 'undefined') { onReady(im); return; }
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext('2d'); if (!g) { onReady(im); return; }
    g.drawImage(im, 0, 0); g.globalCompositeOperation = 'destination-in'; g.drawImage(mk, 0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over'; onReady(c);
  };
  im.onload = done; im.onerror = () => { if (onError) onError(); };
  mk.onload = done; mk.onerror = () => { maskOk = false; done(); };
  im.src = base + '.jpg'; mk.src = base + '_mask.png';
}

export function createParallax() {
  const img = {};
  const load = (key, src) => { if (typeof Image === 'undefined') return; const im = new Image(); im.onload = () => { img[key] = im; }; im.onerror = () => { img[key + '_err'] = true; }; im.src = src; };
  for (const [k, v] of Object.entries(SRC.far)) load('far_' + k, v);
  SRC.mid.forEach((v, i) => load('mid_' + i, v));
  SRC.tower.forEach((v, i) => load('tower_' + i, v));
  // Foreground props load as darkened silhouettes (a canvas each), so they read as
  // close, out-of-focus scenery and never compete with fighters or telegraphs.
  const silhouette = (im, fr, lit) => {
    if (typeof document === 'undefined') return im;
    const [sx, sy, sw, sh] = fr || [0, 0, im.naturalWidth, im.naturalHeight];
    const c = document.createElement('canvas'); c.width = sw; c.height = sh; const g = c.getContext('2d'); if (!g) return im;
    g.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh); g.globalCompositeOperation = 'source-atop'; g.fillStyle = lit ? 'rgba(5,7,14,0.3)' : 'rgba(5,7,14,0.58)'; g.fillRect(0, 0, c.width, c.height); return c;
  };
  if (typeof Image !== 'undefined') { const im = new Image(); im.onload = () => { for (const [k, fr] of Object.entries(FG_ATLAS.frames)) img['fg_' + k] = silhouette(im, fr, FG_KINDS[k] && FG_KINDS[k].lit); }; im.onerror = () => { img.fg_atlas_err = true; }; im.src = FG_ATLAS.src; }
  for (const k of Object.keys(FG_KINDS)) { if (typeof Image === 'undefined') break; if (FG_ATLAS.frames[k]) continue; const im = new Image(); im.onload = () => { img['fg_' + k] = silhouette(im); }; im.onerror = () => { img['fg_' + k + '_err'] = true; }; im.src = 'assets/levels/fg/' + k + '.png'; }
  const cache = new Map(); // level -> [tile 0, 1, 2] drawables (canvas or image)
  const seg = {};
  const join = (key, base) => loadSegment(base, d => { seg[key] = d; }, () => { img[key + '_err'] = true; });
  SRC.seg.forEach((list, lv) => list.forEach((b, k) => { if (b !== 'mid') join('seg_' + lv + '_' + k, b); }));
  for (const [k, b] of Object.entries(SRC.towerSeg)) join('tower_seg_' + k, b);
  // Distinct per-tile paintings for a walking level; a tile still loading falls
  // back to the level's *_mid.png so nothing ever shows the canvas colour.
  function segmentImages(level) {
    if (!(level >= 0 && level < SRC.seg.length)) return null;
    if (cache.has(level)) return cache.get(level);
    const mid = img['mid_' + level];
    const out = SRC.seg[level].map((b, k) => (b === 'mid' ? mid : seg['seg_' + level + '_' + k]) || null);
    if (out.every(Boolean)) cache.set(level, out);
    return out.map(o => o || mid || null);
  }
  function tileVaried(ctx, level, camX, W, H) {
    const src = segmentImages(level);
    const first = src && src.find(Boolean);
    if (!first) return false;
    const w = first.width * (H / first.height);
    let x0 = -(((camX % w) + w) % w);
    for (let x = x0; x < W; x += w) {
      const tile = Math.floor((camX + x + 1) / w);
      const im = src[((tile % 3) + 3) % 3] || first;
      ctx.drawImage(im, x, 0, w, H);
    }
    return true;
  }
  function tile(ctx, im, offset, W, H) {
    const w = im.width * (H / im.height);
    let x0 = -(((offset % w) + w) % w);
    for (let x = x0; x < W; x += w) ctx.drawImage(im, x, 0, w, H);
  }
  // Tower: tile k of the world shows section k (lobby, server floor, throne room).
  function towerTiles(ctx, camX, W, H) {
    const first = img.tower_0 || img.mid_4; if (!first) return false;
    const w = first.width * (H / first.height);
    for (let x = -(((camX % w) + w) % w); x < W; x += w) {
      const k = Math.max(0, Math.min(2, Math.floor((camX + x + 1) / w)));
      ctx.drawImage(seg['tower_seg_' + k] || img['tower_' + k] || first, x, 0, w, H);
    }
    return true;
  }
  // Screen-space background (call before the world camera transform).
  function back(ctx, level, camX, W, H) {
    if (level === TOWER_LEVEL) {
      const far = img.far_tower || img.far_night;
      if (far) tile(ctx, far, camX * FAR_RATE, W, H);
      return towerTiles(ctx, camX, W, H) || !!far;
    }
    const far = img['far_' + FAR_FOR[level]];
    const base = img['mid_' + level];
    // Far always leads on the walking levels: the night/dusk sky behind the
    // street/rooftop sky cuts, and the sewer's own distant cavern (far/sewer.jpg)
    // through its tunnel arches and the dark vaults (never the night skyline).
    if (level <= 2 && far) tile(ctx, far, camX * FAR_RATE, W, H);
    let mid = false;
    if (level <= 2) mid = tileVaried(ctx, level, camX, W, H);
    if (!mid && base) { tile(ctx, base, camX, W, H); mid = true; }
    return !!(far || mid);
  }
  let shown = 0, faded = 0;
  const fade = new Map(); // placement id -> current alpha (eases toward its target)
  function placements(level, camX, W) {
    const out = [], list = FG[level] || [];
    const fx = camX * FG_RATE;
    if (level === 3) {
      const base = Math.floor(fx / SKATE_PERIOD) * SKATE_PERIOD;
      for (const rep of [base - SKATE_PERIOD, base, base + SKATE_PERIOD]) list.forEach((p, i) => out.push({ ...p, id: i + ':' + rep, sx: p.x + rep - fx }));
    } else list.forEach((p, i) => out.push({ ...p, id: String(i), sx: p.x - fx }));
    return out.filter(p => p.sx > -420 && p.sx < W + 420);
  }
  // Fighters on screen (feet x/y in screen px): P1, co-op P2 and every live enemy/boss.
  function fighters(camX, playerSX, playerSY) {
    const out = [{ x: playerSX, y: playerSY + 60 }];
    try {
      const s = typeof window !== 'undefined' && window.__ppState;
      if (s && s.ninjas) for (const n of s.ninjas) if (!n.dead && n.hp > 0) out.push({ x: n.x - camX, y: n.y, r: (n.r || 18) * (n.kind === 'boss' ? 3 : 1.6) });
      const c = typeof window !== 'undefined' && window.__ppCoop, p2 = c && c.p2 && c.p2.player;
      if (p2) out.push({ x: p2.x - camX, y: p2.y });
    } catch (_) {}
    return out;
  }
  function front(ctx, level, camX, W, H, playerSX, playerSY) {
    shown = 0; faded = 0;
    if (fgReduced()) return 0; // Reduced motion: no fast close-up layer at all
    const list = placements(level, camX, W); if (!list.length) return 0;
    const who = fighters(camX, playerSX, playerSY);
    for (const p of list) {
      const im = img['fg_' + p.k], K = FG_KINDS[p.k]; if (!im || !K) continue;
      const h = K.h, w = im.width * (h / im.height) * (K.sx || 1);
      const x = p.sx - w / 2, y = p.top ? -K.sink : H + K.sink - h;
      if (x > W || x + w < 0) continue;
      // over a fighter (body box ~150 px tall) -> nearly transparent
      const over = who.some(f => { const r = f.r || 30; return f.x + r > x - 24 && f.x - r < x + w + 24 && f.y > y - 10 && f.y - 150 < y + h; });
      const key = level + ':' + p.id, target = over ? 0.2 : p.top ? 0.8 : 0.88;
      const a = fade.has(key) ? fade.get(key) + (target - fade.get(key)) * 0.25 : target; fade.set(key, a);
      if (over) faded += 1;
      ctx.save(); ctx.globalAlpha = a; ctx.drawImage(im, x, y, w, h); ctx.restore();
      shown += 1;
    }
    if (fade.size > 400) fade.clear();
    return shown;
  }
  return { back, front, placements, fighters, images: img, stats: () => ({ shown, faded, reduced: fgReduced() }), segments: () => cache, segmentImages, towerTile: k => seg['tower_seg_' + k] || img['tower_' + k] || null };
}
