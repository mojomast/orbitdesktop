"""In-combat reaction portraits, hurt + win (baba_booey, t_718b285057564079).

Sources: /workspace/pizza-art/reactions/gen/<id>.jpg (magenta, HURT bust on the left half,
WIN bust on the right). Each bust is keyed with make_splash.key (border-connected magenta
only, so purple bandanas stay), cut to its largest blobs, and laid on the same 240x300 card
as the select portraits (make_portraits.bg gradient, drop shadow, bottom vignette), bottom
aligned so the bust's cut edge sits under the vignette. The painted heroes (Nous Girl,
Teknium, TurboFit) get a light 2x pixelate + posterize so they sit next to the pixel cards.
No baked text.

Output: ONE atlas, ../pizza-panic/assets/heroes/portraits/reactions.png, 480x2100 RGB:
row r = HEROES[r] (heroes.js order), column 0 = hurt, column 1 = win, 240x300 cells.
Idle stays <id>.png. Per-card previews + contact sheet go to /workspace/pizza-art/reactions/.
usage: python3 make_reactions.py [src dir] [atlas path]
"""
import os, sys
import numpy as np
from PIL import Image, ImageFilter, ImageOps
from scipy import ndimage as ndi
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
SRC = sys.argv[1] if len(sys.argv) > 1 else '/workspace/pizza-art/reactions/gen'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', '..', 'pizza-panic', 'assets', 'heroes', 'portraits', 'reactions.png')
_argv = sys.argv; sys.argv = sys.argv[:1]
import make_splash, make_portraits  # noqa: E402  (both read sys.argv at import)
sys.argv = _argv
W, H = make_portraits.W, make_portraits.H
HEROES = ['turtle_purple', 'turtle_blue', 'turtle_red', 'turtle_orange', 'nous_girl', 'teknium', 'turbofit']  # heroes.js order
PAINTED = {'nous_girl', 'teknium', 'turbofit'}
MOODS = ['hurt', 'win']
PREV = '/workspace/pizza-art/reactions/cards'


def unpink(path, rgba):
    """Clean the matte edge. (1) magenta trapped in wispy hair / between fingers (pockets too
    small for make_splash's pocket pass) fades out by its distance from the bg colour;
    (2) every semi-transparent pixel, and every dark magenta-tinted one (hair strands blended
    with the bg), takes its colour from the nearest clean opaque pixel, so edges never carry
    pink, and unmixing never invents green on skin blends. Blue-leaning purple (b > r/0.8,
    the purple bandana) is never treated as tint."""
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    border = np.concatenate([im[:4].reshape(-1, 3), im[:, :4].reshape(-1, 3), im[:, -4:].reshape(-1, 3)])
    B = np.median(border[(border[:, 0] > 180) & (border[:, 1] < 60)], axis=0)
    arr = np.asarray(rgba).astype(np.float32); r, g, b = im[..., 0], im[..., 1], im[..., 2]
    al = arr[..., 3] / 255
    d = np.sqrt(((im - B) ** 2).sum(-1))
    tint = (np.minimum(r, b) - g > 15) & (r >= b * 0.8)
    pink = tint & (np.minimum(r, b) - g > 25) & (d < 170) & (al > 0)
    al = np.where(pink, np.minimum(al, np.clip((d - 40) / 130, 0, 1)), al)
    fringe = (al > 0) & ((al < 0.97) | tint)
    good = (al >= 0.97) & ~tint
    _, (iy, ix) = ndi.distance_transform_edt(~good, return_indices=True)
    rgb = arr[..., :3].copy(); src = im[iy, ix]
    rgb[fringe] = src[fringe] * np.where(tint[fringe], 0.8, 1.0)[:, None]  # tinted strands: a shade darker
    return Image.fromarray(np.dstack([np.clip(rgb, 0, 255), al * 255]).astype(np.uint8), 'RGBA')


def bust(rgba, half):
    w = rgba.width // 2; im = rgba.crop((half * w, 0, half * w + w, rgba.height))
    a = np.asarray(im)[..., 3] > 128
    lab, n = ndi.label(ndi.binary_dilation(a, iterations=3))
    if n > 1:
        sizes = ndi.sum(np.ones_like(a), lab, range(1, n + 1)); keep = np.isin(lab, 1 + np.nonzero(sizes >= sizes.max() * 0.04)[0])
        arr = np.asarray(im).copy(); arr[..., 3] = (arr[..., 3] * keep).astype(np.uint8); im = Image.fromarray(arr, 'RGBA')
    bb = im.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    return im.crop(bb)


def card(h, b):
    s = min(248 / b.width, 276 / b.height)  # a touch wider than the card: weapon tips may run off the sides
    dw, dh = round(b.width * s), round(b.height * s)
    if h in PAINTED:  # light pixelate + posterize toward the pixel-art cards
        sm = b.resize((max(1, dw // 2), max(1, dh // 2)), Image.LANCZOS)
        rgb = ImageOps.posterize(sm.convert('RGB'), 5); al = sm.getchannel('A').point(lambda v: 0 if v < 70 else (255 if v > 170 else v))
        sm = rgb.convert('RGBA'); sm.putalpha(al); fig = sm.resize((dw, dh), Image.NEAREST)
    else:
        fig = b.resize((dw, dh), Image.LANCZOS)
    c = make_portraits.bg(h)
    x, y = W // 2 - dw // 2, H - dh + 4  # bottom aligned; the cut edge runs under the vignette
    sa = Image.new('RGBA', c.size, (0, 0, 0, 0)); sa.alpha_composite(fig, (x, max(0, y)) if y >= 0 else (x, 0))
    sh = np.array(sa); sh[..., :3] = 0; sh[..., 3] = (sh[..., 3] * 0.45).astype(np.uint8)
    c.alpha_composite(Image.fromarray(sh).filter(ImageFilter.GaussianBlur(5)), (5, 6))
    c.alpha_composite(sa)
    v = np.zeros((H, W, 4), np.uint8); ramp = np.clip((np.arange(H) - (H - 60)) / 60, 0, 1) * 170; v[..., 3] = ramp[:, None].astype(np.uint8)
    c.alpha_composite(Image.fromarray(v, 'RGBA'))
    return c.convert('RGB')


if __name__ == '__main__':
    os.makedirs(PREV, exist_ok=True)
    atlas = Image.new('RGB', (W * 2, H * len(HEROES)))
    for r, h in enumerate(HEROES):
        src = os.path.join(SRC, h + '.jpg'); rgba, _ = make_splash.key(src); rgba = unpink(src, rgba)
        for col, mood in enumerate(MOODS):
            cd = card(h, bust(rgba, col)); cd.save(os.path.join(PREV, f'{h}_{mood}.png'))
            atlas.paste(cd, (col * W, r * H))
    atlas.save(OUT, optimize=True); print('wrote', OUT, os.path.getsize(OUT), 'bytes')
