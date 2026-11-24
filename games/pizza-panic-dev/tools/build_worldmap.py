#!/usr/bin/env python3
"""World map interstitial art (baba_booey, t_5f5d1eed411041b2).
map.jpg  <- /workspace/pizza-art/map/gen/map.jpg: the baked node numbers (2-7) are painted out
           (glyph pixels -> the disc's own dark tone, softened), resized to 960x540, JPEG.
map_ui.png <- ui_sheet.jpg (magenta): pin, slice pointer, cleared stamp, padlock, gold node,
           gray node keyed with make_splash.key, trimmed, scaled to 96 px, packed into ONE
           palette atlas. Prints NODES (map px, by stage NAME) + the UI frame map for worldmap.js.
usage: python3 build_worldmap.py [gen dir] [out dir]   (imagequant: /workspace/pizza-victory/venv)"""
import io, json, os, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as nd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
GEN = sys.argv[1] if len(sys.argv) > 1 else '/workspace/pizza-art/map/gen'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '../../pizza-panic/assets/map')
_a = sys.argv; sys.argv = _a[:1]
import make_splash  # noqa: E402
sys.argv = _a
MW, MH = 960, 540
# node centres in the 1280x720 source, by stage name (badged ones = the baked number's centre)
SRC_NODES = {'sewer': (144, 572, 0), 'street': (250, 315, 1), 'skate': (503, 228, 1), 'subway': (646, 406, 1),
             'rooftop': (841, 236, 1), 'harbor': (1041, 496, 1), 'arcade': (1121, 325, 1), 'tower': (1061, 150, 0)}
UI = ['pin', 'slice', 'stamp', 'lock', 'node_gold', 'node_gray']
ICON = 96


def paint_out(a):
    a = a.copy(); h, w, _ = a.shape; yy, xx = np.mgrid[0:h, 0:w]
    for name, (x, y, badged) in SRC_NODES.items():
        if not badged: continue
        d = np.hypot(xx - x, yy - y)
        zone = d < 24
        glyph = zone & ((a.min(-1) > 140) | ((a.max(-1) < 40) & (d < 20)))  # white digit + its black outline
        glyph = nd.binary_dilation(glyph, iterations=2) & (d < 26)
        ring = (d >= 18) & (d < 28) & ~glyph & (a.mean(-1) < 90)
        tone = np.median(a[ring], axis=0) if ring.any() else np.array([30, 30, 40])
        noise = np.random.default_rng(len(name)).normal(0, 5, (glyph.sum(), 3))
        a[glyph] = np.clip(tone + noise, 0, 255)
        # soften the patch edge
        img = Image.fromarray(a.astype(np.uint8)); bl = np.asarray(img.filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32)
        m = nd.binary_dilation(glyph, iterations=1)
        a[m] = bl[m]
    return a


def save_png(im, path):
    try:
        import imagequant
        im = imagequant.quantize_pil_image(im, dithering_level=0.0, max_colors=128, min_quality=0, max_quality=95)
    except Exception: pass
    buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True); open(path, 'wb').write(buf.getvalue()); return len(buf.getvalue())


def main():
    os.makedirs(OUT, exist_ok=True)
    a = np.asarray(Image.open(os.path.join(GEN, 'map.jpg')).convert('RGB')).astype(np.float32)
    clean = Image.fromarray(paint_out(a).astype(np.uint8)).resize((MW, MH), Image.LANCZOS)
    clean.save(os.path.join(OUT, 'map.jpg'), quality=86, optimize=True, progressive=True)
    k = 1280 / MW
    nodes = {n: [round(x / k), round(y / k)] for n, (x, y, _) in SRC_NODES.items()}
    rgba, _ = make_splash.key(os.path.join(GEN, 'ui_sheet.jpg'))
    al = np.asarray(rgba)[..., 3] > 128
    lab, n = nd.label(nd.binary_dilation(al, iterations=6))
    objs = [(sl, i + 1) for i, sl in enumerate(nd.find_objects(lab)) if (lab[sl] == i + 1).sum() > 2000]
    top = sorted([o for o in objs if (o[0][0].start + o[0][0].stop) / 2 < 360], key=lambda o: o[0][1].start)
    bot = sorted([o for o in objs if (o[0][0].start + o[0][0].stop) / 2 >= 360], key=lambda o: o[0][1].start)
    assert len(top) == 3 and len(bot) == 3, (len(top), len(bot))
    icons = {}
    for name, (sl, li) in zip(UI, top + bot):
        arr = np.asarray(rgba)[sl].copy(); arr[..., 3] = arr[..., 3] * (lab[sl] == li)
        im = Image.fromarray(arr, 'RGBA'); im = im.crop(im.getchannel('A').point(lambda v: 255 if v > 20 else 0).getbbox())
        s = ICON / max(im.size); icons[name] = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    x, frames = 0, {}
    for name in UI: im = icons[name]; frames[name] = [x, 0, im.width, im.height]; x += im.width + 2
    atlas = Image.new('RGBA', (x - 2, ICON), (0, 0, 0, 0))
    for name in UI: atlas.alpha_composite(icons[name], (frames[name][0], 0))
    sz = save_png(atlas, os.path.join(OUT, 'map_ui.png'))
    print('map.jpg', os.path.getsize(os.path.join(OUT, 'map.jpg')), 'map_ui.png', atlas.size, sz)
    print(json.dumps({'nodes': nodes, 'ui': frames}))


if __name__ == '__main__':
    main()
