// Alternate hero palettes and unlocks.
//
// A palette is a filter string applied over a hero's existing rig draw, so no new art
// is needed and every palette works with every pose, weapon and effect instantly.
// Unlocks are a pure function of run progress, and the saved record is written through
// a guarded store: Orbit serves apps from a sandboxed origin where localStorage throws,
// so persistence must degrade to in-memory rather than breaking the module.

export const PALETTES = {
  turtle_purple: [
    { id: 'classic', name: 'Classic', filter: 'none' },
    { id: 'shadow', name: 'Shadow', filter: 'brightness(0.72) saturate(0.65) hue-rotate(210deg)' },
    { id: 'neon', name: 'Neon', filter: 'saturate(1.75) hue-rotate(300deg) brightness(1.08)' },
    { id: 'gold', name: 'Gold', filter: 'sepia(0.55) saturate(2.1) brightness(1.12) hue-rotate(-18deg)' },
  ],
  turtle_blue: [
    { id: 'classic', name: 'Classic', filter: 'none' },
    { id: 'shadow', name: 'Shadow', filter: 'brightness(0.7) saturate(0.7) hue-rotate(200deg)' },
    { id: 'neon', name: 'Neon', filter: 'saturate(1.8) hue-rotate(320deg) brightness(1.06)' },
    { id: 'ice', name: 'Ice', filter: 'saturate(0.9) brightness(1.14) hue-rotate(160deg)' },
  ],
  turtle_red: [
    { id: 'classic', name: 'Classic', filter: 'none' },
    { id: 'shadow', name: 'Shadow', filter: 'brightness(0.72) saturate(0.7) hue-rotate(190deg)' },
    { id: 'neon', name: 'Neon', filter: 'saturate(1.85) hue-rotate(340deg) brightness(1.06)' },
    { id: 'ember', name: 'Ember', filter: 'sepia(0.35) saturate(2.2) brightness(1.05) hue-rotate(-10deg)' },
  ],
  turtle_orange: [
    { id: 'classic', name: 'Classic', filter: 'none' },
    { id: 'shadow', name: 'Shadow', filter: 'brightness(0.74) saturate(0.7) hue-rotate(200deg)' },
    { id: 'neon', name: 'Neon', filter: 'saturate(1.8) hue-rotate(290deg) brightness(1.08)' },
    { id: 'toxic', name: 'Toxic', filter: 'saturate(1.9) hue-rotate(70deg) brightness(1.05)' },
  ],
  nous_girl: [
    { id: 'classic', name: 'Classic', filter: 'none' },
    { id: 'shadow', name: 'Shadow', filter: 'brightness(0.7) saturate(0.68) hue-rotate(205deg)' },
    { id: 'waveform', name: 'Waveform', filter: 'saturate(1.7) hue-rotate(265deg) brightness(1.1)' },
    { id: 'mono', name: 'Mono', filter: 'grayscale(1) brightness(1.06) contrast(1.15)' },
  ],
  teknium: [
    { id: 'classic', name: 'Classic', filter: 'none' },
    { id: 'shadow', name: 'Shadow', filter: 'brightness(0.7) saturate(0.66) hue-rotate(200deg)' },
    { id: 'circuit', name: 'Circuit', filter: 'saturate(1.9) hue-rotate(120deg) brightness(1.1)' },
    { id: 'overclock', name: 'Overclock', filter: 'saturate(2.1) hue-rotate(20deg) brightness(1.12) contrast(1.1)' },
  ],
  turbofit: [
    { id: 'classic', name: 'Classic', filter: 'none' },
    { id: 'shadow', name: 'Shadow', filter: 'brightness(0.7) saturate(0.66) hue-rotate(195deg)' },
    { id: 'feedback', name: 'Feedback', filter: 'saturate(1.9) hue-rotate(280deg) brightness(1.07)' },
    { id: 'chrome', name: 'Chrome', filter: 'grayscale(0.85) brightness(1.16) contrast(1.2)' },
  ],
};

// A palette unlocks from progress the game already tracks. Classic is always on, the
// second palette is yours after one clear, the rest after more.
export const UNLOCK_RULES = {
  classic: () => true,
  shadow: p => (p.stagesCleared || 0) >= 1,
  neon: p => (p.stagesCleared || 0) >= 2 || (p.bonusRuns || 0) >= 1,
  gold: p => (p.stagesCleared || 0) >= 3,
  ice: p => (p.stagesCleared || 0) >= 3,
  ember: p => (p.stagesCleared || 0) >= 3,
  toxic: p => (p.stagesCleared || 0) >= 3,
  waveform: p => (p.stagesCleared || 0) >= 2,
  mono: p => (p.assists || 0) >= 1,
  circuit: p => (p.stagesCleared || 0) >= 2,
  overclock: p => (p.coins || 0) >= 3000,
  feedback: p => (p.bestCombo || 0) >= 15,
  chrome: p => (p.noDamageClears || 0) >= 1,
};

export const palettesFor = hero => (PALETTES[hero] ? PALETTES[hero].map(p => p.id) : []);

// Which palettes a hero has unlocked given a progress record.
export function unlockedFor(hero, progress = {}) {
  return palettesFor(hero).filter(id => {
    const rule = UNLOCK_RULES[id];
    try { return rule ? !!rule(progress) : false; } catch { return false; }
  });
}

export function paletteOf(hero, id) {
  const list = PALETTES[hero] || [];
  return list.find(p => p.id === id) || list[0] || { id: 'classic', name: 'Classic', filter: 'none' };
}

// The filter string rig.draw applies; an unknown or locked palette falls back to classic.
export function tintFor(hero, id, progress = null) {
  if (progress && !unlockedFor(hero, progress).includes(id)) return 'none';
  return paletteOf(hero, id).filter;
}

// Guarded persistence: keep the choice in memory when storage is unavailable.
export function createPaletteStore() {
  const KEY = 'pp.palettes';
  let memory = { picked: {}, unlocked: {} };
  const read = () => {
    try {
      const raw = globalThis.localStorage && globalThis.localStorage.getItem(KEY);
      if (raw) return { ...memory, ...JSON.parse(raw) };
    } catch { /* sandboxed origin: fall through to memory */ }
    return memory;
  };
  const write = next => {
    memory = next;
    try { if (globalThis.localStorage) globalThis.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* memory only */ }
    return next;
  };
  return {
    get: () => read(),
    pick(hero, id) { const s = read(); s.picked = { ...s.picked, [hero]: id }; return write(s); },
    pickedFor(hero) { return read().picked[hero] || 'classic'; },
    recordUnlocked(hero, ids) { const s = read(); s.unlocked = { ...s.unlocked, [hero]: [...new Set([...(s.unlocked[hero] || []), ...ids])] }; return write(s); },
    unlocked(hero) { return read().unlocked[hero] || ['classic']; },
    clear() { memory = { picked: {}, unlocked: {} }; try { globalThis.localStorage && globalThis.localStorage.removeItem(KEY); } catch { /* ignore */ } },
  };
}
