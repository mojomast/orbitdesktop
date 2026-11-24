"""Chroma-key and slice the OpenClaw mech walker parts sheet (flat #FF00FF).
usage: python3 tools/build_mech.py [sheet] [outdir]
Writes assets/enemies/mech/{torso,pod,claw,gun,thigh,shin_a,shin_b}.png (RGBA,
half scale, palette-quantized with alpha) and prints each part's box so
mech.js pivots can be checked. Steps: key on distance from magenta (soft edge),
despill the fringe, drop JPEG speckle (small components), erode 1px, crop."""
import sys, os
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage
SHEET = sys.argv[1] if len(sys.argv) > 1 else '/workspace/pizza-mech/gen/mech_parts.jpg'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', '..', 'pizza-panic', 'assets', 'enemies', 'mech')
SCALE = 0.5
NAMES = [['torso', 'pod', 'claw', 'gun'], ['thigh', 'shin_a', 'shin_b']]

im = np.asarray(Image.open(SHEET).convert('RGB')).astype(np.float32)
r, g, b = im[..., 0], im[..., 1], im[..., 2]
# magenta-ness: high R and B, low G. Distance-based soft key.
mag = np.minimum(r, b) - g
alpha = np.clip((150 - mag) / 70, 0, 1)            # mag>=150 -> 0, mag<=80 -> 1
solid = alpha > 0.5
lab, n = ndimage.label(ndimage.binary_opening(solid, iterations=2))
sizes = ndimage.sum(solid, lab, range(1, n + 1))
keep = [i + 1 for i, s in enumerate(sizes) if s > 3000]
boxes = []
for k in keep:
    ys, xs = np.where(lab == k)
    boxes.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1, k))
rows = [[bx for bx in boxes if (bx[1] + bx[3]) / 2 < 260], [bx for bx in boxes if (bx[1] + bx[3]) / 2 >= 260]]
assert [len(x) for x in rows] == [4, 3], [len(x) for x in rows]
# despill: pull magenta out of fringe pixels (cap R and B toward G-ish neutral)
spill = np.clip(mag, 0, None) * (1 - alpha) ** 0.5
out = im.copy()
neutral = np.maximum(g, np.minimum(r, b) - spill)
fringe = (alpha < 0.98) | (mag > 40)  # only edge pixels / magenta-tinted ones; keeps the real reds
out[..., 0] = np.where(fringe, np.minimum(r, neutral + 40), r); out[..., 2] = np.where(fringe, np.minimum(b, neutral + 40), b)
os.makedirs(OUT, exist_ok=True)
total = 0
for row, names in zip(rows, NAMES):
    for (x0, y0, x1, y1, k), name in zip(sorted(row), names):
        m = ndimage.binary_dilation(lab == k, iterations=3)       # component + its soft edge
        a = (alpha * m)
        a = ndimage.grey_erosion(a, size=(2, 2))                  # eat the last fringe pixel
        pad = 4; X0, Y0, X1, Y1 = max(0, x0 - pad), max(0, y0 - pad), min(im.shape[1], x1 + pad), min(im.shape[0], y1 + pad)
        rgba = np.dstack([out[Y0:Y1, X0:X1], a[Y0:Y1, X0:X1] * 255]).astype(np.uint8)
        p = Image.fromarray(rgba, 'RGBA')
        p = p.resize((max(1, round(p.width * SCALE)), max(1, round(p.height * SCALE))), Image.LANCZOS)
        al = np.asarray(p)[..., 3].copy(); al[al < 24] = 0; al[al > 232] = 255
        p.putalpha(Image.fromarray(al))
        q = p.quantize(colors=128, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        f = os.path.join(OUT, name + '.png'); q.save(f, optimize=True)
        total += os.path.getsize(f)
        print(f'{name:7s} sheet box ({x0},{y0})-({x1},{y1})  png {p.width}x{p.height}  {os.path.getsize(f)//1024} KB')
print('total', total // 1024, 'KB ->', os.path.abspath(OUT))
