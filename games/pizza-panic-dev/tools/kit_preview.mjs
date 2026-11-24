// Rig preview for kits that are not registered in enemy-rigs.js yet (baba_booey,
// t_ffa2e601eaff4a36). Serves the game read-only, injects assets/enemies/<kind>/kit.json
// (plus the generator's derived back limbs) into ENEMY_RIGS in the page *before*
// rig.js evaluates, then draws the real rig in several poses. No game file is edited.
// usage: node tools/kit_preview.mjs [out.png] [kinds=sniper,heavy]
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const ROOT = new URL('../../pizza-panic/', import.meta.url).pathname;
const OUT = process.argv[2] || '/workspace/pizza-kits/rig-preview.png';
const KINDS = (process.argv[3] || 'sniper,heavy').split(',');
export const POSE_LIST = ['idle', 'walk1', 'walk3', 'punchWind', 'punch', 'poundWind', 'pound', 'guard', 'hurt', 'jump'];
const kits = Object.fromEntries(KINDS.map(k => [k, JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/enemies', k, 'kit.json'), 'utf8'))]));
const html = `<!doctype html><body style="margin:0;background:#151820"><canvas id="c" width="1240" height="${KINDS.length * 250 + 20}"></canvas><script type="module">
const kits = ${JSON.stringify(kits)};
const { ENEMY_RIGS } = await import('./enemy-rigs.js');
for (const [kind, t] of Object.entries(kits)) {
  const tb = { ...t };
  for (const [back, front] of [['uarm_b', 'uarm'], ['farm_b', 'farm'], ['thigh_b', 'thigh'], ['shin_b', 'shin']]) {
    const f = t[front]; const parent = back.startsWith('uarm') || back.startsWith('thigh') ? 'torso' : back.startsWith('farm') ? 'uarm_b' : 'thigh_b'; const root = parent === 'torso';
    tb[back] = { ...f, parent, ax: root ? Math.max(2, f.ax - 6) : f.ax, ay: root ? f.ay - 2 : f.ay, back: true };
  }
  ENEMY_RIGS[kind] = tb;
}
const { createRig } = await import('./rig.js');
const rig = createRig(), c = document.getElementById('c'), g = c.getContext('2d');
const poses = ${JSON.stringify(POSE_LIST)}, kinds = Object.keys(kits);
let tries = 0;
(function frame() {
  g.fillStyle = '#151820'; g.fillRect(0, 0, c.width, c.height);
  let ok = 0;
  kinds.forEach((k, r) => poses.forEach((p, i) => {
    const x = 70 + i * 120, y = 30 + r * 250 + 190;
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x - 58, y - 200, 116, 220);
    g.fillStyle = '#9bd6a3'; g.font = '11px monospace'; g.textAlign = 'center'; g.fillText(k + ' ' + p, x, y + 16);
    if (rig.draw(g, k, p, x, y - 70, false, 1.15)) ok++;
  }));
  window.__drawn = ok;
  if (ok < kinds.length * poses.length && tries++ < 100) setTimeout(frame, 50);
})();
</script>`;
const types = { '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); if (u === '/__kits.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(html); }
  const f = path.join(ROOT, u); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 1240, height: KINDS.length * 250 + 20 } }); const errors = [];
page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); }); page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
await page.goto(`http://127.0.0.1:${server.address().port}/__kits.html`); await page.waitForFunction(() => window.__drawn !== undefined, null, { timeout: 15000 }); await page.waitForTimeout(800);
const drawn = await page.evaluate(() => window.__drawn);
await page.screenshot({ path: OUT }); await browser.close(); server.close();
console.log(JSON.stringify({ out: OUT, drawn, expected: KINDS.length * POSE_LIST.length, errors }));
process.exit(errors.length || drawn < KINDS.length * POSE_LIST.length ? 1 : 0);
