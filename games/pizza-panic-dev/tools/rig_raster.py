# Rasterises solved rig frames (matrices from rig.js solve()) and measures what the
# eye sees at each joint: background showing through the joint (gap px), the grip
# sitting on both the hand and the weapon art, and the sole height. stdin: JSON
# {frames:[{id, parts:[{name, path, px, py, m, s}], joints:[[child, parent]], grip:[weapon, hand]|null, soles:[...]}]}
import sys, json, math
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
cache = {}
def mask(path):
    if path not in cache:
        cache[path] = np.asarray(Image.open(path).convert('RGBA'))[..., 3] > 60
    return cache[path]
def full(p):
    m, s = p['m'], p['s']  # world = m * diag(s) * (u - px, v - py)
    a, b, c, d, e, f = m
    A = np.array([[a * s[0], c * s[1]], [b * s[0], d * s[1]]]); t = np.array([e, f]) - A @ np.array([p['px'], p['py']])
    return A, t
def render(p, ox, oy, W):
    # window [ox, ox+W) x [oy, oy+W) of rig space; PIL maps output pixel (x, y) -> input (a x + b y + c, d x + e y + f)
    A, t = full(p); Ai = np.linalg.inv(A); mk = mask(p['path'])
    img = Image.fromarray((mk * 255).astype(np.uint8))
    o = np.array([ox, oy], float)
    c0 = Ai @ (o - t)
    co = (Ai[0, 0], Ai[0, 1], c0[0], Ai[1, 0], Ai[1, 1], c0[1])
    out = img.transform((W, W), Image.AFFINE, co, resample=Image.NEAREST)
    return np.asarray(out) > 127
def width_at(mk, y, x):
    # narrowest run through the joint over a +-3 row band (a neck is narrower than the jaw above it)
    ws = [width_row(mk, yy, x) for yy in range(int(round(y)) - 3, int(round(y)) + 4)]
    ws = [w for w in ws if w > 0]
    return min(ws) if ws else 0
def width_row(mk, y, x):
    if y < 0 or y >= mk.shape[0]: return 0
    y = int(y); row = mk[y]
    xs = np.nonzero(row)[0]
    if not len(xs): return 0
    # the run containing / nearest x
    lab, n = ndi.label(row); x = int(min(max(round(x), 0), len(row) - 1))
    l = lab[x] or lab[xs[np.argmin(abs(xs - x))]]
    return int((lab == l).sum())
axes = {}
def waxis(path, px, py):
    k = (path, px, py)
    if k not in axes:
        a = mask(path); ys, xs = np.nonzero(a)
        Pt = np.stack([xs - px, ys - py], 1).astype(float); C = Pt.mean(0)
        w, v = np.linalg.eigh(np.cov((Pt - C).T)); ax = v[:, np.argmax(w)]
        proj = Pt @ ax; fwd, back = proj.max(), -proj.min()
        if back > fwd: ax = -ax; fwd, back = back, fwd
        axes[k] = (ax, bool(back > 0.6 * fwd))
    return axes[k]
res = {}
data = json.load(sys.stdin)
for fr in data['frames']:
    P = {p['name']: p for p in fr['parts']}
    out = {'gaps': {}, 'grip': None}
    for child, parent in fr['joints']:
        if child not in P or parent not in P: continue
        c, q = P[child], P[parent]
        J = np.array(c['m'][4:6], float)
        wc = width_at(mask(c['path']), c['py'], c['px']) * abs(c['s'][0])
        A, t = full(q); ql = np.linalg.inv(A) @ (J - t)
        wp = width_at(mask(q['path']), ql[1], ql[0]) * abs(q['s'][0])
        r = min(7.0, max(1.5, 0.4 * min(wc, wp)))
        W = int(2 * r + 12); ox, oy = math.floor(J[0]) - W // 2, math.floor(J[1]) - W // 2
        u = render(c, ox, oy, W) | render(q, ox, oy, W)
        dist = ndi.distance_transform_edt(~u) if (~u).any() else np.zeros(u.shape)
        yy, xx = np.mgrid[0:W, 0:W]
        disk = (xx + ox + 0.5 - J[0]) ** 2 + (yy + oy + 0.5 - J[1]) ** 2 <= r * r
        out['gaps'][child] = round(float(dist[disk].max()) if disk.any() else 99, 2)
    if fr.get('grip'):
        w, h = fr['grip']
        if w in P and h in P:
            J = np.array(P[w]['m'][4:6], float); W = 16; ox, oy = math.floor(J[0]) - 8, math.floor(J[1]) - 8
            dw = ndi.distance_transform_edt(~render(P[w], ox, oy, W)); dh = ndi.distance_transform_edt(~render(P[h], ox, oy, W))
            out['grip'] = [round(float(dw[7:10, 7:10].min()), 2), round(float(dh[7:10, 7:10].min()), 2)]
    if fr.get('grip') and fr['grip'][0] in P and fr['grip'][1] in P:
        w, h = fr['grip']; ax, two = waxis(P[w]['path'], P[w]['px'], P[w]['py'])
        A, t = full(P[w]); wd = A @ ax
        hp = P[h]; Ah, th = full(hp); el = np.array(hp['m'][4:6]); hand = np.array(P[w]['m'][4:6])
        fd = hand - el
        ang = math.degrees(math.atan2(wd[1], wd[0]) - math.atan2(fd[1], fd[0]))
        ang = (ang + 180) % 360 - 180
        out['theta'] = round(ang, 1); out['twoEnded'] = two
    res[fr['id']] = out
print(json.dumps(res))
