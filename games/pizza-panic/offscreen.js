// Compact screen-edge indicators so enemies that slip past the camera edge are
// still readable without leaving the play area. It only reads game state, so it
// cannot perturb physics, combat or the shared suite harnesses.
export function drawOffscreenIndicators(ctx, state, W, H, camX) {
  if (!state || !Array.isArray(state.ninjas)) return;
  const L = camX || 0, R = L + W;
  const enemies = state.ninjas.filter(n => !n.dead && Number.isFinite(n.x));
  const shown = [];
  ctx.save();
  for (const n of enemies) {
    if (n.x >= L + 42 && n.x <= R - 42) continue; // already in view
    shown.push(n);
    const y = Math.max(56, Math.min(H - 56, n.y || H / 2));
    const left = n.x < L + 42;
    const x = left ? 28 : W - 28;
    const color = n.kind === 'boss' || n.rider ? '#ff4bd4' : n.ext ? '#ffc24a' : '#68e8ff';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.ellipse(x, y, 18, 16, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    if (left) { ctx.moveTo(x - 6, y); ctx.lineTo(x + 5, y - 8); ctx.lineTo(x + 5, y + 8); }
    else { ctx.moveTo(x + 6, y); ctx.lineTo(x - 5, y - 8); ctx.lineTo(x - 5, y + 8); }
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = .9;
    ctx.fillStyle = '#f7fff7';
    ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((n.name || n.kind || 'E').slice(0, 4), x, y);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;
  }
  ctx.restore();
  return shown.length;
}
