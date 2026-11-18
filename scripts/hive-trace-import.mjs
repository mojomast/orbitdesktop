// Offline fixture tooling. Reuse the actual Rails view validator and select only
// this public incident. No network, database, credentials or live-read path.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateView } from "../apps/rizzstack-rails/rails.js";
const dir = process.argv[2];
if (!dir) throw Error("Expected the public receipt-replay evidence directory");
const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n)));
const view = read("view.json"),
  index = read("incident.json"),
  receipts = read("receipts.json");
assert.ok(validateView(view).ok);
assert.equal(receipts.synthetic, true);
const events = view.lanes
  .flatMap((l) =>
    l.marks.map((m) => {
      const d = index.details[m.event_id];
      assert.equal(d.lane, l.lane_id);
      return {
        id: m.event_id,
        lane: l.lane_id,
        kind: m.kind,
        time: m.occurred_at,
        outcome: m.outcome,
        refs: m.evidence_refs,
        role: d.role,
        run: d.run,
        title: d.title,
        reason: d.reason,
        attempt: d.attempt ? "attempt-" + d.attempt : null,
        parent: d.predecessor,
        duration: m.duration_ms,
      };
    }),
  )
  .sort(
    (a, b) => Number(a.id.split(":").pop()) - Number(b.id.split(":").pop()),
  );
assert.equal(events.length, 35);
assert.equal(new Set(events.map((x) => x.id)).size, 35);
assert.equal(new Set(events.map((x) => x.id.split(":")[0])).size, 1);
const runs = Object.fromEntries(
  Object.entries(receipts.runs).map(([k, v]) => [
    k,
    { revision: v.revision, tests: v.tests, exit: v.exit },
  ]),
);
const payload = {
  source: "Offline Orbit / R12 read of receipt-replay",
  viewDigest: createHash("sha256")
    .update(fs.readFileSync(path.join(dir, "view.json")))
    .digest("hex"),
  events,
  runs,
  contract: receipts.contract_sha256,
};
fs.writeFileSync(
  new URL("../apps/rizzstack-hive/trace-data.js", import.meta.url),
  "// Generated from the bounded public receipt-replay lab capture. Synthetic orchestration.\nexport const trace=" +
    JSON.stringify(payload) +
    ";\n",
);
