import { createStore } from "./store.js";
import { createScene } from "./scene.js";
import { connectHost } from "./host-client.js";
import { confirmedChanges } from "./transitions.js";
import { inboxItems, emptyInbox } from "./inbox.js";
import { createWorkbench } from "./workbench.js";
import { createInspector, relatedAttemptIds } from "./inspector.js";
import { renderReleaseObservation } from './release-provider.js';
import { renderRelease, controlsFor } from "./operations.js";
import { createRecorder } from "./recorder.js";
import { release } from "./release.js";

const names = {
  auth: "Authorization",
  dispatch: "Dispatch",
  build: "Build",
  verify: "Verification",
  review: "Review",
  integrate: "Integration",
  deploy: "Deployment",
  receiver: "Owner / receiver",
};
const $ = (id) => document.getElementById(id),
  node = (tag, c, text) => {
    const n = document.createElement(tag);
    if (c) n.className = c;
    if (text != null) n.textContent = text;
    return n;
  },
  set = (id, t) => {
    if ($(id).textContent !== t) $(id).textContent = t;
  };
const unknown = {
  generatedAt: null,
  health: "unknown",
  metrics: {},
  sections: [],
  attempts: [],
  attention: [],
  records: [],
  stations: Object.keys(names).map((id) => ({
    id,
    signal: "No current observation",
    quality: "unknown",
    level: "unknown",
    depth: null,
  })),
};
const store = createStore(),
  mobile = matchMedia("(max-width:720px)"),
  compact = matchMedia("(max-width:1079px)"),
  reduced = matchMedia("(prefers-reduced-motion:reduce)");
let nav = "floor",
  mode = "host",
  gen = 0,
  host = null,
  fixture = null,
  previous = [],
  focusReturn = null,
  continuous = false,
  changes = null,
  raf = 0,
  initial = true,
  rendered = null,
  renderedHeld = null;
let report=null, displayView=null, railFeed=null, railNotice=null, releasePacket,reportState='off';
const feedLabels={following:'Selected Rails stream live',invalidated:'Selected history changed · overview reread queued',reconnecting:'Selected Rails stream reconnecting',gap:'Selected history gap · reconciling'};
function discardReports(){report=null;displayView=null;work.setDocket(null);}
function receiveReport(packet){
  const raw=store.current.view;
  if(!raw||store.current.status!=='connected'||packet.generatedAt!==raw.generatedAt)return;
  report=packet;reportState='shared';displayView=raw;
  if(packet.titles.length){const lookup=new Map(packet.titles.map(t=>[JSON.stringify([t.kind,t.id]),t.title]));
    const records=raw.records.map(r=>{const title=lookup.get(JSON.stringify([r.kind,r.id]));return title?{...r,title}:r;});
    displayView={...raw,records};}
  work.setDocket(report.queue);schedule();
}
const scene = createScene($("world"), { onSelect: choose }),
  recorder = createRecorder($("floor"), {
    onFrame(v, e) {
      store.reset();
      store.hydrate(v);
      store.select("event", e.id);
      render();
      say(e.title);
    },
  });
const work = createWorkbench({
  root: $("work"),
  shift: $("shift-board"),
  onChoose: (x) => choose(x, true),
  onRelease: () => go("release", true),
});
const bench = createInspector({
  root: $("inspection-body"),
  onChoose: (x) => choose(x, true),
  onWork: (scope) => {
    go("work", true);
    if (typeof scope === "string") work.setScope(scope);
  },
  onRelease: () => go("release", true),
  onSeek: (i) => recorder.seek(i),
  onRails: openRails,
  capabilities: (ctx) =>
    controlsFor({
      ...ctx,
      connected: ctx.railsAvailable === true,
      providers: { rails: host },
    }),
});
function say(t) {
  set("announcement", t);
}
function go(dest, focus = false) {
  recorder.stop();
  nav = dest;
  for (const k of ["floor", "work", "release"]) $(k).hidden = k !== dest;
  document.body.dataset.surface = dest;
  for (const n of document.querySelectorAll(".mastnav button")) {
    if (n.dataset.nav === dest) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  }
  const t = {
    floor: "Shift control",
    work: "Operational workbench",
    release: "Release readiness",
  }[dest];
  $("surface-title").replaceChildren(
    document.createTextNode(t),
    node("span", "", "."),
  );
  if (focus) $(dest).focus({ preventScroll: true });
  render();
}
function choose(x, bring = false) {
  if (typeof x?.id !== "string" || !x.kind) return;
  initial = false;
  recorder.stop();
  const was = store.current.selection;
  if (x.id !== was.id || x.kind !== was.kind || nav !== "floor") {
    previous.push({ sel: was, nav });
    previous = previous.slice(-12);
  }
  store.select(x.kind, x.id);
  if (nav !== "floor") go("floor");
  else render();
  say("Inspecting " + (names[x.id] || x.id));
  if (bring || compact.matches) {
    $("inspect-title")?.focus({ preventScroll: true });
    if (compact.matches) $("inspector").scrollIntoView({ block: "start" });
  }
}
function back() {
  const p = previous.pop();
  if (!p) return;
  store.select(p.sel.kind, p.sel.id);
  go(p.nav);
  if (p.nav === "work") work.restoreFocus();
  else $("inspect-title")?.focus({ preventScroll: true });
}
function openRails(kind, id) {
  if (mode !== "host" || !host || store.current.status !== "connected")
    return false;
  focusReturn = document.activeElement;
  return host.openRails(kind, id);
}
function clear() {
  discardReports();railFeed=null;railNotice=null;reportState='off';
  previous = [];
  focusReturn = null;
  rendered = null;
  renderedHeld = null;
  initial = true;
  changes = null;
  continuous = false;
  work.reset();
  bench.clear();
  $("stations").replaceChildren();
  $("attention").replaceChildren();
  $("sources").replaceChildren();
  set("announcement", "");
  scene.update(unknown, store.current.selection, { motion: false });
}
function keyed(root, rows, key, make) {
  const by = new Map([...root.children].map((n) => [n.dataset.key, n]));
  let i = 0;
  for (const x of rows) {
    const id = key(x);
    let n = by.get(id);
    by.delete(id);
    const sig = JSON.stringify(x);
    if (n?.dataset.sig !== sig) {
      const focused = !!n && n === document.activeElement;
      const next = make(x);
      next.dataset.key = id;
      next.dataset.sig = sig;
      if (n) {
        n.replaceWith(next);
        if (focused) next.focus({ preventScroll: true });
      }
      n = next;
    }
    if (root.children[i] !== n) root.insertBefore(n, root.children[i] || null);
    i++;
  }
  for (const old of by.values()) old.remove();
}
function rail(v, items) {
  set("attention-count", String(items.length).padStart(2, "0"));
  keyed(
    $("attention"),
    items.length ? items : [{ id: ":empty", note: emptyInbox(v) }],
    (x) => x.id,
    (d) => {
      if (!d.target) return node("p", "inbox-empty", d.note);
      const b = node("button", "ticket");
      b.type = "button";
      b.dataset.level = d.level;
      b.dataset.object = d.target.id;
      b.onclick = () => choose(d.target, true);
      const cap = node("span", "ticket-meta", d.category);
      b.append(
        cap,
        node("strong", "", d.title),
        node('span','ticket-impact',d.impact),
        node("span", "ticket-id", d.target.id),
        node(
          "span",
          "ticket-foot",
          `${names[d.stage] || "Source"}${d.age ? " · " + d.age : ""} ↗`,
        ),
      );
      return b;
    },
  );
}
function board(v) {
  keyed(
    $("stations"),
    v.stations,
    (s) => s.id,
    (s) => {
      const b = node("button", "st-row");
      b.append(
        node("strong", "", names[s.id]),
        node("small", "", s.signal || "Unknown"),
      );
      b.onclick = () => choose({ kind: "station", id: s.id }, true);
      return b;
    },
  );
}
const fmt = (x) => (x == null ? "Unknown" : String(x));
const stamp = (t) =>
  Number.isFinite(Date.parse(t))
    ? new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC"
    : "time unknown";
function releaseSummary() {
  const chip = $("release-state"), detail = chip?.nextElementSibling;
  if (!chip) return;
  const current = report?.release;
  if (current && Array.isArray(current.repos)) {
    const known = current.repos.filter((r) => typeof r.main?.sha === "string");
    const unknown = current.repos.length - known.length;
    chip.textContent = `${known.length}/${current.repos.length} observed`;
    if (detail) {
      const labels = known.map((r) => `${String(r.repo).split("/").at(-1)} ${r.main.sha.slice(0, 7)}`);
      detail.textContent = `${labels.join(" · ") || "no revisions observed"}${unknown ? ` · ${unknown} unknown` : ""} ↗`;
    }
    return;
  }
  chip.textContent = release.decision;
  if (detail) detail.textContent = "loaded revision unknown ↗";
}
function render() {
  const { view, status } = store.current,
    v = displayView || view || unknown,
    m = v.metrics,
    demo = mode !== "host",
    replay = mode === "replay",
    held =
      !!view &&
      !demo &&
      status !== "connected",
    historical = held || v.health === "stale";
  const items = inboxItems(v, historical);
  if (initial && view && !replay) {
    const sel =
      items[0]?.target ||
      (v.attempts[0] ? { kind: "attempt", id: v.attempts[0].id } : null);
    if (sel) store.select(sel.kind, sel.id);
    initial = false;
  }
  const sel = store.current.selection,
    record =
      sel.kind === "station"
        ? v.stations.find((s) => s.id === sel.id)
        : sel.kind === "attempt"
          ? v.attempts.find((x) => x.id === sel.id)
          : sel.kind === "attention"
            ? v.attention.find((x) => x.id === sel.id)
            : v.records.find((x) => x.id === sel.id && x.kind === sel.kind);
  const stage = sel.kind === "station" ? sel.id : record?.stage;
  const pending = v.stations.find((x) => x.id === "receiver");
  const owner = !held && pending?.quality === "live" ? pending.depth : null;
  set("flight", fmt(held ? null : m.active));
  set("slots", fmt(held ? null : m.available));
  set("eligible", fmt(held ? null : m.eligible));
  set("decisions", fmt(owner));
  $("slots").nextElementSibling.textContent =
    m.capacity == null || held
      ? "scheduler slots free"
      : `free of ${m.capacity} scheduler slots`;
  set(
    "cost",
    typeof m.cost === "number"
      ? "$" + m.cost.toLocaleString("en-US", { maximumFractionDigits: 4 })
      : "Unknown",
  );
  set(
    "cost-label",
    typeof m.cost === "number"
      ? `${held ? "last " : ""}subtotal · ${m.costCoverage || "coverage unknown"}`
      : m.costCoverage || "coverage unknown",
  );
  releaseSummary();
  set(
    "source-caption",
    replay
      ? "RECORDED FIXTURE · NO LIVE ACTIONS"
      : demo
        ? "SYNTHETIC SHIFT · NO LIVE ACTIONS"
        : status === "connected" && view
          ? "HOST READ GRANTED · READ ONLY"
          : "HOST READ NOT CONFIRMED",
  );
  const label = replay
    ? "Historical replay"
    : demo
      ? "Fixture snapshot"
      : status === "connected"
        ? "Snapshot polling · 30 s"
        : `Host · ${status}`;
  set(
    "connection",
    `${label} / ${held ? "last confirmed" : v.health === "live" ? "fresh sections" : v.health} · ${stamp(v.generatedAt)}`,
  );
  const headline =
    nav === "release"
      ? "Which release gates have evidence, and which still need an operator?"
      : nav === "work"
        ? "Follow recorded work, from its public identity to the next evidence check."
        : replay
          ? "Investigate one duplicate receipt, from the failing reconnect to the combined tree."
          : !view
            ? "Connect a granted Orbit source, or choose a labeled shift to explore."
            : held
              ? "The source is interrupted. Observations below are from the last confirmed read."
              : owner > 0
                ? `${owner} owner ${owner === 1 ? "decision awaits" : "decisions await"} a response. Inspect the request before taking action.`
                : m.active === 0
                  ? "No attempts in flight in this snapshot. Check the inbox for outstanding work."
                  : `Supervise ${fmt(m.active)} in-flight attempts and inspect what is holding up delivery.`;
  set(
    "lead",
    status === "conflict"
      ? `Conflicting projections at ${stamp(v.generatedAt)}. Refresh for a newer observation.`
      : headline,
  );
  set("atlas-count", `${v.attempts.length} ATTEMPT RECORDS`);
  const active = !historical && !replay && m.active > 0 && v.attempts.find(a=>a.quality==='live'&&['starting','running','working','backoff'].includes(a.state));
  const dispatch=$('assignment-lead');dispatch.hidden=!active;dispatch.onclick=active?()=>choose({kind:'attempt',id:active.id},true):null;
  dispatch.children[1].textContent=active?(active.detail || active.taskId || active.id):'';dispatch.children[2].textContent=active?`${active.id} · ${active.route || 'route unknown'} ↗`:'';
  set(
    "sel-plate",
    stage && names[stage] ? names[stage].toUpperCase() : "RECORD",
  );
  $("world").classList.toggle("historical", historical);
  $('watch').hidden=demo||!view;
  set('follow-state',railFeed?`${feedLabels[railFeed.signal]} · ${railFeed.id}`:'Selected history off');
  set('evidence-state',report?(report.queue||report.release||report.titles.length?'Enrolled evidence shared':'No valid enrolled observations'):
    ({off:'Companion evidence not shared',waiting:'Evidence shared · next read scheduled',busy:'Evidence reader busy · retry scheduled',unavailable:'Evidence shared · reader unavailable',shared:'Evidence shared · awaiting confirmed view'}[reportState]));
  const notice=railNotice && !held && view && (railNotice.kind==='attempt'?v.attempts.find(r=>r.id===railNotice.id):v.records.find(r=>r.kind==='job'&&r.jobId===railNotice.id));
  const ticket=$('stream-ticket');ticket.hidden=!notice;
  ticket.lastElementChild.textContent=notice?`${railNotice.id} · inspect the updated history; outcome unconfirmed`:'';
  ticket.onclick=notice?()=>choose({kind:railNotice.kind,id:notice.id},true):null;
  if(releasePacket!==report?.release){releasePacket=report?.release;renderReleaseObservation($('report-release'),releasePacket??null);}
  if (rendered !== v || renderedHeld !== historical) {
    rail(v, items);
    board(v);
    keyed(
      $("sources"),
      v.sections.length
        ? v.sections
        : [{ id: "coverage", state: "unknown", at: null }],
      (s) => s.id,
      (s) => node("span", "", `${s.id} · ${s.state} · ${stamp(s.at)}`),
    );
    work.update(v, {
      historical: historical || replay,
      demo: mode === "dense" || mode === "shift",
    });
    rendered = v;
    renderedHeld = historical;
  }
  for (const b of $("attention").querySelectorAll("[data-object]"))
    b.setAttribute("aria-pressed", String(b.dataset.object === sel.id));
  if (nav === "floor")
    scene.update(
      v,
      { ...sel, stage },
      {
        motion: !$("static").checked && !reduced.matches && !historical,
        changedIds: changes,
        relatedIds: historical?null:relatedAttemptIds(v,sel),
      },
    );
  changes = null;
  bench.update(v, {
    selection: sel,
    mode,
    status,
    railsAvailable:
      mode === "host" && status === "connected" && !!host && !historical,
    canBack: !!previous.length,
    onBack: back,
  });
}
function schedule() {
  if (!raf)
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
}
async function setMode(key) {
  host?.close();
  host = null;
  const g = ++gen;
  mode = key;
  fixture = null;
  store.reset();
  clear();
  $("scenario").value = key;
  recorder.setEnabled(key === "replay");
  if (key === "replay") {
    go("floor");
    return;
  }
  render();
  if (key === "host") {
    host = connectHost({
      onView(v) {
        if (g !== gen) return;
        const prev = store.current.view,
          res = store.hydrate(v);
        if (res === "invalid") store.transport("unavailable");
        if (res === "new")
          changes = confirmedChanges(prev, v, continuous && !document.hidden);
        const accepted = (res === "new" || res === "duplicate") && store.current.status !== "conflict";
        continuous = accepted;
        schedule();
        return store.current.status === "conflict" ? "conflict" : res;
      },
      onStatus(s) {
        if (g !== gen) return;
        store.transport(s);
        if(s!=='connected')discardReports();
        if(!['connected','loading'].includes(s)){railFeed=null;railNotice=null;}
        if (!["connected", "loading"].includes(s))
          continuous = false;
        if (s === "unauthorized") clear();
        schedule();
      },
      onReports(packet){if(g===gen)receiveReport(packet);},
      onReportStatus(s){if(g===gen){reportState=s;schedule();}},
      onFollow(data){if(g!==gen)return;railFeed=data.signal==='idle'?null:data;
        if(data.signal==='invalidated')railNotice=data;
        if(data.signal==='gap'||data.signal==='reconnecting'){railNotice=null;continuous=false;}
        schedule();},
      onReturnFocus() {
        if (focusReturn?.isConnected) focusReturn.focus();
        else $("inspect-title")?.focus();
      },
    });
    return;
  }
  try {
    const [{ fixtures, fixtureTime }, { project }] = await Promise.all([
      import("./fixtures.js"),
      import("./snapshot-adapter.js"),
    ]);
    if (g !== gen) return;
    fixture = project(fixtures[key], { now: fixtureTime });
    if (store.hydrate(fixture) === "invalid") throw Error();
  } catch {
    if (g !== gen) return;
    store.transport("unavailable");
  }
  render();
}
for (const b of document.querySelectorAll("[data-nav]"))
  b.onclick = () => go(b.dataset.nav, true);
function search() {
  go("work");
  work.focusSearch();
}
$("find").onclick = search;
for (const [trigger, target] of [
  ["prefs", "preferences"],
  ["source-info", "sources"],
])
  $(trigger).onclick = () => {
    const open = $(target).hidden;
    $(target).hidden = !open;
    $(trigger).setAttribute("aria-expanded", String(open));
  };
$("static").onchange = () => {
  document.documentElement.classList.toggle("still", $("static").checked);
  render();
};
$("contrast").onchange = () =>
  document.documentElement.classList.toggle("high", $("contrast").checked);
$("scenario").onchange = (e) => setMode(e.target.value);
$("refresh").onclick = () => {
  if (mode === "host") host?.refresh();
  else if (fixture) {
    store.hydrate(fixture);
    say("Fixture snapshot re-read.");
    render();
  }
};
$("focus-b").onclick = () => {
  const v = store.current.view;
  const stage = v?.stations.find((s) => s.level === "delay");
  if (stage) {
    const record = v.records.find(
      (r) =>
        r.kind === "bottleneck" && r.stage === stage.id && r.state === "over",
    );
    choose(record || { kind: "station", id: stage.id }, true);
  } else {
    set("lead", "No measured over-target queue in the available observations.");
    say($("lead").textContent);
  }
};
document.addEventListener("keydown", (e) => {
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.repeat ||
    e.isComposing ||
    e.target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) ||
    document.querySelector("dialog[open]")
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    search();
  } else if (e.key.toLowerCase() === "b" && nav === "floor")
    $("focus-b").click();
});
function sizing() {
  $("board").open = mobile.matches;
}
mobile.addEventListener("change", sizing);
sizing();
renderRelease($("release-history"));renderReleaseObservation($('report-release'),null);
const query = new URLSearchParams(location.search).get("demo");
setMode(
  ["shift", "dense", "quiet", "degraded", "replay"].includes(query)
    ? query
    : "host",
);
