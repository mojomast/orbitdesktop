const surfaces = [
  ["Outputs","orbit://surface/outputs","Published files, aliases, pins, tags, draft refs"],
  ["Workspace Activity","orbit://surface/activity","Observed live activity feed"],
  ["Collab","orbit://surface/collab","Project board, approvals, orchestrator, subagents"],
  ["Google Colab","orbit://surface/colab-runtime","GPU/TPU runtimes on Colab"],
  ["Knowledge search","orbit://surface/search","Explicit source snapshots + exact citations"],
  ["Interactive results","orbit://surface/interactive-results","A2UI v0.9 import/edit/pin/export"],
  ["Document library","orbit://surface/documents","Rich text + canvas artifacts"],
  ["Run traces","orbit://surface/traces","Redacted timing of observed events"],
];
const tbody = document.getElementById('surfaces');
for (const [n,u,d] of surfaces) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><b>${n}</b></td><td><code>${u}</code></td><td>${d}</td>`;
  tbody.appendChild(tr);
}

// config
function readConfig() {
  let c = {};
  try { c = JSON.parse(decodeURIComponent(location.hash.replace(/^#orbit-config=/,''))); } catch (e) { c = {}; }
  return c && typeof c === 'object' ? c : {};
}
function applyConfig() {
  const c = readConfig();
  const title = (c.title || 'Orbit Feature Showcase');
  document.getElementById('title').textContent = title;
  document.title = title;
  document.getElementById('subtitle').textContent = c.subtitle || 'A spatial, agent-customizable workspace. This panel is a sandboxed plugin.';
  const accent = c.accentColor;
  if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) {
    document.documentElement.style.setProperty('--accent', accent);
  }
  document.getElementById('config-pill').textContent = 'config: ' + (Object.keys(c).length ? Object.keys(c).join(', ') : '(none)');
  document.getElementById('configjson').textContent = JSON.stringify(c, null, 2);
}
applyConfig();
document.getElementById('reloadcfg').addEventListener('click', applyConfig);

// mini grid (virtual windows)
const grid = document.getElementById('minigrid');
const status = document.getElementById('gridstatus');
let selected = 0;
for (let i = 0; i < 8; i++) {
  const t = document.createElement('div');
  t.className = 'tile';
  t.textContent = 'Window ' + (i+1);
  t.addEventListener('click', () => {
    t.classList.toggle('active');
    const on = grid.querySelectorAll('.tile.active').length;
    status.textContent = on + ' of ' + 8 + ' windows marked active';
  });
  grid.appendChild(t);
}
status.textContent = '0 of 8 windows marked active';

// theme preview buttons
document.querySelectorAll('[data-accent]').forEach(b => {
  b.addEventListener('click', () => {
    document.documentElement.style.setProperty('--accent', b.dataset.accent);
  });
});
