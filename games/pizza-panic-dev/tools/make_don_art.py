#!/usr/bin/env python3
"""Don Piedro art from /workspace/pizza-story/don/gen/don_full_v2.jpg (baba_booey, t_9ec48322f6de4bf7).
Keys the magenta (make_splash.key: border-sampled key + despill), then writes
  assets/cine/title/don_piedro.png   title cinematic cutout (~340 px tall, like the other cast cutouts)
  assets/ui/victory/don_piedro.png    victory figure (460 px tall, paletted, like make_victory.py)
  assets/heroes/portraits/don_piedro.png  240x300 select card (make_portraits gradient + light pixel treatment)
  assets/heroes/portraits/reactions.png   + row 8 (hurt, win) appended in heroes.js order (480x2400)
usage: python make_don_art.py [--no-reactions]"""
import os, sys, io
import numpy as np
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
_argv = sys.argv; sys.argv = [_argv[0]]
import make_splash, make_portraits
sys.argv = _argv
GAME = os.path.join(HERE, '..', '..', 'pizza-panic')
SRC = '/workspace/pizza-story/don/gen/don_full_v2.jpg'   # v2 (Kyle's redo: grumpy painted bear, spoon on the shoulder)
W, H = 240, 300
make_portraits.COL['don_piedro'] = ((168, 112, 52), (58, 30, 10))

def q(im, colors=256):
    import imagequant
    return imagequant.quantize_pil_image(im, dithering_level=0.6, max_colors=colors, min_quality=0, max_quality=95)

def save_png(im, path, colors=256):
    buf = io.BytesIO(); q(im, colors).save(buf, 'PNG', optimize=True); open(path, 'wb').write(buf.getvalue()); return len(buf.getvalue())

def pixel(b, dw, dh):  # the PAINTED treatment from make_reactions: light pixelate + posterize
    sm = b.resize((max(1, dw // 2), max(1, dh // 2)), Image.LANCZOS)
    rgb = ImageOps.posterize(sm.convert('RGB'), 5); al = sm.getchannel('A').point(lambda v: 0 if v < 70 else (255 if v > 170 else v))
    sm = rgb.convert('RGBA'); sm.putalpha(al); return sm.resize((dw, dh), Image.NEAREST)

def card(fig_rgba, tint=None, rot=0, scale=1.0):
    b = fig_rgba
    if rot: b = b.rotate(rot, expand=True, resample=Image.BICUBIC)
    s = min(250 / b.width, 300 / b.height) * scale
    dw, dh = round(b.width * s), round(b.height * s)
    fig = pixel(b, dw, dh)
    if tint is not None:
        a = np.asarray(fig).astype(np.float32); t = np.array(tint[:3], np.float32)
        a[..., :3] = a[..., :3] * (1 - tint[3]) + t * tint[3]; fig = Image.fromarray(a.clip(0, 255).astype(np.uint8))
    c = make_portraits.bg('don_piedro')
    x, y = W // 2 - dw // 2, H - dh + 6
    sa = Image.new('RGBA', c.size, (0, 0, 0, 0)); sa.alpha_composite(fig, (x, max(0, y)))
    sh = np.array(sa); sh[..., :3] = 0; sh[..., 3] = (sh[..., 3] * 0.45).astype(np.uint8)
    c.alpha_composite(Image.fromarray(sh).filter(ImageFilter.GaussianBlur(5)), (5, 6)); c.alpha_composite(sa)
    v = np.zeros((H, W, 4), np.uint8); ramp = np.clip((np.arange(H) - (H - 60)) / 60, 0, 1) * 170; v[..., 3] = ramp[:, None].astype(np.uint8)
    c.alpha_composite(Image.fromarray(v, 'RGBA'))
    return c.convert('RGB')

def main():
    rgba, _ = make_splash.key(SRC)
    rgba = rgba.crop(rgba.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox())
    fw, fh = rgba.size
    # title cutout
    t = rgba.resize((round(fw * 340 / fh), 340), Image.LANCZOS)
    print('title', t.size, save_png(t, os.path.join(GAME, 'assets/cine/title/don_piedro.png')))
    v = rgba.resize((round(fw * 460 / fh), 460), Image.LANCZOS)
    print('victory', v.size, save_png(v, os.path.join(GAME, 'assets/ui/victory/don_piedro.png')))
    # bust: head, chest plate and the spoon (top ~60% of the figure)
    bust = rgba.crop((round(fw * 0.16), 0, round(fw * 0.86), round(fh * 0.5)))   # v2: head + pads, the spoon ends cropped
    idle = card(bust); idle.save(os.path.join(GAME, 'assets/heroes/portraits/don_piedro.png'), optimize=True); print('portrait', idle.size)
    if '--no-reactions' in sys.argv: return
    hurt = card(bust, tint=(255, 60, 40, 0.28), rot=-4, scale=1.1)
    win = card(bust, tint=(255, 230, 120, 0.12), rot=4, scale=1.04)
    p = os.path.join(GAME, 'assets/heroes/portraits/reactions.png'); at = Image.open(p).convert('RGB')
    assert at.size in ((480, 2100), (480, 2400)), at.size  # 7 rows -> add row 8; 8 rows -> redo row 8 in place
    out = Image.new('RGB', (480, 2400)); out.paste(at.crop((0, 0, 480, 2100)), (0, 0)); out.paste(hurt, (0, 2100)); out.paste(win, (240, 2100))
    out.save(p, optimize=True); print('reactions', out.size, os.path.getsize(p))
    os.makedirs('/workspace/pizza-story/don/work', exist_ok=True)
    c = Image.new('RGB', (720, 300)); c.paste(idle, (0, 0)); c.paste(hurt, (240, 0)); c.paste(win, (480, 0)); c.save('/workspace/pizza-story/don/work/don-cards.png')

if __name__ == '__main__':
    main()
