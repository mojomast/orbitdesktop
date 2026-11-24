// AGENT ARMEGEDDON: CLAWPOCALYPSE NOW sound: sampled music and SFX from free (CC0) packs, played through
// Web Audio. Sources, URLs and licences: CREDITS-AUDIO.md. The recordings live in
// two packs, assets/audio/sfx-pack.ogg.txt and music-pack.ogg.txt: plain Ogg Vorbis
// files laid end to end (byte ranges in audio-pack.js). The .txt suffix is only
// there because Orbit's static app server has no audio MIME types; fetch() reads
// the bytes untouched. The AudioContext is created on the first call and resumed on
// the first user gesture because browsers refuse to start audio before one.
//
// Two layers (same API as the old synth version):
//   * one-shot cues  -> audio.play(name[, opts])   (gameplay + cinematic SFX)
//   * looping themes -> audio.music(name[, fade])  (gameplay + cutscene score)
// audio.duck() pulls the music under a stinger or a line of dialogue.
import { SFX_PACK, MUSIC_PACK, SFX, MUSIC } from './audio-pack.js';

// Gameplay track per level strip (LEVEL_ORDER 0,1,3,2: sewer, street, skate, rooftop).
export const LEVEL_MUSIC = { 0: 'sewer', 1: 'street', 2: 'rooftop', 3: 'skate' };
export const levelMusic = level => LEVEL_MUSIC[level | 0] || 'sewer';
// Theme name -> recording in the music pack. Several scenes may share one recording;
// switching between two names that share it keeps the loop running (no restart).
export const THEME_TRACKS = {
  intro: 'intro', sewer: 'sewer', street: 'street', skate: 'skate', rooftop: 'rooftop',
  miniboss: 'miniboss', boss: 'boss', entrance: 'boss', defeat: 'defeat', ending: 'ending',
};

// Mix: music sits well under the effects (both are loudness-matched at build time).
const MUSIC_LEVEL = 0.34, SFX_LEVEL = 0.8;
const DIALOGUE_DUCK = 0.5;
const MAX_VOICES = 40, PER_CUE = 4, RETRIGGER_MS = 28, MAX_DECODED_TRACKS = 3;

export function createAudio() {
  let ctx = null, master = null, sfxBus = null, musicGain = null, duckGain = null;
  let muted = false, volume = 0.22, musicVol = 1;
  const buffers = Object.create(null);            // sfx key -> AudioBuffer
  const live = new Set();                          // playing one-shot sources
  const perCue = Object.create(null);              // cue -> [sources]
  const lastAt = Object.create(null);              // cue -> ms of last trigger
  const lastPick = Object.create(null);            // variant group -> last index
  const stats = { plays: 0, last: null, errors: 0, scene: null, voices: 0, capSkips: 0, ducked: false, throttled: 0,
    sfxLoaded: 0, sfxTotal: Object.keys(SFX).length, musicReady: false, track: null, loadErrors: 0 };
  // Small random pitch spread so repeated cues never sound machine-identical.
  const vary = (amt = 0.06) => 1 + (Math.random() * 2 - 1) * amt;

  function ensure() {
    if (ctx) return ctx;
    try {
      const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!Ctor) return null;
      ctx = new Ctor();
      // Gentle limiter on the master so stacked hits never clip.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8; limiter.knee.value = 6; limiter.ratio.value = 12;
      limiter.attack.value = 0.003; limiter.release.value = 0.18;
      limiter.connect(ctx.destination);
      master = ctx.createGain(); master.gain.value = muted ? 0 : volume; master.connect(limiter);
      sfxBus = ctx.createGain(); sfxBus.gain.value = SFX_LEVEL; sfxBus.connect(master);
      musicGain = ctx.createGain(); musicGain.gain.value = 0; musicGain.connect(master);
      duckGain = ctx.createGain(); duckGain.gain.value = 1; duckGain.connect(musicGain);
      loadSfx(); musicBytes();
    } catch (error) {
      stats.errors += 1;
      ctx = null;
    }
    return ctx;
  }

  // ---- loading ----
  const packUrl = rel => { try { return new URL(rel, import.meta.url).href; } catch (_) { return rel; } };
  async function fetchBytes(rel) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(packUrl(rel) + (attempt ? `?_r=${attempt}` : ''));
        if (res.ok) return await res.arrayBuffer();
      } catch (_) { /* retry below */ }
      stats.loadErrors += 1;
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
    }
    return null;
  }
  const decode = bytes => new Promise((resolve, reject) => {
    try { const p = ctx.decodeAudioData(bytes, resolve, reject); if (p && p.then) p.then(resolve, reject); } catch (e) { reject(e); }
  });
  let sfxLoading = null;
  function loadSfx() {
    if (sfxLoading || typeof fetch !== 'function') return sfxLoading;
    sfxLoading = fetchBytes(SFX_PACK).then(all => {
      if (!all || !ctx) return;
      return Promise.all(Object.entries(SFX).map(([key, [off, len]]) =>
        decode(all.slice(off, off + len)).then(b => { buffers[key] = b; stats.sfxLoaded += 1; }, () => { stats.loadErrors += 1; })));
    });
    return sfxLoading;
  }
  let musicPack = null;
  function musicBytes() {
    if (!musicPack && typeof fetch === 'function') musicPack = fetchBytes(MUSIC_PACK).then(b => { stats.musicReady = !!b; return b; });
    return musicPack || Promise.resolve(null);
  }
  const decoded = new Map(); // track -> Promise<AudioBuffer>, most recently used last
  function track(key) {
    if (decoded.has(key)) { const p = decoded.get(key); decoded.delete(key); decoded.set(key, p); return p; }
    const range = MUSIC[key];
    const p = musicBytes().then(all => (all && range && ctx ? decode(all.slice(range[0], range[0] + range[1])) : null));
    p.catch(() => { stats.loadErrors += 1; decoded.delete(key); });
    decoded.set(key, p);
    // Decoded PCM is big (~30 MB a track): keep only the newest few (never the playing one).
    for (const k of [...decoded.keys()]) {
      if (decoded.size <= MAX_DECODED_TRACKS) break;
      if (k !== activeKey && k !== key) decoded.delete(k);
    }
    return p;
  }

  // ---- one-shots ----
  // One layer: a sample (or a random variant from a list) with pitch, gain and timing.
  // rate: base playback rate; v: random rate spread; g: gain; at: delay (s);
  // dur: hard cut with a short fade; ramp: [fromRate, toRate] over dur; swell: fade in over dur.
  function layer(cue, keys, { rate = 1, v = 0.06, g = 1, at = 0, dur = 0, ramp = null, swell = false } = {}) {
    const list = Array.isArray(keys) ? keys : [keys];
    let i = (Math.random() * list.length) | 0;
    const gid = list.join('|');
    if (list.length > 1 && i === lastPick[gid]) i = (i + 1) % list.length; // never the same variant twice running
    lastPick[gid] = i;
    const buf = buffers[list[i]];
    if (!buf || !ctx) return;
    if (live.size >= MAX_VOICES) { stats.capSkips += 1; return; }
    const t0 = ctx.currentTime + at;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const r = Math.max(0.25, rate * vary(v));
    if (ramp) { src.playbackRate.setValueAtTime(ramp[0], t0); src.playbackRate.exponentialRampToValueAtTime(ramp[1], t0 + (dur || buf.duration)); }
    else src.playbackRate.value = r;
    const env = ctx.createGain();
    const gain = g * (1 + (Math.random() * 2 - 1) * 0.08);
    if (swell) { env.gain.setValueAtTime(0.0001, t0); env.gain.exponentialRampToValueAtTime(gain, t0 + (dur || buf.duration) * 0.92); }
    else env.gain.setValueAtTime(gain, t0);
    src.connect(env).connect(sfxBus);
    if (dur) { env.gain.setValueAtTime(gain, t0 + Math.max(0, dur - 0.06)); env.gain.linearRampToValueAtTime(0.0001, t0 + dur); src.start(t0); src.stop(t0 + dur + 0.02); }
    else src.start(t0);
    // Per-cue polyphony: a fast flurry steals its own oldest voice instead of piling up.
    const mine = perCue[cue] || (perCue[cue] = []);
    mine.push(src);
    if (mine.length > PER_CUE) { const old = mine.shift(); try { old.stop(); } catch (_) {} }
    live.add(src); stats.voices = live.size;
    src.onended = () => { live.delete(src); stats.voices = live.size; const k = mine.indexOf(src); if (k >= 0) mine.splice(k, 1); try { env.disconnect(); } catch (_) {} };
  }
  const N = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i);
  const SWING = N('swing', 5), SWING_H = N('swingH', 3), WHIFF = N('whiff', 2), THROW = N('throw', 3);
  const PUNCH_M = N('punchM', 5), PUNCH_H = N('punchH', 5), TAP = N('tap', 5), THUD = N('thud', 5), SOFT = N('soft', 3);
  const BLOCK = N('block', 3), PARRY = N('parry', 2), WOOD = N('wood', 3), WOOD_H = N('woodH', 2), GLASS = N('glass', 3);
  const GRAB = N('grab', 2), BOOM = N('boom', 2), ROAR = N('roar', 2), COIN = N('coin', 2), JUMP = N('jump', 2), MOVE = N('move', 2);

  const sounds = {
    // ---- melee: swings, connects, landings and hops ----
    swing: c => layer(c, SWING, { v: 0.09, g: 0.7 }),
    swingHeavy: c => layer(c, SWING_H, { rate: 0.9, v: 0.07, g: 0.85 }),
    kick: c => layer(c, SWING_H, { rate: 1.05, v: 0.08, g: 0.8 }),
    whiff: c => layer(c, WHIFF, { v: 0.1, g: 0.55 }),
    throw: c => layer(c, THROW, { rate: 1.1, v: 0.1, g: 0.65 }),
    // Light connect / heavy connect (heavy is layered on top of melee by combat).
    melee: c => layer(c, PUNCH_M, { v: 0.08, g: 0.9 }),
    heavy: c => layer(c, PUNCH_H, { v: 0.07, g: 1 }),
    // Score accent; opts.combo bends it upward so a streak audibly climbs, and the
    // announcer calls every 10th hit of a combo.
    hit: (c, opts) => {
      const combo = Math.min(30, Math.max(1, Number(opts && opts.combo) || 1));
      layer(c, TAP, { rate: 1 + (Math.min(12, combo) - 1) * 0.045, v: 0.03, g: 0.5 });
      if (combo >= 10 && combo % 10 === 0) layer('vo', 'voCombo', { v: 0, g: 0.8, at: 0.05 });
    },
    // Enemy knocked out: a heavier crack plus body drop.
    ko: c => { layer(c, PUNCH_H, { rate: 0.8, v: 0.06, g: 0.85 }); layer(c, THUD, { rate: 0.7, at: 0.04, g: 0.6 }); },
    grab: c => { layer(c, GRAB, { v: 0.08, g: 0.8 }); layer(c, SOFT, { rate: 1.1, g: 0.5 }); },
    block: c => layer(c, BLOCK, { v: 0.08, g: 0.75 }),
    parry: c => layer(c, PARRY, { rate: 1.1, v: 0.05, g: 0.7 }),
    special: c => { layer(c, 'special', { v: 0.04, g: 0.9 }); layer(c, 'special2', { v: 0.03, g: 0.55 }); layer(c, SWING_H, { rate: 0.8, g: 0.8 }); },
    jump: c => layer(c, JUMP, { v: 0.05, g: 0.55 }),
    hurt: c => { layer(c, THUD, { rate: 0.85, v: 0.08, g: 0.85 }); layer(c, 'ouch', { v: 0.06, g: 0.45 }); },
    // ---- pickups ----
    pickup: c => layer(c, COIN, { v: 0.05, g: 0.65 }),
    coin: c => layer(c, COIN, { rate: 1.06, v: 0.05, g: 0.65 }),
    power: c => { layer(c, 'power', { v: 0.02, g: 0.75 }); layer(c, 'gem', { at: 0.05, v: 0.03, g: 0.45 }); },
    life: c => layer(c, 'jLife', { v: 0, g: 0.8 }),
    // ---- alerts & stingers ----
    warn: c => layer(c, 'error', { v: 0.02, g: 0.75 }),
    wave: c => layer(c, 'jWave', { v: 0, g: 0.75 }),
    victory: c => layer(c, 'jVictory', { v: 0, g: 0.8 }),
    clear: c => { layer(c, 'jClear', { v: 0, g: 0.85 }); layer('vo', 'voWin', { at: 0.55, v: 0, g: 0.85 }); },
    heart: c => { layer(c, SOFT, { rate: 0.5, v: 0.02, g: 0.5 }); layer(c, SOFT, { rate: 0.47, v: 0.02, g: 0.36, at: 0.22 }); },
    boss: c => { layer(c, ROAR, { rate: 0.75, v: 0.05, g: 0.85 }); layer(c, 'rumbleS', { g: 0.55 }); },
    bossdie: c => { layer(c, 'bigBoom', { v: 0.03, g: 0.95 }); layer(c, 'rumble', { rate: 0.8, at: 0.05, g: 0.75 }); layer(c, ROAR, { rate: 0.6, at: 0.1, g: 0.5 }); },
    explode: c => layer(c, BOOM, { v: 0.08, g: 0.8 }),
    charge: c => layer(c, 'charge', { v: 0.05, g: 0.6, dur: 0.7 }),
    over: c => { layer(c, 'jOver', { v: 0, g: 0.85 }); layer('vo', 'voGameOver', { at: 1.0, v: 0, g: 0.9 }); },
    continue: c => layer(c, 'jContinue', { v: 0, g: 0.85 }),
    // Continue countdown announcer: opts.n = 1..10.
    count: (c, opts) => { const n = Math.min(10, Math.max(1, Math.round(Number(opts && opts.n) || 1))); layer('vo', 'vo' + n, { v: 0, g: 0.85 }); },
    fight: c => layer('vo', 'voFight', { v: 0, g: 0.9 }),
    sting: c => layer(c, 'jSting', { v: 0, g: 0.85 }),
    chime: c => layer(c, 'jChime', { v: 0, g: 0.6 }),
    // ---- menus ----
    pause: c => layer(c, 'open', { v: 0, g: 0.7 }),
    unpause: c => layer(c, 'close', { v: 0, g: 0.7 }),
    start: c => layer(c, 'confirm', { v: 0, g: 0.75 }),
    menuMove: c => layer(c, MOVE, { v: 0.03, g: 0.65 }),
    menuConfirm: c => layer(c, 'confirm', { v: 0, g: 0.75 }),
    menuBack: c => layer(c, 'back', { v: 0, g: 0.7 }),
    tick: c => layer(c, 'tick', { v: 0.05, g: 0.55 }),
    blip: c => layer(c, 'blip', { v: 0.12, g: 0.45 }),
    // ---- cinematic SFX: the vocabulary a cutscene timeline needs ----
    whoosh: c => { layer(c, SWING_H, { rate: 0.5, v: 0.05, g: 0.9 }); layer(c, 'hiss', { rate: 0.8, g: 0.22, dur: 0.7 }); },
    impact: c => { layer(c, THUD, { rate: 0.8, v: 0.08, g: 0.9 }); layer(c, 'rumbleS', { rate: 1.2, g: 0.3 }); },
    crunch: c => layer(c, WOOD, { v: 0.12, g: 0.75 }),
    smash: c => { layer(c, GLASS, { v: 0.08, g: 0.75 }); layer(c, WOOD_H, { rate: 0.9, v: 0.06, g: 0.7 }); },
    riser: c => { layer(c, 'hiss', { ramp: [0.45, 1.6], dur: 1.9, swell: true, g: 0.55 }); layer(c, 'charge', { rate: 0.7, at: 1.0, g: 0.35, dur: 0.9 }); },
    thunder: c => { layer(c, 'rumble', { rate: 0.6, v: 0.05, g: 0.95 }); layer(c, 'rumbleS', { rate: 0.5, at: 0.15, g: 0.55 }); },
  };

  // ---- music ----
  let musicTheme = null, activeKey = null, current = null, musicToken = 0, duckTimer = null;
  function fadeOutCurrent(f) {
    if (!current) return;
    const { src, bus } = current, now = ctx.currentTime;
    try {
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(0, now + f);
      src.stop(now + f + 0.05);
    } catch (_) {}
    setTimeout(() => { try { bus.disconnect(); } catch (_) {} }, (f + 0.3) * 1000);
    current = null;
  }
  function startTrack(key, f) {
    const token = ++musicToken;
    track(key).then(buf => {
      if (token !== musicToken || !buf || !ctx || activeKey !== key) return;
      const now = ctx.currentTime;
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0.0001, now);
      bus.gain.linearRampToValueAtTime(1, now + f);
      bus.connect(duckGain);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      src.connect(bus); src.start(now);
      current = { key, src, bus }; stats.track = key;
    }).catch(() => { stats.errors += 1; });
  }
  function setMusic(name, fade = 0.5) {
    const next = name && THEME_TRACKS[name] ? name : null;
    const c = ensure();
    // No AudioContext (headless/old browser): remember the choice, stay silent.
    if (!c) { musicTheme = next; stats.scene = next; return musicTheme; }
    if (next === musicTheme) return musicTheme;
    musicTheme = next;
    stats.scene = next;
    stats.last = next ? `music:${next}` : 'music:off';
    const key = next ? THEME_TRACKS[next] : null, f = Math.max(0.05, fade), now = c.currentTime;
    try {
      musicGain.gain.cancelScheduledValues(now);
      musicGain.gain.setValueAtTime(musicGain.gain.value, now);
      musicGain.gain.linearRampToValueAtTime(muted ? 0 : MUSIC_LEVEL * musicVol, now + 0.05);
      if (key && key === activeKey) return musicTheme; // same recording under another name: keep looping
      // Crossfade: the old loop fades out while the new one fades in on a fresh bus.
      fadeOutCurrent(f);
      activeKey = key;
      if (key) startTrack(key, f); else musicToken += 1;
    } catch (error) { stats.errors += 1; }
    return musicTheme;
  }

  function duck(level = 0.3, seconds = 1.2) {
    const c = ensure();
    if (!c || !duckGain) return level;
    const target = Math.min(1, Math.max(0, level));
    duckGain.gain.cancelScheduledValues(c.currentTime);
    duckGain.gain.setValueAtTime(duckGain.gain.value, c.currentTime);
    duckGain.gain.linearRampToValueAtTime(target, c.currentTime + 0.12);
    if (duckTimer) clearTimeout(duckTimer);
    duckTimer = null;
    if (seconds > 0) duckTimer = setTimeout(() => {
      if (!ctx || !duckGain) return;
      duckGain.gain.cancelScheduledValues(ctx.currentTime);
      duckGain.gain.setValueAtTime(duckGain.gain.value, ctx.currentTime);
      duckGain.gain.linearRampToValueAtTime(duckedNow ? DIALOGUE_DUCK : 1, ctx.currentTime + 0.25); // stay under a dialogue line
    }, seconds * 1000);
    return target;
  }

  // Per-frame: hold the music down while a cutscene or a dialogue line is up.
  let duckedNow = false, resumeAt = -1e9;
  function update(dt, state) {
    if (!state) return;
    let dialogue = false;
    try { dialogue = !!(state.cinema && state.cinema.isActive && state.cinema.isActive()); } catch (_) { dialogue = false; }
    if (state.events) {
      try { if (state.events.line || (Array.isArray(state.events.barks) && state.events.barks.length)) dialogue = true; } catch (_) {}
    }
    stats.ducked = dialogue;
    if (dialogue !== duckedNow) { duckedNow = dialogue; if (dialogue) duck(DIALOGUE_DUCK, 0); else if (musicTheme) duck(1, 0); }
  }

  return {
    stats,
    cues: Object.keys(sounds),
    get muted() { return muted; },
    get volume() { return volume; },
    get musicName() { return musicTheme; },
    get musicVolume() { return musicVol; },
    get ready() { return stats.sfxLoaded === stats.sfxTotal && stats.musicReady; },
    update,
    // Pause menu "Music volume" (0..1); scales the score only, SFX stay on setVolume.
    setMusicVolume(level) {
      const v = Math.min(1, Math.max(0, Number(level)));
      if (!Number.isFinite(v) || v === musicVol) return musicVol;
      musicVol = v;
      if (musicGain && ctx && !muted) musicGain.gain.setTargetAtTime(musicTheme ? MUSIC_LEVEL * musicVol : 0, ctx.currentTime, 0.05);
      return musicVol;
    },
    // Resume on the first key press; browsers keep the context suspended until then.
    unlock() {
      const c = ensure();
      if (!c) return false;
      if (c.state === 'suspended') { resumeAt = typeof performance !== 'undefined' ? performance.now() : Date.now(); c.resume().catch(() => { stats.errors += 1; }); }
      return true;
    },
    // Returns true when the cue exists (even if its samples are still loading).
    play(name, opts) {
      const sound = sounds[name];
      if (!sound) return false;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - (lastAt[name] || -1e9) < RETRIGGER_MS) { stats.throttled += 1; return true; }
      lastAt[name] = now;
      const c = ensure();
      // While the context is still locked (no gesture yet) one-shots would queue up at a
      // frozen clock and all fire on unlock, so drop them, except right after unlock().
      const canPlay = c && (c.state === 'running' || now - resumeAt < 800);
      if (c && !muted && canPlay) { try { sound(name, opts); } catch (error) { stats.errors += 1; return false; } }
      stats.plays += 1; stats.last = name;
      return true;
    },
    // Switch the looping score. null (or an unknown name) fades out; the same
    // name is a no-op, so a scene can call it every frame.
    music(name, fade = 0.5) { return setMusic(name, fade); },
    // Dip the music around a stinger or a line of type: duck(0.25) pulls it
    // down, duck(1) restores it; the second argument auto-restores after N secs.
    duck,
    setVolume(level) {
      volume = Math.min(1, Math.max(0, Number(level) || 0));
      if (master) master.gain.value = muted ? 0 : volume;
      return volume;
    },
    toggle() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : volume;
      if (musicGain && ctx) musicGain.gain.setTargetAtTime(muted ? 0 : (musicTheme ? MUSIC_LEVEL * musicVol : 0), ctx.currentTime, 0.05);
      stats.last = muted ? 'muted' : 'unmuted';
      return muted;
    },
    // ] / [ step the volume; stepping up out of a mute makes the change audible.
    nudgeVolume(delta) {
      volume = Math.min(1, Math.max(0, Math.round((volume + delta) * 100) / 100));
      if (volume > 0 && muted) { muted = false; if (musicGain && ctx) musicGain.gain.setTargetAtTime(musicTheme ? MUSIC_LEVEL * musicVol : 0, ctx.currentTime, 0.05); }
      if (master) master.gain.value = muted ? 0 : volume;
      stats.last = 'volume';
      return volume;
    },
    get state() { return ctx ? ctx.state : 'none'; },
  };
}
