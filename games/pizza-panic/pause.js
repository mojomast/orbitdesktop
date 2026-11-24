// pause.js: menu overlay drawn in screen space. Keeps all menu state and input
// parsing away from game.js so the gameplay module only needs open/close hooks.
// Shared options-screen layout. Every row gets one pitch, and each drawn element has an
// explicit box so overlaps are a testable fact rather than a judgement call. Kept at
// module scope (and exported) so the dev suites assert it without a canvas.
export const OPT_LAYOUT = { top: 150, pitch: 72, name: 20, val: 18, hint: 10, boxPad: 12, boxH: 44, gap: 10 };

// Controls screen: twelve key lines used to run from 124 to 421 on a fixed 27px pitch
// while the BACK button sits at 404, so the last two lines were drawn under the button.
// The block is now fitted into the space above it instead of overflowing.
export const CTRL_LAYOUT = { firstY: 124, lastY: 372, backY: 404, minPitch: 18 };

export function controlsLayout(n, L = CTRL_LAYOUT) {
  const pitch = n > 1 ? Math.min(27, (L.lastY - L.firstY) / (n - 1)) : 27;
  const lineY = i => L.firstY + i * pitch;
  const last = n ? lineY(n - 1) : L.firstY;
  return { pitch, lineY, lastY: last, backY: L.backY, fitsAboveBack: last <= L.backY - 20, firstY: L.firstY, minPitch: L.minPitch };
}

export function optionsLayout(n, L = OPT_LAYOUT) {
  const rows = [];
  let y = L.top;
  for (let i = 0; i < n; i++) {
    const nameY = y;
    const valY = nameY + L.val + L.gap;              // value clears the label
    const hintY = valY + L.hint + L.gap;             // hint clears the value
    rows.push({
      nameY, valY, hintY,
      boxY: nameY - L.name - L.boxPad, boxH: L.boxH,
      top: nameY - L.name, bottom: hintY,            // drawn extent, for overlap checks
    });
    y += L.pitch;
  }
  const lastHint = rows.length ? rows[rows.length - 1].hintY : L.top;
  const backY = lastHint + L.val + L.gap + L.boxPad;  // Back clears the last hint
  return { rows, backY, backTop: backY - L.val, backBottom: backY, backBoxY: backY - L.val - L.boxPad, backBoxH: L.boxH, backBoxW: 310 };
}

export function createPause(W, H, opts = {}) {
  const audio = opts.audio || null;
  const fx = opts.fx || null;
  const root = { open: false, menu: 'main', index: 0, notice: '' };
  const keys = {
    main: ['Resume', 'Controls', 'Options', 'Quit to Title'],
    controls: ['Back'],
    options: ['Music volume', 'SFX volume', 'Screen shake', 'Back'],
  };
  let lastRepeat = 0;
  const state = { ...opts.defaults };

  // Safe localStorage wrapper, because Orbit's sandbox can throw on access.
  function storage() { try { return localStorage; } catch (_) { return null; } }
  function loadOptions() {
    const ls = storage();
    if (!ls) return state;
    try { state.musicVolume = +(ls.getItem('pizzaPanicMusicVolume') || state.musicVolume); } catch (_) {}
    try { state.sfxVolume = +(ls.getItem('pizzaPanicSfxVolume') || state.sfxVolume); } catch (_) {}
    try { state.shakeEnabled = (ls.getItem('pizzaPanicScreenShake') ?? '1') !== '0'; } catch (_) {}
    return state;
  }
  function saveOptions() {
    const ls = storage();
    if (!ls) return;
    try { ls.setItem('pizzaPanicMusicVolume', String(state.musicVolume)); } catch (_) {}
    try { ls.setItem('pizzaPanicSfxVolume', String(state.sfxVolume)); } catch (_) {}
    try { ls.setItem('pizzaPanicScreenShake', state.shakeEnabled ? '1' : '0'); } catch (_) {}
  }
  if (!state.musicVolume && state.musicVolume !== 0) state.musicVolume = 0.82;
  if (!state.sfxVolume && state.sfxVolume !== 0) state.sfxVolume = 0.95;
  if (state.shakeEnabled === undefined) state.shakeEnabled = true;
  loadOptions();
  if (fx) fx.shakeEnabled = state.shakeEnabled;
  if (audio) { try { audio.setVolume && audio.setVolume(state.sfxVolume); } catch (_) {} }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const itemHeight = 44;

  function open(menu = 'main') {
    root.open = true;
    root.menu = menu;
    root.index = 0;
    try { audio && audio.play && audio.play('pause'); } catch (_) {}
  }
  function close() {
    root.open = false;
    root.menu = 'main';
    root.index = 0;
    saveOptions();
    try { audio && audio.play && audio.play('unpause'); } catch (_) {}
  }
  function toggle(menu) { return root.open ? (close(), false) : (open(menu), true); }
  function isOpen() { return root.open; }

  function adjust(idx, delta) {
    if (root.menu === 'options') {
      if (idx === 0) {
        state.musicVolume = clamp(Math.round((state.musicVolume + delta * 0.1) * 10) / 10, 0, 1);
        if (fx && fx.musicVolume) fx.musicVolume = state.musicVolume; // future seam
      } else if (idx === 1) {
        state.sfxVolume = clamp(Math.round((state.sfxVolume + delta * 0.1) * 10) / 10, 0, 1);
        if (audio && audio.setVolume) audio.setVolume(state.sfxVolume);
      } else if (idx === 2) {
        if (delta !== 0) state.shakeEnabled = delta > 0;
        if (fx) fx.shakeEnabled = state.shakeEnabled;
      }
      saveOptions();
    }
  }

  function activate(idx) {
    if (root.menu === 'main') {
      if (idx === 0) close();
      else if (idx === 1) root.menu = 'controls', root.index = 0;
      else if (idx === 2) root.menu = 'options', root.index = 0;
      else if (idx === 3) { root.pendingQuit = true; close(); }
    } else {
      root.menu = 'main';
      root.index = 0;
    }
  }

  function handleKey(e) {
    if (!root.open) return false;
    const code = e.code || '';
    if (code === 'ArrowUp' || code === 'KeyW') { root.index = (root.index - 1 + keys[root.menu].length) % keys[root.menu].length; root.notice = ''; return true; }
    if (code === 'ArrowDown' || code === 'KeyS') { root.index = (root.index + 1) % keys[root.menu].length; root.notice = ''; return true; }
    if (code === 'ArrowLeft' || code === 'KeyA') { adjust(root.index, -1); return true; }
    if (code === 'ArrowRight' || code === 'KeyD') { adjust(root.index, 1); return true; }
    if (code === 'Enter' || code === 'Space') {
      e.preventDefault && e.preventDefault();
      if (root.menu === 'options' && root.index === 2) state.shakeEnabled = !state.shakeEnabled, adjust(root.index, 0);
      else if (root.menu === 'options') adjust(root.index, 0);
      else activate(root.index);
      return true;
    }
    if (code === 'Escape' || code === 'KeyP') { root.menu === 'main' ? close() : (root.menu = 'main', root.index = 0); return true; }
    (e.preventDefault && e.preventDefault());
    return true;
  }

  function drawBox(ctx, x, y, w, h, col) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.82)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#ffe86b';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.restore();
  }

  // Caller may pass the game state if it wants more text; keep the contract simple.
  function draw(ctx) {
    if (!ctx || !root.open) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, W, H);
    const ix = (W - 460) / 2;
    const iy = 52;
    drawBox(ctx, ix, iy, 460, 386, '#ffe86b');
    ctx.fillStyle = '#ffe86b';
    ctx.font = 'bold 34px monospace';
    ctx.fillText(root.menu === 'main' ? 'PAUSED' : root.menu === 'controls' ? 'CONTROLS' : 'OPTIONS', W / 2, 92);

    if (root.menu === 'main') {
      keys.main.forEach((name, i) => {
        const y = 150 + i * 62;
        ctx.fillStyle = i === root.index ? '#ffffff' : '#9fb8a5';
        ctx.font = (i === root.index ? 'bold ' : '') + '22px monospace';
        ctx.fillText(name, W / 2, y);
        if (i === root.index) { ctx.strokeStyle = '#ffe86b'; ctx.lineWidth = 2; ctx.strokeRect(W / 2 - 145, y - 30, 290, 42); }
      });
      ctx.fillStyle = '#708878';
      ctx.font = '11px monospace';
      ctx.fillText('Arrow keys to choose, Enter to select, Esc to resume', W / 2, 396);
    } else if (root.menu === 'controls') {
      const lines = [
        'Move        A / D  or  Arrows   (press twice to dash)',
        'Walk lanes  W / S',
        'Jump        L',
        'Punch       J   (4-hit chain; number to finisher)',
        'Kick        K   (launcher, air juggle)',
        'Back attack J + K while facing an enemy',
        'Special     J + L   costs a little HP',
        'Grab        walk into a stunned foe; J / K / throw',
        'Shoot pizza Space   (aimed by facing; shorter throw while running)',
        'Pause       P  or  Esc',
        '',
        'RETURN on Back',
      ];
      ctx.fillStyle = '#e8f2ea';
      ctx.textAlign = 'left';
      ctx.font = '14px monospace';
      const cl = controlsLayout(lines.length);
      lines.forEach((s, i) => ctx.fillText(s, 92, cl.lineY(i)));
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffe86b';
      ctx.font = 'bold 18px monospace';
      ctx.fillText('[   BACK   ]', W / 2, 404);
    } else {
      const rows = [
        { name: keys.options[0], val: `${Math.round(state.musicVolume * 100)}%`, hint: 'Left/Right' },
        { name: keys.options[1], val: `${Math.round(state.sfxVolume * 100)}%`, hint: 'Left/Right' },
        { name: keys.options[2], val: state.shakeEnabled ? 'ON' : 'OFF', hint: 'Left/Right or Enter' },
      ];
      // One shared pitch for every element, so a row's hint can never collide with the
      // next row's label or with the Back button (they did overlap before: the last hint
      // sat at 330 and Back was drawn at 340). Layout comes from optionsLayout() so a
      // harness asserts the boxes rather than someone eyeballing a screenshot.
      const boxes = optionsLayout(rows.length);
      rows.forEach((row, i) => {
        const b = boxes.rows[i];
        ctx.fillStyle = i === root.index ? '#fff' : '#9fb8a5';
        ctx.font = (i === root.index ? 'bold ' : '') + '20px monospace';
        ctx.fillText(row.name, W / 2, b.nameY);
        ctx.fillStyle = '#ffe86b';
        ctx.font = 'bold 18px monospace';
        ctx.fillText(row.val, W / 2, b.valY);
        ctx.fillStyle = '#6b7f73';
        ctx.font = '10px monospace';
        ctx.fillText(row.hint, W / 2, b.hintY);
        if (i === root.index) { ctx.strokeStyle = '#ffe86b'; ctx.lineWidth = 2; ctx.strokeRect(W / 2 - 155, b.boxY, 310, b.boxH); }
      });
      const last = keys.options.length - 1 === root.index;
      ctx.fillStyle = last ? '#ffffff' : '#9fb8a5';
      ctx.font = (last ? 'bold ' : '') + '18px monospace';
      ctx.fillText('Back', W / 2, boxes.backY);
      if (last) { ctx.strokeStyle = '#ffe86b'; ctx.lineWidth = 2; ctx.strokeRect(W / 2 - 155, boxes.backBoxY, 310, boxes.backBoxH); }
    }
    ctx.restore();
  }

  return { open, close, toggle, isOpen, handleKey, draw, state, save: saveOptions, load: loadOptions, pendingQuit() { return root.pendingQuit; }, clearQuit() { root.pendingQuit = false; }, menu() { return root.menu; }, optionsLayout, controlsLayout };
}
