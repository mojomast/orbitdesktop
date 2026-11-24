#!/usr/bin/env python3
"""Don Piedro torso with the yellow shoulder pads (baba_booey, t_9ec48322f6de4bf7; Kyle's fix).
Source: /workspace/pizza-story/don/gen/don_torso_pads.jpg (pink, key sampled from the border by make_splash.key,
despilled): white chest plate with wide ribbed yellow pads, blue collar, blue belt. It has no hips, so the blue
pelvis (rows 46+) of the parts-sheet torso (slice_don.py output, kept as don_piedro_torso_base.png in the work dir)
is kept underneath the new belt, and the chest is scaled to the old chest width so every attach point keeps working.
The pads' outer overhang is compressed horizontally (PAD_SQUEEZE) so they widen the silhouette about like
don_full.jpg rather than doubling it. The canvas grows by MARGIN px on each side: the rig pivot / attaches shift by
+MARGIN in x (MANIFEST + hero-rigs regenerated). usage: python make_don_torso.py [base_torso.png] [out.png]"""
import os, sys, io
import numpy as np
from PIL import Image
from scipy import ndimage as nd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
_argv = sys.argv; sys.argv = [_argv[0]]
import make_splash as MS
sys.argv = _argv
import slice_don as SD
GAME = os.path.join(HERE, '..', '..', 'pizza-panic')
SRC = '/workspace/pizza-story/don/gen/don_torso_pads.jpg'
WORK = '/workspace/pizza-story/don/work/torso'
BASE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WORK, 'don_piedro_torso_base.png')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(GAME, 'assets/heroes/don_piedro/don_piedro_torso.png')
OLD_W, OLD_CHEST = 51, 46       # parts-sheet torso width / new chest width (a touch narrower: the pads add width)
ARMOUR_H = 54                   # collar top .. belt bottom (mild vertical squash of the front-on art)
PELVIS_FROM, PELVIS_AT = 46, 52  # parts-sheet rows 46+ (blue hips) go under the new belt at row 52
PAD_SQUEEZE = 0.55              # outer pad overhang kept
MARGIN = 20                     # extra px each side for the pads

def main():
    rgba, _ = MS.key(SRC)
    a = np.asarray(rgba).astype(np.float32); al = a[..., 3]
    ys, xs = np.nonzero(al > 128); y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    # chest edges: the opaque span on a row well below the pads (60% down)
    yc = int(y0 + (y1 - y0) * 0.62); row = np.nonzero(al[yc] > 128)[0]; c0, c1 = row.min(), row.max()
    print('src bbox', (x0, y0, x1, y1), 'chest', (c0, c1), 'at row', yc)
    # horizontal warp: x outside [c0, c1] is squeezed toward the chest
    W = a.shape[1]; out_x = np.arange(W, dtype=np.float32)
    nx0 = c0 - (c0 - x0) * PAD_SQUEEZE; nx1 = c1 + (x1 - c1) * PAD_SQUEEZE
    nw = int(np.ceil(nx1 - nx0)) + 2
    # inverse map for every destination column
    dst = np.arange(nw, dtype=np.float32) + nx0
    srcx = np.where(dst < c0, c0 - (c0 - dst) / PAD_SQUEEZE, np.where(dst > c1, c1 + (dst - c1) / PAD_SQUEEZE, dst))
    crop = a[y0:y1 + 1]
    warped = np.stack([np.stack([np.interp(srcx, np.arange(W), crop[y, :, ch]) for ch in range(4)], -1) for y in range(crop.shape[0])])
    im = Image.fromarray(np.clip(warped, 0, 255).astype(np.uint8), 'RGBA')
    k = OLD_CHEST / (c1 - c0 + 1)
    armour = im.resize((max(1, round(im.width * k)), ARMOUR_H), Image.LANCZOS)
    chest_l = round((c0 - nx0) * k)       # chest left edge inside the scaled armour
    base = Image.open(BASE).convert('RGBA')
    CW = OLD_W + 2 * MARGIN; CH = PELVIS_AT + base.height - PELVIS_FROM; canvas = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    pelvis = base.crop((0, PELVIS_FROM, base.width, base.height)); canvas.alpha_composite(pelvis, (MARGIN, PELVIS_AT))
    ax = MARGIN - chest_l; print('armour', armour.size, 'pasted at x', ax, 'canvas', canvas.size)
    if ax < 0 or ax + armour.width > CW: print('WARN armour clipped by the canvas', ax, armour.width, CW)
    canvas.alpha_composite(armour, (ax, 0))
    canvas = SD.outline(canvas)
    os.makedirs(WORK, exist_ok=True)
    al2 = np.asarray(canvas)[..., 3]; padrows = [y for y in range(CH) if (al2[y] > 128).sum() > OLD_CHEST + 8]
    print('chest left x', ax + chest_l, 'pad rows', padrows[:1], padrows[-1:])
    print('wrote', OUT, SD.save(canvas, OUT), 'bytes', canvas.size)
    prev = Image.new('RGBA', (CW * 4, CH * 4), (80, 130, 90, 255)); prev.alpha_composite(canvas.resize((CW * 4, CH * 4), Image.NEAREST)); prev.save(os.path.join(WORK, 'torso-preview.png'))

if __name__ == '__main__':
    main()
