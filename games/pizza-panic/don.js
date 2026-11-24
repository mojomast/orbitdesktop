// don.js: registers the 8th hero, Don Piedro Savastano (id don_piedro), through the existing exported tables
// (baba_booey, t_9ec48322f6de4bf7). A brown teddy bear in alien battle armour with a big spoon; Hermes' #1 fanboy.
// Nothing here edits rig.js internals: the spoon art is upright like turtle_blue's katana (same MANIFEST grip, 120),
// so Don plays turtle_blue's eased, planted keyframes (copied as don_piedro_* poses) with his own chain, kick and
// special. Art: assets/heroes/don_piedro/ (hero-rigs.js via MANIFEST.md), portraits/don_piedro.png, ui/victory/don_piedro.png,
// row 8 of portraits/reactions.png, assets/cine/title/don_piedro.png.  Lines: a level beat (events TRIGGERS) here; the
// intro panel lives in cinematics.js data. drawCineSpeaker() puts his portrait on the cinematic lines he speaks.
import { POSES, HERO_CHAIN, HERO_KICK, HERO_MOVES, HERO_SPECIALS, HEROES as RIG_HEROES, SOLES, WRIST } from './rig.js';
import { HERO_MOVES_COMBAT } from './hero-moves.js';
import { TRIGGERS } from './events.js';

export const DON = 'don_piedro';
const BASE = 'turtle_blue';
export const DON_PORTRAIT = 'assets/heroes/portraits/don_piedro.png';
// Readability rule for every Don line: on screen >= 2.5 s + 50 ms per character, then a short pause.
export const readFor = line => 2.5 + 0.05 * String(line).length;
export const DON_PAUSE = 0.6;
// story-v2: his catchphrase is exactly "Hello I Hermes biggest fanboi". These talk beats are his alone, so they
// only play when Don is in the run (P1 or P2): events.js skips a beat whose `only` hero is absent.
export const DON_CATCHPHRASE = 'Hello I Hermes biggest fanboi';
export const DON_LINES = {
  intro: ['DON PIEDRO: ' + DON_CATCHPHRASE + '.', 'DON PIEDRO: Claw boss want migrate Hermes? I bring spoon.'],
  sewer: DON_CATCHPHRASE,
  gate: 'Claw man, you no touch Hermes. I spoon you!',
};

function register() {
  if (HERO_CHAIN[DON]) return;
  // keyframes: every turtle_blue pose, under Don's name (idles, walk, jump, taunt, victory, moves, mechanics)
  for (const k of Object.keys(POSES)) if (k.startsWith(BASE + '_')) POSES[DON + k.slice(BASE.length)] = POSES[k];
  HERO_CHAIN[DON] = ['slash', 'slashUp', 'slashSpin'];
  HERO_KICK[DON] = 'slashB';
  HERO_MOVES[DON] = { ...HERO_MOVES[BASE] };
  HERO_SPECIALS[DON] = [{ move: 'slashSpin', name: 'Soup Tornado', rootSpin: 360, hits: 6, dmg: 2, knock: 280 }];
  if (!RIG_HEROES.includes(DON)) RIG_HEROES.push(DON);
  SOLES[DON] = [[5, 48], [41, 48]];   // boot heel / toe in shin px (slice_don_v2.py)
  if (WRIST[BASE]) WRIST[DON] = { ...WRIST[BASE] };
  HERO_MOVES_COMBAT[DON] = {
    finisher: { name: 'slashUp', label: 'Spoon Uppercut', dmg: 2, range: 58, wind: 0.12, active: 0.13, rec: 0.28, knock: 380, react: 'launch', stop: 0.12, shake: 0.3, heavy: true, pierceGuard: true },
    special: { name: 'slashSpin', label: 'Soup Tornado', dmg: 2, range: 82, wind: 0.1, active: 0.3, rec: 0.28, knock: 320, react: 'knockdown', stop: 0.13, shake: 0.42, heavy: true, around: true, cost: 8, invuln: 0.7, multi: 3, tick: 0.09 },
  };
  // level cutscene beats with his portrait (letterboxed events line); durations follow the readability rule
  const beat = (level, x, text) => { if (!TRIGGERS.some(t => t.level === level && t.x === x)) TRIGGERS.push({ level, x, type: 'talk', kinds: [], only: DON, speaker: 'DON PIEDRO', portrait: DON_PORTRAIT, line: text, lineDur: readFor(text) + DON_PAUSE }); };
  beat(0, 560, DON_LINES.sewer);
  beat(0, 4980, DON_LINES.gate);
}
register();

// Portrait chip for Don's cinematic lines (cinematics.js stacks the lines; the chip shows while his line is current).
let chip = null, fig = null;
export const DON_FIGURE = 'assets/cine/title/don_piedro.png';
export function drawCineSpeaker(ctx, W, H, cinema) {
  try {
    const id = cinema && cinema.scene && cinema.scene(); if (!id) return false;
    const panel = cinema.panels && cinema.panels()[id]; const d = cinema.debug && cinema.debug(); if (!panel || !d) return false;
    if (id === 'intro_don') {   // his full cutout stands on the plate for the whole FANBOY panel
      if (!fig && typeof Image !== 'undefined') { fig = new Image(); fig.src = DON_FIGURE; }
      if (fig && fig.complete && fig.naturalWidth) {
        const fh = Math.min(300, H - 200), fw = fh * fig.naturalWidth / fig.naturalHeight, bob = Math.sin((d.t || 0) * 3) * 3;
        ctx.save(); ctx.globalAlpha = d.phase === 'out' ? 0.6 : 1; ctx.drawImage(fig, W - fw - 40, H - 182 - fh + 6 + bob, fw, fh); ctx.restore();
      }
    }
    const li = d.phase === 'tail' || d.phase === 'out' ? panel.lines.length : d.li;
    const line = li >= 1 ? panel.lines[li - 1] : null;
    if (!line || !/^DON PIEDRO:/.test(line)) return false;
    if (!chip && typeof Image !== 'undefined') { chip = new Image(); chip.src = DON_PORTRAIT; }
    if (!chip || !chip.complete || !chip.naturalWidth) return false;
    const w = 96, h = 120, x = 14, y = H - 182 - h - 8;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - 4, y - 4, w + 8, h + 26);
    ctx.drawImage(chip, x, y, w, h);
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#ffd23f'; ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center'; ctx.fillText('DON PIEDRO', x + w / 2, y + h + 16);
    ctx.restore();
    return true;
  } catch (_) { return false; }
}
if (typeof window !== 'undefined') window.__ppDon = { DON, DON_LINES, readFor, drawCineSpeaker };
