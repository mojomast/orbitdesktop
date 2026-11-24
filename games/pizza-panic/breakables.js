// breakables.js — smashable level props and the pickups they drop (DOLAN).
// Crates, barrels, trash cans and pizza boxes from props.js take hits from the
// player's melee (combat.js attackBox, same depth-lane rule) and thrown pizzas,
// wobble, shatter into debris, free their collision footprint and drop a pickup.
// Pickups: pizza (heal 35), soda (heal 15), ruby (+1000), emerald (+500).
import { placementsFor, propObstacles } from './props.js';
import { LEVELS } from './collision.js';
import { attackBox, DEPTH } from './combat.js';
import { healPlayer } from './logic.js';

export const BREAKABLE = {
  crate: { hp: 3, debris: ['wood', 'wood', 'wood'], drops: [['pizza', 0.35], ['ruby', 0.3], ['emerald', 0.35]] },
  barrel: { hp: 2, debris: ['metal', 'metal', 'wood'], drops: [['soda', 0.5], ['emerald', 0.5]] },
  trashcan: { hp: 2, debris: ['lid', 'metal', 'cardboard'], drops: [['soda', 0.4], ['emerald', 0.4], ['ruby', 0.2]] },
  pizzaboxes: { hp: 1, debris: ['cardboard', 'cardboard', 'cardboard'], drops: [['pizza', 1]] },
};
export const PICKUPS = { pizza: { heal: 35, label: '+HP' }, soda: { heal: 15, label: '+HP' }, ruby: { score: 1000, coins: 3 }, emerald: { score: 500, coins: 1 } }; // coins: shop.js pizza coins
const DEBRIS_COLORS = { wood: '#8a5a2b', metal: '#6b6f74', lid: '#4f7a3a', cardboard: '#c9a26a' };

export function createBreakables({ audio, rand = Math.random } = {}) {
  const img = {};
  for (const n of Object.keys(PICKUPS)) { try { const im = new Image(); im.src = 'assets/pickups/' + n + '.png'; img['p_' + n] = im; } catch (_) {} }
  for (const n of Object.keys(DEBRIS_COLORS)) { try { const im = new Image(); im.src = 'assets/debris/' + n + '.png'; img['d_' + n] = im; } catch (_) {} }
  const play = n => { try { audio && audio.play(n); } catch (_) {} };
  let owner = null, props = {}, debris = [], pickups = [], texts = [], lastPhase = null, swing = 0;
  const stats = { hits: 0, broken: 0, dropped: 0, collected: 0 };

  // Collision footprints for each placement, matched to the live LEVELS objects.
  function footprints(li) {
    const lv = LEVELS[li]; if (!lv) return [];
    const obs = lv.obstacles || [];
    return propObstacles(li).map(f => obs.find(o => o.x === f.x && o.y === f.y && o.w === f.w && o.h === f.h) || null);
  }
  function restoreAll() {
    for (const k of Object.keys(props)) for (const b of props[k]) if (b.ob && b.ob.__x0 != null) { b.ob.x = b.ob.__x0; delete b.ob.__x0; }
    props = {}; debris = []; pickups = []; texts = [];
  }
  function levelProps(li) {
    if (props[li]) return props[li];
    const fps = footprints(li);
    props[li] = placementsFor(li).map((p, i) => {
      const def = BREAKABLE[p.name];
      const foot = p.spec ? p.spec.foot : [0, 0, 0, 0];
      return { i, p, def, hp: def ? def.hp : Infinity, broken: false, wob: 0, flash: 0, swing: -1, ob: fps[i],
        x0: p.x - p.spec.w / 2, x1: p.x + p.spec.w / 2, footY: p.baseY - p.spec.h + foot[1] + foot[3] / 2, top: p.baseY - p.spec.h, bot: p.baseY };
    });
    return props[li];
  }
  function current(s) {
    if (owner !== s) { restoreAll(); owner = s; }
    const li = s.level | 0;
    return li >= 0 && li <= 2 ? levelProps(li) : [];
  }

  function hit(s, b, dmg, dir) {
    b.hp -= dmg; b.wob = 0.3 * (dir || 1); b.flash = 0.1; stats.hits++;
    if (s.fxCue) s.fxCue('hit', { x: b.p.x, y: b.footY - 20, heavy: dmg > 1, shake: 0.06 });
    play('crunch');
    if (b.hp <= 0) smash(s, b, dir);
  }
  function smash(s, b, dir) {
    b.broken = true; stats.broken++;
    if (b.ob) { b.ob.__x0 = b.ob.x; b.ob.x -= 1e6; } // free the footprint (restored on a new run)
    play('smash');
    const cx = b.p.x, cy = b.top + (b.bot - b.top) * 0.45;
    for (let k = 0; k < 8; k++) {
      const kind = b.def.debris[k % b.def.debris.length];
      debris.push({ kind, sprite: k < 3, x: cx + (rand() - 0.5) * 30, y: cy + (rand() - 0.5) * 20, vx: (dir || 1) * (40 + rand() * 160) * (rand() < 0.25 ? -1 : 1), vy: -160 - rand() * 200, floor: b.footY + (rand() - 0.5) * 16, rot: rand() * 6, vr: (rand() - 0.5) * 14, t: 0, life: 1.1 + rand() * 0.6, size: k < 3 ? 0.8 + rand() * 0.3 : 4 + rand() * 5 });
    }
    // Drop one pickup from the prop's table.
    let r = rand(), type = b.def.drops[b.def.drops.length - 1][0];
    for (const [t, w] of b.def.drops) { if (r < w) { type = t; break; } r -= w; }
    pickups.push({ type, x: cx, y: b.bot + 12, z: 30, vz: 220, vx: (dir || 1) * 40, t: 0 }); stats.dropped++;
  }

  function step(s, dt) {
    const list = current(s);
    const c = s.combat;
    const phase = c && c.attack && !c.attack.hold ? c.phase : null;
    if (phase === 'active' && lastPhase !== 'active') swing++;
    lastPhase = phase;
    if (phase === 'active' && c.attack) {
      const box = attackBox(s, c.attack);
      for (const b of list) {
        if (b.broken || !b.def || b.swing === swing) continue;
        if (box.x1 < b.x0 || box.x0 > b.x1) continue;
        if (Math.abs(s.player.y - b.footY) > box.depth + 22) continue;
        if (box.bot < b.top || box.top > b.bot) continue;
        b.swing = swing;
        hit(s, b, c.attack.heavy || c.attack.around ? 2 : 1, c.attackFacing || 1);
      }
    }
    for (const z of s.pizzas || []) {
      if (z.dead) continue;
      for (const b of list) {
        if (b.broken || !b.def) continue;
        if (z.x > b.x0 && z.x < b.x1 && Math.abs(z.y - b.footY) < DEPTH + 26) { z.dead = true; hit(s, b, 1, Math.sign((z.vx || 1)) || 1); break; }
      }
    }
    for (const b of list) { b.wob *= Math.max(0, 1 - dt * 9); b.flash = Math.max(0, b.flash - dt); }
    for (const d of debris) {
      d.t += dt; d.x += d.vx * dt; d.vy += 900 * dt; d.y += d.vy * dt; d.rot += d.vr * dt;
      if (d.y > d.floor) { d.y = d.floor; d.vy *= -0.35; d.vx *= 0.6; d.vr *= 0.5; }
    }
    debris = debris.filter(d => d.t < d.life);
    const p = s.player;
    for (const k of pickups) {
      k.t += dt; k.vz -= 700 * dt; k.z = Math.max(0, k.z + k.vz * dt); if (k.z === 0) { k.vz = Math.abs(k.vz) > 60 ? -k.vz * 0.4 : 0; k.vx *= 0.8; }
      k.x += k.vx * dt;
      if (!k.got && k.t > 0.35 && k.z < 12 && Math.abs(k.x - p.x) < 30 && Math.abs(k.y - p.y) < 26) {
        k.got = true; stats.collected++;
        const d = PICKUPS[k.type];
        if (d.heal) { healPlayer(s, d.heal); play('life'); texts.push({ x: k.x, y: k.y - 40, s: d.label, c: '#7cff6b', t: 0 }); }
        if (d.coins) s.coins = (s.coins || 0) + d.coins;
        if (d.score) { s.score += d.score; play('pickup'); texts.push({ x: k.x, y: k.y - 40, s: '+' + d.score, c: k.type === 'ruby' ? '#ff6b6b' : '#7cff6b', t: 0 }); }
      }
    }
    pickups = pickups.filter(k => !k.got && k.t < 14);
    for (const t of texts) t.t += dt;
    texts = texts.filter(t => t.t < 0.9);
  }

  // props.js draw modifier: skip broken props, wobble and flash hit ones.
  function propMod(li) {
    const list = props[li]; if (!list || !owner || (owner.level | 0) !== li) return null;
    return i => { const b = list[i]; if (!b) return {}; if (b.broken) return null; return { rot: b.wob * Math.sin(performance.now() / 25), flash: b.flash > 0 }; };
  }

  function draw(ctx, s, camL, camR) {
    for (const d of debris) {
      if (d.x < camL - 40 || d.x > camR + 40) continue;
      ctx.save(); ctx.globalAlpha = Math.min(1, (d.life - d.t) / 0.35); ctx.translate(d.x, d.y); ctx.rotate(d.rot);
      const im = img['d_' + d.kind];
      if (d.sprite && im && im.complete && im.width) ctx.drawImage(im, -im.width * d.size / 2, -im.height * d.size / 2, im.width * d.size, im.height * d.size);
      else { ctx.fillStyle = DEBRIS_COLORS[d.kind] || '#888'; ctx.fillRect(-d.size / 2, -d.size / 2, d.size, d.size * 0.6); }
      ctx.restore();
    }
    for (const k of pickups) {
      if (k.x < camL - 40 || k.x > camR + 40) continue;
      if (k.t > 11 && Math.floor(k.t * 8) % 2) continue; // blink before despawning
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(k.x, k.y + 4, 14, 5, 0, 0, 7); ctx.fill();
      const im = img['p_' + k.type], bob = k.z > 0 ? 0 : Math.sin(k.t * 5) * 2, y = k.y - k.z - 16 + bob;
      if (im && im.complete && im.width) ctx.drawImage(im, k.x - im.width * 0.4, y - im.height * 0.4, im.width * 0.8, im.height * 0.8);
      else { ctx.fillStyle = '#ffe14d'; ctx.beginPath(); ctx.arc(k.x, y, 9, 0, 7); ctx.fill(); }
      if (k.type === 'ruby' || k.type === 'emerald') { const a = 0.5 + 0.5 * Math.sin(k.t * 9); ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.fillRect(k.x + 9, y - 12, 3, 3); }
    }
    ctx.textAlign = 'center'; ctx.font = 'bold 14px monospace';
    for (const t of texts) { ctx.globalAlpha = 1 - t.t / 0.9; ctx.fillStyle = '#000'; ctx.fillText(t.s, t.x + 1, t.y - t.t * 40 + 1); ctx.fillStyle = t.c; ctx.fillText(t.s, t.x, t.y - t.t * 40); }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }

  return { step, draw, propMod, stats, get pickups() { return pickups; }, get debris() { return debris; }, list: s => current(s), smash: (s, i) => { const b = current(s)[i]; if (b && b.def && !b.broken) hit(s, b, 99, 1); return b; } };
}
