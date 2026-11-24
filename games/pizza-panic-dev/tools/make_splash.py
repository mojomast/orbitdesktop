"""Boss intro splash cards (baba_booey, t_0577948bb62442f8).

Keys the comic boss busts in pizza-panic-dev/splash-src/<id>.jpg (flat magenta bg)
into transparent PNGs under pizza-panic/assets/bosses/splash/<id>.png, plus
splash.json (size + whether the bust is cut off at the bottom edge).

Key: background colour B = median of the border; a pixel is background only if
it is close to B AND connected to the border (flood fill), or it lies in a large
enclosed pocket whose mean colour is ~B. So purple inside the figure (SHREDCLAW's
armour, the conductor's lantern glow) is never keyed. Edge pixels are unmixed
(F = (C - (1-a)B) / a) to despill, then every card gets the same 3 px ink
outline and the same light grade, trimmed and resized to 512 px wide.
usage: python3 make_splash.py [src dir] [out dir]   (needs numpy, scipy, PIL; imagequant optional)
"""
import io, json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', 'splash-src')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', '..', 'pizza-panic', 'assets', 'bosses', 'splash')
IDS = ['enforcer', 'bruiser', 'rider', 'skytalon', 'shredclaw', 'conductor', 'hookclaw', 'highscore', 'mech']
WIDTH, INK, OUTLINE = 512, (18, 10, 22), 3
T0, T1, TA = 48, 135, 205   # colour distance from B: <=T0 background; <T1 joins the bg region; alpha ramps to opaque at TA


def key(path):
    im = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    h, w, _ = im.shape
    border = np.concatenate([im[:4].reshape(-1, 3), im[:, :4].reshape(-1, 3), im[:, -4:].reshape(-1, 3)])
    B = np.median(border[(border[:, 0] > 180) & (border[:, 1] < 60)], axis=0)
    d = np.sqrt(((im - B) ** 2).sum(-1))
    cand = d < T1
    lab, n = ndi.label(cand)
    edge = set(np.unique(np.concatenate([lab[0], lab[:, 0], lab[:, -1], lab[-1][d[-1] < T0]]))) - {0}
    bgreg = np.isin(lab, list(edge))
    # enclosed pockets of pure background (gaps between arms, legs, wings)
    core, m = ndi.label(d < T0)
    if m:
        idx = np.arange(1, m + 1)
        area = ndi.sum(np.ones_like(d), core, idx); mean = ndi.mean(d, core, idx)
        keep = idx[(area >= 30) & (mean < 34)]
        pocket = np.isin(core, keep)
        grown = ndi.binary_dilation(pocket, iterations=4) & cand
        bgreg |= grown
    # JPEG blends of the thin black outline with the bg (e.g. 136,0,107) sit just past T1:
    # include a 2 px rim around the bg region and ramp alpha over a wider range there.
    bgreg = ndi.binary_dilation(bgreg, iterations=2) & (d < TA)
    a = np.ones((h, w), np.float32)
    a[bgreg] = np.clip((d[bgreg] - T0) / (TA - T0), 0, 1)
    a = np.where(a < 0.06, 0, a)
    # despill: unmix the background out of edge pixels
    am = np.maximum(a, 1e-3)[..., None]
    F = np.clip((im - (1 - am) * B) / am, 0, 255)
    rgb = np.where((a > 0) & (a < 1), 0, 1)[..., None] * im + np.where((a > 0) & (a < 1), 1, 0)[..., None] * F
    # pink fringe left on opaque edge pixels -> ink (only right next to transparency)
    nearT = ndi.binary_dilation(a < 0.5, iterations=2) & (a >= 0.5)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    pink = nearT & (r > 170) & (g < 70) & (b > 90) & (r > b * 0.95)  # magenta-red, not blue-purple
    rgb[pink] = rgb[pink] * 0.25 + np.array(INK) * 0.75
    # dark ink+magenta JPEG blends on the outline (red ~ blue >> green): pull to ink, keep luminance-free purple (b >> r) alone
    band = ndi.binary_dilation(a < 0.5, iterations=3) & (a >= 0.5)
    murk = band & (r > g + 35) & (b > g + 25) & (r >= b * 0.8) & (r < 200)
    rgb[murk] = rgb[murk] * 0.3 + np.array(INK) * 0.7
    rgba = np.dstack([rgb, a * 255]).astype(np.uint8)
    cut = bool((a[-3:] > 0.5).mean() > 0.04)  # bust runs off the bottom edge
    return Image.fromarray(rgba, 'RGBA'), cut


def finish(im, cut):
    bb = im.getchannel('A').point(lambda v: 255 if v > 20 else 0).getbbox(); im = im.crop(bb)
    s = (WIDTH - 2 * OUTLINE) / im.width
    im = im.resize((WIDTH - 2 * OUTLINE, round(im.height * s)), Image.LANCZOS)
    pad_b = 0 if cut else OUTLINE
    can = Image.new('RGBA', (WIDTH, im.height + OUTLINE + pad_b), (0, 0, 0, 0)); can.alpha_composite(im, (OUTLINE, OUTLINE))
    arr = np.asarray(can).astype(np.float32)
    al = arr[..., 3] / 255
    ring = ndi.grey_dilation(al, footprint=np.array([[abs(x) + abs(y) <= OUTLINE for x in range(-OUTLINE, OUTLINE + 1)] for y in range(-OUTLINE, OUTLINE + 1)]))
    out = np.zeros_like(arr)
    out[..., :3] = arr[..., :3] * al[..., None] + np.array(INK) * (1 - al[..., None])
    out[..., 3] = np.maximum(al, ring) * 255
    # shared grade: slight contrast + saturation lift so the nine cards sit together
    rgb = out[..., :3]; lum = rgb.mean(-1, keepdims=True)
    rgb = np.clip((lum + (rgb - lum) * 1.08 - 128) * 1.05 + 128, 0, 255)
    out[..., :3] = rgb
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


def save(im, path):
    try:
        import imagequant
        q = imagequant.quantize_pil_image(im, dithering_level=0.8, max_colors=256, min_quality=55, max_quality=92)
    except Exception:
        q = im
    buf = io.BytesIO(); q.save(buf, 'PNG', optimize=True); open(path, 'wb').write(buf.getvalue()); return len(buf.getvalue())


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True); meta = {}
    for i in IDS:
        im, cut = key(os.path.join(SRC, i + '.jpg'))
        im = finish(im, cut)
        n = save(im, os.path.join(OUT, i + '.png'))
        meta[i] = {'w': im.width, 'h': im.height, 'cut': cut}
        print(f'{i}: {im.width}x{im.height} cut={cut} {n / 1024:.1f} KB')
    json.dump(meta, open(os.path.join(OUT, 'splash.json'), 'w'), indent=1)
