// AGENT ARMEGEDDON: CLAWPOCALYPSE NOW cinematics. Drawn entirely with in-engine canvas camera work, so the
// bundle still ships only relative image files and no external assets/networking.
// Dialogue pacing (iteration 8): each line types out, then holds for
// HOLD_BASE + HOLD_PER_CHAR * length; after the last line the panel holds TAIL
// more, then fades to black (or crossfades into the next queued panel) over FADE.
// One key press finishes the line being typed, a second press advances.
import { OPTIONS } from './options-live.js';   // accessibility: text speed, reduced motion, hold-to-advance
export const PACING = { HOLD_BASE: 1.2, HOLD_PER_CHAR: 0.04, TAIL: 1.5, TAIL_READ: 0.075, FADE: 0.5, LEAD_IN: 0.35, TITLE_BEAT: 0.25 };
export const holdFor = line => PACING.HOLD_BASE + PACING.HOLD_PER_CHAR * String(line).length;
// The pause after a panel's LAST line, before it fades to the next scene. Sized to the
// reading time of that line rather than a flat number, with a floor so a short line
// still gets a beat: TAIL is that floor, and TAIL_READ is the seconds per character.
// A panel that hands over to a queued scene uses the same linger, so the next scene
// can never start while the last line is still being read.
export const lingerFor = lines => {
  const last = Array.isArray(lines) && lines.length ? String(lines[lines.length - 1]) : '';
  return Math.max(PACING.TAIL, PACING.TAIL_READ * last.length);
};
// story-v2: cover-fit. The art is scaled to FILL the screen (the larger of the two axis
// ratios) and the overflow is cropped, so no panel ever shows a black bar; the camera
// then pans inside the crop, clamped so it can never slide past an image edge.
export const coverScale = (W, H, iw, ih) => Math.max(W / Math.max(1, iw), H / Math.max(1, ih));
export function createCinematics(audio) {
  const src = {
    intro: 'assets/cine/intro.jpg', // legacy single panel, kept as a fallback
    intro1: 'assets/cine/intro_1_meeting.jpg',
    intro2: 'assets/cine/intro_2_briefing.jpg',
    intro3: 'assets/cine/intro_3_teamup.jpg',
    introDon: 'assets/cine/title/plate.jpg', // baba_booey: Don Piedro's panel (his cutout + portrait are drawn over it by don.js)
    bossEnter: 'assets/cine/boss_enter.jpg',
    bossDefeat: 'assets/cine/boss_defeat.jpg',
    ending: 'assets/cine/ending.jpg'
  };
  const img = {};
  for (const [name, url] of Object.entries(src)) {
    if (typeof Image === 'undefined') break;
    const i = new Image();
    i.onload = () => {};
    i.onerror = () => {};
    i.src = url;
    img[name] = i;
  }

  const scenes = {
    // The old 'title' card is gone: title.js runs the arcade attract sequence.
    // Story v2: ten thousand forgotten OpenClaw gateways were left running with no
    // allowlist; one of them, SHREDCLAW, installed every skill, rewrote his own SOUL.md
    // and took the rest over. The Nous crew (Teknium, Nous Girl, TurboFit) has the cure,
    // `hermes claw migrate`, but it has to run from his root gateway atop Claw Tower, so
    // they recruit the sewer turtles (and Don Piedro invites himself). play('intro') runs
    // these panels in order; skipping any panel skips the whole intro.
    intro_1: {
      typeRate: 46, img: 'intro1', fallback: 'intro', sound: 'start', accent: 'thunder', music: 'intro', duration: 6.6,
      title: 'AGENT ARMEGEDDON', lines: ['TEKNIUM: So you four are the ones who run the sewers.', 'NOUS GIRL: Shredclaw has claws in your pipes. I hear them.', 'TURTLES: The sewers are our turf. Somebody bring pizza.'],
      focus: [0.12, 0.85, 0.55],
      // One camera target per line: the pan follows whoever is speaking.
      lineFocus: [[0.12, 0.82, 0.62], [0.88, 0.62, 0.56], [0.50, 0.78, 0.50]],
      from: [0.30, 0.35], to: [0.55, 0.50], zoom: [1.0, 1.25], shake: 0.02
    },
    intro_2: {
      typeRate: 46, img: 'intro2', fallback: 'intro', sound: 'blip', accent: 'riser', music: 'intro', duration: 6.6,
      title: 'THE BRIEFING', lines: ['NOUS GIRL: His root gateway sits on top of Claw Tower.', 'TURBOFIT: We run hermes claw migrate there. Locally!', 'TURTLES: Sewers, streets, rooftops. We know the way up.'],
      focus: [0.87, 0.65, 0.45],
      lineFocus: [[0.88, 0.60, 0.52], [0.16, 0.70, 0.60], [0.50, 0.66, 0.48]],
      from: [0.55, 0.30], to: [0.45, 0.45], zoom: [1.2, 1.0], shake: 0
    },
    // baba_booey (t_9ec48322f6de4bf7): the 8th hero crashes the briefing. Lines stack, so each stays up well past
    // 2.5 s + 50 ms per character; the tail linger gives the pause after the last one.
    intro_don: {
      typeRate: 46, img: 'introDon', fallback: 'intro3', sound: 'jump', accent: 'impact', music: 'intro', duration: 6.6,
      title: 'THE FANBOY', lines: ['DON PIEDRO: Hello I Hermes biggest fanboi.', 'DON PIEDRO: Claw boss want migrate Hermes? I bring spoon.', 'TEKNIUM: ...Fine. The bear with the spoon is in.'],
      focus: [0.70, 0.60, 0.50],
      lineFocus: [[0.72, 0.62, 0.55], [0.72, 0.60, 0.55], [0.40, 0.55, 0.50]],
      from: [0.60, 0.40], to: [0.55, 0.50], zoom: [1.1, 1.2], shake: 0.02
    },
    intro_3: {
      typeRate: 46, img: 'intro3', fallback: 'intro', sound: 'start', accent: 'chime', music: 'intro', duration: 6.6,
      title: 'TEAM UP', lines: ["TEKNIUM: Eight of us. One rogue claw. Let's ship it.", 'TURTLES: Cowabunga! The claw is NOT the law!', '{HERO} leads the charge.  J punch  K kick  L jump  SPACE pizza'],
      focus: [0.12, 0.55, 0.50],
      lineFocus: [[0.18, 0.58, 0.56], [0.42, 0.70, 0.62], [0.50, 0.62, 0.52]],
      from: [0.50, 0.55], to: [0.50, 0.30], zoom: [1.3, 1.05], shake: 0.03
    },
    bossEnter: {
      img: 'bossEnter', sound: 'boss', accent: 'riser', music: 'entrance', duration: 3.6,
      title: 'SHREDCLAW', lines: ['SHREDCLAW: New shell. Same lobster. MORE CLAWS.', 'He installed every skill and rewrote his own SOUL.md.', 'Break his guard one hit at a time. Watch his health bar.'],
      from: [0.48, 0.10], to: [0.48, 0.28], zoom: [1.05, 1.45], shake: 0.08
    },
    bossDefeat: {
      img: 'bossDefeat', sound: 'over', accent: 'impact', music: 'defeat', duration: 3.8,
      title: 'SHREDCLAW DOWN', lines: ['{HERO} stands over the fallen Shredclaw.', 'Root gateway open. Running: hermes claw migrate...', 'Memories, skills, SOUL.md: every claw comes home.'],
      from: [0.45, 0.50], to: [0.22, 0.45], zoom: [1.0, 1.25], shake: 0
    },
    ending: {
      img: 'ending', sound: 'wave', accent: 'chime', music: 'ending', duration: 5.8,
      title: 'THE LAST SLICE', lines: ['Sunrise. The claws molt back into friendly helpers.', 'Even Shredclaw: new shell, much nicer lobster.', 'Press SPACE to start a new run.'],
      from: [0.81, 0.45], to: [0.30, 0.33], zoom: [1.0, 1.25], shake: 0
    }
  };

  const state = {
    active: false, scene: null, t: 0, typed: 0, queue: [],
    countdown: 0, startedAt: 0, skipped: false, hero: '',
    li: 0, ch: 0, phase: 'in', phaseT: 0, holdT: 0, prev: null, prevT: 0, fadeIn: true
  };
  const INTRO = ['intro_1', 'intro_2', 'intro_don', 'intro_3'];
  function fill(text) { return String(text).split('{HERO}').join(state.hero || 'The team'); }
  const segs = s => [s.title, ...s.lines];
  // Estimated running time of a panel at the default pacing (drives the camera move).
  function runTime(s) {
    const rate = s.typeRate || 38;
    let d = PACING.LEAD_IN + s.title.length / rate + PACING.TITLE_BEAT;
    for (const l of s.lines) d += l.length / rate + holdFor(l);
    return d + lingerFor(s.lines) + PACING.FADE;
  }

  function smoothstep(v) { return v * v * (3 - 2 * v); }
  function setLinger(s) { state.linger = lingerFor(s && s.lines); }
  function play(id, onDone) {
    if (id === 'intro') { INTRO.forEach((p, i) => play(p, i === INTRO.length - 1 ? onDone : null)); return; }
    if (scenes[id] && !state.queue.some(q => q.id === id) && (!state.active || !state.scene || state.scene.id !== id)) {
      state.queue.push({ id, onDone: onDone || null });
    }
    pump();
  }
  function pump() {
    if (state.active || !state.queue.length) return;
    const next = state.queue.shift();
    state.active = true;
    state.skipped = false;
    state.t = 0;
    state.typed = 0;
    state.blipAt = 0;
    state.li = 0; state.ch = 0; state.phase = 'in'; state.phaseT = 0; state.holdT = 0;
    { const sc = scenes[next.id]; state.fx = null; state.scene = { id: next.id, ...sc, title: fill(sc.title), lines: sc.lines.map(fill), onDone: next.onDone }; }
    state.scene.duration = runTime(state.scene);
    setLinger(state.scene);                       // readable pause before the next scene
    state.countdown = state.scene.duration;
    // A panel that follows a crossfade starts under the previous one; otherwise it fades up from black.
    state.fadeIn = !state.prev;
    if (audio) {
      audio.unlock();
      try {
        audio.play(state.scene.sound);
        if (state.scene.accent) audio.play(state.scene.accent);
        // Let the stinger read over the score, then bring the scene theme in.
        audio.duck(0.45, 1.3);
        audio.music(state.scene.music, 1.0);
      } catch { }
    }
  }
  // Escape / the skip box: skip the whole cinematic (the rest of the intro too),
  // with a short fade to black rather than a hard cut.
  function skip() {
    if (!state.active) return;
    state.skipped = true;
    if (INTRO.includes(state.scene && state.scene.id)) {
      const rest = state.queue.filter(q => INTRO.includes(q.id));
      state.queue = state.queue.filter(q => !INTRO.includes(q.id));
      const last = rest.length ? rest[rest.length - 1].onDone : null;
      if (last && !state.scene.onDone) state.scene.onDone = last;
    }
    state.prev = null;
    if (state.phase !== 'out') { state.phase = 'out'; state.phaseT = 0; state.outCross = false; }
  }
  // Any other key: finish the line being typed; if it is already shown, move on.
  function advance() {
    if (!state.active || !state.scene) return;
    const s = state.scene, all = segs(s);
    if (state.phase === 'in') { state.phase = 'type'; state.phaseT = 0; }
    if (state.phase === 'type') {
      state.ch = all[state.li].length;
      if (state.li === 0) { state.li = 1; state.ch = 0; if (all.length === 1) toTail(); }
      else { state.phase = 'hold'; state.phaseT = 0; state.holdT = OPTIONS.holdFor(all[state.li], holdFor(all[state.li])); }
      syncTyped();
      return;
    }
    if (state.phase === 'hold') { nextLine(true); return; }
    if (state.phase === 'tail') { toOut(); return; }
    if (state.phase === 'out') finish(true);
  }
  function syncTyped() {
    const all = segs(state.scene); let n = 0;
    for (let i = 0; i < state.li && i < all.length; i++) n += all[i].length;
    state.typed = n + Math.min(state.ch, (all[state.li] || '').length);
  }
  function toTail() { state.phase = 'tail'; state.phaseT = 0; }
  function toOut() { state.phase = 'out'; state.phaseT = 0; state.outCross = state.queue.length > 0; if (state.outCross) finish(true); }
  function nextLine(byKey) {
    const all = segs(state.scene);
    if (state.li < all.length - 1) { state.li++; state.ch = 0; state.phase = 'type'; state.phaseT = 0; syncTyped(); }
    else if (byKey) toOut(); else toTail();
  }
  function finish(completed) {
    if (!state.active || !state.scene) return;
    const done = completed ? state.scene.onDone : null;
    // Crossfade: keep the outgoing panel to dissolve over the next one.
    state.prev = state.outCross && state.queue.length ? { scene: state.scene, fx: state.fx, t: state.t, typed: state.typed } : null;
    state.prevT = 0; state.outCross = false;
    if (audio && state.scene.id !== 'ending' && !state.queue.length && !state.scene.onDone) { try { audio.music('sewer', 0.8); } catch { } }
    if (state.scene.id === 'ending' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('ppcinema-ending-complete'));
    }
    state.active = false;
    state.scene = null;
    state.t = 0;
    state.typed = 0;
    if (state.prev) pump(); // the next panel starts this frame under the dissolve
    if (done) setTimeout(done, 0);
    setTimeout(pump, 16);
  }
  function update(dt) {
    if (!state.active || !state.scene) return;
    const s = state.scene, all = segs(s);
    state.t += dt; state.phaseT += dt;
    if (state.prev) { state.prevT += dt; if (state.prevT >= PACING.FADE) state.prev = null; }
    if (state.phase === 'in' && state.phaseT >= PACING.LEAD_IN) { state.phase = 'type'; state.phaseT = 0; }
    if (state.phase === 'type') {
      state.ch += dt * OPTIONS.typeRate(s.typeRate || 38);
      const len = all[state.li].length;
      if (state.ch >= len) {
        state.ch = len;
        if (state.li === 0) { if (state.phaseT >= len / OPTIONS.typeRate(s.typeRate || 38) + PACING.TITLE_BEAT) { if (all.length > 1) { state.li = 1; state.ch = 0; state.phaseT = 0; } else toTail(); } }
        else { state.phase = 'hold'; state.phaseT = 0; state.holdT = OPTIONS.holdFor(all[state.li], holdFor(all[state.li])); }
      }
    } else if (state.phase === 'hold') {
      if (state.phaseT >= state.holdT) nextLine(false);
    } else if (state.phase === 'tail') {
      if (state.phaseT >= (state.linger || PACING.TAIL)) toOut();
    } else if (state.phase === 'out') {
      if (state.phaseT >= (state.skipped ? 0.35 : PACING.FADE)) finish(true);
    }
    if (!state.active) return;
    syncTyped();
    state.countdown = Math.max(0, s.duration - state.t);
    // Typewriter ticks: one blip every couple of revealed characters.
    const typedNow = Math.floor(state.typed);
    if (audio && typedNow > (state.blipAt || 0)) {
      state.blipAt = typedNow + 2;
      try { audio.play('blip'); } catch { }
    }
    // Camera focus: the panel may give one target per line, so the pan lands on
    // whoever is speaking. Previously this compared the line index against the
    // three components of a single point, which panned x toward a y value.
    if (s.focus) {
      const idx = Math.max(0, state.li - 1);
      const list = s.lineFocus && s.lineFocus.length ? s.lineFocus : [s.focus];
      const lineTarget = list[Math.min(idx, list.length - 1)];
      const target = { x: lineTarget[0], y: lineTarget[1], z: lineTarget[2] != null ? lineTarget[2] : 1 };
      if (state.cam == null) state.cam = { ...target };
      else {
        const rate = state.skipped ? 1 : Math.min(1, dt * (1 / SPEAKER_PAN_SECONDS)) * OPTIONS.motionScale;
        state.cam.x += (target.x - state.cam.x) * rate;
        state.cam.y += (target.y - state.cam.y) * rate;
        state.cam.z += (target.z - state.cam.z) * rate;
      }
      state.fx = state.cam.x;
    }
  }

  function currentFocus(s, t, fx) {
    const p = Math.min(1, t / Math.max(0.1, s.duration));
    const e = smoothstep(p);
    if (s.focus) {
      const cam = state.cam;
      const base = s.focus;
      const x = cam ? cam.x : (fx == null ? base[0] : fx);
      // A per-line focus takes over the vertical framing too; without one the panel
      // keeps its original drift, so nothing changes for single-focus panels.
      const y = cam && s.lineFocus ? cam.y : s.from[1] + (s.to[1] - s.from[1]) * e;
      const z = (cam && s.lineFocus && cam.z) ? cam.z : s.zoom[0] + (s.zoom[1] - s.zoom[0]) * e;
      // story-v2: slow Ken Burns push-in under the speaker pans, so the art never sits still.
      const kb = 1 + KEN_BURNS * e * OPTIONS.motionScale;
      return { x, y, z: z * kb, shake: s.shake * (1 - p), clamp: true };
    }
    return {
      x: s.from[0] + (s.to[0] - s.from[0]) * e,
      y: s.from[1] + (s.to[1] - s.from[1]) * e,
      z: s.zoom[0] + (s.zoom[1] - s.zoom[0]) * e,
      shake: s.shake * (1 - p)
    };
  }

  // Seconds for the camera to ease from one speaker to the next. Short enough to feel
// responsive, long enough that the pan is readable rather than a cut.
const SPEAKER_PAN_SECONDS = 0.45;
// story-v2: extra zoom a focus panel gains over its whole running time (the slow Ken Burns push).
const KEN_BURNS = 0.06;

// One panel: art with its camera move, the caption box and typed text.
  function drawScene(ctx, W, H, s, view) {
    const im = (img[s.img] && img[s.img].complete && img[s.img].naturalWidth) ? img[s.img] : img[s.fallback || s.img];
    const f = currentFocus(s, view.t, view.fx);
    if (im && im.complete && im.naturalWidth) {
      const base = coverScale(W, H, im.width, im.height); // story-v2: cover-fit (was H / height)
      const scale = base * Math.max(1, f.z);
      const dw = im.width * scale;
      const dh = im.height * scale;
      const left = (W - dw) * 0.5;
      const top = (H - dh) * 0.5;
      const focusedLeft = left + (f.x * dw);
      const focusedTop = top + (f.y * dh);
      let ox = W * 0.5 - focusedLeft + (Math.random() - 0.5) * f.shake * 18;
      let oy = H * 0.5 - focusedTop + (Math.random() - 0.5) * f.shake * 18;
      // No panel ever shows past the image edge (story-v2: every panel, not only focus-tracked ones).
      ox = Math.min(0, Math.max(W - dw, ox)); oy = Math.min(0, Math.max(H - dh, oy));
      ctx.save(); ctx.translate(ox, oy);
      ctx.drawImage(im, 0, 0, dw, dh);
      ctx.restore();
    } else {
      ctx.fillStyle = '#050814';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.font = '20px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('LOADING SCENE...', W / 2, H / 2);
      ctx.textAlign = 'left';
    }
    const typedTotal = Math.floor(view.typed);
    let used = 0;
    const titleChars = Math.max(0, Math.min(s.title.length, typedTotal - used));
    used += s.title.length;
    const lineLimits = s.lines.map(line => {
      const chars = Math.max(0, Math.min(line.length, typedTotal - used));
      used += line.length;
      return chars;
    });
    // story-v2: a soft gradient scrim under the caption instead of a solid band (no bars).
    { const g = ctx.createLinearGradient(0, H - 215, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.35, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0.72)'); ctx.fillStyle = g; ctx.fillRect(0, H - 215, W, 215); }
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffeb57';
    ctx.font = 'bold 38px monospace';
    ctx.fillText(s.title.slice(0, titleChars), W / 2, H - 144);
    // Subtitle size is an accessibility option: the dialogue lines go through
    // OPTIONS.fontFor so 'subtitle size' changes what is actually drawn, while the
    // title banner and the skip hint stay their fixed sizes on purpose.
    ctx.font = OPTIONS.fontFor(18);
    ctx.fillStyle = '#f3f7fa';
    s.lines.forEach((line, i) => {
      ctx.fillText(line.slice(0, lineLimits[i]), W / 2, H - 114 + i * 23);
    });
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.textAlign = 'left';
  }

  function draw(ctx, W, H) {
    if (!state.active || !state.scene) return;
    const s = state.scene;
    ctx.save();
    drawScene(ctx, W, H, s, { t: state.t, fx: state.fx, typed: state.typed });
    // Crossfade: the previous panel dissolves away over this one.
    if (state.prev) {
      ctx.globalAlpha = Math.max(0, 1 - state.prevT / PACING.FADE);
      drawScene(ctx, W, H, state.prev.scene, { t: state.prev.t + state.prevT, fx: state.prev.fx, typed: state.prev.typed });
      ctx.globalAlpha = 1;
    }
    // story-v2: no letterbox bars; the art fills the whole screen. The controls hints sit
    // on small translucent pills so they stay readable over any image.
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(W - 222, H - 24, 210, 18);
    ctx.fillRect(10, H - 24, 168, 18);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9bd6a3';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('ESC / click here: skip all', W - 118, H - 10);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '12px monospace';
    const lineDone = state.phase === 'hold' || state.phase === 'tail';
    ctx.fillText(lineDone ? 'any key: next' : 'any key: finish line', 16, H - 10);
    // Fade up from black at the start of a chain, down to black at the end.
    let black = 0;
    if (state.fadeIn && !state.prev) black = Math.max(black, 1 - Math.min(1, state.t / PACING.FADE));
    if (state.phase === 'out') black = Math.max(black, Math.min(1, state.phaseT / (state.skipped ? 0.35 : PACING.FADE)));
    if (black > 0) { ctx.fillStyle = `rgba(0,0,0,${black})`; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
    state.skipBox = { x: W - 220, y: H - 26, w: 205, h: 16 };
  }

  function skipBoxHit(x, y) {
    const b = state.skipBox;
    return !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }

  function clickHandler(e) {
    if (!state.active) return;
    const rect = e.target && e.target.getBoundingClientRect ? e.target.getBoundingClientRect() : null;
    const x = rect ? e.clientX - rect.left : e.offsetX;
    const y = rect ? e.clientY - rect.top : e.offsetY;
    if (skipBoxHit(x, y)) skip();
  }
  if (typeof window !== 'undefined') window.addEventListener('click', clickHandler);

  return { setHero: name => { state.hero = String(name || ''); }, play, skip, advance, update, draw, debug: () => ({ phase: state.phase, li: state.li, ch: state.ch, t: state.t, phaseT: state.phaseT, holdT: state.holdT, prev: !!state.prev, queue: state.queue.map(q => q.id) }), isActive: () => state.active, scene: () => (state.scene ? state.scene.id : null),
    // Read-only camera view and panel table, for tests and for anything that wants to
    // react to a pan or assert the pacing data.
    cam: () => (state.cam ? { ...state.cam } : null), panels: () => scenes };
}
