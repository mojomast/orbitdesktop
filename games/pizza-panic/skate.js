// Iteration 6: the auto-scrolling skate level (OpenClaw highway), played between
// the street and the rooftop. Every hero rides a board; the camera scrolls at a
// steady speed and carries the player with it. Ollie (jump) over cones and
// barriers (a hit costs health and knocks you down), fight claw drones and
// skater goons that ride in, then beat the Claw Rider mini-boss to finish.
import { W, H, SKATE_LEVEL, damagePlayer, spawnPowerup } from './logic.js';
import { KIND_R, KIND_HP, speakLine, heroBark } from './events.js'; // story-v2: hero lines come from the hero(es) in the run

export const SKATE = { speed: 150, length: 9000, band: [392, 488] };

// Scripted beats by distance travelled (px). Obstacles are placed ahead of the
// camera's right edge; enemies ride in from the right or from behind.
// Iteration 9: six segmented types ride the highway (claw drones, skater goons,
// plus brawlers, strikers, acrobats, throwers and a charger on boards), waves
// rise between breathers, and the named scripted events (`event`) are an
// ambush from both sides, a roadworks hazard run, a drone flyover swarm, a
// claw roadblock (the scroll stops, an arena lock until the convoy is down,
// then GO) and the Claw Rider gate, with barks from goons and heroes.
export const BEATS = [
  { at: 0, say: 'enter', banner: 'CLAW HIGHWAY — L TO OLLIE' },
  { at: 250, obstacles: [['cone', 0.3], ['cone', 0.75]] },
  { at: 550, spawn: [['drone', 'right'], ['drone', 'right']] },
  { at: 900, obstacles: [['barrier', 0.5]] },
  { at: 1150, spawn: [['skater', 'right'], ['skater', 'left']], say: 'surround', event: 'ambushBoth', barks: [{ who: 'enemy', text: 'Nice board! Listing it on Moltbook!' }] },
  { at: 1500, obstacles: [['cone', 0.2], ['cone', 0.5], ['cone', 0.85]], pickup: true, breather: true },
  { at: 1850, spawn: [['drone', 'right'], ['brawler', 'right']], obstacles: [['barrier', 0.5]] },
  { at: 2300, spawn: [['skater', 'left'], ['striker', 'right'], ['drone', 'right']] },
  { at: 2700, obstacles: [['barrier', 0.5], ['cone', 0.3]], pickup: true, breather: true },
  { at: 3050, spawn: [['drone', 'right'], ['acrobat', 'right'], ['skater', 'left']] },
  { at: 3500, obstacles: [['cone', 0.7], ['barrier', 0.5]] },
  // Iteration 7: the highway runs on past the overpass (about 2x longer).
  { at: 3900, say: 'ride', obstacles: [['cone', 0.5]], breather: true, barks: [{ who: 'hero', say: 'onward' }] },
  { at: 4300, say: 'hazard', banner: 'ROADWORKS — OLLIE!', event: 'hazardRun', obstacles: [['cone', 0.15], ['cone', 0.45], ['cone', 0.8]] },
  { at: 4420, obstacles: [['barrier', 0.5]] },
  { at: 4540, obstacles: [['cone', 0.3], ['cone', 0.65]] },
  { at: 4660, obstacles: [['barrier', 0.5]] },
  { at: 4900, spawn: [['skater', 'right'], ['thrower', 'right'], ['drone', 'right']], say: 'ahead' },
  { at: 5150, obstacles: [['barrier', 0.5]], pickup: true, breather: true },
  { at: 5500, spawn: [['drone', 'sky'], ['drone', 'sky'], ['drone', 'sky']], say: 'drones', event: 'flyover', barks: [{ who: 'hero', say: 'hype' }] },
  { at: 5950, obstacles: [['cone', 0.25], ['barrier', 0.5]] },
  { at: 6300, spawn: [['skater', 'left'], ['striker', 'left'], ['skater', 'right']] },
  { at: 6750, obstacles: [['barrier', 0.5], ['cone', 0.7], ['cone', 0.3]], pickup: true, breather: true },
  { at: 7150, spawn: [['charger', 'right'], ['skater', 'left'], ['brawler', 'right'], ['drone', 'right']], say: 'breach', banner: 'CLAW ROADBLOCK', event: 'roadblock', lock: true, barks: [{ who: 'enemy', text: 'End of the road! The claw is the law!' }] },
  { at: 7700, obstacles: [['barrier', 0.5]] },
  { at: 8100, obstacles: [['cone', 0.5]], pickup: true, breather: true },
  { at: 8500, spawn: [['rider', 'right']], say: 'gate', event: 'gate', banner: 'CLAW RIDER', barks: [{ who: 'enemy', text: 'Your pizza. My highway. My skill now.' }] },
];

// Bodies come from the shared tables in events.js (the same r/HP on every level).
const KIND = new Proxy({ rider: { r: 22, hp: 10 } }, { get: (o, k) => o[k] || { r: KIND_R[k] || 14, hp: KIND_HP[k] || 1 } });
export const skatePlan = () => ({
  kinds: [...new Set(BEATS.flatMap(b => (b.spawn || []).map(([w]) => (w === 'rider' ? 'skater' : w))))],
  events: [...new Set(BEATS.flatMap(b => [b.event, b.barks && b.barks.length ? 'bark' : null]).filter(Boolean))],
});

export function laneY(f) { return SKATE.band[0] + 8 + f * (SKATE.band[1] - SKATE.band[0] - 16); }

function startSkate(state) {
  const p = state.player;
  const cam = Math.max(0, p.x - 160);
  state.skate = { cam, start: cam, dist: 0, beat: 0, obstacles: [], done: false, riderSpawned: false, finished: 0, hits: 0, cleared: 0, lock: null };
  state.skateStart = false;
  state.cameraX = cam;
  state.scrollSpeed = SKATE.speed;
  p.y = laneY(0.5);
  p.x = cam + 160;
  state.ninjas = [];
  state.hazards = [];
}

function say(state, text) {
  if (!state.events) return;
  state.events.line = { text, t: 0, dur: Math.max(2.6, text.length * 0.05) };
}

function spawn(state, what, from) {
  const sk = state.skate;
  const k = KIND[what];
  const x = from === 'left' || from === 'sky' ? sk.cam - 40 - (from === 'sky' ? state.ninjas.filter(m => m.flyover).length * 90 : 0) : sk.cam + W + 40;
  const n = {
    kind: what === 'rider' ? 'skater' : what, level: SKATE_LEVEL, x, y: laneY(0.15 + Math.random() * 0.7),
    r: k.r, hp: k.hp, maxHp: k.hp, vx: SKATE.speed, vy: 0, skate: true,
  };
  if (what === 'drone') { n.hover = 70; n.flying = true; }
  // Flyover: drones sweep in high from behind, then peel off into the fight.
  if (from === 'sky') { n.scripted = true; n.flyover = true; n.hover = 150; n.vx = SKATE.speed + 320; n.peelAt = W - 140 - state.ninjas.filter(m => m.flyover).length * 120; n.onScreen = true; }
  if (what === 'rider') { n.elite = true; n.rider = true; n.name = 'CLAW RIDER'; n.scale = 1.4; sk.riderSpawned = true; }
  state.ninjas.push(n);
  return n;
}

export function skateActive(state) { return !!(state && state.skate && state.level === SKATE_LEVEL); }

// Runs once per frame after combatWalk (so the board carries the player).
export function stepSkate(state, dt) {
  if (state.level !== SKATE_LEVEL) { if (state.skate) state.skate = null; return; }
  if (state.skateStart || !state.skate) startSkate(state);
  const sk = state.skate, p = state.player;
  if (sk.done) return;
  // Roadblock arena lock: the scroll stops until the convoy is down, then GO.
  if (sk.lock) {
    sk.lock.t += dt;
    if (!state.ninjas.some(n => !n.dead) || sk.lock.t > 60) {
      sk.lock = null;
      if (state.events) { state.events.go = { t: 0, dur: 2.6 }; state.events.log.push({ type: 'arenaClear', level: SKATE_LEVEL, at: Math.round(sk.dist) }, { type: 'go', level: SKATE_LEVEL }); }
    }
  }
  const v = sk.lock ? 0 : SKATE.speed * dt;
  sk.cam += v; sk.dist += v; state.cameraX = sk.cam; state.scrollSpeed = sk.lock ? 0 : SKATE.speed;
  p.x += v;
  p.x = Math.max(sk.cam + 40, Math.min(sk.cam + W - 90, p.x));
  while (sk.beat < BEATS.length && sk.dist >= BEATS[sk.beat].at) {
    const b = BEATS[sk.beat++];
    const spoke = b.say && state.events ? speakLine(state, b.say, { level: SKATE_LEVEL, boss: b.event === 'gate' ? b.banner : null }) : null;
    if (!b.say && b.line) say(state, b.line);
    for (const [type, f] of b.obstacles || []) {
      sk.obstacles.push(type === 'barrier'
        ? { type, x: sk.cam + W + 60, y: laneY(0.5), w: 48, clear: 24 }
        : { type, x: sk.cam + W + 60 + Math.random() * 80, y: laneY(f), w: 22, clear: 12 });
    }
    const group = (b.spawn || []).map(([what, from]) => spawn(state, what, from));
    const e = state.events;
    if (e) {
      if (b.event) e.log.push({ type: 'skate', event: b.event, at: b.at, kinds: (b.spawn || []).map(([w]) => w) });
      if (b.banner) e.banner = { text: b.banner, t: 0, dur: 2.2 };
      if (e.barks) for (const bk of b.barks || []) {
        if (bk.who === 'hero' && bk.say) { const said = heroBark(state, bk.say, spoke && spoke.hero); e.log.push({ type: 'bark', who: 'hero', level: SKATE_LEVEL, text: said }); continue; }
        const n = bk.who === 'hero' ? null : group.find(m => m.kind !== 'drone') || group[0] || null;
        e.barks.push({ who: bk.who, text: bk.text, n, t: 0, dur: Math.max(2.2, bk.text.length * 0.06, 2.5 + 0.05 * bk.text.length) }); // story-v2: readable
        e.log.push({ type: 'bark', who: bk.who, level: SKATE_LEVEL, text: bk.text });
      }
    }
    if (b.lock) sk.lock = { t: 0 };
    if (b.event && state.eventCue) state.eventCue(b.event === 'flyover' ? 'dropIn' : b.event === 'gate' ? 'miniBoss' : b.event === 'roadblock' ? 'doorBurst' : 'ambush', { x: sk.cam + W / 2, y: SKATE.band[0], level: SKATE_LEVEL, event: b.event });
    if (b.pickup) { spawnPowerup(state, { x: sk.cam + W + 20, y: laneY(Math.random()) }, () => 0.99); const pw = state.powerups[state.powerups.length - 1]; pw.type = 'life'; pw.floorY = pw.y; }
  }
  // Obstacles: a hit costs health and knocks the rider down.
  for (const o of sk.obstacles) {
    if (o.hit || o.passed) continue;
    if (p.x - o.x > o.w / 2 + p.r) { o.passed = true; sk.cleared += 1; continue; }
    const overlapX = Math.abs(p.x - o.x) < o.w / 2 + p.r * 0.5;
    const overlapY = o.type === 'barrier' || Math.abs(p.y - o.y) < 16;
    if (overlapX && overlapY && (p.z || 0) < o.clear && !(state.invuln > 0)) {
      o.hit = true; sk.hits += 1;
      damagePlayer(state, 10, { knockdown: true, x: o.x }); // balance: 12 -> 10 (still a knockdown)
      if (state.fxCue) state.fxCue('hit', { x: o.x, y: o.y, heavy: true, shake: 0.25 });
      if (state.audioCue) state.audioCue('thud');
    }
  }
  sk.obstacles = sk.obstacles.filter(o => o.x > sk.cam - 120);
  for (const n of state.ninjas) if (n.flyover && !n.dead) { n.vy = 0; n.vx = SKATE.speed + 320; if (n.x - sk.cam >= n.peelAt) { n.flyover = false; n.scripted = false; n.hover = 70; n.vx = SKATE.speed; } }
  // Enemies left far behind the camera are gone (they fell off the highway).
  for (const n of state.ninjas) if (n.x < sk.cam - 220 || n.x > sk.cam + W + 400) n.dead = true;
  // Once on screen, riders stay on screen (no kiting off the right edge).
  for (const n of state.ninjas) { if (n.flyover) continue; n.skAge = (n.skAge || 0) + dt; if (n.skAge > 1.5) n.onScreen = true; if (n.onScreen) n.x = Math.max(sk.cam + 30, Math.min(sk.cam + W - 30, n.x)); else if (n.x > sk.cam + 20 && n.x < sk.cam + W - 20) n.onScreen = true; }
  // Powerups ride the road: keep them on screen until collected or passed.
  state.powerups = state.powerups.filter(pw => pw.x > sk.cam - 40);
  // Finish: all beats out, the rider down and the road clear.
  const riderAlive = state.ninjas.some(n => n.rider && !n.dead);
  if (sk.beat >= BEATS.length && sk.riderSpawned && !riderAlive && state.ninjas.every(n => n.dead)) {
    sk.finished += dt;
    if (sk.finished > 0.2 && !sk.done) {
      sk.done = true;
      say(state, 'The Claw Rider is scrap. Next stop: the OpenClaw tower rooftops!');
      state.scrollSpeed = 0;
      state.skateDone = (state.skateDone || 0) + 1;
      // Hand back to the normal wave rule; the rooftop strip starts at x=0.
      state.holdWave = false;
      p.x = 60; state.cameraX = 0; state.skate = null; state.skateExit = true;
    }
  }
}

// --- drawing ----------------------------------------------------------------
const IMG = {};
function load(name, src) { if (typeof Image === 'undefined') return; const im = new Image(); im.onload = () => { IMG[name] = im; }; im.src = src; }
for (const n of ['board', 'board_ollie', 'cone', 'barrier', 'pizzabox']) load(n, 'assets/levels/skate/' + n + '.png');
for (const n of ['torso', 'rotor', 'claw1', 'claw2', 'claw3', 'thruster', 'bolt']) load('drone_' + n, 'assets/enemies/drone/drone_' + n + '.png');
export const skateImages = IMG;

export function drawObstacles(ctx, state) {
  const sk = state.skate;
  if (!sk) return;
  for (const o of sk.obstacles) {
    const im = IMG[o.type];
    const h = o.type === 'barrier' ? 52 : 44;
    ctx.save();
    if (o.hit) { ctx.globalAlpha = 0.6; ctx.translate(o.x, o.y); ctx.rotate(0.6); ctx.translate(-o.x, -o.y); }
    if (o.type === 'barrier') {
      // A barrier spans the road: draw a row of blocks across the band.
      for (let y = SKATE.band[0] + 10; y <= SKATE.band[1]; y += 26) {
        if (im) { const w = h * im.width / im.height; ctx.drawImage(im, o.x - w / 2, y - h + 6, w, h); }
        else { ctx.fillStyle = '#999'; ctx.fillRect(o.x - 24, y - 20, 48, 24); }
      }
    } else if (im) { const w = h * im.width / im.height; ctx.drawImage(im, o.x - w / 2, o.y - h + 6, w, h); }
    else { ctx.fillStyle = '#ff7a1a'; ctx.beginPath(); ctx.moveTo(o.x, o.y - 26); ctx.lineTo(o.x + 10, o.y + 4); ctx.lineTo(o.x - 10, o.y + 4); ctx.fill(); }
    ctx.restore();
  }
}

// Skateboard under a rider's feet; tilts into an ollie while airborne.
export function drawBoard(ctx, x, footY, z, face, scale = 1) {
  const air = z > 2;
  const im = air ? IMG.board_ollie : IMG.board;
  ctx.save();
  ctx.translate(x, footY - z);
  if (face < 0) ctx.scale(-1, 1);
  ctx.scale(scale, scale);
  // Wrap-up fix: board.png / board_ollie.png are top-down art (wheels on top), which read as an
  // upside-down board under the riders. Draw a side-view board instead: the deck top sits at the
  // rider's feet (y 0), trucks and wheels hang below it, kicktails curl up; ollies tip the nose up.
  void im;
  if (air) ctx.rotate(-0.32);
  const L = 23;
  ctx.fillStyle = '#16301b';
  ctx.beginPath(); ctx.moveTo(-L, -3.2); ctx.quadraticCurveTo(-L + 3, 0.4, -L + 7, 0.4); ctx.lineTo(L - 7, 0.4); ctx.quadraticCurveTo(L - 3, 0.4, L, -3.2);
  ctx.lineTo(L + 0.8, -1.6); ctx.quadraticCurveTo(L - 2, 3.4, L - 7, 3.4); ctx.lineTo(-L + 7, 3.4); ctx.quadraticCurveTo(-L + 2, 3.4, -L - 0.8, -1.6); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#2f9a42'; ctx.fillRect(-L + 7, 1.2, 2 * L - 14, 1.6); // deck edge highlight
  ctx.fillStyle = '#0d0d0d'; ctx.fillRect(-L + 6, 0.2, 2 * L - 12, 1.1); // grip tape
  for (const tx of [-L + 9, L - 9]) {
    ctx.fillStyle = '#8b8f96'; ctx.fillRect(tx - 3, 3.4, 6, 2.2); ctx.fillRect(tx - 1, 5, 2, 1.6); // truck
    ctx.fillStyle = '#d9372b'; ctx.beginPath(); ctx.arc(tx, 8.2, 2.9, 0, Math.PI * 2); ctx.fill(); // wheel
    ctx.fillStyle = '#f2d0c8'; ctx.beginPath(); ctx.arc(tx, 8.2, 1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Segmented claw drone: rotor spins (x-squash) and bobs, pincers snap, thruster
// flickers. Parts and pivots are in assets/enemies/MANIFEST.md (## drone).
export function drawDrone(ctx, n, t) {
  const S = 1.0; // parts re-sliced at 2x (iteration 7)
  const bob = Math.sin(t * 4 + (n.__rigId || 0)) * 3;
  const y = n.y - (n.hover || 30) - (n.z || 0) + bob;
  const face = n.face || -1; // iteration 8: the drone art faces RIGHT natively
  const atk = n.atk && n.atk.phase !== 'recover';
  const snap = atk ? 1 : (Math.sin(t * 7 + (n.__rigId || 0)) * 0.5 + 0.5) * 0.3;
  ctx.save();
  // shadow on the road
  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.beginPath(); ctx.ellipse(n.x, n.y + 6, 26, 7, 0, 0, 7); ctx.fill();
  ctx.translate(n.x, y);
  if (face < 0) ctx.scale(-1, 1);
  ctx.scale(S, S);
  if (n.hitFlash > 0) ctx.filter = 'brightness(2)';
  const part = (name, px, py, x, y, rot = 0, sx = 1, alpha = 1) => {
    const im = IMG['drone_' + name]; if (!im) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sx, 1); ctx.globalAlpha = alpha; ctx.drawImage(im, -px, -py); ctx.restore();
  };
  const T = IMG.drone_torso, bw = T ? T.width : 65, bh = T ? T.height : 62;
  // Joints from MANIFEST.md ## drone (torso pivot 31,31; attach points are torso-local).
  const tx = x => x - 31, ty = y => y - 31;
  // thruster on the back, mirrored so its cone points backwards, flickering
  part('thruster', 35, 20, tx(10), ty(31), 0, -1, 0.6 + Math.random() * 0.4);
  // one pincer under the front: open / half / closed frames as it snaps
  const fr = atk ? (n.atk.phase === 'active' ? 'claw3' : 'claw2') : (snap > 0.22 ? 'claw2' : 'claw1');
  const piv = { claw1: [10, 26], claw2: [10, 24], claw3: [10, 20] }[fr];
  part(fr, piv[0], piv[1], tx(46), ty(50), 0.35 + (atk ? 0.25 : snap * 0.3));
  part('torso', 31, 31, 0, 0);
  // rotor spinning: squash horizontally at 20 Hz
  const spin = Math.abs(Math.cos(t * 62 + (n.__rigId || 0)));
  part('rotor', 31, 56, tx(31), ty(8), 0, 0.25 + 0.75 * spin);
  ctx.restore();
}

export function drawShots(ctx, state, cutterImg) {
  for (const s of state.enemyShots || []) {
    ctx.save(); ctx.translate(s.x, s.y);
    if (s.kind === 'drone' && IMG.drone_bolt) { if (s.vx > 0) ctx.scale(-1, 1); ctx.drawImage(IMG.drone_bolt, -IMG.drone_bolt.width / 2, -IMG.drone_bolt.height / 2); }
    else if (cutterImg) { ctx.rotate(s.t * 14); ctx.drawImage(cutterImg, -9, -9, 18, 18); }
    else { ctx.fillStyle = '#ccc'; ctx.beginPath(); ctx.arc(0, 0, s.r, 0, 7); ctx.fill(); }
    ctx.restore();
  }
}
