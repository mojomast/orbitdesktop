import test from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../apps/rizzstack-hive/snapshot-adapter.js';
import { fixtures, fixtureTime } from '../apps/rizzstack-hive/fixtures.js';

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
  for (const mutate of [s => { s.schema += '.99'; },
    s => { s.degraded = ['not_a_section']; }, s => { s.usage.totals.cost_usd = Infinity; },
    s => { s.fleet = Object.create(s.fleet); }, s => { s.generated_at = '2026-02-31T00:00:00Z'; },
    s => { s.generated_at = '2099-12-31T23:59:59Z'; },
    s => { s.fleet.attempts[0] = Object.defineProperty({}, 'state', { get() { throw new Error(privateNote); } }); },
  ]) { const s = snapshot(); mutate(s); assert.throws(() => project(s, clock), { message: 'Invalid Hive snapshot' }); }
});

test('section-local schema violations degrade only their own section', () => {
  for (const [id, mutate] of [
    ['decisions', s => { s.decisions.requests[0].authority = 'owner'; }],
    ['fleet', s => { s.fleet.attempts[0].attempt_id = 'bad/id'; }],
    ['usage', s => { delete s.usage.by_repo; }],
    ['health', s => { s.health.quota = [{ ...row, kind: 'box_ram', status: 'unavailable', value: 4, unit: 'byte', remaining: null, cap: null, resource_id: null }]; }],
    ['ci', s => { s.ci.prs[0].state = 'deployed'; }],
  ]) {
    const s = snapshot();
    mutate(s);
    const v = project(s, clock);
    assert.equal(v.sections.find(x => x.id === id).state, 'unavailable');
    assert.ok(v.sections.some(x => x.id !== id && x.state === 'live'), `${id} degraded every section`);
    assert.deepEqual(v.stations.map(x => x.id), ['auth','dispatch','build','verify','review','integrate','deploy','receiver']);
  }
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

const replay = (s = fixtures.dense) => project(s, {now: fixtureTime});
const byId = (rows, id) => rows.find(r => r.id === id);
test('verifier ticket opens the same stage and retains uncertainty about recovery',()=>{
  const v=replay(), signal=v.attention.find(r=>r.id==='section:verifier-failure');
  const evidence=byId(v.records,signal.detail);assert.equal(evidence.source,signal.source);assert.equal(evidence.stage,'verify');assert.match(evidence.detail,/Recovery status is unknown/);
});
test('new public selectors may use a reviewed operational phrase without inheriting a job binding',()=>{
  const s=structuredClone(fixtures.shift), d=s.decisions.requests[0];
  Object.assign(d,{request_id:'req_new',question:'Integrate observability bridge?',subject:'bridge'});
  const j=s.pipeline.jobs[0];j.title='Verify receipt replay';const v=replay(s);
  const decision=byId(v.records,'decision:req_new');assert.equal(decision.title,d.question);assert.equal(decision.jobId,undefined);assert.equal(byId(v.records,`job:${j.job_id}`).title,j.title);
  d.question+=' private notes';assert.equal(byId(replay(s).records,'decision:req_new').title,'Owner request req_new');
});

test('published job, task, feature and gate labels follow exact collector keys', () => {
  for (const name of ['shift','dense','quiet','degraded']) {
    const raw = fixtures[name], v = replay(raw);
    for (const j of raw.pipeline.jobs) assert.equal(byId(v.records, `job:${j.job_id}`).title, j.title);
    for (const a of v.attempts) {
      const task = raw.pipeline.jobs.find(j => j.job_id === a.jobId)?.tasks.find(t => t.task_id === a.taskId);
      if (a.quality === 'live') assert.equal(a.detail, task.title);
      else assert.ok(!Object.hasOwn(a, 'detail'));
    }
    for (const d of raw.decisions?.requests ?? []) {
      const r = byId(v.records, `decision:${d.request_id}`);
      assert.equal(r.title, d.question);
      assert.equal(r.jobId, d.subject);
      assert.ok(r.detail.includes(`(${d.subject})`));
      const job = byId(v.records, `job:${r.jobId}`);
      assert.ok(r.detail.includes(job.title));
      if (r.state === 'pending') {
        assert.equal(byId(v.attention,r.id).title,r.title);
        const gate = v.records.find(f => f.kind === 'backlog' && f.jobId === r.jobId);
        assert.equal(gate.state, 'needs_approval');
        assert.match(r.detail, /Downstream feature: Publish/);
        assert.equal(byId(v.records,'backlog:feat_publish').title, 'Publish');
      }
    }
  }
});

test('free prose never becomes public through a title, task, subject, question, dependency or named producer', () => {
  for (const canary of ['Plan the quarterly staffing review', 'Approve that travel reimbursement?', 'PRIVATE-FIXTURE-OMIT',
    'ghp_fixtureCredential', 'west-ops.ts.net', '/home/operator/private.txt', 'https://private.invalid/session', '<script>', 'a\u202eb']) {
    const s = structuredClone(fixtures.shift), j = s.pipeline.jobs.find(j => j.job_id === 'return');
    j.title = canary; j.summary = canary; j.tasks[0].title = canary; j.tasks[0].reason = canary;
    const a = s.fleet.attempts[0], aj = s.pipeline.jobs.find(j => j.job_id === a.job_id);
    aj.tasks.find(t => t.task_id === a.task_id).title = canary; a.detail = canary;
    s.decisions.requests[0].question = canary;
    const v = replay(s);
    assert.ok(!JSON.stringify(v).includes(canary));
    assert.equal(byId(v.records,'job:return').title, 'Job return');
    assert.equal(byId(v.records,'decision:gate_handoff').title, 'Owner request gate_handoff');
    assert.ok(!byId(v.records,'decision:gate_handoff').jobId);
    assert.ok(!byId(v.attempts,a.attempt_id).detail);
  }
  const s = structuredClone(fixtures.shift);
  s.decisions.requests[0].subject = 'Quarterly.staffing.review';
  s.decisions.requests[0].kind = 'private-owner';
  s.backlog.features[0].feature_id = 'PRIVATE-FEATURE';
  s.backlog.features.at(-1).depends_on = ['private.ts.net'];
  assert.doesNotMatch(JSON.stringify(replay(s)), /Quarterly\.staffing|private-owner|PRIVATE-FEATURE|private\.ts\.net/);
});

test('matching a request id, task id, gate type or similar feature id alone does not establish a join', () => {
  const s = structuredClone(fixtures.shift);
  const a = s.fleet.attempts.find(a => a.task_id === 'digest');
  a.job_id = 'ledger'; // digest exists, but in another job
  s.decisions.requests.push({...s.decisions.requests[0], request_id: 'return'});
  s.backlog.features.at(-1).depends_on = ['feat_return_2'];
  const v = replay(s);
  assert.ok(!byId(v.attempts,a.attempt_id).detail);
  assert.ok(!byId(v.records,'decision:return').jobId);
  assert.doesNotMatch(byId(v.records,'decision:gate_handoff').detail, /Publish/);
  a.job_id = 'replay'; a.repo = 'another/repo';
  assert.ok(!byId(replay(s).attempts,a.attempt_id).detail);
  const j = s.pipeline.jobs.find(j => j.job_id === 'replay');
  j.tasks.push({...j.tasks[0], title:'Conflicting identity'});
  assert.throws(() => replay(s), {message:'Invalid Hive snapshot'});
});

test('the worker outcome, failed task, verifier report and PR checks remain separate observations', () => {
  const s = structuredClone(fixtures.dense);
  s.failures.failures[0].retryable = true;
  const v = replay(s), worker = byId(v.attempts,'att_offset');
  assert.equal(worker.state, 'succeeded');
  const verifier = byId(v.attention,'section:verifier-failure');
  assert.equal(verifier.stage, 'verify');
  assert.equal(verifier.at, s.failures.failures[0].ts);
  assert.match(byId(v.records,verifier.detail).detail, /retryable: true/);
  assert.match(verifier.reason, /Recovery status is unknown/);
  assert.equal(byId(v.attention,'section:failed-tasks').detail, 'job:ledger');
  assert.equal(byId(v.records,'job:ledger').state, 'recorded');
  const ci = byId(v.attention,'section:failing-ci');
  assert.equal(byId(v.records,ci.detail).id, 'ci:demo/bundlebees#24');
  assert.ok(!Object.hasOwn(byId(v.records,ci.detail), 'jobId'));
  s.ci.prs[0].ci_state = 'unavailable'; // check names are not verdicts
  s.pipeline.jobs.find(j => j.job_id === 'ledger').tasks.find(t => t.task_id === 'offset').state = 'pending';
  s.failures.failures[0].component = 'unknown';
  assert.ok(!replay(s).attention.some(a => ['section:verifier-failure','section:failed-tasks','section:failing-ci'].includes(a.id)));
});

test('live envelope with stale rows cannot support present-tense joins or attention', () => {
  const s = structuredClone(fixtures.dense), old = '2026-11-16T15:00:00Z';
  s.decisions.requests[0].generated_at = old;
  s.pipeline.jobs.find(j => j.job_id === 'ledger').generated_at = old;
  s.failures.failures[0].generated_at = old;
  s.ci.prs.find(pr => pr.ci_state === 'failing').generated_at = old;
  const v = replay(s);
  assert.equal(byId(v.records,'decision:gate_canary').state, 'last observed: pending');
  assert.ok(!byId(v.records,'decision:gate_canary').jobId);
  assert.equal(station(v,'receiver').depth, null);
  assert.ok(!byId(v.attempts,'att_cursor').detail);
  assert.ok(!v.attention.some(a => a.level === 'danger' || a.level === 'gate'));
  s.decisions.status = 'unavailable'; s.pipeline.status = 'unavailable';
  const u = replay(s);
  assert.ok(!u.records.some(r => ['job','decision'].includes(r.kind)));
  assert.ok(!u.attempts.some(a => a.detail));
});

test('bounded selection retains pending gate and its exact evidence under crowded sources and permutation', () => {
  const s = structuredClone(fixtures.dense);
  for (let i = 0; i < 80; i++) {
    s.pipeline.jobs.push({...s.pipeline.jobs[0], job_id:`a-${i}`, tasks:[]});
    s.backlog.features.push({...s.backlog.features[0], feature_id:`a-${i}`});
    s.decisions.requests.push({...s.decisions.requests[1], request_id:`a-${i}`});
    s.ci.prs.push({...s.ci.prs[0], ci_state:'passing', repo:`a/r${i}`});
  }
  const v = replay(s);
  for (const id of ['decision:gate_canary','job:release','backlog:feat_release','backlog:feat_publish']) assert.ok(byId(v.records,id));
  for (const a of v.attention) if (a.detail) assert.equal(byId(v.records,a.detail).source,a.source);
  assert.ok(v.records.length <= 200 && v.attention.length <= 50);
  assert.ok(Buffer.byteLength(JSON.stringify(v)) <= 512 * 1024);
  s.pipeline.jobs.reverse(); s.backlog.features.reverse(); s.decisions.requests.reverse(); s.ci.prs.reverse();
  assert.deepEqual(replay(s), v);
});
