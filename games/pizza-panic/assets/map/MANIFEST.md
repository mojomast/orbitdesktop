# assets/map: world map interstitial (baba_booey, t_5f5d1eed411041b2)

Two runtime files, used only by `worldmap.js` (shown between stages, ~2.5 s, any key / pad button skips).

| file | size | what |
|---|---|---|
| `map.jpg` | 960x540 JPG q86 | City map with the painted route. The baked stage numbers are painted out (node badges only); the stage title is canvas text. |
| `map_ui.png` | 513x96 palette PNG, alpha | UI atlas: hero pin, slice pointer, CLEARED stamp, padlock, gold node, gray node |

## Layer order (bottom to top)
1. `map.jpg`, fit to width, with letterbox bars for the caption text
2. a dashed gold line for the leg being travelled (straight line between the two nodes)
3. node badges: `node_gold` + `stamp` for cleared stages, a pulsing `node_gold` + bobbing `slice` for the next stage, and `node_gray` + `lock` for later stages
4. `pin` (hero marker): eased straight glide plus a hop from the cleared node to the next node, tip on the node

## Node spots (map px, keyed by stage NAME = `LEVELS[i].id`)
sewer 108,429 · street 188,236 · skate 377,171 · subway 484,304 · rooftop 631,177 · harbor 781,372 · arcade 841,244 · tower 796,112

Play order is `LEVEL_ORDER` = sewer, street, skate, subway, rooftop, arcade, harbor, tower. The painted
route branches differently, so the pin always takes a straight eased path between nodes.

## Atlas frames `[x, y, w, h]` in map_ui.png
pin 0,0,81,96 · slice 83,0,69,96 · stamp 154,0,93,96 · lock 249,0,75,96 · node_gold 326,0,93,96 · node_gray 421,0,92,96

## Rebuild
`pizza-panic-dev/tools/build_worldmap.py` (sources in /workspace/pizza-art/map/). It paints out the digits,
resizes, keys the UI sheet off magenta, packs and quantizes it, and prints the node and frame maps above
(which are mirrored in `worldmap.js`).
