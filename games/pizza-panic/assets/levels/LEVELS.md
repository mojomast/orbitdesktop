# Side-scrolling level strips (mr_india)
Each strip is 1814x510: a 907px painting plus its mirror, so it loops seamlessly (tile every 1814px; parallax-friendly). Coordinates are strip pixels, with y from the top.

| File | Walkable floor band (y) | Obstacles (block walking) | Notes |
|---|---|---|---|
| sewer.jpg | 363-456 | crates x332-500 and x1314-1482, y 295-376 (their bases cross the back edge of the floor, so block y363-380 there) | toxic green water above y363 is lethal or unwalkable; below y456 is the front wall |
| street.jpg | 358-510 (sidewalk 358-380, road 380-510) | none on the floor (dumpster and cans sit against the wall, above y358) | night rain, neon pizza shop |
| rooftop.jpg | 358-425 | none; below y425 is the front ledge | dusk skyline |

Suggested level order: sewer, street, rooftop (boss).

## Distinct segments per strip tile (baba_booey)
Walking levels draw a different painting on each of their three 1814px tiles (parallax.js `SRC.seg`):

| Level | Tile 0 (x 0-1814) | Tile 1 (x 1814-3628) | Tile 2 (x 3628-5442) | Far layer |
|---|---|---|---|---|
| sewer | seg/sewer_a (the original; its 2 tunnel arches open onto the cavern) | seg/sewer_b (waterfall junction; top void cut) | seg/sewer_c (hideout outskirts: string lights, arcade, valve) | far/sewer.jpg (distant cavern) |
| street | street_mid.png (original, sky cut) | seg/street_b (pizzeria + pawn shop) | seg/street_c (scaffolding, dumpsters, subway stairs, claw billboard) | far/night.jpg |
| rooftop | rooftop_mid.png (original, sky cut) | seg/rooftop_b (HVAC, pigeon coop, dishes) | seg/rooftop_c (helipad, planters, stairwell hut, antenna) | far/dusk.jpg |

seg/* are a JPG plus an alpha `_mask.png`, joined once at load. Every tile keeps the floor bands above (same walkable band, opaque, painted floor on it); the sewer crates are painted at the collision crate rects on all three tiles. Built by pizza-panic-dev/tools/build_backgrounds.py from /workspace/pizza-bg/gen; checked by check-backgrounds.mjs.
