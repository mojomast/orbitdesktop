// MR.INDIA rigging QA (t_0309973138084dd1): weapon angle vs forearm on every attack frame, for every hero and every
// weapon-carrying enemy, in both facings, plus grip/hand gaps, wrong-way elbows/knees and frame-to-frame snaps.
// Geometry follows rig.js draw(): each part rotates by its pose angle along its parent chain, the weapon hangs off
// its parent forearm's attach point (the hand). Forearm axis = elbow pivot -> hand attach; weapon axis = PCA of the
// weapon art, pointing from the grip to the far end (two-ended staffs/shields: axis without a tip direction).
// theta = weapon axis - forearm axis in the facing-normalised frame (negative = toward the figure's front).
// A fist grip is natural for theta in [-160, +20]: from straight along the forearm (a thrust) through perpendicular
// forward (neutral grip, -90) to cocked back over the thumb. Past that the blade points back out of the fist.
// usage: node check-weapon-angle.mjs [--list] [--json f]
import assert from 'node:assert/strict'; import { execFileSync } from 'node:child_process'; import fs from 'node:fs';
const G = new URL('../pizza-panic/', import.meta.url).pathname;
globalThis.window = globalThis.window || {};
const R = await import(G + 'rig.js'); const { HERO_RIGS } = await import(G + 'hero-rigs.js'); const { ENEMY_RIGS } = await import(G + 'enemy-rigs.js');
const { POSES } = R; const LIST = process.argv.includes('--list'); const JI = process.argv.indexOf('--json');
const IN_HAND = new Set(['striker', 'turtle_red']), SPIN_ONLY = new Set(['turtle_orange']);
const LIM = { lo: -160, hi: 20, grip: 4, hand: 4, elbow: 15, knee: -15, snap: 150 };
const kinds = [...Object.keys(HERO_RIGS), ...Object.keys(ENEMY_RIGS)].filter(k => (HERO_RIGS[k] || ENEMY_RIGS[k]).weapon);
const dir = k => (k in HERO_RIGS ? G + 'assets/heroes/' + k + '/' : G + 'assets/enemies/' + k + '/');
const jobs = kinds.map(k => { const T = HERO_RIGS[k] || ENEMY_RIGS[k], w = T.weapon, f = T[w.parent];
  return { kind: k, weapon: dir(k) + w.file, wpx: w.px, wpy: w.py, farm: dir(k) + f.file, fax: w.ax, fay: w.ay, fpx: f.px, fpy: f.py }; });
// Image metrics (PIL offline, never getImageData in the game): weapon long axis by PCA of the opaque pixels, grip and
// hand-attach distance to solid art, forearm axis from elbow pivot to hand attach.
const PY = String.raw`# Per-kind weapon / forearm image metrics for check-weapon-angle.mjs (mr_india). stdin: JSON list of jobs.
import sys, json, math
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
out = {}
for j in json.load(sys.stdin):
    a = np.asarray(Image.open(j['weapon']).convert('RGBA'))[..., 3] > 60
    ys, xs = np.nonzero(a); px, py = j['wpx'], j['wpy']
    P = np.stack([xs - px, ys - py], 1).astype(float); C = P.mean(0)
    w, v = np.linalg.eigh(np.cov((P - C).T)); ax = v[:, np.argmax(w)]
    proj = P @ ax; fwd, back = proj.max(), -proj.min()
    if back > fwd: ax = -ax; fwd, back = back, fwd
    two = back > 0.6 * fwd  # gripped near the middle (staff, shield): the axis has no "tip" direction
    dist = ndi.distance_transform_edt(~a)
    gx, gy = int(round(min(max(px, 0), a.shape[1] - 1))), int(round(min(max(py, 0), a.shape[0] - 1)))
    f = np.asarray(Image.open(j['farm']).convert('RGBA'))[..., 3] > 60; fd = ndi.distance_transform_edt(~f)
    fx, fy = int(round(min(max(j['fax'], 0), f.shape[1] - 1))), int(round(min(max(j['fay'], 0), f.shape[0] - 1)))
    out[j['kind']] = {'axis': math.degrees(math.atan2(ax[1], ax[0])), 'twoEnded': bool(two), 'len': float(fwd),
                      'gripGap': float(dist[gy, gx]), 'handGap': float(fd[fy, fx]),
                      'farmAxis': math.degrees(math.atan2(j['fay'] - j['fpy'], j['fax'] - j['fpx']))}
print(json.dumps(out))
`;
const M = JSON.parse(execFileSync('python3', ['-c', PY], { input: JSON.stringify(jobs) }).toString());
const wrap = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a; };
// rig.js chain math, but tracking only rotations: world angle of a part's local x axis.
const worldRot = (T, A, name) => { let r = 0; for (let n = name; n; n = T[n].parent) r += (n === 'weapon' || n === 'staff' || n === 'katana') ? (A.weapon || 0) + (T[n].grip || 0) : (A[n] || 0); return r; };
const ALLK = [...Object.keys(HERO_RIGS), ...Object.keys(ENEMY_RIGS)];
const attackPoses = k => Object.keys(POSES).filter(p => p.startsWith(k + '_') && !ALLK.some(o => o !== k && o.startsWith(k + '_') && p.startsWith(o + '_')) && /_(wind|active|follow)$/.test(p) && !/_(hitReact|grab|grabThrow)_/.test(p));
const off = {}; const tot = { frames: 0, backwards: 0, mirror: 0, grip: 0, elbow: 0, knee: 0, snap: 0 };
const add = (k, what, msg) => { (off[k] ||= { backwards: [], mirror: [], grip: [], elbow: [], knee: [], snap: [] })[what].push(msg); tot[what]++; };
for (const k of kinds) {
  const T = HERO_RIGS[k] || ENEMY_RIGS[k], m = M[k], wparent = T.weapon.parent;
  if (m.gripGap > LIM.grip) add(k, 'grip', `grip pivot ${m.gripGap.toFixed(1)}px off the weapon art`);
  if (m.handGap > LIM.hand) add(k, 'grip', `hand attach ${m.handGap.toFixed(1)}px off the ${wparent} art`);
  const drawn = !IN_HAND.has(k);
  for (const p of attackPoses(k)) {
    const A = POSES[p]; const move = p.slice(k.length + 1).replace(/_(wind|active|follow)$/, '');
    // in-betweens of the wind -> active blend (anim.js mixes angles linearly)
    const W = POSES[`${k}_${move}_wind`], Ac = POSES[`${k}_${move}_active`];
    const frames = [[p, A]]; if (p.endsWith('_active') && W) for (const t of [0.33, 0.66]) { const o = {}; for (const key of Object.keys({ ...W, ...Ac })) o[key] = (W[key] || 0) + ((Ac[key] || 0) - (W[key] || 0)) * t; frames.push([`${p}@${t}`, o]); }
    for (const [fname, F] of frames) {
      if (drawn && !(SPIN_ONLY.has(k) && !/spin/i.test(fname))) {
        tot.frames++;
        const th = {};
        for (const face of [1, -1]) {
          // world angles under flip: a mirrored figure negates x, so an angle a becomes 180 - a; normalise back by facing.
          const farm = worldRot(T, F, wparent) + m.farmAxis, wpn = worldRot(T, F, 'weapon') + m.axis;
          const fa = face > 0 ? farm : 180 - farm, wa = face > 0 ? wpn : 180 - wpn;
          th[face] = face > 0 ? wrap(wa - fa) : -wrap(wa - fa);
        }
        let t1 = th[1]; if (t1 > LIM.hi) t1 -= 360; // express in [-340, 20]
        let bad = t1 < LIM.lo || t1 > LIM.hi;
        if (m.twoEnded) { const alt = wrap(t1 + 180); let t2 = alt > LIM.hi ? alt - 360 : alt; bad = bad && (t2 < LIM.lo || t2 > LIM.hi); }
        if (process.env.THETA && fname.startsWith(process.env.THETA)) console.log('theta', fname, t1.toFixed(0));
        if (JI > 0) ((M[k].thetas ||= []).push([fname, th[1]]));
        if (bad) add(k, 'backwards', `${fname}: weapon ${t1.toFixed(0)} deg off the forearm`);
        if (Math.abs(wrap(th[1] - th[-1])) > 1) add(k, 'mirror', `${fname}: right ${th[1].toFixed(0)} vs left ${th[-1].toFixed(0)}`);
      }
      if (fname.includes('@')) continue;
      for (const [j, lim, sgn] of [['farm', LIM.elbow, 1], ['farm_b', LIM.elbow, 1], ['shin', LIM.knee, -1], ['shin_b', LIM.knee, -1]]) {
        const v = F[j] || 0; if (sgn > 0 ? v > lim : v < lim) add(k, j.startsWith('farm') ? 'elbow' : 'knee', `${fname}: ${j} ${v}`);
      }
    }
    if (p.endsWith('_active') && W) for (const key of Object.keys({ ...W, ...Ac })) { const d = Math.abs((Ac[key] || 0) - (W[key] || 0)); if (d > LIM.snap) add(k, 'snap', `${move}: ${key} ${W[key] || 0} -> ${Ac[key] || 0}`); }
  }
}
// Eased strikes: play every wind -> active transition through anim.js at 60 fps and record the largest single-frame
// joint jump and the overshoot past the strike pose (big swings must arc through, not pop). ANIM=path overrides.
const { createAnim } = await import(process.env.ANIM || G + 'anim.js');
const ease = { worst: 0, at: '', over: 0, overAt: '' };
for (const p of Object.keys(POSES).filter(p => /_active$/.test(p) && POSES[p.replace(/_active$/, '_wind')])) {
  const w = p.replace(/_active$/, '_wind'), a = createAnim(), dt = 1 / 60; let t = 0, prev;
  for (let i = 0; i < 21; i++) prev = a.step('k', w, { phase: 'wind', dur: 0.2 }, dt, t += dt);
  for (let i = 0; i < 12; i++) { const c = a.step('k', p, { phase: 'active', dur: 0.12 }, dt, t += dt);
    for (const k of ['torso', 'head', 'uarm', 'farm', 'uarm_b', 'farm_b', 'thigh', 'shin', 'thigh_b', 'shin_b', 'weapon']) {
      const d = Math.abs((c[k] || 0) - (prev[k] || 0)); if (d > ease.worst) Object.assign(ease, { worst: d, at: `${p} ${k}` });
      const g = POSES[p][k] || 0, s0 = POSES[w][k] || 0; if (Math.abs(g - s0) > 120 && (g - s0) * ((c[k] || 0) - g) > 0 && Math.abs((c[k] || 0) - g) > ease.over) Object.assign(ease, { over: Math.abs((c[k] || 0) - g), overAt: `${p} ${k}` }); }
    prev = { ...c }; }
}
console.log('eased strikes: worst one-frame joint jump', ease.worst.toFixed(1), 'deg (' + ease.at + '), worst big-swing overshoot', ease.over.toFixed(1), 'deg (' + ease.overAt + ')');
// Informational: the same weapon test on the standing / moving / reaction poses (not part of the attack gate).
const STAND = ['idle', 'walk1', 'walk2', 'walk3', 'walk4', 'jump', 'hurt', 'turn', 'punch', 'kick', 'idleA', 'idleB', 'idleC', 'taunt', 'victory', 'flinch', 'stagger', 'knockdownAir', 'down', 'wake', 'grabHold', 'grabbed'];
const standBad = [];
for (const k of kinds) { if (IN_HAND.has(k) || SPIN_ONLY.has(k)) continue; const T = HERO_RIGS[k] || ENEMY_RIGS[k], m = M[k];
  for (const n of STAND) { const F = POSES[`${k}_${n}`] || POSES[n]; if (!F) continue;
    let t1 = wrap(worldRot(T, F, 'weapon') + m.axis - worldRot(T, F, T.weapon.parent) - m.farmAxis); if (t1 > LIM.hi) t1 -= 360;
    let bad = t1 < LIM.lo; if (m.twoEnded) { let t2 = wrap(t1 + 180); if (t2 > LIM.hi) t2 -= 360; bad = bad && t2 < LIM.lo; }
    if (bad) standBad.push(`${k}_${n} ${t1.toFixed(0)}`); } }
console.log('non-attack poses with a backwards weapon (info):', standBad.length, standBad.join(', '));
const per = Object.fromEntries(Object.entries(off).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, b.length]).filter(([, n]) => n))]));
if (JI > 0) fs.writeFileSync(process.argv[JI + 1], JSON.stringify({ tot, per, off, M }, null, 1));
console.log('totals', JSON.stringify(tot)); for (const [k, v] of Object.entries(per)) console.log(' ', k, JSON.stringify(v));
if (LIST) for (const [k, v] of Object.entries(off)) for (const [a, list] of Object.entries(v)) for (const s of list) console.log('   ', k, a, s);
let fails = 0; const t = (n, f) => { try { f(); console.log('PASS', n); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
const heroes = Object.keys(HERO_RIGS);
t('no hero weapon points backwards on any attack frame', () => assert.deepEqual(heroes.filter(h => off[h] && off[h].backwards.length), []));
t('no enemy weapon points backwards on any attack frame', () => assert.deepEqual(kinds.filter(h => !heroes.includes(h) && off[h] && off[h].backwards.length), []));
t('weapons sit in the hand (grip and hand attach on solid art)', () => assert.deepEqual(kinds.filter(h => off[h] && off[h].grip.length), []));
t('left-facing mirrors right-facing exactly', () => assert.equal(tot.mirror, 0));
t('no wrong-way elbows or knees on attack frames', () => assert.equal(tot.elbow + tot.knee, 0));
t('big swings ease through (no joint jumps > 80 deg in one 60 fps frame, overshoot < 8 deg)', () => { assert.ok(ease.worst <= 80, ease.at + ' ' + ease.worst.toFixed(0)); assert.ok(ease.over < 8, ease.overAt + ' ' + ease.over.toFixed(1)); });
t('anim.js tags its angle objects with the pose name and rig.draw reads it (turtle_orange spin-only nunchaku shows in game)', () => {
  const o = createAnim().step('k', 'turtle_orange_nunchakuSpin_active', { phase: 'active', dur: 0.1 }, 1 / 60, 0);
  assert.equal(o.__pose, 'turtle_orange_nunchakuSpin_active'); assert.match(fs.readFileSync(G + 'rig.js', 'utf8'), /pose && pose\.__pose/); });
t('hero idle variants breathe (not a frozen pose)', () => { const a = createAnim(); const v = []; for (let i = 0; i < 40; i++) v.push(a.step('k', 'turtle_blue_idleB', {}, 1 / 30, i / 30).uarm); assert.ok(Math.max(...v) - Math.min(...v) > 2, 'uarm range ' + (Math.max(...v) - Math.min(...v)).toFixed(1)); });
t('MANIFEST grip angles reach the generated tables', () => { for (const k of ['turtle_blue', 'turbofit', 'nous_girl', 'teknium', 'turtle_orange']) assert.ok(HERO_RIGS[k].weapon.grip, k); for (const k of ['brawler', 'acrobat']) assert.ok(ENEMY_RIGS[k].weapon.grip, k); });
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
