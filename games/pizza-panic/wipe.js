// wipe.js: OpenClaw claw-slash stage wipe (mr_india, t_96f516de1275486c).
// Plays assets/ui/wipes/wipe_01..10.png over ~0.5 s when gameplay comes back up on a new stage (after the clear card,
// bonus and shop close). Pure overlay: never touches input or stage logic, and any frame that hasn't loaded is skipped.
// Skipped entirely with Reduced motion or Reduced flash (options-live.js, read only) and with ?wipe=0.
// window.__ppWipe: play(), playing, plays, skipped, frame, hold(k|null) (tests only: pin a frame for a screenshot).
import OPTIONS from './options-live.js';
export const WIPE_FRAMES = 10, WIPE_DUR = 0.5;
export function createWipe() {
  const frames = [];
  if (typeof Image !== 'undefined') for (let i = 1; i <= WIPE_FRAMES; i++) { try { const im = new Image(); im.src = `assets/ui/wipes/wipe_${String(i).padStart(2, '0')}.png`; frames.push(im); } catch (_) {} }
  let off = false; try { off = /[?&]wipe=0/.test(String(globalThis.location && globalThis.location.search || '')); } catch (_) {}
  let held = null; // tests: hold(k) pins frame k on screen for a screenshot
  const st = { t: -1, lastS: null, lastLevel: null, plays: 0, skipped: 0, frame: -1 };
  const reduced = () => { try { return !!(OPTIONS && (OPTIONS.reducedMotion || OPTIONS.reducedFlash)); } catch (_) { return false; } };
  function play() { if (off || reduced()) { st.skipped++; return false; } st.t = 0; st.plays++; return true; }
  function draw(ctx, W, H, s, dt, live) {
    if (!s) return;
    if (s !== st.lastS) { st.lastS = s; st.lastLevel = null; } // a new run starts without a wipe
    if (live) { if (st.lastLevel !== null && s.level !== st.lastLevel) play(); st.lastLevel = s.level; }
    if (held !== null) { const im = frames[held]; if (im && im.complete && im.naturalWidth) ctx.drawImage(im, 0, 0, W, H); return; }
    if (st.t < 0) return;
    const k = Math.floor(st.t / WIPE_DUR * WIPE_FRAMES); st.t += Math.min(dt || 0, 0.1);
    if (k >= WIPE_FRAMES) { st.t = -1; st.frame = -1; return; }
    st.frame = k; const im = frames[k];
    if (im && im.complete && im.naturalWidth) ctx.drawImage(im, 0, 0, W, H);
  }
  const api = { play, draw, get playing() { return st.t >= 0; }, get plays() { return st.plays; }, get skipped() { return st.skipped; }, get frame() { return st.frame; }, hold(k) { held = k == null ? null : Math.max(0, Math.min(WIPE_FRAMES - 1, k | 0)); } };
  if (typeof window !== 'undefined') window.__ppWipe = api;
  return api;
}
