import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtures, fixtureTime} from '../apps/rizzstack-hive/fixtures.js';
import {project} from '../apps/rizzstack-hive/snapshot-adapter.js';
import {projectLabelView, publishLabels, applyLabels, validateLabels} from '../apps/rizzstack-hive/public-labels.js';

const clock = {now: fixtureTime}, repo = 'observatory/saffron', jobId = 'saffron-wave';
const note = 'Plan the team picnic near the lake';
const job = {kind:'job', id:jobId, repo, jobId, title:'Saffron relay'};
const feature = {kind:'backlog', id:'saffron-card', repo, jobId, title:'Orchard handoff'};
const draft = {version:'hive.public-aliases/1', snapshotSha256:'a'.repeat(64), rows:[job, feature]};
function capture() {
  const s = structuredClone(fixtures.shift);
  Object.assign(s.pipeline.jobs[0], {job_id:jobId, repo, title:note, summary:note});
  Object.assign(s.backlog.features[0], {feature_id:feature.id, job_id:jobId, depends_on:[]});
  s.pipeline.jobs[0].tasks[0].title = note;
  s.decisions.requests[0].question = note;
  return s;
}
const record = (v, row) => v.records.find(r => r.id === `${row.kind}:${row.id}`);
const packetFor = s => publishLabels(s, draft, draft.snapshotSha256, clock);
const show = (view, packet) => applyLabels(view, packet, clock);

test('opt-in aliases for previously unseen keys change two titles only', async () => {
  const s = capture(), base = project(s, clock), packet = await packetFor(s);
  assert.equal(validateLabels(packet), true);
  assert.ok(!JSON.stringify(packet).includes(note));
  const view = await projectLabelView(s, clock), result = show(view, packet);
  const expected = structuredClone(base);
  for (const row of draft.rows) record(expected,row).title = row.title;
  assert.deepEqual(result,expected);
  assert.deepEqual(view,base);
  assert.notStrictEqual(result,view);
  assert.doesNotMatch(JSON.stringify(result), /team picnic|sourceRevision|snapshotSha256/);
  assert.deepEqual(show(result,null),base); // retraction, no sticky display cache
  assert.deepEqual(show(structuredClone(view),packet),base); // no transferable provenance
  assert.deepEqual(show(base,packet),base); // bare id and time are not a binding
});

test('an unpublished source note cannot affect a digest, title or selection', async () => {
  const s = capture(), p = await packetFor(s);
  s.pipeline.jobs[0].title = 'Notes on a new private meeting';
  s.pipeline.jobs[0].summary = 'Return to Elm street after lunch';
  s.pipeline.jobs[0].tasks[0].reason = 'Different private prose';
  s.decisions.requests[0].question = 'Meet tomorrow in the hall?';
  assert.deepEqual(await packetFor(s),p);
  const output = show(await projectLabelView(s,clock),p);
  assert.doesNotMatch(JSON.stringify(output), /private meeting|Elm street|Different private|in the hall|team picnic/);
});

test('replay and substitution: exact repo, source row, job, kind, scoped id and content revision', async () => {
  const p = await packetFor(capture());
  for (const change of [s => {s.pipeline.jobs[0].repo='other/saffron';},
    s => {s.pipeline.jobs[0].base_rev='f'.repeat(40);}, s => {s.pipeline.jobs[0].escalation_count++;},
    s => {s.pipeline.jobs[0].tasks[0].state='rejected';}, s => {s.pipeline.jobs[0].job_id='another-wave';},
    s => {s.pipeline.jobs[0].generated_at='2025-11-17T20:00:00Z';}, s => {s.pipeline.status='stale';}]) {
    const s = capture(); change(s);
    assert.deepEqual(show(await projectLabelView(s,clock),p),project(s,clock));
  }
  for (const change of [s => {s.backlog.features[0].job_id=s.pipeline.jobs[1].job_id;},
    s=>{s.backlog.features[0].depends_on=['other-card'];}, s=>{s.backlog.features[0].status='failed';},
    s=>{s.backlog.features[0].feature_id='other-card';}]) {
    const s = capture(); change(s);
    assert.ok(!JSON.stringify(show(await projectLabelView(s,clock),p)).includes(feature.title));
  }
  const s = capture(), view = await projectLabelView(s,clock), tampered = structuredClone(p);
  [tampered.rows[0].revision,tampered.rows[1].revision]=[tampered.rows[1].revision,tampered.rows[0].revision];
  assert.deepEqual(show(view,tampered),project(s,clock));
  assert.deepEqual(applyLabels(view,p,{now:fixtureTime+600001}),project(s,clock));
  await assert.rejects(publishLabels(s,draft,'0'.repeat(64),clock));
});

test('strict versioned allowlist: no aliases from paths, prose fields, accessors or a wide packet', async () => {
  const s = capture(), p = await packetFor(s), view = await projectLabelView(s,clock);
  const invalid = [p => {p.rows[0].question=note;}, p => {p.extra=null;}, p => {p.rows.push({...p.rows[0]});},
    p => {p.version+='a';}, p => {p.rows=Array(65).fill(p.rows[0]);}, p => {p.rows[0].id='a.b';},
    p => {p.rows[0].repo='ghp_example/slug';}, p => {p.rows[0].revision='a'.repeat(65);},
    p => {p.rows[0].title='x'.repeat(80);}, p => {p.rows[0]=Object.create(p.rows[0]);},
    p => {Object.defineProperty(p.rows[0], 'title',{enumerable:true,get(){throw Error(note);}});},
    p => {p.rows[0].id += '\n';}, p => {p.rows[0].jobId='constructor';}, p => {p.rows[0].kind='decision';},
    ...['/home/user','10.0.0.5','example.org','user@example.org','report.md','Bearer alpha','ghp_abcd',
      'PRIVATE material','Internal','Api key','Access Key','A\u202eB','Two\nlines','Label\n','<b>New</b>','C:\\work','file:///tmp/x'].map(x => p => {p.rows[0].title=x;})];
  for (const change of invalid) {
    const q = structuredClone(p); change(q);
    assert.equal(validateLabels(q),false);
    assert.deepEqual(show(view,q),project(s,clock)); // all or nothing
  }
  for (const rows of [[{...job,question:note}], [{...feature,jobId:'other-job'}],[{...job,kind:'decision'}]]) {
    await assert.rejects(publishLabels(s,{...draft,rows},draft.snapshotSha256,clock));
  }
});

test('sampling a new live generation preserves only unchanged revisions within the review window', async () => {
  const s = capture(), p = await packetFor(s);
  const sample = delta => {
    const now = fixtureTime + delta, stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z');
    const raw = JSON.stringify(s).replaceAll(s.generated_at,stamp);
    return projectLabelView(JSON.parse(raw),{now}).then(v => applyLabels(v,p,{now}));
  };
  assert.equal(record(await sample(60000),job).title,job.title);
  assert.equal(record(await sample(24*60*60_000+1),job).title,`Job ${jobId}`);
  assert.equal(record(await sample(-60000),job).title,`Job ${jobId}`);
});
