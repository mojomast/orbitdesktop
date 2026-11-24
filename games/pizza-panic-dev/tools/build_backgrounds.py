#!/usr/bin/env python3
"""baba_booey: build distinct walking-level background segments.

Each walking level (sewer 0, street 1, rooftop 2) gets three different strip
tiles (1814x510, a 907px painting plus its mirror, like LEVELS.md):
  tile 0 = the original painting, tile 1 = <level>_b, tile 2 = <level>_c.
New paintings (1280x720 JPGs in /workspace/pizza-bg/gen) are scaled to 907x510,
vertically remapped so their wall base / floor band lands on the level's
collision band, colour-graded toward the original strip, sky keyed to alpha
(street/rooftop) or cavern openings keyed (sewer, so sewer_far shows through),
and cross-faded into the previous tile at the seam. The sewer crates are
pasted at the collision crate positions on every tile.

Outputs (JPG colour + 8-bit alpha mask PNG; parallax.js joins them at load.
A palette PNG with alpha either balloons to ~550 KB or, with a plain RGBA
octree quantize, hands opaque colours low-alpha entries, which is how the
old sewer_mid.png lost its wall):
  assets/levels/seg/sewer_a.jpg + _mask.png   tile 0, the original sewer wall with
                                              its two arches opened onto the cavern
  assets/levels/seg/{sewer,street,rooftop}_{b,c}.jpg + _mask.png
  assets/levels/far/sewer.jpg                 sewer_far + mirror, 1814x510
Street/rooftop tile 0 stay the existing street_mid.png / rooftop_mid.png.
v2 (t_fadcdb1655a545f1, art in /workspace/pizza-bg/gen2):
  seg/subway_0, seg/subway_2   carriage tiles (A + graffiti car; gangway car end + B)
  seg/harbor_1                 the second pier tile (fish market | loading bay, cranes kept)
  seg/arcade_1                 the second cabinet-row tile (racing/dance | air hockey/party)
  seg/tower_1                  the server floor (red-alert lab)
usage: python3 tools/build_backgrounds.py [sewer|street|rooftop|subway|harbor|arcade|tower ...]
"""
import sys, os
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

GAME = os.environ.get('PP_GAME', '/home/box/orbitdesktop/games/pizza-panic')
GEN = os.environ.get('PP_GEN', '/workspace/pizza-bg/gen')
LV = os.path.join(GAME, 'assets/levels')
OUT = os.environ.get('PP_OUT', LV)
PREV = os.environ.get('PP_PREVIEW', '/workspace/pizza-bg/work')
HALF, H, TW = 907, 510, 1814
SEAM = 110  # cross-fade width at tile seams


def load_gen(name):
    im = Image.open(os.path.join(GEN, name + '.jpg')).convert('RGB').resize((HALF, H), Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


def load_lv(name):
    return np.asarray(Image.open(os.path.join(LV, name)).convert('RGBA')).astype(np.float32)


def remap(a, pts):
    """Vertical piecewise-linear remap. pts = [(src_y, dst_y), ...] ascending.
    Outside the points the mapping continues at slope 1 (a plain shift)."""
    s = [p[0] for p in pts]; d = [p[1] for p in pts]
    s = [s[0] - 2000] + s + [s[-1] + 2000]; d = [d[0] - 2000] + d + [d[-1] + 2000]
    ys = np.interp(np.arange(H, dtype=np.float32), d, s)
    ys = np.clip(ys, 0, a.shape[0] - 1)
    y0 = np.floor(ys).astype(int); y1 = np.minimum(y0 + 1, a.shape[0] - 1); f = (ys - y0)[:, None, None]
    return a[y0] * (1 - f) + a[y1] * f


def to_ycc(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    return np.stack([y, (b - y) * 0.564, (r - y) * 0.713], -1)


def from_ycc(c):
    y, cb, cr = c[..., 0], c[..., 1] / 0.564, c[..., 2] / 0.713
    r = cr + y; b = cb + y; g = (y - 0.299 * r - 0.114 * b) / 0.587
    return np.stack([r, g, b], -1)


def grade(a, ref, m_a, m_ref, k=0.65):
    """Mean/std colour transfer in YCbCr toward ref, blended by k."""
    A, R = to_ycc(a), to_ycc(ref[..., :3])
    out = A.copy()
    for c in range(3):
        ma, sa = A[..., c][m_a].mean(), A[..., c][m_a].std() + 1e-3
        mr, sr = R[..., c][m_ref].mean(), R[..., c][m_ref].std() + 1e-3
        scale = sr / sa if c == 0 else min(1.6, sr / sa)
        out[..., c] = (A[..., c] - ma) * scale + mr
    return np.clip(a + k * (from_ycc(out) - a), 0, 255)


def sky_alpha(a, ymax, tol=14.0, soft=10.0):
    """Key a flat dark sky to transparency: a per-row sky colour model tracked
    from the top, then only sky-coloured pixels connected to the top rows."""
    h, w = a.shape[:2]
    model = np.zeros((h, 3), np.float32)
    model[0] = np.median(a[0].reshape(-1, 3), 0)
    dist = np.zeros((h, w), np.float32)
    for y in range(h):
        ref = model[y - 1] if y else model[0]
        d = np.linalg.norm(a[y] - ref, axis=1)
        sel = d < tol * 1.3
        model[y] = np.median(a[y][sel], 0) if sel.sum() > 40 else ref
        dist[y] = np.linalg.norm(a[y] - model[y], axis=1)
    cand = dist < tol + soft
    cand[ymax:] = False
    lab, _ = ndi.label(cand)
    top = set(np.unique(lab[0])) - {0}
    region = np.isin(lab, list(top))
    region = ndi.binary_opening(region, iterations=1) | (region & (dist < tol * 0.6))
    alpha = np.ones((h, w), np.float32)
    t = np.clip((dist - tol) / soft, 0, 1)
    alpha[region] = t[region]
    alpha = np.minimum(alpha, ndi.gaussian_filter(alpha, 0.7) + 0.35)  # anti-alias the cut
    alpha = np.clip(alpha, 0, 1)
    return alpha, model


def sky_alpha_cols(a, ymax, tol=12.0, holes_above=0):
    """Street: the sky is only what is above each column's first non-sky pixel,
    so dark facades below a roofline can never be keyed (no leaks)."""
    _, model = sky_alpha(a, ymax, tol=tol, soft=8)
    h, w = a.shape[:2]
    dist = np.linalg.norm(a - model[:, None, :], axis=2)
    dist = ndi.median_filter(dist, size=3)
    non = dist > tol
    non[ymax:] = True
    first = np.argmax(non, axis=0).astype(np.float32)          # first art row per column
    first = ndi.minimum_filter1d(first, 3)                      # thin antennas keep their pixels
    yy = np.arange(h, dtype=np.float32)[:, None]
    alpha = np.clip((yy - first[None, :] + 1.0) / 2.0, 0, 1)
    if holes_above:
        # sky seen between frame bars (billboard scaffold): strictly sky-coloured
        # pockets wholly above `holes_above`, so no dim wall or mesh gets keyed
        strict = (dist < tol * 0.55) & (alpha > 0.5)
        lab, n = ndi.label(strict)
        if n:
            sl = ndi.find_objects(lab)
            for i, s in enumerate(sl, 1):
                if s[0].stop <= holes_above and (lab[s] == i).sum() >= 30:
                    alpha[lab == i] = 0
    return alpha.astype(np.float32), model


def unmatte(a, alpha, model):
    """Remove the sky colour from semi-transparent edge pixels (no dark halo)."""
    S = model[:, None, :]
    al = np.maximum(alpha, 0.05)[..., None]
    fixed = (a - (1 - al) * S) / al
    edge = (alpha > 0.02) & (alpha < 0.98)
    out = a.copy(); out[edge] = np.clip(fixed[edge], 0, 255)
    return out


def dark_top_alpha(a, ymax, thr=30, soft=18):
    """Sewer: key the black void / dark vaults connected to the top edge."""
    mx = a.max(-1)
    cand = mx < thr + soft
    cand[ymax:] = False
    lab, _ = ndi.label(cand)
    top = set(np.unique(lab[0])) - {0}
    region = np.isin(lab, list(top))
    alpha = np.ones(mx.shape, np.float32)
    t = np.clip((mx - thr) / soft, 0, 1)
    alpha[region] = t[region]
    # fade the key out toward ymax so no hard horizontal line
    fade = np.clip((np.arange(mx.shape[0]) - (ymax - 40)) / 40.0, 0, 1)[:, None]
    alpha = np.maximum(alpha, fade)
    return np.clip(ndi.gaussian_filter(alpha, 0.8), 0, 1)


def arch_hole(shape, cx, top, half_w, spring, bottom, feather=7, fog=(255, 296)):
    """Alpha (0 = hole) for a round-topped tunnel opening."""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ry = spring - top
    inside_round = ((xx - cx) / half_w) ** 2 + ((yy - spring) / ry) ** 2 < 1
    inside_rect = (np.abs(xx - cx) < half_w) & (yy >= spring) & (yy <= bottom)
    m = (inside_round & (yy < spring)) | inside_rect
    d = ndi.distance_transform_edt(m)
    hole = np.clip(d / feather, 0, 1)
    # keep the toxic fog low in the opening
    hole *= 1 - np.clip((yy - fog[0]) / (fog[1] - fog[0]), 0, 1)
    return 1 - hole


def mirror(a):
    return np.concatenate([a, a[:, ::-1]], axis=1)


def roll(a, dx):
    return np.roll(a, dx, axis=1)


def crossfade_into(prev, cur, width=SEAM, hold=0):
    """The first columns of cur continue prev (prev loops, so the pixels after
    its right edge are its own first columns): `hold` px copied whole (finish a
    prop that sits on prev's edge, e.g. the rooftop water tower), then a
    `width` px smoothstep fade into cur."""
    out = cur.copy()
    n = hold + width
    ramp = np.clip((np.arange(n, dtype=np.float32) - hold) / max(1, width - 1), 0, 1)
    ramp = ramp * ramp * (3 - 2 * ramp)
    r = ramp[None, :, None]
    out[:, :n] = prev[:, :n] * (1 - r) + cur[:, :n] * r
    return out


def save_jpg_mask(rgba_img, base, quality=82):
    """Colour as JPG (small, like the original strips) plus an 8-bit alpha mask
    PNG; parallax.js joins them once at load. Clear pixels take the nearest
    art colour first so JPG ringing does not creep into the edges."""
    a = rgba_img.astype(np.float32)
    al = a[..., 3]
    rgb = a[..., :3].copy()
    clear = al < 128
    if clear.any():
        _, (iy, ix) = ndi.distance_transform_edt(clear, return_indices=True)
        rgb[clear] = rgb[iy[clear], ix[clear]]
    Image.fromarray(np.clip(rgb + 0.5, 0, 255).astype(np.uint8)).save(base + '.jpg', quality=quality, optimize=True, progressive=True)
    n = os.path.getsize(base + '.jpg')
    if True:  # always write the mask (an opaque one is ~1 KB): the loader never 404s
        m = np.clip(al + 0.5, 0, 255).astype(np.uint8)
        m[m > 250] = 255; m[m < 5] = 0
        # LA: alpha carries the mask so canvas 'destination-in' can use it
        Image.fromarray(np.stack([np.zeros_like(m), m], -1), 'LA').save(base + '_mask.png', optimize=True)
        n += os.path.getsize(base + '_mask.png')
    return n


def rgba(rgb, alpha=None):
    a = np.ones(rgb.shape[:2], np.float32) if alpha is None else alpha
    return np.concatenate([rgb, a[..., None] * 255], -1)


# ---------------------------------------------------------------- sewer (0)
def build_sewer():
    A = load_lv('sewer.jpg')[..., :3]                       # original 1814x510, opaque
    # tile 0: the original wall with its two tunnel arches opened onto the cavern
    a0 = np.minimum(arch_hole((H, TW), 446, 142, 92, 232, 300), arch_hole((H, TW), TW - 446, 142, 92, 232, 300))
    T0 = rgba(A, a0)
    floor = A  # the original floor band (rows >= 360) is shared by tiles 0/1: same flagstones, crates' bases
    m_ref = np.ones(A.shape[:2], bool); m_ref[360:] = False

    # crates: cut from the original at the collision crate rects, pasted on every tile
    def crate_layer():
        lay = np.zeros((H, TW, 4), np.float32)
        g_minus = A[..., 1] - np.maximum(A[..., 0], A[..., 2])
        keep = np.clip((26 - g_minus) / 16, 0, 1)  # toxic water is strongly green
        for (x0, x1, y0) in [(330, 432, 292), (430, 503, 319)]:
            for (u0, u1) in [(x0, x1), (TW - x1, TW - x0)]:
                lay[y0:384, u0:u1, :3] = A[y0:384, u0:u1]
                lay[y0:384, u0:u1, 3] = keep[y0:384, u0:u1] * 255
        lay[..., 3] = ndi.gaussian_filter(lay[..., 3], 0.6)
        return lay
    crates = crate_layer()

    def over(dst, lay):
        al = lay[..., 3:4] / 255
        out = dst.copy(); out[..., :3] = dst[..., :3] * (1 - al) + lay[..., :3] * al
        out[..., 3] = np.maximum(dst[..., 3], lay[..., 3]); return out

    # tile 1: junction (waterfall). Floor top 425 -> 363; the original floor below.
    b = load_gen('sewer_b')
    b = remap(b, [(425, 363), (470, 455)])
    m_b = np.ones(b.shape[:2], bool); m_b[:40] = False; m_b[360:] = False
    b = grade(b, A[:, :HALF], m_b, m_ref[:, :HALF], 0.55)
    ab = dark_top_alpha(b, 150)
    B = rgba(mirror(b), mirror(ab[..., None])[..., 0])
    B = roll(B, -680)                                         # tile edge on the big pipe column; waterfall clear of the crates
    blend = np.clip((np.arange(H) - 352) / 12.0, 0, 1)[:, None, None]
    B[..., :3] = B[..., :3] * (1 - blend) + floor * blend
    B[..., 3] = np.maximum(B[..., 3], blend[..., 0] * 255)
    B = over(B, crates)

    # tile 2: hideout outskirts (string lights, arcade cabinet, valve wheel), own floor
    c = load_gen('sewer_c')
    c = remap(c, [(362, 363), (440, 452), (460, 470)])
    m_c = np.ones(c.shape[:2], bool); m_c[:30] = False
    c = grade(c, A[:, :HALF], m_c, np.ones(A[:, :HALF].shape[:2], bool), 0.5)
    ac = dark_top_alpha(c, 110, thr=26, soft=16)
    C = rgba(mirror(c), mirror(ac[..., None])[..., 0])
    C = roll(C, -640)                                         # tile edge on the valve pipe column
    C = over(C, crates)

    B, C = crossfade_into(T0, B, 34), crossfade_into(B, C, 40)  # each fades from the previous tile's own loop
    far = load_gen('sewer_far')
    far = grade(far, A[:, :HALF], np.ones(far.shape[:2], bool), m_ref[:, :HALF], 0.25) * 0.92
    return {'sewer_a': T0, 'sewer_b': B, 'sewer_c': C}, mirror(far)


# ---------------------------------------------------------------- street (1)
def wet_road(seg_rgb, orig, base, road_top):
    """Road below road_top: the original wet asphalt with its colour streaks
    knocked down, plus a blurred mirror reflection of this segment's storefronts."""
    out = seg_rgb.copy()
    road = orig[:, :, :3].copy()
    lum = to_ycc(road)[..., :1]
    road = road * 0.35 + lum * 0.65
    road *= 0.85
    span = H - road_top
    src = seg_rgb[max(0, base - span):base][::-1]
    if src.shape[0] < span: src = np.concatenate([src, np.repeat(src[-1:], span - src.shape[0], 0)], 0)
    refl = ndi.gaussian_filter(src, (3.0, 1.2, 0))
    fade = (1 - np.arange(span) / span)[:, None, None] ** 1.4
    # brighter lights reflect more (neon streaks)
    glow = np.clip((to_ycc(refl)[..., :1] - 40) / 120, 0, 1)
    region = road[road_top:]
    region = region + refl * fade * (0.28 + 0.5 * glow)
    out[road_top:] = np.clip(region, 0, 255)
    blend = np.clip((np.arange(H) - (road_top - 4)) / 8.0, 0, 1)[:, None, None]
    return seg_rgb * (1 - blend) + out * blend


def build_street():
    A = load_lv('street.jpg')[..., :3]
    T0 = load_lv('street_mid.png')       # DOLAN/pipi's sky-cut original, kept as tile 0
    m_ref = T0[..., 3] > 250; m_ref[355:] = False
    outs = {}
    prev = T0
    # seam: (fade, hold). Into b: hold the 'W 46 St' sign post on the original's
    # edge; into c: fade out over b's bare brick before its PIZZA sign starts.
    for name, base, curb, roll_dx, signs, seam in [('street_b', 405, 455, 0, [(70, 348, 145, 222)], (70, 40)),
                                                   ('street_c', 420, 447, 0, [], (56, 0))]:
        s = load_gen(name)
        s = remap(s, [(base, 356), (curb, 381)])
        sh = base - 356
        m = np.ones(s.shape[:2], bool); m[:120] = False; m[356:] = False
        s = grade(s, A[:, :HALF], m, m_ref[:, :HALF], 0.45)
        al, model = sky_alpha_cols(s, 300, tol=12)
        s = unmatte(s, al, model)
        full = mirror(s); fa = mirror(al[..., None])[..., 0]
        # signs read the right way round on the mirrored half too
        for (x0, x1, y0, y1) in signs:
            y0 -= sh; y1 -= sh
            full[y0:y1, TW - x1:TW - x0] = s[y0:y1, x0:x1]
            fa[y0:y1, TW - x1:TW - x0] = al[y0:y1, x0:x1]
        full = wet_road(full, A, 356, 384)
        fa[384:] = 1
        T = rgba(full, fa)
        T = roll(T, roll_dx)
        outs[name] = crossfade_into(prev, T, *seam)
        prev = T  # the next tile continues this painting's own loop, not its seam
    return outs


# ---------------------------------------------------------------- rooftop (2)
def build_rooftop():
    A = load_lv('rooftop.jpg')[..., :3]
    T0 = load_lv('rooftop_mid.png')
    m_ref = T0[..., 3] > 250; m_ref[:280] = False
    outs = {}
    prev = T0
    for name, pts, roll_dx, k, hold in [('rooftop_b', [(375, 356), (440, 425)], 0, 0.4, 100),
                                        ('rooftop_c', [(386, 357), (430, 425)], 0, 0.4, 95)]:
        s = load_gen(name)
        s = remap(s, pts)
        m = np.ones(s.shape[:2], bool); m[:200] = False
        s = grade(s, A[:, :HALF], m, m_ref[:, :HALF], k)
        al, model = sky_alpha_cols(s, 340, tol=12, holes_above=262)
        s = unmatte(s, al, model)
        T = rgba(mirror(s), mirror(al[..., None])[..., 0])
        T = roll(T, roll_dx)
        outs[name] = crossfade_into(prev, T, 60, hold)
        prev = T  # the next tile continues this painting's own loop, not its seam
    return outs


# ======================================================== v2: subway, harbor, arcade, tower
GEN2 = os.environ.get('PP_GEN2', '/workspace/pizza-bg/gen2')


def load_gen2(name):
    im = Image.open(os.path.join(GEN2, name + '.jpg')).convert('RGB').resize((HALF, H), Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


def fade_out_to(cur, nxt, width):
    """The last `width` px of cur fade into what precedes nxt's first column
    (nxt loops: its own last columns), so cur's right edge meets nxt."""
    out = cur.copy()
    ramp = np.clip(np.arange(width, dtype=np.float32) / (width - 1), 0, 1)
    ramp = (ramp * ramp * (3 - 2 * ramp))[None, :, None]
    out[:, -width:] = cur[:, -width:] * (1 - ramp) + nxt[:, -width:] * ramp
    return out


def join_halves(left, right, width=70):
    """Two different 907px paintings side by side, cross-faded at x=907."""
    out = np.concatenate([left, right], 1)
    ramp = np.clip(np.arange(2 * width, dtype=np.float32) / (2 * width - 1), 0, 1)
    ramp = (ramp * ramp * (3 - 2 * ramp))[None, :, None]
    a = HALF - width
    # left continues into right's first columns mirrored, right continues left's last columns mirrored
    lext = np.concatenate([left[:, a:], left[:, ::-1][:, :width]], 1)
    rext = np.concatenate([right[:, :width][:, ::-1], right[:, :width]], 1)
    out[:, a:a + 2 * width] = lext * (1 - ramp) + rext * ramp
    return out


def dark_holes(a, y0, y1, thr=22, soft=14, min_area=600):
    """Flat-black windows -> transparent: dark components inside rows y0..y1."""
    mx = a.max(-1)
    cand = mx < thr + soft
    cand[:y0] = False; cand[y1:] = False
    lab, n = ndi.label(cand)
    alpha = np.ones(mx.shape, np.float32)
    if n:
        areas = ndi.sum(np.ones_like(mx), lab, index=np.arange(1, n + 1))
        keep = np.isin(lab, 1 + np.flatnonzero(areas >= min_area))
        core = ndi.binary_erosion(keep, iterations=1) | (keep & (mx < thr))
        t = np.clip((mx - thr) / soft, 0, 1)
        alpha[keep] = t[keep]
        alpha[core & (mx < thr)] = 0
    return np.clip(ndi.gaussian_filter(alpha, 0.6), 0, 1)


def subway_tiles():
    """Tile 0: carriage A's first panels + the graffiti carriage; tile 2: the
    gangway/cab-door car end + carriage B's last panels. The roof tile is untouched.
    Floors land on the car floor (wall base 385 like the A/B cars); black windows cut."""
    A = load_lv('subway/mid_car_a.png'); Bc = load_lv('subway/mid_car_b.png')
    m_ref = A[..., 3] > 250; m_ref[380:] = False
    outs = {}
    for name, pts in [('subway_b', [(398, 385), (490, 510)]), ('subway_c', [(398, 385)])]:
        x = remap(load_gen2(name), pts)
        m = np.ones(x.shape[:2], bool); m[385:] = False
        x = grade(x, A[:, :HALF, :3], m, m_ref[:, :HALF], 0.4)
        al = dark_holes(x, 40, 345)
        outs[name] = rgba(x, al)
    t0 = join_halves(A[:, :HALF], outs['subway_b'])
    t0 = fade_out_to(t0, A, 50)                      # A loops: the roof tile follows A in the old layout too
    t2 = join_halves(outs['subway_c'], Bc[:, HALF:])
    return {'subway_0': t0, 'subway_2': t2}


def crane_layer(D):
    """The painted gantry cranes (x~470 and its mirror 1344) cut from docks_mid."""
    lay = np.zeros_like(D)
    yy = np.arange(H)[:, None]
    for x0, x1 in [(360, 585), (TW - 585, TW - 360)]:
        seg = D[:, x0:x1].copy()
        r, g, b = seg[..., 0], seg[..., 1], seg[..., 2]
        yellow = (r > 90) & (r - b > 45) & (g > 55)
        a = np.where(yy < 288, seg[..., 3], np.where(yellow & (yy < 396), 255, 0)).astype(np.float32)
        a = ndi.gaussian_filter(a, 0.6)
        lay[:, x0:x1, :3] = seg[..., :3]; lay[:, x0:x1, 3] = a
    return lay


def over(dst, lay):
    al = lay[..., 3:4] / 255
    out = dst.copy(); out[..., :3] = dst[..., :3] * (1 - al) + lay[..., :3] * al
    out[..., 3] = np.maximum(dst[..., 3], lay[..., 3]); return out


def harbor_tiles():
    """Tile 1 (the second pier): fish market shed | warehouse loading bay, on the
    docks deck (rows >= 392 from docks_mid, so the band and wet planks match),
    sky cut to the far docks layer, and the two gantry cranes repainted where
    CRANES drop their crates (x 470, 1340 of the tile)."""
    D = load_lv('harbor/docks_mid.png'); S = load_lv('harbor/ship_mid.png')
    m_ref = D[..., 3] > 250; m_ref[392:] = False
    halves = []
    for name, pts in [('harbor_b', [(418, 396), (448, 460)]), ('harbor_c', [(398, 396), (432, 460)])]:
        x = remap(load_gen2(name), pts)
        m = np.ones(x.shape[:2], bool); m[:120] = False; m[392:] = False
        x = grade(x, D[:, :HALF, :3], m, m_ref[:, :HALF], 0.4)
        al, model = sky_alpha_cols(x, 330, tol=11, holes_above=330)
        x = unmatte(x, al, model)
        halves.append(rgba(x, al))
    t = join_halves(halves[0], halves[1])
    deck = D.copy()
    blend = np.clip((np.arange(H) - 386) / 10.0, 0, 1)[:, None, None]
    t = t * (1 - blend) + deck * blend
    t = over(t, crane_layer(D))
    t = crossfade_into(D, t, 70)
    t = fade_out_to(t, S, 60)
    t[392:, :, 3] = 255                                  # the deck is solid (docks_mid's band has a few 221s)
    # Ship deck: ship_mid.png's palette quantize keyed ~5.4k deck pixels (the
    # pink puddle reflections) to clear, so the far sky showed through the deck.
    # seg/harbor_2 is the same painting with those holes filled from the deck.
    S2 = S.copy()
    hole = S2[..., 3] < 250; hole[:380] = False
    if hole.any():
        _, (iy, ix) = ndi.distance_transform_edt(hole, return_indices=True)
        fill = S2[iy, ix, :3]
        soft = ndi.gaussian_filter(fill, (2, 2, 0))
        S2[hole, :3] = soft[hole] * 0.85 + np.array([90, 40, 110], np.float32) * 0.15   # a faint neon sheen
        S2[380:, :, 3] = np.maximum(S2[380:, :, 3], 255 * (np.arange(380, H) >= 392)[:, None])
        S2[hole, 3] = 255
    return {'harbor_1': t, 'harbor_2': S2}


def arcade_tiles():
    """Tile 1 (the second cabinet row): racing cabinets/dance stage/plush counter |
    air hockey/pinball/party table/claw door. arcade_c's plain maroon carpet is
    replaced by arcade_b's cosmic carpet (mirrored, so it is not a copy)."""
    A = np.asarray(Image.open(os.path.join(LV, 'arcade/arcade_mid.jpg')).convert('RGB')).astype(np.float32)
    T = np.asarray(Image.open(os.path.join(LV, 'arcade/ticket_mid.jpg')).convert('RGB')).astype(np.float32)
    b = load_gen2('arcade_b'); c = load_gen2('arcade_c')
    carpet = b[:, ::-1]
    blend = np.clip((np.arange(H) - 334) / 10.0, 0, 1)[:, None, None]
    c = c * (1 - blend) + carpet * blend
    m = np.ones(b.shape[:2], bool); m[340:] = False
    mr = np.ones(A.shape[:2], bool); mr[340:] = False
    b = grade(b, A[:, :HALF], m, mr[:, :HALF], 0.25); c = grade(c, A[:, :HALF], m, mr[:, :HALF], 0.3)
    t = join_halves(rgba(b), rgba(c), 60)
    t = crossfade_into(rgba(A), t, 70)
    t = fade_out_to(t, rgba(T), 60)
    return {'arcade_1': t}


def tower_tiles():
    """Tile 1, the server floor: the red-alert lab (mutagen tanks, robot arms)
    plus its mirror, replacing the recoloured lobby copy. Its floor plates
    (y 345-420) are stretched onto the tower band (384-500)."""
    L0 = load_lv('tower_mid.png'); L2 = load_lv('tower_throne_mid.png')
    x = remap(load_gen2('tower_server_b'), [(345, 343), (420, 500), (500, 510)])
    t = rgba(mirror(x))
    t = crossfade_into(L0, t, 60)
    t = fade_out_to(t, L2, 60)
    return {'tower_1': t}


V2 = {'subway': subway_tiles, 'harbor': harbor_tiles, 'arcade': arcade_tiles, 'tower': tower_tiles}


def main():
    only = set(sys.argv[1:])
    os.makedirs(PREV, exist_ok=True); os.makedirs(os.path.join(OUT, 'seg'), exist_ok=True); os.makedirs(os.path.join(OUT, 'far'), exist_ok=True)
    sizes = {}
    for lvl in ['sewer', 'street', 'rooftop'] + list(V2):
        if only and lvl not in only: continue
        if lvl in V2:
            for k, v in V2[lvl]().items(): sizes['seg/' + k] = save_jpg_mask(v, os.path.join(OUT, 'seg', k))
            continue
        if lvl == 'sewer':
            t, far = build_sewer()
            p = os.path.join(OUT, 'far', 'sewer.jpg')
            Image.fromarray(np.clip(far + 0.5, 0, 255).astype(np.uint8)).save(p, quality=80, optimize=True, progressive=True)
            sizes['far/sewer.jpg'] = os.path.getsize(p)
        else:
            t = build_street() if lvl == 'street' else build_rooftop()
        for k, v in t.items(): sizes['seg/' + k] = save_jpg_mask(v, os.path.join(OUT, 'seg', k))
    for k, v in sizes.items(): print(f'{k:22s} {v/1024:7.1f} KB')
    print('total', round(sum(sizes.values()) / 1024), 'KB')


if __name__ == '__main__':
    main()
