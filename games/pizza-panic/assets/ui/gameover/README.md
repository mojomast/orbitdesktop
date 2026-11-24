# assets/ui/gameover (baba_booey, t_a4826c482cfc4c4a)

| file | size | used by |
|---|---|---|
| `continue.jpg` | 740x510 JPG | screens.js drawContinue: fades in over the world, then DOLAN's grey drain and darkening run over it as the countdown runs out |
| `gameover.jpg` | 740x510 JPG | screens.js: rises over the drained continue art during the glass crack, then sits under the GAME OVER text (drawFinal) |

No text is baked in. The CONTINUE? banner (`assets/ui/continue.png`), the digits, the ring and all captions are drawn on top.
The text areas are pre-darkened in the JPGs: on the continue art, behind the banner, the digits and the bottom two lines; on the game-over art, a band behind GAME OVER and the stats.
Fit: from the 1024x576 sources, scaled to a width of 772 (16 px trimmed per side, so the edge heroes stay in frame).
The remaining 38 px at the top and bottom are mirrored edge bands that fade dark.
Rebuild: `pizza-panic-dev/tools/build_gameover.py /workspace/pizza-art/gameover/gen`
