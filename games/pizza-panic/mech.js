// OpenClaw mech walker (baba_booey): a code-driven part rig for the CLAW WALKER
// mini boss. Seven sliced parts (assets/enemies/mech, built by
// pizza-panic-dev/tools/build_mech.py) are placed with a little forward
// kinematics and rotated per pose: walk cycle (leg swing, knee bend, torso bob),
// claw swipe / grab, stomp, gatling sweep and missile pod. The fight itself
// (attacks, phases, weak point, bar, defeat) lives in boss.js (MINI_BOSSES.mech);
// this file only draws what boss.js puts on the enemy (n.mechAtk, n.weakOpen).
// Not rig.js / enemy-rigs.js: those are Hermes's segmented humanoid rigs.

// Part pivots in source-image pixels (the PNGs are at half the sheet scale).
export const PARTS = {
  torso:  { file: 'torso.png',  w: 146, h: 131, hip: [72, 112], claw: [112, 78], gun: [96, 100], pod: [40, 28], dome: [96, 34] },
  pod:    { file: 'pod.png',    w: 120, h: 69,  pivot: [60, 58], mouth: [112, 34] },
  claw:   { file: 'claw.png',   w: 210, h: 125, pivot: [28, 100], tip: [200, 64] },
  gun:    { file: 'gun.png',    w: 129, h: 73,  pivot: [18, 36], muzzle: [127, 40] },
  thigh:  { file: 'thigh.png',  w: 73,  h: 161, pivot: [36, 22], end: [36, 140] },
  shin_a: { file: 'shin_a.png', w: 118, h: 169, pivot: [58, 26], end: [60, 164] },
  shin_b: { file: 'shin_b.png', w: 118, h: 166, pivot: [58, 26], end: [60, 161] },
};
export const MECH_SCALE = 0.54; // screen px per part px, before n.scale/1.6
export const UPPER = 1.3;      // torso / arms / pod drawn bulkier than the legs
const IMG = {};
if (typeof Image !== 'undefined') for (const [k, p] of Object.entries(PARTS)) { const im = new Image(); im.onload = () => { IMG[k] = im; }; im.src = 'assets/enemies/mech/' + p.file; }
export const mechImages = IMG;
const len = (p) => Math.hypot(p.end[0] - p.pivot[0], p.end[1] - p.pivot[1]);
const ease = k => k * k * (3 - 2 * k);

// Pose angles (radians, local frame facing right). Leg angle 0 hangs straight
// down, + swings forward; arm/pod angle 0 is as painted, - raises it.
export function mechPose(n, t) {
  const A = n.mechAtk, moving = Math.abs(n.vx || 0) + Math.abs(n.vy || 0) > 8;
  const dtw = Math.min(0.05, Math.max(0, t - (n.__walkT ?? t))); n.__walkT = t;
  const ph = (n.__walkPh = (n.__walkPh || 0) + (moving ? dtw * 7 : 0));
  const sw = moving ? 0.3 : 0.04;
  const legs = [ph, ph + Math.PI].map(q => { const th = sw * Math.sin(q); return { th, sh: th - (moving ? 0.38 * Math.max(0, Math.sin(q + 1.3)) : 0.05) }; });
  const pose = { far: legs[1], near: legs[0], bob: moving ? 5 * Math.abs(Math.cos(ph)) : 1.5 * Math.sin(t * 2), claw: 0.05 * Math.sin(t * 1.7), gun: 0, pod: 0,
    recoil: 0, muzzle: 0, podFlash: 0, dip: 0, clawShut: 0 };
  if (!A) return pose;
  const k = A.phase === 'wind' ? 1 - A.t / (A.wind || 1) : A.phase === 'active' ? 1 - A.t / (A.active || 1) : 1 - A.t / (A.rec || 1);
  if (A.name === 'claw') {
    if (A.phase === 'wind') { pose.claw = -0.95 * ease(k); }
    else if (A.phase === 'active') { pose.claw = -0.95 + 1.35 * Math.min(1, k * 2.5); pose.clawShut = A.grab ? 1 : 0; if (A.grab) pose.claw = 0.25; }
    else pose.claw = 0.4 * (1 - ease(k));
  } else if (A.name === 'stomp') {
    if (A.phase === 'wind') { const e = ease(k); pose.near = { th: 0.85 * e, sh: 0.85 * e - 1.25 * e }; pose.dip = -4 * e; }
    else if (A.phase === 'active') { const e = Math.min(1, k * 6); pose.near = { th: 0.85 * (1 - e) + 0.1 * e, sh: (0.85 - 1.25) * (1 - e) }; pose.dip = 8 * (1 - Math.min(1, k * 2)); }
    else pose.dip = 3 * (1 - k);
  } else if (A.name === 'gatling') {
    pose.gun = A.phase === 'wind' ? -0.12 * ease(k) : A.phase === 'active' ? 0.04 * Math.sin(t * 90) : 0;
    if (A.phase === 'active') { pose.recoil = 3 * Math.abs(Math.sin(t * 70)); pose.muzzle = 0.6 + 0.4 * Math.sin(t * 120); }
    if (A.phase === 'wind') pose.muzzle = 0.25 * k;
  } else if (A.name === 'missiles') {
    pose.pod = A.phase === 'wind' ? -0.6 * ease(k) : A.phase === 'active' ? -0.6 : -0.6 * (1 - ease(k));
    if (A.phase === 'active') pose.podFlash = 1 - k;
  }
  return pose;
}

// World-space draw, called by game.js in the y-sorted actor pass (inside
// fx.ninja so the shared hit flash applies). Returns false if art isn't loaded.
export function drawMech(ctx, n, t = 0) {
  if (!IMG.torso || !IMG.thigh || !IMG.shin_a) return false;
  const S = MECH_SCALE * (n.scale || 1.6) / 1.6;
  const pose = mechPose(n, t);
  const face = n.face != null ? (n.face < 0 ? -1 : 1) : -1;
  const groundY = n.y + n.r - (n.z || 0);
  const T = PARTS.torso, Lt = len(PARTS.thigh), Ls = len(PARTS.shin_a);
  // Leg chains relative to the hip; plant the lowest foot on the ground.
  const chain = (L, dx) => { const kx = dx + Math.sin(L.th) * Lt, ky = Math.cos(L.th) * Lt; return { L, dx, kx, ky, fx: kx + Math.sin(L.sh) * Ls, fy: ky + Math.cos(L.sh) * Ls }; };
  const far = chain(pose.far, -34), near = chain(pose.near, 24);
  const hipDrop = Math.max(far.fy, near.fy);
  ctx.save();
  ctx.translate(n.x, groundY);
  ctx.scale(face * S, S);
  const hipY = -hipDrop - pose.bob + pose.dip;
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(0, 4, 120, 22, 0, 0, 7); ctx.fill();
  const part = (key, P, x, y, ang, k = 1, pivot = P.pivot) => {
    const im = IMG[key]; if (!im) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.drawImage(im, -pivot[0] * k, -pivot[1] * k, P.w * k, P.h * k); ctx.restore();
  };
  const leg = (c, shinKey, dark) => {
    if (dark) { ctx.save(); ctx.filter = (ctx.filter && ctx.filter !== 'none' ? ctx.filter + ' ' : '') + 'brightness(0.62)'; }
    part(shinKey, PARTS[shinKey], c.kx, hipY + c.ky, -c.L.sh);
    part('thigh', PARTS.thigh, c.dx, hipY, -c.L.th);
    if (dark) ctx.restore();
  };
  // torso frame: hip mount at (0, hipY)
  const U = UPPER, tx = -T.hip[0] * U, ty = hipY + 14 - T.hip[1] * U;
  const at = p => [tx + p[0] * U, ty + p[1] * U];
  leg(far, 'shin_b', true);
  const [px, py] = at(T.pod); part('pod', PARTS.pod, px, py, pose.pod, U);
  ctx.drawImage(IMG.torso, tx, ty, T.w * U, T.h * U);
  // weak point: the cockpit dome glows (open) after an attack / a stagger
  const [dx, dy] = at(T.dome);
  if (n.weakOpen) {
    const pulse = 0.55 + 0.45 * Math.sin(t * 16);
    const g = ctx.createRadialGradient(dx, dy, 4, dx, dy, 46);
    g.addColorStop(0, `rgba(255,255,170,${0.85 * pulse})`); g.addColorStop(0.5, `rgba(120,255,140,${0.45 * pulse})`); g.addColorStop(1, 'rgba(120,255,140,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(dx, dy, 46, 0, 7); ctx.fill();
    ctx.save(); ctx.scale(face, 1); ctx.fillStyle = '#fff36b'; ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.font = 'bold 30px monospace'; ctx.textAlign = 'center';
    const bx = face * dx, by = dy - 52 - 6 * Math.sin(t * 8); ctx.strokeText('▼', bx, by); ctx.fillText('▼', bx, by); ctx.restore();
  } else { ctx.fillStyle = 'rgba(255,60,60,0.25)'; ctx.beginPath(); ctx.arc(dx, dy, 10 + 2 * Math.sin(t * 5), 0, 7); ctx.fill(); }
  leg(near, 'shin_a', false);
  const [gx, gy] = at(T.gun); part('gun', PARTS.gun, gx - pose.recoil, gy, pose.gun, U);
  const [cx, cy] = at(T.claw); part('claw', PARTS.claw, cx, cy, pose.claw, U);
  // muzzle flash / missile launch flashes
  if (pose.muzzle > 0) {
    const G = PARTS.gun, mx = gx - pose.recoil + Math.cos(pose.gun) * (G.muzzle[0] - G.pivot[0]) * U, my = gy + (Math.sin(pose.gun) * (G.muzzle[0] - G.pivot[0]) + (G.muzzle[1] - G.pivot[1])) * U;
    ctx.fillStyle = `rgba(255,220,90,${pose.muzzle})`; ctx.beginPath(); ctx.arc(mx + 8, my, 10 + 8 * pose.muzzle, 0, 7); ctx.fill();
  }
  if (pose.podFlash > 0) { ctx.fillStyle = `rgba(255,150,60,${pose.podFlash})`; ctx.beginPath(); ctx.arc(px + 40, py - 40, 24 * pose.podFlash + 6, 0, 7); ctx.fill(); }
  // phase 2: damaged, smoking
  if (n.mechPhase > 0) for (let i = 0; i < 3; i++) {
    const q = (t * 0.7 + i / 3) % 1; ctx.fillStyle = `rgba(60,60,70,${0.45 * (1 - q)})`;
    ctx.beginPath(); ctx.arc(tx + 30 + i * 30 + 10 * Math.sin(t + i), ty + 20 - q * 70, 8 + q * 16, 0, 7); ctx.fill();
  }
  ctx.restore();
  return true;
}
