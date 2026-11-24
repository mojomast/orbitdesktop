// Accessibility options.
//
// Small, explicit values with guarded persistence (Orbit's sandbox blocks storage, so
// the store degrades to memory). Defaults reproduce today's behaviour exactly: with
// nothing toggled the game must be byte-for-byte as it was, which is why every hook
// reads these through a getter rather than a baked-in branch.
export const DEFAULTS = {
  reducedFlash: false,    // dampen screen shake, hit flashes and the glitch/pulse effects
  reducedMotion: false,   // no camera pans or idle drift; things cut instead of gliding
  subtitleScale: 1,       // dialogue and bark text size multiplier
  textSpeed: 1,           // typewriter speed multiplier (0.5 = half speed, twice as long)
  colourSafe: false,      // telegraphs add a shape cue, not just a colour change
  holdToAdvance: false,   // dialogue only advances on a press, never on a timer
};

export const OPTION_META = {
  reducedFlash: { label: 'Reduced flash', note: 'Softer shake, dimmer hit flashes' },
  reducedMotion: { label: 'Reduced motion', note: 'Camera cuts instead of panning' },
  subtitleScale: { label: 'Subtitle size', min: 0.8, max: 1.6, step: 0.1 },
  textSpeed: { label: 'Text speed', min: 0.5, max: 2, step: 0.25 },
  colourSafe: { label: 'Colour-safe cues', note: 'Telegraphs get a shape, not just a colour' },
  holdToAdvance: { label: 'Hold to advance', note: 'Dialogue waits for you' },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sanitise = raw => {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULTS)) {
    const v = raw[key];
    if (typeof DEFAULTS[key] === 'boolean') out[key] = !!v;
    else if (typeof DEFAULTS[key] === 'number' && Number.isFinite(v)) {
      const meta = OPTION_META[key] || {};
      out[key] = clamp(v, meta.min != null ? meta.min : 0, meta.max != null ? meta.max : 4);
    }
  }
  return out;
};

export function createOptions() {
  const KEY = 'pp.options';
  // The live values are held in this module so game code can read them without a
  // dependency chain, and so a test can drive them directly.
  const values = { ...DEFAULTS };
  Object.assign(values, sanitise(readRaw()));
  let listeners = [];

  function readRaw() {
    try {
      const raw = globalThis.localStorage && globalThis.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }               // sandboxed origin: memory only
  }
  function persist() {
    try { if (globalThis.localStorage) globalThis.localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* memory only */ }
  }
  function set(key, v) {
    if (!(key in DEFAULTS)) return values[key];
    const next = sanitise({ ...values, [key]: v })[key];
    if (values[key] === next) return next;
    values[key] = next;
    persist();
    for (const fn of listeners) { try { fn(key, next); } catch { /* a listener must not break the game */ } }
    return next;
  }
  function toggle(key) {
    if (typeof DEFAULTS[key] !== 'boolean') return values[key];
    return set(key, !values[key]);
  }
  function reset() { for (const k of Object.keys(DEFAULTS)) values[k] = DEFAULTS[k]; persist(); }
  function onChange(fn) { listeners.push(fn); return () => { listeners = listeners.filter(f => f !== fn); }; }

  // Shorthands the rest of the game reads. Each one is a plain getter so a toggle
  // takes effect on the next frame with no re-plumbing.
  const api = {
    values,
    get: key => values[key],
    set, toggle, reset, onChange,
    get reducedFlash() { return values.reducedFlash; },
    get reducedMotion() { return values.reducedMotion; },
    get subtitleScale() { return values.subtitleScale; },
    get textSpeed() { return values.textSpeed; },
    get colourSafe() { return values.colourSafe; },
    get holdToAdvance() { return values.holdToAdvance; },
    // Screen-shake multiplier: reduced flash damps shake to a third.
    get shakeScale() { return values.reducedFlash ? 0.33 : 1; },
    // Camera ease multiplier: reduced motion snaps instead of gliding.
    get motionScale() { return values.reducedMotion ? 0 : 1; },
    // A typewriter rate adjusted for text speed (never faster than 4x, never zero).
    typeRate: base => Math.max(4, (Number(base) || 46) * values.textSpeed),
    // Dialogue text size.
    fontFor: (size, family = 'monospace') => `${Math.round(size * values.subtitleScale)}px ${family}`,
    // Hold-to-advance or timer: how long a line is allowed to sit before it moves on.
    holdFor: (line, baseHold) => (values.holdToAdvance ? Infinity : baseHold),
    meta: OPTION_META,
  };
  if (typeof window !== 'undefined') window.__ppOptions = api;
  return api;
}
