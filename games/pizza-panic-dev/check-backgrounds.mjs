// Walking-level background checks (baba_booey, t_d7f9cc49e453482c).
//  - sewer, street and rooftop each draw three DISTINCT paintings, one per
//    1814 px strip tile (not tinted copies of one painting)
//  - the sewer draws a real far layer (far/sewer.jpg, its own cavern), the
//    street/rooftop keep night/dusk, the tower keeps its per-section tiles
//  - floor band alignment: every tile is opaque across the collision band,
//    its painted floor top sits on the band top, and tile seams are continuous
//  - no flat-colour holes: back() covers every pixel at every camera x
//  - assets stay lean (JPG + alpha mask PNG)
//  v2 (t_fadcdb1655a545f1): the same for subway (5), harbor (6), arcade (7) and the
//  tower (4): three distinct tiles each, bands opaque and aligned, seams
//  continuous, no holes; subway windows cut to the tunnel, harbor cranes painted
//  where CRANES drop crates, the tower server floor is its own painting.
// usage: node check-backgrounds.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const G = new URL('../pizza-panic/', import.meta.url);
const K = await import(new URL('collision.js', G).href);
const SD = await import(new URL('subway-data.js', G).href);
const HD = await import(new URL('harbor-data.js', G).href);
const AD = await import(new URL('arcade-data.js', G).href);
const V2 = { 5: 'subway', 6: 'harbor', 7: 'arcade', 4: 'tower' };
const V2_SEG = { subway: ['subway_0', 'subway_2'], harbor: ['harbor_1', 'harbor_2'], arcade: ['arcade_1'], tower: ['tower_1'] };
const P = await import(new URL('parallax.js', G).href);
let pass = 0, total = 0;
const t = async (name, fn) => { total++; await fn(); pass++; console.log('PASS', name); };
const src = fs.readFileSync(new URL('parallax.js', G), 'utf8');
const LV = { 0: 'sewer', 1: 'street', 2: 'rooftop' };
const pngInfo = f => { const b = fs.readFileSync(f); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
const jpgSize = f => { const b = fs.readFileSync(f); let i = 2; while (i < b.length) { const m = b[i + 1], len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc2) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + len; } return null; };
const segList = () => { const m = src.match(/seg:\s*\[([\s\S]*?)\n\s*\],\n/); assert.ok(m, 'parallax.js has SRC.seg'); return [...m[1].matchAll(/\[([^\]]*)\]/g)].map(r => [...r[1].matchAll(/'([^']+)'/g)].map(x => x[1])); };

await t('static: three distinct segment files per walking level, a sewer far layer, no tint system, lean assets', () => {
  const seg = segList();
  assert.equal(seg.length, 3);
  let bytes = 0; const seen = new Set();
  seg.forEach((list, lv) => {
    assert.equal(list.length, 3, LV[lv]);
    assert.equal(new Set(list).size, 3, LV[lv] + ' tiles are 3 different files');
    for (const b of list) {
      if (b === 'mid') { const f = new URL(`assets/levels/${LV[lv]}_mid.png`, G).pathname; assert.deepEqual(pngInfo(f), { w: 1814, h: 510 }); continue; }
      const j = new URL(b + '.jpg', G).pathname, m = new URL(b + '_mask.png', G).pathname;
      assert.ok(fs.existsSync(j), j); assert.deepEqual(jpgSize(j), { w: 1814, h: 510 }, j);
      if (fs.existsSync(m)) { assert.deepEqual(pngInfo(m), { w: 1814, h: 510 }, m); bytes += fs.statSync(m).size; }
      const d = fs.readFileSync(j).toString('base64'); assert.ok(!seen.has(d), 'duplicate segment ' + b); seen.add(d);
      bytes += fs.statSync(j).size;
    }
  });
  const far = new URL('assets/levels/far/sewer.jpg', G).pathname;
  assert.deepEqual(jpgSize(far), { w: 1814, h: 510 }); bytes += fs.statSync(far).size;
  assert.match(src, /FAR_FOR = \['sewer'/, 'level 0 far layer is the sewer cavern');
  assert.ok(!/hue-rotate|PALETTE/.test(src), 'tinted-copy segment system is gone');
  assert.match(src, /tower_server_mid\.png/); assert.match(src, /far\/tower\.jpg/);
  assert.ok(bytes < 1.6e6, `segment art ${Math.round(bytes / 1024)} KB`);
  console.log(`   segment art + sewer far: ${Math.round(bytes / 1024)} KB`);
});

await t('static v2: subway/harbor/arcade/tower segment files exist (JPG + mask, 1814x510), lean, wired', () => {
  let bytes = 0;
  for (const [lv, list] of Object.entries(V2_SEG)) for (const b of list) {
    const j = new URL(`assets/levels/seg/${b}.jpg`, G).pathname, m = new URL(`assets/levels/seg/${b}_mask.png`, G).pathname;
    assert.deepEqual(jpgSize(j), { w: 1814, h: 510 }, j); assert.deepEqual(pngInfo(m), { w: 1814, h: 510 }, m);
    bytes += fs.statSync(j).size + fs.statSync(m).size;
  }
  assert.ok(bytes < 1.5e6, `v2 segment art ${Math.round(bytes / 1024)} KB`);
  console.log(`   v2 segment art: ${Math.round(bytes / 1024)} KB`);
  for (const [f, re] of [['subway.js', /seg\/subway_0/], ['harbor.js', /seg\/harbor_1/], ['arcade.js', /seg\/arcade_1/], ['parallax.js', /seg\/tower_1/]]) assert.match(fs.readFileSync(new URL(f, G), 'utf8'), re, f);
  // the level systems keep their sections: subway roof run is still tile 1, the ship / ticket counter are still tile 2
  assert.deepEqual([SD.SUBWAY_ROOF.x0, HD.SHIP_X, AD.TICKET_X], [1814, 3628, 3628]);
});

await t('node: back() with no images loaded stays safe (no document/Image)', () => {
  const p = P.createParallax();
  assert.deepEqual(p.segmentImages(0), [null, null, null]);
  assert.equal(p.back({ drawImage() { throw new Error('nothing to draw'); } }, 0, 0, 740, 510), false);
});

// ---- browser: decode the real art
const require = createRequire('/home/box/orbitdesktop/package.json');
const { chromium } = require('playwright-core');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
const server = http.createServer((q, r) => { if (q.url.startsWith('/favicon')) { r.writeHead(204); return r.end(); } const f = path.join(G.pathname, decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html')); if (!f.startsWith(G.pathname) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(res => server.listen(0, '127.0.0.1', res));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 740, height: 510 } });
const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
await page.goto(url + 'parallax.js'); // same origin, no game boot
const bands = Object.fromEntries([0, 1, 2].map(l => [l, K.LEVELS[l].walkables[0]]));
const R = await page.evaluate(async (bands) => {
  const P = await import('./parallax.js');
  const p = P.createParallax();
  for (let i = 0; i < 200 && !(p.segments().size === 3 && p.images.far_sewer && p.images.far_night && p.images.far_dusk && p.images.tower_2); i++) { [0, 1, 2].forEach(l => p.segmentImages(l)); await new Promise(r => setTimeout(r, 50)); }
  const out = { loaded: p.segments().size, tiles: {}, back: {}, far: {} };
  const px = im => { const c = document.createElement('canvas'); c.width = 1814; c.height = 510; const g = c.getContext('2d'); g.drawImage(im, 0, 0, 1814, 510); return g.getImageData(0, 0, 1814, 510).data; };
  for (const lv of [0, 1, 2]) {
    const ims = p.segmentImages(lv); const b = bands[lv];
    const data = ims.map(px);
    // grayscale thumbnails of the wall (above the band), for the distinctness test
    const thumb = d => { const o = []; for (let y = 0; y < b.y - 10; y += 6) for (let x = 0; x < 1814; x += 6) { const i = (y * 1814 + x) * 4; o.push(d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11); } return o; };
    const corr = (a, c) => { const n = a.length; let ma = 0, mc = 0; for (let i = 0; i < n; i++) { ma += a[i]; mc += c[i]; } ma /= n; mc /= n; let s = 0, sa = 0, sc = 0; for (let i = 0; i < n; i++) { const u = a[i] - ma, v = c[i] - mc; s += u * v; sa += u * u; sc += v * v; } return s / Math.sqrt(sa * sc + 1e-9); };
    const th = data.map(thumb);
    // floor: band opacity, painted floor-top step (median row luminance), seam continuity
    const alphaMin = data.map(d => { let m = 255; for (let y = b.y; y < Math.min(510, b.y + b.h); y++) for (let x = 0; x < 1814; x++) m = Math.min(m, d[(y * 1814 + x) * 4 + 3]); return m; });
    const prof = d => { const o = []; for (let y = 0; y < 510; y++) { const row = []; for (let x = 0; x < 1814; x += 2) { const i = (y * 1814 + x) * 4; row.push(d[i] + d[i + 1] + d[i + 2]); } row.sort((u, v) => u - v); o.push(row[row.length >> 1] / 3); } return o; };
    const edge = d => { const pr = prof(d); let best = 0, at = 0; for (let r = b.y - 30; r <= b.y + 30; r++) { const v = Math.abs((pr[r + 2] + pr[r + 3] + pr[r + 4]) - (pr[r - 4] + pr[r - 3] + pr[r - 2])) / 3; if (v > best) { best = v; at = r; } } return at; };
    const col = (d, x) => { const o = []; for (let y = b.y; y < Math.min(510, b.y + b.h); y++) { const i = (y * 1814 + x) * 4; o.push(d[i], d[i + 1], d[i + 2]); } return o; };
    const mad = (a, c) => a.reduce((s, v, i) => s + Math.abs(v - c[i]), 0) / a.length;
    const inner = d => { let s = 0; for (const x of [300, 700, 1100, 1500]) s += mad(col(d, x), col(d, x + 1)); return s / 4; };
    const seams = [0, 1].map(k => ({ seam: mad(col(data[k], 1813), col(data[k + 1], 0)), inner: inner(data[k + 1]) }));
    out.tiles[lv] = { corr: [corr(th[0], th[1]), corr(th[0], th[2]), corr(th[1], th[2])], alphaMin, edges: data.map(edge), seams, kinds: ims.map(im => im && im.constructor.name) };
  }
  // back(): every pixel covered (sentinel magenta never survives), far layer drawn first
  for (const lv of [0, 1, 2, 4]) {
    out.back[lv] = [];
    for (const camX of [0, 300, 1100, 1500, 1814 - 370, 2600, 1814 * 2 - 370, 4200, 5442 - 740]) {
      const c = document.createElement('canvas'); c.width = 740; c.height = 510; const g = c.getContext('2d');
      g.fillStyle = '#ff00ff'; g.fillRect(0, 0, 740, 510);
      const drawn = []; const orig = g.drawImage.bind(g);
      g.drawImage = (im, ...a) => { drawn.push(im.src ? im.src.replace(/^.*assets\//, '') : 'canvas:' + (Object.entries(p.images).find(([, v]) => v === im)?.[0] || 'seg')); return orig(im, ...a); };
      const ok = p.back(g, lv, camX, 740, 510);
      const d = g.getImageData(0, 0, 740, 510).data; let holes = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] < 20 && d[i + 2] > 240) holes++;
      out.back[lv].push({ camX, ok, holes, first: drawn[0], n: drawn.length });
    }
  }
  // the sewer cavern really shows: in the arch of tile 0 the drawn pixel is the far art
  { const c = document.createElement('canvas'); c.width = 740; c.height = 510; const g = c.getContext('2d');
    p.back(g, 0, 100, 740, 510); const a = g.getImageData(446 - 100, 200, 1, 1).data;
    const f = document.createElement('canvas'); f.width = 740; f.height = 510; const h = f.getContext('2d');
    const far = p.images.far_sewer; const w = far.width * (510 / far.height); h.drawImage(far, -((100 * P.FAR_RATE) % w), 0, w, 510);
    const b = h.getImageData(446 - 100, 200, 1, 1).data; out.far.arch = [Array.from(a), Array.from(b)]; }
  return out;
}, bands);

// v2 levels: build the real modules in the page and read back their tile art
const BANDS2 = { 5: SD.SUBWAY_BAND, 6: HD.HARBOR_BAND, 7: AD.ARCADE_BAND, 4: K.LEVELS[4].walkables[0] };
const R2 = await page.evaluate(async ({ BANDS2, CRANES }) => {
  const [P, SW, HB, AR] = await Promise.all(['./parallax.js', './subway.js', './harbor.js', './arcade.js'].map(m => import(m)));
  const p = P.createParallax(), sw = SW.createSubway({}), hb = HB.createHarbor({}), ar = AR.createArcade({});
  const tiles = {
    5: () => [sw.images.seg0, sw.images.roof, sw.images.seg2],
    6: () => [hb.images.docks_mid, hb.images.pier2, hb.images.ship2],
    7: () => [ar.images.arcade_mid, ar.images.row2, ar.images.ticket_mid],
    4: () => [p.towerTile(0), p.towerTile(1), p.towerTile(2)],
  };
  const ready = () => Object.values(tiles).every(f => f().every(Boolean)) && sw.images.tunnel && hb.images.docks_far && p.images.far_tower;
  for (let i = 0; i < 200 && !ready(); i++) await new Promise(r => setTimeout(r, 50));
  const px = im => { const c = document.createElement('canvas'); c.width = 1814; c.height = 510; const g = c.getContext('2d'); g.drawImage(im, 0, 0, 1814, 510); return g.getImageData(0, 0, 1814, 510).data; };
  const corr = (a, c) => { const n = a.length; let ma = 0, mc = 0; for (let i = 0; i < n; i++) { ma += a[i]; mc += c[i]; } ma /= n; mc /= n; let s = 0, sa = 0, sc = 0; for (let i = 0; i < n; i++) { const u = a[i] - ma, v = c[i] - mc; s += u * v; sa += u * u; sc += v * v; } return s / Math.sqrt(sa * sc + 1e-9); };
  const out = {};
  for (const lv of [5, 6, 7, 4]) {
    const ims = tiles[lv](); const b = BANDS2[lv];
    if (!ims.every(Boolean)) { out[lv] = { missing: ims.map(Boolean) }; continue; }
    const data = ims.map(px);
    const thumb = d => { const o = []; for (let y = 0; y < b.y - 10; y += 6) for (let x = 0; x < 1814; x += 6) { const i = (y * 1814 + x) * 4; o.push((d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) * d[i + 3] / 255); } return o; };
    const th = data.map(thumb);
    const alphaMin = data.map(d => { let m = 255; for (let y = b.y; y < Math.min(510, b.y + b.h); y++) for (let x = 0; x < 1814; x++) m = Math.min(m, d[(y * 1814 + x) * 4 + 3]); return m; });
    const col = (d, x) => { const o = []; for (let y = b.y; y < Math.min(510, b.y + b.h); y++) { const i = (y * 1814 + x) * 4; o.push(d[i], d[i + 1], d[i + 2]); } return o; };
    const mad = (a, c) => a.reduce((s, v, i) => s + Math.abs(v - c[i]), 0) / a.length;
    const inner = d => { let s = 0; for (const x of [300, 700, 1100, 1500]) s += mad(col(d, x), col(d, x + 1)); return s / 4; };
    const seams = [0, 1].map(k => ({ seam: mad(col(data[k], 1813), col(data[k + 1], 0)), inner: inner(data[k + 1]) }));
    const r = { corr: [corr(th[0], th[1]), corr(th[0], th[2]), corr(th[1], th[2])], alphaMin, seams };
    if (lv === 5) r.windows = [0, 2].map(k => { let n = 0, tot = 0; for (let y = 60; y < 330; y += 2) for (let x = 0; x < 1814; x += 2) { tot++; if (data[k][(y * 1814 + x) * 4 + 3] < 128) n++; } return n / tot; });
    if (lv === 6) r.cranes = CRANES.filter(x => x > 1814 && x < 3628).map(x => { let n = 0; const lx = x - 1814; for (let y = 90; y < 290; y++) for (let dx = -60; dx <= 60; dx++) { const i = (y * 1814 + lx + dx) * 4, d = data[1]; if (d[i + 3] > 200 && d[i] > 120 && d[i] - d[i + 2] > 60 && d[i + 1] > 80) n++; } return n; });
    // back(): every pixel covered at several camera x
    r.holes = [];
    for (const camX of [0, 900, 1814 - 370, 2600, 3628 - 370, 4200, 5442 - 740]) {
      const c = document.createElement('canvas'); c.width = 740; c.height = 510; const g = c.getContext('2d');
      g.fillStyle = '#ff00ff'; g.fillRect(0, 0, 740, 510);
      const s = { level: lv, wave: 1, events: { log: [] }, player: { x: camX + 300, y: b.y + 20 }, ninjas: [] };
      if (lv === 5) sw.back(g, s, camX, 740, 510, 1 / 60); else if (lv === 6) hb.back(g, s, camX, 740, 510); else if (lv === 7) ar.back(g, s, camX, 740, 510); else p.back(g, 4, camX, 740, 510);
      const d = g.getImageData(0, 0, 740, 510).data; let holes = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] < 20 && d[i + 2] > 240) holes++;
      r.holes.push([camX, holes]);
    }
    out[lv] = r;
  }
  return out;
}, { BANDS2, CRANES: HD.CRANES });

await t('browser: all nine segment paintings load and join with their masks', () => {
  assert.equal(R.loaded, 3, 'segment cache for the 3 walking levels');
  for (const lv of [0, 1, 2]) assert.ok(R.tiles[lv].kinds.every(Boolean), LV[lv] + ' ' + R.tiles[lv].kinds);
});
await t('distinct segments: the three tiles of each level are different paintings (not tinted copies)', () => {
  for (const lv of [0, 1, 2]) {
    const c = R.tiles[lv].corr.map(v => +v.toFixed(2));
    console.log(`   ${LV[lv]}: wall correlation between tiles ${c.join(' / ')} (a tinted copy is ~0.95+)`);
    assert.ok(Math.max(...c) < 0.6, LV[lv] + ' tiles too similar ' + c);
  }
});
await t('floor band alignment: opaque across the collision band, painted floor top on the band top, continuous seams', () => {
  for (const lv of [0, 1, 2]) {
    const T = R.tiles[lv], b = bands[lv];
    console.log(`   ${LV[lv]}: band y${b.y}-${b.y + b.h}; floor top per tile ${T.edges.join(', ')}; band alpha min ${T.alphaMin.join(', ')}; seam diff ${T.seams.map(s => s.seam.toFixed(1) + ' (in-tile ' + s.inner.toFixed(1) + ')').join(', ')}`);
    T.alphaMin.forEach((a, k) => { if (k > 0 || lv === 0) assert.equal(a, 255, `${LV[lv]} tile ${k} band has see-through pixels`); else assert.ok(a >= 235, `${LV[lv]} tile 0 band alpha ${a}`); });
    T.edges.forEach((e, k) => assert.ok(Math.abs(e - b.y) <= 32, /* strongest floor step: wall base, or the street's curb */ `${LV[lv]} tile ${k} floor top at ${e}, band ${b.y}`));
    T.seams.forEach((s, k) => assert.ok(s.seam <= Math.max(6, s.inner * 2.5), `${LV[lv]} seam ${k + 1} jumps ${s.seam.toFixed(1)} vs ${s.inner.toFixed(1)}`));
  }
});
await t('far layers: sewer draws its cavern (shown through the arches), street/rooftop night/dusk, tower its own', () => {
  const want = { 0: 'levels/far/sewer.jpg', 1: 'levels/far/night.jpg', 2: 'levels/far/dusk.jpg', 4: 'levels/far/tower.jpg' };
  for (const lv of [0, 1, 2, 4]) for (const r of R.back[lv]) { assert.ok(r.ok, `${lv} back drew`); assert.equal(r.first, want[lv], `level ${lv} camX ${r.camX} draws ${r.first} first`); }
  const [a, b] = R.far.arch; assert.ok(a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= 3), `arch pixel ${a} is the cavern ${b}`);
});
await t('no flat-colour holes: back() covers every pixel at every camera x (sewer, street, rooftop, tower)', () => {
  for (const lv of [0, 1, 2, 4]) for (const r of R.back[lv]) assert.equal(r.holes, 0, `level ${lv} camX ${r.camX}: ${r.holes} uncovered px`);
});
await t('v2 distinct tiles: subway, harbor, arcade and tower each show three different paintings', () => {
  for (const lv of [5, 6, 7, 4]) {
    const r = R2[lv]; assert.ok(!r.missing, `${V2[lv]} tiles loaded ${JSON.stringify(r.missing)}`);
    const c = r.corr.map(v => +v.toFixed(2));
    console.log(`   ${V2[lv]}: wall correlation between tiles ${c.join(' / ')}`);
    assert.ok(Math.max(...c) < 0.6, `${V2[lv]} tiles too similar ${c}`);
  }
});
await t('v2 floor bands: opaque across each band, continuous seams; subway windows cut, harbor cranes repainted at CRANES', () => {
  for (const lv of [5, 6, 7, 4]) {
    const r = R2[lv], b = BANDS2[lv];
    console.log(`   ${V2[lv]}: band y${b.y}-${b.y + b.h}; band alpha min ${r.alphaMin.join(', ')}; seam diff ${r.seams.map(s => s.seam.toFixed(1) + ' (in-tile ' + s.inner.toFixed(1) + ')').join(', ')}`);
    // tile 0 of the harbor/tower is an existing *_mid.png (a few 221-225 alpha px from the 256-colour quantize), left as is
    r.alphaMin.forEach((a, k) => assert.ok(a >= ((lv === 6 || lv === 4) && k === 0 ? 215 : 235), `${V2[lv]} tile ${k} band alpha ${a}`));
    // the subway roof tile is a section cut (hatch up / down) on both sides: the
    // original car->roof and roof->car seams were 22-24, so hold it to that
    r.seams.forEach((s, k) => assert.ok(lv === 5 ? s.seam <= 26 : s.seam <= Math.max(8, s.inner * 3), `${V2[lv]} seam ${k + 1} jumps ${s.seam.toFixed(1)} vs ${s.inner.toFixed(1)}`));
  }
  console.log(`   subway window cut-outs: ${R2[5].windows.map(v => (v * 100).toFixed(1) + '%').join(', ')}; harbor crane pixels at x ${HD.CRANES.filter(x => x > 1814 && x < 3628).join(', ')}: ${R2[6].cranes.join(', ')}`);
  R2[5].windows.forEach((v, k) => assert.ok(v > 0.05, `subway tile ${k * 2} windows cut ${v}`));
  R2[6].cranes.forEach((n, k) => assert.ok(n > 400, `harbor crane ${k} painted (${n} px)`));
});
await t('v2 no flat-colour holes: each module\'s back() covers every pixel at every camera x', () => {
  for (const lv of [5, 6, 7, 4]) for (const [camX, h] of R2[lv].holes) assert.equal(h, 0, `${V2[lv]} camX ${camX}: ${h} uncovered px`);
});
await t('0 console errors', () => { assert.deepEqual(errors, []); });
await browser.close(); server.close();
console.log(`${pass}/${total} passed`);
