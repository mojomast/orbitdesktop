# baba_booey t_a4826c482cfc4c4a: fit gameover.jpg / continue.jpg (1024x576) to the 740x510 canvas and bake
# readability darkening behind the screens.js text areas. Near-cover fit: width 772 (16 px trimmed per side,
# so the edge heroes stay in frame), height 434; the remaining 38 px top and bottom are mirrored edge bands
# fading to near black (sky above, wet street below).  usage: python build_gameover.py [srcdir] [outdir]
import sys, os
from PIL import Image, ImageFilter, ImageDraw, ImageChops
SRC = sys.argv[1] if len(sys.argv) > 1 else '/workspace/pizza-art/gameover/gen'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '../../pizza-panic/assets/ui/gameover')
W, H, FW = 740, 510, 772
def fit(im):
    fh = round(576 * FW / 1024); im = im.convert('RGB').resize((FW, fh), Image.LANCZOS)
    x0 = (FW - W) // 2; im = im.crop((x0, 0, x0 + W, fh)); pad = (H - fh) // 2
    c = Image.new('RGB', (W, H)); c.paste(im, (0, pad))
    top = im.crop((0, 0, W, pad)).transpose(Image.FLIP_TOP_BOTTOM).filter(ImageFilter.GaussianBlur(3))
    bot = im.crop((0, fh - (H - fh - pad), W, fh)).transpose(Image.FLIP_TOP_BOTTOM).filter(ImageFilter.GaussianBlur(3))
    c.paste(top, (0, 0)); c.paste(bot, (0, pad + fh))
    # soften the seams a touch
    return c, pad, fh
def shade(c, shapes):
    m = Image.new('L', c.size, 0); d = ImageDraw.Draw(m)
    for kind, box, a in shapes:
        (d.ellipse if kind == 'e' else d.rectangle)(box, fill=a)
    m = m.filter(ImageFilter.GaussianBlur(34))
    return Image.composite(Image.new('RGB', c.size, (6, 3, 8)), c, m)
def edges(m, pad, fh, top_a, bot_a):
    d = ImageDraw.Draw(m)
    for y in range(H):
        a = 0
        if y < pad + 20: a = top_a * (1 - y / (pad + 20))
        if y > pad + fh - 20: a = max(a, bot_a * (y - (pad + fh - 20)) / (H - (pad + fh - 20)))
        if a: d.line([(0, y), (W, y)], fill=int(a))
def build(name, shapes, top_a, bot_a):
    c, pad, fh = fit(Image.open(os.path.join(SRC, name)))
    m = Image.new('L', c.size, 0); edges(m, pad, fh, top_a, bot_a)
    c = Image.composite(Image.new('RGB', c.size, (4, 2, 6)), c, m)
    c = shade(c, shapes)
    # corner vignette
    v = Image.new('L', (W, H), 0); ImageDraw.Draw(v).ellipse((-W * 0.25, -H * 0.3, W * 1.25, H * 1.3), fill=255)
    v = ImageChops.invert(v.filter(ImageFilter.GaussianBlur(60))).point(lambda p: int(p * 0.6))
    c = Image.composite(Image.new('RGB', c.size, (0, 0, 0)), c, v)
    os.makedirs(OUT, exist_ok=True); p = os.path.join(OUT, name); c.save(p, quality=86, optimize=True, progressive=True)
    print(name, c.size, os.path.getsize(p))
# continue: CONTINUE? banner (370,150 300x125), digits + ring (370,295 r70), two text lines at H-58 / H-32
build('continue.jpg', [('e', (190, 80, 550, 220), 120), ('e', (270, 215, 470, 375), 150), ('r', (90, 436, 650, 500), 170)], 120, 230)
# game over: GAME OVER (y~225), stats line (H/2+20), PRESS ANY KEY (H/2+60); keep the villain's head above it
build('gameover.jpg', [('r', (90, 196, 650, 330), 165)], 90, 200)
