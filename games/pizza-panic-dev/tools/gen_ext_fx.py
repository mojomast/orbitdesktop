"""Procedurally generate FX sprites for the iteration-10 enemies (enemies-ext.js):
flame puffs (4 frames), burning-ground decal, shuriken, smoke puff, teleport
slash streak and a pilot-light glow. Deterministic (seeded). Output:
games/pizza-panic/assets/enemies/ext/*.png
usage: python3 tools/gen_ext_fx.py
"""
import math, random, os
from PIL import Image, ImageDraw, ImageFilter
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'pizza-panic', 'assets', 'enemies', 'ext')
os.makedirs(OUT, exist_ok=True)
rnd = random.Random(1010)

def save(im, name):
    im.save(os.path.join(OUT, name)); print(name, im.size)

def blob_flame(seed, size=64):
    r = random.Random(seed)
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    layers = [((255, 60, 10), 1.0), ((255, 140, 20), 0.78), ((255, 210, 60), 0.55), ((255, 250, 200), 0.3)]
    for col, k in layers:
        lay = Image.new('RGBA', (size, size), (0, 0, 0, 0)); d = ImageDraw.Draw(lay)
        for _ in range(14):
            a = r.uniform(0, math.tau); dist = r.uniform(0, size * 0.18 * k)
            cx = size / 2 + math.cos(a) * dist; cy = size * 0.55 + math.sin(a) * dist * 0.8 - (1 - k) * size * 0.12
            rr = size * 0.22 * k * r.uniform(0.7, 1.15)
            d.ellipse([cx - rr, cy - rr * 1.25, cx + rr, cy + rr * 0.9], fill=col + (235,))
        # flickering tongues
        for _ in range(3):
            tx = size / 2 + r.uniform(-size * 0.2, size * 0.2) * k; th = size * 0.45 * k
            d.polygon([(tx - size * 0.07 * k, size * 0.5), (tx + size * 0.07 * k, size * 0.5), (tx + r.uniform(-4, 4), size * 0.5 - th)], fill=col + (220,))
        lay = lay.filter(ImageFilter.GaussianBlur(1.6))
        im = Image.alpha_composite(im, lay)
    return im

for i in range(4): save(blob_flame(100 + i), f'flame_{i}.png')

# burning ground decal: dark scorch ellipse with embers
W, H = 96, 36
im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
d.ellipse([2, 4, W - 2, H - 2], fill=(30, 12, 6, 170))
d.ellipse([10, 9, W - 10, H - 7], fill=(90, 25, 5, 160))
for _ in range(22):
    x = rnd.uniform(14, W - 14); y = rnd.uniform(10, H - 9); rr = rnd.uniform(1.5, 4)
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, rnd.randint(120, 220), 30, 230))
save(im.filter(ImageFilter.GaussianBlur(0.8)), 'burn.png')

# shuriken: 4-point steel star with red claw centre
S = 32
im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
c = S / 2
pts = []
for k in range(8):
    a = k * math.pi / 4; rr = 15 if k % 2 == 0 else 5
    pts.append((c + math.cos(a) * rr, c + math.sin(a) * rr))
d.polygon(pts, fill=(200, 210, 222, 255), outline=(60, 64, 74, 255))
for k in range(4):
    a = k * math.pi / 2 + 0.25
    d.line([(c, c), (c + math.cos(a) * 12, c + math.sin(a) * 12)], fill=(250, 252, 255, 255), width=1)
d.ellipse([c - 4, c - 4, c + 4, c + 4], fill=(200, 30, 40, 255), outline=(40, 10, 10, 255))
d.ellipse([c - 1.5, c - 1.5, c + 1.5, c + 1.5], fill=(20, 20, 20, 255))
save(im, 'shuriken.png')

# smoke puff (teleport / vent)
S = 64
im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
for _ in range(16):
    a = rnd.uniform(0, math.tau); dist = rnd.uniform(0, 14)
    cx = S / 2 + math.cos(a) * dist; cy = S / 2 + math.sin(a) * dist; rr = rnd.uniform(8, 15); g = rnd.randint(70, 130)
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(g, g - 10, g + 15, 150))
save(im.filter(ImageFilter.GaussianBlur(2.2)), 'smoke.png')

# slash streak (claw ninja teleport strike)
im = Image.new('RGBA', (110, 40), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
for i, (col, w) in enumerate([((255, 40, 60, 140), 14), ((255, 160, 170, 200), 7), ((255, 255, 255, 255), 2)]):
    d.arc([6, -40 + i, 104, 34 - i], 20, 160, fill=col, width=w)
save(im.filter(ImageFilter.GaussianBlur(0.6)), 'slash.png')

# pilot-light / nozzle glow
S = 48
im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
px = im.load()
for y in range(S):
    for x in range(S):
        dd = math.hypot(x - S / 2, y - S / 2) / (S / 2)
        if dd < 1: a = int(255 * (1 - dd) ** 2); px[x, y] = (120, 200, 255, a) if dd > 0.3 else (230, 245, 255, a)
save(im, 'pilot.png')
