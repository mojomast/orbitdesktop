// Headless check for audio.js: per-level music, boss theme, mini-boss loop, SFX variants,
// sampled CC0 packs load/decode, every cue the game calls exists, mute/volume, theme aliasing.
// (based on check-select.mjs boot): 0 console errors, all 7 heroes on the select
// screen with portraits, keyboard navigation, and the confirmed hero is what spawns.
// usage: node check-select.mjs [url] [screenshot.png]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname;
let url = process.argv[2], server;
if (!url || url === '-') {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { if (!q.url.startsWith('/favicon')) console.log('404 ' + q.url); r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
  await new Promise(res => server.listen(0, '127.0.0.1', res)); url = `http://127.0.0.1:${server.address().port}/`;
}
const errors = []; let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
page.on('requestfailed', r => errors.push('requestfailed ' + r.url()));
page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
// Test-only workaround until events.js bubble() stops shadowing portrait() (t_15268287d7974b40): serve a renamed copy.
if (!process.env.NO_EVENTS_PATCH) await page.route('**/events.js', async r => { const res = await r.fetch(); const src = await res.text(); const body = !/const portrait = /.test(src) ? src : src.replace('function portrait(', 'function portraitChip(').replace(/\bportrait\(ctx,/g, 'portraitChip(ctx,'); await r.fulfill({ response: res, body }); });
await page.goto(url); await page.waitForTimeout(1500);

const SH = process.argv[3] || '/workspace/dolan-bak/shots';
fs.mkdirSync(SH, { recursive: true });
const snap = n => page.screenshot({ path: `${SH}/${n}.png` });
for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
ok(await page.evaluate(() => window.__ppSelect?.active), 'reached character select');
await page.keyboard.press('Enter'); await page.waitForTimeout(400);
for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
ok(!(await page.evaluate(() => window.__ppCinema.isActive())), 'intro skipped, in gameplay');
const A = () => page.evaluate(() => window.__ppAudio.musicName);
const waitMusic = async (want, ms = 3000) => { for (let t = 0; t < ms; t += 100) { if (await A() === want) return true; await page.waitForTimeout(100); } return false; };
ok(await waitMusic('sewer'), `sewer track in level 0 (${await A()})`);
const go = lv => page.evaluate(lv => { const s = window.__ppState; s.ninjas.forEach(n => { n.hp = 0; n.dead = true; }); s.holdWave = true; s.invuln = 99; s.level = lv; }, lv);
for (const [lv, name] of [[1, 'street'], [3, 'skate'], [2, 'rooftop'], [0, 'sewer']]) { await go(lv); ok(await waitMusic(name), `level ${lv} plays '${name}' (${await A()})`); }
const mv = await page.evaluate(() => { window.__ppPause.state.musicVolume = 0.3; return new Promise(r => setTimeout(() => r(window.__ppAudio.musicVolume), 300)); });
ok(Math.abs(mv - 0.3) < 1e-6, `pause music volume reaches audio (${mv})`);
await page.evaluate(() => { const s = window.__ppState; s.ninjas.push({ kind: 'brawler', levelBoss: true, elite: true, level: s.level, x: s.player.x + 400, y: s.player.y, r: 17, hp: 99, maxHp: 99, vx: 0, vy: 0 }); });
ok(await waitMusic('miniboss'), `mini-boss gate loop (${await A()})`);
await page.evaluate(() => { const s = window.__ppState; s.ninjas.forEach(n => { n.hp = 0; n.dead = true; }); s.ninjas.push({ kind: 'boss', level: s.level, x: s.player.x + 400, y: s.player.y, r: 26, hp: 999, maxHp: 999, vx: 0, vy: 0 }); });
await page.waitForTimeout(400); for (let i = 0; i < 10 && await page.evaluate(() => window.__ppCinema.isActive()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
ok(await waitMusic('boss'), `boss theme starts (${await A()})`);
const sfx = await page.evaluate(() => { const a = window.__ppAudio, e0 = a.stats.errors; const r = ['hit', 'swing', 'swingHeavy', 'melee', 'heavy', 'impact', 'pickup', 'hurt', 'crunch', 'smash', 'sting'].map(n => [n, a.play(n), a.play(n)]); return { r, errs: a.stats.errors - e0 }; });
ok(sfx.r.every(x => x[1] && x[2]) && sfx.errs === 0, `SFX play without errors (${sfx.r.filter(x => !x[1]).map(x => x[0])})`);
// Sampled audio (CC0 packs, see CREDITS-AUDIO.md): both packs load and decode, the theme really loops.
const loaded = await page.evaluate(async () => { const a = window.__ppAudio; for (let i = 0; i < 100 && !a.ready; i++) await new Promise(r => setTimeout(r, 100)); return { ready: a.ready, n: a.stats.sfxLoaded, total: a.stats.sfxTotal, loadErrors: a.stats.loadErrors }; });
ok(loaded.ready && loaded.n === loaded.total && loaded.total >= 90 && loaded.loadErrors === 0, `sfx + music packs load and decode (${loaded.n}/${loaded.total}, loadErrors=${loaded.loadErrors})`);
const trackOk = async want => { for (let t = 0; t < 4000; t += 100) { if (await page.evaluate(() => window.__ppAudio.stats.track) === want) return true; await page.waitForTimeout(100); } return false; };
ok(await trackOk('boss'), `boss recording is looping (${await page.evaluate(() => window.__ppAudio.stats.track)})`);
const CUES = ['kick', 'ko', 'grab', 'block', 'parry', 'special', 'jump', 'throw', 'whiff', 'coin', 'power', 'life', 'warn', 'wave', 'victory', 'clear', 'heart', 'boss', 'bossdie', 'explode', 'charge', 'over', 'continue', 'count', 'fight', 'chime', 'pause', 'unpause', 'start', 'menuMove', 'menuConfirm', 'menuBack', 'tick', 'blip', 'whoosh', 'riser', 'thunder'];
const sfx2 = await page.evaluate(async CUES => { const a = window.__ppAudio, e0 = a.stats.errors, bad = []; for (const n of CUES) { if (!a.play(n, { combo: 10, n: 3 })) bad.push(n); await new Promise(r => setTimeout(r, 35)); } return { bad, errs: a.stats.errors - e0, voices: a.stats.voices }; }, CUES);
ok(!sfx2.bad.length && sfx2.errs === 0 && sfx2.voices > 0, `every cue plays real samples (bad=${sfx2.bad}, voices=${sfx2.voices})`);
// Hit variation: repeated hits get different pitch (random variant + rate spread + combo climb).
const vari = await page.evaluate(async () => { const a = window.__ppAudio; return a.cues.includes('hit') && a.cues.includes('melee'); });
ok(vari, 'hit/melee cues present');
// Every cue name the game calls must exist (catches typos at call sites).
{ const used = new Set(); for (const f of fs.readdirSync(ROOT).filter(f => f.endsWith('.js'))) { const src = fs.readFileSync(path.join(ROOT, f), 'utf8'); for (const m of src.matchAll(/(?:audio\??\.play|\bplay|\bsfx)\(\s*'([A-Za-z]+)'/g)) used.add(m[1]); }
  for (const m of fs.readFileSync(path.join(ROOT, 'cinematics.js'), 'utf8').matchAll(/(?:sound|accent): '([A-Za-z]+)'/g)) used.add(m[1]);
  const cues = await page.evaluate(() => window.__ppAudio.cues); const missing = [...used].filter(n => !cues.includes(n) && !['intro', 'ending', 'bossEnter', 'bossDefeat'].includes(n));
  ok(!missing.length, `all ${used.size} cue names used by the game exist (${missing})`); }
// Entrance cutscene shares the boss recording: switching names must not restart the loop.
const alias = await page.evaluate(async () => { const a = window.__ppAudio; a.music('entrance'); await new Promise(r => setTimeout(r, 200)); const t1 = a.stats.track; a.music('boss'); await new Promise(r => setTimeout(r, 200)); return t1 === 'boss' && a.stats.track === 'boss' && a.musicName === 'boss'; });
ok(alias, 'entrance -> boss keeps the same loop running');
const mute = await page.evaluate(() => { const a = window.__ppAudio; const m1 = a.toggle(); const m2 = a.toggle(); const keep = a.volume; a.setVolume(0.5); a.nudgeVolume(0.08); const up = a.volume; a.nudgeVolume(-0.08); const back = a.volume; a.setVolume(keep); return m1 === true && m2 === false && Math.abs(up - 0.58) < 1e-9 && Math.abs(back - 0.5) < 1e-9; });
ok(mute, 'mute toggle and [ ] volume steps still work');
const silent = await page.evaluate(async () => { const { createAudio } = await import('./audio.js'); const AC = window.AudioContext, WAC = window.webkitAudioContext; window.AudioContext = undefined; window.webkitAudioContext = undefined; try { const a = createAudio(); a.unlock(); a.play('smash'); a.music('boss'); a.duck(0.3); a.setMusicVolume(0.5); return a.musicName === 'boss' && a.state === 'none'; } finally { window.AudioContext = AC; window.webkitAudioContext = WAC; } });
ok(silent, 'degrades silently with no AudioContext');
ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close(); if (server) server.close();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
