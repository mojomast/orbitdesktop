// coach.js: first-run coach marks (mr_india, t_6ebf4f0c9c624d89).
// The first time a player reaches gameplay from NEW GAME, four short cards teach move, attack,
// special and grab/throw. Each card advances when the player actually does the move (or after a
// short timeout); Enter skips the card; Esc / pad START dismisses them all (and still opens pause as usual). Gameplay never freezes.
// Once the sequence ends (completed, skipped or timed out) the flag 'pizzaPanicCoachDone' is set through
// the guarded store (save.js guardedStore: in-memory fallback on Orbit's sandboxed origin), so it is
// never shown again. CONTINUE runs never show it; P1 only in co-op. CLEAR SAVE does not reset the flag.
// Flags: ?coach=1 forces the cards (ignores the stored flag), ?coach=0 skips them;
// window.__ppCoach.force(true|false|null) does the same for tests, .reset() clears the stored flag.
import { guardedStore } from './save.js';

export const COACH_KEY = 'pizzaPanicCoachDone';
export const CARDS = [
  { id: 'move', title: 'MOVE', keys: 'ARROWS / WASD  -  double-tap or SHIFT / C to dash', pad: 'STICK / D-PAD  -  LT / RT dash', time: 9 },
  { id: 'attack', title: 'ATTACK', keys: 'J punch  -  K kick  -  L jump  (punch x4 = finisher)', pad: 'X punch  -  B kick  -  A jump', time: 10 },
  { id: 'special', title: 'SPECIAL', keys: 'J + L together: spin special (costs a little HP)', pad: 'RB special', time: 10 },
  { id: 'grab', title: 'GRAB & THROW', keys: 'walk into a stunned foe: J knee - J+away throw - K/L slam', pad: 'X knee - X+away throw - B/A slam', time: 12 },
];

function urlFlag() {
  try { const m = /[?&]coach=(\d)/.exec(String((globalThis.location && globalThis.location.search) || '')); return m ? m[1] === '1' : null; } catch { return null; }
}

export function createCoach(opts = {}) {
  const store = guardedStore(opts.store);
  let forced = opts.force != null ? opts.force : urlFlag();
  const st = { on: false, i: 0, t: 0, owner: null, base: null, attacks: 0, lastAtk: null, fade: 0, done: [], stats: { shown: 0, completed: 0, skipped: 0, timedOut: 0 } };
  const icons = {}, iconDraws = {}; // card illustrations (t_cd6d3db7a9774e77); a card without a loaded icon draws as before
  if (typeof Image !== 'undefined') for (const c of CARDS) { try { const im = new Image(); im.onload = () => { icons[c.id] = im; }; im.src = 'assets/ui/coach/' + c.id + '.png'; } catch (_) {} }
  const acknowledged = () => store.get(COACH_KEY) === '1';
  const wanted = () => (forced === true ? true : forced === false ? false : !acknowledged());

  // Called when a NEW GAME run starts (not on CONTINUE). Arms the cards for this run.
  function begin(s) {
    st.on = false; st.owner = null;
    if (!s || !wanted()) return false;
    st.on = true; st.owner = s; st.i = 0; st.t = 0; st.base = null; st.attacks = 0; st.lastAtk = s.combat && s.combat.attack; st.done = []; st.seen = false; st.stats.shown++;
    return true;
  }
  function finish(how) {
    st.on = false; st.owner = null; st.fade = 0.4;
    st.stats[how] = (st.stats[how] || 0) + 1;
    store.set(COACH_KEY, '1');
  }
  function next(how) {
    st.done.push({ id: CARDS[st.i].id, how });
    st.i++; st.t = 0; st.base = null; st.attacks = 0;
    if (st.i >= CARDS.length) finish(st.done.every(d => d.how === 'did') ? 'completed' : how === 'skip' ? 'skipped' : 'timedOut');
  }

  // Per frame (game.js loop). env.live = gameplay is visible and running (no cinema / card / pause / shop).
  function update(s, dt, env = {}) {
    if (st.fade > 0) st.fade = Math.max(0, st.fade - dt);
    // Queue coach cards behind scripted-event dialogue so they can never overlap.
    if (st.on && s && s.events && s.events.line) return;
    if (!st.on || s !== st.owner || !env.live || s.over) return;
    const c = s.combat || {}, p = s.player || { x: 0, y: 0 }, card = CARDS[st.i];
    if (!st.base) st.base = { x: p.x, y: p.y, moved: 0 };
    st.seen = true; // the cards are on screen: Enter / Esc now belong to them
    st.t += dt;
    const atk = c.attack, fresh = atk && atk !== st.lastAtk; st.lastAtk = atk;
    let did = false;
    if (card.id === 'move') { st.base.moved += Math.hypot(p.x - st.base.x, p.y - st.base.y); st.base.x = p.x; st.base.y = p.y; did = st.base.moved > 90; }
    else if (card.id === 'attack') { if (fresh) st.attacks++; did = st.attacks >= 2; }
    else if (card.id === 'special') did = !!(fresh && (atk.cost || /special/i.test(atk.name || '')));
    else if (card.id === 'grab') did = !!c.grab || !!(fresh && atk.name === 'grabThrow');
    if (did) next('did'); else if (st.t >= card.time) next('timeout');
  }

  // Keydown hook: Enter skips the current card (eaten); Esc (pad START) dismisses all and is passed on to pause. Only while a card is up.
  function handleKey(e) {
    if (!st.on || !st.seen || e.repeat) return false;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { next('skip'); return true; }
    if (e.code === 'Escape') { while (st.on) next('skip'); return false; } // dismiss all, then Esc / START still pauses as usual
    return false;
  }

  function draw(ctx, W, H) {
    if (!st.on || !st.seen) return;
    if (st.owner && st.owner.events && st.owner.events.line) return;
    const card = CARDS[st.i], k = Math.min(1, st.t * 5), bw = 500, bh = 66, x = (W - bw) / 2, y = H - 128 + (1 - k) * 16;
    ctx.save(); ctx.globalAlpha = k; ctx.textAlign = 'center';
    const icon = icons[card.id], ix = icon ? x - 62 : x, iw = bw + (icon ? 62 : 0); // the icon gets its own panel at the card's left
    ctx.fillStyle = 'rgba(8,14,22,0.84)'; ctx.fillRect(ix, y, iw, bh);
    ctx.strokeStyle = '#7cff6b'; ctx.lineWidth = 2; ctx.strokeRect(ix, y, iw, bh);
    if (icon) { ctx.drawImage(icon, x - 59, y + 4, 58, 58); iconDraws[card.id] = (iconDraws[card.id] || 0) + 1; }
    ctx.fillStyle = '#7cff6b'; ctx.fillRect(x, y + bh - 3, bw * Math.max(0, 1 - st.t / card.time), 3); // timeout bar
    ctx.font = 'bold 15px monospace'; ctx.fillStyle = '#ffe14d'; ctx.fillText(`${card.title}`, W / 2, y + 19);
    ctx.font = '10px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.textAlign = 'right'; ctx.fillText(`${st.i + 1}/${CARDS.length}`, x + bw - 8, y + 15);
    ctx.textAlign = 'left'; ctx.fillText('ENTER next  ESC skip all', x + 8, y + 15); ctx.textAlign = 'center';
    ctx.font = 'bold 12px monospace'; ctx.fillStyle = '#e8f0ea'; ctx.fillText(card.keys, W / 2, y + 38);
    ctx.font = '11px monospace'; ctx.fillStyle = '#8fd3ff'; ctx.fillText('PAD  ' + card.pad + '  -  START skip', W / 2, y + 55);
    ctx.restore();
  }

  return {
    begin, update, handleKey, draw,
    get active() { return st.on; }, get card() { return st.on ? CARDS[st.i].id : null; }, get index() { return st.i; },
    get done() { return st.done.slice(); }, get stats() { return { ...st.stats }; }, acknowledged, get iconDraws() { return { ...iconDraws }; },
    force(v) { forced = v === true || v === false ? v : null; }, reset() { store.set(COACH_KEY, ''); }, store,
  };
}
