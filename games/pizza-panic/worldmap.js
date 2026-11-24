// World map interstitial between stages (baba_booey, t_5f5d1eed411041b2).
// When play resumes on a NEW stage (after the clear card, bonus and shop have all closed, the
// same moment wipe.js keys off), a ~2.5 s city map shows the route: cleared stages get the red
// stamp, the hero pin glides (eased, straight) from the stage just cleared to the next one, which
// pulses under a bobbing slice pointer; later stages are gray with a padlock. Any key / pad button
// skips (game.js routes keydown here while active). Reduced motion: one static frame (pin
// already on the next node, no pulse/bob), still skippable. ?map=0 turns it off; automation (webdriver) too unless ?map=1.
// Nodes are keyed by stage NAME (LEVELS[i].id), so LEVEL_ORDER can differ from the drawn route.
// Art: assets/map/map.jpg (960x540) + assets/map/map_ui.png (one atlas), see assets/map/MANIFEST.md.
import { OPTIONS } from './options-live.js';
import { LEVEL_ORDER } from './logic.js';
import { LEVELS } from './collision.js';

export const MAP_DUR = 2.5;
export const MAP_SIZE = [960, 540];
// node centres in map px, by stage name (built by pizza-panic-dev/tools/build_worldmap.py)
export const MAP_NODES = { sewer: [108, 429], street: [188, 236], skate: [377, 171], subway: [484, 304], rooftop: [631, 177], harbor: [781, 372], arcade: [841, 244], tower: [796, 112] };
export const MAP_UI = { pin: [0, 0, 81, 96], slice: [83, 0, 69, 96], stamp: [154, 0, 93, 96], lock: [249, 0, 75, 96], node_gold: [326, 0, 93, 96], node_gray: [421, 0, 92, 96] };
export const STAGE_TITLES = { sewer: 'SEWER', street: 'STREET', skate: 'SKATE RUN', subway: 'SUBWAY', rooftop: 'ROOFTOPS', harbor: 'HARBOR', arcade: 'ARCADE', tower: 'OPENCLAW TOWER' };
const nameOf = lv => (LEVELS[lv] && LEVELS[lv].id) || null;
const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

export function createWorldMap({ audio } = {}) {
  const img = {};
  if (typeof Image !== 'undefined') for (const [k, src] of [['map', 'assets/map/map.jpg'], ['ui', 'assets/map/map_ui.png']]) { try { const im = new Image(); im.onload = () => { img[k] = im; }; im.onerror = () => { img[k + '_err'] = true; }; im.src = src; } catch (_) {} }
  // Off with ?map=0. Also off under automation (navigator.webdriver) so the existing headless suites that
  // drive stage changes keep their timing; ?map=1 forces it on (check-worldmap does).
  let off = false; try { const q = String(globalThis.location && globalThis.location.search || ''); off = /[?&]map=0/.test(q) || (!/[?&]map=1/.test(q) && !!(globalThis.navigator && navigator.webdriver)); } catch (_) {}
  const reduced = () => { try { return !!OPTIONS.reducedMotion; } catch (_) { return false; } };
  const play = n => { try { audio && audio.play && audio.play(n); } catch (_) {} };
  let st = null, lastS = null, lastLevel = null, gated = false;
  const stats = { shown: 0, skipped: 0, done: 0, last: null };
  // Start a map for the move from stage `from` to stage `to` (level ids). Returns false if either has no node.
  function show(from, to) {
    const a = nameOf(from), b = nameOf(to);
    if (off || !MAP_NODES[a] || !MAP_NODES[b]) return false;
    const idx = LEVEL_ORDER.indexOf(to);
    st = { t: 0, from: a, to: b, toLevel: to, cleared: LEVEL_ORDER.slice(0, Math.max(0, idx)).map(nameOf), reduced: reduced(), landed: false };
    stats.shown++; stats.last = { from: a, to: b, cleared: st.cleared.slice(), reduced: st.reduced }; play('pause');
    return true;
  }
  function finish(skipped) { if (!st) return; st = null; if (skipped) stats.skipped++; stats.done++; }
  function skip() { if (st) { finish(true); play('start'); return true; } return false; }
  function handleKey(e) { if (!st) return false; if (e && (e.repeat || /^(Shift|Control|Alt|Meta)/.test(e.code || ''))) return true; skip(); return true; }
  // Per frame from game.js draw(): `live` = play would run now (no screen/shop/bonus/cinema/pause/over).
  function draw(ctx, W, H, s, dt, live) {
    if (!s) return;
    if (s !== lastS) { lastS = s; lastLevel = null; st = null; gated = false; } // a new run (or a resumed save) starts without a map
    // Only a stage change that happened behind a gate (clear card / bonus / shop, i.e. not live) shows the
    // map; a level poked mid-play (debug jumps, test harnesses) does not.
    if (!live) gated = true;
    else if (!st) {
      const lv = s.level | 0;
      if (gated && lastLevel !== null && lv !== lastLevel && LEVEL_ORDER.indexOf(lv) > LEVEL_ORDER.indexOf(lastLevel)) show(lastLevel, lv);
      lastLevel = lv; gated = false;
    }
    if (!st) return;
    st.t += Math.min(dt || 0, 0.1);
    if (st.t >= MAP_DUR) { finish(false); return; }
    render(ctx, W, H);
  }
  function sprite(ctx, k, cx, cy, h, anchorBottom) {
    const im = img.ui, f = MAP_UI[k]; if (!im || !f) return;
    const w = f[2] * h / f[3]; ctx.drawImage(im, f[0], f[1], f[2], f[3], cx - w / 2, anchorBottom ? cy - h : cy - h / 2, w, h);
  }
  function render(ctx, W, H) {
    const t = st.t, r = st.reduced;
    const k = W / MAP_SIZE[0], mh = MAP_SIZE[1] * k, y0 = (H - mh) / 2;
    const P = n => [MAP_NODES[n][0] * k, y0 + MAP_NODES[n][1] * k];
    const a = r ? 1 : Math.min(1, t / 0.2, (MAP_DUR - t) / 0.25);
    ctx.save(); ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = '#05060c'; ctx.fillRect(0, 0, W, H);
    if (img.map) ctx.drawImage(img.map, 0, y0, W, mh); else { ctx.fillStyle = '#141a2e'; ctx.fillRect(0, y0, W, mh); }
    // the leg being travelled: a gold dashed line (the painted route follows its own order)
    const [ax, ay] = P(st.from), [bx, by] = P(st.to);
    ctx.save(); ctx.strokeStyle = 'rgba(255,214,90,0.85)'; ctx.lineWidth = 3; ctx.setLineDash([6, 6]); ctx.lineDashOffset = r ? 0 : -t * 30;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.restore();
    for (const lv of LEVEL_ORDER) {
      const n = nameOf(lv); if (!MAP_NODES[n]) continue;
      const [x, y] = P(n), done = st.cleared.includes(n), next = n === st.to;
      if (next) {
        const pulse = r ? 1 : 1 + 0.14 * Math.sin(t * 9);
        sprite(ctx, 'node_gold', x, y, 34 * pulse);
        sprite(ctx, 'slice', x, y - 50 - (r ? 0 : Math.abs(Math.sin(t * 5)) * 8), 26, true);
      } else if (done) { sprite(ctx, 'node_gold', x, y, 30); sprite(ctx, 'stamp', x + 9, y - 9, 22); }
      else { sprite(ctx, 'node_gray', x, y, 28); sprite(ctx, 'lock', x + 10, y + 9, 14); }
    }
    // hero pin: eased straight glide from the cleared stage to the next one, tip on the node
    const p = r ? 1 : ease(Math.min(1, Math.max(0, (t - 0.35) / 1.3)));
    if (p >= 1 && !st.landed) { st.landed = true; if (!r) play('chime'); }
    const hop = r ? 0 : Math.sin(p * Math.PI) * 26;
    sprite(ctx, 'pin', ax + (bx - ax) * p, ay + (by - ay) * p - 8 - hop, 40, true);
    // captions (canvas text, nothing baked into the art)
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffe86b'; ctx.font = 'bold 20px monospace';
    ctx.fillText('NEXT: ' + (STAGE_TITLES[st.to] || st.to.toUpperCase()), W / 2, Math.max(22, y0 - 14));
    ctx.fillStyle = 'rgba(220,230,255,0.75)'; ctx.font = '11px monospace';
    ctx.fillText('STAGE ' + (LEVEL_ORDER.indexOf(st.toLevel) + 1) + ' / ' + LEVEL_ORDER.length + '   -   any key: skip', W / 2, Math.min(H - 8, y0 + mh + 20));
    ctx.restore();
  }
  const api = { draw, show, skip, handleKey, active: () => !!st, get t() { return st ? st.t : -1; }, get state() { return st && { ...st, cleared: st.cleared.slice() }; }, stats: () => ({ ...stats }), images: img, get off() { return off; } };
  if (typeof window !== 'undefined') window.__ppMap = api;
  return api;
}
