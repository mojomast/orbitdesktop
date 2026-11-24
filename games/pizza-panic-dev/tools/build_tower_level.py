"""Build the OpenClaw Tower level strips from the generated paintings in
/workspace/pizza-tower/gen/ (1024x576) into the game's level format:
1814x510 strips = a 907px painting + its mirror, so each tile loops seamlessly.
  assets/levels/far/tower.jpg          far parallax (night sky + claw searchlight)
  assets/levels/tower_mid.png          lobby (window sky cut to alpha -> far shows)
  assets/levels/tower_server_mid.png   server floor (cooler, red-alert regrade)
  assets/levels/tower_throne_mid.png   penthouse throne room (boss arena)
  assets/levels/tower.jpg              flat fallback (lobby over far)
usage: python3 tools/build_tower_level.py [gen_dir]
"""
import sys, os
from PIL import Image, ImageOps, ImageEnhance, ImageDraw, ImageFilter
GEN = sys.argv[1] if len(sys.argv) > 1 else '/workspace/pizza-tower/gen'
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'pizza-panic', 'assets', 'levels')
W1, H = 907, 510

def strip(im):
    im = im.resize((W1, H), Image.LANCZOS)
    out = Image.new(im.mode, (W1 * 2, H)); out.paste(im, (0, 0)); out.paste(ImageOps.mirror(im), (W1, 0))
    return out

def sky_cut(im):
    # Lobby window: original window glass ~x262-698, sky y268-330 (skyline below).
    # Fade alpha to 0 in the sky band so the far layer (searchlight, stars) shows.
    k = W1 / 1024
    x0, x1, y0, y1, fade = int(264 * k), int(696 * k), int(270 * k), int(332 * k), int(26 * k)
    a = Image.new('L', im.size, 255); d = ImageDraw.Draw(a)
    for y in range(y0, y1):
        v = 0 if y < y1 - fade else int(255 * (y - (y1 - fade)) / fade)
        d.line([(x0, y), (x1, y)], fill=v)
    a = a.filter(ImageFilter.GaussianBlur(1.2))
    im = im.convert('RGBA'); im.putalpha(a); return im

def regrade(im, r, g, b, bright=1.0):
    rgb = im.convert('RGB'); rr, gg, bb = rgb.split()
    rr = rr.point(lambda v: min(255, int(v * r))); gg = gg.point(lambda v: min(255, int(v * g))); bb = bb.point(lambda v: min(255, int(v * b)))
    out = ImageEnhance.Brightness(Image.merge('RGB', (rr, gg, bb))).enhance(bright)
    if im.mode == 'RGBA': out = out.convert('RGBA'); out.putalpha(im.split()[3])
    return out

main = Image.open(os.path.join(GEN, 'tower_main.jpg')).convert('RGB')
far = Image.open(os.path.join(GEN, 'tower_far.jpg')).convert('RGB')
throne = Image.open(os.path.join(GEN, 'tower_throne.jpg')).convert('RGB')

far_s = strip(far); far_s.save(os.path.join(OUT, 'far', 'tower.jpg'), quality=90)
lobby = sky_cut(main.resize((W1, H), Image.LANCZOS))
lobby_s = Image.new('RGBA', (W1 * 2, H)); lobby_s.paste(lobby, (0, 0)); lobby_s.paste(ImageOps.mirror(lobby), (W1, 0))
lobby_s.save(os.path.join(OUT, 'tower_mid.png'), optimize=True)
server = regrade(ImageOps.mirror(lobby_s), 1.15, 0.85, 0.95, 0.92)  # red-alert server floor, mirrored phase
server.save(os.path.join(OUT, 'tower_server_mid.png'), optimize=True)
strip(throne).convert('RGBA').save(os.path.join(OUT, 'tower_throne_mid.png'), optimize=True)
flat = far_s.convert('RGBA'); flat.alpha_composite(lobby_s); flat.convert('RGB').save(os.path.join(OUT, 'tower.jpg'), quality=88)
print('built tower strips ->', os.path.abspath(OUT))
