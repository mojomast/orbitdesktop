# Skate run near-field props (t_ff6cf63cc2c04b1e, baba_booey)

`skate_fg.png` is ONE palette-PNG atlas (1024x602, ~209 KB) for the 500-file publish limit.
Frame map: `FG_ATLAS.frames` in `parallax.js` (`[x, y, w, h]`); drawing sizes in `FG_KINDS`.
Built by `pizza-panic-dev/tools/build_skatefg.py` from /workspace/pizza-bg/skate-fg/gen/sheet1+2.jpg.
Drawn by the existing foreground-props path (darkened silhouette, 1.4x scroll, fades over
fighters, off with Reduced motion); placed by `FG_THEME[3]` every ~800 fg px, repeating each
`SKATE_PERIOD` (9600). Pivot = bottom-centre for ground props (drawn at y = H + sink - h),
top-centre for `@top` props (y = -sink). lit = neon, darkened 0.3 instead of 0.58.

| prop | frame w x h | drawn h | sink | anchor | notes |
|---|---|---|---|---|---|
| trash_bags | 318x264 | 130 | 16 | bottom | bags + pizza box |
| barricade | 273x300 | 165 | 20 | bottom | striped, amber lamp |
| dumpster | 277x300 | 210 | 26 | bottom | lid open |
| tire_stack | 265x283 | 185 | 20 | bottom | broken board leaning |
| neon_slice | 196x202 | 150 | -90 | top | cyan wall sign; loose brick ledge cropped off; lit |
| arrow_sign | 141x300 | 300 | 10 | bottom | pink neon arrow on a pole, points right (travel direction); tight key; lit |
| hanging_cables | 250x300 | 260 | 0 | top | cables run off the frame top (anchor), dangling lamp |
| no_entry | 130x300 | 340 | 10 | bottom | sign on a post |

Ground props stay low (<= 210 px, poles excepted) so the skate cones/barriers stay readable; the layer fades only over fighters, not over skate obstacles.
