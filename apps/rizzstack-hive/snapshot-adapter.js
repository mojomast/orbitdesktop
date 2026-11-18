// Only this allowlisted, read-only projection may leave the trusted snapshot reader.
import validate from './validate-snapshot.js';

const SECTIONS = ['fleet', 'usage', 'pipeline', 'backlog', 'ci', 'failures', 'health', 'alerts', 'bottlenecks', 'decisions'];
const STATIONS = ['auth', 'dispatch', 'build', 'verify', 'review', 'integrate', 'deploy', 'receiver'];
const ACTIVE = new Set(['starting', 'running', 'working', 'backoff']);
const SECTION_STAGE = { fleet: 'build', usage: 'build', pipeline: 'build', backlog: 'dispatch', ci: 'review', failures: 'build', health: 'dispatch', alerts: 'dispatch', bottlenecks: 'dispatch', decisions: 'receiver' };
// Same client freshness window as Observatory. This does not replace the
// collector's own (configurable) heartbeat/ledger freshness checks.
const FRESH_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const invalid = () => { throw new TypeError('Invalid Hive snapshot'); };
const sourceOf = id => `snapshot/1:${id}`;
const measured = status => status === 'known' || status === 'partial';
const fmt = n => n ?? 'unknown';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fresh = (ts, now) => { const age = now - Date.parse(ts); return age <= FRESH_MS && age >= -CLOCK_SKEW_MS; };

// The API accepts parsed JSON, not objects with methods, sparse arrays, accessors
// or inherited facts. Budget the input independently of the bounded display.
function admit(value) {
  let nodes = 0, chars = 0;
  function visit(v, key, depth) {
    if (++nodes > 120_000 || depth > 20) invalid();
    if (typeof v === 'string') {
      chars += v.length;
      if (chars > 2_000_000 || v.length > 2048) invalid();
      if (key === 'ts' || key.endsWith('_at')) {
        // The frozen schema checks timestamp syntax. Also refuse impossible
        // calendar dates that Date.parse silently carries into the next month.
        const local = v.slice(0, 19);
        const ms = Date.parse(local + 'Z');
        if (!Number.isFinite(Date.parse(v)) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== local) invalid();
      }
      return;
    }
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) invalid();
      return;
    }
    if (typeof v !== 'object') invalid();
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const keys = Reflect.ownKeys(v);
    if (keys.length > 12_000 || (array && keys.length !== v.length + 1)) invalid();
    for (const k of keys) {
      if (array && k === 'length') continue;
      if (typeof k !== 'string' || k.length > 256 || (array && (!/^\d+$/.test(k) || +k >= v.length || String(+k) !== k))) invalid();
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) invalid();
      visit(d.value, k, depth + 1);
    }
  }
  visit(value, '', 0);
  if (!validate(value)) invalid();
}

// ID fields are public by producer contract. In addition to schema syntax,
// withhold placeholders and common credential/network-shaped lookalikes.
function token(s) {
  if (!s || s === 'unknown' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(s)) return null;
  if (/^(?:gh[pousr]_|github_pat_|sk-|glpat-|AKIA|ASIA|eyJ[a-z0-9_-]*\.|bearer[._-])|\.(?:internal|local|lan|ts\.net)$|^\d+\.\d+\.\d+\.\d+$/i.test(s)) return null;
  return s;
}
function repoSlug(s) {
  if (!s || s.length > 256) return null;
  const parts = s.split('/');
  return parts.length === 2 && parts.every(token) ? s : null;
}
function sectionStates(s, now) {
  return SECTIONS.map(id => {
    const body = s[id];
    if (!body) return { id, state: 'absent', at: null };
    let state = body.status;
    if (state === 'live' && (!fresh(s.generated_at, now) || !fresh(body.collected_at, now) || s.degraded.includes(id) || (id === 'fleet' && body.source === 'dispatch_leases'))) state = 'stale';
    return { id, state, at: body.collected_at };
  });
}

function coverage(usage) {
  const { requests, unknown_cost_records: unknown, cost_status: status } = usage.totals;
  if (requests === null || requests === 0 || unknown === null || unknown > requests || status === 'unavailable' || usage.source.record_count !== requests) return null;
  const priced = requests - unknown;
  if ((status === 'known' && unknown !== 0) || (status === 'unknown' && priced !== 0) || (status === 'partial' && (!priced || !unknown))) return null;
  const errors = usage.source.parse_errors;
  return `${priced}/${requests} priced` + (errors === 0 ? '' : `; parse errors: ${fmt(errors)}`);
}

// No timeline, cache, fetch, effects or capabilities. The store handles pages
// arriving out of order; all times here are source times, never ingest time.
export function project(snapshot, { now = Date.now() } = {}) {
  const s = snapshot;
  admit(s);
  if (!Number.isFinite(now) || Date.parse(s.generated_at) > now + CLOCK_SKEW_MS) invalid();
  const sections = sectionStates(s, now);
  const quality = Object.fromEntries(sections.map(x => [x.id, x.state]));
  const live = id => quality[id] === 'live';
  const readable = id => live(id) || quality[id] === 'stale';
  const observations = sections.filter(x => x.state !== 'absent');
  const health = observations.every(x => x.state === 'unavailable') ? 'unavailable'
    : observations.every(x => x.state !== 'live') ? 'stale'
    : observations.some(x => x.state !== 'live') || s.health.scheduler.liveness !== 'live' ? 'degraded' : 'live';
  const b = s.bottlenecks, inv = b?.invariant;
  const usableInvariant = live('bottlenecks') && fresh(inv.generated_at, now) && measured(inv.status);
  const metered = live('usage') && measured(s.usage.source.usage_status) && fresh(s.usage.source.generated_at, now) && fresh(s.usage.totals.generated_at, now);
  const activeRows = s.fleet.attempts.filter(a => ACTIVE.has(a.state));
  const fleetConflict = live('fleet') && s.fleet.in_flight !== null && (s.fleet.in_flight !== activeRows.length || activeRows.some(a => !fresh(a.generated_at, now)));
  const metrics = {
    active: live('fleet') && !fleetConflict ? s.fleet.in_flight : null,
    available: usableInvariant && live('pipeline') && live('backlog') ? inv.capacity?.available ?? null : null,
    capacity: usableInvariant ? inv.capacity?.max_active ?? null : null,
    eligible: usableInvariant && live('backlog') && live('pipeline') ? inv.ready : null,
    cost: metered && measured(s.usage.totals.cost_status) ? s.usage.totals.cost_usd : null,
    costCoverage: metered ? coverage(s.usage) : null,
  };
  const waiting = usableInvariant && live('pipeline') && live('backlog') ? inv.waiting_despite_capacity : null;
  const stations = STATIONS.map(id => ({ id, signal: 'No current observation', quality: 'unknown', level: 'unknown', depth: null }));
  function display(id, signal, quality, level, depth = null) {
    Object.assign(stations.find(x => x.id === id), { signal, quality, level, depth });
  }
  const attempts = [], records = [], attention = [];
  function record(kind, key, stage, title, state, section, at, detail, jobId = null) {
    const id = `${kind}:${key}`;
    // Records lack a separate quality field in this display contract. Historical
    // rows keep their observed values, explicitly qualified in both fields.
    const stale = !live(section);
    records.push({ id, kind, stage, title, state: stale ? `last observed: ${state}` : state, source: sourceOf(section), at,
      detail: (stale ? 'Stale source. ' : '') + detail, ...(jobId ? { jobId } : {}) });
    return id;
  }
  function issue(id, stage, title, reason, section, at, level) {
    attention.push({ id, title, reason, stage, level, source: sourceOf(section), at });
  }

  if (readable('fleet')) {
    const source = sourceOf('fleet') + (s.fleet.source ? `:${s.fleet.source}` : '');
    const seen = new Set();
    for (const a of s.fleet.attempts) {
      const id = token(a.attempt_id);
      if (!id) continue;
      if (seen.has(id)) invalid(); // No verified identity for either conflicting row.
      seen.add(id);
      attempts.push({ id, stage: 'build', state: a.state, route: token(a.route), jobId: token(a.job_id), taskId: token(a.task_id), repo: repoSlug(a.repo),
        at: a.updated_at ?? a.generated_at, quality: fresh(a.generated_at, now) ? quality.fleet : 'stale', source });
    }
  }
  attempts.sort((a, b) => Number(ACTIVE.has(b.state)) - Number(ACTIVE.has(a.state)) || Date.parse(b.at) - Date.parse(a.at) || compare(a.id, b.id));
  if (metrics.active !== null) display('build', `${metrics.active} in flight`, quality.fleet, metrics.active ? 'active' : 'quiet');
  else display('build', 'In-flight count unknown', quality.fleet, 'unknown');
  if (fleetConflict) issue('section:fleet-count', 'build', 'Fleet tally unconfirmed', 'The in-flight tally is not supported by the current attempt rows.', 'fleet', s.fleet.collected_at, 'danger');

  const gates = usableInvariant && inv.status === 'known' && live('pipeline') ? inv.human_approvals_required : null;
  if (gates !== null) display('auth', `${gates} approval gates pending`, inv.status, gates ? 'gate' : 'quiet', gates);
  if (metrics.eligible !== null) display('dispatch', `${metrics.eligible} eligible · ${fmt(metrics.available)} slots free`, inv.status,
    waiting === true ? 'delay' : waiting === null ? 'unknown' : metrics.eligible ? 'active' : 'quiet', metrics.eligible);
  if (b && readable('bottlenecks')) {
    const reason = `Eligible: ${fmt(metrics.eligible)}; free scheduler slots: ${fmt(metrics.available)}; waiting despite capacity: ${fmt(waiting)}.`;
    const id = record('bottleneck', 'invariant', 'dispatch', 'Scheduler invariant', inv.status, 'bottlenecks', inv.generated_at, reason);
    if (waiting === true) issue(id, 'dispatch', 'Eligible work is waiting', reason, 'bottlenecks', inv.generated_at, 'delay');
    const stages = new Set();
    for (const r of b.stages) {
      if (stages.has(r.stage)) invalid();
      stages.add(r.stage);
      const primary = { verify: 'pipeline', integrate: 'pipeline', review: 'backlog', deploy: 'ci' }[r.stage];
      const rowQuality = !live('bottlenecks') ? quality.bottlenecks : !fresh(r.generated_at, now) ? 'stale' : quality[primary];
      const usable = rowQuality === 'live';
      const target = b.thresholds[r.stage].dwell_target_s;
      const dwell = measured(r.dwell_status), flow = measured(r.throughput_status);
      const timed = dwell && (r.dwell_median_s !== null || r.dwell_p95_s !== null) && target !== null;
      const state = timed ? r.state : 'unknown';
      const detail = `Queue: ${fmt(r.queue_depth)}; oldest: ${fmt(r.oldest_item_age_s)} s. Dwell median/p95: ${fmt(dwell ? r.dwell_median_s : null)}/${fmt(dwell ? r.dwell_p95_s : null)} s (${r.dwell_status}); target: ${fmt(target)} s. Throughput per hour, 1h/24h: ${fmt(flow ? r.throughput_per_hour_1h : null)}/${fmt(flow ? r.throughput_per_hour_24h : null)} (${r.throughput_status}).`;
      const id = record('bottleneck', r.stage, r.stage, `${r.stage} queue`, usable ? state : 'unknown', 'bottlenecks', r.generated_at, usable ? detail : `Current ${r.stage} pressure unknown; source is ${rowQuality}.`);
      if (!usable) { display(r.stage, 'Current queue unknown', rowQuality, 'unknown'); continue; }
      display(r.stage, state === 'over' ? 'Dwell over target' : state === 'ok' ? 'Dwell within target' : 'Dwell unknown', r.dwell_status,
        state === 'over' ? 'delay' : state === 'unknown' ? 'unknown' : r.queue_depth > 0 ? 'active' : 'quiet', r.queue_depth);
      if (state === 'over') issue(id, r.stage, `${r.stage} dwell over target`, detail, 'bottlenecks', r.generated_at, 'delay');
    }
  }

  if (readable('decisions')) {
    let pending = 0;
    for (const d of s.decisions.requests) {
      const key = token(d.request_id);
      if (d.state === 'pending') pending++;
      if (!key) continue;
      const at = d.applied_at ?? d.decided_at ?? d.raised_at;
      const title = `Owner request ${key}`;
      // Snapshot/1 lacks a nonce, owner signature or consumption receipt.
      const state = d.state === 'applied' && !d.applied_at ? 'reported applied (time unknown)' : d.state;
      const detail = `Queue reports ${state}; kind: ${token(d.kind) ?? 'unknown'}. Read-only observation.`;
      const id = record('decision', key, 'receiver', title, state, 'decisions', at, detail);
      if (live('decisions') && d.state === 'pending') issue(id, 'receiver', title, 'The decision queue reports a pending owner request.', 'decisions', at, 'gate');
    }
    if (live('decisions')) display('receiver', `${pending} pending owner requests`, 'live', pending ? 'gate' : 'quiet', pending);
  }
  if (readable('pipeline')) for (const j of s.pipeline.jobs) {
    const jobId = token(j.job_id);
    if (!jobId) continue;
    // Jobs have no job-level verdict in /1. Summarize closed task states only.
    const counts = new Map();
    for (const t of j.tasks) counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
    const states = [...counts.keys()].sort().map(k => `${k}: ${counts.get(k)}`).join(', ');
    record('job', jobId, 'build', `Job ${jobId}`, 'recorded', 'pipeline', j.generated_at,
      `Tasks: ${fmt(j.task_count)}${states ? ` (${states})` : ''}; base: ${j.base_rev ?? 'unknown'}; escalations: ${fmt(j.escalation_count)}.`, jobId);
  }
  if (readable('backlog')) for (const f of s.backlog.features) {
    const key = token(f.feature_id);
    if (!key) continue;
    const stage = f.status === 'needs_approval' ? 'auth' : f.status === 'ready_for_review' ? 'review' : 'dispatch';
    record('backlog', key, stage, `Feature ${key}`, f.status, 'backlog', f.generated_at, `Recorded dependencies: ${f.depends_on.length}.`, token(f.job_id));
  }
  if (readable('ci')) for (const pr of s.ci.prs) {
    const repo = repoSlug(pr.repo);
    if (!repo) continue;
    const title = `${repo} #${pr.number}`;
    record('ci', `${repo}#${pr.number}`, 'review', title, pr.state, 'ci', pr.generated_at, `CI: ${pr.ci_state}; failing checks: ${pr.failing_check_names.length}. No reviewed head or deployment receipt in this row.`);
  }
  if (readable('usage')) {
    const meterRow = (key, title, r) => record('usage', key, 'build', title, r.cost_status, 'usage', r.generated_at,
      `Requests: ${fmt(r.requests)}; tokens: ${fmt(measured(r.tokens_status) ? r.total_tokens : null)} (${r.tokens_status}); list-price subtotal USD: ${fmt(measured(r.cost_status) ? r.cost_usd : null)} (${r.cost_status}).`);
    meterRow('totals', 'Usage totals', s.usage.totals);
    for (const r of s.usage.by_model) {
      if (token(r.model) && token(r.provider)) meterRow(`model:${r.provider}:${r.model}`, `${r.provider} · ${r.model}`, r);
    }
    for (const r of s.usage.by_repo) if (repoSlug(r.repo)) meterRow(`repo:${r.repo}`, r.repo, r);
  }
  if (readable('failures')) {
    // No event ID in /1: group equal public observations instead of inventing
    // mutable array-index IDs or silently merging two independent events.
    const groups = new Map();
    for (const f of s.failures.failures) {
      const key = [f.ts, f.class, token(f.attempt_id), token(f.job_id), token(f.task_id), token(f.fallback_to)].join(':');
      const group = groups.get(key) ?? { f, count: 0 }; group.count++; groups.set(key, group);
    }
    for (const [key, { f, count }] of groups) record('failure', key, 'build', `${f.class} observation`, f.class, 'failures', f.ts,
      `Matching rows: ${count}; attempt: ${token(f.attempt_id) ?? 'unknown'}; fallback: ${token(f.fallback_to) ?? 'not reported'}.` + (count === 1 ? ` Component: ${token(f.component) ?? 'unknown'}; code: ${token(f.code) ?? 'unknown'}; retryable: ${fmt(f.retryable)}; HTTP 429: ${fmt(f.http_429)}.` : ''), token(f.job_id));
  }
  if (live('alerts')) {
    const groups = new Map();
    for (const r of s.alerts.active) {
      const key = token(r.key);
      if (!key) continue;
      const group = groups.get(key) ?? { at: r.ts, count: 0 };
      group.count++; if (Date.parse(r.ts) > Date.parse(group.at)) group.at = r.ts; groups.set(key, group);
    }
    for (const [key, g] of groups) issue(`alert:${key}`, 'dispatch', `Threshold: ${key}`, `${g.count} active threshold warning(s) reported.`, 'alerts', g.at, 'delay');
  }
  for (const x of observations) if (x.state !== 'live') issue(`section:${x.id}`, SECTION_STAGE[x.id], `${x.id} source ${x.state}`, 'Current facts cannot be confirmed from this source.', x.id, x.at, 'unknown');

  const priority = x => x.level === 'danger' ? 0 : x.level === 'gate' ? 1 : x.id === 'bottleneck:invariant' ? 2 : x.level === 'delay' ? 3 : 4;
  attention.sort((a, b) => priority(a) - priority(b) || compare(a.id, b.id));
  records.sort((a, b) => compare(a.id, b.id));
  if (records.some((r, i) => i > 0 && r.id === records[i - 1].id)) invalid();
  // Per-kind budget prevents one crowded source from burying all other facts.
  const used = new Map();
  const bounded = records.filter(r => { const count = used.get(r.kind) ?? 0; used.set(r.kind, count + 1); return count < 28; });
  return { generatedAt: s.generated_at, health: fleetConflict ? 'degraded' : health, sections, metrics, attempts: attempts.slice(0, 100), stations, attention: attention.slice(0, 28), records: bounded };
}
