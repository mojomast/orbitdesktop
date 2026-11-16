// Observatory v2 design mockup — static, fake data only. No framework, no CDN.
// Interaction design contract: apps/rizzstack-observatory/DESIGN-v2.md
// L0 overview -> drill-down | RED above USE | burn-rate thresholds drawn on
// charts | deploy markers | color = state only | one question per view.

const NOW = 1800000000000; // fixed fake "now" so the mock is deterministic
const WINDOW_MS = 24 * 3600 * 1000; // every time-series view shares one window

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtDur = (ms) => {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60), r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return String(h).padStart(2, '0') + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }
  return String(m).padStart(2, '0') + 'm ' + String(r).padStart(2, '0') + 's';
};
const fmtCost = (v) => (v == null ? null : '$' + v.toFixed(2));
const fmtClock = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z';
const fmtAgo = (ms) => {
  const m = Math.round((NOW - ms) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
};

// ---------------------------------------------------------------- fake data
const BASE_DEPLOYS = [
  { repo: 'rizzstack-collector', version: '0.9.0', at: NOW - 20 * 3600 * 1000 },
  { repo: 'orbitdesktop', version: '0.3.1', at: NOW - 14 * 3600 * 1000 },
  { repo: 'rizzstack-gateway', version: '1.2.3', at: NOW - 6 * 3600 * 1000 },
  { repo: 'rizzstack-gateway', version: '1.2.4', at: NOW - 2.2 * 3600 * 1000 },
];

const BASE = {
  fleet: [
    { id: 'bee-a1', branch: 'feat/usage-observability', route: 'zoo/glm-5.3-flash', state: 'running', started: NOW - 93_000, cost: 0.42 },
    { id: 'bee-b2', branch: 'main', route: 'zoo/glm-5.3-flash', state: 'running', started: NOW - 12 * 60_000, cost: 0.31 },
    { id: 'bee-c3', branch: 'fix/gateway-parity', route: 'other/model', state: 'failed', started: NOW - 3600_000, cost: null },
    { id: 'bee-d4', branch: 'feat/burn-panels', route: 'zoo/glm-5.3-flash', state: 'completed', started: NOW - 45 * 60_000, cost: 0.11 },
    { id: 'bee-e5', branch: 'docs/drill-down', route: 'other/model', state: 'queued', started: null, cost: null },
    { id: 'bee-f6', branch: 'chore/tokens', route: 'zoo/glm-5.3-flash', state: 'running', started: NOW - 3 * 60_000, cost: 0.05 },
  ],
  red: { ratePerMin: 3.8, errorPct: 17, p95: 501_000 },
  usage: {
    tokensTotal: 48_210,
    byModel: [
      { key: 'zoo/glm-5.3-flash', tokens: 31_204, cost: 0.84 },
      { key: 'other/model', tokens: 17_006, cost: null },
    ],
    byProvider: [{ key: 'zoo', tokens: 31_204, cost: 0.84 }],
    byRepo: [{ key: 'orbitdesktop', tokens: 48_210, cost: null }],
    note: 'Pricing is missing for other/model and for the per-repo split — the collector cannot price them yet. They render as UNKNOWN, never as zero.',
  },
  pipeline: {
    jobs: [
      {
        id: 'job-1', title: 'Ship observatory v2', repo: 'orbitdesktop', state: 'blocked',
        started: NOW - 9 * 3600 * 1000,
        tasks: [
          { id: 'task-1', title: 'Wire owner gate', state: 'blocked',
            stages: [{ name: 'verify', state: 'ok' }, { name: 'integrate', state: 'bad', reason: 'conflict with main' }, { name: 'accept', state: 'wait', reason: 'owner review' }],
            escalation: 'human review requested', blocker: 'merge conflict with main' },
          { id: 'task-2', title: 'Quota burn panel', state: 'completed',
            stages: [{ name: 'verify', state: 'ok' }, { name: 'integrate', state: 'ok' }, { name: 'accept', state: 'ok' }] },
          { id: 'task-3', title: 'Parity map from doctor data', state: 'running',
            stages: [{ name: 'verify', state: 'run' }, { name: 'integrate', state: 'wait' }, { name: 'accept', state: 'wait' }] },
        ],
      },
      {
        id: 'job-2', title: 'Gateway parity fix', repo: 'rizzstack-gateway', state: 'failed',
        started: NOW - 5 * 3600 * 1000,
        tasks: [
          { id: 'task-1', title: 'Pin installed version', state: 'failed',
            stages: [{ name: 'verify', state: 'bad', reason: 'version probe failed' }, { name: 'integrate', state: 'wait' }, { name: 'accept', state: 'wait' }],
            blocker: 'installed 1.2.3 vs running 1.2.4' },
        ],
      },
    ],
  },
  backlog: [
    { name: 'Todo', cards: [
      { id: 'BL-14', title: 'SSE live wiring', meta: 'bee-e5' },
      { id: 'BL-15', title: 'Usage cost ingest', meta: '3 pts' },
      { id: 'BL-16', title: 'Topology evidence API', meta: '5 pts' }] },
    { name: 'Doing', cards: [
      { id: 'BL-13', title: 'Burn-rate panels', meta: 'bee-a1' },
      { id: 'BL-17', title: 'Deploy markers', meta: 'bee-b2' }] },
    { name: 'Done', cards: [
      { id: 'BL-11', title: 'Snapshot schema', meta: '5 pts' },
      { id: 'BL-12', title: 'Stale markers', meta: 'bee-a1' },
      { id: 'BL-18', title: 'Parity map v1', meta: '8 pts' }] },
  ],
  topology: [
    { repo: 'orbitdesktop', cells: [
      { stage: 'checkout', state: 'ok', evidence: 'clean tree at 8530a14 (main)' },
      { stage: 'main', state: 'ok', evidence: 'main at 8530a14, 0 ahead' },
      { stage: 'installed', state: 'ok', evidence: 'installed bundle matches checkout hash' },
      { stage: 'loaded', state: 'ok', evidence: 'runtime loaded app v1.0.0' },
      { stage: 'deployed', state: 'warn', evidence: 'deployed 0.3.1 while main carries +obs2 design spike' }] },
    { repo: 'rizzstack-gateway', cells: [
      { stage: 'checkout', state: 'ok', evidence: 'clean tree at f41c9b2' },
      { stage: 'main', state: 'ok', evidence: 'main at f41c9b2' },
      { stage: 'installed', state: 'bad', evidence: 'installed 1.2.3 but 1.2.4 is running — parity broken' },
      { stage: 'loaded', state: 'ok', evidence: 'gateway process alive, pid 4242' },
      { stage: 'deployed', state: 'ok', evidence: 'deploy 1.2.4 live since ' + fmtClock(NOW - 2.2 * 3600 * 1000) }] },
    { repo: 'mojomast/hyvv', cells: [
      { stage: 'checkout', state: 'unknown', evidence: 'no local checkout — doctor found nothing on disk' },
      { stage: 'main', state: 'ok', evidence: 'remote main at 9d21ee1' },
      { stage: 'installed', state: 'unknown', evidence: 'not installed on this host' },
      { stage: 'loaded', state: 'unknown', evidence: 'not loaded by the runtime' },
      { stage: 'deployed', state: 'unknown', evidence: 'no deploy record in the last 24h' }] },
    { repo: 'rizzstack-collector', cells: [
      { stage: 'checkout', state: 'ok', evidence: 'clean tree at 77aa310' },
      { stage: 'main', state: 'warn', evidence: 'checkout is 2 commits behind main' },
      { stage: 'installed', state: 'ok', evidence: 'installed 0.9.0 matches checkout' },
      { stage: 'loaded', state: 'ok', evidence: 'collector scheduler alive, last event 42s ago' },
      { stage: 'deployed', state: 'ok', evidence: 'deploy 0.9.0 live since ' + fmtClock(NOW - 20 * 3600 * 1000) }] },
  ],
  burn: {
    budgetHours: 6,
    series: [0.3, 0.4, 0.5, 0.4, 0.6, 0.8, 1.1, 1.0, 0.9, 1.2, 1.6, 2.1, 2.6, 2.2, 1.8, 2.0, 2.4, 3.1, 3.9, 4.6, 5.1, 4.2, 3.4, 2.8, 2.6],
    thresholds: [2, 4],
  },
  quotas: [
    { kind: 'worker_pool', used: 3, cap: 10, unit: 'tasks' },
    { kind: 'tool_calls', used: 950, cap: 1000, unit: 'calls' },
    { kind: 'api_requests', used: 1200, cap: 5000, unit: 'calls' },
  ],
  alerts: [
    { level: 'error', text: 'Gateway version mismatch — running 1.2.4 vs installed 1.2.3', goto: 'topology' },
    { level: 'warn', text: 'Tool-call quota above 90% (950 / 1000 calls)', goto: 'overview' },
    { level: 'info', text: 'Task task-1 escalated: human review requested', goto: 'pipeline' },
  ],
  receivers: [
    { id: 'rc-1', agent: 'bee-a1', title: 'Add stale markers to fleet table', summary: 'Diffs fleet rows older than the freshness budget with a STALE chip and dims the table.', state: 'pending' },
    { id: 'rc-2', agent: 'bee-c3', title: 'Restart gateway on 1.2.4 mismatch', summary: 'Restarts the gateway host process so installed catches up to running 1.2.4.', state: 'pending' },
  ],
  config: [
    { key: 'autoRefresh', label: 'Auto-refresh snapshot', sub: 'every 30s via the snapshot stream', on: true },
    { key: 'strictPoolCap', label: 'Strict worker-pool cap', sub: 'refuses new bees at the cap instead of queueing', on: false },
    { key: 'telemetryExport', label: 'Telemetry export', sub: 'owner-approved only — the F6 fence refuses it in this demo', on: false, policy: true },
  ],
};

const STAGES = ['checkout', 'main', 'installed', 'loaded', 'deployed'];
const EMPTY_HINTS = {
  fleet: 'No bee attempts in this snapshot. Start a worker pool or widen the window.',
  usage: 'No usage counters yet. The collector emits them with the first billed call.',
  pipeline: 'No pipeline jobs in this snapshot.',
  backlog: 'Backlog source did not return a board.',
  topology: 'Doctor has not reported yet. Run doctor to build the parity map.',
  burn: 'No burn series yet — the failure budget needs at least one window.',
};

const state = {
  view: 'overview',
  scenario: 'normal',
  owner: false,
  seq: 0,
  queue: [],
  timers: [],
  audit: [],
  deployConfirm: false,
  deployRepo: 'orbitdesktop',
  deployRev: 'main @ 8530a14',
  rejectOpen: {},
  sourceOverrides: {},
};

const model = {
  deploys: BASE_DEPLOYS.slice(),
  receivers: BASE.receivers.map((r) => Object.assign({}, r)),
  config: BASE.config.map((c) => Object.assign({}, c)),
};

let auditClock = NOW - 30_000;

function audit(actor, text, outcome, reason) {
  auditClock += 1000;
  state.audit.unshift({ at: fmtClock(auditClock), actor, text, outcome, reason });
  if (state.audit.length > 40) state.audit.pop();
}

function announce(text) {
  const el = document.getElementById('announce');
  if (el) el.textContent = text;
}

// ------------------------------------------------------- scenario shaping
function snap() {
  const s = state.scenario;
  if (s === 'empty') return { empty: true, generatedAt: null };
  const data = {
    empty: false, generatedAt: s === 'stale' ? NOW - 20 * 60_000 : NOW - 60_000,
    fleet: BASE.fleet, red: BASE.red, pipeline: BASE.pipeline, burn: BASE.burn,
  };
  if (s === 'degraded') {
    data.sources = { usage: 'error', alerts: 'error' };
    data.healthDegraded = true;
  }
  for (const key of Object.keys(state.sourceOverrides)) {
    if (data.sources && data.sources[key] === 'error') delete data.sources[key];
  }
  return data;
}

function chip(key, label, st, detail) {
  return '<div class="chip ' + esc(st) + '"><span class="chip-label">' + esc(label) + '</span>' +
    '<span class="state ' + esc(st) + '">' + esc(st === 'run' ? 'running' : st) + '</span>' +
    '<span class="chip-detail">' + detail + '</span></div>';
}

// ------------------------------------------------------------- SVG charts
function burnChart(data) {
  const series = data.burn.series, W = 640, H = 210, pad = { l: 34, r: 10, t: 14, b: 22 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b, yMax = 6;
  const x = (i) => pad.l + (i / (series.length - 1)) * plotW;
  const y = (v) => pad.t + plotH - (v / yMax) * plotH;
  let path = 'M' + x(0).toFixed(1) + ',' + y(series[0]).toFixed(1);
  series.forEach((v, i) => { if (i) path += ' L' + x(i).toFixed(1) + ',' + y(v).toFixed(1); });
  const area = path + ' L' + x(series.length - 1).toFixed(1) + ',' + y(0).toFixed(1) + ' L' + x(0).toFixed(1) + ',' + y(0).toFixed(1) + ' Z';
  let out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Bee failure-budget burn over the shared 24h window; 2x and 4x thresholds are drawn on the chart">';
  for (let g = 1; g <= 5; g++) out += '<line class="ch-grid" x1="' + pad.l + '" y1="' + y(g) + '" x2="' + (W - pad.r) + '" y2="' + y(g) + '"/>';
  for (const t of data.burn.thresholds) {
    out += '<line class="ch-threshold' + (t >= 4 ? ' hi' : '') + '" x1="' + pad.l + '" y1="' + y(t) + '" x2="' + (W - pad.r) + '" y2="' + y(t) + '"/>' +
      '<text class="ch-text" x="' + (pad.l + 4) + '" y="' + (y(t) - 3) + '">' + t + 'x burn</text>';
  }
  out += '<path class="ch-area" d="' + area + '"/><path class="ch-line" d="' + path + '"/>';
  for (const d of model.deploys) {
    if (d.at < NOW - WINDOW_MS) continue;
    const dx = pad.l + ((d.at - (NOW - WINDOW_MS)) / WINDOW_MS) * plotW;
    out += '<line class="ch-marker" x1="' + dx + '" y1="' + pad.t + '" x2="' + dx + '" y2="' + (H - pad.b) + '"/>' +
      '<polygon class="ch-flag" points="' + dx + ',' + (pad.t - 6) + ' ' + (dx + 6) + ',' + (pad.t - 2) + ' ' + dx + ',' + (pad.t + 2) + '"/>' +
      '<title>deploy ' + esc(d.repo) + ' ' + esc(d.version) + '</title>';
  }
  out += '<text class="ch-text" x="' + pad.l + '" y="' + (H - 6) + '">-24h</text>' +
    '<text class="ch-text" x="' + (pad.l + plotW / 2 - 12) + '" y="' + (H - 6) + '">-12h</text>' +
    '<text class="ch-text strong" x="' + (W - pad.r - 20) + '" y="' + (H - 6) + '">now</text>' +
    '<text class="ch-text" x="2" y="' + (y(0) + 3) + '">0</text><text class="ch-text" x="2" y="' + (y(2) + 3) + '">2x</text><text class="ch-text" x="2" y="' + (y(4) + 3) + '">4x</text>';
  return out + '</svg>';
}

function pipelineTimeline(data) {
  const jobs = data.pipeline.jobs, W = 640, rowH = 26, top = 26, H = top + jobs.length * rowH + 16;
  const padL = 150, plotW = W - padL - 12;
  const x = (at) => padL + ((at - (NOW - WINDOW_MS)) / WINDOW_MS) * plotW;
  const fill = { ok: 'var(--ok)', bad: 'var(--bad)', run: 'var(--run)', wait: 'var(--wait)', warn: 'var(--warn)', unknown: 'var(--unknown)' };
  let out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="24h pipeline lanes with deploy markers">';
  out += '<text class="ch-text" x="' + padL + '" y="12">-24h</text><text class="ch-text strong" x="' + (W - 40) + '" y="12">now</text>';
  jobs.forEach((job, i) => {
    const cy = top + i * rowH + rowH / 2;
    const start = Math.max(job.started, NOW - WINDOW_MS);
    out += '<text class="ch-text strong" x="6" y="' + (cy + 3) + '">' + esc(job.title.slice(0, 24)) + '</text>';
    out += '<line class="ch-grid" x1="' + padL + '" y1="' + cy + '" x2="' + (W - 12) + '" y2="' + cy + '"/>';
    out += '<rect x="' + x(start) + '" y="' + (cy - 6) + '" width="' + (x(NOW) - x(start)) + '" height="12" rx="6" fill="' + fill[job.state] + '" opacity="0.3"/>';
    job.tasks.forEach((t, k) => {
      const tx = x(start) + k * 14;
      out += '<rect x="' + tx + '" y="' + (cy - 4) + '" width="8" height="8" rx="2" fill="' + fill[t.state] + '"><title>' + esc(t.title) + ': ' + esc(t.state) + '</title></rect>';
    });
  });
  for (const d of model.deploys) {
    if (d.at < NOW - WINDOW_MS) continue;
    const dx = x(d.at);
    out += '<line class="ch-marker" x1="' + dx + '" y1="16" x2="' + dx + '" y2="' + (H - 12) + '"/>' +
      '<polygon class="ch-flag" points="' + dx + ',10 ' + (dx + 6) + ',14 ' + dx + ',18"/>' +
      '<text class="ch-text" x="' + (dx + 4) + '" y="' + (H - 2) + '">' + esc(d.version) + '</text><title>deploy ' + esc(d.repo) + ' ' + esc(d.version) + '</title>';
  }
  return out + '</svg>';
}

function quotaBars(quotas) {
  let out = '<ul class="bars">';
  for (const q of quotas) {
    const pct = Math.round((q.used / q.cap) * 100);
    const st = pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
    const warnX = Math.round(pct >= 80 ? 80 : 0), badX = pct >= 95 ? 95 : 0;
    out += '<li><span class="bar-label">' + esc(q.kind) + '</span>' +
      '<span class="bar-track"><span class="bar-fill ' + st + '" style="width:' + pct + '%">' +
      '<i class="tick" style="left:' + warnX + '%"></i><i class="tick bad" style="left:' + badX + '%"></i></span></span>' +
      '<span class="bar-value">' + q.used.toLocaleString() + ' / ' + q.cap.toLocaleString() + ' ' + esc(q.unit) + ' <span class="state ' + st + '">' + st + '</span></span></li>';
  }
  return out + '</ul><p class="chart-note">Threshold ticks drawn at 80% (warn) and 95% (bad) of each cap.</p>';
}

// ------------------------------------------------------------------ views
function emptyPanel(text, hint) {
  return '<p class="empty-state">' + esc(text) + (hint ? ' ' + esc(hint) : '') + '</p>';
}

function renderOverview(data) {
  const health = document.getElementById('ov-health');
  if (data.empty) {
    health.innerHTML = '';
    document.getElementById('ov-grid').innerHTML = emptyPanel('No snapshot loaded yet.', 'The collector emits rizzstack.observability/snapshot/1 when a worker pool starts.');
    return;
  }
  const degraded = data.healthDegraded;
  let chips = '';
  chips += chip('launcher', 'Launcher', degraded ? 'unknown' : 'ok', degraded ? 'probe timed out' : 'pid 4242');
  chips += chip('docker', 'Docker', degraded ? 'unknown' : 'ok', degraded ? 'probe timed out' : 'docker 24.0');
  chips += chip('gateway', 'Gateway parity', 'warn', 'installed 1.2.3 · running 1.2.4');
  chips += chip('scheduler', 'Scheduler', degraded ? 'bad' : 'ok', degraded ? 'no beat for 15m' : 'last event 42s ago');
  chips += chip('burn', 'Failure budget', 'bad', '4.6x burn — see panel');
  chips += chip('quota', 'Tool calls', 'warn', '950 / 1000 (95%)');
  chips += chip('spend', 'Spend today', 'unknown', '<span class="unknown-cost">UNKNOWN</span> — unpriced models');
  health.innerHTML = chips;
  const alerts = data.sources && data.sources.alerts === 'error'
    ? '<p class="source-error">Alerts source unavailable. <button type="button" class="linkish" data-retry="alerts">Retry</button></p>'
    : BASE.alerts.map((a) => '<div class="alert ' + a.level + '"><span class="alert-level">' + a.level.toUpperCase() + '</span><p>' + esc(a.text) + '</p>' +
        '<button type="button" class="linkish" data-goto="' + a.goto + '">→</button></div>').join('');
  document.getElementById('ov-grid').innerHTML =
    '<div class="panel"><h3>Bee failure budget — burn over 24h</h3>' + burnChart(data) +
      '<p class="chart-note">Budget 6h · thresholds drawn at 2x and 4x · flags are deploys (1.2.4 at -2.2h).</p>' +
      '<p class="drill"><button type="button" class="linkish" data-goto="pipeline">Drill in → Pipeline</button></p></div>' +
    '<div class="panel"><h3>Service RED (fleet)</h3><div class="red-row" style="grid-template-columns:1fr">' +
      '<div class="red-card"><span class="label">Rate</span><div class="value">' + data.red.ratePerMin + '/min</div><div class="sub">bee attempts, 5m window</div></div>' +
      '<div class="red-card"><span class="label">Errors</span><div class="value bad">' + data.red.errorPct + '%</div><div class="sub">failed attempts — bee-c3</div></div>' +
      '<div class="red-card"><span class="label">Duration p95</span><div class="value">' + fmtDur(data.red.p95) + '</div><div class="sub">attempt wall time</div></div></div>' +
      '<p class="drill"><button type="button" class="linkish" data-goto="fleet">Drill in → Fleet</button></p></div>' +
    '<div class="panel"><h3>Quota burn (USE)</h3>' + quotaBars(BASE.quotas) +
      '<p class="drill"><button type="button" class="linkish" data-goto="control">Drill in → Control</button></p></div>' +
    '<div class="panel"><h3>Top alerts</h3>' + (alerts || emptyPanel('No active alerts.')) +
      '<p class="drill"><button type="button" class="linkish" data-goto="topology">Drill in → Topology</button></p></div>';
}

function renderFleet(data) {
  const body = document.getElementById('fleet-body');
  const red = document.getElementById('fleet-red');
  if (data.empty) { red.innerHTML = ''; body.innerHTML = emptyPanel(EMPTY_HINTS.fleet); return; }
  red.innerHTML =
    '<div class="red-card"><span class="label">Rate</span><div class="value">' + data.red.ratePerMin + '/min</div><div class="sub">attempts started</div></div>' +
    '<div class="red-card"><span class="label">Errors</span><div class="value bad">' + data.red.errorPct + '%</div><div class="sub">share failed</div></div>' +
    '<div class="red-card"><span class="label">Duration p95</span><div class="value">' + fmtDur(data.red.p95) + '</div><div class="sub">wall time</div></div>';
  const rows = data.fleet.map((a) => {
    const st = { running: 'run', completed: 'ok', failed: 'bad', queued: 'wait' }[a.state] || 'unknown';
    const cost = a.cost == null ? '<span class="unknown-cost">UNKNOWN</span>' : esc(fmtCost(a.cost));
    return '<tr><td class="mono">' + esc(a.id) + '</td><td class="mono">' + esc(a.branch) + '</td><td>' + esc(a.route) + '</td>' +
      '<td><span class="state ' + st + '">' + esc(a.state) + '</span></td><td class="mono">' + fmtDur(a.started ? NOW - a.started : null) + '</td>' +
      '<td>' + cost + '</td><td><button type="button" class="linkish" data-goto="pipeline" aria-label="Drill into pipeline for ' + esc(a.id) + '">→</button></td></tr>';
  }).join('');
  body.innerHTML = '<table><caption>Bee attempts with route, state, elapsed and cost (UNKNOWN where unpriced)</caption>' +
    '<thead><tr><th scope="col">Attempt</th><th scope="col">Branch</th><th scope="col">Route</th><th scope="col">State</th><th scope="col">Elapsed</th><th scope="col">Cost</th><th scope="col"><span class="visually-hidden">Drill down</span></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

function usageGroup(title, rows) {
  return '<div class="usage-group"><h3>' + esc(title) + '</h3><ul>' + rows.map((r) =>
    '<li><span class="bar-label">' + esc(r.key) + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + r.pct + '%"></span></span>' +
    '<span class="bar-value">' + r.tokens.toLocaleString() + ' tok · ' +
    (r.cost == null ? '<span class="unknown-cost">UNKNOWN</span>' : esc(fmtCost(r.cost))) + '</span></li>').join('') + '</ul></div>';
}

function renderUsage(data) {
  const el = document.getElementById('usage-body');
  if (data.empty) { el.innerHTML = emptyPanel(EMPTY_HINTS.usage); return; }
  if (data.sources && data.sources.usage === 'error') {
    el.innerHTML = '<p class="source-error">Usage source unavailable — tokens and costs withheld rather than shown as zero. <button type="button" class="linkish" data-retry="usage">Retry</button></p>';
    return;
  }
  const maxTok = Math.max.apply(null, BASE.usage.byModel.map((m) => m.tokens));
  const scale = (rows) => rows.map((r) => Object.assign({}, r, { pct: Math.round((r.tokens / maxTok) * 100) }));
  el.innerHTML = '<div class="usage-total">' +
    '<div><span class="label">Tokens 24h</span><div class="value">' + BASE.usage.tokensTotal.toLocaleString() + '</div></div>' +
    '<div><span class="label">Cost 24h</span><div class="value"><span class="unknown-cost">UNKNOWN</span></div></div>' +
    '<div><span class="label">Priced share</span><div class="value">$0.84</div></div></div>' +
    usageGroup('By model', scale(BASE.usage.byModel)) +
    usageGroup('By provider', scale(BASE.usage.byProvider)) +
    usageGroup('By repo', scale(BASE.usage.byRepo)) +
    '<p class="chart-note">' + esc(BASE.usage.note) + '</p>';
}

function stageChip(s) {
  return '<li class="stage"><span class="stage-name">' + esc(s.name) + '</span><span class="state ' + esc(s.state) + '">' +
    ({ ok: 'passed', bad: 'failed', run: 'running', wait: 'waiting' }[s.state] || esc(s.state)) + '</span>' +
    (s.reason ? '<span class="reason">' + esc(s.reason) + '</span>' : '') + '</li>';
}

function renderPipeline(data) {
  const el = document.getElementById('pipeline-body');
  const tl = document.getElementById('pipeline-timeline');
  if (data.empty) { tl.innerHTML = ''; el.innerHTML = emptyPanel(EMPTY_HINTS.pipeline); return; }
  tl.innerHTML = pipelineTimeline(data);
  el.innerHTML = data.pipeline.jobs.map((job) =>
    '<article class="job"><div class="job-head"><span class="title">' + esc(job.title) + '</span>' +
    '<span class="mono">' + esc(job.repo) + '</span><span class="state ' + esc(job.state === 'blocked' ? 'bad' : job.state === 'failed' ? 'bad' : job.state === 'running' ? 'run' : 'ok') + '">' + esc(job.state) + '</span></div>' +
    job.tasks.map((t) => '<div class="task"><div class="task-head"><span class="mono">' + esc(t.id) + '</span><span class="title">' + esc(t.title) + '</span>' +
      '<span class="state ' + esc(t.state === 'running' ? 'run' : t.state === 'completed' ? 'ok' : t.state === 'failed' ? 'bad' : 'warn') + '">' + esc(t.state) + '</span></div>' +
      '<ul class="stages">' + t.stages.map(stageChip).join('') + '</ul>' +
      (t.escalation ? '<p class="reason escalation">Escalation: ' + esc(t.escalation) + '</p>' : '') +
      (t.blocker ? '<p class="reason blocker">Blocker: ' + esc(t.blocker) + '</p>' : '') + '</div>').join('') +
    '</article>').join('');
}

function renderBacklog(data) {
  const el = document.getElementById('backlog-body');
  if (data.empty) { el.innerHTML = emptyPanel(EMPTY_HINTS.backlog); return; }
  el.innerHTML = BASE.backlog.map((col) =>
    '<div class="board-column"><h3>' + esc(col.name) + ' <span class="count">' + col.cards.length + '</span></h3><ul>' +
    col.cards.map((c) => '<li><span class="card-title">' + esc(c.title) + '</span><span class="card-meta mono">' + esc(c.id) + ' · ' + esc(c.meta) + '</span></li>').join('') +
    '</ul></div>').join('');
}

function renderTopology(data) {
  const el = document.getElementById('topology-map');
  if (data.empty) { el.innerHTML = emptyPanel(EMPTY_HINTS.topology); return; }
  let out = '<div class="parity">';
  out += '<div class="parity-row"><span class="parity-head">Repo ↓ / stage →</span>' +
    STAGES.map((s) => '<span class="parity-head">' + s + '</span>').join('') + '</div>';
  for (const repo of BASE.topology) {
    out += '<div class="parity-row"><span class="parity-repo">' + esc(repo.repo) + '</span>' +
      repo.cells.map((c) => '<button type="button" class="cell ' + esc(c.state) + '" data-cell="' + esc(repo.repo) + '|' + esc(c.stage) + '" ' +
        'aria-label="' + esc(repo.repo) + ' ' + esc(c.stage) + ': ' + esc(c.state) + ' — open doctor evidence">' + esc(c.state) + '</button>').join('') + '</div>';
  }
  el.innerHTML = out + '</div>';
}

// -------------------------------------------------------- control surface
function renderControl() {
  const gate = document.getElementById('owner-gate');
  gate.className = 'gate' + (state.owner ? ' open' : '');
  gate.innerHTML = '<span class="owner-chip' + (state.owner ? ' on' : '') + '">OWNER SESSION ' + (state.owner ? 'OPEN' : 'LOCKED') + '</span>' +
    '<span class="gate-note">' + (state.owner
      ? 'mock session — actions sign into the owner API and enter the fenced F6 queue'
      : 'unlock to decide; locked controls refuse readably instead of silently no-oping') + '</span>' +
    '<button type="button" id="toggle-owner">' + (state.owner ? 'Lock session' : 'Unlock as owner') + '</button>';

  const locked = state.owner ? '' : 'disabled';
  document.getElementById('receiver-list').innerHTML = model.receivers.map((r) => {
    const st = r.state === 'accepted' ? 'ok' : r.state === 'rejected' ? 'bad' : 'wait';
    const reasonField = state.rejectOpen[r.id]
      ? '<div class="reason-field"><label for="reason-' + esc(r.id) + '">Reason (required)</label>' +
        '<textarea id="reason-' + esc(r.id) + '" data-reason="' + esc(r.id) + '" placeholder="Why is this rejected?"></textarea>' +
        '<button type="button" data-decision="reject-send" data-id="' + esc(r.id) + '" ' + locked + ' class="danger" disabled>Send rejection</button></div>'
      : '';
    return '<div class="decision"><div class="decision-head"><span class="mono">' + esc(r.id) + '</span>' +
      '<span class="title">' + esc(r.title) + '</span><span class="state ' + st + '">' + esc(r.state) + '</span>' +
      '<span class="owner-chip">via owner API</span></div>' +
      '<p>' + esc(r.summary) + ' <span class="card-meta">— ' + esc(r.agent) + '</span></p>' +
      '<div class="decision-actions">' +
      '<button type="button" data-decision="accept" data-id="' + esc(r.id) + '" ' + locked + '>Accept</button>' +
      (r.state === 'pending' ? '<button type="button" data-decision="reject" data-id="' + esc(r.id) + '" ' + locked + '>Reject…</button>' : '') +
      '</div>' + reasonField + '</div>';
  }).join('');

  const dp = state.deployConfirm
    ? '<div class="field-row"><span class="pending-note">Deploy ' + esc(state.deployRepo) + ' @ ' + esc(state.deployRev) + ' — confirm to enqueue into F6.</span>' +
      '<button type="button" data-deploy-step="confirm" ' + locked + '>Confirm deploy</button>' +
      '<button type="button" data-deploy-step="cancel">Cancel</button></div>'
    : '<div class="field-row"><label>Repo<select data-deploy-repo>' +
        ['orbitdesktop', 'rizzstack-gateway', 'rizzstack-collector', 'mojomast/hyvv'].map((r) => '<option>' + esc(r) + '</option>').join('') +
      '</select></label><label>Rev<input data-deploy-rev value="main @ 8530a14" spellcheck="false"></label>' +
      '<button type="button" data-deploy-step="stage" ' + locked + '>Queue deploy…</button></div>';
  document.getElementById('deploy-panel').innerHTML = dp;

  document.getElementById('config-panel').innerHTML = model.config.map((c) =>
    '<div class="toggle-row"><span><span class="toggle-label">' + esc(c.label) + '</span>' +
    (c.pending ? '<span class="pending-note"> · queued fq-' + esc(c.pending) + '</span>' : '') +
    '<span class="toggle-sub">' + esc(c.sub) + '</span></span>' +
    '<button type="button" role="switch" aria-checked="' + c.on + '" data-toggle="' + esc(c.key) + '" ' + locked + '>' + (c.on ? 'On' : 'Off') + '</button></div>').join('');

  const queueRows = state.queue.map((a) =>
    '<tr><td class="mono">' + esc(a.id) + '</td><td>' + esc(a.kind) + '</td><td class="mono">' + esc(a.target) + '</td>' +
    '<td><span class="state ' + (a.state === 'applied' ? 'ok' : a.state === 'rejected' ? 'bad' : 'wait') + '">' + esc(a.state) + '</span></td>' +
    '<td class="mono">owner API → F6</td></tr>').join('');
  document.getElementById('queue-body').innerHTML = state.queue.length
    ? '<table><thead><tr><th scope="col">Id</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">State</th><th scope="col">Route</th></tr></thead><tbody>' + queueRows + '</tbody></table>'
    : emptyPanel('Queue empty — every mutation lands here first.', '');

  document.getElementById('audit-body').innerHTML = state.audit.slice(0, 12).map((a) =>
    '<li><span class="audit-head"><span class="mono">' + esc(a.at) + '</span><span>' + esc(a.actor) + '</span>' +
    '<span class="audit-outcome ' + esc(a.outcome) + '">' + esc(a.outcome) + '</span></span>' +
    '<div>' + esc(a.text) + (a.reason ? ' <span class="audit-reason">— ' + esc(a.reason) + '</span>' : '') + '</div></li>').join('')
    || '<li>No audited actions yet.</li>';
}

// ------------------------------------------------- F6 queue + optimistic
function enqueue(kind, target, opts) {
  const action = Object.assign({ id: 'fq-' + (++state.seq), kind, target, state: 'queued', route: 'owner API → F6' }, opts || {});
  state.queue.unshift(action);
  audit(state.owner ? 'owner' : 'gate', kind + ' ' + target + ' signed into the owner API', 'queued');
  announce(kind + ' ' + target + ' queued as ' + action.id);
  state.timers.push(setTimeout(() => resolveAction(action), 700));
  return action;
}

function resolveAction(action) {
  let outcome, reason;
  if (!state.owner) {
    outcome = 'rejected'; reason = 'owner gate closed — F6 fence refused';
  } else if (action.forceReject) {
    outcome = 'rejected'; reason = action.forceReject;
  } else {
    outcome = 'applied';
  }
  if (outcome === 'applied') {
    action.commit();
    audit('f6', action.kind + ' ' + action.target + (action.reason ? ' — reason: ' + action.reason : ''), 'applied');
  } else {
    action.revert();
    audit('f6', action.kind + ' ' + action.target, 'rejected', reason);
    announce(action.kind + ' reverted: ' + reason);
  }
  state.queue = state.queue.filter((q) => q !== action);
  renderControl();
}

function toggleOwner() {
  state.owner = !state.owner;
  audit('viewer', state.owner ? 'owner session opened (mock)' : 'owner session locked', state.owner ? 'applied' : 'queued');
  if (!state.owner) state.deployConfirm = false;
  announce(state.owner ? 'Owner session open — controls enabled' : 'Owner session locked — controls disabled');
  if (state.view !== 'control') renderView(); else renderControl();
}

function decide(id, kind, reason) {
  const r = model.receivers.find((x) => x.id === id);
  if (!r || r.state !== 'pending' || !state.owner) return;
  const prior = r.state;
  r.state = kind === 'accept' ? 'accepted' : 'rejected'; // optimistic before the queue answers
  state.rejectOpen[id] = false;
  const action = enqueue(kind, id);
  if (kind === 'reject') action.reason = reason;
  action.commit = () => {};
  action.revert = () => { r.state = prior; };
  renderControl();
}

function toggleConfig(key) {
  const c = model.config.find((x) => x.key === key);
  if (!c || c.pending || !state.owner) return;
  const prior = c.on;
  c.on = !c.on; // optimistic flip before the queue answers
  const action = enqueue('config.' + key, key, { forceReject: c.policy ? 'policy: telemetry export requires a signed owner approval' : false });
  action.commit = () => { c.pending = null; };
  action.revert = () => { c.on = prior; c.pending = null; };
  c.pending = action.id.slice(3);
  renderControl();
}

function stageDeploy() {
  if (!state.owner) return;
  const repo = document.querySelector('[data-deploy-repo]');
  const rev = document.querySelector('[data-deploy-rev]');
  state.deployRepo = repo ? repo.value : state.deployRepo;
  state.deployRev = rev && rev.value.trim() ? rev.value.trim() : state.deployRev;
  state.deployConfirm = true;
  renderControl();
}

function confirmDeploy() {
  if (!state.owner) return;
  state.deployConfirm = false;
  const deploy = { repo: state.deployRepo, version: state.deployRev, at: NOW, pending: true };
  model.deploys.push(deploy);
  const action = enqueue('deploy', state.deployRepo + ' @ ' + state.deployRev);
  action.commit = () => { deploy.pending = false; };
  action.revert = () => { model.deploys.pop(); };
  renderControl();
}

function retrySource(name) {
  state.sourceOverrides[name] = true;
  announce(name + ' source recovered (mock retry)');
  renderAll();
}

// ------------------------------------------------------------ view router
const RENDER = { overview: renderOverview, fleet: renderFleet, usage: renderUsage, pipeline: renderPipeline, backlog: renderBacklog, topology: renderTopology, control: renderControl };

function renderView() {
  const data = snap();
  if (state.view === 'control') renderControl();
  else RENDER[state.view](data);
}

function goto(view) {
  state.view = view;
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const active = tab.dataset.goto === view;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('[role=tabpanel]')) panel.hidden = panel.id !== 'panel-' + view;
  renderView();
  const heading = document.querySelector('#panel-' + view + ' h2');
  if (heading) heading.focus();
  announce(view + ' view');
}

// ------------------------------------------------------------------ header
function renderHeader() {
  const data = snap();
  const badge = document.getElementById('freshness');
  const banner = document.getElementById('banner');
  let cls = 'unknown', label = 'NO DATA', bannerText = '';
  if (!data.empty) {
    const age = NOW - data.generatedAt;
    if (age > 15 * 60_000) { cls = 'stale'; label = 'STALE'; bannerText = 'Snapshot is ' + fmtAgo(data.generatedAt) + ' old — values may be outdated. Stale data beats no data.'; }
    else if (data.sources && Object.keys(data.sources).length) { cls = 'bad'; label = 'DEGRADED'; bannerText = 'Some sources are unavailable — affected panels show their own error state; healthy panels stay live.'; }
    else { cls = 'live'; label = 'LIVE'; }
  }
  badge.className = 'badge ' + cls;
  badge.textContent = label;
  banner.hidden = !bannerText;
  banner.className = 'banner' + (cls === 'bad' ? ' error' : '');
  banner.textContent = bannerText;
  document.body.classList.toggle('stale', cls === 'stale');
  for (const btn of document.querySelectorAll('[data-scenario]')) {
    btn.setAttribute('aria-pressed', btn.dataset.scenario === state.scenario ? 'true' : 'false');
  }
}

function renderAll() {
  renderHeader();
  renderView();
}

function setScenario(name) {
  for (const t of state.timers) clearTimeout(t);
  state.timers = [];
  state.queue = [];
  state.deployConfirm = false;
  state.rejectOpen = {};
  state.sourceOverrides = {};
  state.scenario = name;
  audit('viewer', 'demo scenario switched to ' + name, 'applied');
  announce('Scenario: ' + name);
  renderAll();
}

// ----------------------------------------------------------------- charts css tick helper, evidence dialog
function openEvidence(key) {
  const [repo, stage] = key.split('|');
  const repoEntry = BASE.topology.find((r) => r.repo === repo);
  const cell = repoEntry && repoEntry.cells.find((c) => c.stage === stage);
  if (!cell) return;
  document.getElementById('evidence-title').textContent = repo + ' · ' + stage;
  document.getElementById('evidence-body').textContent = 'State: ' + cell.state + '. Doctor evidence: ' + cell.evidence;
  document.getElementById('evidence-dialog').showModal();
}

// --------------------------------------------------------------- wiring
document.addEventListener('click', (event) => {
  const t = event.target.closest('[data-goto],[data-scenario],[data-cell],[data-decision],[data-toggle],[data-deploy-step],[data-retry],#toggle-owner,#open-shortcuts');
  if (!t) return;
  if (t.dataset.goto) { goto(t.dataset.goto); return; }
  if (t.dataset.scenario) { setScenario(t.dataset.scenario); return; }
  if (t.dataset.cell) { openEvidence(t.dataset.cell); return; }
  if (t.id === 'toggle-owner') { toggleOwner(); return; }
  if (t.id === 'open-shortcuts') { document.getElementById('shortcuts-dialog').showModal(); return; }
  if (t.dataset.retry) { retrySource(t.dataset.retry); return; }
  if (t.dataset.toggle) { toggleConfig(t.dataset.toggle); return; }
  if (t.dataset.deployStep === 'stage') { stageDeploy(); return; }
  if (t.dataset.deployStep === 'confirm') { confirmDeploy(); return; }
  if (t.dataset.deployStep === 'cancel') { state.deployConfirm = false; renderControl(); return; }
  if (t.dataset.decision === 'accept') { decide(t.dataset.id, 'accept'); return; }
  if (t.dataset.decision === 'reject') { state.rejectOpen[t.dataset.id] = true; renderControl(); return; }
  if (t.dataset.decision === 'reject-send') {
    const field = document.querySelector('[data-reason="' + t.dataset.id + '"]');
    const reason = field && field.value.trim();
    if (!reason) return;
    decide(t.dataset.id, 'reject', reason);
  }
});

document.addEventListener('input', (event) => {
  const field = event.target.closest('[data-reason]');
  if (field) {
    const send = document.querySelector('[data-decision="reject-send"][data-id="' + field.dataset.reason + '"]');
    if (send) send.disabled = !field.value.trim();
    return;
  }
  if (event.target.matches('[data-deploy-rev]')) state.deployRev = event.target.value;
});

const tablist = document.getElementById('tablist');
tablist.addEventListener('keydown', (event) => {
  const tabs = Array.from(tablist.querySelectorAll('[role=tab]'));
  const current = tabs.indexOf(document.activeElement);
  let next = -1;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next >= 0) { event.preventDefault(); goto(tabs[next].dataset.goto); tabs[next].focus(); }
});

const VIEWS = ['overview', 'fleet', 'usage', 'pipeline', 'backlog', 'topology', 'control'];

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
  if (document.querySelector('dialog[open]')) return;
  if (/^[1-7]$/.test(event.key)) { goto(VIEWS[Number(event.key) - 1]); event.preventDefault(); return; }
  if (event.key === 'o' || event.key === 'O') { toggleOwner(); return; }
  if (event.key === '?') { document.getElementById('shortcuts-dialog').showModal(); event.preventDefault(); return; }
  if (event.key === 'Escape' && state.view !== 'overview') goto('overview');
});

renderAll();
audit('viewer', 'mockup opened with fake snapshot data', 'applied');
renderControl();
