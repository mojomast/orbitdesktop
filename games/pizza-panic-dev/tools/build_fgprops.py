#!/usr/bin/env python3
"""Foreground parallax props (baba_booey, t_1ad03aea0ea3452a).
Keys the two magenta prop sheets in /workspace/pizza-fgprops/gen/, splits them
into one sprite per prop (row-major order, names below), despills the fringe,
trims and writes small palette PNGs to games/pizza-panic/assets/levels/fg/.
usage: python3 build_fgprops.py [gen dir] [out dir]   (imagequant optional; a
venv with it lives at /workspace/pizza-victory/venv)"""
import io, sys, os
import numpy as np
from PIL import Image
from scipy import ndimage as nd
GEN = sys.argv[1] if len(sys.argv) > 1 else '/workspace/pizza-fgprops/gen'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '../../pizza-panic/assets/levels/fg')
SHEETS = {
    'fg_props_a.jpg': [['sewer_pipe', 'chain', 'sewer_lamp', 'street_lamp', 'fence', 'hydrant'],
                       ['power_cable', 'cone', 'skate_rail', 'subway_pillar', 'turnstile']],
    'fg_props_b.jpg': [['water_tower', 'antenna', 'ac_unit', 'bollard', 'crates'],
                       ['dock_lamp', 'cargo_net', 'server_rack', 'claw_banner', 'data_cables']],
}
MAX_H = 300  # stored height cap; the game draws them darkened, so this is plenty

def key(a):
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    sure = (R > 200) & (G < 70) & (B > 110) & (R - G > 150)
    w = nd.gaussian_filter(sure.astype(np.float32), 25) + 1e-4
    bg = np.stack([nd.gaussian_filter(a[..., c] * sure, 25) / w for c in range(3)], -1)
    d = np.sqrt(((a - bg) ** 2).sum(-1))
    alpha = np.clip((d - 45) / 85, 0, 1); alpha[sure & (d < 75)] = 0
    alpha[nd.binary_erosion(alpha > 0.5, iterations=3)] = 1
    am = np.maximum(alpha, 0.05)[..., None]
    f = np.clip((a - (1 - am) * bg) / am, 0, 255)
    band = (alpha > 0) & ~nd.binary_erosion(alpha > 0.5, iterations=4)
    spill = np.clip(np.minimum(f[..., 0], f[..., 2]) - f[..., 1] - 30, 0, None) * band
    f[..., 0] -= spill * 0.8; f[..., 2] -= spill * 0.8
    # Ground/drop shadows were painted as darkened magenta: a pixel whose colour points
    # the same way as the local background but is darker is shadow -> black at
    # alpha (1 - brightness ratio). Purples in the props (banner, rack trim) carry
    # green and fall outside the cone.
    nb = np.linalg.norm(bg, axis=-1) + 1e-3; na = np.linalg.norm(a, axis=-1) + 1e-3
    cos = (a * bg).sum(-1) / (na * nb)
    shadow = (cos > 0.985) & (alpha > 0) & (a[..., 1] < 60)
    sa = np.clip(1 - na / nb, 0, 1)
    f[shadow] = 0; alpha[shadow] = np.minimum(alpha[shadow], sa[shadow] * 0.9)
    alpha = nd.grey_erosion(alpha, size=(2, 2)) * 0.5 + alpha * 0.5
    return f, alpha

def save(im, path):
    try:
        import imagequant
        q = imagequant.quantize_pil_image(im, dithering_level=0.5, max_colors=128, min_quality=55, max_quality=92)
    except Exception:
        q = im
    buf = io.BytesIO(); q.save(buf, 'PNG', optimize=True)
    open(path, 'wb').write(buf.getvalue()); return len(buf.getvalue())

def main():
    os.makedirs(OUT, exist_ok=True); total = 0; rows_out = []
    for sheet, rows in SHEETS.items():
        a = np.asarray(Image.open(os.path.join(GEN, sheet)).convert('RGB')).astype(np.float32)
        f, alpha = key(a)
        lab, n = nd.label(nd.binary_dilation(alpha > 0.3, iterations=7))
        comps = []
        for i, sl in enumerate(nd.find_objects(lab)):
            m = (lab[sl] == i + 1) & (alpha[sl] > 0.02)
            if m.sum() < 900: continue
            comps.append((sl, i + 1))
        cy = lambda c: (c[0][0].start + c[0][0].stop) / 2
        mid = a.shape[0] / 2
        top = sorted([c for c in comps if cy(c) < mid], key=lambda c: c[0][1].start)
        bot = sorted([c for c in comps if cy(c) >= mid], key=lambda c: c[0][1].start)
        for names, got in zip(rows, (top, bot)):
            assert len(got) == len(names), f'{sheet}: expected {len(names)} props in a row, found {len(got)}'
            for name, (sl, li) in zip(names, got):
                m = lab[sl] == li
                rgba = np.dstack([f[sl], alpha[sl] * 255 * m]).astype(np.uint8)
                im = Image.fromarray(rgba); bb = im.getchannel('A').point(lambda v: 255 if v > 5 else 0).getbbox(); im = im.crop(bb)
                if im.height > MAX_H: im = im.resize((round(im.width * MAX_H / im.height), MAX_H), Image.LANCZOS)
                size = save(im, os.path.join(OUT, name + '.png')); total += size
                rows_out.append((name, im.size, size))
    for r in rows_out: print(f'{r[0]:14s} {r[1][0]:4d}x{r[1][1]:<4d} {r[2] / 1024:6.1f} KB')
    print(f'total {total / 1024:.0f} KB, {len(rows_out)} props')

if __name__ == '__main__':
    main()
