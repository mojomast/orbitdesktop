import test from "node:test";
import assert from "node:assert/strict";
import { createInspector } from "../apps/rizzstack-hive/inspector.js";
import { chapters, trace, traceFrame } from "../apps/rizzstack-hive/trace.js";
import { controlsFor } from "../apps/rizzstack-hive/operations.js";
import * as api from "../apps/rizzstack-hive/inspector.js";
import { fixtures, fixtureTime } from '../apps/rizzstack-hive/fixtures.js';
import { project } from '../apps/rizzstack-hive/snapshot-adapter.js';

// Deterministic DOM host; removing or moving a focused subtree loses focus,
// just as replacing the original inspector did on every collector refresh.
class Element {
  constructor(tag, doc) {
    this.tag = tag;
    this.ownerDocument = doc;
  }
  children = [];
  textContent = "";
  attrs = new Map();
  setAttribute(k, v) {
    this.attrs.set(k, v);
  }
  contains(n) {
    return n === this || this.children.some((c) => c.contains(n));
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  remove() {
    if (!this.parent) return;
    if (this.contains(this.ownerDocument.activeElement))
      this.ownerDocument.activeElement = null;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  insertBefore(n, before) {
    n.remove();
    this.children.splice(
      before ? this.children.indexOf(before) : this.children.length,
      0,
      n,
    );
    n.parent = this;
  }
  append(...ns) {
    ns.forEach((n) => this.insertBefore(n, null));
  }
  replaceChildren(...ns) {
    [...this.children].forEach((n) => n.remove());
    this.append(...ns);
  }
  click() {
    if (!this.disabled) this.onclick?.();
  }
}
const at = "2026-11-17T20:00:00Z";
function fixture() {
  const attempt = {
    id: "a",
    jobId: "job1",
    taskId: "shared",
    detail: "Check receipt",
    source: "snapshot/1:fleet:cli",
    stage: "build",
    state: "running",
    quality: "live",
    at,
  };
  const job = {
    id: "job:job1",
    kind: "job",
    jobId: "job1",
    title: "Receipt replay",
    stage: "build",
    source: "snapshot/1:pipeline",
    state: "recorded",
    at,
  };
  const task = {
    id: "task:job1:shared",
    kind: "task",
    title: "Check receipt",
    jobId: "job1",
    taskId: "shared",
    stage: "build",
    source: job.source,
    at,
  };
  const pressure = {
    id: "bottleneck:verify",
    kind: "bottleneck",
    title: "Verification queue",
    source: "snapshot/1:bottlenecks",
    stage: "verify",
    at,
  };
  return {
    generatedAt: at,
    sections: ["fleet", "pipeline", "bottlenecks"].map((id) => ({
      id,
      state: "live",
      at,
    })),
    metrics: {},
    stations: [
      {
        id: "verify",
        signal: "Dwell within target",
        quality: "known",
        depth: 0,
      },
    ],
    attention: [],
    attempts: [attempt],
    records: [
      job,
      task,
      { ...task, id: "task:job2:shared", jobId: "job2" },
      pressure,
    ],
  };
}
function host(
  capabilities = (ctx) => controlsFor(ctx).filter((c) => c.kind === "write"),
) {
  const doc = {
      createElement(tag) {
        return new Element(tag, this);
      },
    },
    root = doc.createElement("div");
  const picks = [],
    opens = [],
    seeks = [];
  const inspector = createInspector({
    root,
    capabilities,
    onRails: (...a) => opens.push(a),
    onChoose: (s) => picks.push(s),
    onSeek: (i) => seeks.push(i),
  });
  const all = (n = root) => n.children.flatMap((c) => [c, ...all(c)]);
  const opts = {
    selection: { kind: "attempt", id: "a" },
    mode: "host",
    status: "connected",
    railsAvailable: true,
  };
  return {
    root,
    doc,
    picks,
    opens,
    seeks,
    inspector,
    all,
    update: (v, o) => inspector.update(v, { ...opts, ...o }),
    node: (tag) => all().find((n) => n.tag === tag),
    find: (text) => all().find((n) => n.textContent === text),
    btn: (part) =>
      all().find((n) => n.tag === "button" && n.textContent.includes(part)),
  };
}

test("accepted refresh retains the same focused heading, expanded authority and Rails invoker", () => {
  const h = host(),
    v = fixture();
  h.update(v);
  const title = h.node("h2"),
    details = h.node("details"),
    rails = h.btn("Open Rails timeline ↗");
  assert.equal(title.id, "inspect-title");
  assert.equal(title.tabIndex, -1);
  title.focus();
  details.open = true;
  v.attempts[0].state = "working";
  v.generatedAt = "2026-11-17T20:01:00Z";
  h.update(v);
  assert.equal(h.doc.activeElement, title);
  assert.equal(h.node("h2"), title);
  assert.ok(h.find("working"));
  rails.focus();
  h.update(v);
  assert.equal(h.btn("Open Rails timeline ↗"), rails);
  assert.equal(h.doc.activeElement, rails);
  assert.equal(h.node("details"), details);
  assert.equal(details.open, true);
  assert.deepEqual(h.opens, []);
  rails.click();
  assert.deepEqual(h.opens, [["attempt", "a"]]);
});

test("a dropped record, revoked grant or stale source cannot open Rails; clear drops old controls", () => {
  const h = host(),
    v = fixture();
  h.update(v);
  const b = h.btn("Open Rails timeline ↗");
  for (const o of [
    { status: "conflict" },
    { status: "loading" },
    { railsAvailable: false },
    { mode: "replay" },
  ]) {
    h.update(v, o);
    assert.equal(b.disabled, true);
    b.click();
  }
  v.attempts[0].quality = "stale";
  h.update(v);
  assert.equal(b.disabled, true);
  b.click();
  h.update({ ...v, attempts: [] });
  b.click();
  assert.equal(h.btn("Open Rails"), undefined);
  const job = { selection: { kind: "job", id: "job:job1" } };
  h.update(v, job);
  const j = h.btn("Open Rails timeline ↗");
  j.click();
  assert.deepEqual(h.opens, [["job", "job1"]]);
  v.records[0].state = "last observed: recorded";
  h.update(v, job);
  assert.equal(j.disabled, true);
  h.update(v, { ...job, status: "unauthorized" });
  assert.equal(h.root.children.length, 0);
  j.click();
  assert.deepEqual(h.opens, [["job", "job1"]]);
});

test("links use the public job + task pair and pressure record; controls expose reasons without writers", () => {
  const h = host(() => [
    {
      label: "Retry attempt",
      available: true,
      reason: "Current lease required.",
      next: "Check the fence.",
    },
  ]);
  const v = fixture();
  v.attempts[0].source = "<img src=x>";
  h.update(v);
  h.btn("Related job").click();
  h.btn("Related task").click();
  assert.deepEqual(h.picks, [
    { kind: "job", id: "job:job1" },
    { kind: "task", id: "task:job1:shared" },
  ]);
  assert.ok(!h.btn("task:job2:shared"));
  assert.ok(!h.node("img"));
  assert.ok(!h.find("<img src=x>"));
  assert.ok(!h.btn("Retry attempt"));
  assert.ok(h.all().some((n) => n.textContent.includes("Check the fence.")));
  h.update(v, { selection: { kind: "station", id: "verify" } });
  assert.deepEqual(
    h
      .all().find(n=>n.tag==='dl' && n.className==='facts')
      .children.slice(0, 2)
      .map((n) => n.children.map((c) => [c.tag, c.textContent])),
    [
      [
        ["dt", "Observation"],
        ["dd", "Dwell within target"],
      ],
      [
        ["dt", "Queue depth"],
        ["dd", "0"],
      ],
    ],
  );
  assert.ok(h.find("known"));
  h.btn("Inspect pressure").click();
  assert.deepEqual(h.picks.at(-1), {
    kind: "bottleneck",
    id: "bottleneck:verify",
  });
});

test('highlight uses exact current identities; no stale, ambiguous, cross-repo or stage joins', () => {
  const v = fixture();
  v.attempts.push({...v.attempts[0], id:'b', jobId:'job2'});
  const ids = (kind,id) => [...api.relatedAttemptIds(v,{kind,id})];
  assert.deepEqual(ids('attempt','a'), ['a']);
  assert.deepEqual(ids('station','verify'), []);
  assert.deepEqual(ids('task','task:job1:shared'), ['a']);
  assert.deepEqual(ids('job','job:job1'), ['a']);
  v.records[0].repo='team/one'; v.attempts[0].repo='team/two';
  assert.deepEqual(ids('job','job:job1'), []);
  delete v.attempts[0].repo;
  v.records.push({...v.records[0]}); assert.deepEqual(ids('job','job:job1'), []);
  v.attempts.push({...v.attempts[0],jobId:'job3'});
  assert.deepEqual(ids('attempt','a'), []);
  v.attempts.pop(); v.attempts[0].quality='stale'; assert.deepEqual(ids('attempt','a'), []);
  assert.deepEqual(ids('attempt','../missing'), []);
});

test('decision dossier distinguishes a queue state from permission and an effect receipt, including after a changed head', () => {
  const h = host();
  const snapshot = structuredClone(fixtures.dense);
  const selection = {kind:'decision',id:'decision:gate_reader'};
  const render = () => h.update(project(snapshot,{now:fixtureTime}),{selection,mode:'dense'});
  const fact = label => h.find(label)?.parent.children[1].textContent;
  render();
  assert.ok(h.find('Decision readiness'));
  assert.equal(fact('Current candidate head'),'Unknown');
  assert.equal(fact('Current contract'),'Unknown');
  for (const x of ['Permitted options','Current lease','Remaining budget','Owner authority','Effect receipt']) assert.equal(fact(x),'Unknown',x);
  assert.ok(h.node('ol')); assert.ok(h.node('time'));
  assert.equal(h.btn('Submit owner decision'),undefined);
  const job=snapshot.pipeline.jobs.find(j=>j.job_id==='viewer');
  job.base_rev='1'.repeat(40); render(); job.base_rev='2'.repeat(40); render();
  assert.equal(fact('Current candidate head'),'Unknown');
  assert.ok(!h.find('1'.repeat(40)) && !h.find('2'.repeat(40)));
  const v = project(snapshot,{now:fixtureTime}), row=v.records.find(x=>x.id===selection.id);
  Object.assign(row,{receipt:'private-unverified',options:['Approve'],head:'3'.repeat(40),authority:'owner'});
  h.update(v,{selection,status:'conflict'});
  assert.equal(fact('Owner authority'),'Unknown'); assert.equal(fact('Effect receipt'),'Unknown');
  assert.ok(!h.find('private-unverified')); assert.ok(!h.find('3'.repeat(40)));
  assert.ok(h.all().some(x=>/last confirmed|historical/i.test(x.textContent)));
});

test('a failure highlights its exact named attempt, never other attempts on the same job or IDs in prose', () => {
  const v = project(fixtures.dense,{now:fixtureTime});
  const signal = v.attention.find(a=>a.id==='section:verifier-failure');
  const row = v.records.find(r=>r.id===signal.detail);
  assert.ok(v.attempts.filter(a=>a.jobId===row.jobId).length>1);
  const selected = {kind:'attention',id:signal.id};
  assert.deepEqual([...api.relatedAttemptIds(v,selected)],['att_offset']);
  v.attempts.find(a=>a.id==='att_offset').taskId='different';
  row.detail='Matching rows: 1; attempt: att_cursor; fallback: not reported.';
  assert.deepEqual([...api.relatedAttemptIds(v,selected)],[]);
  signal.detail='missing'; assert.deepEqual([...api.relatedAttemptIds(v,selected)],[]);
});

test('suite outcomes stay with the verifier mark at its recorded head and contract',()=>{
  const h=host(), c=chapters[2], v=traceFrame(c.i), r=v.records.at(-1);
  const draw=()=>h.update(v,{mode:'replay',selection:{kind:'event',id:r.id}});
  draw(); assert.ok(h.find('Passed'));
  r.revision='f'.repeat(40); draw(); assert.ok(!h.find('Passed'));
  r.revision=trace.runs[r.run].revision; r.contract='f'.repeat(64); draw(); assert.ok(!h.find('Passed'));
  const worker=v.records.find(x=>x.role==='worker_report' && x.tests);
  h.update(v,{mode:'replay',selection:{kind:'event',id:worker.id}}); assert.ok(!h.find('Passed'));
});

test('an archived failure and a ready_for_review queue feature can be inspected without inventing active work or review',()=>{
  const v = project(fixtures.dense,{now:fixtureTime}); v.attention=[];
  const h=host(),failure=v.records.find(r=>r.kind==='failure'),feature=v.records.find(r=>r.kind==='backlog');
  h.update(v,{selection:failure}); assert.ok(h.find('Unknown. No later recovery receipt is linked.'));
  feature.state='ready_for_review'; h.update(v,{selection:feature});
  assert.ok(h.find('No reviewer assignment, independent verdict or reviewed revision is supplied.'));
});

test("recorded test outcomes, provenance and predecessor come from the captured mark, never a future frame", () => {
  const h = host();
  for (const [index, c] of chapters.entries()) {
    const v = traceFrame(c.i),
      record = v.records.at(-1);
    h.update(v, { mode: "replay", selection: { kind: "event", id: c.id } });
    assert.ok(h.find(record.id));
    assert.ok(h.find(record.state));
    assert.ok(h.find(record.role));
    assert.ok(h.find(trace.viewDigest));
    if (index === 1) assert.ok(h.find("Failed"));
    if (index === 3) {
      assert.ok(h.find("tenant_scope"));
      assert.equal(h.all().filter((n) => n.textContent === "Passed").length, 4);
      h.btn("Inspect causal predecessor").click();
      assert.equal(trace.events[h.seeks.at(-1)].id, record.predecessor);
    }
    if (record.state === "NOT_RUN") {
      assert.ok(!h.find("Passed"));
      assert.ok(!h.btn("Inspect causal predecessor"));
    }
  }
});
