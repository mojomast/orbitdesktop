import { trace } from "./trace.js";
import { evidenceFor, inboxItems, recordFinding } from './inbox.js';
import { decisionReadiness } from './operations.js';

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
const only = items => items.length === 1 ? items[0] : null;
const selectorID = id => typeof id === 'string' && id.toLowerCase() !== 'unknown' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id);
const recorded = (v, { kind, id }) => {
  const list = kind === 'station' ? v.stations : kind === 'attempt' ? v.attempts : kind === 'attention' ? v.attention : v.records;
  const row = only(list.filter(x=>x.id===id));
  return row && (list !== v.records || row.kind === kind) ? row : null;
};

// Same source IDs, not a causal claim. No stage, title, route, prose,
// single-remaining-attempt heuristic or repository-only joins.
export function relatedAttemptIds(v, selection) {
  const ids = new Set();
  if (!v || !selection) return ids;
  let {kind} = selection, row = recorded(v, selection);
  if (!row) return ids;
  if (kind === 'attention') {
    // A summary points to an example job, not to every worker on that job.
    if (row.id==='section:failed-tasks' || row.id==='section:failed-features') return ids;
    row = evidenceFor(v,row); if (!row) return ids; kind = row.kind;
  }
  const live = r => sourceSection(v,r)?.state === 'live' && !/^last observed:/i.test(r.state);
  const counts = new Map();
  for (const a of v.attempts) counts.set(a.id,(counts.get(a.id) ?? 0)+1);
  const candidates = v.attempts.filter(a=>selectorID(a.id) && counts.get(a.id)===1);
  if (kind === 'event' || (kind === 'attempt' && row.source?.startsWith('Rails / '))) {
    // Replay records are historical and partial. Exact mark/attempt joins
    // come from the reviewed capture, never from an arbitrary host row.
    if (!v.sections.some(s=>s.id==='captured Rails view')) return ids;
    const origin = kind === 'event' && trace.events.find(e=>e.id===row.id && e.time===row.at && e.role===row.source);
    const target = kind === 'attempt' ? row.id : origin?.attempt;
    if (candidates.some(a=>a.id===target && a.source?.startsWith('Rails / '))) ids.add(target);
    return ids;
  }
  if (!live(row)) return ids;
  const attempts = candidates.filter(a=>a.quality==='live' && sourceSection(v,a)?.id==='fleet' && live(a));
  if (kind === 'attempt') { if (attempts.includes(row)) ids.add(row.id); return ids; }
  if (!selectorID(row.jobId)) return ids;
  const jobs = v.records.filter(r=>r.kind==='job' && r.jobId===row.jobId);
  if (jobs.length>1 || (jobs[0] && (!live(jobs[0]) || jobs[0].source!=='snapshot/1:pipeline' || jobs[0].id!==`job:${row.jobId}`))) return ids;
  const sameJob = a=>a.jobId===row.jobId && (!a.repo || !jobs[0]?.repo || a.repo===jobs[0].repo) && (!a.repo || !row.repo || a.repo===row.repo);
  if (kind === 'failure' && row.source === 'snapshot/1:failures') {
    // /1's public failure key is a documented tuple; unlike detail text it
    // preserves exact token boundaries (the timestamp is its own prefix).
    const prefix = `failure:${row.at}:${row.state}:`;
    const tuple = row.id.startsWith(prefix) ? row.id.slice(prefix.length).split(':') : [];
    const [attemptId,jobId,taskId] = tuple;
    if (tuple.length !== 4 || !selectorID(attemptId) || jobId!==row.jobId ||
      (row.attemptId && row.attemptId!==attemptId) || (row.taskId && row.taskId!==taskId)) return ids;
    if (attempts.some(a=>a.id===attemptId && sameJob(a) && (!taskId || a.taskId===taskId))) ids.add(attemptId);
  } else if (kind === 'job' && row.id===`job:${row.jobId}` && row===jobs[0] ||
    kind === 'task' && row.source==='snapshot/1:pipeline' && selectorID(row.taskId) && row.id===`task:${row.jobId}:${row.taskId}` ||
    kind === 'decision' && row.source==='snapshot/1:decisions' && jobs.length===1 ||
    kind === 'backlog' && row.source==='snapshot/1:backlog' && jobs.length===1) {
    for (const a of attempts) if (sameJob(a) && (kind!=='task' || a.taskId===row.taskId)) ids.add(a.id);
  }
  return ids;
}
// Task identifiers are scoped to a job. Never infer an edge from a stage,
// route, title, provider or a mention in prose. Missing rows are normal.
function linked(v, kind, row) {
  if (kind === "attention")
    return [evidenceFor(v,row)].filter(Boolean);
  if (!selectorID(row.jobId)) return [];
  const sameJob = (x) => x.jobId === row.jobId && (!row.repo || !x.repo || row.repo===x.repo);
  const exactTask = (x) => row.taskId && x.taskId === row.taskId;
  const jobs = v.records.filter((x) => x.kind === "job" && x.jobId===row.jobId);
  if (jobs.length>1 || (jobs[0] && (!sameJob(jobs[0]) || jobs[0].id!==`job:${row.jobId}`))) return [];
  const tasks = v.records.filter(
    (x) => x.kind === "task" && sameJob(x) && x.id===`task:${row.jobId}:${x.taskId}` && (kind === "job" || exactTask(x)),
  );
  const relevant = relatedAttemptIds(v,{kind,id:row.id});
  const attempts = v.attempts.filter(a => relevant.has(a.id))
    .map((x) => ({ ...x, kind: "attempt" }));
  return [...jobs, ...tasks, ...attempts].filter(
    (x) => !(x.kind === kind && x.id === row.id) && recorded(v,x),
  );
}
function railsTarget(v, kind, row) {
  if (!row || !selectorID(row.id)) return null;
  const selector =
    kind === "attempt"
      ? ["attempt", row.id]
      : ["job", "task", "backlog", "failure"].includes(kind) &&
          v.records.includes(row)
        ? ["job", row.jobId]
        : null;
  return selector &&
    selectorID(selector[1])
    ? selector
    : null;
}
function sourceSection(v, row) {
  if (typeof row.source !== "string") return;
  return v.sections.find(
    (x) =>
      row.source === `snapshot/1:${x.id}` ||
      (x.id==='fleet' && ['snapshot/1:fleet:cli','snapshot/1:fleet:dispatch_leases'].includes(row.source)),
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
    const address = el('p','case-address'), facts = el("dl", "facts"),
      links = el("div", "inspect-links"),
      details = el("details", "authority"),
      actions = el("div");
    const brief = el('section','case-brief'), dossier = el('details','case-fold case-dossier'),
      readiness = el('dl','case-facts'), timeline = el('details','case-fold'), marks = el('ol','case-marks');
    dossier.append(el('summary','','Decision readiness'),readiness);
    timeline.append(el('summary','','Observation timeline'),marks);
    details.className='authority case-fold';
    details.append(el("summary", "", "Authority limits"), actions);
    root.append(kicker, title, badge, address, dossier, brief, intro, timeline, facts, links, details);
    ui = { kicker, title, badge, address, intro, brief, dossier, readiness, timeline, marks, facts, links, actions };
  }
  function pairs(rows) {
    return rows.map(([k,value])=>{ const pair=el('div'); pair.append(el('dt','',k),el('dd','',value ?? 'Unknown')); return pair; });
  }
  function caseFile(finding, ready, marks) {
    const sig=JSON.stringify([finding,ready,marks]);
    if (ui.caseSig===sig) return;
    ui.caseSig=sig;
    ui.brief.hidden=!finding && !ready;
    ui.dossier.hidden=!ready;
    ui.timeline.hidden=!marks.length;
    const copy=[];
    if (finding || ready) {
      copy.push(el('small','case-index',finding ? `${finding.signalClass}  /  ${finding.severity}` : 'Owner file  /  Read only'),
        el('h3','case-impact',finding?.impact ?? ready.report));
      if (finding) {
        const list=el('dl','case-analysis');
        list.append(...pairs([['Reported cause',finding.cause],[ready?'Effect':'Recovery',finding.recovery]]));
        copy.push(list);
      }
      const next=el('div','case-next'); next.append(el('strong','','Next investigation'),el('p','',ready?.next ?? finding.next));
      copy.push(next);
    }
    ui.brief.replaceChildren(...copy);
    ui.readiness.replaceChildren(...pairs(ready?.rows ?? []));
    ui.marks.replaceChildren(...marks.map(([at,text])=>{
      const li=el('li'), time=el('time','',stamp(at)); time.dateTime=at;
      li.append(time,el('p','',text)); return li;
    }));
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
      nodes.push(
        el('strong','case-limit',label),
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
    setText(ui.title, row ? title || id : 'Record unavailable');
    setText(ui.address,row && !isStation ? `${row.id} · ${stamp(row.at)}` : ''); ui.address.hidden=!row || isStation;
    setText(
      ui.kicker,
      !row ? 'NO MATCHING SOURCE' : isStation ? "STATION PROFILE" : `${kind.toUpperCase()} RECORD`,
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
    const finding = row && !isStation ? inboxItems(v,Boolean(interrupted)).find(item =>
      kind==='attention' ? item.id===id : item.target.kind===kind && item.target.id===id) ?? recordFinding(v,row,Boolean(interrupted)) : null;
    const ready = decisionReadiness(v,row,Boolean(interrupted));
    const stale = interrupted || (!isStation && (row?.quality==='stale' || /^last observed:/i.test(row?.state) || section?.state==='stale'));
    if (stale) { setText(ui.badge,'Last observed'); ui.badge.className='tag'; }
    const marks=[];
    const mark=(at,what)=>{if (typeof at==='string' && Number.isFinite(Date.parse(at))) marks.push([at,what]);};
    const relations=row && !isStation ? linked(v,kind,row) : [];
    if (row) {
      mark(row.at,ready ? 'Request state reported by the decision queue.' : 'Time attached to the selected source record.');
      if (kind==='failure') {
        const a=relations.find(r=>r.kind==='attempt');
        if (a) mark(a.at,`Fleet reported ${a.id}: ${a.state}. No recovery is inferred.`);
      }
      if (ready) {
        const job=relations.find(r=>r.kind==='job' && r.source==='snapshot/1:pipeline');
        if (job) mark(job.at,`Pipeline observed the bound job ${job.jobId}.`);
      }
      mark(section?.at,'Source section collected.');
      if (v.generatedAt!==section?.at) mark(v.generatedAt,mode==='replay'?'Recorded frame boundary.':'Overview generated.');
    }
    marks.sort((a,b)=>Date.parse(a[0])-Date.parse(b[0]));
    caseFile(finding,ready,marks);
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
        ["Source", section || mode==='replay' ? row.source : null],
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
          else if (origin.kind==='verification.result' && origin.role==='verifier_record' && origin.time===row.at &&
            origin.outcome===row.state && origin.run===row.run && row.revision===trace.runs[origin.run]?.revision && row.contract===trace.contract)
            for (const [name, result] of Object.entries(trace.runs[origin.run]?.tests ?? {})) {
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
