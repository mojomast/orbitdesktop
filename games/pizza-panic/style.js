// style.js: per-stage combo / style tracking, live combo counter, STYLE grade on the
// stage clear card (mr_india, t_35fa8ec420214dc1).
// Tracked per stage, for P1 only (co-op P2 runs on its own slice in coop.js):
//   maxCombo  longest s.combo reached
//   juggles   air re-launches (each n.juggles increase past the first launch)
//   specials  health specials started (moves with a health cost) + team-up assists fired (s.super 100 -> 0)
//   dmg       HP lost, not counting a special's own health cost
// Style points = min(maxCombo, 50) + min(4 * juggles, 30) + min(5 * specials, 20) - floor(dmg / 4)
//   STYLE S >= 60, A >= 40, B >= 20, else C.
// The STYLE grade sits on its own line on the stage clear card (drawn under the rows, after
// the rank stamp lands). It does NOT change screens.js's S/A/B/C stage rank or the score bonus;
// it is attached as screens.data.style = { grade, points, maxCombo, juggles, specials, dmg, text }.
// Milestones: the live counter pops at 10 / 25 / 50; fx.js's praise text uses the same
// milestones (MILESTONE_TEXT) so each milestone shows exactly one word.
import { OPTIONS } from './options-live.js'; // read only: colourSafe / reducedMotion for the live meter
export const MILESTONES = [10, 25, 50];
export const MILESTONE_TEXT = { 10: 'RADICAL!', 25: 'TUBULAR!', 50: 'COWABUNGA!' };
// The praise word for a combo that crossed a milestone this frame (from -> to), else null.
export function fxPraise(from, to) { let w = null; for (const m of MILESTONES) if (to >= m && from < m) w = MILESTONE_TEXT[m]; return w; }
export const STYLE_THRESHOLDS = { S: 60, A: 40, B: 20 };
export function stylePoints(g) {
  return Math.min(g.maxCombo || 0, 50) + Math.min(4 * (g.juggles || 0), 30) + Math.min(5 * (g.specials || 0), 20) - Math.floor((g.dmg || 0) / 4);
}
export function styleGrade(g) {
  const p = stylePoints(g);
  return p >= STYLE_THRESHOLDS.S ? 'S' : p >= STYLE_THRESHOLDS.A ? 'A' : p >= STYLE_THRESHOLDS.B ? 'B' : 'C';
}
export function styleLine(g) {
  return `STYLE ${styleGrade(g)}: max combo ${g.maxCombo}, ${g.juggles} juggle${g.juggles === 1 ? '' : 's'}, ${g.specials} special${g.specials === 1 ? '' : 's'}, ${g.dmg} dmg taken`;
}
const GRADE_COL = { S: '#7cff6b', A: '#ffe14d', B: '#8fd3ff', C: '#c8c8c8' };

// Live STYLE meter (mr_india, t_ada855f0f2f140dd): the same formula as the clear card, read
// mid-stage. progress = how far the points are from this grade's floor to the next grade.
const ORDER = ['C', 'B', 'A', 'S'];
export function styleLive(g) {
  if (!g) return null;
  const points = stylePoints(g), grade = styleGrade(g), i = ORDER.indexOf(grade);
  const lo = i === 0 ? 0 : STYLE_THRESHOLDS[grade], next = ORDER[i + 1] || null, hi = next ? STYLE_THRESHOLDS[next] : lo;
  return { grade, points, next, progress: next ? Math.max(0, Math.min(1, (points - lo) / (hi - lo))) : 1 };
}
// Colour-safe: Okabe-Ito hues, and the letter carries a 1-4 tick count so grades never rely on colour.
const GRADE_COL_SAFE = { S: '#56b4e9', A: '#e69f00', B: '#f0e442', C: '#bbbbbb' };
// The meter's screen rect: right edge, under the live HIT COMBO counter (W-84..W-18, y 150..190)
// and the co-op 2P card (y 82..126); clear of the hero card (left), score/sound panels (top),
// the TEAM UP meter (bottom left) and the boss bar (bottom centre).
export const METER_RECT = (W) => ({ x: W - 96, y: 198, w: 84, h: 30 });
const opt = () => { try { return OPTIONS || {}; } catch (_) { return {}; } };
const overlayUp = () => { try { const w = globalThis.window || {}; return !!((w.__ppBonus && w.__ppBonus.active && w.__ppBonus.active()) || (w.__ppShop && w.__ppShop.active && w.__ppShop.active()) || (w.__ppMap && w.__ppMap.active && w.__ppMap.active())); } catch (_) { return false; } };

export function createStyle() {
  let owner = null, stage = null, ended = null, frames = 0, last = null, lastClear = null, pop = { t: 9, m: 0 }, shown = 0;
  const meter = { grade: null, rankT: 9, idleT: 9, points: null, combo: 0, drawn: false, alpha: 0, rect: null }; // live STYLE meter
  const jug = new WeakMap();
  const fresh = s => ({ wave: s.wave, maxCombo: 0, juggles: 0, specials: 0, dmg: 0, carry: s.combo || 0 }); // carry: a combo running over the stage change does not count
  function reset(s) { stage = fresh(s); last = { hp: s.hp, attack: s.combat && s.combat.attack, sup: s.super || 0, combo: s.combo || 0 }; for (const n of s.ninjas || []) jug.set(n, n.juggles || 0); }

  function track(s) {
    const combo = s.combo || 0;
    if (combo !== stage.carry) { stage.carry = -1; stage.maxCombo = Math.max(stage.maxCombo, combo); }
    for (const m of MILESTONES) if (combo >= m && last.combo < m) { pop = { t: 0, m }; }
    for (const n of s.ninjas || []) {
      const j = n.juggles || 0, pj = jug.has(n) ? jug.get(n) : 0;
      if (j > pj) stage.juggles += Math.max(0, j - Math.max(pj, 1));
      jug.set(n, j);
    }
    const atk = s.combat && s.combat.attack;
    let cost = 0;
    if (atk && atk !== last.attack && atk.cost) { stage.specials++; cost = atk.cost; }
    if ((last.sup || 0) >= 100 && (s.super || 0) < 100) stage.specials++;
    if (Number.isFinite(s.hp) && Number.isFinite(last.hp) && s.hp < last.hp) stage.dmg += Math.max(0, Math.round(last.hp - s.hp - cost));
    last = { hp: s.hp, attack: atk, sup: s.super || 0, combo };
  }

  // Per frame from game.js's loop, after the sim.
  function watch(s, screens) {
    if (!s) return;
    frames++;
    if (owner !== s) { owner = s; reset(s); ended = null; }
    const mode = screens && screens.mode ? screens.mode() : null, data = screens && screens.data;
    if (mode === 'clear' && data && data !== lastClear) {
      // Stage clear just fired: finish this stage's style, then start the next stage fresh.
      lastClear = data;
      const src = ended && frames - ended.at < 180 ? ended.g : stage; ended = null; // the wave may tick over a frame or two before the card
      const g = { maxCombo: src.maxCombo, juggles: src.juggles, specials: src.specials, dmg: src.dmg };
      data.style = { grade: styleGrade(g), points: stylePoints(g), ...g, text: styleLine(g) };
      reset(s); return;
    }
    if (mode || s.over) { last.hp = s.hp; last.combo = s.combo || 0; last.attack = s.combat && s.combat.attack; last.sup = s.super || 0; return; }
    if (s.wave !== stage.wave) { ended = { g: stage, at: frames }; reset(s); } // new stage; the clear card (if any) picks up `ended`
    track(s);
  }

  function draw(ctx, W, H, s, screens, dt = 1 / 60) {
    pop.t += dt; meter.drawn = false;
    const mode = screens && screens.mode ? screens.mode() : null;
    ctx.save();
    if (mode === 'clear') {
      const d = screens.data, j = screens.juice || {};
      if (d && d.style && j.stamped) {
        const st = d.style, a = Math.min(1, (screens.t - 0) * 2);
        // wrap-up: centred on the results panel (shifted right when a solo hero cut-out stands left), 12px so it clears the art.
        const cx = W / 2 + ((d.heroes || []).length === 1 ? 60 : 0);
        ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.font = 'bold 12px monospace';
        const y = H - 62, w = Math.min(W - 20, ctx.measureText(st.text).width + 24);
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(cx - w / 2, y - 14, w, 21);
        ctx.fillStyle = GRADE_COL[st.grade]; ctx.fillText(st.text, cx, y + 1);
      }
    } else if (s && !mode && !s.over) {
      drawMeter(ctx, W, H, s, dt);
      // Live counter: right edge, below the co-op P2 card, clear of the hero card and lives pips.
      const c = s.combo || 0;
      if (c >= 2) shown = c;
      if (c >= 2 || pop.t < 0.6) {
        const k = pop.t < 0.35 ? 1 + 0.7 * (1 - pop.t / 0.35) : 1, hot = pop.m && pop.t < 0.6;
        const x = W - 18, y = 172;
        ctx.translate(x, y); ctx.scale(k, k); ctx.textAlign = 'right';
        ctx.font = 'bold 30px monospace'; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        const n = String(c >= 2 ? c : shown); ctx.strokeText(n, 0, 0);
        ctx.fillStyle = hot ? '#7cff6b' : c >= 25 ? '#ff6e8f' : c >= 10 ? '#ffb347' : '#ffe86b'; ctx.fillText(n, 0, 0);
        ctx.font = 'bold 11px monospace'; ctx.strokeText('HIT COMBO', 0, 14); ctx.fillText('HIT COMBO', 0, 14);
        if (hot) { ctx.globalAlpha = Math.max(0, 1 - pop.t / 0.6); ctx.strokeStyle = '#7cff6b'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(-24, -10, 26 + 40 * pop.t, 0, Math.PI * 2); ctx.stroke(); }
      }
    }
    ctx.restore();
  }

  // Live STYLE meter: a grade pip + thin bar to the next grade. Pulses on a rank-up (not with
  // reduced motion), dims after a few seconds without combo / juggle / special / damage changes.
  function drawMeter(ctx, W, H, s, dt) {
    meter.drawn = false;
    const L = styleLive(stage);
    if (!L || overlayUp()) return;
    const o = opt(), reduced = !!o.reducedMotion, safe = !!o.colourSafe;
    const combo = s.combo || 0;
    if (meter.points === null) meter.points = L.points;
    if (L.points !== meter.points || (combo >= 2 && combo !== meter.combo)) meter.idleT = 0; else meter.idleT += dt;
    if (meter.grade && ORDER.indexOf(L.grade) > ORDER.indexOf(meter.grade)) meter.rankT = 0; else meter.rankT += dt;
    meter.points = L.points; meter.combo = combo; meter.grade = L.grade;
    const idle = meter.idleT > 4 && combo < 2;
    const alpha = idle ? 0.38 : 1;
    const r = METER_RECT(W), col = (safe ? GRADE_COL_SAFE : GRADE_COL)[L.grade];
    meter.alpha = alpha; meter.rect = r; meter.drawn = true; meter.live = L; meter.safe = safe; meter.reduced = reduced;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(5,18,14,0.72)'; ctx.strokeStyle = 'rgba(130,240,150,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(r.x, r.y, r.w, r.h, 7); else ctx.rect(r.x, r.y, r.w, r.h); ctx.fill(); ctx.stroke();
    // Letter pip (pulses on rank-up unless reduced motion is on).
    const k = !reduced && meter.rankT < 0.4 ? 1 + 0.45 * (1 - meter.rankT / 0.4) : 1;
    const px = r.x + 15, py = r.y + r.h / 2;
    ctx.save(); ctx.translate(px, py); ctx.scale(k, k);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
    ctx.fillStyle = col; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(L.grade, 0, 1);
    ctx.restore();
    if (!reduced && meter.rankT < 0.5) { ctx.save(); ctx.globalAlpha = alpha * (1 - meter.rankT / 0.5); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, 12 + 18 * meter.rankT, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
    // Label, colour-safe tick count, thin progress bar to the next grade.
    const tx = r.x + 31, bw = r.w - 38;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.font = 'bold 9px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText('STYLE', tx, r.y + 12);
    if (safe) for (let i = 0; i <= ORDER.indexOf(L.grade); i++) { ctx.fillStyle = col; ctx.fillRect(tx + 34 + i * 4, r.y + 6, 2, 6); }
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(tx, r.y + 18, bw, 4);
    ctx.fillStyle = col; ctx.fillRect(tx, r.y + 18, bw * L.progress, 4);
    if (L.next) { ctx.font = '8px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.textAlign = 'right'; ctx.fillText(L.next, r.x + r.w - 4, r.y + 12); }
    ctx.restore();
  }

  return { watch, draw, reset, get live() { return styleLive(stage); }, get meter() { return { ...meter, rect: meter.rect && { ...meter.rect } }; }, get stage() { if (!stage) return null; const { carry, ...o } = stage; return o; }, get pop() { return { ...pop }; } };
}
