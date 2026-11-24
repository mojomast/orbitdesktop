#!/usr/bin/env python3
"""Skate-run near-field foreground props (baba_booey, t_ff6cf63cc2c04b1e).
Keys /workspace/pizza-bg/skate-fg/gen/sheet1.jpg + sheet2.jpg (4 props each, left to right),
cuts one sprite per prop and packs them into ONE palette PNG atlas
games/pizza-panic/assets/levels/skate/fg/skate_fg.png; prints the frame map that parallax.js
carries inline (FG_ATLAS). Keying: build_fgprops.key (local-bg distance + painted-shadow cone)
for everything except the pink neon arrow, whose tube fill is itself a darker magenta: it uses
make_splash.key (only border-connected near-key pixels are background, tight tolerance, edge
unmix) and skips the shadow cone. The cyan slice sign's loose brick ledge is cropped off.
usage: python3 build_skatefg.py [gen dir] [atlas path] [preview dir]   (imagequant: /workspace/pizza-victory/venv)"""
import io, json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as nd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
GEN = sys.argv[1] if len(sys.argv) > 1 else '/workspace/pizza-bg/skate-fg/gen'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '../../pizza-panic/assets/levels/skate/fg/skate_fg.png')
PREV = sys.argv[3] if len(sys.argv) > 3 else '/workspace/pizza-bg/skate-fg/cut'
_a = sys.argv; sys.argv = _a[:1]
import build_fgprops, make_splash  # noqa: E402
sys.argv = _a
SHEETS = {'sheet1.jpg': ['trash_bags', 'barricade', 'dumpster', 'tire_stack'],
          'sheet2.jpg': ['neon_slice', 'arrow_sign', 'hanging_cables', 'no_entry']}
MAX_H, PAD, ATLAS_W = 300, 2, 1024


def comps(alpha, min_px=900):
    lab, n = nd.label(nd.binary_dilation(alpha > 0.3, iterations=7))
    out = []
    for i, sl in enumerate(nd.find_objects(lab)):
        m = (lab[sl] == i + 1) & (alpha[sl] > 0.02)
        if m.sum() >= min_px: out.append((sl, i + 1, lab))
    return out


def cut(f, alpha, sl, li, lab):
    m = lab[sl] == li
    im = Image.fromarray(np.dstack([np.clip(f[sl], 0, 255), alpha[sl] * 255 * m]).astype(np.uint8), 'RGBA')
    im = im.crop(im.getchannel('A').point(lambda v: 255 if v > 5 else 0).getbbox())
    if im.height > MAX_H: im = im.resize((round(im.width * MAX_H / im.height), MAX_H), Image.LANCZOS)
    return im


def keyed(path, tight=False):
    """make_splash.key (border-connected background only, edge unmix). tight: the pink neon
    arrow, whose fill is a darker magenta, gets a narrow tolerance so the flood stops at its tube."""
    if tight: old = (make_splash.T0, make_splash.T1, make_splash.TA); make_splash.T0, make_splash.T1, make_splash.TA = 30, 70, 120
    try: rgba, _ = make_splash.key(path)
    finally:
        if tight: make_splash.T0, make_splash.T1, make_splash.TA = old
    k = np.asarray(rgba).astype(np.float32); f, alpha = k[..., :3].copy(), k[..., 3] / 255
    if not tight:
        # painted ground shadows are darkened key colour: same direction as B, darker -> black, alpha by darkness
        im = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
        border = np.concatenate([im[:4].reshape(-1, 3), im[:, :4].reshape(-1, 3), im[:, -4:].reshape(-1, 3)])
        B = np.median(border[(border[:, 0] > 180) & (border[:, 1] < 60)], axis=0)
        na = np.linalg.norm(im, axis=-1) + 1e-3; nb = np.linalg.norm(B) + 1e-3
        cos = (im * B).sum(-1) / (na * nb)
        sh = (cos > 0.985) & (alpha > 0) & (im[..., 1] < 60)
        f[sh] = 0; alpha[sh] = np.minimum(alpha[sh], np.clip(1 - na[sh] / nb, 0, 1) * 0.9)
    return f, alpha


def save(im, path, keep=None):
    """Palette PNG. The quantizer can snap a stray dark edge pixel to a key-pink palette entry:
    after quantizing, key-pink pixels on a matte edge (or anywhere outside `keep`, the pink
    arrow's frame, whose neon glow is that pink) are pointed at the transparent entry."""
    import imagequant
    q = imagequant.quantize_pil_image(im, dithering_level=0.0, max_colors=256, min_quality=0, max_quality=95)
    rgba = np.asarray(q.convert('RGBA')).astype(np.float32); idx = np.array(q)
    a = rgba[..., 3]; kp = (a > 0) & (np.sqrt(((rgba[..., :3] - np.array([252, 3, 165])) ** 2).sum(-1)) < 75)  # margin: canvas premultiply shifts edge colours
    edge = nd.binary_dilation(a < 128, structure=np.ones((5, 5), bool))  # within 2 px (square), as check-skatefg counts
    inside = np.zeros(a.shape, bool)
    if keep: x, y, w, h = keep; inside[y:y + h, x:x + w] = True
    bad = kp & (edge | ~inside)
    if bad.any():
        # repoint each to the nearest non-pink opaque palette entry to its PRE-quantize colour
        # (an outline stays an outline), or to the transparent entry if it was see-through
        src = np.asarray(im).astype(np.float32)
        pal = np.array(q.getpalette()[:768], np.float32).reshape(-1, 3)
        trns = q.info.get('transparency'); pa = np.full(len(pal), 255.0)
        if isinstance(trns, (bytes, bytearray)): pa[:len(trns)] = list(trns)
        okp = (pa >= 200) & (np.sqrt(((pal - np.array([252, 3, 165])) ** 2).sum(-1)) >= 75)
        cand = np.nonzero(okp)[0]; t = int(np.argmin(pa))
        pix = q.load()
        for yy, xx in zip(*np.nonzero(bad)):
            o = src[yy, xx]
            pix[int(xx), int(yy)] = t if o[3] < 128 else int(cand[np.argmin(((pal[cand] - o[:3]) ** 2).sum(-1))])
    buf = io.BytesIO(); q.save(buf, 'PNG', optimize=True)
    open(path, 'wb').write(buf.getvalue()); return len(buf.getvalue()), int(bad.sum())


def main():
    sprites = {}
    for sheet, names in SHEETS.items():
        path = os.path.join(GEN, sheet)
        f, alpha = keyed(path)
        cs = comps(alpha)
        cs.sort(key=lambda c: c[0][1].start)
        if sheet == 'sheet2.jpg':
            # drop the brick ledge: the short wide blob below the slice sign
            ledge = [c for c in cs if (c[0][0].stop - c[0][0].start) < 110 and c[0][0].start > 380 and c[0][1].stop < 400]
            assert len(ledge) == 1, 'ledge not found'; cs = [c for c in cs if c is not ledge[0]]
        assert len(cs) == len(names), f'{sheet}: {len(cs)} props, expected {len(names)}'
        for name, (sl, li, lab) in zip(names, cs):
            if name == 'arrow_sign':
                tf, ta = keyed(path, tight=True)
                e = (ta > 0) & (ta < 1) & (tf[..., 1] > np.minimum(tf[..., 0], tf[..., 2]) + 10)  # unmix went green on the rim
                tf[..., 1][e] = np.minimum(tf[..., 0], tf[..., 2])[e]
                m = np.zeros(ta.shape, bool); m[sl] = True
                lab2, _n = nd.label(nd.binary_dilation((ta > 0.3) & m, iterations=7))
                big = np.argmax(nd.sum(np.ones_like(ta), lab2, range(1, _n + 1))) + 1
                full = (slice(0, ta.shape[0]), slice(0, ta.shape[1]))
                sprites[name] = cut(tf, ta, full, big, lab2)
            else:
                kp = np.sqrt(((f - np.array([252, 3, 165])) ** 2).sum(-1)) < 60  # stray key-pink left on a matte edge
                sprites[name] = cut(f, np.where(kp, 0, alpha), sl, li, lab)
    # shelf pack, tallest first
    order = sorted(sprites, key=lambda n: -sprites[n].height)
    x = y = shelf = 0; frames = {}
    for n in order:
        im = sprites[n]
        if x + im.width + PAD > ATLAS_W: x, y, shelf = 0, y + shelf + PAD, 0
        frames[n] = [x, y, im.width, im.height]; x += im.width + PAD; shelf = max(shelf, im.height)
    H = y + shelf
    atlas = Image.new('RGBA', (ATLAS_W, H), (0, 0, 0, 0))
    os.makedirs(PREV, exist_ok=True)
    for n, (fx, fy, w, h) in frames.items(): atlas.alpha_composite(sprites[n], (fx, fy)); sprites[n].save(os.path.join(PREV, n + '.png'))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    size, fixed = save(atlas, OUT, keep=frames['arrow_sign'])
    print(f'wrote {OUT} {ATLAS_W}x{H} {size / 1024:.1f} KB ({fixed} stray key-pink px cleared after quantizing)')
    print(json.dumps({k: frames[k] for k in sum(SHEETS.values(), [])}))


if __name__ == '__main__':
    main()
