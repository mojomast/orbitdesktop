// MR.INDIA t_458a9599cf714072: TurboFit's in-game head must show his face under the hair
// (the v1 head was hair only). Guards hero-rigs data vs the PNG and the face pixels.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import zlib from 'node:zlib';
const G = new URL('../pizza-panic/', import.meta.url);
const { HERO_RIGS } = await import(new URL('hero-rigs.js', G).href);
let fails = 0; const t = (n, f) => { try { const d = f(); console.log('PASS', n + (d ? ' ' + d : '')); } catch (e) { fails++; console.log('FAIL', n, '-', e.message); } };
function png(file) { // minimal 8-bit RGB/RGBA decoder (filters 0-4)
  const b = fs.readFileSync(file); let o = 8, w, h, ct, idat = [];
  while (o < b.length) { const len = b.readUInt32BE(o), ty = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (ty === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; assert.equal(d[8], 8, 'bit depth'); } if (ty === 'IDAT') idat.push(d); o += 12 + len; }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; assert.ok(bpp, 'colour type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * bpp), st = w * bpp;
  for (let y = 0; y < h; y++) { const f = raw[y * (st + 1)];
    for (let x = 0; x < st; x++) { const v = raw[y * (st + 1) + 1 + x], a = x >= bpp ? px[y * st + x - bpp] : 0, u = y ? px[(y - 1) * st + x] : 0, c = x >= bpp && y ? px[(y - 1) * st + x - bpp] : 0;
      const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c);
      px[y * st + x] = (v + [0, a, u, (a + u) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? u : c][f]) & 255; } }
  return { w, h, bpp, px };
}
const part = HERO_RIGS.turbofit.head, file = new URL('assets/heroes/turbofit/' + part.file, G);
const im = png(file);
t('hero-rigs head entry matches the PNG and keeps the neck pivot', () => {
  assert.deepEqual([im.w, im.h], [part.w, part.h]); assert.deepEqual([part.px, part.py], [37, 54]);
});
t('the head shows a face: plenty of skin-tone pixels, on the right half (heroes face right)', () => {
  let op = 0, skin = 0, right = 0;
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { const i = (y * im.w + x) * im.bpp, a = im.bpp === 4 ? im.px[i + 3] : 255; if (a < 128) continue; op++;
    const r = im.px[i], g = im.px[i + 1], b = im.px[i + 2]; if (r > 150 && g > 95 && b > 60 && r > g && g > b && r - b > 50) { skin++; if (x > im.w / 2) right++; } }
  assert.ok(skin / op > 0.12, `skin ${(100 * skin / op).toFixed(1)}%`); assert.ok(right > skin / 2, 'face sits right of centre');
  return `(skin ${(100 * skin / op).toFixed(1)}% of opaque, ${Math.round(100 * right / skin)}% right of centre)`;
});
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
