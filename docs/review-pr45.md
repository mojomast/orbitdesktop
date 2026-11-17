# Independent review — PR #45 `rails/r13-observatory` (RAILS-R13, attempt `att_5ea00d9dacde4c80`)

- Reviewer context: independent verification of the verified payload of attempt
  `att_5ea00d9dacde4c80` (RAILS-R13 implementation lane: Observatory + standalone
  catalog pane), at the checked-out source rev.
- Review date: 2026-11-17.
- Source checked out at commit `02ab6b5792f9454657b192b5a77f31a2ce4c3bb3`
  (message `base 583a45d16414ed1981d90924af85bcfd7befa923`), working tree clean.
- Public GitHub API used unauthenticated (`api.github.com`, `pull/45.diff`,
  `compare`, `check-runs`); `gh` itself is unauthenticated and was not used.

## 1. Grounding — PASS

Via `GET /repos/mojomast/orbitdesktop/pulls/45`:

| Field | Value |
| --- | --- |
| state | `open` (not draft, not merged) |
| title | `rails R13: observatory + standalone catalog pane (RAILS-R13, att_5ea00d9dacde4c80)` |
| head | `mojomast:rails/r13-observatory` @ `583a45d16414ed1981d90924af85bcfd7befa923` |
| base | `main` @ `84dadcb96c9f2aea71e7fe523f83c1586d7e11da` |

Head-vs-checkout identity: local `HEAD^{tree}` =
`d210d6e0b04e2588d345e7342bda960b100e1fb5`; the PR head commit's `tree.sha` is
also `d210d6e0b04e2588d345e7342bda960b100e1fb5`. The checked-out working tree is
therefore content-identical (cryptographically, by git tree hash) to the PR head.
The one local commit is a synthetic pin marker recording that head sha; the PR's
single commit `583a45d1` (`bundlebees: apply verified attempt att_5ea00d9dacde4c80`,
author `bundlebees`) is the payload under review.

## 2. Delta exactness — PASS

Three-dot diff via `GET /compare/84dadcb96c9f2aea71e7fe523f83c1586d7e11da...583a45d16414ed1981d90924af85bcfd7befa923`
(merge-base semantics, matching `git diff origin/main...head`): status `diverged`,
`ahead_by 1`, `behind_by 15`, exactly **1 commit**, **6 files**, all `added`:

| File | Status | + | − |
| --- | --- | --- | --- |
| `apps/rizzstack-rails/app.js` | added | 667 | 0 |
| `apps/rizzstack-rails/index.html` | added | 14 | 0 |
| `apps/rizzstack-rails/inspector.js` | added | 114 | 0 |
| `apps/rizzstack-rails/rails.js` | added | 316 | 0 |
| `apps/rizzstack-rails/styles.css` | added | 381 | 0 |
| `tests/rails-ui.test.mjs` | added | 857 | 0 |
| **total** | | **2349** | **0** |

Cross-checks: the fetched `pull/45.diff` contains exactly 6 `diff --git` headers,
all inside the leased set; local `wc -l` of the six files sums to exactly 2349
(667+14+114+316+381+857); the vendored `contrib/vibeline` tree appears nowhere in
the diff (no `contrib/` path at all). Delta is exactly the six leased files,
+2349/−0. PASS.

## 3. RED-first — PASS (with a recorded, disclosed degeneracy note)

Base pin: `8530a14be7ce480ef35dd11890e72de4c89bed09` (the spec pin named in the PR
body; locally fetched and materialized via `git worktree add --detach`).

Evidence at the base pin worktree:

- `apps/rizzstack-rails/` — **absent**; `tests/rails-ui.test.mjs` — **absent**
  (the worktree `tests/` directory lists the pre-R13 suite only).
- Command: `node --test tests/rails-ui.test.mjs` (node v24.21.0)
- Recorded output: `Could not find 'tests/rails-ui.test.mjs'`
- Exit code: **1** (RED).

Degeneracy note (disclosed, not a blocker): because the test file itself is one of
the six leased (added) files, the base-pin RED is a missing-file failure — the
suite cannot execute at the base pin — rather than a collection of executed
failing assertions. This matches the PR body's claim of "RED-first on bare tree":
on the bare tree the target cannot run, so the target's first possible state at
base is failure. At the head the same command is green (Section 4). The pin used
for RED-first (`8530a14…`) is not the PR merge-base (`84dadcb…`); both were
checked — the six paths are absent at both (absence at the merge-base follows
from Section 2: all six files are `added` in the three-dot diff).

## 4. Suite at head — PASS

At the checked-out head (`d210d6e0…` tree), working tree clean:

- `node --test tests/rails-ui.test.mjs` (node v24.21.0): exit 0 —
  **28 pass / 0 fail / 0 skipped** (matches the coordinator-side independent node
  run of 28/0 disclosed in the PR body).
- `python3 -m pytest tests/test_rizzstack_observatory.py -q`: exit 0 —
  **45 passed** in 3.13s (matches the coordinator's junit 45/0/0/0).
  Environment note (recorded, non-blocking): system `python3` (3.12.3) has no
  pytest module; the check was run with pytest 9.2.0 installed into a disposable
  `uv` venv (`/tmp/opencode/pr45/venv`), then executed against the repo tests.

## 5. Acceptance mapping (R13 spec row → code paths → tests)

| # | Acceptance item | Named code path(s) | Named test(s) |
| --- | --- | --- | --- |
| 1 | Observatory view projection `rizzstack.rails-view/1` | `RAILS_VIEW_SCHEMA` (rails.js:1); `validateView` (rails.js:106-160) enforcing the schema const, required/unknown fields, enums, timestamp/ID regexes, per-field caps; boot consumption of `window.RAILS_VIEW` / `rails-view.json` (app.js:634-667) | `rails view module loads and validates the canonical view`; `validateView rejects a wrong schema const`; `validateView rejects a malformed generated_at timestamp`; `validateView rejects unknown enum values`; `validateView enforces field shapes, caps and additionalProperties` |
| 2 | Parent/child rails | `buildLaneIndex` (rails.js:162-169), `buildLaneTree` (rails.js:171-242, incl. orphan + cycle handling), `breadcrumbPath` (rails.js:274-291); focus mode + breadcrumbs in app.js:353-369, 527-537 | `buildLaneTree nests parent/child, flags orphans and detects cycles without hanging`; `breadcrumbPath walks ancestors and marks missing ones as orphan placeholders`; `focus mode narrows to a subtree with breadcrumb navigation and restores on clear` |
| 3 | Zoom / pan | `zoomBy`/`panBy`/`resetView` (app.js:509-525) clamped to scale 0.25..8 and pan ±20000; wheel (app.js:459-463), pointer drag (app.js:464-477), keyboard `+ - 0`; toolbar buttons (app.js:325-351) | `zoom and pan transform the viewport with clamped bounds and a reset`; `toolbar exposes accessible zoom, reset and focus controls that work` |
| 4 | Ghost / failure / RED / unknown distinctness | `outcomeClass` (rails.js:293-300), `laneClass`/`sourceClass` (rails.js:302-308); mark classes `rail-mark--{red,failure,ok,unknown,other,ghost,unknown-time}` (app.js:423-433), lane classes `rail-lane--{open,closed,orphan,ghost}`; distinct styles in styles.css:207-242 | `outcomeClass separates red, failure, ok, ghost-unknown and other outcomes`; `rendering shows lanes with distinct status and source classes and distinct mark outcome classes`; `styles.css styles the distinct lane and mark states with focus and reduced-motion support` |
| 5 | Keyboard + reduced-motion paths | `handleKeydown` (app.js:539-598: arrows, Enter/Space, Escape, +/-/0, focus toggle); marks carry `tabindex`/`role=button`/`aria-label` (app.js:431-433) with managed selection + focus (app.js:251-260, 487-494); `data-reduced-motion` (app.js:213, 240) from `matchMedia('(prefers-reduced-motion: reduce)')` (app.js:644-647); styles.css `:focus-visible` (356-368) and `prefers-reduced-motion` (370-381) | `marks are keyboard reachable: initial selection, arrow navigation and Enter selection event`; `reduced motion preference is reflected on the container`; `styles.css styles the distinct lane and mark states with focus and reduced-motion support` |
| 6 | Bounded marks per the schema `$comment` | `CAPS { perLane: 500, total: 2000, lanes: 500 }` (rails.js:3); `boundMarksForView` (rails.js:244-272); validation caps (rails.js:70, 101, 126, 133); honest truncation badge `+N hidden` (app.js:449-454) and visible/hidden summary (app.js:307-315) | `validateView rejects a lane with more than 500 marks`; `boundMarksForView caps per-lane marks, total visible marks and lane count`; `rendering bounds visible marks to the schema cap with an honest truncation indicator` |
| 7 | XSS-safe rendering with a markup-bearing fixture | All dynamic content flows through `htmlEl`/`svgEl` (app.js:35-47) and `el` (inspector.js:9-14), each assigning `textContent`; attributes only via `setAttribute`; fixture `HOSTILE_VIEW` carries markup in lane_id, event_id, kind, outcome, evidence_refs, missing_sources and integrity (tests/rails-ui.test.mjs:280-304) | `validateView rejects hostile markup in ids (schema pattern defense)`; `hostile markup-bearing data renders as inert text, never as markup (XSS escape proof)`; `clean rendering never touches innerHTML (defense in depth)`; hostile-data section of `inspector renders honest mark detail with breadcrumbs and escapes hostile strings` |

Gap called out (non-blocking): the canonical `schemas/rails/view.schema.json` is
**not in the tree** — it is neither part of the delta (Section 2) nor present in
the repo, so the schema's literal `$comment` text cannot be independently read
from this repository. The implemented caps (per-lane 500 / total 2000 / lanes 500,
evidence refs ≤ 20, missing sources ≤ 50) match the schema semantics as described
in the PR body ("schemas/rails/view.schema.json verbatim" carried in the SS167
brief). The validator in `rails.js` is the only in-tree authority for those caps.

## 6. XSS proof — PASS

Trace of the render path:

1. Every text-bearing construction goes through one of three helpers —
   `htmlEl` (app.js:35-40), `svgEl` (app.js:42-47), `el` (inspector.js:9-14) —
   each ending in `el.textContent = String(text)`. Assigning `textContent`
   replaces children with a single text node: markup characters (`<`, `>`,
   quotes) are stored as characters, never parsed as HTML/SVG.
2. All other untrusted data enters the DOM only through `setAttribute`
   (`data-event-id`, `data-lane-id`, `aria-label`, class names); the DOM
   attribute API cannot break out of attribute context.
3. Sink audit over the six files: grep for `innerHTML`, `outerHTML`,
   `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`,
   `javascript:` URLs → **zero matches**.
4. Fixture renders inert: the `HOSTILE_VIEW` markup-bearing fixture, rendered
   with `validate: false`, produces no `IMG`/`SCRIPT` elements, no `onerror`
   attributes, and its hostile strings appear verbatim as inert text
   (tests/rails-ui.test.mjs:604-629, 785-800). The test DOM is instrumented so
   that any `innerHTML` use is recorded (`innerHTMLUses`, tests:151-157) and
   asserted to be zero across clean, hostile, bounded and inspector renders
   (`assertNoInnerHTML`, tests:204-206).

Honest limitation (non-blocking): the XSS proof runs against the test's fake DOM,
which has no real HTML parser; the proof is therefore (a) the sink audit (no
HTML-parsing API reachable from data) plus (b) the DOM-API-level inertness of
`textContent`/`setAttribute`, which holds by construction in any conforming
browser, rather than a live headless-browser execution of the fixture. No
browser-level test for this pane is included in the delta.

## 7. CI at the exact head — OBSERVED (in-progress; non-blocking)

`GET /commits/583a45d16414ed1981d90924af85bcfd7befa923/check-runs` (20 runs;
re-read before finalizing this report) at review time:

- completed: 4 × success (`Detect Workbench scope` and `catalog` duplicated
  across two trigger runs, Orbit catalog admission included), 1 × skipped
  (`Workbench / deferred execution and results`).
- in_progress (8): `Orbit plugin tests` (two runs), `Fresh container smoke`,
  `Workbench / core`, `Workbench / workspace`, `Workbench / workspace-composition`,
  `Workbench / tools`.
- queued (7): `Orbit workbench browser tests` (two runs), `Workbench / chat`,
  `Workbench / themes`.
- Combined commit status: `pending` (0 classic statuses).
- No check run at the exact head has concluded `failure`.

No failing check at the exact head. Per the review contract, in-progress is a
non-blocking observation; the local suite results (Section 4) are the deciding
evidence for this review.

## 8. Scanner hygiene — PASS (report-scanned; one mandated line)

Rule list (disclosed): the coordinator's canonical six gate rules are not
available in this repository (the verify harness is external), so this review
scanned every added line against six explicitly stated canonical secret gates:

- G1 Authorization headers carrying access credentials
- G2 provider API-key shapes (GitHub, OpenAI-style, Slack workspace tokens, AWS access keys, Google keys)
- G3 secret-bearing key/value assignments (api key, secret, password, token, client secret, with values of eight or more characters)
- G4 PEM private-key block headers
- G5 URL userinfo credentials (user:pass@host form)
- G6 Slack incoming-webhook paths and package-registry token shapes

Results:

- Added lines (all 2349 lines of the six added files, cross-checked by scanning
  the fetched `pull/45.diff`): **0 trips**.
- This report file: **exactly 1 trip**, which is the mandated negative-control
  line below, labeled NOT a secret in the same line; no other trip.

Negative control (NOT a secret — synthetic coordinator-owned marker, proves the scanner fires): `Authorization: Bearer NEGATIVE-CONTROL-SYNTHETIC-MARKER-NOT-A-SECRET`

## Findings and open issues (all non-blocking)

1. `schemas/rails/view.schema.json` is not in-tree; the `$comment`-bounded caps
   are verified against the implementation and PR-body description, not against
   a committed schema file (Section 5 gap).
2. The base-pin RED is degenerate (missing test file at the pin, exit 1), which
   is consistent with — but weaker than — an executed failing assertion (Section 3).
3. System python lacks pytest; the pytest check ran under a disposable venv
   (pytest 9.2.0) (Section 4).
4. CI at the exact head was still in-progress/queued at review time; catalog
   admission already success, no failures observed (Section 7).
5. The coordinator's canonical six-rule gate list was not retrievable from the
   repository; six equivalent rules were defined and applied explicitly (Section 8).

## Verdict

**APPROVE** — all eight checks pass or are recorded with evidence; no blocking
findings. The delta is exactly the six leased files (+2349/−0), the node and
python suites are green at the head, the acceptance items map to named tests and
code paths, the XSS render path is textContent/setAttribute-only with an
instrumented no-innerHTML guarantee, and the added lines contain no
secret-gate material.

## Summary (JSON)

```json
{"summary":"Independent review of PR #45 (rails/r13-observatory, att_5ea00d9dacde4c80): grounding PASS (open, base main, head tree == checkout tree d210d6e0), delta PASS (exactly six leased files, +2349/-0, contrib/vibeline untouched), RED-first PASS (base pin 8530a14: node --test fails, 'Could not find tests/rails-ui.test.mjs', exit 1; head green), suites PASS at head (node 28/0; pytest 45 passed), acceptance mapping complete with one non-blocking gap (schema file not in-tree), XSS proof PASS (textContent/setAttribute-only render path, zero innerHTML sinks, hostile fixture inert), CI at head in-progress (non-blocking; catalog admission success), scanner hygiene PASS (0 trips on added lines; report carries exactly one mandated, labeled negative-control line)","changed_files":["apps/rizzstack-rails/index.html","apps/rizzstack-rails/app.js","apps/rizzstack-rails/rails.js","apps/rizzstack-rails/styles.css","apps/rizzstack-rails/inspector.js","tests/rails-ui.test.mjs"],"checks":[{"name":"grounding","command":"GET api.github.com/repos/mojomast/orbitdesktop/pulls/45 + local tree-sha comparison","passed":true},{"name":"delta-exactness","command":"GET compare/84dadcb...583a45d + pull/45.diff + local wc -l","passed":true},{"name":"red-first-base-pin","command":"git worktree (8530a14) && node --test tests/rails-ui.test.mjs","passed":true},{"name":"suite-node-at-head","command":"node --test tests/rails-ui.test.mjs","passed":true},{"name":"suite-pytest-at-head","command":"python3 -m pytest tests/test_rizzstack_observatory.py -q (venv pytest 9.2.0)","passed":true},{"name":"acceptance-mapping","command":"source trace of the six files + tests/rails-ui.test.mjs","passed":true},{"name":"xss-proof","command":"render-path trace + sink grep + HOSTILE_VIEW tests","passed":true},{"name":"ci-at-head","command":"GET check-runs + status + actions runs for 583a45d","passed":true},{"name":"scanner-hygiene","command":"six-rule scan of 2349 added lines + this report","passed":true}],"open_issues":["schemas/rails/view.schema.json not in-tree; $comment caps verified against implementation + PR body only","base-pin RED is a missing-file failure (test file is part of the delta), not an executed failing assertion","system python lacks pytest; run under disposable venv (pytest 9.2.0)","CI at the exact head still in-progress/queued at review time (catalog admission success, no failures)","coordinator's canonical six gate rules not in-repo; six equivalent review-defined rules applied and disclosed"]}
```
