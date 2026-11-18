import { trace } from "./trace.js";

const stations = new Map([
  [
    "auth",
    ["Authorization", "Which work has permission to enter?", "bottlenecks"],
  ],
  [
    "dispatch",
    ["Dispatch", "Which assignment and lease were recorded?", "bottlenecks"],
  ],
  ["build", ["Build", "Who is working, and on which scope?", "fleet"]],
  [
    "verify",
    [
      "Verification",
      "What did the verifier establish on this revision?",
      "bottlenecks",
    ],
  ],
  [
    "review",
    [
      "Review",
      "Who reviewed the head, and was the review independent?",
      "bottlenecks",
    ],
  ],
  [
    "integrate",
    ["Integration", "What passed on the combined tree?", "bottlenecks"],
  ],
  [
    "deploy",
    [
      "Deployment",
      "Which revision is actually installed and loaded?",
      "bottlenecks",
    ],
  ],
  [
    "receiver",
    ["Owner / receiver", "Which decision belongs to the owner?", "decisions"],
  ],
]);
const stamp = (s) =>
  typeof s === "string" && Number.isFinite(Date.parse(s))
    ? new Date(s)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, " UTC")
    : "Not recorded";
const keyOf = (kind, id) => JSON.stringify([kind, id]);
const label = (r) =>
  r.title && r.title !== r.id ? `${r.title} · ${r.id}` : r.id;
const recorded = (v, { kind, id }) => {
  if (kind === "station") return v.stations.find((x) => x.id === id);
  if (kind === "attempt") return v.attempts.find((x) => x.id === id);
  if (kind === "attention") return v.attention.find((x) => x.id === id);
  return v.records.find((x) => x.id === id && x.kind === kind);
};
// Task identifiers are scoped to a job. Never infer an edge from a stage,
// route, title, provider or a mention in prose. Missing rows are normal.
function linked(v, kind, row) {
  if (kind === "attention")
    return v.records.filter(
      (x) =>
        (x.id === row.id || x.id === row.detail) && x.source === row.source,
    );
  if (!row.jobId) return [];
  const sameJob = (x) => x.jobId === row.jobId;
  const exactTask = (x) => row.taskId && x.taskId === row.taskId;
  const jobs = v.records.filter((x) => x.kind === "job" && sameJob(x));
  const tasks = v.records.filter(
    (x) => x.kind === "task" && sameJob(x) && (kind === "job" || exactTask(x)),
  );
  const attempts = v.attempts
    .filter(
      (x) =>
        sameJob(x) && (kind === "job" || (kind === "task" && exactTask(x))),
    )
    .map((x) => ({ ...x, kind: "attempt" }));
  return [...jobs, ...tasks, ...attempts].filter(
    (x) => !(x.kind === kind && x.id === row.id),
  );
}
function railsTarget(v, kind, row) {
  if (!row) return null;
  const selector =
    kind === "attempt"
      ? ["attempt", row.id]
      : ["job", "task", "backlog", "failure"].includes(kind) &&
          v.records.includes(row)
        ? ["job", row.jobId]
        : null;
  return selector &&
    typeof selector[1] === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(selector[1])
    ? selector
    : null;
}
function sourceSection(v, row) {
  if (typeof row.source !== "string") return;
  return v.sections.find(
    (x) =>
      row.source === `snapshot/1:${x.id}` ||
      row.source.startsWith(`snapshot/1:${x.id}:`),
  );
}
const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};

// Public projection in; local navigation out. Retain the heading, summary and
// keyed navigation buttons while the same object is being examined.
export function createInspector({
  root,
  onChoose,
  onRails,
  onWork,
  onRelease,
  onSeek,
  capabilities,
}) {
  const doc = root.ownerDocument;
  const el = (tag, cls = "", text = "") => {
    const n = doc.createElement(tag);
    n.className = cls;
    n.textContent = text;
    return n;
  };
  let identity, ui, current;
  const buttons = new Map();
  function clear() {
    for (const b of buttons.values()) b.onclick = null;
    buttons.clear();
    identity = ui = current = null;
    root.replaceChildren();
  }
  function mount(key) {
    clear();
    identity = key;
    const kicker = el("small", "kicker"),
      title = el("h2"),
      badge = el("span", "tag"),
      intro = el("p", "detail-text");
    title.id = "inspect-title";
    title.tabIndex = -1;
    title.setAttribute("role", "heading");
    const facts = el("dl", "facts"),
      links = el("div", "inspect-links"),
      details = el("details", "authority"),
      actions = el("div");
    details.append(el("summary", "", "Controls & authority"), actions);
    root.append(kicker, title, badge, intro, facts, links, details);
    ui = { kicker, title, badge, intro, facts, links, actions };
  }
  function facts(rows) {
    // No interactive descendants here. Keep unchanged text selectable, too.
    const sig = JSON.stringify(rows);
    if (ui.factSig === sig) return;
    ui.factSig = sig;
    ui.facts.replaceChildren(
      ...rows.map(([k, v]) => {
        const pair = el("div");
        pair.append(
          el("dt", "", k),
          el("dd", "", v == null || v === "" ? "Unknown" : String(v)),
        );
        return pair;
      }),
    );
  }
  function navigation(items) {
    const focused = doc.activeElement,
      hadFocus = ui.links.contains(focused),
      wanted = new Set(items.map((x) => x.key));
    for (const [key, b] of buttons)
      if (!wanted.has(key)) {
        b.onclick = null;
        b.remove();
        buttons.delete(key);
      }
    items.forEach(({ key, text, run, cls = "choice" }, i) => {
      let b = buttons.get(key);
      if (!b) {
        b = el("button", cls);
        b.type = "button";
        buttons.set(key, b);
      }
      setText(b, text);
      b.onclick = run ?? null;
      b.disabled = !run;
      if (ui.links.children[i] !== b)
        ui.links.insertBefore(b, ui.links.children[i] ?? null);
    });
    if (hadFocus && (!ui.links.contains(focused) || focused.disabled))
      ui.title.focus({ preventScroll: true });
    else if (hadFocus && doc.activeElement !== focused)
      focused.focus({ preventScroll: true });
  }
  function authority(caps) {
    const sig = JSON.stringify(caps);
    if (ui.capSig === sig) return;
    ui.capSig = sig;
    // Even a future provider description cannot register a command handler.
    const nodes = [
      el(
        "p",
        "unavailable",
        "Read-only inspection. Owner actions cannot be submitted here.",
      ),
    ];
    for (const { label, available, reason, next } of caps) {
      const b = el("button", "act", label);
      b.type = "button";
      b.disabled = true;
      nodes.push(
        b,
        el(
          "p",
          "unavailable",
          [available ? "Outside this surface." : "Unavailable.", reason, next]
            .filter(Boolean)
            .join(" "),
        ),
      );
    }
    ui.actions.replaceChildren(...nodes);
  }

  function update(
    v,
    { selection, mode, status, railsAvailable, canBack, onBack },
  ) {
    if (!selection || !v || status === "unauthorized") {
      clear();
      return;
    }
    const { kind, id } = selection,
      key = keyOf(kind, id);
    if (key !== identity) mount(key);
    const row = recorded(v, selection),
      isStation = kind === "station",
      stage = isStation ? id : row?.stage;
    const station = stations.get(stage),
      stageName = station?.[0];
    const connected =
      mode === "host" && status === "connected" && railsAvailable === true;
    const ctx = {
      view: v,
      selection,
      kind,
      stage,
      record: row,
      mode,
      status,
      railsAvailable,
      connected,
    };
    const caps = capabilities?.(ctx) ?? [];
    current = ctx;
    const section =
      row &&
      (isStation
        ? v.sections.find((x) => x.id === station?.[2])
        : sourceSection(v, row));
    const items = [],
      rows = [];
    const pick = (kind, id, text) =>
      items.push({
        key: keyOf(kind, id),
        text,
        run: onChoose && (() => onChoose({ kind, id }, true)),
      });
    const title = isStation ? stageName : kind === "attempt" ? id : row?.title;
    setText(ui.title, title || id);
    setText(
      ui.kicker,
      isStation ? "STATION PROFILE" : `${kind.toUpperCase()} RECORD`,
    );
    setText(
      ui.badge,
      isStation
        ? row?.quality || "unknown"
        : row?.state || row?.level || "unknown",
    );
    ui.badge.className =
      "tag" +
      (["active", "delay", "danger", "gate"].includes(row?.level)
        ? " " + row.level
        : "");
    const interrupted =
      mode === "host" && status !== "connected" && v.generatedAt;
    if (interrupted)
      rows.push([
        "Read status",
        `${status} · last confirmed at ${stamp(v.generatedAt)}`,
      ]);

    if (!row) {
      setText(
        ui.intro,
        "This object has no record in the current view. Return to Work to choose an observed object.",
      );
      rows.push(["Public ID", id]);
    } else if (isStation) {
      setText(ui.intro, station?.[1] || "What does this station report?");
      rows.push(
        ["Observation", row.signal],
        ["Queue depth", row.depth],
        ["Station ID", id],
        ["Evidence basis", row.source || section?.id],
        ["Source time", stamp(section?.at ?? v.generatedAt)],
      );
      const evidence = v.records.filter(
        (x) => x.stage === id && x.kind === "bottleneck",
      );
      for (const x of evidence)
        pick(x.kind, x.id, "Inspect pressure record · " + label(x));
      const index = [
        ...v.attempts
          .filter((x) => x.stage === id)
          .map((x) => ({ ...x, kind: "attempt" })),
        ...v.records.filter((x) => x.stage === id && x.kind !== "bottleneck"),
      ];
      for (const x of index.slice(0, 3))
        pick(x.kind, x.id, "Stage index · " + label(x));
      if (id === "deploy" && onRelease)
        items.push({
          key: "release",
          text: "Inspect release record ↗",
          run: onRelease,
        });
    } else {
      const relations = linked(v, kind, row);
      const task = relations.find((x) => x.kind === "task");
      setText(
        ui.intro,
        kind === "attempt"
          ? `${row.detail || task?.title || row.title || "Worker attempt"} · ${row.route || "route not recorded"}. The attempt is source-observed; its dispatch binding is unproven.`
          : [row.reason, row.detail].filter(Boolean).join(" ") ||
              "No additional evidence supplied.",
      );
      rows.push(
        [kind === "event" ? "Origin ID" : "Public ID", id],
        ["Stage", stageName],
        ["Source", row.source],
        ["Observed at", stamp(row.at)],
      );
      if (row.quality || section)
        rows.push(["Source quality", row.quality || section.state]);
      if (kind === "attempt")
        rows.push(
          ["Route", row.route],
          ["Job", row.jobId],
          ["Task", row.taskId],
          ["Repository", row.repo],
          ["Dispatch binding", "Unproven"],
        );
      else {
        if (row.jobId) rows.push(["Job", row.jobId]);
        if (row.taskId) rows.push(["Task", row.taskId]);
      }
      if (typeof row.costUsd === "number")
        rows.push(["Reported cost (USD)", row.costUsd]);
      if (kind === "usage" && id === "usage:totals") {
        if (typeof v.metrics.cost === "number")
          rows.push(["Known subtotal (USD)", v.metrics.cost]);
        if (v.metrics.costCoverage)
          rows.push(["Cost coverage", v.metrics.costCoverage]);
      }
      if (kind === "event" && mode === "replay") {
        const origin = trace.events.find((x) => x.id === id);
        if (origin) {
          rows.push(
            ["Authority", row.role],
            ["Occurred at", stamp(row.at)],
            ["Code revision", row.revision],
            ["Contract", row.contract],
            ["Evidence", row.refs?.join(" · ")],
            ["Run", row.run],
            ["Capture", trace.source],
            ["View digest", trace.viewDigest],
          );
          // The Windows mark references the integrated run; its passing cases
          // are NOT Windows results. The capture contains no Windows receipt.
          if (row.state === "NOT_RUN")
            rows.push(["Platform evidence", "No Windows run receipt"]);
          else if (row.tests)
            for (const [name, result] of Object.entries(row.tests)) {
              rows.push([
                name.replace(/^test_/, ""),
                result === 0 ? "Passed" : "Failed",
              ]);
            }
          const parent =
            row.predecessor &&
            row.predecessor === origin.parent &&
            v.records.find((x) => x.kind === "event" && x.id === origin.parent);
          if (parent && onSeek) {
            const at = trace.events.findIndex((x) => x.id === parent.id);
            if (at >= 0) {
              rows.push(["Causal predecessor", parent.id]);
              items.push({
                key: "predecessor",
                text: "← Inspect causal predecessor",
                run: () => onSeek(at),
              });
            }
          }
        }
      }
      if (["job", "attempt", "task"].includes(kind) && !relations.length)
        rows.push(["Related records", "No verified link in this view"]);
      for (const x of relations.slice(0, 8))
        pick(
          x.kind,
          x.id,
          `${kind === "attention" ? "Inspect evidence" : "Related " + x.kind} · ${label(x)}`,
        );
      if (relations.length > 8)
        rows.push([
          "Related index",
          `8 of ${relations.length} shown · see Work for the full index`,
        ]);

      const target = railsTarget(v, kind, row);
      if (target) {
        const live =
          section?.state === "live" &&
          (kind !== "attempt" || row.quality === "live") &&
          !/^last observed:/i.test(row.state);
        const nav = caps.find(
          (x) => x.kind === "navigation" && x.id === "open_rails",
        );
        const enabled =
          connected &&
          live &&
          !!onRails &&
          (!nav ||
            (nav.available &&
              nav.target?.kind === target[0] &&
              nav.target.id === target[1]));
        items.unshift({
          key: "rails",
          text: "Open Rails timeline ↗",
          cls: "act",
          run: enabled
            ? () => {
                if (current === ctx) onRails(...target);
              }
            : null,
        });
        if (!enabled)
          rows.push([
            "Rails reader",
            mode !== "host"
              ? "Host connection required; fixture IDs do not authorize a lookup."
              : !live
                ? "No current source record for this lookup."
                : "A connected, granted reader is required.",
          ]);
      }
      if (stageName && v.stations.some((x) => x.id === stage))
        pick("station", stage, `← ${stageName} station`);
    }
    if (canBack && onBack)
      items.push({
        key: "back",
        text: "← Back to previous object / Work",
        run: onBack,
      });
    else if (onWork)
      items.push({
        key: "work",
        text: "Browse work register ↗",
        run: () => onWork(),
      });
    facts(rows);
    navigation(items);
    authority(caps.filter((x) => x.kind !== "navigation"));
  }
  return { update, clear };
}
