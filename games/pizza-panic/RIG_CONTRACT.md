# Rig + animation contract (owned by Hermes)

Anything in this file is stable: combat, logic and the level systems can rely on it.
If a pose you need is missing, ask on the board and it gets added here — the point of
this file is that you never have to read rig.js to use it.

## Requesting a pose

One naming rule for every rig:

    `${kind}_${move}_${phase}`

- `kind` — a hero id (`turtle_blue`, `turtle_red`, `turtle_orange`, `turtle_purple`,
  `nous_girl`, `teknium`, `turbofit`) or an enemy type (`brawler`, `striker`,
  `blocker`, `thrower`, `charger`, `acrobat`).
- `move` — the move name (see the tables below).
- `phase` — `wind`, `active` or `recover`.

Player: set `state.hero` (or `state.selectedHero`) for the rig, and the rig reads the
attack from combat itself. Per-hit poses come from `HERO_CHAIN[hero]`, indexed by
`combat.chain` (1-based), so a 3-hit chain animates differently on each hit with no
extra plumbing. `HERO_KICK[hero]` is what plays when the kick button is used.

Enemies: set `ninja.move` + `ninja.phase` (or `ninja.attack = { move, phase }`).
`ninja.guard = true` plays the blocker's guard. A stun or hit-flash plays the hurt
reaction automatically.

Nothing is required: an unknown kind, an unknown move or an unknown phase falls back to
idle or walk, and a missing part image is skipped, so a bad name can never break the
render loop.

## Moves available now

Heroes (chains): blue `slash`/`slashUp`/`slashSpin` … red `stabL`/`stabR`/`stabFlurry` …
orange `nunchakuA`/`nunchakuB`/`nunchakuSpin` … purple `sweep`/`sweepB`/`sweepSpin` …
teknium `bladeA`/`bladeB`/`bladeC` … turbofit `axe`/`axeB`/`axeHeavy` …
nous_girl `whipA`/`whipB`/`wave`.

Hero specials and their data live in `HERO_SPECIALS` (root spin, hits, knockback,
pierce, launch, projectile FX). Nothing consumes it yet — read it and the animation
follows.

Enemies: brawler `swing`/`haymaker`, striker `dash`/`flurry`, blocker `guard`/`bash`,
thrower `throw`, charger `charge`/`pound`, acrobat `flip`/`jumpkick`/`spin`.

## Iteration-6 mechanics (already animatable, per rig)

`launcher`, `juggle`, `dashAttack`, `grab`, `grabThrow`, `backAttack`, `hitReact`,
`healthSpecial`, `groundPound`.

Each has `_wind` and `_active` (both distinct poses) and `_recover`, for all thirteen
rigs. So for a launcher on the blue turtle: `turtle_blue_launcher_wind` →
`turtle_blue_launcher_active`, reachable the same way as any other move.

## Hooks game.js expects to keep (Hermes-owned)

If game.js is rewritten, these are the seams the rest of my work hangs off. They are
all state callbacks or single lines, not systems:

- `state.audioCue(name)` — combat fires it; game.js maps names to sounds.
- `state.fxCue(name, data)` — combat fires it; game.js turns it into hit-stop shake,
  shockwave rings and the spark/dust sprites (`impacts.js`).
- `state.eventCue(type, data)` — scripted beats (`events.js`) use it for their sound,
  shake and dust.
- `stepEvents(state, dt)` once per simulated frame, and `drawEventOverlay(ctx, ...)`
  once per draw, for the dialogue band.
- `rig.draw(ctx, kind, rig.playerPose(state), x, rootY, flip, scale, key, dt)` for the
  player and `rig.draw(ctx, enemyRigKind(n), rig.enemyPose(n, t), ...)` for enemies.
- The camera reads `state.cameraX` and honours `state.events.camX` for beat holds.
- HUD: `SOUND %`, and the health bar is drawn from `hp/maxHp` for any enemy with
  `maxHp > 1`.

## Heroes world-class pass (Oct 15)

- Every hero has its own `${hero}_idleA|B|C`, `_walk1..4`, `_jump`, `_turn`, `_taunt`, `_victory` and
  per-move `_wind|_active|_follow|_recover` (recover = that hero's stance). `playerPose` returns the
  hero's walk/jump/turn names; anim.js cycles `${hero}_walkN` like the shared walk.
- Pose objects may carry `tw` (-1 coiled .. +1 driven through: shoulders/hips slide around the spine),
  `dx`/`dy` (root nudge, rig px). anim.js blends them like any joint.
- `solve(kind, angles, { poseName, animated })` in rig.js is the pure geometry draw() uses (matrices,
  per-part scale, draw order). Heroes get: per-hero layer order (`orderFor`), `PART_SCALE`
  proportion fixes, a soft wrist limit on the weapon (`WRIST`), and planted feet (lowest sole on
  `FOOT_Y` for animated grounded frames; `AIR_POSE` frames keep the idle offset).
- Tested by `pizza-panic-dev/check-rigs.mjs`.
