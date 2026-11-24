# AGENT ARMEGEDDON: CLAWPOCALYPSE NOW cutout rig (turtle + foot ninja)

Files: `rig/turtle_{head,torso,uarm,farm,thigh,shin,staff}.png`, `rig/foot_{head,torso,uarm,farm,thigh,shin,katana}.png`. Same scale (torso 34px tall); assembled height about 90px. **Iteration 7:** hero and enemy parts (heroes/, enemies/) are now re-sliced at torso 68px (2x, ~180px assembled) and drawn at RIG_SCALE 0.7 (~126px on screen). These legacy turtle_purple/foot parts have no magenta source sheet, so game.js draws them at 2x RIG_SCALE (1.4) instead; re-slicing them needs a parts sheet. Feet sit 63 screen px below the torso pivot for every rig.
Native facing: turtle faces **right**, foot ninja faces **left** (mirror with `flip`). Coordinates are part-local px from the image's top-left; angles are degrees, clockwise-positive (canvas convention), 0 = the part as drawn.
`_b` = back limb: same image, drawn first and darkened (`ctx.filter='brightness(0.6)'`). The root is `torso`; place the rig by the torso pivot (about the character's centre; feet are about +45px below it).

## turtle

| part | image | size | pivot (local) | parent | attach (parent px) |
|---|---|---|---|---|---|
| torso | turtle_torso.png | 24x34 | 12,17 | - | - |
| head | turtle_head.png | 34x27 | 20,25 | torso | 13,4 |
| uarm_b | turtle_uarm.png | 11x26 | 5,2 | torso | 12,8 |
| farm_b | turtle_farm.png | 17x25 | 8,2 | uarm_b | 5,23 |
| thigh_b | turtle_thigh.png | 18x26 | 9,2 | torso | 10,30 |
| shin_b | turtle_shin.png | 24x23 | 8,2 | thigh_b | 9,23 |
| thigh | turtle_thigh.png | 18x26 | 9,2 | torso | 14,30 |
| shin | turtle_shin.png | 24x23 | 8,2 | thigh | 9,23 |
| uarm | turtle_uarm.png | 11x26 | 5,2 | torso | 15,8 |
| farm | turtle_farm.png | 17x25 | 8,2 | uarm | 5,23 |
| staff | turtle_staff.png | 63x5 | 31,2 | farm_b | 8,21 |

## foot

| part | image | size | pivot (local) | parent | attach (parent px) |
|---|---|---|---|---|---|
| torso | foot_torso.png | 18x34 | 9,17 | - | - |
| head | foot_head.png | 18x21 | 10,19 | torso | 9,3 |
| uarm_b | foot_uarm.png | 11x27 | 5,2 | torso | 10,8 |
| farm_b | foot_farm.png | 14x31 | 6,2 | uarm_b | 5,24 |
| thigh_b | foot_thigh.png | 15x24 | 7,2 | torso | 10,31 |
| shin_b | foot_shin.png | 18x24 | 11,2 | thigh_b | 7,21 |
| thigh | foot_thigh.png | 15x24 | 7,2 | torso | 7,31 |
| shin | foot_shin.png | 18x24 | 11,2 | thigh | 7,21 |
| uarm | foot_uarm.png | 11x27 | 5,2 | torso | 7,8 |
| farm | foot_farm.png | 14x31 | 6,2 | uarm | 5,24 |
| katana | foot_katana.png | 23x36 | 5,31 | farm | 8,28 |

Pivot meaning: head = neck bottom; uarm = shoulder top; farm = elbow top; thigh = hip top; shin = knee top; staff/katana = grip. The turtle staff is held in the back hand, the katana in the front hand.

Weapon grip (rig QA, mr_india): a part manifest section may carry a `Weapon grip: N` line. The generator emits it as `grip: N` on that rig's weapon row and rig.js adds it to the pose's `weapon` angle, so vertical weapon art (katana, axe-guitar, mic, sword) sits in the fist the same way the horizontal staff/bat art does under the shared poses. A natural fist grip keeps the weapon's long axis within about -160..+20 degrees of the forearm (elbow -> hand) axis, measured clockwise in the right-facing frame; `pizza-panic-dev/check-weapon-angle.mjs` gates every attack frame against that.

## Draw order (back to front)

`uarm_b`, `farm_b`, `thigh_b`, `shin_b`, `staff`, `katana`, `torso`, `thigh`, `shin`, `head`, `uarm`, `farm` (skip parts the rig lacks).

## Pose keyframes (degrees; unlisted parts = 0)

Values are for the turtle (facing right; positive swings the limb backward/clockwise). For the foot ninja (facing left) negate the angles, or draw it with flip so that the same table applies.

| pose | torso | head | uarm | farm | uarm_b | farm_b | thigh | shin | thigh_b | shin_b | weapon |
|---|---|---|---|---|---|---|---|---|---|---|---|
| idle | 0 | 0 | 10 | -20 | -15 | -50 | -5 | 0 | 6 | 0 | -60 |
| walk 1 | 3 | 0 | 30 | -10 | -30 | -50 | -25 | 10 | 25 | 15 | -60 |
| walk 2 | 0 | 0 | 0 | -20 | 0 | -50 | 0 | 25 | 0 | 5 | -60 |
| walk 3 | 3 | 0 | -30 | -25 | 30 | -40 | 25 | 15 | -25 | 10 | -60 |
| walk 4 | 0 | 0 | 0 | -20 | 0 | -50 | 0 | 5 | 0 | 25 | -60 |
| punch | 8 | -5 | -80 | -10 | 20 | -60 | -10 | 5 | 15 | 0 | -40 |
| kick | -10 | 5 | 25 | -30 | -25 | -50 | -85 | -10 | 10 | 10 | -60 |
| jump | -5 | -5 | -40 | -60 | -30 | -70 | -40 | 60 | -20 | 50 | -90 |

Walk: loop the 4 frames at ~8 fps (or lerp between them), bob the root -2px on frames 1 and 3. Punch: 0.08s wind-up from idle, hold 0.1s, return. Kick: same timing. Jump: hold while airborne. Foot ninja idle in the preview used katana -20, uarm -15, farm 25, uarm_b 15, farm_b 30, thigh 5, thigh_b -6.

## Example drawRig

```js
// parts: { torso: {img, px, py, parent, ax, ay}, uarm_b: {...}, ... }  (px,py = pivot; ax,ay = attach in parent px)
// pose: { uarm: 10, farm: -20, ... } degrees.  ORDER: draw order array from above.
function drawRig(ctx, parts, pose, x, y, flip) {
  const toRad = d => (d || 0) * Math.PI / 180;
  // chain of ancestors (root first) for one part
  const chain = name => { const c = []; for (let n = name; n; n = parts[n].parent) c.unshift(n); return c; };
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.scale(-1, 1);
  for (const name of ORDER) {
    const part = parts[name]; if (!part || !part.img) continue;
    ctx.save();
    for (const n of chain(name)) {
      const p = parts[n];
      if (p.parent) { const q = parts[p.parent]; ctx.translate(p.ax - q.px, p.ay - q.py); }
      ctx.rotate(toRad(pose[n]));
    }
    if (name.endsWith('_b')) ctx.filter = 'brightness(0.6)';
    ctx.drawImage(part.img, -part.px, -part.py);
    ctx.restore();
  }
  ctx.restore();
}
// _b parts reuse the base image: parts.uarm_b = { ...parts.uarm, ax: 12, ay: 8 } etc. (see the tables).
```

Preview: /workspace/pp-rig-preview.png (idle pose, rendered with these numbers).
