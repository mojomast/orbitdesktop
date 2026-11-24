// Hero rig QA (heroes world-class pass). Rasterises every hero pose, plus the in-between frames
// anim.js actually plays (wind -> strike -> follow-through -> recover, walk cycle, idle), from the
// same solve() rig.js draws with, and checks what the eye sees:
//  - no joint gap over 1px (background showing through a shoulder/elbow/hip/knee/neck),
//  - the weapon grip sits on the hand art and on the weapon's handle in every frame,
//  - no weapon pointing backwards out of the fist (in every frame, not only attack keyframes),
//  - no part flipped on its own (every part matrix keeps a positive determinant; facing left is
//    one mirror of the whole rig), front limbs over the torso, back limbs under it, the weapon
//    drawn right after the hand that holds it, skirt/coat heroes draw the thighs under the torso,
//  - feet planted: grounded frames put the lowest sole on the ground line.
// usage: node check-rigs.mjs [--list]
import assert from 'node:assert/strict'; import { execFileSync } from 'node:child_process';
const G = new URL('../pizza-panic/', import.meta.url).pathname, DEV = new URL('./', import.meta.url).pathname;
const R = await import(G + 'rig.js'); await import(G + 'don.js'); /* baba_booey: don_piedro registers his chain/poses through rig.js's tables (game.js imports it) */ const { HERO_RIGS } = await import(G + 'hero-rigs.js'); const { createAnim } = await import(G + 'anim.js');
const { POSES, HERO_CHAIN, HERO_KICK, HERO_SPECIALS, solve, apply, orderFor } = R;
const LIST = process.argv.includes('--list');
const heroes = Object.keys(HERO_RIGS);
const GENERIC = ['idle', 'walk1', 'walk2', 'walk3', 'walk4', 'jump', 'turn', 'hurt', 'punch', 'kick', 'punchWind', 'kickWind'];
const frames = [], meta = {};
const isW = n => n === 'weapon' || n === 'staff' || n === 'katana';
const push = (h, id, A, poseName) => {
  const T = HERO_RIGS[h], sol = solve(h, A, { poseName, animated: true });
  const parts = sol.order.map(n => ({ name: n, path: G + 'assets/heroes/' + h + '/' + T[n].file, px: T[n].px, py: T[n].py, m: sol.M[n], s: sol.S[n] }));
  const joints = sol.order.filter(n => T[n].parent && !isW(n) && sol.order.includes(T[n].parent)).map(n => [n, T[n].parent]);
  const grip = sol.order.includes('weapon') ? ['weapon', T.weapon.parent] : null;
  frames.push({ id: h + '|' + id, parts, joints, grip }); meta[h + '|' + id] = { h, sol, poseName, dy: A.dy || 0 };
};
for (const h of heroes) {
  const names = [...new Set([...Object.keys(POSES).filter(p => p.startsWith(h + '_')), ...GENERIC])];
  for (const n of names) push(h, n, { ...POSES[n], __pose: n }, n);
  // what anim.js plays: every move's wind -> active -> rec at 60 fps, the walk cycle and the idle
  const moves = [...new Set([...HERO_CHAIN[h], HERO_KICK[h], ...(HERO_SPECIALS[h] || []).map(s => s.move), 'grab', 'grabThrow', 'dashAttack', 'launcher'])];
  for (const mv of moves) {
    if (!POSES[`${h}_${mv}_wind`]) continue;
    const a = createAnim(); let t = 0, i = 0; const dt = 1 / 60;
    for (const [ph, n, dur] of [['wind', `${h}_${mv}_wind`, 0.24], ['active', `${h}_${mv}_active`, 0.1], ['rec', `${h}_${mv}_recover`, 0.3]]) {
      for (let k = 0; k < Math.round(dur * 60); k++) { const o = a.step('k', n, { phase: ph, dur }, dt, t += dt); if (k % 2 === 0) push(h, `${mv}~${ph}${k}`, { ...o }, n); i++; }
    }
  }
  const a = createAnim(); let t = 0;
  for (let k = 0; k < 32; k++) { const o = a.step('w', `${h}_walk1`in POSES ? `${h}_walk1` : 'walk1', { walkT: k / 60, walkRate: 8 }, 1 / 60, t += 1 / 60); if (k % 2 === 0) push(h, 'walk~' + k, { ...o }, o.__pose); }
  for (let k = 0; k < 60; k += 6) { const o = createAnim().step('i', `${h}_idleA`, {}, 1 / 60, k / 10); push(h, 'idle~' + k, { ...o }, o.__pose); }
}
const out = JSON.parse(execFileSync('python3', [DEV + 'tools/rig_raster.py'], { input: JSON.stringify({ frames }), maxBuffer: 1 << 28 }).toString());
let fails = 0; const t = (n, f) => { try { const d = f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const bad = { gap: [], grip: [], back: [], det: [], order: [], feet: [] }; const worst = { gap: 0 };
const AIR = /jump|knockdownAir|_down|^down|wake|vaultKick|juggle|dodgeRoll|slide|flip|bassDrop/;
for (const [id, r] of Object.entries(out)) {
  const { h, sol, poseName } = meta[id];
  for (const [j, g] of Object.entries(r.gaps)) { if (g > worst.gap) Object.assign(worst, { gap: g, at: id + ' ' + j }); if (g > 1) bad.gap.push(`${id} ${j} ${g}px`); }
  if (r.grip && (r.grip[0] > 1 || r.grip[1] > 1)) bad.grip.push(`${id} grip off weapon ${r.grip[0]}px / hand ${r.grip[1]}px`);
  if (r.theta != null && !r.twoEnded) { let th = r.theta; if (th > 20) th -= 360; if (th < -160 || th > 20) bad.back.push(`${id} theta ${r.theta}`); }
  for (const n of sol.order) { const m = sol.M[n], s = sol.S[n]; if (m[0] * m[3] - m[1] * m[2] <= 0 || s[0] <= 0 || s[1] <= 0) bad.det.push(`${id} ${n}`); }
}
for (const h of heroes) {
  const o = orderFor(h), T = HERO_RIGS[h], at = n => o.indexOf(n);
  const ok = at('uarm_b') < at('torso') && at('farm_b') < at('torso') && at('uarm') > at('torso') && at('farm') > at('uarm') && at('head') > at('torso') && at('shin_b') < at('torso');
  if (!ok) bad.order.push(h + ' limb layers');
  if (T.weapon && at('weapon') !== at(T.weapon.parent) + 1) bad.order.push(`${h} weapon not drawn right after its hand (${T.weapon.parent})`);
  if (R.SKIRTED && R.SKIRTED.has(h) && !(at('thigh') < at('torso'))) bad.order.push(h + ' thigh over the skirt/coat');
}
// feet planted: every grounded frame's lowest sole sits on the ground line (rig px below the root).
if (R.soleY) for (const [id, m] of Object.entries(meta)) { if (R.AIR_POSE.test(m.poseName || '')) continue; const y = R.soleY(m.h, m.sol); if (Math.abs(y - R.FOOT_Y - m.dy) > 0.6) bad.feet.push(`${id} sole ${y.toFixed(1)} vs ${R.FOOT_Y + m.dy}`); }
const show = (k, l) => { if (LIST || l.length) console.log(`  ${k}: ${l.length}` + (l.length ? ' e.g. ' + l.slice(0, LIST ? 400 : 6).join('; ') : '')); };
console.log(`frames rasterised: ${frames.length} across ${heroes.length} heroes; worst joint gap ${worst.gap}px (${worst.at})`);
for (const [k, l] of Object.entries(bad)) show(k, l);
t('no joint gap over 1px on any hero frame (keyframes and eased in-betweens)', () => assert.equal(bad.gap.length, 0, bad.gap.slice(0, 5).join('; ')));
t('weapons are gripped: the grip point sits on the hand and on the weapon handle in every frame', () => assert.equal(bad.grip.length, 0, bad.grip.slice(0, 5).join('; ')));
t('no weapon points backwards out of the fist in any frame (idle, walk, jump, attacks, reactions)', () => assert.equal(bad.back.length, 0, bad.back.slice(0, 5).join('; ')));
t('no part is flipped on its own (positive determinant, positive scale)', () => assert.equal(bad.det.length, 0, bad.det.slice(0, 5).join('; ')));
t('layer order: back limbs under the torso, front limbs over, weapon after its hand, skirt/coat over thighs', () => assert.equal(bad.order.length, 0, bad.order.slice(0, 5).join('; ')));
t('feet planted: grounded frames stand on the ground line', () => { assert.ok(R.soleY, 'rig.js exports soleY'); assert.equal(bad.feet.length, 0, bad.feet.slice(0, 5).join('; ')); });
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
