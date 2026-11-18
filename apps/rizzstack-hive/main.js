import { createStore } from "./store.js";
import { createScene } from "./scene.js";
import { connectHost } from "./host-client.js";
import { release } from "./release.js";
import { trace, traceFrame, chapters } from "./trace.js";
import { confirmedChanges } from "./transitions.js";

const NAMES = {
  auth: "Authorization",
  dispatch: "Dispatch",
  build: "Build",
  verify: "Verification",
  review: "Review",
  integrate: "Integration",
  deploy: "Deployment",
  receiver: "Owner / receiver",
};
const notes = {
  auth: "Which work has permission to enter?",
  dispatch: "Which assignment and lease were recorded?",
  build: "Who is working, and on which scope?",
  verify: "What did the verifier establish on this revision?",
  review: "Who reviewed the head, and was the review independent?",
  integrate: "What passed on the combined tree?",
  deploy: "Which revision is actually installed and loaded?",
  receiver: "Which decision belongs to the owner?",
};
const ids = Object.keys(NAMES),
  $ = (id) => document.getElementById(id),
  el = (tag, c, text) => {
    const n = document.createElement(tag);
    if (c) n.className = c;
    if (text != null) n.textContent = text;
    return n;
  };
const fmt = (x) =>
    x == null
      ? "Unknown"
      : typeof x === "number"
        ? x.toLocaleString("en-US")
        : String(x),
  stamp = (x) =>
    typeof x === "string" && Number.isFinite(Date.parse(x))
      ? new Date(x)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d+Z$/, " UTC")
      : "Not recorded";
const btn = (label, cls, fn) => {
    const b = el("button", cls, label);
    b.type = "button";
    b.onclick = fn;
    return b;
  },
  set = (id, t) => {
    if ($(id).textContent !== t) $(id).textContent = t;
  },
  tag = (s, l) =>
    el(
      "span",
      "tag " + (["active", "delay", "danger", "gate"].includes(l) ? l : ""),
      s,
    );
const empty = () => ({
  generatedAt: null,
  health: "unknown",
  metrics: {},
  sections: [],
  attempts: [],
  attention: [],
  records: [],
  stations: ids.map((id) => ({
    id,
    signal: "No source observation",
    quality: "unknown",
    level: "unknown",
    depth: null,
  })),
});
const store = createStore(),
  mobile = matchMedia("(max-width:720px)"),
  reduce = matchMedia("(prefers-reduced-motion:reduce)");
let mode = "host",
  nav = "floor",
  host = null,
  generation = 0,
  limit = 36,
  readEpoch = 0,
  layoutFrame = 0,
  focusReturn = null,
  demoFixture = null,
  inspectedKey = "",
  renderedData = "",
  renderedWork = "",
  renderedSource = "";
const scene = createScene($("world"), { onSelect: choose });
let continuous = false,
  changedIds = null;
const callout = el("button", "first-signal");
callout.id = "first-signal";
callout.type = "button";
callout.hidden = true;
$("floor").prepend(callout);
const SOURCE_MAP = {
  auth: "bottlenecks",
  dispatch: "bottlenecks",
  build: "fleet",
  verify: "bottlenecks",
  review: "bottlenecks",
  integrate: "bottlenecks",
  deploy: "bottlenecks",
  receiver: "decisions",
};
// Revocation must also remove detached-from-view DOM and controller references.
function clearPrivate() {
  focusReturn = null;
  inspectedKey = "";
  renderedData = "";
  renderedWork = "";
  renderedSource = "";
  $("rows").replaceChildren();
  $("attention").replaceChildren();
  $("inspection-body").replaceChildren();
  $("sources").replaceChildren();
  $("search").value = "";
  $("scope").value = "all";
  $("lead").textContent = "";
  $("announcement").textContent = "";
  callout.replaceChildren();
  delete callout.dataset.for;
  callout.onclick = null;
  callout.hidden = true;
  scene.update(empty(), store.current.selection, { motion: false });
  textBoard(empty());
}
let tracePos = 0,
  playTimer = 0;
const traceOption = new Option("Replay · Duplicate receipt", "replay");
$("scenario").append(traceOption);
const player = el("section", "recorder"),
  playTitle = el("strong", "", "Incident recorder"),
  readout = el("output", ""),
  range = el("input"),
  chapterList = el("div", "chapter-list");
player.hidden = true;
player.setAttribute("aria-label", "Recorded incident timeline");
range.type = "range";
range.min = 0;
range.max = String(trace.events.length - 1);
range.setAttribute("aria-label", "Recorded event position");
function seek(pos, automatic = false) {
  if (mode !== "replay") return;
  if (!automatic) pauseRecording();
  tracePos = Math.max(0, Math.min(trace.events.length - 1, pos));
  let v = traceFrame(tracePos);
  store.reset();
  store.hydrate(v);
  const event = trace.events[tracePos];
  store.select("event", event.id);
  range.value = String(tracePos);
  readout.textContent = `${String(tracePos + 1).padStart(2, "0")} / ${trace.events.length} · ${event.time.slice(11, 19)} UTC`;
  const mark = v.records.at(-1);
  locator.textContent = `${NAMES[mark.stage]} / ${event.title}`;
  for (const [i, b] of [...chapterList.children].entries()) {
    if (tracePos === chapters[i].i) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  }
  renderedData = "";
  render();
  say("Recorded event: " + event.title);
}
range.oninput = () => seek(Number(range.value));
for (const c of chapters) {
  const b = btn(c.title, "chapter", () => seek(c.i));
  chapterList.append(b);
}
const railBar = el("div", "rail-bar");
railBar.append(
  playTitle,
  btn("←", "edition-btn", () => seek(tracePos - 1)),
  range,
  btn("→", "edition-btn", () => seek(tracePos + 1)),
  readout,
);
railBar.children[1].setAttribute("aria-label", "Previous recorded event");
railBar.children[3].setAttribute("aria-label", "Next recorded event");
const locator = el("span", "event-locator"),
  playToggle = btn("Play recording", "edition-btn", () => {
    if (playTimer) {
      pauseRecording();
      return;
    }
    if (tracePos === trace.events.length - 1) seek(0);
    playToggle.textContent = "Pause recording";
    playToggle.setAttribute("aria-pressed", "true");
    playTimer = setInterval(() => {
      if (
        document.hidden ||
        nav !== "floor" ||
        mode !== "replay" ||
        tracePos === trace.events.length - 1
      ) {
        pauseRecording();
        return;
      }
      seek(tracePos + 1, true);
    }, 1600);
  });
function pauseRecording() {
  clearInterval(playTimer);
  playTimer = 0;
  playToggle.textContent = "Play recording";
  playToggle.setAttribute("aria-pressed", "false");
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseRecording();
});
railBar.append(playToggle);
player.append(railBar, locator, chapterList);
$("floor").prepend(player);
function say(msg) {
  set("announcement", msg);
}
function go(to, focus = false) {
  pauseRecording();
  nav = to;
  for (const key of ["floor", "work", "release"]) $(key).hidden = to !== key;
  for (const n of document.querySelectorAll(".mastnav button")) {
    if (n.dataset.nav === to) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  }
  const title = {
    floor: "Factory floor",
    work: "Work register",
    release: "Release desk",
  }[nav];
  $("surface-title").replaceChildren(
    document.createTextNode(title),
    el("span", "", "."),
  );
  if (focus) $(to).focus({ preventScroll: true });
  render();
}
function choose(sel, bring = false) {
  if (!sel || typeof sel.id !== "string") return;
  pauseRecording();
  store.select(sel.kind, sel.id);
  if (nav !== "floor") go("floor");
  else render();
  say("Inspecting " + (NAMES[sel.id] || sel.id));
  if (bring || mobile.matches) {
    $("inspector").scrollIntoView({ block: "nearest" });
    $("inspect-title")?.focus({ preventScroll: true });
  }
}
function dl(rows) {
  const list = el("dl", "facts");
  for (const [k, v] of rows) {
    const line = el("div");
    line.append(el("dt", "", k), el("dd", "", fmt(v)));
    list.append(line);
  }
  return list;
}
function safeSource(x) {
  return typeof x === "string" ? x : "Not recorded";
}
function openRails(kind, id) {
  if (mode !== "host" || !host || !["attempt", "job"].includes(kind)) return;
  focusReturn = document.activeElement;
  host.openRails(kind, id);
}
function authorityBox(target) {
  const dd = el("details", "authority"),
    summary = el("summary", "", "Controls & authority");
  dd.append(
    summary,
    el(
      "p",
      "unavailable",
      "Read-only scope. No revision-bound owner action provider is registered for this surface.",
    ),
  );
  const disabled = btn(
    target === "receiver"
      ? "Submit decision unavailable"
      : target === "deploy"
        ? "Deploy unavailable"
        : "Retry unavailable",
    "act",
    () => {},
  );
  disabled.disabled = true;
  dd.append(disabled);
  return dd;
}
function workRows(v) {
  return [
    ...v.attempts.map((x) => ({
      ...x,
      kind: "attempt",
      title: x.id,
      detail: x.route,
    })),
    ...v.records,
  ];
}
function inspect(v) {
  const sel = store.current.selection,
    s = v.stations.find((x) => x.id === sel.id),
    r =
      sel.kind === "station"
        ? s
        : sel.kind === "attempt"
          ? v.attempts.find((x) => x.id === sel.id)
          : sel.kind === "attention"
            ? v.attention.find((x) => x.id === sel.id)
            : v.records.find((x) => x.kind === sel.kind && x.id === sel.id);
  const key = JSON.stringify([
    sel,
    r,
    mode,
    store.current.status,
    sel.kind === "station"
      ? v.attempts
          .filter((x) => x.stage === sel.id)
          .map((x) => x.id)
          .slice(0, 6)
      : null,
    v.generatedAt,
  ]);
  if (key === inspectedKey) return;
  inspectedKey = key;
  const body = $("inspection-body");
  const stage = sel.kind === "station" ? sel.id : r?.stage,
    n = ids.indexOf(stage);
  set("sel-plate", n < 0 ? "OBJECT" : `${String(n + 1).padStart(2, "0")} / 08`);
  const title = el(
    "h2",
    "",
    sel.kind === "station" ? NAMES[sel.id] : r?.title || sel.id,
  );
  title.id = "inspect-title";
  title.tabIndex = -1;
  body.replaceChildren(
    el(
      "small",
      "kicker",
      sel.kind === "station"
        ? "STATION PROFILE"
        : (sel.kind + " RECORD").toUpperCase(),
    ),
    title,
  );
  if (!r) {
    body.append(
      el(
        "p",
        "detail-text",
        "No current source record for this selection. Refresh or choose another object.",
      ),
      authorityBox(stage),
    );
    return;
  }
  const signal = r.signal ?? r.state ?? r.reason ?? r.quality ?? "Unknown";
  body.append(
    tag(
      sel.kind === "station"
        ? r.quality || "unknown"
        : r.state || r.level || r.quality || "observation",
      r.level,
    ),
    el(
      "p",
      "detail-text",
      sel.kind === "station"
        ? notes[stage]
        : r.reason || r.detail || "An observation of this object was recorded.",
    ),
  );
  if (sel.kind === "event") {
    body.append(
      dl([
        ["Origin ID", r.id],
        ["Authority", r.role],
        ["Occurred at", stamp(r.at)],
        ["Code revision", r.revision],
        ["Contract", r.contract],
        ["Evidence", (r.refs || []).join(" · ") || null],
        ["Run", r.run],
      ]),
    );
    if (r.tests)
      body.append(
        dl(
          Object.entries(r.tests).map(([k, x]) => [
            k.replace(/^test_/, ""),
            x === 0 ? "Passed" : "Failed",
          ]),
        ),
      );
    if (r.predecessor) {
      const at = trace.events.findIndex((e) => e.id === r.predecessor);
      if (at >= 0)
        body.append(
          btn("← Inspect causal predecessor", "choice", () => seek(at)),
        );
    }
  } else if (sel.kind === "station") {
    const section = v.sections.find((x) => x.id === SOURCE_MAP[stage]);
    body.append(
      dl([
        ["Observed", signal],
        ["Queue depth", r.depth],
        ["Evidence basis", r.source || section?.id || "Unknown"],
        ["Source time", stamp(section?.at ?? v.generatedAt)],
      ]),
    );
    const related = [
      ...v.attempts
        .filter((x) => x.stage === stage)
        .map((x) => ({ kind: "attempt", id: x.id, label: x.id })),
      ...v.records
        .filter((x) => x.stage === stage)
        .map((x) => ({ kind: x.kind, id: x.id, label: x.title || x.id })),
    ];
    for (const x of related.slice(0, 3))
      body.append(btn("↳ " + x.label, "choice", () => choose(x)));
    if (related.length > 3)
      body.append(
        btn("Browse work register ↗", "choice", () => go("work", true)),
      );
    if (stage === "deploy")
      body.append(
        btn("Inspect release record ↗", "choice", () => go("release", true)),
      );
  } else {
    const rows = [
      ["Observation", r.state ?? r.level ?? "unknown"],
      ["Public ID", r.id],
      ["Source", safeSource(r.source)],
      ["Observed at", stamp(r.at)],
    ];
    if (sel.kind === "attempt")
      rows.push(
        ["Route", r.route],
        ["Job", r.jobId],
        ["Task", r.taskId],
        ["Repository", r.repo],
        ["Dispatch binding", "Unproven"],
      );
    body.append(dl(rows));
    const kind = sel.kind === "attempt" ? "attempt" : r.jobId ? "job" : null,
      id = kind === "attempt" ? r.id : r.jobId;
    if (kind) {
      const enabled =
        mode === "host" && store.current.status === "connected" && !!host;
      const b = btn(
        enabled
          ? "Open Rails timeline ↗"
          : "Rails · " +
              (mode === "host"
                ? "reader unavailable"
                : "host connection required"),
        "act",
        () => openRails(kind, id),
      );
      b.disabled = !enabled;
      body.append(b);
      if (mode !== "host")
        body.append(
          el(
            "p",
            "unavailable",
            "Demo identifiers do not authorize a live Rails lookup.",
          ),
        );
    }
    if (stage && NAMES[stage])
      body.append(
        btn("← " + NAMES[stage] + " station", "choice", () =>
          choose({ kind: "station", id: stage }),
        ),
      );
  }
  body.append(authorityBox(stage));
}
function keyed(root, items, make) {
  const by = new Map([...root.children].map((n) => [n.dataset.key, n]));
  const seen = new Set();
  let i = 0;
  for (const d of items) {
    const key = d.key;
    if (seen.has(key)) continue;
    seen.add(key);
    let node = by.get(key);
    const sig = JSON.stringify(d);
    if (!node || node.dataset.sig !== sig) {
      const next = make(d),
        focused = node === document.activeElement;
      next.dataset.key = key;
      next.dataset.sig = sig;
      if (node) {
        node.replaceWith(next);
        if (focused) next.focus({ preventScroll: true });
      }
      node = next;
    }
    if (root.children[i] !== node)
      root.insertBefore(node, root.children[i] || null);
    i++;
  }
  for (const [k, n] of by) if (!seen.has(k)) n.remove();
}
function textBoard(v) {
  keyed(
    $("stations"),
    v.stations.map((x) => ({ ...x, key: x.id })),
    (d) => {
      const b = btn("", "st-row", () =>
        choose({ kind: "station", id: d.id }, true),
      );
      b.append(
        el("strong", "", NAMES[d.id]),
        el("small", "", d.signal || "Unknown"),
      );
      return b;
    },
  );
}
function issues(v) {
  const items = v.attention.slice(0, 10);
  set("attention-count", `${v.attention.length} OBSERVED`);
  keyed(
    $("attention"),
    items.length
      ? items.map((x) => ({ ...x, key: x.id }))
      : [
          {
            key: ":empty",
            title: store.current.view
              ? "No items in the available observations. Check source coverage."
              : "No authorized source observation.",
          },
        ],
    (d) => {
      if (d.key === ":empty") return el("p", "empty", d.title);
      const b = btn("", "issue", () =>
          choose({ kind: "attention", id: d.id }, true),
        ),
        box = el("span");
      box.append(el("strong", "", d.title), el("small", "", d.reason));
      b.append(tag(d.level || "signal", d.level), box, el("em", "", "↗"));
      return b;
    },
  );
}
function register(v) {
  const search = $("search").value.trim().toLowerCase(),
    scope = $("scope").value,
    all = workRows(v),
    results = all.filter(
      (x) =>
        (scope === "all" || x.kind === scope) &&
        (!search ||
          [
            x.title,
            x.id,
            x.jobId,
            x.taskId,
            x.route,
            x.repo,
            x.detail,
            x.source,
            x.state,
          ].some(
            (t) => typeof t === "string" && t.toLowerCase().includes(search),
          )),
    );
  const shown = results.slice(0, limit);
  set(
    "result-count",
    `${shown.length} SHOWN / ${results.length} MATCHING / ${all.length} AVAILABLE`,
  );
  $("more").hidden = shown.length === results.length;
  keyed(
    $("rows"),
    shown.map((x) => ({ ...x, key: x.kind + ":" + x.id })),
    (d) => {
      const b = btn("", "obj", () => choose(d, true)),
        c = el("span");
      c.append(
        el("strong", "", d.title || d.id),
        el(
          "small",
          "",
          `${d.kind} / ${d.detail || d.route || d.source || "source unknown"}`,
        ),
      );
      b.append(c, tag(d.state || "unknown", ""));
      return b;
    },
  );
}
function releaseDesk() {
  const body = el("div", "release-body");
  const title = el(
    "h2",
    "",
    "Software qualified · release " + release.decision,
  );
  body.append(
    el("small", "kicker", "HISTORICAL QUALIFICATION / WORKFLOW #92"),
    title,
    el(
      "p",
      "detail-text",
      "Software checks, a deployment, and a human receiver decision are different observations. This retained release packet supplies only the first.",
    ),
    dl([
      ["Recorded", stamp(release.at)],
      ["Required cases", release.tests],
      ["Component checks", release.checks],
      ["Live Windows canary", release.canary],
      ["Receiver", release.receiver],
      ["Installed / loaded", "Unknown / unknown"],
      ["HTTP events p95 / default", release.defaultEventsMs + " ms"],
      [
        "Indexed / independent repeat",
        `${release.indexedEventsMs} / ${release.priorIndexedEventsMs} ms`,
      ],
      ...Object.entries(release.tuple || {}),
    ]),
  );
  const a = el("a", "", "Read qualification evidence ↗");
  a.href = release.evidenceUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  body.append(a, authorityBox("deploy"));
  const provenance = el("details", "authority");
  provenance.append(
    el("summary", "", "Qualification notes & original RETURN digest"),
  );
  const list = el("ul");
  for (const note of release.notes) list.append(el("li", "", note));
  provenance.append(list);
  body.append(provenance);
  $("release").replaceChildren(body);
}
function render() {
  const { view, status, selection } = store.current,
    v = view || empty(),
    m = v.metrics,
    demo = mode !== "host",
    signal = v.attention[0];
  const held =
    ["disconnected", "unavailable", "loading", "conflict"].includes(status) &&
    view;
  set(
    "lead",
    nav === "release"
      ? "Inspect the recorded tuple, performance evidence and open gates."
      : nav === "work"
        ? "Find a public object, then follow its evidence to the floor."
        : signal
          ? `${signal.title} — ${signal.reason || "inspect the evidence below."}`
          : "Read the line from authorization to receipt.",
  );
  set("flight", fmt(m.active));
  set("slots", fmt(m.available));
  set("eligible", fmt(m.eligible));
  set(
    "cost",
    typeof m.cost === "number"
      ? "$" + m.cost.toLocaleString("en-US", { maximumFractionDigits: 4 })
      : "Unknown",
  );
  set(
    "cost-label",
    m.costCoverage == null ? "cost coverage unknown" : String(m.costCoverage),
  );
  set("release-state", release.decision || "Unknown");
  set(
    "source-caption",
    demo
      ? "SYNTHETIC SHIFT · NO LIVE ACTIONS"
      : status === "connected" && view
        ? "HOST READ GRANTED · READ ONLY"
        : "HOST READ NOT CONFIRMED",
  );
  set(
    "connection",
    `${demo ? "DEMO" : "HOST"} / ${held ? "LAST CONFIRMED · " : ""}${status === "connected" ? v.health || "observed" : status} · ${stamp(v.generatedAt)}`,
  );
  set("atlas-count", `${v.attempts.length} ATTEMPT RECORDS`);
  $("world").classList.toggle("historical", Boolean(held));
  $("slots").nextElementSibling.textContent =
    m.capacity == null || held
      ? "scheduler slots free"
      : `free of ${fmt(m.capacity)} scheduler slots`;
  const degraded =
    !!held ||
    ["unavailable", "unauthorized", "conflict", "disconnected"].includes(
      status,
    );
  if (held) {
    set("flight", "Unknown");
    set("slots", "Unknown");
    set("eligible", "Unknown");
    set(
      "lead",
      "Source interrupted. The floor shows the last confirmed observation.",
    );
  }
  if (status === "conflict")
    set(
      "lead",
      `Conflicting projections for ${stamp(v.generatedAt)}. The prior confirmed observation is retained; refresh for a newer collector read.`,
    );
  if (typeof m.cost === "number")
    set(
      "cost-label",
      "known subtotal · " + (m.costCoverage || "coverage unknown"),
    );
  const priority = signal && !held && mode !== "replay";
  callout.hidden = !priority;
  if (priority) {
    const key = [mode, signal.id, signal.title, signal.level].join("|");
    if (callout.dataset.for !== key) {
      callout.dataset.for = key;
      callout.replaceChildren(
        el("small", "", "PRIORITY SIGNAL"),
        el("strong", "", signal.title),
        el("span", "", "Inspect evidence ↗"),
      );
    }
    callout.onclick = () => choose({ kind: "attention", id: signal.id }, true);
  }
  if (demo && mode !== "replay" && signal && !degraded)
    set(
      "lead",
      `Shift observation · ${fmt(m.active)} in flight · ${v.attention.length} attention signals.`,
    );
  player.hidden = mode !== "replay";
  if (mode === "replay") {
    set("source-caption", "RECORDED FIXTURE · NO LIVE ACTIONS");
    set(
      "lead",
      "Trace a duplicate receipt from a failing test to a verified fix.",
    );
  }
  const ds = JSON.stringify([v.sections, status]);
  if (ds !== renderedSource) {
    renderedSource = ds;
    $("sources").replaceChildren(
      ...(v.sections.length
        ? v.sections.map((x) =>
            el("span", "", `${x.id} · ${x.state} · ${stamp(x.at)}`),
          )
        : [el("span", "", "Source coverage unknown.")]),
    );
  }
  if (nav === "floor") {
    const position =
      mode === "replay" && selection.kind === "event"
        ? v.records.find((r) => r.id === selection.id)?.stage
        : null;
    scene.update(v, position ? { kind: "station", id: position } : selection, {
      motion: !$("static").checked && !reduce.matches,
      changedIds,
    });
    inspect(v);
    if (renderedData !== v) {
      textBoard(v);
      issues(v);
      renderedData = v;
    }
  }
  changedIds = null;
  if (nav === "work") {
    register(v);
    drawQueue();
    renderedWork = v;
  }
  set(
    "edition",
    nav === "floor"
      ? "PLATE 01—08"
      : nav === "work"
        ? "OBJECT INDEX"
        : "RELEASE DOSSIER",
  );
}
let queueMode = null;
const queuePanel = el("section", "queue-panel");
$("work").append(queuePanel);
async function drawQueue() {
  const demo = mode === "shift" || mode === "dense";
  if (queueMode === demo) return;
  queueMode = demo;
  queuePanel.replaceChildren();
  try {
    const { renderQueueDesk } = await import("./queue-desk.js");
    if (queueMode === demo) renderQueueDesk(queuePanel, { demo });
  } catch {
    if (queueMode === demo)
      queuePanel.append(
        el("p", "empty", "Queue reconciliation projection unavailable."),
      );
  }
}
function schedule() {
  if (!layoutFrame)
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      render();
    });
}
async function setMode(key) {
  pauseRecording();
  host?.close();
  host = null;
  demoFixture = null;
  continuous = false;
  changedIds = null;
  mode = key;
  const gen = ++generation;
  readEpoch++;
  store.reset();
  clearPrivate();
  $("scenario").value = key;
  render();
  if (key === "host") {
    host = connectHost({
      onView(v) {
        if (gen !== generation) return;
        const prev = store.current.view,
          state = store.hydrate(v);
        if (state === "invalid") store.transport("unavailable");
        if (state === "new")
          changedIds = confirmedChanges(
            prev,
            v,
            continuous && !document.hidden,
          );
        continuous = ["new", "duplicate"].includes(state);
        schedule();
      },
      onStatus(s) {
        if (gen !== generation) return;
        store.transport(s);
        if (["unauthorized", "unavailable", "disconnected"].includes(s))
          continuous = false;
        if (s === "unauthorized") clearPrivate();
        schedule();
      },
      onReturnFocus() {
        if (focusReturn?.isConnected) focusReturn.focus();
        else $("inspect-title")?.focus();
      },
    });
    return;
  }
  if (key === "replay") {
    seek(chapters[1].i);
    return;
  }
  try {
    const [{ fixtures, fixtureTime }, { project }] = await Promise.all([
      import("./fixtures.js"),
      import("./snapshot-adapter.js"),
    ]);
    if (gen !== generation) return;
    demoFixture = project(fixtures[key], { now: fixtureTime });
    if (store.hydrate(demoFixture) === "invalid") throw Error();
    render();
  } catch {
    if (gen === generation) {
      store.transport("unavailable");
      render();
    }
  }
}
document
  .querySelectorAll("[data-nav]")
  .forEach((n) => (n.onclick = () => go(n.dataset.nav, true)));
$("prefs").onclick = () => {
  const open = $("preferences").hidden;
  $("preferences").hidden = !open;
  $("prefs").setAttribute("aria-expanded", open);
};
$("static").onchange = () => {
  document.documentElement.classList.toggle("still", $("static").checked);
  render();
};
$("contrast").onchange = () =>
  document.documentElement.classList.toggle("high", $("contrast").checked);
$("source-info").onclick = () => {
  const open = $("sources").hidden;
  $("sources").hidden = !open;
  $("source-info").setAttribute("aria-expanded", open);
};
$("scenario").onchange = (e) => setMode(e.target.value);
$("refresh").onclick = () => {
  if (mode === "host") host?.refresh();
  else if (demoFixture) {
    store.hydrate(demoFixture);
    say("Demo snapshot re-read.");
  }
  render();
};
$("focus-b").onclick = () => {
  const list = store.current.view?.stations || [];
  const found =
    list.find((s) => s.level === "delay") ||
    list
      .filter((s) => Number.isFinite(s.depth) && s.depth > 0)
      .sort((a, b) => b.depth - a.depth)[0];
  if (found) choose({ kind: "station", id: found.id }, true);
  else {
    const msg =
      "Pressure unknown: no measured queue or delay in this observation.";
    set("lead", msg);
    say(msg);
  }
};
document.addEventListener("keydown", (e) => {
  if (
    e.key.toLowerCase() === "b" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.repeat &&
    !e.target.isContentEditable &&
    !document.querySelector("dialog[open]") &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)
  ) {
    if (nav === "floor") $("focus-b").click();
  }
});
for (const id of ["search", "scope"])
  $(id).addEventListener("input", () => {
    limit = 36;
    register(store.current.view || empty());
  });
$("more").onclick = () => {
  limit += 36;
  register(store.current.view || empty());
};
function sizing() {
  $("board").open = mobile.matches;
}
mobile.addEventListener("change", sizing);
sizing();
releaseDesk();
const query = new URLSearchParams(location.search).get("demo");
setMode(
  ["shift", "dense", "quiet", "degraded", "replay"].includes(query)
    ? query
    : "host",
);
