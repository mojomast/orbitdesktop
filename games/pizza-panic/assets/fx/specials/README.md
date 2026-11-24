# Hero special-move FX sheets (mr_india, t_fd630e9e9b1c4c85)

One sheet per hero special, 8 frames of 160x144 in a single row (sheet 1280x144), paletted PNG.
Frame i rect = [x, y, w, h] = [i*160, 0, 160, 144], i = 0..7, played over 0.5 s (62.5 ms per frame).
Anchor = the frame-space point drawn on the hero's feet (p.x, p.y + p.r - p.z); x runs toward the hero's facing
(the sheet is mirrored when facing left). Drawn at 1.35x by specialfx.js.

| hero | special | effect | anchor | bytes |
|---|---|---|---|---|
| turtle_purple | Bo Whirl | purple crescent, scale-up + spin + fade | 80, 134 | 45733 |
| turtle_blue | Blade Cyclone | blue ring, scale-up + slight spin + fade | 80, 134 | 50453 |
| turtle_red | Rising Uppercut | red burst pillar, vertical growth + fade | 80, 140 | 52658 |
| turtle_orange | Slide Kick | orange spiral, scale-up + spin + fade | 80, 134 | 56563 |
| nous_girl | Bass Drop | pink/cyan sound rings, scale-up forward + fade | 22, 126 | 47569 |
| teknium | Data Burst | green energy-blade streak, horizontal stretch + fade | 10, 124 | 30751 |
| turbofit | Power Chord | gold lightning dome burst then fade; the cracked slab stays | 80, 140 | 52940 |

Frame rects (same for every sheet):

- frame 0: [0, 0, 160, 144]
- frame 1: [160, 0, 160, 144]
- frame 2: [320, 0, 160, 144]
- frame 3: [480, 0, 160, 144]
- frame 4: [640, 0, 160, 144]
- frame 5: [800, 0, 160, 144]
- frame 6: [960, 0, 160, 144]
- frame 7: [1120, 0, 160, 144]

Source art: /workspace/fx-art/fx-turtles.jpg + fx-others.jpg; rebuild with /workspace/fx-art/cut_fx.py, split_turbo.py, build_sheets.py.
