#!/usr/bin/env python3
"""AGENT ARMEGEDDON title art (baba_booey, t_9ec48322f6de4bf7) from /workspace/pizza-story/don/gen/.
  title_plate.jpg -> assets/cine/title/plate.jpg (cover-fit 1280x720)
  title_logo.jpg  -> assets/cine/title/logo.png (600 px wide) and assets/logo.png (fit 360x141)
Logo key: the key colour is sampled from the four corners; alpha ramps on the colour distance with a TIGHT
threshold (the claw scratches glow red/orange, which sits much closer to the pink than the chrome letters do)
and only for pixels connected to the border background or in enclosed pure-key pockets; then the key colour is
unmixed out of the soft edge (despill) so the glow keeps its red/orange instead of going pink.
usage: python build_title_art.py [outdir-root]"""
import os, sys, io
import numpy as np
from PIL import Image
from scipy import ndimage as nd
HERE = os.path.dirname(os.path.abspath(__file__))
GAME = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '..', 'pizza-panic')
SRC = '/workspace/pizza-story/don/gen'
T0, T1, TA = 38, 80, 150

def plate():
    im = Image.open(os.path.join(SRC, 'title_plate.jpg')).convert('RGB')
    s = max(1280 / im.width, 720 / im.height); im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    x0, y0 = (im.width - 1280) // 2, (im.height - 720) // 2; im = im.crop((x0, y0, x0 + 1280, y0 + 720))
    p = os.path.join(GAME, 'assets/cine/title/plate.jpg'); im.save(p, quality=84, optimize=True, progressive=True); print('plate', im.size, os.path.getsize(p))

def key_logo():
    a = np.asarray(Image.open(os.path.join(SRC, 'title_logo.jpg')).convert('RGB')).astype(np.float32)
    h, w, _ = a.shape
    K = np.median(np.concatenate([a[:16, :16], a[:16, -16:], a[-16:, :16], a[-16:, -16:]]).reshape(-1, 3), axis=0)
    d = np.sqrt(((a - K) ** 2).sum(-1))
    cand = d < T1
    lab, n = nd.label(cand)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bg = np.isin(lab, list(edge))
    core, m = nd.label(d < T0)   # enclosed pockets (inside A, O, P...) of near-pure key
    if m:
        idx = np.arange(1, m + 1); area = nd.sum(np.ones_like(d), core, idx); mean = nd.mean(d, core, idx)
        bg |= nd.binary_dilation(np.isin(core, idx[(area >= 40) & (mean < 24)]), iterations=3) & cand
    bg = nd.binary_dilation(bg, iterations=2) & (d < TA)
    al = np.ones((h, w), np.float32); al[bg] = np.clip((d[bg] - T0) / (TA - T0), 0, 1); al[al < 0.05] = 0
    am = np.maximum(al, 1e-3)[..., None]
    F = np.clip((a - (1 - am) * K) / am, 0, 255)
    soft = (al > 0) & (al < 1)
    rgb = np.where(soft[..., None], F, a)
    # remaining pink cast on the soft rim: magenta = R and B both high over G; pull B down toward G (keeps red/orange glow)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    rim = nd.binary_dilation(al < 0.6, iterations=3) & (al > 0)
    pink = rim & (b > g + 30) & (r > 120)
    gr = np.minimum(g + 12, 255)
    for c in range(3): rgb[..., c] = np.where(pink, gr, rgb[..., c])   # neutral (chrome/shadow) rim, not red
    # the drop shadow under the letters is darkened key (s*K): turn it into a real black shadow with alpha 1-s
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    shade = (al > 0) & (b - g > 35) & (r - g > 55)
    sk = np.clip((a * K).sum(-1) / (K * K).sum(), 0, 1)
    al = np.where(shade, np.minimum(al, np.clip(1 - sk, 0, 1) * 0.85), al)
    rgb = np.where(shade[..., None], 10, rgb)
    out = Image.fromarray(np.dstack([np.clip(rgb, 0, 255), al * 255]).astype(np.uint8), 'RGBA')
    return out.crop(out.getchannel('A').point(lambda v: 255 if v > 10 else 0).getbbox())

def save(im, p):
    import imagequant
    q = imagequant.quantize_pil_image(im, dithering_level=0.7, max_colors=256, min_quality=0, max_quality=96)
    buf = io.BytesIO(); q.save(buf, 'PNG', optimize=True); open(p, 'wb').write(buf.getvalue()); return len(buf.getvalue())

def logo():
    L = key_logo(); print('logo bbox', L.size)
    big = L.resize((600, round(600 * L.height / L.width)), Image.LANCZOS)
    print('cine logo', big.size, save(big, os.path.join(GAME, 'assets/cine/title/logo.png')))
    s = min(360 / L.width, 141 / L.height); small = L.resize((round(L.width * s), round(L.height * s)), Image.LANCZOS)
    print('logo.png', small.size, save(small, os.path.join(GAME, 'assets/logo.png')))
    prev = Image.new('RGBA', big.size, (20, 20, 30, 255)); prev.alpha_composite(big); prev.save('/workspace/pizza-story/don/work/logo-on-dark.png')
    prev = Image.new('RGBA', big.size, (230, 230, 230, 255)); prev.alpha_composite(big); prev.save('/workspace/pizza-story/don/work/logo-on-light.png')

if __name__ == '__main__':
    plate(); logo()
