// specialfx.js: per-hero special-move FX sheets (mr_india, t_fd630e9e9b1c4c85).
// assets/fx/specials/<heroId>.png = 8 frames of 160x144 in one row (rects + anchors in that folder's README.md).
// Keyed off the existing special: a fresh combat attack with a health cost (combat.js start(), the J+L chord /
// pad RB), the same signal style.js and coach.js use. Wired from fx.js (step / player / over hooks): the sheet plays
// over ~0.5 s at the hero's feet, follows the hero, mirrors when facing left, never touches gameplay. Skipped with
// Reduced motion or Reduced flash (options-live.js, read only). window.__ppSpecialFX: spawned, skipped, draws, hold(hero, k).
import OPTIONS from './options-live.js';
export const SFX_FRAME = { w: 160, h: 144, n: 8 }, SFX_DUR = 0.5, SFX_SCALE = 1.35;
// Frame-space anchor that sits on the hero's feet (x measured toward the hero's facing).
export const SFX_ANCHOR = { turtle_purple: [80, 134], turtle_blue: [80, 134], turtle_red: [80, 140], turtle_orange: [80, 134], nous_girl: [22, 126], teknium: [10, 124], turbofit: [80, 140] };
export function createSpecialFX() {
  const img = {};
  if (typeof Image !== 'undefined') for (const id of Object.keys(SFX_ANCHOR)) { try { const im = new Image(); im.src = `assets/fx/specials/${id}.png`; img[id] = im; } catch (_) {} }
  const st = { live: [], lastAtk: null, cam: null, spawned: {}, skipped: 0, draws: {}, held: null };
  const reduced = () => { try { return !!(OPTIONS && (OPTIONS.reducedMotion || OPTIONS.reducedFlash)); } catch (_) { return false; } };
  function step(s, dt) {
    const c = s && s.combat; if (!c) return;
    const atk = c.attack, fresh = atk && atk !== st.lastAtk; st.lastAtk = atk;
    for (const f of st.live) f.t += dt; st.live = st.live.filter(f => f.t < SFX_DUR);
    if (!fresh || !atk.cost) return;
    const hero = s.selectedHero in SFX_ANCHOR ? s.selectedHero : null; if (!hero) return;
    if (reduced()) { st.skipped++; return; }
    st.live.push({ hero, t: 0, s, face: (c.attackFacing || c.facing || 1) < 0 ? -1 : 1 });
    st.spawned[hero] = (st.spawned[hero] || 0) + 1;
  }
  // Called from fx.player while the camera transform is on the context: remember it so over() can draw in world space.
  function mark(ctx) { try { st.cam = ctx.getTransform(); } catch (_) {} }
  function one(ctx, hero, k, p, face) {
    const im = img[hero]; if (!im || !im.complete || !im.naturalWidth) return;
    const [ax, ay] = SFX_ANCHOR[hero], { w, h } = SFX_FRAME, sc = SFX_SCALE;
    const fx0 = p.x, fy0 = p.y + (p.r || 16) - (p.z || 0);
    ctx.save(); ctx.translate(fx0, fy0); ctx.scale(face * sc, sc);
    ctx.drawImage(im, k * w, 0, w, h, -ax, -ay, w, h); ctx.restore();
    st.draws[hero] = (st.draws[hero] || 0) + 1;
  }
  function draw(ctx) {
    if ((!st.live.length && !st.held) || !st.cam) return;
    ctx.save(); ctx.setTransform(st.cam);
    if (st.held) { const p = st.held.s.player, c = st.held.s.combat; one(ctx, st.held.hero, st.held.k, p, c && c.facing < 0 ? -1 : 1); }
    for (const f of st.live) one(ctx, f.hero, Math.min(SFX_FRAME.n - 1, Math.floor(f.t / SFX_DUR * SFX_FRAME.n)), f.s.player, f.face);
    ctx.restore();
  }
  const api = { step, mark, draw, get live() { return st.live.length; }, get spawned() { return { ...st.spawned }; }, get skipped() { return st.skipped; }, get draws() { return { ...st.draws }; },
    hold(s, hero, k) { st.held = s && hero ? { s, hero, k: k | 0 } : null; }, reset() { st.live = []; st.lastAtk = null; } };
  if (typeof window !== 'undefined') window.__ppSpecialFX = api;
  return api;
}
