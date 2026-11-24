// mr_india (render-bug fix, t_04ffd001df3944ed): failed images heal themselves.
// Every art loader in the game keys off onload (img[k] = im) and never retries,
// so an image that failed once stayed missing for the whole session and the
// renderer fell back to placeholder circles and a flat floor. A failure takes
// only a moment: a republish swapping the app folder, a PNG caught mid-write,
// a busy server. game.js imports this module first, so it wraps every Image
// that is created while the other modules load. A failed load retries with
// backoff and a cache-busting query until it succeeds; when it does, the
// loader's own onload runs as usual. Stats: window.__ppAssetRetry.
const MAX_TRIES = 12;
if (typeof HTMLImageElement !== 'undefined' && !HTMLImageElement.prototype.__ppRetry) {
  const proto = HTMLImageElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'src');
  const stats = { failed: 0, retries: 0, healed: 0, gaveUp: 0, broken: new Set() };
  if (typeof window !== 'undefined') window.__ppAssetRetry = stats;
  if (desc && desc.set && desc.get) {
    Object.defineProperty(proto, '__ppRetry', { value: true });
    const retryable = src => !/^(data|blob):/i.test(src);
    function onError() {
      const base = this.__ppBase;
      if (!base || !retryable(base)) return;
      if (!this.__ppTries) stats.failed++;
      stats.broken.add(base);
      if (this.__ppTries >= MAX_TRIES) { stats.gaveUp++; return; }
      const n = ++this.__ppTries;
      clearTimeout(this.__ppTimer);
      this.__ppTimer = setTimeout(() => {
        if (this.__ppBase !== base) return; // the loader moved on to another file
        stats.retries++;
        this.__ppRetrying = true;
        try { this.src = base + (base.includes('?') ? '&' : '?') + '_r=' + n; } finally { this.__ppRetrying = false; }
      }, Math.min(8000, 400 * 2 ** (n - 1)));
    }
    function onLoad() {
      if (this.__ppTries) { stats.healed++; stats.broken.delete(this.__ppBase); }
      this.__ppTries = 0;
    }
    Object.defineProperty(proto, 'src', {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set(v) {
        if (!this.__ppRetrying) { this.__ppBase = String(v); this.__ppTries = 0; clearTimeout(this.__ppTimer); }
        if (!this.__ppHooked) { this.__ppHooked = true; this.addEventListener('error', onError); this.addEventListener('load', onLoad); }
        desc.set.call(this, v);
      }
    });
  }
}
export const assetRetry = typeof window !== 'undefined' ? window.__ppAssetRetry : null;
