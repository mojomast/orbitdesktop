import test from "node:test";
import assert from "node:assert/strict";
import { traceFrame, chapters, trace } from "../apps/rizzstack-hive/trace.js";
test("scrubbing never reveals a future event or upgrades a worker report", () => {
  for (const [i, e] of trace.events.entries()) {
    const v = traceFrame(i);
    assert.equal(v.records.length, i + 1);
    assert.equal(v.records.at(-1).id, e.id);
    assert.equal(new Set(v.records.map((x) => x.id)).size, i + 1);
    for (const r of v.records)
      if (r.role === "worker_report") assert.notEqual(r.state, "PASS");
  }
  const baseline = traceFrame(chapters[0].i),
    a = traceFrame(chapters[1].i),
    b = traceFrame(chapters[2].i),
    merged = traceFrame(chapters[3].i);
  assert.equal(baseline.records.at(-1).state, "EXPECTED_RED");
  assert.equal(a.records.at(-1).state, "FAIL");
  assert.equal(b.records.at(-1).state, "PASS");
  assert.notEqual(b.records.at(-1).revision, merged.records.at(-1).revision);
  assert.equal(Object.keys(merged.records.at(-1).tests).length, 4);
  assert.equal(traceFrame(chapters[4].i).records.at(-1).state, "NOT_RUN");
  assert.equal(traceFrame(34).records.at(-1).state, "held");
  assert.ok(!b.records.some((r) => r.id === merged.records.at(-1).id));
});
