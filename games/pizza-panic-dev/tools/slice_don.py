#!/usr/bin/env python3
"""Don Piedro Savastano hero parts (baba_booey, t_9ec48322f6de4bf7).
Keys /workspace/pizza-story/don/gen/don_parts.jpg (pink bg, key sampled from the border by make_splash.key, with despill),
labels the pieces, builds the 7 rig parts at the turtle pixel scale (torso 68 px tall):
  head (faces right), torso, uarm = the plain blue sleeve section of the top-right arm (glove cut off, stretched a little),
  farm = the other sleeve with the glove, thigh, shin (boot faces right), weapon = the spoon turned upright (bowl up,
  handle down, like the katana art) so it shares turtle_blue's grip and poses, pivot at the handle end.
Adds a 1 px ink outline (the turtles' treatment), quantizes, writes assets/heroes/don_piedro/don_piedro_<part>.png and
prints the MANIFEST section + SOLES.  usage: python slice_don.py [outdir]"""
import io, os, sys, json
import numpy as np
from PIL import Image
from scipy import ndimage as nd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
_argv = sys.argv; sys.argv = [_argv[0]]
import make_splash as MS
sys.argv = _argv
GAME = os.path.join(HERE, '..', '..', 'pizza-panic')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(GAME, 'assets', 'heroes', 'don_piedro')
SRC = '/workspace/pizza-story/don/gen/don_parts.jpg'
INK = (20, 14, 22)
CENTRES = {'head': (380, 140), 'torso': (690, 165), 'arm1': (920, 160), 'arm2': (360, 420), 'thigh': (575, 415), 'shin': (920, 415), 'weapon': (730, 620)}

def save(im, path):
    try:
        import imagequant
        q = imagequant.quantize_pil_image(im, dithering_level=0.5, max_colors=96, min_quality=0, max_quality=95)
    except Exception:
        q = im
    buf = io.BytesIO(); q.save(buf, 'PNG', optimize=True); open(path, 'wb').write(buf.getvalue()); return len(buf.getvalue())

def outline(im):
    a = np.asarray(im).copy(); al = a[..., 3] > 100
    ring = nd.binary_dilation(al, iterations=1) & ~al
    a[ring] = (*INK, 255)
    # darken the existing outermost opaque px a touch so the line reads at 1x
    return Image.fromarray(a)

def trim(im):
    return im.crop(im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox())

def centre_at(al, y, th=96):
    y = int(min(max(y, 0), al.shape[0] - 1)); xs = np.nonzero(al[y] > th)[0]
    for d in range(1, 12):
        if len(xs): break
        for yy in (y - d, y + d):
            if 0 <= yy < al.shape[0]:
                xs = np.nonzero(al[yy] > th)[0]
                if len(xs): break
    return int(round((xs.min() + xs.max()) / 2)) if len(xs) else al.shape[1] // 2

def build():
    rgba_im, _ = MS.key(SRC)
    rgba = np.asarray(rgba_im); al = rgba[..., 3]
    fg = al > 40
    lab, n = nd.label(nd.binary_dilation(fg, iterations=3))
    pieces = {}
    for i, s in enumerate(nd.find_objects(lab)):
        m = (lab[s] == i + 1) & fg[s]
        if m.sum() < 400: continue
        cy, cx = (s[0].start + s[0].stop) / 2, (s[1].start + s[1].stop) / 2
        name = min(CENTRES, key=lambda k: (CENTRES[k][0] - cx) ** 2 + (CENTRES[k][1] - cy) ** 2)
        assert name not in pieces, name
        c = rgba[s].copy(); c[..., 3] = np.where(lab[s] == i + 1, c[..., 3], 0); pieces[name] = trim(Image.fromarray(c))
    assert set(pieces) == set(CENTRES), sorted(pieces)
    k = 68 / pieces['torso'].height
    sc = lambda im, f=1.0, fy=1.0: im.resize((max(1, round(im.width * k * f)), max(1, round(im.height * k * f * fy))), Image.LANCZOS)
    P = {}
    P['torso'] = sc(pieces['torso'])
    P['head'] = sc(pieces['head'], 1.0)
    # arm1: sleeve over a white glove; the sleeve is the rows above the white cuff
    a1 = pieces['arm1']; A = np.asarray(a1).astype(int)
    white = (A[..., 0] > 200) & (A[..., 1] > 200) & (A[..., 2] > 200) & (A[..., 3] > 128)
    rows = np.nonzero(white.sum(1) > a1.width * 0.35)[0]; cuff = int(rows.min())
    sleeve = trim(a1.crop((0, 0, a1.width, cuff - 2)))
    P['uarm'] = sc(sleeve, 1.0, 1.25)
    P['farm'] = sc(pieces['arm2'])
    P['thigh'] = sc(pieces['thigh'])
    P['shin'] = sc(pieces['shin'])
    sp = pieces['weapon'].rotate(90, expand=True, resample=Image.BICUBIC)  # handle left -> bottom, bowl right -> top
    sp = trim(sp); f = 112 / sp.height
    P['weapon'] = sp.resize((max(1, round(sp.width * f)), 112), Image.LANCZOS)
    for p in P: P[p] = outline(P[p])
    W = {p: im.size for p, im in P.items()}; AL = {p: np.asarray(im.getchannel('A')) for p, im in P.items()}
    top = lambda p, f=0.12: (centre_at(AL[p], round(W[p][1] * f)), round(W[p][1] * f))
    bot = lambda p, f=0.12: (centre_at(AL[p], W[p][1] - 1 - round(W[p][1] * f)), W[p][1] - 1 - round(W[p][1] * f))
    tw, th = W['torso']
    hy = W['head'][1] - 1 - round(W['head'][1] * 0.1)
    rows = {
        'head': ((centre_at(AL['head'], hy) - 4, hy), 'torso', (centre_at(AL['torso'], 6), 7)),
        'torso': ((tw // 2, th // 2), None, None),
        'uarm': (top('uarm', 0.1), 'torso', (round(tw * 0.58), 16)),
        'farm': (top('farm', 0.1), 'uarm', bot('uarm', 0.1)),
        'thigh': (top('thigh', 0.14), 'torso', (round(tw * 0.5), th - 8)),
        'shin': (top('shin', 0.12), 'thigh', bot('thigh', 0.12)),
        # fist: low on the glove; weapon pivot: the handle end, above the hanging hole
        'weapon': ((centre_at(AL['weapon'], W['weapon'][1] - 1 - round(W['weapon'][1] * 0.12)), W['weapon'][1] - 1 - round(W['weapon'][1] * 0.12)), 'farm', bot('farm', 0.14)),
    }
    os.makedirs(OUT, exist_ok=True); total = 0
    for p in P: total += save(P[p], os.path.join(OUT, f'don_piedro_{p}.png'))
    sh = AL['shin']; ys = np.nonzero(sh.max(1) > 96)[0]; yb = int(ys.max()); xs = np.nonzero(sh[yb - 2] > 96)[0]
    soles = [[int(xs.min()) + 1, yb], [int(xs.max()) - 1, yb]]
    md = ['| part | image | size | pivot | parent | attach |', '|---|---|---|---|---|---|']
    for p in ['head', 'torso', 'uarm', 'farm', 'thigh', 'shin', 'weapon']:
        (px, py), par, att = rows[p]
        md.append(f'| {p} | don_piedro_{p}.png | {W[p][0]}x{W[p][1]} | {px},{py} | {par or "-"} | {f"{att[0]},{att[1]}" if att else "-"} |')
    print('\n'.join(md)); print('SOLES', json.dumps(soles)); print(f'total {total/1024:.1f} KB')

if __name__ == '__main__':
    build()
