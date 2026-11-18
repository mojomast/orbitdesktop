import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../apps/rizzstack-hive/snapshot-adapter.js';

// Synthetic snapshot/1 observations, not a deployed collector or owner receipt.
const at = '2026-11-17T15:00:00Z';
const clock = { now: Date.parse(at) };
const row = { schema: 'rizzstack.observability/snapshot/1', generated_at: at };
const section = { status: 'live', error: null, collected_at: at };
const privateNote = 'private transcript https://private.invalid/session';
const attempt = (attempt_id, state = 'running') => ({ ...row, attempt_id, state, job_id: 'job-a', task_id: 'task-a', repo: 'example/factory', branch: null, route: 'deepseek', started_at: null, updated_at: at, detail: privateNote });
const stage = (name) => ({ ...row, stage: name, state: 'unknown', queue_depth: null, oldest_item_age_s: null, dwell_p95_s: null, dwell_median_s: null, dwell_status: 'unknown', throughput_per_hour_1h: null, throughput_per_hour_24h: null, throughput_status: 'unknown', wip: null, capacity: null, capacity_source: null });
const decision = (request_id, state) => ({ ...row, request_id, state, kind: 'gate', question: privateNote, subject: 'subject-a', raised_at: at, decided_at: ['applied', 'decided'].includes(state) ? at : null, applied_at: state === 'applied' ? at : null, outcome: ['applied', 'decided'].includes(state) ? 'approve' : null });
function snapshot() {
  const meter = { ...row, requests: 3, input_tokens: null, output_tokens: null, total_tokens: null, cost_usd: 0.09, tokens_status: 'unknown', cost_status: 'partial' };
  return {
    ...row, collector: { name: 'test' }, degraded: [],
    fleet: { ...section, source: 'cli', in_flight: 3, bee_cap: null, attempts: [attempt('bee1'), attempt('bee2'), attempt('bee3', 'working'), attempt('bee4', 'succeeded'), attempt('bee5', 'unknown')] },
    pipeline: { ...section, jobs: [{ ...row, job_id: 'job-a', repo: 'example/factory', base_rev: 'a'.repeat(40), title: privateNote, summary: privateNote, tasks: [{ ...row, task_id: 'task-a', state: 'verifying', reason: privateNote, attempts_count: 1 }], task_count: 1, escalation_count: 0 }], blockers: [], escalations: [], counts: { verifying: 1 } },
    backlog: { ...section, features: [{ ...row, feature_id: 'job-a', job_id: 'job-a', status: 'queued', depends_on: [] }], counts: { queued: 1 } },
    ci: { ...section, prs: [{ ...row, state: 'merged', repo: 'example/factory', number: 7, ci_state: 'passing', failing_check_names: [], head_branch: 'work/new' }], repos: [] },
    failures: { ...section, failures: [{ ...row, ts: at, class: 'rate-limit', attempt_id: 'bee1', job_id: 'job-a', task_id: 'task-a', code: null, component: null, fallback_to: 'deepseek', http_429: true, retryable: null, note: privateNote }], counts: { 'rate-limit': 1 } },
    health: { ...section, scheduler: { ...row, liveness: 'live', alive: true, last_event_at: at, last_event_age_s: 0, source: 'metrics' }, bees_in_flight: 3, bee_cap: 14, quota: [] },
    usage: { ...section, totals: { ...meter, unknown_cost_records: 1, http_429_count: 1, fallback_count: 1 }, source: { ...row, parse_errors: 0, record_count: 3, usage_status: 'known' }, by_model: [{ ...meter, model: 'flash', provider: 'deepseek' }], by_repo: [] },
    alerts: { ...section, active: [{ ...row, key: 'blocker_age_s', severity: 'warn', ts: at, observed: 15000, threshold: 14400, message: privateNote }] },
    decisions: { ...section, requests: [decision('job-a', 'pending'), decision('req2', 'decided'), decision('req3', 'applied')] },
    bottlenecks: { ...section, stages: [{ ...stage('verify'), state: 'over', queue_depth: 3, dwell_p95_s: 95, dwell_median_s: 83, dwell_status: 'partial', throughput_per_hour_1h: 2, throughput_per_hour_24h: 1.25, throughput_status: 'known' }, stage('review'), stage('integrate'), stage('deploy')],
      thresholds: Object.fromEntries(['verify','review','integrate','deploy'].map(name => [name, { dwell_target_s: 60 }])),
      invariant: { ...row, status: 'known', capacity: { max_active: 4, in_use: 3, available: 1 }, ready: 1, ready_waiting_despite_capacity: 1, waiting_despite_capacity: true, total_outstanding: 4, claimed: 0, active_workers: 2, awaiting_verify: 1, awaiting_review: null, awaiting_integrate: null, awaiting_deploy: null, blocked_with_reason: 0, blocked_reasons: {}, human_approvals_required: 0, last_auto_progress_at: null, last_auto_progress_age_s: null, completion_to_next_action_median_s: null, completion_to_next_action_p95_s: null, completion_to_next_action_status: 'unknown' } },
  };
}
const station = (v, id) => v.stations.find(s => s.id === id);

test('maps real selectors and keeps distinct evidence scopes and public identities', () => {
  const s = snapshot();
  const original = structuredClone(s);
  const v = project(s, clock);
  assert.deepEqual(s, original);
  assert.equal(v.generatedAt, at);
  assert.deepEqual(v.stations.map(s => s.id), ['auth','dispatch','build','verify','review','integrate','deploy','receiver']);
  assert.deepEqual(v.metrics, { active: 3, available: 1, capacity: 4, eligible: 1, cost: 0.09, costCoverage: '2/3 priced' });
  assert.equal(station(v, 'verify').level, 'delay');
  assert.equal(station(v, 'verify').depth, 3);
  assert.equal(station(v, 'deploy').level, 'unknown');
  assert.ok(v.attention.some(a => a.stage === 'dispatch' && /capacity/i.test(a.reason)));
  assert.ok(v.attention.some(a => a.source.includes('alerts')));
  const pressure = v.records.find(r => r.kind === 'bottleneck' && r.stage === 'verify');
  for (const measured of [/95/, /60/, /partial/, /1h/, /24h/]) assert.match(pressure.detail, measured);
  assert.deepEqual(v.attempts.find(a => a.id === 'bee4'), { id: 'bee4', state: 'succeeded', stage: 'build', jobId: 'job-a', taskId: 'task-a', route: 'deepseek', repo: 'example/factory', source: 'snapshot/1:fleet:cli', quality: 'live', at });
  assert.equal(new Set(v.records.map(r => r.id)).size, v.records.length);
  for (const kind of ['job','decision','bottleneck','backlog','ci','usage','failure']) assert.ok(v.records.some(r => r.kind === kind && r.source && r.detail && r.at));
  assert.deepEqual(v.records.filter(r => r.kind === 'decision').map(r => r.state).sort(), ['applied','decided','pending']);
  assert.equal(v.attention.filter(a => a.source.includes('decisions')).length, 1);
  assert.equal(v.records.find(r => r.kind === 'ci').state, 'merged');
  assert.ok(!JSON.stringify(v).includes('private'));
});

test('older /1 payloads render independent sections; omissions and unknown cost stay unknown', () => {
  const s = snapshot(); delete s.decisions; delete s.bottlenecks; delete s.fleet.source;
  s.fleet.bee_cap = 14; s.usage.totals.cost_usd = null; s.usage.totals.cost_status = 'unknown'; s.usage.totals.unknown_cost_records = 3;
  const v = project(s, clock);
  for (const id of ['bottlenecks','decisions']) assert.deepEqual(v.sections.find(x => x.id === id), { id, state: 'absent', at: null });
  assert.equal(v.metrics.active, 3);
  for (const key of ['available','capacity','eligible','cost']) assert.equal(v.metrics[key], null);
  assert.equal(station(v, 'receiver').depth, null);
  assert.equal(v.attempts[0].source, 'snapshot/1:fleet');
  assert.ok(v.attention.some(a => a.source.includes('alerts')));
});

test('fresh envelope cannot launder old sections, lease fallback, or an undecidable invariant', () => {
  const s = snapshot(); s.fleet.collected_at = '2026-11-16T15:00:00Z'; s.decisions.status = 'stale'; s.usage.status = 'unavailable';
  s.bottlenecks.invariant.waiting_despite_capacity = null;
  const v = project(s, clock);
  assert.equal(v.sections.find(x => x.id === 'fleet').state, 'stale');
  assert.equal(v.metrics.active, null); assert.equal(v.metrics.cost, null); assert.equal(v.metrics.costCoverage, null);
  assert.equal(station(v, 'build').level, 'unknown'); assert.equal(station(v, 'receiver').depth, null);
  assert.ok(!v.attention.some(a => a.level === 'gate' || /despite capacity/i.test(a.reason)));
  assert.ok(v.attempts.every(a => a.quality === 'stale'));
  s.fleet.collected_at = at; s.fleet.source = 'dispatch_leases';
  assert.equal(project(s, clock).metrics.active, null);
});

test('schema and JSON admission fail closed before selecting any fields, without echoing source', () => {
  for (const mutate of [s => { s.schema += '.99'; }, s => { s.decisions.requests[0].authority = 'owner'; },
    s => { s.degraded = ['decisions']; }, s => { s.fleet.attempts[0].attempt_id = 'bad/id'; }, s => { delete s.usage.by_repo; },
    s => { s.health.quota = [{ ...row, kind: 'box_ram', status: 'unavailable', value: 4, unit: 'byte', remaining: null, cap: null, resource_id: null }]; },
    s => { s.ci.prs[0].state = 'deployed'; }, s => { s.usage.totals.cost_usd = Infinity; },
    s => { s.fleet = Object.create(s.fleet); }, s => { s.generated_at = '2026-02-31T00:00:00Z'; },
    s => { s.generated_at = '2099-12-31T23:59:59Z'; },
    s => { s.fleet.attempts[0] = Object.defineProperty({}, 'state', { get() { throw new Error(privateNote); } }); },
  ]) { const s = snapshot(); mutate(s); assert.throws(() => project(s, clock), { message: 'Invalid Hive snapshot' }); }
});

test('bounded collections, deterministic identities, no placeholder bee or index-based join', () => {
  const s = snapshot(); s.fleet.attempts = Array.from({length: 160}, (_, n) => attempt(`bee-${n}`));
  s.fleet.attempts.unshift(attempt('unknown')); s.fleet.in_flight = 161;
  s.decisions.requests = Array.from({length: 150}, (_, n) => decision(`decision-${n}`, 'pending'));
  const a = project(s, clock); s.fleet.attempts.reverse(); s.decisions.requests.reverse(); const b = project(s, clock);
  assert.ok(a.attempts.length <= 100 && a.records.length <= 200 && a.attention.length <= 50);
  assert.equal(a.metrics.active, 161); assert.equal(station(a, 'receiver').depth, 150);
  assert.ok(!a.attempts.some(x => x.id === 'unknown'));
  assert.deepEqual(a, b);
});

test('public display references are bounded and token-safe even for compound PR and failure keys', () => {
  const s = snapshot();
  Object.assign(s.failures.failures[0], { job_id: 'j'.repeat(128), task_id: 't'.repeat(128), attempt_id: 'a'.repeat(128), code: 'code', component: 'cli' });
  s.ci.prs[0].repo = `${'a'.repeat(120)}/${'b'.repeat(127)}`;
  s.fleet.attempts[0].route = 'private.ts.net';
  s.fleet.attempts[0].task_id = 'github_pat_zero';
  const v = project(s, clock);
  for (const r of [...v.records, ...v.attention, ...v.attempts]) {
    assert.match(r.id, /^[A-Za-z0-9][A-Za-z0-9_.:/#+-]{0,699}$/);
  }
  assert.equal(v.records.find(r => r.kind === 'ci').id, `ci:${s.ci.prs[0].repo}#7`);
  assert.equal(v.attempts.find(x => x.id === 'bee1').route, null);
  assert.equal(v.attempts.find(x => x.id === 'bee1').taskId, null);
});

test('a section timestamp on an old row and a contradicted fleet tally cannot report live progress', () => {
  const s = snapshot();
  s.fleet.in_flight = 14;
  s.bottlenecks.stages[0].generated_at = '2026-11-16T00:00:00Z';
  const v = project(s, clock);
  assert.equal(v.metrics.active, null);
  assert.equal(station(v, 'verify').level, 'unknown');
  assert.ok(!v.attention.some(x => x.stage === 'verify' && x.level === 'delay'));
});
