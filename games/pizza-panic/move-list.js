// move-list.js — a per-hero overlay listing the moves and specials. It reuses
// only screen-space canvas text, so it never interrupts the game loop or combat
// state machine; toggling just flips one boolean.
const LINES = {
  turtle_purple: ['PURPLE TURTLE — BO STAFF', '', 'J (x4) Bo Sweep: 4th hit sweeps 60px and knocks down', 'K Kick, L Jump, J+K Back attack, J+L special', 'J+L Bo Whirl: spins in place and hits both sides'],
  turtle_blue: ['BLUE TURTLE — KATANA', '', 'J (x4) Dash Slash: 74px lunge, pierces guard', 'K Kick, L Jump, J+K Back attack, J+L special', 'J+L Blade Cyclone: dual sword sweep, wide depth'],
  turtle_red: ['RED TURTLE — SAI', '', 'J (x4) Sai Flurry: 4 rapid hits on the string', 'K Kick, L Jump, J+K Back attack, J+L special', 'J+L Rising Uppercut: launcher uppercut'],
  turtle_orange: ['ORANGE TURTLE — NUNCHAKU', '', 'J (x4) Nunchaku Flurry: 4 multi-hit swings', 'K Kick, L Jump, J+K Back attack, J+L special', 'J+L Slide Kick: 132px low slide'],
  nous_girl: ['NOUS GIRL — AUDIO CABLE', '', 'J (x4) Sound Wave: mid-range stagger at 76px', 'K Kick, L Jump, J+K Back attack, J+L special', 'J+L Bass Drop: sound-wave blast'],
  teknium: ['TEKNIUM — ENERGY BLADE', '', 'J (x4) Blade Finisher knockdown after the string', 'K Kick, L Jump, J+K Back attack, J+L special', 'J+L Data Burst: tech dash strike'],
  turbofit: ['TURBO FIT — GUITAR AXE', '', 'J (x4) Guitar Axe Smash: 3-damage heavy hit', 'K Kick, L Jump, J+K Back attack, J+L special', 'J+L Power Chord: shockwave shot'],
  don_piedro: ['DON PIEDRO — BIG SPOON', '', 'J (x4) Spoon Uppercut: 4th hit launches', 'K Kick (Spoon Charge), L Jump, J+K Back attack, J+L special', 'J+L Soup Tornado: spins and hits all around'],
};
export function createMoveList() {
  let open = false;
  let since = 0;
  return {
    isOpen: () => open,
    toggle(heroId = 'turtle_purple') { open = !open; since = performance.now(); return open; },
    update(dt) { /* reserved */ },
    draw(ctx, W, H, heroId) {
      if (!open) return;
      const key = LINES[heroId] || LINES.turtle_purple;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.fillRect(0, 0, W, H);
      const px = 150, py = 70, pw = W - px * 2, ph = H - py * 2;
      ctx.fillStyle = '#06120f';
      ctx.fillRect(px, py, pw, ph);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(130,240,150,.7)';
      ctx.strokeRect(px + .5, py + .5, pw - 1, ph - 1);
      ctx.fillStyle = '#63f7a0';
      ctx.font = 'bold 18px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('MOVE LIST (F to close)', px + 20, py + 22);
      ctx.font = '13px monospace';
      ctx.fillStyle = '#ffe86b';
      let y = py + 58;
      for (const line of key) { ctx.fillStyle = line.endsWith('—') || line === line.toUpperCase() ? '#ffe86b' : '#d9f4e2'; ctx.fillText(line, px + 20, y); y += 26; }
      ctx.fillStyle = 'rgba(255,255,255,.45)';
      ctx.font = '11px monospace';
      ctx.fillText('Shared inputs: J punch  K kick  L jump  I throw pizza  T taunt', px + 20, H - 80);
      ctx.restore();
    }
  };
}
