# Character select portraits

240x300 RGB cards, no baked text (the select screen draws names, weapon and blurb).
Built from each hero's `../<id>/sheet.jpg` by `pizza-panic-dev/tools/make_portraits.py`:
magenta keyed out, head-and-torso bust over the hero's colour gradient, weapon on a
diagonal behind. Re-run the script after a sheet changes. Previous 120x150 labelled
portraits are in ~/backups/pizza-panic-select-2151/src/assets/heroes/portraits/.

## Reaction frames (hurt / win)

`reactions.png`: ONE 480x2100 RGB atlas (kept to one file for the 500-file publish limit).
Row r = `HEROES[r]` in heroes.js order (turtle_purple, turtle_blue, turtle_red, turtle_orange,
nous_girl, teknium, turbofit); column 0 = hurt, column 1 = win; each cell is a 240x300 card on
the same gradient as `<id>.png` (which stays the idle frame). Cell for hero i, mood m:
`sx = m * 240, sy = i * 300`. No baked text. Built from /workspace/pizza-art/reactions/gen/
by `pizza-panic-dev/tools/make_reactions.py`; checked by `pizza-panic-dev/check-reactions.mjs`.
