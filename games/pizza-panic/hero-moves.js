// Per-hero move sets (task: unique specials and combo finishers).
//
// Every hero overrides two slots of the shared combat.js move table: the fourth hit
// of the punch string (the combo finisher) and the chord special. Overrides are full
// move records merged onto the base move, so they run through exactly the same
// hitbox code path (attackBox / targets / land) as everything else — no parallel
// combat system, just different numbers, reactions and labels per weapon.
//
// A move's `name` doubles as its animation key: the rig plays
// `${hero}_${name}_wind|active|recover`, so every entry here already has keyframes
// from the rig work (sweep, slashSpin, stabFlurry, nunchakuSpin, wave, bladeC, axeHeavy...).
// Slot keys the combat side resolves against:
//   finisher  -> the 4th hit of the punch string
//   special   -> the J+L chord (costs health, as before)
export const HERO_MOVES_COMBAT = {
  // Long reach: a flat bo sweep that knocks down, and a spin that clears both sides.
  turtle_purple: {
    finisher: { name: 'sweep', label: 'Bo Sweep', dmg: 2, range: 60, wind: 0.12, active: 0.12, rec: 0.3, knock: 380, react: 'knockdown', stop: 0.12, shake: 0.24, heavy: true, pierceGuard: true },
    special: { name: 'sweepSpin', label: 'Bo Whirl', dmg: 2, range: 84, wind: 0.12, active: 0.3, rec: 0.3, knock: 320, react: 'knockdown', stop: 0.14, shake: 0.44, heavy: true, around: true, cost: 8, invuln: 0.7, multi: 3, tick: 0.1 },
  },
  // Balanced swordplay: a lunging dash slash, and a spinning cyclone.
  turtle_blue: {
    finisher: { name: 'slashB', label: 'Dash Slash', dmg: 2, range: 56, wind: 0.11, active: 0.12, rec: 0.26, knock: 340, react: 'knockdown', stop: 0.11, shake: 0.26, heavy: true, lunge: 74, pierceGuard: true },
    special: { name: 'slashSpin', label: 'Blade Cyclone', dmg: 2, range: 78, wind: 0.1, active: 0.28, rec: 0.28, knock: 300, react: 'knockdown', stop: 0.13, shake: 0.4, heavy: true, around: true, cost: 8, invuln: 0.7, multi: 3, tick: 0.09 },
  },
  // Aggressive: a rapid sai flurry that pins the target, and a launcher uppercut.
  turtle_red: {
    finisher: { name: 'stabFlurry', label: 'Sai Flurry', dmg: 1, range: 44, wind: 0.09, active: 0.26, rec: 0.24, knock: 90, react: 'stagger', stop: 0.07, shake: 0.14, heavy: true, multi: 4, tick: 0.065 },
    special: { name: 'upper', label: 'Rising Uppercut', dmg: 3, range: 46, wind: 0.13, active: 0.13, rec: 0.3, knock: 470, react: 'launch', stop: 0.13, shake: 0.42, heavy: true, cost: 8, invuln: 0.6, pierceGuard: true },
  },
  // Acrobatic: a four-swing nunchaku flurry, and a long low slide kick.
  turtle_orange: {
    finisher: { name: 'nunchakuSpin', label: 'Nunchaku Flurry', dmg: 1, range: 52, wind: 0.09, active: 0.28, rec: 0.24, knock: 120, react: 'stagger', stop: 0.07, shake: 0.16, heavy: true, multi: 4, tick: 0.07 },
    special: { name: 'slide', label: 'Slide Kick', dmg: 2, range: 60, wind: 0.09, active: 0.2, rec: 0.3, knock: 360, react: 'knockdown', stop: 0.12, shake: 0.3, heavy: true, lunge: 132, cost: 8, invuln: 0.5, pierceGuard: true },
  },
  // Nous Girl: a mid-range sound wave, and a bass-drop shockwave that clears the floor.
  nous_girl: {
    finisher: { name: 'wave', label: 'Sound Wave', dmg: 2, range: 76, wind: 0.12, active: 0.14, rec: 0.26, knock: 300, react: 'stagger', stop: 0.1, shake: 0.26, heavy: true, pierceGuard: true },
    special: { name: 'bassDrop', label: 'Bass Drop', dmg: 3, range: 88, wind: 0.14, active: 0.24, rec: 0.3, knock: 420, react: 'knockdown', stop: 0.15, shake: 0.5, heavy: true, around: true, cost: 8, invuln: 0.7 },
  },
  // Teknium: a cancel-friendly blade finisher, and a data burst that surrounds him.
  teknium: {
    finisher: { name: 'bladeC', label: 'Blade Finisher', dmg: 2, range: 54, wind: 0.1, active: 0.13, rec: 0.22, knock: 320, react: 'knockdown', stop: 0.11, shake: 0.24, heavy: true, pierceGuard: true, cancel: true },
    special: { name: 'burst', label: 'Data Burst', dmg: 2, range: 82, wind: 0.11, active: 0.22, rec: 0.28, knock: 260, react: 'knockdown', stop: 0.13, shake: 0.4, heavy: true, around: true, cost: 8, invuln: 0.8, pierceGuard: true },
  },
  // TurboFit: the heaviest single hit, and a power chord that travels both ways.
  turbofit: {
    finisher: { name: 'axeHeavy', label: 'Guitar Axe Smash', dmg: 3, range: 58, wind: 0.16, active: 0.13, rec: 0.34, knock: 480, react: 'knockdown', stop: 0.16, shake: 0.44, heavy: true, lunge: 10 },
    special: { name: 'chord', label: 'Power Chord', dmg: 3, range: 96, wind: 0.15, active: 0.24, rec: 0.34, knock: 400, react: 'knockdown', stop: 0.16, shake: 0.55, heavy: true, around: true, cost: 8, invuln: 0.7, multi: 2, tick: 0.12 },
  },
};

const SLOT_BY_CHAIN = { punch4: 'finisher', healthSpecial: 'special' };

// Resolve a base move through the current hero's overrides. Called from combat.js at
// move-start time, so everything downstream (hitboxes, reactions, audio) sees the
// hero's version of the move. Unknown heroes/slots return the base move untouched.
export function heroMove(state, base, slot = null) {
  if (!base) return base;
  const hero = state && (state.hero || state.selectedHero);
  const table = hero && HERO_MOVES_COMBAT[hero];
  if (!table) return base;
  const key = slot || SLOT_BY_CHAIN[base.chainKey] || SLOT_BY_CHAIN[base.name] || base.name;
  const over = table[key];
  if (!over) return base;
  // Keep the base's grab/juggle flags so a finisher can never break the state machine.
  return { ...base, ...over, chainKey: base.chainKey, baseName: base.name };
}

// Read-only view for tests and for the controls screen.
export function heroMoveList(hero) {
  const t = HERO_MOVES_COMBAT[hero];
  if (!t) return [];
  return Object.entries(t).map(([slot, m]) => ({ slot, name: m.name, label: m.label, dmg: m.dmg, range: m.range, react: m.react, around: !!m.around, multi: m.multi || 1 }));
}
