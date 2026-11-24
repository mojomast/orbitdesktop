# Level ambience sheets (mr_india, t_dd91539751db48a4)

One row per sheet, paletted PNG. Frame i rect = [i*w, 0, w, h]. Drawn by amb-fx.js right after the far/mid
parallax layers (before props and fighters), low alpha, own parallax factor; off under Reduced motion or ?amb=0.

| sheet | level | frame w x h | frames | bytes | content |
|---|---|---|---|---|---|
| sewer.png | 0 | 112 x 160 | 8 | 14128 | steam puffs rising from the bottom centre; loop, 8 frames |
| street.png | 1 | 97 x 118 | 8 | 18742 | neon pizza sign: on, on, flicker, on, off, off, on, dim |
| subway.png | 5 | 128 x 120 | 6 | 25342 | spark burst growing from the bottom-left origin, then fading |
| rooftop.png | 2 | 160 x 70 | 8 | 6052 | rain streaks scrolling down-left; each frame tiles seamlessly in x and y |
| tower.png | 4 | 64 x 56 | 8 | 8031 | pigeon flap cycle, facing left (flies right-to-left; mirror for the other way) |

Frame rects:
- sewer: [0, 0, 112, 160], [112, 0, 112, 160], [224, 0, 112, 160], [336, 0, 112, 160], [448, 0, 112, 160], [560, 0, 112, 160], [672, 0, 112, 160], [784, 0, 112, 160]
- street: [0, 0, 97, 118], [97, 0, 97, 118], [194, 0, 97, 118], [291, 0, 97, 118], [388, 0, 97, 118], [485, 0, 97, 118], [582, 0, 97, 118], [679, 0, 97, 118]
- subway: [0, 0, 128, 120], [128, 0, 128, 120], [256, 0, 128, 120], [384, 0, 128, 120], [512, 0, 128, 120], [640, 0, 128, 120]
- rooftop: [0, 0, 160, 70], [160, 0, 160, 70], [320, 0, 160, 70], [480, 0, 160, 70], [640, 0, 160, 70], [800, 0, 160, 70], [960, 0, 160, 70], [1120, 0, 160, 70]
- tower: [0, 0, 64, 56], [64, 0, 64, 56], [128, 0, 64, 56], [192, 0, 64, 56], [256, 0, 64, 56], [320, 0, 64, 56], [384, 0, 64, 56], [448, 0, 64, 56]

Source: /workspace/amb-art/ambience.jpg; rebuild with /workspace/amb-art/cut_amb.py + build_amb.py.
