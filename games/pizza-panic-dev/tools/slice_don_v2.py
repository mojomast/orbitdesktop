#!/usr/bin/env python3
"""Don Piedro v2 parts (baba_booey, t_9ec48322f6de4bf7; Kyle's redo: grumpier, painted, turtle-sized).
Keys /workspace/pizza-story/don/gen/don_parts_v2.jpg (magenta, key sampled from the border by make_splash.key,
despilled), drops the baked label numbers ('1)', '(2)'...: small components), labels the 7 parts by position:
1 head (front, scowl, scar, scouter), 2 torso WITH the yellow shoulder pads, 3 upper arm (sleeve; the cuff ring is
cut off), 4 forearm + fist, 5 thigh, 6 boot shin facing right, 7 spoon (stood upright, bowl up, like the katana art
so turtle_blue's grip / keyframes still fit). One scale K for the whole body, chosen so the rig stands as tall as
turtle_red / turbofit (~193 px head-top to sole); the pads' overhang is squeezed (PAD_SQUEEZE) so the silhouette
only widens a bit. 1 px ink outline + saturation trim like the turtle parts; writes IN PLACE over
assets/heroes/don_piedro/don_piedro_<part>.png and prints the MANIFEST table. usage: slice_don_v2.py [outdir]"""
import os, sys, json
import numpy as np
from PIL import Image, ImageEnhance
from scipy import ndimage as nd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
_argv = sys.argv; sys.argv = [_argv[0]]
import make_splash as MS
import slice_don as SD
sys.argv = _argv
GAME = os.path.join(HERE, '..', '..', 'pizza-panic')
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(GAME, 'assets', 'heroes', 'don_piedro')
SRC = '/workspace/pizza-story/don/gen/don_parts_v2.jpg'
# part centres in the 1280x720 sheet
CENTRES = {'head': (225, 205), 'torso': (585, 230), 'uarm': (905, 215), 'farm': (1110, 235), 'thigh': (210, 525), 'shin': (485, 535), 'weapon': (925, 535)}
TORSO_H = 68          # px; turtle_red / turbofit torsos are 68
PAD_SQUEEZE = 0.62
SAT = 1.12            # painted source is a little duller than the turtle parts
SPOON_H = 112         # same weapon length as v1 (grip 120 like turtle_blue)

def pieces_of():
    rgba_im, _ = MS.key(SRC)
    rgba = np.asarray(rgba_im); al = rgba[..., 3]; fg = al > 40
    lab, n = nd.label(nd.binary_dilation(fg, iterations=3))
    out = {}
    for i, s in enumerate(nd.find_objects(lab)):
        m = (lab[s] == i + 1) & fg[s]
        if m.sum() < 2500: continue          # label digits / parentheses
        cy, cx = (s[0].start + s[0].stop) / 2, (s[1].start + s[1].stop) / 2
        name = min(CENTRES, key=lambda k: (CENTRES[k][0] - cx) ** 2 + (CENTRES[k][1] - cy) ** 2)
        assert name not in out, (name, cx, cy)
        c = rgba[s].copy(); c[..., 3] = np.where(lab[s] == i + 1, c[..., 3], 0)
        out[name] = SD.trim(Image.fromarray(c)); print(name, out[name].size, 'at', round(cx), round(cy))
    assert set(out) == set(CENTRES), sorted(out)
    return out

def squeeze_pads(im):
    a = np.asarray(im).astype(np.float32); al = a[..., 3]; h, w = al.shape
    row = np.nonzero(al[int(h * 0.62)] > 128)[0]; c0, c1 = row.min(), row.max()
    nx0 = c0 * (1 - PAD_SQUEEZE); nx1 = c1 + (w - 1 - c1) * PAD_SQUEEZE; nw = int(np.ceil(nx1 - nx0)) + 1
    dst = np.arange(nw, dtype=np.float32) + nx0
    srcx = np.where(dst < c0, c0 - (c0 - dst) / PAD_SQUEEZE, np.where(dst > c1, c1 + (dst - c1) / PAD_SQUEEZE, dst))
    o = np.stack([np.stack([np.interp(srcx, np.arange(w), a[y, :, ch]) for ch in range(4)], -1) for y in range(h)])
    return Image.fromarray(np.clip(o, 0, 255).astype(np.uint8), 'RGBA')

def sat(im):
    rgb = ImageEnhance.Color(im.convert('RGB')).enhance(SAT); rgb.putalpha(im.getchannel('A')); return rgb

def build():
    pc = pieces_of()
    K = TORSO_H / pc['torso'].height
    sc = lambda im, f=1.0, fy=1.0: im.resize((max(1, round(im.width * K * f)), max(1, round(im.height * K * f * fy))), Image.LANCZOS)
    P = {}
    P['torso'] = sc(squeeze_pads(pc['torso']))
    P['head'] = sc(pc['head'], 1.0)
    a1 = pc['uarm']; A = np.asarray(a1).astype(int)
    white = (A[..., 0] > 170) & (A[..., 1] > 170) & (A[..., 2] > 160) & (A[..., 3] > 128)
    rows = np.nonzero(white.sum(1) > a1.width * 0.35)[0]; cuff = int(rows.min())
    P['uarm'] = sc(SD.trim(a1.crop((0, 0, a1.width, cuff + 6))))     # sleeve (+ the cuff's top lip)
    P['farm'] = sc(pc['farm'])
    P['thigh'] = sc(pc['thigh'])
    P['shin'] = sc(pc['shin'])
    sp = SD.trim(pc['weapon'].rotate(90, expand=True, resample=Image.BICUBIC)); f = SPOON_H / sp.height
    P['weapon'] = sp.resize((max(1, round(sp.width * f)), SPOON_H), Image.LANCZOS)
    for p in P: P[p] = SD.outline(sat(P[p]))
    W = {p: im.size for p, im in P.items()}; AL = {p: np.asarray(im.getchannel('A')) for p, im in P.items()}
    top = lambda p, f=0.12: (SD.centre_at(AL[p], round(W[p][1] * f)), round(W[p][1] * f))
    bot = lambda p, f=0.12: (SD.centre_at(AL[p], W[p][1] - 1 - round(W[p][1] * f)), W[p][1] - 1 - round(W[p][1] * f))
    tw, th = W['torso']
    # torso landmarks: collar centre (head), shoulder joint just under the front pad, hips
    tA = AL['torso']; chest = np.nonzero(tA[int(th * 0.62)] > 128)[0]; cl, cr = int(chest.min()), int(chest.max())
    padrows = [y for y in range(th) if (tA[y] > 128).sum() > (cr - cl) + 10]; pad_bot = max(padrows) if padrows else 16
    hy = W['head'][1] - 1 - round(W['head'][1] * 0.08)
    cx = (cl + cr) // 2
    rows = {
        'head': ((SD.centre_at(AL['head'], hy), hy), 'torso', (cx, 6)),
        'torso': ((cx, th // 2), None, None),
        'uarm': (top('uarm', 0.1), 'torso', (cl + round((cr - cl) * 0.66), min(pad_bot, round(th * 0.3)))),
        'farm': (top('farm', 0.08), 'uarm', bot('uarm', 0.1)),
        'thigh': (top('thigh', 0.14), 'torso', (cx + 2, th - 8)),
        'shin': (top('shin', 0.1), 'thigh', bot('thigh', 0.12)),
        'weapon': ((SD.centre_at(AL['weapon'], W['weapon'][1] - 1 - round(W['weapon'][1] * 0.12)), W['weapon'][1] - 1 - round(W['weapon'][1] * 0.12)), 'farm', bot('farm', 0.14)),
    }
    os.makedirs(OUT, exist_ok=True); total = 0
    for p in P: total += SD.save(P[p], os.path.join(OUT, f'don_piedro_{p}.png'))
    sh = AL['shin']; ys = np.nonzero(sh.max(1) > 96)[0]; yb = int(ys.max()); xs = np.nonzero(sh[yb - 2] > 96)[0]
    soles = [[int(xs.min()) + 1, yb], [int(xs.max()) - 1, yb]]
    md = ['| part | image | size | pivot | parent | attach |', '|---|---|---|---|---|---|']
    for p in ['head', 'torso', 'uarm', 'farm', 'thigh', 'shin', 'weapon']:
        (px, py), par, att = rows[p]
        md.append(f'| {p} | don_piedro_{p}.png | {W[p][0]}x{W[p][1]} | {px},{py} | {par or "-"} | {f"{att[0]},{att[1]}" if att else "-"} |')
    # static stand height like the other heroes: head top above the collar .. sole below the hips
    (hpx, hpy), _, (hax, hay) = rows['head']; (tpx, tpy), _, (tax, tay) = rows['thigh']; (spx, spy), _, (sax, say) = rows['shin']
    height = (hpy - hay) + tay + (say - tpy) + (yb - spy)
    print('\n'.join(md)); print('SOLES', json.dumps(soles)); print('stand height', height, 'K', round(K, 4), f'total {total/1024:.1f} KB')
    SD.save(Image.new('RGBA', (1, 1)), '/dev/null') if False else None

if __name__ == '__main__':
    build()
