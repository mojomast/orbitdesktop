// Browser half of check-inputbuf.mjs (MR.INDIA, t_03fb1fa4bff742d5): the real page,
// every hero, on keyboard (KeyboardEvent), on a stubbed standard gamepad that
// gamepad.js polls (navigator.getGamepads), and mixed keyboard + pad.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const ROOT = process.env.PP_ROOT || new URL('../pizza-panic/', import.meta.url).pathname;
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.md': 'text/plain' };
const wait = ms => new Promise(r => setTimeout(r, ms));
// Stub pad: window.__pad.buttons[i] is flipped by the in-page driver.
const INIT = () => {
  const pad = { id: 'inputbuf-stub (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__pad = pad;
  Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
};
// In-page driver: runs one mode's checks for the current hero, returns [{name, ok, info}].
const DRIVE = async (mode) => {
  const out = [], frame = () => new Promise(r => requestAnimationFrame(r));
  const S = () => window.__ppState, Cb = () => S().combat;
  const C = await import('./combat.js'), HM = await import('./hero-moves.js');
  const keep = () => { const s = S(); s.invuln = 9; s.hp = Math.max(s.hp || 0, 500); s.hurtT = 0; s.playerDown = 0; for (const n of s.ninjas) { n.stun = Math.max(n.stun || 0, 1); } };
  const untilF = async (cond, maxF = 180) => { for (let i = 0; i < maxF; i++) { keep(); if (cond(Cb())) return true; await frame(); } return false; };
  const PAD = { punch: 2, kick: 1, jump: 0, special: 5, back: 4 }, KEY = { punch: 'KeyJ', kick: 'KeyK', jump: 'KeyL' };
  const kb = codes => { for (const code of codes) { dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true })); dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true, cancelable: true })); } };
  const tapPad = async i => { window.__pad.buttons[i] = { pressed: true, touched: true, value: 1 }; await frame(); await frame(); window.__pad.buttons[i] = { pressed: false, touched: false, value: 0 }; };
  let n = 0;
  const press = async (what) => { // what: punch | kick | jump | special | back
    const usePad = mode === 'pad' || (mode === 'mix' && (n++ % 2 === 1));
    if (usePad) return tapPad(PAD[what]);
    if (what === 'special') return kb(['KeyJ', 'KeyL']);
    if (what === 'back') return kb(['KeyJ', 'KeyK']);
    kb([KEY[what]]);
  };
  const reset = async () => { await untilF(c => c.phase === 'idle' && !c.airborne && c.chain === 0 && !c.buffer, 240); for (let i = 0; i < 3; i++) await frame(); Cb().log.length = 0; }; // combat.js caps the log at 30
  const s0 = S(); const lab = m => HM.heroMove(s0, m).label;
  const string = C.MOVES.punch.map((m, i) => lab({ ...m, chainKey: 'punch' + (i + 1) }));
  const check = async (name, fn) => { try { await reset(); const info = await fn(); out.push({ name, ok: true, info }); } catch (e) { out.push({ name, ok: false, info: String(e && e.message || e) }); } };
  for (const lead of [0.12, 0.1]) await check(`J x4 string, presses ${lead * 1000} ms before recovery ends`, async () => {
    const c = Cb(), base = c.log.length; n = 0;
    await press('punch');
    for (let k = 1; k < 4; k++) {
      if (!await untilF(c => c.log.length >= base + k && c.phase === 'rec' && c.timer <= lead && c.hitStop <= 0)) throw new Error('no recovery after hit ' + k + ' log ' + c.log.slice(base).join(','));
      await press('punch');
    }
    await untilF(c => c.log.length >= base + 4, 90); await untilF(c => c.phase === 'idle', 90);
    const got = c.log.slice(base).join(' > ');
    if (got !== string.join(' > ')) throw new Error('got ' + got + ' want ' + string.join(' > '));
    return got;
  });
  await check('L in recovery cancels into a jump', async () => {
    const c = Cb(); n = 0; await press('punch');
    if (!await untilF(c => c.phase === 'rec' && c.hitStop <= 0)) throw new Error('no rec');
    await press('jump'); if (!await untilF(c => c.airborne, 4)) throw new Error('jump did not come out');
  });
  for (const [what, mv] of [['special', 'healthSpecial'], ['back', 'backAttack']]) {
    await check(`${what} chord in recovery cancels into it`, async () => {
      const c = Cb(), base = c.log.length; n = 0; await press('punch');
      if (!await untilF(c => c.phase === 'rec' && c.hitStop <= 0)) throw new Error('no rec');
      await press(what); await untilF(c => c.log.includes(lab(C.MOVES[mv])), 30);
      // J lands first (starting the next string hit) and the chord upgrades it inside its wind.
      if (!c.log.slice(base + 1).includes(lab(C.MOVES[mv]))) throw new Error('got ' + c.log.slice(base).join(','));
      return c.log.join(' > ');
    });
    await check(`${what} chord in an active frame is buffered as the chord`, async () => {
      const c = Cb(), base = c.log.length; n = 0; await press('punch');
      if (!await untilF(c => c.phase === 'active')) throw new Error('no active');
      await press(what); await untilF(c => c.log.length > base + 1, 40);
      if (c.log[base + 1] !== lab(C.MOVES[mv])) throw new Error('got ' + c.log.slice(base).join(','));
    });
  }
  return out;
};
export async function run(t, opts = {}) {
  const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); const URL0 = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const { HEROES } = await import(ROOT + 'heroes.js');
  try {
    for (let h = 0; h < HEROES.length; h++) {
      if (process.env.PP_HERO && HEROES[h].id !== process.env.PP_HERO) continue;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      await ctx.addInitScript(INIT);
      const page = await ctx.newPage();
      page.on('console', m => { if (m.type() === 'error') errors.push(HEROES[h].id + ': ' + m.text()); });
      page.on('pageerror', e => errors.push(HEROES[h].id + ': ' + e.message));
      await page.goto(URL0 + '?coach=0&wipe=0&amb=0'); await wait(1200);
      const ev = f => page.evaluate(f).catch(() => null);
      for (let i = 0; i < 80 && !(await ev(() => window.__ppSelect && window.__ppSelect.active)); i++) { await page.keyboard.press('KeyX'); await wait(150); }
      await page.keyboard.press('Digit' + (h + 1)); await wait(150);
      await page.keyboard.press('Enter'); await wait(800);
      for (let i = 0; i < 60; i++) {
        const st = await ev(() => ({ cine: window.__ppCinema && window.__ppCinema.isActive(), sel: window.__ppSelect && window.__ppSelect.active, c: !!(window.__ppState && window.__ppState.combat) }));
        if (st && st.cine) { await page.keyboard.press('Escape'); await wait(300); continue; }
        if (st && st.sel) { await page.keyboard.press('Enter'); await wait(300); continue; }
        if (st && st.c) break; await wait(200);
      }
      await wait(600);
      const hero = await ev(() => window.__ppState.selectedHero || window.__ppState.hero);
      t(`browser ${HEROES[h].id}: hero selected`, () => { if (hero !== HEROES[h].id) throw new Error('selected ' + hero); });
      for (const mode of ['kb', 'pad', 'mix']) {
        const res = await page.evaluate(DRIVE, mode).catch(e => [{ name: 'driver', ok: false, info: e.message }]);
        for (const r of res) t(`browser ${HEROES[h].id} [${mode}]: ${r.name}`, () => { if (!r.ok) throw new Error(r.info); return r.info && mode === 'kb' && /string/.test(r.name) ? '' : ''; });
      }
      await ctx.close();
    }
    t('browser: 0 console errors', () => { if (errors.length) throw new Error(errors.length + ' errors: ' + errors.slice(0, 3).join(' | ')); });
  } finally { await browser.close(); server.close(); }
}
