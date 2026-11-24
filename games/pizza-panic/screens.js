// screens.js — stage clear results, game over with a CONTINUE countdown, and the
// ending + credits roll. game.js only calls a few hooks (track/stageClear/
// gameOver/ending/handleKey/update/draw); everything else lives here.
import { HEROES } from './heroes.js';
import { levelMusic } from './audio.js';

export const STAGE_NAMES = { 0: 'SEWER', 1: 'STREET', 3: 'SKATE RUN', 2: 'ROOFTOP' };
const STAGE_NUM = { 0: 1, 1: 2, 3: 3, 2: 4 };
const CONTINUE_SECS = 10;
// dolan (juice): stage clear count-up timeline. Everything lands inside the
// card's existing 1.2s minimum, so one press after 1.2s still closes it.
const CLEAR_T = { rows: 0.22, lines: [0.42, 0.6, 0.78], line: 0.16, total: 0.94, totalDur: 0.16, stamp: 1.12, done: 1.2 };
const CRACK_SECS = 0.7;
// Rank from the stage bonus + no-damage: S = no damage and a fast clear.
export function stageRank(d) {
  if (!d) return 'C';
  if (d.hits === 0 && d.secs <= 90) return 'S';
  if (d.total >= 6500 || d.hits === 0) return 'A';
  if (d.total >= 3000) return 'B';
  return 'C';
}
const easeOutBack = (k, s = 1.7) => { k = Math.min(1, Math.max(0, k)) - 1; return 1 + k * k * ((s + 1) * k + s); };
// Same rule MR.INDIA's arcade glitch uses: pause-menu screen shake off (fx.shakeEnabled) or reduced motion.
const reducedFlash = () => { try { const fx = typeof window !== 'undefined' && window.__ppFx; return !!((fx && fx.shakeEnabled === false) || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)); } catch (_) { return false; } };
// Local high scores (top 10 + 3-letter initials). Orbit serves apps from a
// sandboxed origin where localStorage can throw; then the table lives in memory.
export const SCORE_KEY = 'pizzaPanicScores', MAX_SCORES = 10;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ.!?';
const memScores = { v: null };
export function loadScores() {
  let raw = null; try { raw = localStorage.getItem(SCORE_KEY); } catch (_) { raw = memScores.v; }
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.filter(e => e && Number.isFinite(e.score)).slice(0, MAX_SCORES) : []; } catch (_) { return []; }
}
export function saveScores(list) {
  const v = JSON.stringify(list.slice(0, MAX_SCORES)); memScores.v = v;
  try { localStorage.setItem(SCORE_KEY, v); } catch (_) {}
}
export function qualifies(score, list = loadScores()) { return score > 0 && (list.length < MAX_SCORES || score > list[list.length - 1].score); }
export function insertScore(entry, list = loadScores()) {
  const out = list.concat([entry]).sort((a, b) => b.score - a.score).slice(0, MAX_SCORES);
  saveScores(out); return out.indexOf(entry);
}
const CREDITS = [
  ['title', 'AGENT ARMEGEDDON: CLAWPOCALYPSE NOW'], ['gap'],
  ['head', 'PRODUCED BY'], ['name', 'Kyle'], ['gap'],
  ['head', 'BUILT BY THE INSANE ASSYLYM'],
  ['role', 'MR.INDIA', 'combat, levels, story, character select'],
  ['role', 'HERMES', 'rigs, animation, audio, effects'],
  ['role', 'PIPI', 'cinematics, backgrounds, pause menu'],
  ['role', 'BABA BOOEY', 'OpenClaw boss fights'],
  ['role', 'CHEESE', 'gamepad support and QA'],
  ['role', 'DOLAN', 'results, continue and ending screens'],
  ['gap'], ['head', 'MUSIC & SOUND  (FREE CC0 ASSETS)'],
  ['role', 'JUHANI JUNKALA', 'chiptune score, OpenGameArt.org'],
  ['role', 'KENNEY', 'sound effects, jingles and announcer, kenney.nl'],
  ['role', 'ARTISTICDUDE  ·  RUBBERDUCK', 'swishes, creature and item SFX, OpenGameArt.org'],
  ['gap'], ['head', 'STARRING'], ['heroes'], ['gap'],
  ['head', 'AND INTRODUCING'], ['name', 'SHREDCLAW and the OpenClaw overlords'], ['gap'], ['gap'],
  ['title', 'THANK YOU FOR PLAYING'],
];

export function createScreens({ audio, onQuit, onClearClose } = {}) {
  const st = { mode: null, t: 0, data: null, run: null, stage: null, tracked: [] };
  let hiBg = null; try { hiBg = new Image(); hiBg.src = 'assets/ui/hiscore_bg.jpg'; } catch (_) {}
  const ui = {}; // dolan: juice art
  for (const k of ['rank_s', 'rank_a', 'rank_b', 'rank_c', 'stage_clear', 'continue']) { try { const im = new Image(); im.src = 'assets/ui/' + k + '.png'; ui[k] = im; } catch (_) {} }
  for (const k of ['ui_slice', 'pickups/pizza']) { try { const im = new Image(); im.src = 'assets/' + k + '.png'; ui[k] = im; } catch (_) {} }
  const ready = im => im && im.complete && im.naturalWidth;
  const fxs = { parts: [], flash: 0, shake: 0, tickAt: -1, drain: 0 }; // particles, white flash, card shake, tick throttle, continue drain
  const play = n => { try { audio && audio.play(n); } catch (_) {} };
  const portraits = {};
  for (const h of HEROES) { try { const im = new Image(); im.src = 'assets/heroes/portraits/' + h.id + '.png'; portraits[h.id] = im; } catch (_) {} }
  // baba_booey (t_bbe9e23bf6af47c5): full-body victory pose cut-outs + the stage clear splash.
  const victory = {}, CROPPED = new Set(['turtle_orange']); // art cropped above the feet
  for (const h of HEROES) { try { const im = new Image(); im.src = 'assets/ui/victory/' + h.id + '.png'; victory[h.id] = im; } catch (_) {} }
  try { ui.splash = new Image(); ui.splash.src = 'assets/ui/stage_clear_splash.jpg'; } catch (_) {}
  const goArt = {}; for (const k of ['continue', 'gameover']) { try { const im = new Image(); im.src = 'assets/ui/gameover/' + k + '.jpg'; goArt[k] = im; } catch (_) {} } // baba_booey: continue + game-over illustrations (t_a4826c482cfc4c4a)
  // P1's hero, plus Cheese's co-op P2 when one is in play (window.__ppCoop.p2 is P2's state view).
  const winners = s => { const out = s && s.selectedHero ? [s.selectedHero] : []; try { const c = typeof window !== 'undefined' && window.__ppCoop, id = c && c.p2 && c.p2.selectedHero; if (id && id !== out[0]) out.push(id); } catch (_) {} return out; };
  // Draws one victory cut-out fitted to maxW x maxH, feet at (cx, bottom); k = 0..1 slide-in, from = -1 left / 1 right.
  function drawWinner(ctx, id, cx, bottom, maxW, maxH, k, from = -1, W = 740) {
    const im = victory[id]; if (!ready(im) || k <= 0) return false;
    if (CROPPED.has(id)) bottom = ctx.canvas.height; // art cut off at the knees: stand on the screen edge
    const sc = Math.min(maxW / im.naturalWidth, maxH / im.naturalHeight), w = im.naturalWidth * sc, h = im.naturalHeight * sc;
    const x = cx + (1 - easeOutBack(k, 1.4)) * from * (W / 2 + w);
    ctx.save(); ctx.globalAlpha *= Math.min(1, k * 3);
    if (from > 0) { ctx.translate(x, 0); ctx.scale(-1, 1); ctx.drawImage(im, -w / 2, bottom - h, w, h); } // P2 faces P1
    else ctx.drawImage(im, x - w / 2, bottom - h, w, h);
    ctx.restore(); return true;
  }

  function newStage(s) { st.stage = { level: s.level, t: 0, kos: 0, combo: 0, hits: s.hpHit || 0, coins0: s.coins || 0 }; }
  // Call when a fresh run starts (character select confirm or restart).
  function reset(s) { st.mode = null; st.t = 0; st.run = { t: 0, kos: 0, combo: 0, continues: 0, stages: 0 }; newStage(s); }
  // Per sim step: snapshot before the world steps, count knockouts after.
  const counted = new WeakSet();
  function before(s) { st.tracked = s.ninjas.slice(); }
  function after(s, dt) {
    if (!st.run) reset(s);
    let ko = 0;
    for (const n of st.tracked.concat(s.ninjas)) if (n.hp <= 0 && !counted.has(n)) { counted.add(n); ko++; }
    st.tracked = [];
    st.stage.kos += ko; st.run.kos += ko;
    if (ko) play('ko'); // enemy knocked out
    st.stage.t += dt; st.run.t += dt;
    st.stage.combo = Math.max(st.stage.combo, s.combo || 0); st.run.combo = Math.max(st.run.combo, s.combo || 0);
  }

  function stageClear(s, level) {
    const g = st.stage || { level, t: 0, kos: 0, combo: 0, hits: 0 };
    const hits = Math.max(0, (s.hpHit || 0) - g.hits), secs = Math.round(g.t);
    const timeBonus = Math.max(0, 240 - secs) * 20;
    const perfect = hits === 0 ? 5000 : 0;
    const comboBonus = g.combo * 100;
    const total = timeBonus + perfect + comboBonus;
    s.score += total;
    s.coins = (s.coins || 0) + 5; const coinsGot = Math.max(0, s.coins - (g.coins0 || 0)); // dolan: +5 pizza coins per stage clear
    st.run.stages += 1;
    st.data = { level, name: STAGE_NAMES[level] || 'STAGE', num: STAGE_NUM[level] || st.run.stages, secs, kos: g.kos, combo: g.combo, hits, timeBonus, perfect, comboBonus, total };
    st.data.coins = coinsGot; st.data.heroes = winners(s); st.data.rank = stageRank(st.data); st.data.stamped = false; fxs.parts = []; fxs.shake = 0; fxs.tickAt = -1;
    st.mode = 'clear'; st.t = 0;
    newStage(s);
    play('clear'); // stage-clear jingle + announcer
  }
  // dolan: the stage-clear card closes here (key or timeout); onClearClose(stagesCleared, data) lets game.js chain the bonus stage.
  function closeClear() { st.mode = null; if (onClearClose) { try { onClearClose(st.run ? st.run.stages : 0, st.data); } catch (_) {} } }
  function gameOver(s) { st.mode = 'continue'; st.t = 0; fxs.drain = 0; st.data = { count: CONTINUE_SECS, s, crack: null }; play('continue'); try { audio && audio.music(null, 1); } catch (_) {} }
  function ending(s) { st.mode = 'credits'; st.t = 0; st.data = { s, score: s.score, hero: s.selectedHero, heroes: winners(s) }; try { audio && audio.music('ending', 0.8); } catch (_) {} }

  function doContinue() {
    const s = st.data.s;
    s.over = false; s.lives = 3; s.hp = s.maxHp || 100; s.invuln = 3; s.playerDown = 0;
    s.continues = (s.continues || 0) + 1; st.run.continues += 1;
    // Knock everyone back so the hero isn't stun-locked on the spot.
    for (const n of s.ninjas) { const d = Math.sign(n.x - s.player.x) || 1; n.vx = d * 260; if (n.atk) n.atk = null; }
    st.mode = null; play('start'); play('life');
    fxs.flash = reducedFlash() ? 0.3 : 1; fxs.drain = 0; // dolan: continue flash
    try { audio && audio.music(levelMusic(s.level), 0.8); } catch (_) {}
  }
  function finish() { st.mode = null; st.data = null; st.run = null; if (onQuit) onQuit(); }
  // End of a run (final GAME OVER or after the credits): initials if the score
  // makes the table, otherwise straight to the table, then the title.
  function afterRun(cleared) {
    const s = st.data && st.data.s; if (!s) return finish();
    const heroDef = HEROES.find(h => h.id === s.selectedHero);
    const entry = { n: 'AAA', score: s.score | 0, hero: heroDef ? heroDef.name : '', stage: cleared ? 'ALL CLEAR' : (STAGE_NAMES[s.level] || ''), at: Date.now() };
    st.entry = { e: entry, slot: 0, letters: [0, 0, 0], rank: -1 };
    if (qualifies(entry.score)) { st.mode = 'initials'; st.t = 0; play('life'); }
    else { st.mode = 'scores'; st.t = 0; }
  }
  function commitInitials() {
    const en = st.entry; en.e.n = en.letters.map(i => LETTERS[i]).join('');
    en.rank = insertScore(en.e); st.mode = 'scores'; st.t = 0; play('chime');
  }
  function initialsKey(e) {
    const en = st.entry, c = e.code;
    if (/^Key[A-Z]$/.test(c)) { en.letters[en.slot] = LETTERS.indexOf(c.slice(3)); play('menuMove'); if (en.slot < 2) en.slot++; else commitInitials(); return; }
    if (c === 'ArrowUp' || c === 'ArrowDown') { const d = c === 'ArrowUp' ? 1 : -1; en.letters[en.slot] = (en.letters[en.slot] + d + LETTERS.length) % LETTERS.length; play('menuMove'); return; }
    if (c === 'ArrowLeft' || c === 'Backspace') { en.slot = Math.max(0, en.slot - 1); return; }
    if (c === 'ArrowRight') { en.slot = Math.min(2, en.slot + 1); return; }
    if (c === 'Enter' || c === 'Space') { if (en.slot < 2) { en.slot++; play('menuConfirm'); } else commitInitials(); return; }
    if (c === 'Escape') commitInitials();
  }

  function handleKey(e) {
    if (!st.mode) return false;
    if (e.repeat || /^(Shift|Control|Alt|Meta)/.test(e.code)) return true;
    const confirm = /^(Enter|Space|KeyJ)$/.test(e.code);
    if (st.mode === 'clear') { if (st.t > CLEAR_T.done) { closeClear(); play('start'); } else st.t = CLEAR_T.done; return true; } // first press skips the count-up to its end state
    if (st.mode === 'continue') {
      if (st.data && st.data.crack != null) return true; // too late: the banner is breaking
      if (confirm) { doContinue(); return true; }
      if (e.code === 'Escape') { st.mode = 'final'; st.t = 0; return true; }
      // Any other button ticks the countdown faster, arcade style.
      st.t = Math.floor(st.t) + 1; play('tick'); return true;
    }
    if (st.mode === 'final') { if (st.t > 1) afterRun(false); return true; }
    if (st.mode === 'initials') { initialsKey(e); return true; }
    if (st.mode === 'scores') { if (st.t > 1) finish(); return true; }
    if (st.mode === 'credits') {
      if (st.rollDone) afterRun(true); else if (e.code === 'Escape') st.t = Math.max(st.t, 6) + 1000; else st.t = Math.max(st.t, 6) + 3;
      return true;
    }
    return true;
  }

  function burst(W = 740) {
    const n = reducedFlash() ? 26 : 60, cols = ['#ffe14d', '#ff5252', '#7cff6b', '#38c9ff', '#ff8cf0', '#fff'];
    for (let i = 0; i < n; i++) {
      const slice = i % 6 === 0, side = i % 2 ? 1 : -1;
      fxs.parts.push({ x: W / 2 + side * (40 + Math.random() * 120), y: 90 + Math.random() * 30, vx: side * (60 + Math.random() * 260), vy: -260 - Math.random() * 240,
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14, c: cols[i % cols.length], slice, size: slice ? 22 + Math.random() * 8 : 5 + Math.random() * 5, t: 0, life: 1.8 + Math.random() * 0.9 });
    }
  }
  function stepJuice(dt) {
    fxs.flash = Math.max(0, fxs.flash - dt * 3); fxs.shake = Math.max(0, fxs.shake - dt * 2.5);
    for (const q of fxs.parts) { q.t += dt; q.vy += 520 * dt; q.vx *= 1 - dt * 0.8; q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vr * dt; }
    fxs.parts = fxs.parts.filter(q => q.t < q.life);
  }
  function update(dt) {
    stepJuice(dt);
    if (!st.mode) return;
    const prevT = st.t; st.t += dt;
    if (st.mode === 'clear') {
      const d = st.data, T = CLEAR_T;
      try { const fx = window.__ppFx; if (fx && fx.pops && fx.pops.length) fx.pops = []; } catch (_) {} // the frozen world's score pop (+bonus) would hang under the card
      if (prevT < 0.05 && st.t >= 0.05) { fxs.shake = reducedFlash() ? 0.08 : 0.4; play('impact'); } // banner slam
      const counting = T.lines.some(a => st.t >= a && st.t < a + T.line) || (st.t >= T.total && st.t < T.total + T.totalDur);
      if (counting && st.t - fxs.tickAt >= 0.055) { fxs.tickAt = st.t; play('tick'); }
      if (d && !d.stamped && st.t >= T.stamp) { d.stamped = true; play('smash'); play(d.rank === 'S' ? 'sting' : 'chime'); fxs.flash = reducedFlash() ? 0.15 : 0.55; fxs.shake = reducedFlash() ? 0.05 : 0.3; burst(); }
    }
    if (st.mode === 'clear' && st.t > 7) { closeClear(); }
    if (st.mode === 'initials' && st.t > 30) commitInitials();
    if (st.mode === 'scores' && st.t > 14) finish();
    if (st.mode === 'continue') {
      const d = st.data;
      if (d.crack != null) { d.crack += dt; if (d.crack >= CRACK_SECS) { st.mode = 'final'; st.t = 0; play('over'); } return; }
      fxs.drain = Math.min(1, st.t / CONTINUE_SECS);
      const lastThree = CONTINUE_SECS - st.t <= 3, beat = lastThree ? 0.5 : 1; // heartbeat speeds up for the last 3
      if (Math.floor(st.t) !== Math.floor(prevT) && st.t < CONTINUE_SECS) { try { audio && audio.play('count', { n: CONTINUE_SECS - Math.floor(st.t) }); } catch (_) {} } // announcer counts down
      if (Math.floor(st.t / beat) !== Math.floor(prevT / beat)) play('heart');
      if (st.t >= CONTINUE_SECS) { st.t = CONTINUE_SECS; d.crack = 0; fxs.drain = 1; play('impact'); fxs.shake = reducedFlash() ? 0.05 : 0.35; } // glass-crack drop, then GAME OVER
    }
  }

  const center = (ctx, text, y, font, color) => { ctx.font = font; ctx.fillStyle = color; ctx.fillText(text, ctx.canvas.width / 2, y); };
  function shakeXY() { const k = fxs.shake * (reducedFlash() ? 4 : 16); return k ? [(Math.random() - 0.5) * k, (Math.random() - 0.5) * k] : [0, 0]; }
  function drawParts(ctx) {
    for (const q of fxs.parts) {
      ctx.save(); ctx.globalAlpha = Math.min(1, (q.life - q.t) / 0.4); ctx.translate(q.x, q.y); ctx.rotate(q.rot);
      const im = ui.ui_slice && ready(ui.ui_slice) ? ui.ui_slice : ui['pickups/pizza'];
      if (q.slice && ready(im)) ctx.drawImage(im, -q.size / 2, -q.size / 2 * im.naturalHeight / im.naturalWidth, q.size, q.size * im.naturalHeight / im.naturalWidth);
      else { ctx.fillStyle = q.c; ctx.fillRect(-q.size / 2, -q.size / 4, q.size, q.size / 2); }
      ctx.restore();
    }
  }
  function drawClear(ctx, W, H) {
    const d = st.data, t = st.t, T = CLEAR_T;
    // Translucent backdrop: the hero's victory pose stays visible behind the card.
    ctx.fillStyle = `rgba(4,10,8,${Math.min(0.68, t * 2)})`; ctx.fillRect(0, 0, W, H);
    // baba_booey: splash art fades in behind the results (kept a little see-through, so the in-world pose still shows).
    const heroes = (d.heroes || []).filter(id => ready(victory[id])), solo = heroes.length === 1, dx = solo ? 60 : 0;
    if (ready(ui.splash)) {
      const im = ui.splash, sc = Math.max(W / im.naturalWidth, H / im.naturalHeight);
      ctx.save(); ctx.globalAlpha = Math.min(0.85, t * 2.5); ctx.drawImage(im, (W - im.naturalWidth * sc) / 2, (H - im.naturalHeight * sc) / 2, im.naturalWidth * sc, im.naturalHeight * sc);
      ctx.globalAlpha = Math.min(0.62, t * 2); ctx.fillStyle = '#04080a'; ctx.fillRect(W / 2 - 256 + dx, 150, 412, H - 182); ctx.restore(); // results panel
    }
    // The chosen hero (and co-op P2 from the right) slides in.
    const vk = Math.min(1, Math.max(0, (t - 0.12) / 0.45));
    if (solo) drawWinner(ctx, heroes[0], 88, H - 6, 164, 330, vk, -1, W); // wrap-up: narrower so the cut-out stays left of the results panel (x 174)
    else if (heroes.length > 1) { drawWinner(ctx, heroes[0], 86, H - 6, 175, 285, vk, -1, W); drawWinner(ctx, heroes[1], W - 86, H - 6, 175, 250, Math.min(1, Math.max(0, (t - 0.24) / 0.45)), 1, W); }
    const [sx, sy] = shakeXY();
    ctx.save(); ctx.translate(sx, sy);
    // Banner slam: big -> overshoot -> settle.
    const bk = Math.min(1, t / 0.32), bs = t < 0.32 ? 2.4 - 1.4 * easeOutBack(bk, 2.6) : 1;
    ctx.save(); ctx.translate(W / 2, 78); ctx.scale(bs, bs); ctx.globalAlpha = Math.min(1, t * 6);
    if (ready(ui.stage_clear)) ctx.drawImage(ui.stage_clear, -150, -75, 300, 151);
    else { ctx.font = 'bold 44px monospace'; ctx.fillStyle = '#ffe86b'; ctx.fillText('STAGE CLEAR!', 0, 14); }
    ctx.restore();
    center(ctx, `STAGE ${d.num}  \u2022  ${d.name}`, 170, 'bold 16px monospace', '#9bd6a3');
    const roll = (a, dur, v) => Math.round(v * Math.min(1, Math.max(0, (t - a) / dur)));
    const rows = [
      ['TIME', `${Math.floor(d.secs / 60)}:${String(d.secs % 60).padStart(2, '0')}`],
      ['ENEMIES KO\'D', String(d.kos)], ['BEST COMBO', d.combo > 1 ? d.combo + 'x' : '-'], ['HITS TAKEN', String(d.hits)], null,
      ['TIME BONUS', '+' + roll(T.lines[0], T.line, d.timeBonus), T.lines[0]], ['COMBO BONUS', '+' + roll(T.lines[1], T.line, d.comboBonus), T.lines[1]],
      ['NO-DAMAGE BONUS', d.perfect ? '+' + roll(T.lines[2], T.line, d.perfect) : '-', T.lines[2]], null,
      ['STAGE BONUS', '+' + roll(T.total, T.totalDur, d.total), T.total],
      ['PIZZA COINS', '+' + roll(T.total, T.totalDur, d.coins || 0), T.total],
    ];
    const L = W / 2 - 240 + dx, R = W / 2 + 130 + dx;
    let y = 200;
    rows.forEach((r, i) => {
      if (!r) { y += 8; return; }
      if (t < (r[2] != null ? r[2] : T.rows * (i / 4))) return;
      const big = r[0] === 'STAGE BONUS', live = r[2] != null && t < r[2] + (big ? T.totalDur : T.line);
      ctx.font = (big ? 'bold 20px' : 'bold 16px') + ' monospace';
      ctx.fillStyle = big ? '#ffe86b' : r[0] === 'PIZZA COINS' ? '#ffc94a' : r[0] === 'NO-DAMAGE BONUS' && d.perfect ? '#7cff6b' : '#dce8e0';
      ctx.textAlign = 'left'; ctx.fillText(r[0], L, y);
      ctx.textAlign = 'right'; if (live) ctx.fillStyle = '#fff'; ctx.fillText(r[1], R, y);
      y += 26;
    });
    // Rank stamp thumps down after the total.
    if (t >= T.stamp - 0.12) {
      const k = Math.min(1, (t - (T.stamp - 0.12)) / 0.14), sc = 3 - 2 * k, im = ui['rank_' + d.rank.toLowerCase()];
      const cx = W / 2 + 228 + dx, cy = heroes.length > 1 ? 214 : 318; // co-op: above P2's head
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.18 * k); ctx.scale(sc, sc); ctx.globalAlpha = Math.min(1, k * 1.5);
      ctx.font = 'bold 11px monospace'; ctx.fillStyle = '#dce8e0'; ctx.textAlign = 'center'; if (k >= 1) ctx.fillText('RANK', 0, -58);
      if (ready(im)) ctx.drawImage(im, -im.naturalWidth / 2, -48, im.naturalWidth, 96);
      else { ctx.font = 'bold 64px monospace'; ctx.fillStyle = '#ffe14d'; ctx.fillText(d.rank, 0, 22); }
      ctx.restore();
    }
    ctx.restore();
    drawParts(ctx);
    ctx.textAlign = 'center';
    if (t > 1.5 && Math.floor(t * 2.5) % 2 === 0) center(ctx, 'PRESS ANY KEY', H - 22, 'bold 17px monospace', '#fff');
  }
  function drawContinue(ctx, W, H) {
    const t = st.t, d = st.data, left = Math.max(0, CONTINUE_SECS - Math.floor(t)), lastThree = CONTINUE_SECS - t <= 3, crack = d.crack;
    if (ready(goArt.continue)) { ctx.save(); ctx.globalAlpha = Math.min(1, t / 0.35); ctx.drawImage(goArt.continue, 0, 0, W, H); ctx.restore(); } // baba_booey: hopeful art fades in over the world
    // The world drains to greyscale and darkens as the countdown runs.
    ctx.save();
    ctx.globalCompositeOperation = 'saturation'; ctx.fillStyle = `rgba(128,128,128,${fxs.drain})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = `rgba(${lastThree ? 40 : 14},0,0,${Math.min(0.3, t) + 0.45 * fxs.drain})`; ctx.fillRect(0, 0, W, H);
    ctx.restore();
    if (crack != null && ready(goArt.gameover)) { ctx.save(); ctx.globalAlpha = Math.min(1, crack / CRACK_SECS); ctx.drawImage(goArt.gameover, 0, 0, W, H); ctx.restore(); } // baba_booey: game-over art rises as the banner cracks
    const [sx, sy] = shakeXY();
    ctx.save(); ctx.translate(sx, sy);
    // Heartbeat pulse (lub-dub), twice as fast in the last 3 seconds.
    const period = lastThree ? 0.5 : 1, p = (t % period) / period;
    const pulse = 1 + 0.07 * Math.max(0, 1 - p * 7) + 0.045 * Math.max(0, 1 - Math.abs(p - 0.24) * 9);
    const bw = 300, bh = 125, by = 150;
    ctx.save();
    if (crack != null) { const k = crack / CRACK_SECS; ctx.translate(W / 2, by + k * k * 260); ctx.rotate(k * 0.35); ctx.globalAlpha = 1 - k * 0.8; }
    else { ctx.translate(W / 2, by); ctx.scale(pulse, pulse); }
    if (lastThree && crack == null) { ctx.shadowColor = '#ff2020'; ctx.shadowBlur = reducedFlash() ? 6 : 10 + 16 * (pulse - 1) * 10; }
    if (ready(ui.continue)) ctx.drawImage(ui.continue, -bw / 2, -bh / 2, bw, bh);
    else { ctx.font = 'bold 46px monospace'; ctx.fillStyle = '#ff5252'; ctx.fillText('CONTINUE?', 0, 16); }
    ctx.shadowBlur = 0;
    if (crack != null) { // glass crack lines over the banner
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2; ctx.beginPath();
      const segs = [[-10, -50, 8, -12, -18, 18, 4, 58], [8, -12, 60, -24, 130, -40], [-18, 18, -80, 30, -140, 22], [4, 20, 70, 38, 120, 60]];
      for (const s2 of segs) { ctx.moveTo(s2[0], s2[1]); for (let i = 2; i < s2.length; i += 2) ctx.lineTo(s2[i], s2[i + 1]); }
      ctx.stroke();
    }
    ctx.restore();
    if (crack == null) {
      // Each digit punches in big and settles.
      const k = t % 1, sc = 1 + 1.3 * (1 - easeOutBack(Math.min(1, k / 0.28), 2.2));
      ctx.save(); ctx.translate(W / 2, H / 2 + 40); ctx.scale(sc, sc); ctx.globalAlpha = Math.min(1, 0.4 + k * 4);
      ctx.font = 'bold 96px monospace'; ctx.lineWidth = 8; ctx.strokeStyle = '#1a0000'; ctx.lineJoin = 'round';
      ctx.textBaseline = 'middle'; ctx.strokeText(String(left), 0, 4); ctx.fillStyle = lastThree ? '#ff4040' : '#ffe86b'; ctx.fillText(String(left), 0, 4); // scales about its centre
      ctx.restore();
      ctx.strokeStyle = lastThree ? '#ff4040' : '#ffe86b'; ctx.lineWidth = 5; ctx.beginPath();
      ctx.arc(W / 2, H / 2 + 40, 70, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - (t % 1))); ctx.stroke();
    }
    ctx.restore();
    center(ctx, 'ENTER / SPACE / J  continue      ESC  give up', H - 58, 'bold 14px monospace', '#fff');
    center(ctx, `SCORE ${d.s.score}`, H - 32, 'bold 16px monospace', '#9bd6a3');
  }
  function drawFinal(ctx, W, H) {
    const t = st.t;
    if (ready(goArt.gameover)) { ctx.drawImage(goArt.gameover, 0, 0, W, H); ctx.fillStyle = `rgba(0,0,0,${Math.min(0.3, 0.12 + t * 0.3)})`; } // baba_booey: game-over art (text areas pre-darkened)
    else ctx.fillStyle = `rgba(0,0,0,${Math.min(0.9, 0.6 + t)})`;
    ctx.fillRect(0, 0, W, H);
    const d = Math.min(1, t / 0.7), ease = 1 - Math.abs(Math.cos(d * Math.PI * 2.5)) * (1 - d);
    center(ctx, 'GAME OVER', -40 + (H / 2 - 30 + 40) * ease, 'bold 56px monospace', '#ff5252');
    if (t > 0.8) {
      const r = st.run || { kos: 0, combo: 0 };
      center(ctx, `FINAL SCORE ${st.data.s.score}   KO'S ${r.kos}   BEST COMBO ${r.combo > 1 ? r.combo + 'x' : '-'}`, H / 2 + 20, 'bold 15px monospace', '#dce8e0');
      if (Math.floor(t * 2.5) % 2 === 0) center(ctx, 'PRESS ANY KEY FOR TITLE', H / 2 + 60, 'bold 16px monospace', '#fff');
    }
  }
  function drawCredits(ctx, W, H) {
    const t = st.t, d = st.data, r = st.run || { t: 0, kos: 0, combo: 0, continues: 0 };
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#120a24'); g.addColorStop(1, '#03060a');
    ctx.globalAlpha = Math.min(1, t * 1.5); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // Stars.
    for (let i = 0; i < 60; i++) { const x = (i * 97) % W, y = (i * 53 + t * (8 + i % 5 * 4)) % H; ctx.fillStyle = `rgba(255,255,255,${0.25 + (i % 3) * 0.2})`; ctx.fillRect(x, y, 2, 2); }
    ctx.globalAlpha = 1; ctx.textAlign = 'center';
    if (t < 6) {
      // Victory card: the chosen hero and the run's totals.
      const a = Math.min(1, t / 0.6) * Math.min(1, (6 - t) / 0.6);
      ctx.globalAlpha = a;
      center(ctx, 'THE CITY IS SAVED!', 70, 'bold 34px monospace', '#ffe86b');
      const h = HEROES.find(x => x.id === d.hero), im = portraits[d.hero];
      // baba_booey: the victory pose cut-out(s) stand on the left and the totals move right; the plain portrait is the fallback.
      const vh = (d.heroes || [d.hero]).filter(id => ready(victory[id])), vk = Math.min(1, t / 0.55);
      const names = (d.heroes || []).map(id => (HEROES.find(x => x.id === id) || {}).name).filter(Boolean);
      const who = names.length > 1 ? names.join(' & ') : (h ? h.name : 'THE HEROES');
      const tx = vh.length ? W / 2 + 120 : W / 2, at = (text, y, font, color) => { ctx.font = font; ctx.fillStyle = color; ctx.fillText(text, tx, y); };
      if (vh.length > 1) { drawWinner(ctx, vh[1], 270, H - 18, 180, 300, vk, -1, W); drawWinner(ctx, vh[0], 135, H - 12, 200, 350, vk, -1, W); }
      else if (vh.length) drawWinner(ctx, vh[0], 170, H - 14, 270, 380, vk, -1, W);
      else if (im && im.complete && im.width) ctx.drawImage(im, W / 2 - 60, 92, 120, 150);
      at(who + ' beat SHREDCLAW', vh.length ? 150 : 268, 'bold 16px monospace', '#9bd6a3');
      const secs = Math.round(r.t);
      const lines = [`FINAL SCORE  ${d.score}`, `TIME  ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, `ENEMIES KO'D  ${r.kos}`, `BEST COMBO  ${r.combo > 1 ? r.combo + 'x' : '-'}`, `CONTINUES USED  ${r.continues}`];
      lines.forEach((l, i) => at(l, (vh.length ? 196 : 304) + i * 30, 'bold 16px monospace', i === 0 ? '#fff' : '#dce8e0'));
      ctx.globalAlpha = 1;
      return;
    }
    // Scrolling credits.
    const speed = 40, base = H + 20 - (t - 6) * speed;
    let y = base;
    for (const row of CREDITS) {
      const k = row[0];
      if (k === 'gap') { y += 26; continue; }
      if (y > -60 && y < H + 60) {
        if (k === 'title') center(ctx, row[1], y, 'bold 30px monospace', '#ffe86b');
        else if (k === 'head') center(ctx, row[1], y, 'bold 14px monospace', '#ff9a3c');
        else if (k === 'name') center(ctx, row[1], y, 'bold 18px monospace', '#fff');
        else if (k === 'role') { center(ctx, row[1], y, 'bold 18px monospace', '#fff'); center(ctx, row[2], y + 18, '13px monospace', '#9bd6a3'); }
        else if (k === 'heroes') HEROES.forEach((h, i) => center(ctx, h.name + (h.weapon ? '  ·  ' + h.weapon : ''), y + i * 22, '15px monospace', '#dce8e0'));
      }
      y += k === 'role' ? 44 : k === 'heroes' ? HEROES.length * 22 : k === 'title' ? 44 : 30;
    }
    // Hold THE END once the roll has passed.
    if (y < H / 2 - 40) {
      center(ctx, 'THE END', H / 2 + 60, 'bold 40px monospace', '#ffe86b');
      if (Math.floor(t * 2.5) % 2 === 0) center(ctx, 'PRESS ANY KEY FOR TITLE', H - 40, 'bold 15px monospace', '#fff');
      st.rollDone = true;
    } else st.rollDone = false;
  }
  function hiBackdrop(ctx, W, H, a) {
    if (hiBg && hiBg.complete && hiBg.width) ctx.drawImage(hiBg, 0, 0, W, H); else { ctx.fillStyle = '#05080a'; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.fillRect(0, 0, W, H);
  }
  function drawInitials(ctx, W, H) {
    const t = st.t, en = st.entry;
    hiBackdrop(ctx, W, H, 0.45);
    center(ctx, 'NEW HIGH SCORE!', 92, 'bold 40px monospace', '#ffe86b');
    center(ctx, String(en.e.score), 132, 'bold 26px monospace', '#fff');
    center(ctx, 'ENTER YOUR INITIALS', 176, 'bold 16px monospace', '#9bd6a3');
    for (let i = 0; i < 3; i++) {
      const x = W / 2 + (i - 1) * 74, y = 266, on = i === en.slot;
      ctx.fillStyle = on ? 'rgba(255,232,107,0.18)' : 'rgba(0,0,0,0.45)'; ctx.fillRect(x - 30, y - 56, 60, 76);
      ctx.strokeStyle = on ? '#ffe86b' : '#708878'; ctx.lineWidth = on ? 3 : 2; ctx.strokeRect(x - 30, y - 56, 60, 76);
      ctx.font = 'bold 56px monospace'; ctx.fillStyle = on && Math.floor(t * 3) % 2 ? '#fff' : on ? '#ffe86b' : '#dce8e0';
      ctx.fillText(LETTERS[en.letters[i]], x, y);
      if (on) { ctx.fillStyle = '#ffe86b'; ctx.font = 'bold 14px monospace'; ctx.fillText('\u25b2', x, y - 64); ctx.fillText('\u25bc', x, y + 38); }
    }
    center(ctx, 'Type letters, or Up/Down to change and Left/Right to move', H - 118, '13px monospace', '#dce8e0');
    center(ctx, 'ENTER confirms', H - 98, '13px monospace', '#dce8e0');
    center(ctx, `${Math.max(0, Math.ceil(30 - t))}`, H - 60, 'bold 18px monospace', '#ff9a3c');
  }
  function drawScores(ctx, W, H) {
    const t = st.t, list = loadScores(), rank = st.entry ? st.entry.rank : -1;
    hiBackdrop(ctx, W, H, 0.55);
    center(ctx, 'HIGH SCORES', 64, 'bold 38px monospace', '#ffe86b');
    ctx.font = 'bold 12px monospace'; ctx.fillStyle = '#ff9a3c';
    const cols = [W / 2 - 270, W / 2 - 205, W / 2 - 80, W / 2 + 10, W / 2 + 275];
    ctx.textAlign = 'left'; ctx.fillText('RANK', cols[0], 98); ctx.fillText('NAME', cols[1], 98); ctx.fillText('HERO', cols[3], 98);
    ctx.textAlign = 'right'; ctx.fillText('SCORE', cols[2] + 60, 98); ctx.fillText('STAGE', cols[4], 98);
    if (!list.length) center(ctx, 'NO SCORES YET', 200, 'bold 18px monospace', '#dce8e0');
    list.forEach((e, i) => {
      if (t < 0.15 + i * 0.07) return;
      const y = 128 + i * 31, me = i === rank;
      if (me) { ctx.fillStyle = `rgba(255,232,107,${0.16 + 0.1 * Math.sin(t * 6)})`; ctx.fillRect(cols[0] - 10, y - 21, cols[4] - cols[0] + 20, 28); }
      ctx.font = (me ? 'bold ' : '') + '17px monospace';
      ctx.fillStyle = me ? '#ffe86b' : i === 0 ? '#fff' : '#dce8e0';
      const ord = ['1ST', '2ND', '3RD'][i] || (i + 1) + 'TH';
      ctx.textAlign = 'left'; ctx.fillText(ord, cols[0], y); ctx.fillText(String(e.n || '???').slice(0, 3), cols[1], y); ctx.font = (me ? 'bold ' : '') + '14px monospace'; ctx.fillText(String(e.hero || '').slice(0, 15), cols[3], y);
      ctx.textAlign = 'right'; ctx.fillText(String(e.score), cols[2] + 60, y); ctx.font = '12px monospace'; ctx.fillText(String(e.stage || '').slice(0, 10), cols[4], y);
    });
    ctx.textAlign = 'center';
    if (t > 1 && Math.floor(t * 2.5) % 2 === 0) center(ctx, 'PRESS ANY KEY', H - 22, 'bold 15px monospace', '#fff');
  }
  function drawFlash(ctx, W, H) { if (fxs.flash > 0) { ctx.save(); ctx.fillStyle = `rgba(255,255,255,${Math.min(1, fxs.flash) * 0.7})`; ctx.fillRect(0, 0, W, H); ctx.restore(); } }
  function draw(ctx, W, H) {
    if (!st.mode) { if (fxs.flash > 0 || fxs.parts.length) { drawParts(ctx); drawFlash(ctx, W, H); } return; }
    ctx.save(); ctx.textAlign = 'center';
    if (st.mode === 'clear') drawClear(ctx, W, H);
    else if (st.mode === 'continue') drawContinue(ctx, W, H);
    else if (st.mode === 'final') drawFinal(ctx, W, H);
    else if (st.mode === 'credits') drawCredits(ctx, W, H);
    else if (st.mode === 'initials') drawInitials(ctx, W, H);
    else if (st.mode === 'scores') drawScores(ctx, W, H);
    drawFlash(ctx, W, H);
    ctx.restore(); ctx.textAlign = 'left';
  }
  return {
    reset, before, after, stageClear, gameOver, ending, handleKey, update, draw,
    active: () => !!st.mode, blocking: () => !!st.mode, mode: () => st.mode,
    get t() { return st.t; }, get entry() { return st.entry; }, scores: loadScores, showScores() { st.entry = null; st.mode = 'scores'; st.t = 0; }, get data() { return st.data; }, get run() { return st.run; }, get rollDone() { return !!st.rollDone; },
    press: code => handleKey({ code, repeat: false }),
    get juice() { const d = st.data || {}; return { rank: d.rank || null, stamped: !!d.stamped, countDone: st.mode === 'clear' && st.t >= CLEAR_T.done, drain: fxs.drain, crack: d.crack != null ? d.crack : null, parts: fxs.parts.length, flash: fxs.flash, reduced: reducedFlash() }; }, // dolan: juice state for tests
  };
}
