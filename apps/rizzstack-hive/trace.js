import { trace } from "./trace-data.js";
const stations = [
  "auth",
  "dispatch",
  "build",
  "verify",
  "review",
  "integrate",
  "deploy",
  "receiver",
];
const location = {
  dispatch: "dispatch",
  verifier: "verify",
  "A-connection-key": "build",
  "B-receipt-key": "build",
  "C-account-scope": "build",
  "combined-tree": "integrate",
  "windows-check": "verify",
};
const labels = {
  baseline: "Baseline / duplicated credit",
  first: "A / connection key fails after reconnect",
  fixed: "B / receipt key passes on candidate",
  integrated: "Combined tree / four cases pass",
  windows: "Windows / no run receipt",
};
export { trace };
export const chapters = trace.events
  .map((e, i) => ({
    i,
    id: e.id,
    title: labels[e.run] || labels.windows,
    stage: location[e.lane],
  }))
  .filter((x) => trace.events[x.i].kind === "verification.result")
  .map((x) => ({
    ...x,
    title: trace.events[x.i].outcome === "NOT_RUN" ? labels.windows : x.title,
  }));
export function traceFrame(i) {
  if (!Number.isInteger(i) || i < 0 || i >= trace.events.length)
    throw RangeError("Invalid record position");
  const shown = trace.events.slice(0, i + 1),
    latest = shown.at(-1),
    by = new Map(),
    attempts = new Map();
  for (const e of shown) {
    by.set(location[e.lane], e);
    if (e.attempt && e.role !== "verifier_record") {
      const prev = attempts.get(e.attempt);
      attempts.set(e.attempt, {
        id: e.attempt,
        stage: "build",
        state:
          e.kind === "attempt.state" ? e.outcome : (prev?.state ?? "observed"),
        at: e.time,
        source: "Rails / " + e.lane,
        route: null,
        jobId: "receipt-replay",
        taskId: "receipt-accounting",
        quality: "partial",
        repo: null,
      });
    }
  }
  const rows = shown.map((e) => ({
    id: e.id,
    kind: "event",
    stage: location[e.lane],
    title: e.title,
    state: e.outcome || "recorded",
    quality: "partial",
    at: e.time,
    source: e.role,
    jobId: "receipt-replay",
    detail: e.reason || `${e.lane} · ${e.kind}`,
    revision: trace.runs[e.run]?.revision || null,
    refs: e.refs,
    role: e.role,
    run: e.run,
    tests: trace.runs[e.run]?.tests,
    contract: e.kind === "verification.result" ? trace.contract : null,
    predecessor: e.parent,
  }));
  return {
    generatedAt: latest.time,
    health: "recorded · partial",
    sections: [
      {
        id: "captured Rails view",
        state: "partial · integrity unchecked",
        at: latest.time,
      },
    ],
    metrics: { active: null, available: null, eligible: null, cost: null },
    attempts: [...attempts.values()],
    stations: stations.map((id) => {
      const e = by.get(id);
      return {
        id,
        depth: null,
        source: "Rails / receipt-replay",
        signal: e ? e.outcome || e.kind : "No recorded mark",
        quality: e ? "partial" : "unknown",
        level: !e
          ? "unknown"
          : e.outcome === "FAIL" || e.outcome === "failed"
            ? "danger"
            : e.outcome === "NOT_RUN" || e.outcome === "held"
              ? "gate"
              : e.outcome === "PASS"
                ? "verified"
                : "quiet",
      };
    }),
    attention:
      latest.outcome === "NOT_RUN" || latest.outcome === "held"
        ? [
            {
              id: "gap-windows",
              stage: "verify",
              level: "gate",
              title: "Windows receipt missing",
              reason: "This trace contains no Windows run.",
              source: trace.source,
              at: latest.time,
            },
          ]
        : [],
    records: rows,
  };
}
