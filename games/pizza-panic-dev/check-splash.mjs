// check-splash: boss intro splash cards (baba_booey, t_0577948bb62442f8).
//  - assets: a transparent PNG per boss id under assets/bosses/splash/ (every id in
//    boss.js BOSSES + MINI_BOSSES, harbor-data, arcade-data, subway-data), lean, keyed
//    clean (no magenta left) without eating the purple (SHREDCLAW, the conductor's lantern)
//  - boss.js: adopting a boss starts a card with its name + title; it slides in, holds,
//    slides out; ENTER / the first hit skips it; Reduced motion -> a static fade
//  - in the game: real gate spawns show the card (image loaded) on several levels, it
//    waits out the bossEnter cinematic, ENTER skips it, no console errors
// usage: node check-splash.mjs [shots dir]
import fs from 'node:fs'; import path from 'node:path'; import http from 'node:http'; import { createRequire } from 'node:module'; import { execFileSync } from 'node:child_process';
const require = createRequire('/home/box/orbitdesktop/package.json'); const { chromium } = require('playwright-core');
const ROOT = new URL('../pizza-panic/', import.meta.url).pathname, SH = process.argv[2] || '/workspace/pizza-splash';
const PY = '/workspace/pizza-victory/venv/bin/python';
let pass = 0, fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
globalThis.window = globalThis.window || { addEventListener() {}, dispatchEvent() { return true; } };
globalThis.CustomEvent = globalThis.CustomEvent || class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const L = await import(ROOT + 'logic.js'), C = await import(ROOT + 'combat.js'), E = await import(ROOT + 'events.js'), B = await import(ROOT + 'boss.js');
const O = (await import(ROOT + 'options-live.js')).OPTIONS;
// ---- assets ---------------------------------------------------------------
const ids = [...new Set([...Object.values(B.BOSSES), ...Object.values(B.MINI_BOSSES)].map(d => d.id))].sort();
ok(JSON.stringify([...B.SPLASH_IDS].sort()) === JSON.stringify(ids), `a splash id for every boss id (${ids.join(', ')})`);
ok(['enforcer', 'bruiser', 'rider', 'skytalon', 'shredclaw', 'conductor', 'hookclaw', 'highscore', 'mech'].every(i => ids.includes(i)), 'existing boss ids unchanged (keys kept)');
const DIR = path.join(ROOT, B.SPLASH_DIR), meta = JSON.parse(fs.readFileSync(path.join(DIR, 'splash.json'), 'utf8'));
const stats = JSON.parse(execFileSync(PY, ['-c', `
import sys,json; import numpy as np; from PIL import Image
out={}
for i in sys.argv[2:]:
    im=Image.open(sys.argv[1]+i+'.png'); mode=im.mode; a=np.asarray(im.convert('RGBA')).astype(int); r,g,b,al=a[...,0],a[...,1],a[...,2],a[...,3]
    mag=int(((al>40)&(r>200)&(g<60)&(b>100)&(b<215)&(r>b)).sum()); purple=int(((al>200)&(b>r)&(b>120)&(g<90)).sum())
    h,w=al.shape; corners=int(max(al[0,0],al[0,-1],al[3,3],al[3,-4])); clear=float((al==0).mean()); edge=float((al[0]>0).mean())
    out[i]=dict(w=w,h=h,mode=mode,mag=mag,purple=purple,corners=corners,clear=clear,top=edge)
print(json.dumps(out))`, DIR, ...ids]).toString());
let total = 0;
for (const i of ids) {
  const f = path.join(DIR, i + '.png'), st = stats[i], kb = fs.statSync(f).size / 1024; total += kb;
  ok(kb < 120 && st.w === 512 && st.h >= 280 && st.h <= 420 && meta[i] && meta[i].w === st.w && meta[i].h === st.h,
    `${i}.png: ${st.w}x${st.h}, ${kb.toFixed(1)} KB (< 120), listed in splash.json`);
  ok(st.corners === 0 && st.clear > 0.15 && st.top > 0 && st.mag < 60, `${i}: transparent background (${(st.clear * 100).toFixed(0)}% clear), trimmed, ${st.mag} magenta px left`);
}
ok(stats.shredclaw.purple > 5000 && stats.conductor.purple > 1500, `purple kept: SHREDCLAW ${stats.shredclaw.purple} px, conductor lantern ${stats.conductor.purple} px`);
ok(total < 1000, `all cards ${total.toFixed(0)} KB total`);
// ---- boss.js unit --------------------------------------------------------
const mockCtx = () => { const calls = []; return new Proxy({ calls }, { get(o, k) { if (k in o) return o[k]; if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} }); if (k === 'measureText') return s => ({ width: String(s).length * 22 }); return (...a) => { calls.push([k, a]); }; }, set(o, k, v) { o[k] = v; return true; } }); };
function spawnGate(level, pick = g => g[g.length - 1]) {
  const s = L.createState(); s.hpMode = true; s.level = level; s.wave = L.LEVEL_ORDER.indexOf(level) + 1; C.createCombat(s); E.ensureEvents(s);
  s.walkLevel = true; s.holdWave = true;
  const gates = E.TRIGGERS.filter(x => x.level === level && x.event === 'gate'), gate = pick(gates);
  for (const tr of E.TRIGGERS.filter(x => x.level === level && x !== gate)) s.events.fired[tr.level + ':' + tr.x] = true;
  s.player.x = gate.x + 5; s.player.y = L.LEVELS[level].walkables[0].y + 40; E.stepEvents(s, 1 / 60);
  return s;
}
const T = B.SPLASH_TIME, TOT = T.in + T.hold + T.out;
{
  const s = spawnGate(0), bosses = B.createBosses({}); bosses.step(s, 1 / 60);
  const c = bosses.splash(s);
  ok(c && c.id === 'enforcer' && c.name === 'SEWER ENFORCER' && c.title === B.BOSSES[0].title, 'adopting the sewer gate boss starts the SEWER ENFORCER card with its title');
  const ctx = mockCtx(); bosses.drawHud(ctx, s, 1 / 60, 740, 510);
  const texts = ctx.calls.filter(([k]) => k === 'fillText').map(([, a]) => a[0]);
  ok(texts.includes('SEWER ENFORCER') && texts.includes(B.BOSSES[0].title) && c.drawn && c.drawn.dx > 300, `card drawn with name + title, sliding in from the right (dx ${c.drawn.dx})`);
  ok(T.in <= 0.5 && TOT >= 2 && TOT <= 3, `short: ${T.in}s in, ${T.hold}s hold, ${T.out}s out`);
  for (let i = 0; i < 60 * (T.in + 0.3); i++) bosses.step(s, 1 / 60);
  bosses.drawHud(mockCtx(), s, 1 / 60, 740, 510);
  ok(bosses.splash(s).drawn.dx === 0 && bosses.splash(s).drawn.alpha === 1, 'holds in place, fully opaque');
  for (let i = 0; i < 60 * TOT; i++) bosses.step(s, 1 / 60);
  ok(!bosses.splash(s), 'gone after the slide-out; the fight carries on');
  const ctx2 = mockCtx(); bosses.drawHud(ctx2, s, 1 / 60, 740, 510);
  ok(!ctx2.calls.some(([k, a]) => k === 'fillText' && a[0] === 'ENTER skip') && ctx2.calls.some(([k, a]) => k === 'fillText' && a[0] === 'SEWER ENFORCER'), 'boss bar still drawn, card not');
}
{
  const s = spawnGate(5), bosses = B.createBosses({}); bosses.step(s, 1 / 60);
  ok(bosses.splash(s)?.id === 'conductor', 'subway gate -> THE CONDUCTOR card');
  ok(bosses.skipSplash(s) && bosses.splash(s).t >= T.in + T.hold, 'skipSplash jumps to the slide-out');
  for (let i = 0; i < 60 * (T.out + 0.05); i++) bosses.step(s, 1 / 60); ok(!bosses.splash(s), 'skipped card clears within the slide-out');
}
{
  const s = spawnGate(6), bosses = B.createBosses({}); bosses.step(s, 1 / 60);
  ok(bosses.splash(s)?.id === 'hookclaw', 'harbor gate -> CAPTAIN HOOKCLAW card (harbor-data id)');
  const n = s.ninjas.find(m => m.__boss); for (let i = 0; i < 40; i++) bosses.step(s, 1 / 60);
  n.hp -= 3; bosses.step(s, 1 / 60);
  ok(bosses.splash(s) && bosses.splash(s).skipped, 'the first hit on the boss skips the card');
}
{
  const s = spawnGate(7), bosses = B.createBosses({}); bosses.step(s, 1 / 60); ok(bosses.splash(s)?.id === 'highscore', 'arcade gate -> HIGH SCORE card (arcade-data id)');
  const m = spawnGate(4, g => g.find(x => x.boss && x.boss.name === 'CLAW WALKER')), bm = B.createBosses({}); bm.step(m, 1 / 60); ok(bm.splash(m)?.id === 'mech', 'tower lobby gate -> CLAW WALKER card');
  const f = spawnGate(4), bf = B.createBosses({}); bf.step(f, 1 / 60); ok(bf.splash(f)?.id === 'shredclaw' && bf.splash(f).final, 'tower top -> SHREDCLAW card, marked FINAL BOSS (still the final boss)');
  ok(B.BOSSES[4].id === 'shredclaw' && B.BOSSES[4].final, 'SHREDCLAW stays the final boss');
}
{
  const was = O.reducedMotion; O.set('reducedMotion', true);
  const s = spawnGate(1), bosses = B.createBosses({}); bosses.step(s, 1 / 60);
  let seen = []; for (let i = 0; i < 60 * TOT; i++) { bosses.step(s, 1 / 60); const c = bosses.splash(s); if (!c) break; bosses.drawHud(mockCtx(), s, 1 / 60, 740, 510); seen.push(c.drawn); }
  ok(seen.length > 60 && seen.every(d => d.dx === 0 && d.reduced) && seen[2].alpha < 0.5 && Math.max(...seen.map(d => d.alpha)) === 1, `Reduced motion: no slide (dx 0 in all ${seen.length} frames), a static fade in/out`);
  O.set('reducedMotion', was);
}
// ---- in the game ---------------------------------------------------------
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const errors = []; let phase = 'boot';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
page.on('console', m => { if (m.type() === 'error') errors.push(`[${phase}] ` + m.text().split('\n')[0]); });
page.on('pageerror', e => errors.push(`[${phase}] ` + String(e).split('\n')[0]));
page.on('response', r => { if (r.status() >= 400) errors.push(`[${phase}] HTTP ${r.status()} ${r.url()}`); });
await page.addInitScript(() => { try { localStorage.setItem('pizzaPanicCoachDone', '1'); localStorage.removeItem('pizzaPanicOptions'); } catch (_) {} });
fs.mkdirSync(SH, { recursive: true });
const clear = async () => { for (let i = 0, idle = 0; i < 40 && idle < 3; i++) {
  const w = await page.evaluate(() => { const b = window.__ppBonus; if (b && b.active()) { try { b.close(); } catch (_) {} return 'bonus'; } const sh = window.__ppShop; if (sh && sh.active()) { try { sh.leave(); } catch (_) {} return 'shop'; }
    if (window.__ppPause?.isOpen?.()) { window.__ppPause.close(); return 'pause'; } if (window.__ppScreens?.active?.()) return 'screen'; if (window.__ppCinema?.isActive?.()) return 'cine'; return null; });
  if (w === 'screen') await page.keyboard.press('Enter'); else if (w === 'cine') await page.keyboard.press('Escape'); idle = w ? 0 : idle + 1; await page.waitForTimeout(150); } };
const spawn = (lv, which) => page.evaluate(async ([lv, which]) => {
  const E = await import('./events.js'), L = await import('./logic.js'), s = window.__ppState;
  s.level = lv; s.wave = L.LEVEL_ORDER.indexOf(lv) + 1; s.ninjas = []; s.invuln = 999; s.hp = s.maxHp; s.walkLevel = true; s.holdWave = true; s.bossFight = null; s.bossBar = null;
  const gates = E.TRIGGERS.filter(x => x.level === lv && x.event === 'gate'), gate = which ? gates.find(g => g.boss && g.boss.name === which) : gates[gates.length - 1];
  for (const tr of E.TRIGGERS) if (tr.level === lv) s.events.fired[tr.level + ':' + tr.x] = tr !== gate; delete s.events.fired[gate.level + ':' + gate.x];
  s.events.lock = null; s.events.camX = null; s.events.cooldown = 0; s.player.x = gate.x + 5; s.player.y = L.LEVELS[lv].walkables[0].y + 40;
  return gate.x; }, [lv, which || null]);
const overlay = () => page.evaluate(() => !!(window.__ppShop?.active?.() || window.__ppBonus?.active?.() || window.__ppScreens?.active?.() || window.__ppCinema?.isActive?.() || window.__ppPause?.isOpen?.()));
// switching s.level can raise the stage-clear / shop flow: settle that first, then fire the gate
const go = async (lv, which) => {
  for (let k = 0; k < 4; k++) {
    // park the hero at the level start first: an emptied gate next to the exit would end the stage
    await page.evaluate(lv => { const s = window.__ppState; s.ninjas = []; s.events.lock = null; s.player.x = 200; s.level = lv; s.holdWave = true; s.invuln = 999; s.bossFight = null; }, lv);
    await page.waitForTimeout(700); await clear(); await page.waitForTimeout(300);
    if ((await overlay()) || (await page.evaluate(() => window.__ppState.level)) !== lv) continue;
    // a gate fired on a jumped-to level can still raise that level's stage flow once: retry until the card runs
    await spawn(lv, which); await page.waitForTimeout(300);
    if ((await overlay()) || (await page.evaluate(() => window.__ppState.level)) !== lv) { await clear(); continue; }
    return true;
  }
  return false;
};
const card = () => page.evaluate(() => { const c = window.__ppBoss.splash(window.__ppState); return c ? { id: c.id, t: c.t, skipped: c.skipped, drawn: c.drawn || null } : null; });
const waitCard = async (pred, ms = 6000) => { const t0 = Date.now(); let c = null; while (Date.now() - t0 < ms) { c = await card(); if (pred(c)) return c; await page.waitForTimeout(40); } return c; };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForTimeout(1200);
  for (let i = 0; i < 80 && !(await page.evaluate(() => window.__ppSelect?.active)); i++) { await page.keyboard.press('KeyX'); await page.waitForTimeout(150); }
  await page.keyboard.press('Enter'); await page.waitForTimeout(400); await clear();
  await page.waitForTimeout(300); const loaded = await page.evaluate(() => window.__ppBoss.splashLoaded());
  ok(loaded.length === B.SPLASH_IDS.length, `the game preloads all ${loaded.length}/${B.SPLASH_IDS.length} splash cards`);
  const SHOTS = [[0, null, 'enforcer'], [5, null, 'conductor'], [6, null, 'hookclaw'], [4, 'CLAW WALKER', 'mech'], [7, null, 'highscore'], [1, null, 'bruiser']];
  for (const [lv, which, id] of SHOTS) {
    phase = id; await clear(); await go(lv, which);
    const c = await waitCard(c => c && c.id === id && c.t > T.in + 0.25 && c.drawn && c.drawn.img);
    const f = `${SH}/intro-${id}.png`; if (c && c.id === id) await page.screenshot({ path: f });
    if (!(c && c.id === id && c.drawn && c.drawn.img && c.drawn.dx === 0)) console.log('   debug', id, JSON.stringify(c), JSON.stringify(await page.evaluate(() => { const s = window.__ppState; return { level: s.level, boss: s.bossFight && s.bossFight.active && s.bossFight.active.def.id, ninjas: s.ninjas.map(n => n.kind + (n.levelBoss ? '*' : '') + (n.name ? ':' + n.name : '')), lock: !!s.events.lock, px: Math.round(s.player.x) }; })));
    ok(c && c.id === id && c.drawn.img && c.drawn.dx === 0, `${id}: the real gate spawn shows its card in game, image drawn (${f})`);
    if (id === 'enforcer') { const m = await waitCard(c => c && c.t > 0.05 && c.t < T.in - 0.1, 50); }
  }
  { // slide-in frame + ENTER skip
    phase = 'skip'; await clear(); await go(2);
    await page.evaluate(() => { const c = window.__ppState.bossFight && window.__ppState.bossFight.splash; if (c) c.t = 0; }); // replay from the first frame
    const a = await waitCard(c => c && c.id === 'skytalon' && c.drawn && c.drawn.dx > 40 && c.drawn.img);
    if (a && a.drawn && a.drawn.dx > 0) await page.screenshot({ path: `${SH}/intro-skytalon-slidein.png` });
    ok(a && a.drawn && a.drawn.dx > 40, `skytalon: card slides in from the right (dx ${a && a.drawn && a.drawn.dx})`);
    await waitCard(c => c && c.t > T.in + 0.1); await page.keyboard.press('Enter');
    const s1 = await card(); ok(s1 && s1.skipped, 'ENTER skips the card in game');
    ok(!(await waitCard(c => !c, 3000)), 'skipped card is gone after the slide-out');
    ok(await page.evaluate(() => !window.__ppPause.isOpen() && !window.__ppScreens.active()), 'ENTER skip opens no menu');
  }
  { // Reduced motion in game
    phase = 'reduced'; await clear(); await page.evaluate(() => window.__ppOptions.set('reducedMotion', true)); await go(0);
    await page.evaluate(() => { const c = window.__ppState.bossFight && window.__ppState.bossFight.splash; if (c) c.t = 0; });
    const c = await waitCard(c => c && c.id === 'enforcer' && c.t > 0.12 && c.t < T.in && c.drawn && c.drawn.img, 6000);
    if (c) await page.screenshot({ path: `${SH}/intro-enforcer-reduced-fade.png` });
    ok(c && c.drawn.reduced && c.drawn.dx === 0 && c.drawn.alpha < 1, `Reduced motion: a static fade in game (alpha ${c && c.drawn.alpha}, dx ${c && c.drawn.dx})`);
    await page.evaluate(() => window.__ppOptions.set('reducedMotion', false));
  }
  { // final boss: waits out the bossEnter cinematic
    // warm up on the tower's lobby gate so the jumped-to level's stage flow has settled, then fire the top gate
    phase = 'final'; await clear(); await go(4, 'CLAW WALKER');
    await page.evaluate(() => { const s = window.__ppState; s.ninjas = []; s.bossFight = null; s.bossBar = null; s.events.lock = null; });
    await page.waitForTimeout(400); await clear(); await spawn(4);
    let cineSeen = false, frozen = true, t0 = null;
    for (let i = 0; i < 120; i++) { const st = await page.evaluate(() => ({ cine: window.__ppCinema.isActive(), c: window.__ppBoss.splash(window.__ppState) })); if (st.cine && st.c) { cineSeen = true; if (t0 == null) t0 = st.c.t; else if (st.c.t > t0 + 1e-6) frozen = false; } if (cineSeen && !st.cine) break; await page.waitForTimeout(50); if (cineSeen && i > 50) await page.evaluate(() => { if (window.__ppCinema.isActive()) window.__ppCinema.skip(); }); }
    ok(cineSeen && frozen, 'SHREDCLAW: the card waits while the bossEnter cinematic plays');
    const c = await waitCard(c => c && c.id === 'shredclaw' && c.t > T.in + 0.25 && c.drawn && c.drawn.img);
    const covered = await overlay();
    if (covered) console.log('   debug final', JSON.stringify(c), JSON.stringify(await page.evaluate(() => { const s = window.__ppState; return { level: s.level, wave: s.wave, over: s.over, ninjas: s.ninjas.map(n => n.kind + (n.dead ? 'x' : '')), defeated: s.bossFight && s.bossFight.defeated.map(d => d.id), shop: window.__ppShop.active(), cine: window.__ppCinema.isActive(), scr: window.__ppScreens.active(), px: Math.round(s.player.x) }; })));
    if (c && !covered) await page.screenshot({ path: `${SH}/intro-shredclaw.png` });
    ok(c && c.id === 'shredclaw' && !covered, 'SHREDCLAW card shows after the cinematic, nothing on top of it');
  }
} catch (e) { ok(false, 'browser run: ' + String(e).split('\n')[0]); }
ok(!errors.length, `0 console/page errors ${errors.slice(0, 4).join(' | ')}`);
await browser.close(); server.close();
console.log(`${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
