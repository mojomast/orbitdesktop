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

// Published display copy only (Workflow scripts/hive_fixtures.py and its
// schemas/hive/fixtures). Collector.scrub masks URLs and truncates; it doesn't
// make an objective, criterion, or owner question public. Never learn labels
// from the incoming snapshot, trust collector.name, or redact by regex.
const JOB_LABELS = new Map(Object.entries({ replay: 'Receipt replay', ledger: 'Ledger reader', viewer: 'Evidence desk',
  worker: 'Landing export', return: 'Receiver gate', release: 'Canary admission' }));
const TASK_LABELS = new Map(Object.entries({
  'replay:digest': 'Match receipt digests', 'replay:twins': 'Reject duplicate receipts', 'replay:redact': 'Remove private fields',
  'replay:chain': 'Match the chain head', 'replay:pair': 'Replay both receipt halves', 'replay:header': 'Match the receipt header',
  'ledger:cursor': 'Resume at the saved cursor', 'ledger:window': 'Limit the replay window', 'ledger:index': 'Index receipt offsets',
  'ledger:limit': 'Cap the page size', 'ledger:offset': 'Match the replay offset',
  'viewer:focus': 'Keep the selected receipt', 'viewer:marks': 'Label source gaps', 'viewer:keys': 'Restore keyboard focus',
  'worker:export': 'Bind the landing receipt', 'worker:origin': 'Preserve the origin ID', 'worker:clock': 'Separate source times',
  'worker:seal': 'Read back the sealed landing', 'return:handoff': 'Wait for the receiver', 'release:handoff': 'Review the canary scope',
}));
const GATE_QUESTIONS = new Map(Object.entries({
  'gate_handoff:return': 'Accept the replay evidence for handoff?', 'gate_canary:release': 'Admit the replay candidate to canary review?',
  'gate_window:ledger': 'Keep the bounded replay window?', 'gate_reader:viewer': 'Include the read-only evidence view?',
}));
// /1 has NO backlog title. These are display names for exact published keys.
const FEATURE_LABELS = new Map(Object.entries({ feat_replay: 'Replay', feat_ledger: 'Ledger', feat_viewer: 'Viewer', feat_worker: 'Worker',
  feat_return: 'Receiver handoff', feat_release: 'Release', feat_publish: 'Publish', feat_obs_snapshot: 'Observability snapshot',
  feat_obs_dashboards: 'Observability dashboards', feat_obs_alerts: 'Observability alerts' }));
const approved = (catalog, key, value) => typeof value === 'string' && catalog.get(key) === value ? catalog.get(key) : null;
// Closed public operations vocabulary for previously unseen IDs. Emit the
// reviewed phrase itself, never a substring/capture from arbitrary producer text.
const PUBLIC_OBJECTS=['observability bridge','snapshot adapter','release candidate','receipt replay','integration results','deployment rollback','worker routing','verification evidence','Rails timeline'];
const PUBLIC_TITLES=new Set(PUBLIC_OBJECTS.flatMap(noun=>['Review','Verify','Integrate','Inspect','Prepare','Repair'].map(verb=>`${verb} ${noun}`)));
const PUBLIC_QUESTIONS=new Set([...PUBLIC_TITLES].flatMap(title=>[`${title}?`,`Approve: ${title[0].toLowerCase()+title.slice(1)}?` ]));
const publicPhrase=(allowed,value)=>typeof value==='string'&&allowed.has(value)?value:null;
const featureName = key => FEATURE_LABELS.get(key) ?? `Feature ${key}`;

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
  if (!s || s.toLowerCase() === 'unknown' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(s)) return null;
  if (/(?:^|[._-])(?:private|secret|credential|password)(?:[._-]|$)/i.test(s)) return null;
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
  function record(kind, key, stage, title, state, section, at, detail, jobId = null, observedAt = at) {
    const id = `${kind}:${key}`;
    // Records lack a separate quality field in this display contract. Historical
    // rows keep their observed values, explicitly qualified in both fields.
    const stale = !live(section) || !fresh(observedAt, now);
    records.push({ id, kind, stage, title, state: stale ? `last observed: ${state}` : state, source: sourceOf(section), at,
      detail: (stale ? 'Stale source. ' : '') + detail, ...(jobId ? { jobId } : {}) });
    return id;
  }
  function issue(id, stage, title, reason, section, at, level, detail) {
    attention.push({ id, title, reason, stage, level, source: sourceOf(section), at, ...(detail ? { detail } : {}) });
  }
  // A section summary with a direct record target; no fabricated event IDs.
  // Keep the latest example (stable ID tie-break) and the number of matching
  // observations. This keeps a large source from displacing the owner inbox.
  const negative = new Map();
  function negativeExample(key, stage, title, reason, section, at, target) {
    const group = negative.get(key);
    const example = { stage, title, reason, section, at, target };
    const later = !group || Date.parse(at) > Date.parse(group.at) || (Date.parse(at) === Date.parse(group.at) && compare(target, group.target) < 0);
    negative.set(key, { ...(later ? example : group), count: (group?.count ?? 0) + 1 });
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

  const currentJobs = new Map(), currentTasks = new Map();
  if (readable('pipeline')) for (const j of s.pipeline.jobs) {
    const jobId = token(j.job_id);
    if (!jobId) continue;
    const title = approved(JOB_LABELS, jobId, j.title) ?? publicPhrase(PUBLIC_TITLES,j.title) ?? publicPhrase(PUBLIC_TITLES,j.summary) ?? `Job ${jobId}`;
    const current = live('pipeline') && fresh(j.generated_at, now);
    if (current) currentJobs.set(jobId, {title, repo: repoSlug(j.repo)});
    const counts = new Map(), labels = [], failed = [], ids = new Set();
    for (const t of j.tasks) {
      const taskId = token(t.task_id);
      if (taskId) {
        if (ids.has(taskId)) invalid();
        ids.add(taskId);
      }
      if (!fresh(t.generated_at, now) && current) continue;
      counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
      if (!taskId) continue;
      // Neither ID admits ':'. Task IDs alone are not unique across jobs.
      const pair = `${jobId}:${taskId}`, name = approved(TASK_LABELS, pair, t.title) ?? publicPhrase(PUBLIC_TITLES,t.title);
      if (name) labels.push(`${name} (${t.state})`);
      if (current) currentTasks.set(pair, {name, state: t.state});
      if (current && t.state === 'failed') failed.push(name ?? `Task ${taskId}`);
    }
    const states = [...counts.keys()].sort().map(k => `${k}: ${counts.get(k)}`).join(', ');
    const names = labels.sort().slice(0, 8).join('; ');
    const detail = `Tasks: ${fmt(j.task_count)}${states ? ` (${states})` : ''}; base: ${j.base_rev ?? 'unknown'}; escalations: ${fmt(j.escalation_count)}.`;
    const id = record('job', jobId, 'build', title, 'recorded', 'pipeline', j.generated_at, names ? `${detail} ${names}.` : detail, jobId);
    if (failed.length) negativeExample('failed-tasks', 'build', `${title}: failed task`, `${failed.sort()[0]} was reported failed by the pipeline.`, 'pipeline', j.generated_at, id);
  }
  for (const a of attempts) {
    if (a.quality !== 'live' || !a.jobId || !a.taskId) continue;
    const job = currentJobs.get(a.jobId), task = currentTasks.get(`${a.jobId}:${a.taskId}`);
    if (task?.name && !(a.repo && job.repo && a.repo !== job.repo)) a.detail = task.name;
  }
  const gateFeatures = new Map(), dependents = new Map();
  if (readable('backlog')) for (const f of s.backlog.features) {
    const key = token(f.feature_id);
    if (!key) continue;
    const stage = f.status === 'needs_approval' ? 'auth' : f.status === 'ready_for_review' ? 'review' : 'dispatch';
    const title = featureName(key), jobId = token(f.job_id);
    const id = record('backlog', key, stage, title, f.status, 'backlog', f.generated_at, `Recorded dependencies: ${f.depends_on.length}.`, jobId);
    if (live('backlog') && fresh(f.generated_at, now)) {
      if (f.status === 'failed') negativeExample('failed-features', stage, `${title}: failed feature`, 'The backlog reports this feature as failed.', 'backlog', f.generated_at, id);
      if (f.status === 'needs_approval' && jobId) {
        if (!gateFeatures.has(jobId)) gateFeatures.set(jobId, []);
        gateFeatures.get(jobId).push(key);
      }
      for (const dep of new Set(f.depends_on)) {
        if (!dependents.has(dep)) dependents.set(dep, new Set());
        dependents.get(dep).add(key);
      }
    }
  }
  const decisionSupport = new Set();
  if (readable('decisions')) {
    let pending = 0, complete = true;
    for (const d of s.decisions.requests) {
      const key = token(d.request_id), current = live('decisions') && fresh(d.generated_at, now);
      if (!current) complete = false;
      if (d.state === 'pending' && current) pending++;
      if (!key) continue;
      const at = d.applied_at ?? d.decided_at ?? d.raised_at;
      // A subject may also name a gate, feature, or grant. Only these published
      // requests have a typed subject→job binding, not every ID-shaped subject.
      const question = d.kind === 'gate' && approved(GATE_QUESTIONS, `${key}:${d.subject}`, d.question);
      const jobId = question && current && currentJobs.has(d.subject) ? d.subject : null;
      const title = question || publicPhrase(PUBLIC_QUESTIONS,d.question) || `Owner request ${key}`;
      const state = d.state === 'applied' && !d.applied_at ? 'reported applied (time unknown)' : d.state;
      const subject = jobId ? `${currentJobs.get(jobId).title} (${jobId})` : question || PUBLIC_OBJECTS.includes(d.subject) ? d.subject : 'not published';
      const kind = ['gate','budget','scope','grant'].includes(d.kind) ? d.kind : 'unknown';
      let detail = `Subject: ${subject}. Queue reports ${state}; kind: ${kind}. Read-only observation.`;
      if (jobId && d.state === 'pending') {
        decisionSupport.add(`job:${jobId}`);
        const keys = (gateFeatures.get(jobId) ?? []).sort().slice(0, 3);
        const downstream = new Set();
        for (const k of keys) {
          decisionSupport.add(`backlog:${k}`);
          for (const dep of dependents.get(k) ?? []) downstream.add(dep);
        }
        // Describe dependency edges, not a prediction that approving will run work.
        const next = [...downstream].sort().slice(0, 3);
        for (const k of next) decisionSupport.add(`backlog:${k}`);
        // New prose exposes only published aliases, not other opaque subjects.
        const named = next.map(k => FEATURE_LABELS.get(k)).filter(Boolean);
        if (named.length) detail += ` Downstream feature: ${named.join(', ')}.`;
      }
      const id = record('decision', key, 'receiver', title, state, 'decisions', at, detail, jobId, d.generated_at);
      if (current && d.state === 'pending') issue(id, 'receiver', title, 'The decision queue reports a pending owner request.', 'decisions', at, 'gate');
    }
    if (live('decisions') && complete) display('receiver', `${pending} pending owner requests`, 'live', pending ? 'gate' : 'quiet', pending);
  }
  if (readable('ci')) for (const pr of s.ci.prs) {
    const repo = repoSlug(pr.repo);
    if (!repo) continue;
    const title = `${repo} #${pr.number}`;
    const id = record('ci', `${repo}#${pr.number}`, 'review', title, pr.state, 'ci', pr.generated_at, `CI: ${pr.ci_state}; failing checks: ${pr.failing_check_names.length}. No reviewed head or deployment receipt in this row.`);
    if (live('ci') && fresh(pr.generated_at, now) && pr.ci_state === 'failing') negativeExample('failing-ci', 'review', `${title}: CI failing`, 'The PR row reports failing CI.', 'ci', pr.generated_at, id);
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
    for (const [key, { f, count }] of groups) {
      const jobId = token(f.job_id), taskId = token(f.task_id);
      const detail = `Matching rows: ${count}; attempt: ${token(f.attempt_id) ?? 'unknown'}; fallback: ${token(f.fallback_to) ?? 'not reported'}.` + (count === 1 ? ` Component: ${token(f.component) ?? 'unknown'}; code: ${token(f.code) ?? 'unknown'}; retryable: ${fmt(f.retryable)}; HTTP 429: ${fmt(f.http_429)}.` : '');
       const verifier = count === 1 && f.component === 'verify';
       const id = record('failure', key, verifier ? 'verify' : 'build', verifier ? `Verifier ${f.class} observation` : `${f.class} observation`, f.class, 'failures', f.ts, detail + ' Recovery status is unknown.', jobId, count === 1 ? f.generated_at : f.ts);
      const task = jobId && taskId && currentTasks.get(`${jobId}:${taskId}`);
      // A failure event can outlive its incident. Surface only a fresh reported
      // verifier regression, or one corroborated by a current failed task. No
      // inference from a worker exit state, error prose, fallback, or retryable.
      if (count === 1 && live('failures') && fresh(f.generated_at, now) && Date.parse(f.ts) <= now + CLOCK_SKEW_MS &&
          f.component === 'verify' && f.class === 'regression' && (fresh(f.ts, now) || task?.state === 'failed')) {
        negativeExample('verifier-failure', 'verify', 'Verifier reported a regression', `Recorded failure${task?.name ? ` for ${task.name}` : ''}. Recovery status is unknown.`, 'failures', f.ts, id);
      }
    }
  }
  for (const [key, g] of negative) issue(`section:${key}`, g.stage, g.title,
    g.reason + (g.count > 1 ? ` Matching records: ${g.count}.` : ''), g.section, g.at, 'danger', g.target);
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
  const shown = attention.slice(0, 28), targets = new Set(shown.map(a => a.detail ?? a.id));
  const rank = r => targets.has(r.id) ? 0 : decisionSupport.has(r.id) ? 1 : 2;
  records.sort((a,b) => rank(a) - rank(b) || compare(a.id,b.id));
  const used = new Map();
  const bounded = records.filter(r => { const count = used.get(r.kind) ?? 0; used.set(r.kind, count + 1); return count < 28; });
  bounded.sort((a,b) => compare(a.id,b.id));
  return { generatedAt: s.generated_at, health: fleetConflict ? 'degraded' : health, sections, metrics, attempts: attempts.slice(0, 100), stations, attention: shown, records: bounded };
}
