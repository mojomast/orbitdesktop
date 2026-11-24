// Impact and motion FX layer: MR.INDIA's transparent hit sprites (assets/fx/)
// played as short, scale-up-and-fade pops. Kept separate from fx.js so the
// particle/UI effects there stay untouched.
//
// Sprites face right, so they are mirrored when the actor faces left.
const SPEC = {
  spark: { file: 'spark.png', w: 52, h: 56, mode: 'hit' },
  spark_heavy: { file: 'spark_heavy.png', w: 73, h: 72, mode: 'hit' },
  dust: { file: 'dust.png', w: 55, h: 56, mode: 'ground' },
  puff: { file: 'puff.png', w: 37, h: 36, mode: 'ground' },
  swoosh: { file: 'swoosh.png', w: 72, h: 64, mode: 'swing' },
};
const LIFE = 0.12;   // ~120ms per pop, as specified

export function createImpacts() {
  function roundRect(ctx, x, y, w, h, r) { const radius = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + radius, y); ctx.arcTo(x + w, y, x + w, y + h, radius); ctx.arcTo(x + w, y + h, x, y + h, radius); ctx.arcTo(x, y + h, x, y, radius); ctx.arcTo(x, y, x + w, y, radius); ctx.closePath(); }
  const images = {};
  for (const [name, spec] of Object.entries(SPEC)) {
    const im = new Image();
    im.onload = () => { images[name] = im; };
    im.src = 'assets/fx/' + spec.file;
  }
  let live = [], played = {}, total = 0;

  function spawn(name, x, y, facing = 1, opt = {}) {
    const spec = SPEC[name];
    if (!spec || !images[name]) return false;
    live.push({
      name, spec, x, y,
      facing: facing < 0 ? -1 : 1,
      t: 0,
      scale: opt.scale || 1,
      rotation: opt.rotation || 0,
      delay: opt.delay || 0,
      aura: !!opt.aura,
      shade: opt.shade || null,
    });
    played[name] = (played[name] || 0) + 1;
    total += 1;
    return true;
  }

  // Called from the combat event hook: pick the sprite from what happened.
  // Impact juice gets layered: a bright contact spark, a heavier descending
  // cloud for bigger blows, then a smaller kicker so hits read as weight rather
  // than one transparent shape appearing for 120ms.
  function onEvent(kind, data = {}) {
    const facing = data.facing || 1;
    const x = data.x, y = data.y;
    let hit = false;
    if (kind === 'hit') {
      hit = spawn(data.heavy ? 'spark_heavy' : 'spark', x, y, facing, {
        scale: data.heavy ? 1.15 : 0.92, aura: !!data.heavy, shade: data.heavy ? '#ff8a8a' : null,
      });
      if (data.heavy) spawn('dust', x + (facing < 0 ? -8 : 8), y + 6, facing, { scale: 0.75, rotation: 0.18, delay: 0.025 });
      else if (data.blocked) spawn('puff', x + (facing < 0 ? -3 : 3), y + 2, -facing, { scale: 0.75 });
      else spawn('puff', x, y + 5, facing, { scale: 0.45 });
    } else if (kind === 'land' || kind === 'launch') {
      hit = spawn(kind === 'launch' ? 'spark_heavy' : 'dust', x, y, facing, { scale: kind === 'launch' ? 0.85 : 1.05, aura: kind === 'launch', rotation: kind === 'launch' ? 0 : -0.1 });
      if (kind === 'launch') spawn('dust', x + (facing < 0 ? 6 : -6), y + 4, facing, { scale: 0.6, delay: 0.02 });
      else spawn('puff', x + (facing < 0 ? -14 : 14), y + 1, facing, { scale: 0.55 });
    } else if (kind === 'swing') {
      hit = spawn('swoosh', x, y, facing, { scale: 0.85, rotation: -0.2 * (facing < 0 ? -1 : 1) });
      spawn('puff', x - (facing < 0 ? -5 : 5), y + 7, facing, { scale: 0.35 });
    } else if (kind === 'finisher') {
      hit = spawn('spark_heavy', x, y, facing, { scale: 1.25, aura: true, shade: '#ff8a8a', rotation: -0.22 * (facing < 0 ? -1 : 1) });
      if (hit) spawn('dust', x, y + 6, facing, { scale: 0.95, rotation: 0.18 });
    } else if (kind === 'step') {
      hit = spawn('puff', x, y, facing, { scale: 0.38 });
    } else if (kind === 'dash') {
      hit = spawn('swoosh', x, y, facing, { scale: 0.65, rotation: -0.14 * (facing < 0 ? -1 : 1) });
    }
    return hit;
  }

  function step(dt) {
    if (!live.length) return;
    for (const e of live) e.t += dt;
    live = live.filter(e => e.t < LIFE);
  }

  function draw(ctx) {
    for (const e of live) {
      if (e.delay > e.t) continue;
      const im = images[e.name];
      if (!im) continue;
      const local = Math.min(1, Math.max(0, (e.t - e.delay) / LIFE));
      const p = local / (1 + (e.spec.mode === 'ground' ? 0.35 : 0));
      const life = Math.max(0, 1 - Math.min(1, local));
      const fade = 1 - local * local;
      const base = 0.55 + (e.spec.mode === 'hit' ? local * 0.45 : local * 0.35);
      const scale = base * (e.scale || 1) * (1 + (e.aura ? 0.08 * (1 - life) : 0));
      const sw = e.spec.w * scale, sh = e.spec.h * scale;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 0.96 * fade - (e.delay > 0 ? 0.05 : 0));
      if (e.aura) {
        ctx.save();
        ctx.translate(e.x, e.y);
        ctx.globalAlpha *= 0.18 + 0.22 * (1 - life);
        ctx.fillStyle = e.shade || '#ffe86b';
        ctx.beginPath(); ctx.arc(0, 0, sw * 0.75, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 0.96 * fade;
      }
      ctx.translate(e.x, e.y);
      if (e.facing < 0) ctx.scale(-1, 1);
      if (e.rotation) ctx.rotate(e.rotation);
      ctx.drawImage(im, -sw / 2, -sh / 2, sw, sh);
      // A ground dust smudge behind sprites so they absorb the floor rather
      // than floating on top of it; this is the "weight" the pass adds.
      if (e.spec.mode === 'ground' || e.spec.mode === 'hit') {
        const hx = (e.facing < 0 ? -1 : 1) * ((e.t * 28) % 6);
        ctx.globalAlpha = 0.18 * life;
        ctx.fillStyle = 'rgba(20,28,18,0.45)';
        roundRect(ctx, -sw * 0.45 + hx, sh * 0.3 + e.t * 3, sw * 0.9, 4, 2); ctx.fill();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }


  return { spawn, onEvent, step, draw, images, stats: () => ({ total, played, live: live.length }) };
}
