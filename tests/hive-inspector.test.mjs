import test from "node:test";
import assert from "node:assert/strict";
import { createInspector } from "../apps/rizzstack-hive/inspector.js";
import { chapters, trace, traceFrame } from "../apps/rizzstack-hive/trace.js";
import { controlsFor } from "../apps/rizzstack-hive/operations.js";

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
  assert.ok(h.find("<img src=x>"));
  assert.ok(h.btn("Retry attempt").disabled);
  assert.ok(h.all().some((n) => n.textContent.includes("Check the fence.")));
  h.update(v, { selection: { kind: "station", id: "verify" } });
  assert.deepEqual(
    h
      .node("dl")
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
