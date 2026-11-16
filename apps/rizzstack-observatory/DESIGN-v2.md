# Observatory v2 — interaction design spike (r2)

Status: design spike, not a shipped feature. Owner goal: "world class dashboard,
easy way to visualize the setup and change things, cutting edge techniques".
This document is the interaction design contract for Observatory v2; the
clickable proof lives in `mockup-v2/` (static no-build bundle, fake data only).

Basis: the r2 research brief supplied by the coordinator. Research anchors:

- Layered SRE dashboards — Google SRE Book, ch. "Monitoring Distributed
  Systems" (golden signals) and the SRE Workbook, ch. "Alerting on SLOs"
  (multiwindow, multi-burn-rate alerts); Grafana drill-down dashboard
  practice; aiAxonIQ layered-dashboard guidance (overview → triage → detail).
- RED above USE — Tom Wilkie's RED method (Rate, Errors, Duration) answered
  before Brendan Gregg's USE method (Utilization, Saturation, Errors): service
  health first, resource health second.
- 2026 no-build dashboard pattern — custom elements (or plain DOM) + SSE +
  hand-rolled SVG charts, ≈34 KB total versus ≈70 KB for a chart-library
  bundle; zero build step, zero CDN.

## 1. Research conclusions, translated into rules

| # | Research finding | Observatory rule |
|---|------------------|------------------|
| 1 | Layered dashboards (SRE/Grafana/aiAxonIQ): an L0 overview answers "is anything wrong", drill-downs answer "why" | Strict L0 → L1 layering. L0 = health strip + overview; every L0 panel is a link into exactly one L1 view. No mixed-purpose panels. |
| 2 | RED above USE | Signal ordering inside every service view: Rate / Errors / Duration rows or chips come first; resource (USE: pool saturation, quota) panels sit below or beside them, never above. |
| 3 | Burn-rate panels (SRE Workbook) | Bee failure budget and quota headroom render as *burn* over a sliding window with the alert thresholds (2×, 4×) drawn on the chart, not just as numbers. |
| 4 | Thresholds drawn on charts | Any chart that has a budget/SLO/quota draws its threshold line inside the same SVG. A threshold that is not drawn is a threshold that is missed. |
| 5 | Deploy markers on timelines | Every time-axis chart (pipeline timeline, burn chart) draws deploy markers (repo, version) so state changes can be correlated with releases. |
| 6 | One question per view | Each view title is a question: Overview "is anything wrong?", Fleet "what are the bees doing?", Usage "what did we spend?", Pipeline "what is shipping and what is stuck?", Backlog "what is next?", Topology "is the setup coherent?", Control "what do I decide right now?". |
| 7 | Consistent units and time ranges | Units are declared on every axis/chip (tasks, calls, tokens, USD); all time-series views share the same 24 h window and the same now-marker; durations always `Xm Ys` style. |
| 8 | Color = state only | Colors encode state (ok / warn / bad / running / waiting / unknown), never category or decoration. Every colored element also carries a text state label or an aria-label, so color is never the only carrier. |
| 9 | Every panel links drill-down | A panel without a drill-in affordance is either promoted to a view or deleted. Panel footers carry `Drill in →` targets. |
| 10 | No-build frontends (2026) | Catalog bundles stay static: vanilla JS ES modules, plain DOM/custom elements, hand-rolled SVG charts, no framework, no CDN, no build step. Chart code is small because the vocabulary is small (line, area, bar, marker, threshold). |
| 11 | Push updates without frameworks | The runtime wires SSE (`EventSource`) to the snapshot stream; the static mock simulates it with a timer, so the interaction contract (stale → refreshed) is identical. |

## 2. View map (L0 → L1)

```
L0 overview ──┬── L1 fleet        (what are the bees doing?)
              ├── L1 usage        (what did we spend? — UNKNOWN stays UNKNOWN)
              ├── L1 pipeline     (what is shipping / stuck? + deploy markers)
              ├── L1 backlog      (what is queued next?)
              ├── L1 topology     (is the setup coherent? parity map)
              └── L1 control      (what do I decide right now?)
```

- **L0 overview.** Health strip (launcher, docker, gateway parity, scheduler,
  bee failure-budget burn, quota burn, spend) + four glance panels: burn chart
  with thresholds and deploy markers, RED summary, top alerts, pipeline at a
  glance. Every panel drills into its L1 view.
- **Fleet.** RED header (rate, error share, duration p95) above the attempt
  table; per-attempt state colors + UNKNOWN cost where pricing is missing.
- **Usage.** Token bars; cost rendered only where priced; unpriced entries
  render the literal badge `UNKNOWN` (never `$0.00`, never blank) with a note
  naming the unpriced source.
- **Pipeline.** Jobs → tasks → stages (verify / integrate / accept), with
  escalations and blockers quoted verbatim; a 24 h timeline carries deploy
  markers so "stuck since the 1.2.4 deploy" is answerable in one glance.
- **Backlog.** Three columns (Todo / Doing / Done); cards link to pipeline
  when a job exists.
- **Topology / parity map.** Doctor data as a matrix: 4 repos × 5 stages
  (checkout / main / installed / loaded / deployed). Cell color = state, cell
  text = state word, click opens the doctor evidence for that cell. The map
  answers "is what I installed what I checked out, and is it what runs?"
- **Control surface.** Owner-gated mutations: receiver decisions
  (accept / reject-with-reason), deploy trigger (two-step confirm), config
  toggles; the F6 action queue table and the append-only audit trail are
  always visible — including while an action is in flight.

## 3. Control surface — the mutation contract

Observatory v2 never mutates through an open endpoint. Every control routes
through Orbit's owner-authenticated API into the **F6 action queue**, which is
fenced (validated, rate-limited, owner-scoped) and audited:

1. The owner session gate must be open (mock: "Unlock as owner"). Locked
   controls render with an explicit OWNER lock chip and refuse with a
   readable message; they do not silently no-op.
2. Acting enqueues: optimistic UI first (control enters `queued` state with a
   queue id `fq-…`), then the queue entry resolves `queued → applied` (the
   mock elides the intermediate `running` state).
3. **Reconcile**: if the queue confirms, the optimistic state is adopted and
   the audit trail records `applied`.
4. **Revert**: if the fence rejects (gate closed, policy refusal, conflict),
   the control returns to its prior value, a rejection notice appears with the
   queue's reason, and the audit records `rejected`.
5. Rejecting a receiver proposal *requires* a reason; the submit stays
   disabled until text exists.
6. The audit trail is append-only in the UI (newest first), every entry
   carrying time, actor, action, target, reason and outcome.

This is the "optimistic update with reconcile/revert" pattern specified here
and implemented in the mock; the production API shape (owner-authenticated
route + F6 queue id in every response) is deliberately mirrored by the mock's
route column so the seam is already designed.

## 4. Interaction design

- **Keyboard.** `1…7` switch views; `ArrowLeft`/`ArrowRight`/`Home`/`End`
  rove the tab list; `O` toggles the mock owner gate; `?` opens the shortcut
  sheet; `Esc` closes dialogs or returns to L0; all panels are reachable by
  Tab; drill-downs are real buttons/links (no click-only divs).
- **Focus.** View switches move focus to the view heading (`tabindex="-1"`),
  so screen readers announce context. `aria-selected` marks the active tab.
- **Reduced motion.** All animation (pulse, transitions) is disabled under
  `prefers-reduced-motion: reduce`; charts never animate.
- **Dark-first tokens.** All colors are CSS custom properties on `:root`
  (panel `#11141b` on `#0d0f14`, borders `#232733`, accent `#6d8cff` /
  `#54e6c6`, state colors ok/warn/bad/waiting/unknown); a light override
  exists only to prove the tokens are real. Charts read the same tokens.
- **Empty / stale / degraded (designed, not incidental).**
  - *Empty*: no snapshot → every panel shows its own empty-state sentence
    plus the fix hint; header badge `NO DATA`.
  - *Stale*: snapshot older than the freshness budget → header `STALE`, a
    banner states the age, panels dim slightly, data stays visible (stale data
    beats no data).
  - *Degraded*: per-source failures render *inside the affected panel* (source
    error line + retry affordance) while healthy panels stay live; header
    `DEGRADED`. Alerts and quotas keep rendering what did arrive.
- **Data honesty.** Unknown costs are `UNKNOWN`; missing values are `—` or
  `unknown`, never fabricated zeros; state words always accompany colors.

## 5. Mockup inventory (`mockup-v2/`)

- `index.html` — shell: header (brand, freshness, scenario switcher), L0 nav
  (7 tabs), 7 tabpanels, control dialogs (topology evidence, shortcuts),
  footer with demo-data scenarios (normal / stale / degraded / empty).
- `styles.css` — dark-first token sheet, state color system, reduced-motion
  and light-theme overrides.
- `app.js` — ES module: deterministic fake snapshot, SVG chart builders
  (burn area chart with threshold lines + deploy markers, quota bars, usage
  bars, pipeline lanes), view renderers, keyboard controller, owner gate,
  F6 queue simulation with optimistic reconcile/revert, audit trail.

Fake data only — no fetch, no SSE connection, no credentials. The bundle is
catalog-admissible: three static files, relative assets, no build step,
< 100 KB of assets.
