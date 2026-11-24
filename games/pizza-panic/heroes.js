// pipi's character select data. Art sources are MR.INDIA's cutout heroes, and the
// rigs for each hero are owned by Hermes; the menu only displays text stats.
// Roster corrected to Kyle's swap: hermes_girl is replaced by nous_girl (Nous
// Research mascot). Hero ids double as rig kinds. Order is the select-screen order.
// weapon + blurb: one-line style shown under the grid; stat: the numbers line.
export const HEROES = [
  { id: 'turtle_purple', name: 'PURPLE TURTLE', weapon: 'BO STAFF', blurb: 'Long reach: wide staff sweeps and a pole-vault kick.', stat: 'LONG REACH  SPD 3 / ATK 3 / RNG 5 / SWEEP 5' },
  { id: 'turtle_blue', name: 'BLUE TURTLE', weapon: 'KATANA', blurb: 'Balanced blade master: fast slash chains and a spin attack.', stat: 'BALANCED  SPD 3 / ATK 3 / RNG 4 / CHAIN 3' },
  { id: 'turtle_red', name: 'RED TURTLE', weapon: 'SAI', blurb: 'Up close and angry: rapid sai stabs and a rising uppercut.', stat: 'AGGRESSIVE  SPD 4 / ATK 5 / RNG 2 / STABS 5' },
  { id: 'turtle_orange', name: 'ORANGE TURTLE', weapon: 'NUNCHAKU', blurb: 'Acrobat: multi-hit nunchaku spins and a slide kick.', stat: 'ACROBATIC  SPD 5 / ATK 3 / RNG 4 / SPIN 5' },
  { id: 'nous_girl', name: 'NOUS GIRL', weapon: 'AUDIO CABLE', blurb: 'Agile caster: cable whips up close, sound-wave blasts at range.', stat: 'AGILE  SPD 4 / ATK 2 / RNG 5 / SOUND WAVE' },
  { id: 'teknium', name: 'TEKNIUM', weapon: 'ENERGY BLADE', blurb: 'Technical combo engine: long blade chains and dash-throughs.', stat: 'TECHNICAL  SPD 4 / ATK 3 / RNG 4 / CHAIN 5' },
  { id: 'turbofit', name: 'TURBOFIT', weapon: 'GUITAR AXE', blurb: 'Heavy hitter: slow axe swings and a power-chord shockwave.', stat: 'HEAVY  SPD 2 / ATK 5 / RNG 4 / SHOCKWAVE' },
  // baba_booey (t_9ec48322f6de4bf7): Hermes' #1 fanboy, registered for the rig/combat in don.js
  { id: 'don_piedro', name: 'DON PIEDRO', weapon: 'BIG SPOON', blurb: 'Hermes\' #1 fan: spoon bonks, a launching uppercut and a Soup Tornado.', stat: 'FANBOY  SPD 3 / ATK 4 / RNG 4 / SOUP 5' }
];
export function heroFor(id) { return HEROES.find(h => h.id === id) || HEROES[0]; }
