#!/usr/bin/env python3
"""OpenClaw sniper + heavy part kits (baba_booey, t_ffa2e601eaff4a36).
Keys a magenta parts sheet (MANIFEST.md layout, facing right), drops the
sniper's wrist bracer and thin laser line, splits the heavy's pauldron arm off the
torso, rotates the heavy's horizontal fist forearm to hang down, scales so the torso
is 68 px tall (the iteration-7 2x convention), computes pivots/attach points with
the MANIFEST rules and writes assets/enemies/<kind>/<kind>_<part>.png plus
<kind>/KIT.md (MANIFEST-format section). Source sheets: pizza-panic-dev/kits/<kind>/sheet.jpg.
usage: python3 slice_kits.py [sniper|heavy ...]"""
import io, os, sys, json
import numpy as np
from PIL import Image
from scipy import ndimage as nd
HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.join(HERE, '..', '..', 'pizza-panic')
SRC = os.path.join(HERE, '..', 'kits')
TORSO_PX = 68
KITS = {
    'sniper': dict(title='OpenClaw sniper',
        centres={'head': (113, 279), 'torso': (310, 330), 'uarm': (460, 263), 'bracer': (467, 444), 'farm': (575, 333),
                 'thigh': (686, 354), 'shin': (825, 395), 'weapon': (1059, 297)},
        skip={'bracer'}, laser=True, split=None, rotate={}, grip='pistol',
        palette='black tactical mask with a red scope eye, ghillie fringe over a black plate carrier with the purple claw, grey sleeves, black gloves, charcoal cargo pants, laced boots, long black rifle with a red scope.',
        moves='aim (uarm -80 farm -10, rifle level; a red laser line telegraphs the shot for ~0.8s, then a fast tracer), reload hop back (0.6s).',
        behavior='Rooftop marksman: keeps 300-450px away on high ground, paints the hero with a laser line before firing (line locks 0.25s before the shot so it can be dodged by moving off the lane), retreats when approached; low HP.'),
    'heavy': dict(title='OpenClaw heavy',
        centres={'head': (128, 330), 'torso': (370, 326), 'uarm': (560, 300), 'thigh': (821, 264), 'farm': (747, 405),
                 'shin': (968, 412), 'weapon': (1141, 356)},
        skip=set(), laser=False, split=(492, 150, 500), rotate={'farm': -90}, grip='handle',
        palette='gunmetal riveted plate armour, purple visor and purple claw crest, pauldron upper arm, fist gauntlet, armoured boots, hydraulic sledgehammer with a purple core.',
        moves='hammer slam (uarm -150 to 40, 1.0s wind-up with a ground-crack telegraph, super armour during wind-up and swing, shockwave), shoulder guard (uarm -40 farm -60, blocks frontal light hits).',
        behavior='Slow (0.5x walk), high HP; the hammer slam has super armour (no flinch) and a long recovery that is the punish window; can raise a guard against frontal light hits, so throws and jump kicks work best.'),
}

def key(a, laser):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    km = np.minimum(r, b * 1.6) - g
    bg = (km > 70) & (r > 150)
    if laser:  # the thin red laser line (and its glow) is not part of the rifle: the game draws it as a telegraph
        red = (r > 140) & (g < 110) & (b < 140) & ~bg
        thin = red & ~nd.binary_opening(red, structure=np.ones((5, 5)))
        bg |= nd.binary_dilation(thin, iterations=2) & (red | (km > 25))
    fg = nd.binary_opening(~bg, iterations=2)
    alpha = np.clip((110 - km) / 60, 0, 1); alpha[~nd.binary_dilation(fg, iterations=1)] = 0
    spill = np.clip(np.minimum(r, b) - g, 0, None) * (alpha < 1)
    out = a.copy(); out[..., 0] -= spill * 0.7; out[..., 2] -= spill * 0.7
    return fg, np.dstack([np.clip(out, 0, 255), alpha * 255]).astype(np.uint8)

def centre_at(al, y, th=96):
    y = int(min(max(y, 0), al.shape[0] - 1)); xs = np.nonzero(al[y] > th)[0]
    for d in range(1, 12):
        if len(xs): break
        for yy in (y - d, y + d):
            if 0 <= yy < al.shape[0]: xs = np.nonzero(al[yy] > th)[0]
            if len(xs): break
    return int(round((xs.min() + xs.max()) / 2)) if len(xs) else al.shape[1] // 2

def save(im, path):
    try:
        import imagequant
        q = imagequant.quantize_pil_image(im, dithering_level=0.6, max_colors=128, min_quality=60, max_quality=95)
    except Exception:
        q = im
    buf = io.BytesIO(); q.save(buf, 'PNG', optimize=True); open(path, 'wb').write(buf.getvalue()); return len(buf.getvalue())

def build(kind):
    K = KITS[kind]
    a = np.asarray(Image.open(os.path.join(SRC, kind, 'sheet.jpg')).convert('RGB')).astype(np.float32)
    fg, rgba = key(a, K['laser'])
    if K['split']:
        x, y0, y1 = K['split']; fg[y0:y1, x - 1:x + 1] = False  # torso | pauldron arm seam
    lab, n = nd.label(nd.binary_dilation(fg, iterations=3) & ~(np.zeros_like(fg) if not K['split'] else _seam(fg.shape, K['split'])))
    parts = {}
    for i, s in enumerate(nd.find_objects(lab)):
        m = (lab[s] == i + 1) & fg[s]
        if m.sum() < 300: continue
        cy, cx = (s[0].start + s[0].stop) / 2, (s[1].start + s[1].stop) / 2
        name = min(K['centres'], key=lambda k: (K['centres'][k][0] - cx) ** 2 + (K['centres'][k][1] - cy) ** 2)
        assert name not in parts, f'{kind}: two pieces map to {name}'
        parts[name] = (s, i + 1)
    names = ['head', 'torso', 'uarm', 'farm', 'thigh', 'shin', 'weapon']
    assert all(p in parts for p in names), f'{kind}: missing {[p for p in names if p not in parts]}'
    out_dir = os.path.join(GAME, 'assets', 'enemies', kind); os.makedirs(out_dir, exist_ok=True)
    ims, total = {}, 0
    for p in names:
        s, li = parts[p]
        crop = rgba[s].copy(); crop[..., 3] = np.where(nd.binary_dilation(lab[s] == li, iterations=2) & (nd.binary_dilation(fg[s], iterations=1)), crop[..., 3], 0)
        im = Image.fromarray(crop)
        if p in K['rotate']: im = im.rotate(K['rotate'][p], expand=True, resample=Image.BICUBIC)
        bb = im.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox(); ims[p] = im.crop(bb)
    k = TORSO_PX / ims['torso'].height  # trimmed torso -> exactly 68 px
    for p in names: ims[p] = ims[p].resize((max(1, round(ims[p].width * k)), max(1, round(ims[p].height * k))), Image.LANCZOS)
    al = {p: np.asarray(im.getchannel('A')) for p, im in ims.items()}
    W = {p: im.size for p, im in ims.items()}
    top = lambda p: (centre_at(al[p], round(W[p][1] * 0.12)), round(W[p][1] * 0.12))
    bot = lambda p, f=0.12: (centre_at(al[p], W[p][1] - 1 - round(W[p][1] * f)), W[p][1] - 1 - round(W[p][1] * f))
    tw, th = W['torso']
    rows = {
        'head': ((centre_at(al['head'], W['head'][1] - 1 - round(W['head'][1] * 0.08)), W['head'][1] - 1 - round(W['head'][1] * 0.08)), 'torso', (centre_at(al['torso'], 6), 6)),
        'torso': ((tw // 2, th // 2), None, None),
        'uarm': (top('uarm'), 'torso', (round(tw * 0.3), 16)),
        'farm': (top('farm'), 'uarm', bot('uarm')),
        'thigh': (top('thigh'), 'torso', (round(tw * 0.4), th - 8)),
        'shin': (top('shin'), 'thigh', bot('thigh')),
        'weapon': (grip(al['weapon'], K['grip']), 'farm', bot('farm', 0.15)),
    }
    if kind == 'heavy':  # the arm hangs from the round shoulder socket on the torso's right edge
        rows['uarm'] = (rows['uarm'][0], 'torso', (round(tw * 0.62), round(th * 0.22)))
    for p in names: total += save(ims[p], os.path.join(out_dir, f'{kind}_{p}.png'))
    md = [f'## {kind} ({K["title"]})', '', f'Palette: {K["palette"]}  Moves: {K["moves"]}  Behavior: {K["behavior"]}', '',
          '| part | image | size | pivot | parent | attach |', '|---|---|---|---|---|---|']
    table = {}
    for p in names:
        (px, py), par, att = rows[p]
        md.append(f'| {p} | {kind}_{p}.png | {W[p][0]}x{W[p][1]} | {px},{py} | {par or "-"} | {f"{att[0]},{att[1]}" if att else "-"} |')
        table[p] = dict(file=f'{kind}_{p}.png', w=W[p][0], h=W[p][1], px=px, py=py, parent=par, ax=att[0] if att else 0, ay=att[1] if att else 0)
    open(os.path.join(out_dir, 'KIT.md'), 'w').write('\n'.join(md) + '\n')
    json.dump(table, open(os.path.join(out_dir, 'kit.json'), 'w'), indent=1)
    print(f'{kind}: ' + ' '.join(f'{p}={W[p][0]}x{W[p][1]}' for p in names) + f'  {total / 1024:.1f} KB')

def _seam(shape, split):
    x, y0, y1 = split; m = np.zeros(shape, bool); m[y0:y1, x - 1:x + 1] = True; return m

def grip(al, how):
    h, w = al.shape
    if how == 'handle':  # sledgehammer: grip near the shaft's left end
        x = round(w * 0.1); ys = np.nonzero(al[:, x] > 96)[0]; return x, int(ys.mean()) if len(ys) else h // 2
    # rifle: the pistol grip is the lowest part of the left half
    best = (0, 0)
    for x in range(round(w * 0.1), round(w * 0.55)):
        ys = np.nonzero(al[:, x] > 96)[0]
        if len(ys) and ys.max() > best[1]: best = (x, ys.max())
    x, yb = best; ys = np.nonzero(al[:, x] > 96)[0]
    return x, int(round(yb - (yb - ys.min()) * 0.25))

if __name__ == '__main__':
    for kd in (sys.argv[1:] or list(KITS)): build(kd)
