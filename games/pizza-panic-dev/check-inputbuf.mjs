// MR.INDIA input buffer + cancel windows audit (board t_03fb1fa4bff742d5).
// Node part (always): drives combat.js with timed press sequences for all 7 heroes,
// whiffing and against a sandbag (so hit-stop is live), and asserts the move chain:
//  - a press in the last 120 / 100 / 40 ms of recovery chains into the next string step (x4)
//  - a press during wind/active is buffered (0.25 s) and fires on the first recovery frame
//  - a press more than BUFFER before the move can be cancelled is dropped (by design)
//  - jump (L) cancels recovery; J+L special and J+K back attack chords cancel recovery
//    and are not lost when pressed during an active / hit-stop frame
//  - nothing pressed during hit-stop is eaten
// Browser part (opt-in with --browser, so the suite loop stays fast; PP_HERO=<id> runs
// one hero): the same chains through the real page on keyboard
// (KeyboardEvent), on a simulated standard gamepad (navigator.getGamepads stub polled
// by gamepad.js), and mixed keyboard + pad.
import assert from 'node:assert/strict';
const G = new URL('../pizza-panic/', import.meta.url).href;
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const L = await import(G + 'logic.js');
const C = await import(G + 'combat.js');
const HM = await import(G + 'hero-moves.js');
const { HEROES } = await import(G + 'heroes.js');
let fails = 0, passes = 0;
const t = (name, fn) => { try { const d = fn(); passes++; console.log('PASS', name + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', name, '-', e.message); } };
const DT = 1 / 120, BUFFER = 0.25;
const fresh = (hero, bag) => {
  const s = L.createState(); s.hpMode = true; s.level = 1; s.wave = 2; s.selectedHero = hero; s.hero = hero; C.createCombat(s);
  s.player.x = 400; s.player.y = 420; s.hp = 999;
  if (bag) s.ninjas.push({ kind: 'brawler', level: 1, x: s.player.x + 34, y: s.player.y, r: 15, hp: 1e6, maxHp: 1e6, vx: 0, vy: 0, sandbag: true });
  return s;
};
// Keep the sandbag in front, upright and alive so every swing connects.
const pinBag = s => { for (const n of s.ninjas) if (n.sandbag) { n.x = s.player.x + 34 * s.combat.facing; n.y = s.player.y; n.vx = n.vy = 0; n.z = 0; n.hp = 1e6; n.dead = false; n.down = 0; n.knockdown = 0; n.launchV = 0; } };
const step = s => { pinBag(s); C.combatStep(s, DT); };
const label = (s, m) => HM.heroMove(s, m).label;
const stringLabels = s => C.MOVES.punch.map((m, i) => label(s, { ...m, chainKey: 'punch' + (i + 1) }));
const tail = (arr, n) => arr.slice(-n).join(' > ');
// Run until cond (max secs).
const until = (s, cond, max = 2) => { for (let i = 0; i < max / DT; i++) { if (cond(s.combat)) return true; step(s); } return false; };
const settle = s => { for (let i = 0; i < 1.5 / DT; i++) step(s); };
const press = (s, ...b) => b.map(x => C.combatPress(s, x));

const heroes = HEROES.map(h => h.id);
for (const hero of heroes) for (const bag of [false, true]) {
  const tag = `${hero} ${bag ? 'vs sandbag' : 'whiff'}`;
  // 1. x4 string with presses N ms before recovery ends.
  for (const lead of [0.12, 0.1, 0.04]) t(`${tag}: J x4 string, presses ${Math.round(lead * 1000)} ms before recovery ends`, () => {
    const s = fresh(hero, bag), c = s.combat;
    press(s, 'punch');
    for (let k = 1; k < 4; k++) {
      assert.ok(until(s, c => c.phase === 'rec' && c.timer <= lead + 1e-9 && c.hitStop <= 0), `no recovery after hit ${k}`);
      press(s, 'punch');
    }
    settle(s);
    assert.equal(tail(c.log, 4), stringLabels(s).join(' > '));
    assert.equal(c.log.length, 4, 'extra moves: ' + c.log.join(','));
  });
  // 2. Press during wind/active is buffered and comes out on the first recovery frame.
  t(`${tag}: J pressed in active is buffered into the next hit`, () => {
    const s = fresh(hero, bag), c = s.combat;
    press(s, 'punch'); until(s, c => c.phase === 'active'); step(s);
    assert.equal(press(s, 'punch')[0], 'buffered');
    assert.ok(until(s, c => c.log.length === 2, 0.6), 'buffered press never fired: ' + c.log.join(','));
    assert.equal(c.log[1], stringLabels(s)[1]);
  });
  // 3. Early press: more than BUFFER before the move can be cancelled -> dropped (design).
  t(`${tag}: a press > ${BUFFER}s before recovery is dropped (buffer design)`, () => {
    const s = fresh(hero, bag), c = s.combat;
    press(s, 'punch'); until(s, c => c.phase === 'rec'); press(s, 'punch'); until(s, c => c.phase === 'rec'); press(s, 'punch'); until(s, c => c.phase === 'rec');
    press(s, 'punch'); // the finisher
    const fin = c.attack; if (fin.wind + fin.active <= BUFFER + 2 * DT) return '(skip: finisher wind+active ' + (fin.wind + fin.active).toFixed(2) + 's <= buffer)';
    step(s); press(s, 'punch'); // ~wind start: too early (J again, so no chord)
    settle(s);
    assert.equal(c.log.length, 4, 'early press was not dropped: ' + c.log.join(','));
    return `(finisher wind+active ${(fin.wind + fin.active).toFixed(2)}s)`;
  });
  // 4. Jump cancels recovery; a jump pressed in active comes out at recovery start.
  t(`${tag}: L cancels recovery (rec press and active-buffered press)`, () => {
    let s = fresh(hero, bag), c = s.combat;
    press(s, 'punch'); until(s, c => c.phase === 'rec' && c.hitStop <= 0); const left = c.timer; press(s, 'jump');
    assert.ok(c.airborne && !c.attack, 'jump did not cancel recovery (left ' + left.toFixed(3) + ')');
    s = fresh(hero, bag); c = s.combat;
    press(s, 'punch'); until(s, c => c.phase === 'active' && c.now - c.press.punch > 0.1 + 1e-9); assert.equal(c.phase, 'active'); press(s, 'jump'); // outside the 0.1 s J+L chord
    assert.ok(until(s, c => c.airborne, 0.6), 'buffered jump never fired');
    assert.ok(c.attack == null || c.attack.name === 'jumpKick', 'attack not cancelled');
  });
  // 5. Chords cancel recovery, and are not lost when pressed during an active frame.
  for (const [chord, b2, mv] of [['J+L special', 'jump', 'healthSpecial'], ['J+K back attack', 'kick', 'backAttack']]) {
    t(`${tag}: ${chord} in recovery cancels into it`, () => {
      const s = fresh(hero, bag), c = s.combat;
      press(s, 'punch'); until(s, c => c.phase === 'rec' && c.hitStop <= 0); press(s, 'punch', b2); settle(s);
      assert.ok(c.log.includes(label(s, C.MOVES[mv])), c.log.join(','));
    });
    t(`${tag}: ${chord} pressed in an active frame is buffered as the chord`, () => {
      const s = fresh(hero, bag), c = s.combat;
      press(s, 'punch'); until(s, c => c.phase === 'active'); step(s); press(s, 'punch', b2); settle(s);
      assert.ok(c.log.includes(label(s, C.MOVES[mv])), 'chord lost, got ' + c.log.join(','));
    });
  }
  if (!bag) continue;
  // 6. Hit-stop: nothing pressed during it is eaten.
  for (const [what, b, expect] of [['J', ['punch'], s => stringLabels(s)[1]], ['L', ['jump'], 'air'], ['J+L', ['punch', 'jump'], s => label(s, C.MOVES.healthSpecial)]]) t(`${tag}: ${what} pressed during hit-stop comes out after it`, () => {
    const s = fresh(hero, true), c = s.combat;
    press(s, 'punch'); assert.ok(until(s, c => c.hitStop > 0, 0.5), 'no hit-stop on the sandbag');
    step(s); assert.ok(c.hitStop > 0, 'hit-stop too short to test');
    if (what === 'L') { until(s, c => c.now - c.press.punch > 0.1 + 1e-9); assert.ok(c.hitStop > 0, 'hit-stop ended inside the chord window'); } // L alone, not J+L
    press(s, ...b);
    assert.ok(until(s, c => c.hitStop <= 0, 0.5));
    if (expect === 'air') assert.ok(until(s, c => c.airborne, 0.6), 'jump eaten');
    else { settle(s); assert.ok(c.log.includes(expect(s)), 'eaten: ' + c.log.join(',')); }
  });
}
// Teknium's finisher carries cancel:true; recovery cancels already apply to every move,
// so the flag is informational. Keep the data shape honest.
t('hero-moves: cancel flag is boolean where present', () => { for (const [h, tb] of Object.entries(HM.HERO_MOVES_COMBAT || {})) for (const m of Object.values(tb)) if ('cancel' in m) assert.equal(typeof m.cancel, 'boolean', h); });

if (process.argv.includes('--browser')) await (await import('./inputbuf-browser.mjs')).run(t);
console.log(`${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
