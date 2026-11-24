// bonus.js — Bonus stage: pizza delivery time attack (DOLAN).
// Runs once per run, after the stage-clear card of the 2nd cleared stage
// (screens.js onClearClose -> game.js -> bonus.start). While it runs the main
// world is frozen (game.js gates simStep) and this module owns input + drawing.
// Ride the scooter right along the brownstone street: Left/Right speed, Up/Down
// change lanes (sidewalk + 2 road lanes). Taxis drive the other way, cones sit
// in lanes: a hit costs 2s and spins you. At a door with the bouncing green
// arrow, on the sidewalk lane, J / Space / Enter tosses a pizza: +1000, plus a
// tip for a fast delivery. Road coins +200. Results add the total to s.score.
// Gamepad works through gamepad.js's synthesized arrow/J/Space/Escape events.
import { levelMusic } from './audio.js';

export const BONUS = { time: 45, tiles: 8, deliveries: 6, perDelivery: 1000, tip: 500, tipSecs: 7, coin: 200, hitCost: 2 };
const TILE = 907, LANES = [388, 446, 500];          // wheel line per lane (0 = sidewalk)
const DOORS = [49, 235, 390, 718];                   // door x in an unflipped street tile (shop door skipped)
const PLATES = [[95, 217], [235, 188], [435, 238], [762, 241]]; // the art's own number plates; ours cover them
const SPEED = { cruise: 190, fast: 430, slow: 40 };

export function createBonus({ audio, onDone, rand = Math.random } = {}) {
  const img = {};
  for (const k of ['street', 'scooter', 'taxi', 'boxes', 'arrow', 'coin', 'cone']) { try { const im = new Image(); im.src = 'assets/bonus/' + k + (k === 'street' ? '.jpg' : '.png'); img[k] = im; } catch (_) {} }
  const ready = im => im && im.complete && im.naturalWidth;
  const play = n => { try { audio && audio.play(n); } catch (_) {} };
  const music = (n, f) => { try { audio && audio.music && audio.music(n, f); } catch (_) {} };
  let st = null, doneFor = null;
  const ROAD = TILE * BONUS.tiles;

  function build() {
    const doors = [];
    for (let i = 0; i < BONUS.tiles; i++) DOORS.forEach((dx, k) => {
      const f = v => (i % 2 ? i * TILE + (TILE - v) : i * TILE + v), x = f(dx);
      doors.push({ x, px: f(PLATES[k][0]), py: PLATES[k][1], num: 0, target: false, done: false });
    });
    {
    }
    doors.sort((a, b) => a.x - b.x); doors.forEach((d, i) => { d.num = 42 + i * 2; });
    // Spread the targets: one per stretch, skipping the first door.
    const pool = doors.filter(d => d.x > 500 && d.x < ROAD - 300), per = pool.length / BONUS.deliveries;
    for (let k = 0; k < BONUS.deliveries; k++) pool[Math.min(pool.length - 1, Math.floor(k * per + rand() * per))].target = true;
    const cones = [], coins = [];
    for (let x = 700; x < ROAD - 300; x += 380 + rand() * 260) {
      let lane = Math.floor(rand() * 3);
      if (lane === 0 && doors.some(d => d.target && Math.abs(d.x - x) < 110)) lane = 1 + Math.floor(rand() * 2);
      cones.push({ x, lane });
    }
    for (let x = 520; x < ROAD - 200; x += 220 + rand() * 200) {
      const lane = 1 + Math.floor(rand() * 2);
      if (cones.some(c => c.lane === lane && Math.abs(c.x - x) < 70)) continue;
      coins.push({ x, lane, got: false });
    }
    return { doors, cones, coins };
  }

  function start(s) {
    if (!s || s.hpMode === false || doneFor === s || (st && st.mode)) return false;
    doneFor = s;
    const w = build();
    st = { s, mode: 'ride', t: 0, time: BONUS.time, x: 120, lane: 0, y: LANES[0], speed: 0, spin: 0, inv: 0, cam: 0,
      ...w, taxis: [], tosses: [], pops: [], spawn: 1.2, delivered: 0, tips: 0, coinsGot: 0, hits: 0, lastDeliver: 0, resultT: 0, total: 0, applied: false };
    play('sting'); play('start'); music('skate', 0.6);
    return true;
  }
  const active = () => !!(st && st.mode);

  function laneHit(lane, x, half) { return lane === st.lane && Math.abs(x - st.x) < half; }
  function crash(kind) {
    st.time = Math.max(0, st.time - BONUS.hitCost); st.hits++; st.spin = 0.7; st.inv = 1.3; st.speed = 0;
    st.pops.push({ x: st.x, y: st.y - 90, s: '-2s', c: '#ff5a5a', t: 0 });
    play('impact'); if (kind === 'taxi') play('swingHeavy');
  }
  function deliver() {
    if (st.mode !== 'ride' || st.lane !== 0 || st.spin > 0) return false;
    const d = st.doors.find(o => o.target && !o.done && Math.abs(o.x - st.x) < 60);
    if (!d) return false;
    d.done = true; st.delivered++;
    const fast = st.t - st.lastDeliver <= BONUS.tipSecs; st.lastDeliver = st.t;
    st.tosses.push({ x0: st.x, y0: st.y - 60, x1: d.x, y1: 300, t: 0 });
    st.pops.push({ x: d.x, y: 250, s: '+' + BONUS.perDelivery, c: '#7cff6b', t: 0 });
    if (fast) { st.tips++; st.pops.push({ x: d.x, y: 222, s: 'TIP +' + BONUS.tip, c: '#ffd84a', t: 0, coin: true }); play('chime'); }
    play('pickup');
    return true;
  }
  function finish() {
    if (!st || st.mode !== 'ride') return;
    st.mode = 'results'; st.resultT = 0;
    st.total = st.delivered * BONUS.perDelivery + st.tips * BONUS.tip + st.coinsGot * BONUS.coin;
    if (!st.applied) { st.s.score += st.total; st.s.coins = (st.s.coins || 0) + Math.floor(st.total / 1000); st.applied = true; } // +1 pizza coin per 1000 bonus points
    play('chime'); play('wave');
  }
  function close() {
    if (!st) return;
    const s = st.s; st.mode = null;
    music(levelMusic(s.level), 0.8);
    if (onDone) { try { onDone(s); } catch (_) {} }
  }

  function step(dt, keys = {}) {
    if (!active()) return;
    st.t += dt;
    for (const p of st.pops) p.t += dt; st.pops = st.pops.filter(p => p.t < 1.1);
    if (st.mode === 'results') { st.resultT += dt; if (st.resultT > 8) close(); return; }
    st.time = Math.max(0, st.time - dt);
    const right = keys.ArrowRight || keys.KeyD, left = keys.ArrowLeft || keys.KeyA;
    const want = st.spin > 0 ? 0 : right ? SPEED.fast : left ? SPEED.slow : SPEED.cruise;
    st.speed += (want - st.speed) * Math.min(1, dt * (want < st.speed ? 5 : 2.2));
    st.x = Math.min(ROAD - 60, st.x + st.speed * dt);
    st.y += (LANES[st.lane] - st.y) * Math.min(1, dt * 14);
    st.spin = Math.max(0, st.spin - dt); st.inv = Math.max(0, st.inv - dt);
    st.cam = Math.max(0, Math.min(ROAD - 740, st.x - 200));
    // Oncoming taxis in the road lanes.
    st.spawn -= dt;
    if (st.spawn <= 0) { st.spawn = 1.1 + rand() * 1.3; st.taxis.push({ x: st.cam + 740 + 120, lane: 1 + Math.floor(rand() * 2), v: 170 + rand() * 110 }); }
    for (const c of st.taxis) { c.x -= c.v * dt; if (st.inv <= 0 && Math.abs(st.y - LANES[c.lane]) < 24 && laneHit(c.lane, c.x, 108)) crash('taxi'); }
    st.taxis = st.taxis.filter(c => c.x > st.cam - 200);
    for (const c of st.cones) if (!c.hit && st.inv <= 0 && Math.abs(st.y - LANES[c.lane]) < 20 && laneHit(c.lane, c.x, 52)) { c.hit = true; crash('cone'); }
    for (const c of st.coins) if (!c.got && Math.abs(st.y - LANES[c.lane]) < 22 && laneHit(c.lane, c.x, 44)) { c.got = true; st.coinsGot++; st.pops.push({ x: c.x, y: LANES[c.lane] - 70, s: '+' + BONUS.coin, c: '#ffd84a', t: 0 }); play('pickup'); }
    for (const b of st.tosses) b.t += dt; st.tosses = st.tosses.filter(b => b.t < 0.6);
    if (st.time <= 0 || st.x >= ROAD - 61) finish();
  }

  function handleKey(e) {
    if (!active()) return false;
    const c = e.code;
    if (st.mode === 'results') { if (st.resultT > 1 && !e.repeat && /^(Enter|Space|KeyJ|Escape)$/.test(c)) close(); return true; }
    if (c === 'Escape') { finish(); return true; }
    if (e.repeat) return true;
    if ((c === 'ArrowUp' || c === 'KeyW') && st.lane > 0) st.lane--;
    if ((c === 'ArrowDown' || c === 'KeyS') && st.lane < 2) st.lane++;
    if (c === 'KeyJ' || c === 'Space' || c === 'Enter') { if (!deliver()) play('whiff'); }
    return true;
  }

  // --- drawing ------------------------------------------------------------
  function sprite(ctx, im, x, yBottom, h, flip) {
    if (!ready(im)) return false;
    const w = h * im.naturalWidth / im.naturalHeight;
    ctx.save(); ctx.translate(x, yBottom); if (flip) ctx.scale(-1, 1); ctx.drawImage(im, -w / 2, -h, w, h); ctx.restore();
    return true;
  }
  // Wrap-up fix: the scooter used to drive itself. Seat the player's own hero on it with the
  // shared rig (seated pose: hands on the bars, thighs on the seat, feet on the floorboard).
  const SEATED = { torso: 10, head: -6, uarm: -62, farm: -24, uarm_b: -54, farm_b: -30, thigh: -82, shin: 78, thigh_b: -76, shin_b: 72, weapon: -150 };
  function rider(ctx, x, y) {
    const rig = typeof window !== 'undefined' && window.__ppRig;
    if (!rig || !st || !st.s) return false;
    try {
      const kind = rig.heroKind(st.s);
      const sc = (kind === 'turtle' || kind === 'foot' ? 1.4 : 0.7) * RIDER_K;
      return !!rig.draw(ctx, kind, SEATED, x + RIDER_DX, y + RIDER_DY, false, sc, null, 1 / 60);
    } catch (_) { return false; }
  }
  const RIDER_K = 0.72, RIDER_DX = -12, RIDER_DY = -75;
  function world(ctx, W, H) {
    const cam = st.cam;
    const i0 = Math.floor(cam / TILE), i1 = Math.floor((cam + W) / TILE);
    for (let i = i0; i <= i1; i++) {
      const x = i * TILE - cam;
      if (ready(img.street)) { ctx.save(); if (i % 2) { ctx.translate(x + TILE, 0); ctx.scale(-1, 1); ctx.drawImage(img.street, 0, 0, TILE, H); } else ctx.drawImage(img.street, x, 0, TILE, H); ctx.restore(); }
      else { ctx.fillStyle = '#241a2e'; ctx.fillRect(x, 0, TILE, 390); ctx.fillStyle = '#3a3640'; ctx.fillRect(x, 352, TILE, 40); ctx.fillStyle = '#15131c'; ctx.fillRect(x, 392, TILE, H - 392); }
    }
    ctx.save(); ctx.translate(-cam, 0);
    // Address plates; pending targets get the bouncing arrow and a glow.
    ctx.textAlign = 'center';
    for (const d of st.doors) {
      if (d.x < cam - 60 || d.x > cam + W + 60) continue;
      const tgt = d.target && !d.done;
      ctx.fillStyle = tgt ? 'rgba(20,60,20,0.88)' : 'rgba(10,10,16,0.7)'; ctx.fillRect(d.px - 19, d.py - 11, 38, 21);
      ctx.strokeStyle = tgt ? '#7cff6b' : d.done ? '#ffd84a' : 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.5; ctx.strokeRect(d.px - 19, d.py - 11, 38, 21);
      ctx.fillStyle = tgt ? '#c8ffc0' : d.done ? '#ffd84a' : 'rgba(255,255,255,0.7)'; ctx.font = 'bold 12px monospace'; ctx.fillText(d.done ? '\u2713' + d.num : d.num, d.px, d.py + 4);
      if (tgt) {
        const bob = Math.sin(st.t * 7 + d.x) * 7;
        ctx.save(); ctx.globalAlpha = 0.25 + 0.15 * Math.sin(st.t * 7); ctx.fillStyle = '#7cff6b'; ctx.beginPath(); ctx.ellipse(d.x, 388, 46, 9, 0, 0, 7); ctx.fill(); ctx.restore();
        ctx.save(); ctx.translate(d.x, 120 + bob); ctx.rotate(Math.PI / 2);
        if (ready(img.arrow)) ctx.drawImage(img.arrow, -22, -18, 44, 36); else { ctx.fillStyle = '#7cff6b'; ctx.fillRect(-18, -8, 22, 16); }
        ctx.restore();
      }
    }
    // Actors back to front by lane.
    const items = [];
    for (const c of st.cones) if (c.x > cam - 60 && c.x < cam + W + 60) items.push({ y: LANES[c.lane], f: () => { ctx.globalAlpha = c.hit ? 0.45 : 1; sprite(ctx, img.cone, c.x, LANES[c.lane] + 2, 40) || (ctx.fillStyle = '#ff7a1a', ctx.fillRect(c.x - 12, LANES[c.lane] - 34, 24, 34)); ctx.globalAlpha = 1; } });
    for (const c of st.coins) if (!c.got && c.x > cam - 40 && c.x < cam + W + 40) items.push({ y: LANES[c.lane] - 1, f: () => { const sx = Math.abs(Math.cos(st.t * 4 + c.x)); ctx.save(); ctx.translate(c.x, 0); ctx.scale(Math.max(0.2, sx), 1); sprite(ctx, img.coin, 0, LANES[c.lane] - 14 + Math.sin(st.t * 5 + c.x) * 3, 26) || (ctx.fillStyle = '#ffd84a', ctx.beginPath(), ctx.arc(0, LANES[c.lane] - 28, 12, 0, 7), ctx.fill()); ctx.restore(); } });
    for (const c of st.taxis) items.push({ y: LANES[c.lane] + 1, f: () => { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(c.x, LANES[c.lane], 74, 8, 0, 0, 7); ctx.fill(); sprite(ctx, img.taxi, c.x, LANES[c.lane] + 4, 76) || (ctx.fillStyle = '#ffcf1a', ctx.fillRect(c.x - 80, LANES[c.lane] - 60, 160, 60)); } });
    items.push({ y: st.y + 0.5, f: () => {
      if (st.inv > 0 && Math.floor(st.inv * 12) % 2) return;
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(st.x, st.y, 50, 7, 0, 0, 7); ctx.fill();
      ctx.save(); ctx.translate(st.x, st.y - 34); if (st.spin > 0) ctx.rotate((0.7 - st.spin) * Math.PI * 4); ctx.translate(-st.x, -(st.y - 34));
      sprite(ctx, img.scooter, st.x, st.y + 3, 72) || (ctx.fillStyle = '#e02a2a', ctx.fillRect(st.x - 50, st.y - 60, 100, 60));
      rider(ctx, st.x, st.y);
      ctx.restore();
    } });
    items.sort((a, b) => a.y - b.y).forEach(o => o.f());
    for (const b of st.tosses) { const k = b.t / 0.6, x = b.x0 + (b.x1 - b.x0) * k, y = b.y0 + (b.y1 - b.y0) * k - Math.sin(k * Math.PI) * 90; ctx.save(); ctx.translate(x, y); ctx.rotate(k * 6); sprite(ctx, img.boxes, 0, 14, 28); ctx.restore(); }
    ctx.font = 'bold 16px monospace';
    for (const p of st.pops) { const y = p.y - p.t * 40; ctx.globalAlpha = Math.max(0, 1 - p.t / 1.1); if (p.coin) sprite(ctx, img.coin, p.x - 60, y + 6, 20); ctx.fillStyle = '#000'; ctx.fillText(p.s, p.x + 1, y + 1); ctx.fillStyle = p.c; ctx.fillText(p.s, p.x, y); }
    ctx.globalAlpha = 1; ctx.restore();
  }
  function hud(ctx, W, H) {
    ctx.save();
    const low = st.time < 10;
    ctx.fillStyle = 'rgba(8,10,24,0.82)'; ctx.fillRect(W / 2 - 92, 8, 184, 54); ctx.strokeStyle = low ? '#ff5a5a' : '#ffd84a'; ctx.lineWidth = 2; ctx.strokeRect(W / 2 - 92, 8, 184, 54);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffd84a'; ctx.font = 'bold 11px monospace'; ctx.fillText('BONUS: PIZZA DELIVERY', W / 2, 23);
    ctx.font = 'bold 26px monospace'; ctx.fillStyle = low && Math.floor(st.t * 4) % 2 ? '#ff5a5a' : '#fff'; ctx.fillText(st.time.toFixed(1), W / 2, 53);
    ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(8,10,24,0.82)'; ctx.fillRect(10, 8, 190, 54);
    if (ready(img.boxes)) ctx.drawImage(img.boxes, 18, 16, 33, 20);
    ctx.font = 'bold 15px monospace'; ctx.fillStyle = '#7cff6b'; ctx.fillText(`${st.delivered} / ${BONUS.deliveries}`, 58, 32);
    if (ready(img.coin)) ctx.drawImage(img.coin, 124, 18, 16, 17);
    ctx.fillStyle = '#ffd84a'; ctx.fillText('' + (st.coinsGot + st.tips), 144, 32);
    const run = st.delivered * BONUS.perDelivery + st.tips * BONUS.tip + st.coinsGot * BONUS.coin;
    ctx.font = 'bold 12px monospace'; ctx.fillStyle = '#fff'; ctx.fillText('BONUS ' + run, 18, 54);
    // Progress strip + next address.
    const next = st.doors.find(d => d.target && !d.done && d.x > st.x - 60);
    ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(8,10,24,0.82)'; ctx.fillRect(W - 200, 8, 190, 54);
    ctx.fillStyle = '#c8ffc0'; ctx.font = 'bold 13px monospace'; ctx.fillText(next ? `NEXT: #${next.num}  ${Math.max(0, Math.round((next.x - st.x) / 10))}m` : 'ALL ON BOARD DONE', W - 18, 30);
    const px = W - 190, pw = 170; ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(px, 44, pw, 6);
    for (const d of st.doors) if (d.target) { ctx.fillStyle = d.done ? '#ffd84a' : '#7cff6b'; ctx.fillRect(px + pw * d.x / ROAD - 1, 41, 3, 12); }
    ctx.fillStyle = '#ff4040'; ctx.fillRect(px + pw * st.x / ROAD - 3, 42, 6, 10);
    ctx.textAlign = 'center'; ctx.font = '11px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText('\u2190/\u2192 SPEED   \u2191/\u2193 LANE   J / SPACE / ENTER DELIVER ON THE SIDEWALK   ESC SKIP', W / 2, H - 8);
    ctx.restore();
  }
  function results(ctx, W, H) {
    const k = Math.min(1, st.resultT / 0.35);
    ctx.save(); ctx.fillStyle = `rgba(0,0,0,${0.6 * k})`; ctx.fillRect(0, 0, W, H);
    const w = 420, h = 250, x = (W - w) / 2, y = (H - h) / 2 + (1 - k) * 40;
    ctx.fillStyle = 'rgba(14,12,30,0.95)'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#ffd84a'; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffd84a'; ctx.font = 'bold 26px monospace'; ctx.fillText('DELIVERY BONUS', W / 2, y + 42);
    if (ready(img.scooter)) ctx.drawImage(img.scooter, x + 20, y + 14, 56, 36);
    const rows = [['DELIVERIES', `${st.delivered} / ${BONUS.deliveries}`, st.delivered * BONUS.perDelivery], ['TIPS', 'x' + st.tips, st.tips * BONUS.tip], ['COINS', 'x' + st.coinsGot, st.coinsGot * BONUS.coin], ['CRASHES', 'x' + st.hits, null]];
    ctx.font = 'bold 16px monospace';
    rows.forEach((r, i) => { const ry = y + 86 + i * 30; ctx.textAlign = 'left'; ctx.fillStyle = '#dce8e0'; ctx.fillText(r[0], x + 34, ry); ctx.fillStyle = '#fff'; ctx.fillText(r[1], x + 200, ry); ctx.textAlign = 'right'; ctx.fillStyle = r[2] == null ? '#ff8080' : '#7cff6b'; ctx.fillText(r[2] == null ? '' : '+' + r[2], x + w - 34, ry); });
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(x + 30, y + 196, w - 60, 2);
    ctx.textAlign = 'left'; ctx.fillStyle = '#ffd84a'; ctx.font = 'bold 20px monospace'; ctx.fillText('BONUS TOTAL', x + 34, y + 224);
    ctx.textAlign = 'right'; ctx.fillText('+' + st.total, x + w - 34, y + 224);
    if (st.resultT > 1 && Math.floor(st.resultT * 2) % 2 === 0) { ctx.textAlign = 'center'; ctx.font = '12px monospace'; ctx.fillStyle = '#fff'; ctx.fillText('PRESS ENTER TO CONTINUE', W / 2, y + h + 22); }
    ctx.restore(); ctx.textAlign = 'left';
  }
  function draw(ctx, W, H) {
    if (!active()) return;
    ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    world(ctx, W, H); hud(ctx, W, H);
    if (st.mode === 'results') results(ctx, W, H);
    else if (st.t < 2) { ctx.globalAlpha = Math.min(1, 2 - st.t); ctx.textAlign = 'center'; ctx.font = 'bold 34px monospace'; ctx.lineWidth = 6; ctx.strokeStyle = '#000'; ctx.strokeText('DELIVER THE PIZZAS!', W / 2, 220); ctx.fillStyle = '#ffd84a'; ctx.fillText('DELIVER THE PIZZAS!', W / 2, 220); ctx.globalAlpha = 1; }
    ctx.restore(); ctx.textAlign = 'left';
  }

  const api = { start, active, step, draw, handleKey, finish, close, BONUS, LANES, ROAD, get st() { return st; }, get mode() { return st ? st.mode : null; }, get doneFor() { return doneFor; }, rearm() { doneFor = null; } /* test hook */ };
  if (typeof window !== 'undefined') window.__ppBonus = api;
  return api;
}
