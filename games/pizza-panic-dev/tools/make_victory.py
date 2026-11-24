# Chroma-key the victory poses (pink/magenta bg) to trimmed RGBA PNGs.
import numpy as np, sys, io
from PIL import Image
from scipy import ndimage as nd
IDS = ['turtle_purple','turtle_blue','turtle_red','turtle_orange','nous_girl','teknium','turbofit']
H_OUT = 460
def key(h):
    a = np.asarray(Image.open(f'/workspace/pizza-victory/gen/{h}.jpg').convert('RGB')).astype(np.float32)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    cand = (R > 215) & (G < 50) & (B > 120)
    # border-connected candidate region = sure background (lets interior purple stay)
    lab, n = nd.label(cand); edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    sure = np.isin(lab, list(edge))
    # also small enclosed bg pockets (between arms/legs): bright pink, big enough
    for i in range(1, n + 1):
        if i in edge: continue
        m = lab == i
        if m.sum() > 150 and R[m].mean() > 235 and G[m].mean() < 25: sure |= m
    # local background colour (bg is a gradient), normalized convolution
    w = nd.gaussian_filter(sure.astype(np.float32), 30) + 1e-4
    bg = np.stack([nd.gaussian_filter(a[..., c] * sure, 30) / w for c in range(3)], -1)
    d = np.sqrt(((a - bg) ** 2).sum(-1))
    alpha = np.clip((d - 40) / 90, 0, 1)
    alpha[sure & (d < 70)] = 0
    # only the edge band gets soft alpha; deep interior is opaque
    solid = nd.binary_erosion(alpha > 0.5, iterations=3)
    alpha[solid] = 1
    # drop specks
    lab2, n2 = nd.label(alpha > 0.3); sizes = nd.sum(np.ones_like(alpha), lab2, range(1, n2 + 1))
    keep = np.isin(lab2, [i + 1 for i, s in enumerate(sizes) if s >= 400])
    alpha[~nd.binary_dilation(keep, iterations=2)] = 0
    # unmix the background from the fringe, then despill pink in the band
    am = np.maximum(alpha, 0.05)[..., None]
    f = np.clip((a - (1 - am) * bg) / am, 0, 255)
    band = (alpha > 0) & ~nd.binary_erosion(alpha > 0.5, iterations=4)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    spill = np.clip(np.minimum(r, b) - np.maximum(g, 0) - 40, 0, None) * band
    f[..., 0] -= spill * 0.7; f[..., 2] -= spill * 0.7
    alpha = nd.grey_erosion(alpha, size=(2, 2)) * 0.5 + alpha * 0.5  # pull in the last fringe px
    rgba = np.dstack([np.clip(f, 0, 255), alpha * 255]).astype(np.uint8)
    ys, xs = np.nonzero(alpha > 0.02)
    im = Image.fromarray(rgba).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    if im.height > H_OUT: im = im.resize((round(im.width * H_OUT / im.height), H_OUT), Image.LANCZOS)
    return im
def save(im, path, limit=150_000):
    import imagequant
    s = im
    while True:
        q = imagequant.quantize_pil_image(s, dithering_level=0.6, max_colors=256, min_quality=60, max_quality=95)
        buf = io.BytesIO(); q.save(buf, 'PNG', optimize=True); data = buf.getvalue()
        if len(data) <= limit: break
        s = s.resize((int(s.width * 0.93), int(s.height * 0.93)), Image.LANCZOS)
    open(path, 'wb').write(data); return s.size, len(data)
if __name__ == '__main__':
    for h in (sys.argv[1:] or IDS):
        print(h, *save(key(h), f'/workspace/pizza-victory/cut/{h}.png'))
