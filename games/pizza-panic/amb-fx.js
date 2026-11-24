// amb-fx.js: animated level ambience in the background layers (mr_india, t_dd91539751db48a4).
// One sheet per level in assets/ambience/ (rects in its README.md): sewer steam, street neon flicker, subway sparks,
// rooftop rain, tower pigeons. Drawn from game.js right after the far/mid parallax layers and ambient.drawBack, before
// the world transform, so props, fighters and enemies always draw on top. Low alpha, own parallax factor, a few fixed
// spots per level. Arcade, harbor and skate get nothing. Off under Reduced motion (options-live.js, read only) and ?amb=0.
// window.__ppAmbFx: draws (per level), skipped, enabled.
import OPTIONS from './options-live.js';
export const AMB_SHEETS = { sewer: [112, 160, 8], street: [97, 118, 8], subway: [128, 120, 6], rooftop: [160, 70, 8], tower: [64, 56, 8] }; // frame w, h, count
// Per level: sheet, parallax factor, alpha, scale, spots { period, x (screen-space offset), y (top) } and frame timing.
const LEVELS = {
  0: { sheet: 'sewer', par: 0.6, alpha: 0.5, sc: 1, spots: [{ p: 560, x: 150, y: 196 }, { p: 560, x: 430, y: 214, ph: 0.5 }], dur: 0.13 },
  1: { sheet: 'street', par: 0.6, alpha: 0.75, sc: 0.62, spots: [{ p: 980, x: 520, y: 112 }], durs: [1.2, 0.6, 0.08, 0.5, 0.08, 0.06, 1.0, 0.3] },
  5: { sheet: 'subway', par: 0.7, alpha: 0.75, sc: 0.7, spots: [{ p: 760, x: 260, y: 40 }, { p: 760, x: 610, y: 30, ph: 0.45 }], durs: [0.06, 0.06, 0.06, 0.07, 0.08, 0.1], idle: 1.4 },
  2: { sheet: 'rooftop', par: 0.8, alpha: 0.32, sc: 1, tile: { y0: 0, y1: 330 }, dur: 0.06 },
  4: { sheet: 'tower', par: 0.3, alpha: 0.7, sc: 0.62, birds: [{ x: 0, y: 70, v: 46, ph: 0 }, { x: 60, y: 92, v: 46, ph: 3 }, { x: 110, y: 62, v: 46, ph: 5 }, { x: 400, y: 120, v: 38, ph: 2 }], dur: 0.09 },
};
export function createAmbFx() {
  const img = {};
  if (typeof Image !== 'undefined') for (const k of Object.keys(AMB_SHEETS)) { try { const im = new Image(); im.src = `assets/ambience/${k}.png`; img[k] = im; } catch (_) {} }
  let off = false; try { off = /[?&]amb=0/.test(String(globalThis.location && globalThis.location.search || '')); } catch (_) {}
  const st = { t: 0, draws: {}, skipped: 0 };
  const reduced = () => { try { return !!(OPTIONS && OPTIONS.reducedMotion); } catch (_) { return false; } };
  const frameAt = (cfg, t) => {
    const n = AMB_SHEETS[cfg.sheet][2];
    if (!cfg.durs) return Math.floor(t / cfg.dur) % n;
    const total = cfg.durs.reduce((a, b) => a + b, 0) + (cfg.idle || 0); let u = t % total;
    for (let i = 0; i < n; i++) { if (u < cfg.durs[i]) return i; u -= cfg.durs[i]; } return -1; // -1 = idle gap (nothing drawn)
  };
  function draw(ctx, s, camX, W, H, dt) {
    st.t += Math.min(dt || 0, 0.1);
    const cfg = s && LEVELS[s.level | 0]; if (!cfg) return;
    if (off || reduced()) { st.skipped++; return; }
    const im = img[cfg.sheet]; if (!im || !im.complete || !im.naturalWidth) return;
    const [fw, fh] = AMB_SHEETS[cfg.sheet], sc = cfg.sc, w = fw * sc, h = fh * sc, cx = (camX || 0) * cfg.par;
    ctx.save(); ctx.globalAlpha = cfg.alpha; let n = 0;
    const blit = (k, x, y, flip) => { if (k < 0) return; if (flip) { ctx.save(); ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(im, k * fw, 0, fw, fh, 0, 0, w, h); ctx.restore(); } else ctx.drawImage(im, k * fw, 0, fw, fh, x, y, w, h); n++; };
    if (cfg.tile) {
      const k = frameAt(cfg, st.t), x0 = -(((cx % w) + w) % w);
      for (let y = cfg.tile.y0; y < cfg.tile.y1; y += h) for (let x = x0; x < W; x += w) blit(k, x, y);
    } else if (cfg.birds) {
      const span = W + 200;
      for (const b of cfg.birds) { const x = ((((b.x - st.t * b.v - cx) % span) + span) % span) - 100; blit(frameAt(cfg, st.t + b.ph * 0.09), x, b.y + Math.sin(st.t * 1.3 + b.ph) * 4); }
    } else {
      for (const sp of cfg.spots) {
        const per = cfg.durs ? cfg.durs.reduce((a, b) => a + b, 0) + (cfg.idle || 0) : cfg.dur * AMB_SHEETS[cfg.sheet][2];
        const k = frameAt(cfg, st.t + (sp.ph || 0) * per);
        for (let x = (((sp.x - cx) % sp.p) + sp.p) % sp.p - sp.p; x < W; x += sp.p) if (x + w > 0) blit(k, x, sp.y);
      }
    }
    ctx.restore();
    if (n) st.draws[s.level | 0] = (st.draws[s.level | 0] || 0) + n;
  }
  const api = { draw, get draws() { return { ...st.draws }; }, get skipped() { return st.skipped; }, get enabled() { return !off && !reduced(); } };
  if (typeof window !== 'undefined') window.__ppAmbFx = api;
  return api;
}
