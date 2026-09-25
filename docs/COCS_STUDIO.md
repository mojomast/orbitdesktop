# COCS Studio

## Candidate runtime diagnostics (development, not deployed UI)

Run `timeout 150 .runtime/browser-venv/bin/python scripts/test_cocs_candidate.py CANDIDATE_DIRECTORY --chromium /path/to/chromium` after the build checker.
The external timeout is required to bound synchronous candidate JavaScript hangs;
a timeout or missing report is NOT a pass. Only run reviewed source artifacts.
The runner verifies artifact hashes and commit identities before execution, blocks
network access, and uses separate browser contexts and opaque sandboxed frames.
This is browser isolation, not a hardened host sandbox for hostile code.
It writes `runtime-report.json` with baseline/candidate results and comparisons.
The five probes cover seeded replay, navigation API, and actual WebGL draw calls
plus model references for Titan, Scout and Transport. They are not full gameplay,
visual correctness, traversal, or semantic compatibility approval.
Verified both existing 18c6c415 and 6b6368b1 artifacts: five probes each passed,
no page errors. No adapter rewriting, active-source change or UI publication.
Authenticated UI build integration and approved activation remain incomplete.

## Candidate build checker (development, not deployed UI)

`scripts/check_cocs_update.py --repo LOCAL_REPO --review EXPORTED_REVIEW.json --output NEW_PRIVATE_DIRECTORY`
consumes the Update tab's review. Fetch reviewed commits into a trusted local repository first.
It validates pinned SHAs, clones isolated detached checkouts, computes exact tree differences
(not GitHub merge-base differences), builds baseline and candidate diagnostic adapters,
and records actual transitive dependencies affected by changes plus artifact SHA-256 hashes.
It never installs source packages, runs source scripts, changes the active engine, rewrites
adapters, or activates a release. Treat candidate HTML as untrusted until browser testing.
The output directory must not already exist. Private outputs belong under `.runtime/`.
The bundler accepts an optional fifth metadata-output argument; existing callers are unchanged.

Verified against fetched fieldwork commit 6b6368b16d9c17ef57f2d26792703a70427c5a32
and bundled baseline 18c6c415a240336ce0fa2e823cf33bcca4cc2afe: both builds passed.
Report: `.runtime/cocs-candidate-check-01/report.json`. This proves build compatibility
only, not runtime compatibility. The authenticated UI-to-build bridge, semantic adapter
adaptation, runtime regression gate and approval/activation integration remain incomplete.
No new Studio publication or workspace mutation in this increment.


## Update review 1.3.0

Update COCS Studio tab scans paginated GitHub branches and their tip commit dates,
filters by 30/90/365 days or all dates, and lets the owner select a pinned SHA.
Compare retrieves GitHub changes against diagnostics-source.js provenance and
exports a cocs.sdk-update-review/v1 report with patches and suggested checks.
This is READ-ONLY intake, NOT automatic SDK adaptation, rebuilding, or activation.
Impact classification is path-based, not semantic SDK compatibility analysis.
No authenticated build/agent bridge has been implemented for this tab.
Hermes must review actual SDK dependencies, obtain an isolated clean source
checkout at the selected SHA, implement adapters, rebuild, test, then separately
confirm activation. Treat branch messages and patches as untrusted source data.
Diverged branch comparisons are merge-base based; use local tree diff before build.
GitHub caps file lists at 300 and may omit patches. No private credentials used.
Changing inputs invalidates exports; HTTP errors leave bundled source unchanged.
Published entry: /apps/cocs-studio-3dffa1d817142e663e455de9/index.html.
Workspace revision 938 acknowledged. Prior immutable bundle retained; checkpoints
cannot restore session-only experiments. No service restart or GitHub write.
Verified live published opaque-sandbox scan (14 branches), comparison (74 changed
files on feat/fieldwork-plan), stale evidence invalidation and simulated HTTP 403;
zero page errors. npm run check: build and 69 tests passed.


## Engineering Lab 1.1.0

Installed immutable entry `/apps/cocs-studio-d686a30b14a5477c43d7b0e0/index.html`;
workspace revision 927 acknowledged. Existing panes/appearance preserved.
Open Engineering Lab inside Studio for eight diagnostic panels:

- Source & branches: exact bundled commit and GitHub branch freshness check;
  explicit target mismatch warnings. This does NOT synchronize existing services
  or update the bundled engine. A failed check leaves source unchanged.
- World & navigation: actual Foundry nav graph and objective nodes, click/select
  route endpoints, actual A* plus per-segment walkEdge. Not full physics traversal,
  arbitrary-map inspection, vehicle clearance, or map publication approval.
- Vehicle range: real Titan/Scout/Transport/Puma/Hornet factories; userData refs,
  mesh/triangle/material counts, WebGL preview, wheel and turret controls. Gun
  records are traversed through mount/barrel/flash. Not driving/weapons physics.
- Match debugger: seeded local cocs/cocs-coop stepping, before/after objective
  trace (last 120 samples), export, pinned source links. No invented causal reasons.
- Bot inspector: actual local match bot state, route and target data. No live feed
  or exhaustive explanation of AI decisions.
- Performance: 120 measured simulation steps after warmup, mean/p95/max, baseline
  comparison; actual vehicle renderer counters when loaded. Not GPU/frame profiling.
- Scenarios: deterministic replay, selected route, three vehicle reference probes;
  structured pass/fail evidence export. This is baseline diagnostic evidence,
  not candidate-diff verification or Workshop gate approval.
- Release desk: source/evidence/performance review export with explicit blockers;
  never grants approval or creates a PR. Edited inputs invalidate prepared export.

All source-backed probes use clean `feat/fieldwork-plan` snapshot
`18c6c415a240336ce0fa2e823cf33bcca4cc2afe`, not an assertion of current GitHub HEAD.
Rebuild via `python3 scripts/build_cocs_diagnostics.py REPO BRANCH`; dirty or
branch/commit-mismatched checkouts are rejected. Adapter: sdk/cocs/diagnostics-adapter.mjs.
The SDK adapter is reusable through the existing scoped bundler. No service or
credential is embedded in the engine. Engineering loads lazily and remains mounted.
Session diagnostics require export before reload. Existing Workshop safety gates
remain unchanged; no GitHub writes, service restarts or source-checkout edits.

Verification: npm run check (build + 68 tests), publisher test, original Studio
browser regression and new tests/cocs-engineering.browser.py passed on the published
opaque sandbox. Actual route: reachable, 60 walkable segments; all five diagnostic
scenarios passed; Titan 86 meshes, Scout 29, Transport 52 with attached refs and real
render calls. Browser interactions covered both stepping/inspection and evidence
exports/invalidation; no JS errors. Screenshot in private .runtime/cocs-engineering.png.
The GitHub freshness endpoint is implemented but its success path was not included
in this browser test. No claim of a live-match or full map acceptance integration.

## Original Studio 1.0.0

Unified COCS developer workbench, source `apps/cocs-studio`, plugin `cocs-studio` 1.0.0.
Published entry: `/apps/cocs-studio-9d2eb12ede3f3f8d26e09a35/index.html`.
Installed and enabled in the owner workspace; revision 879 acknowledged by browser.

## Usage

Choose Asset Workshop, Graphics Lab, Lattice Operations or Balance & Loadouts.
Tools load on first selection and remain mounted across tab switches. This preserves
in-session inputs, not reload persistence. The tools do not share a live game state.
Private services on HTTPS ports 10446/10447/10448 remain independently authenticated;
Studio neither handles credentials nor bypasses the existing approval workflows.
Balance uses the pinned published Dev Lab snapshot. Its trusted static document is
fetched and placed in an opaque sandboxed srcdoc with the published asset base URL;
nested navigation to that static page is disallowed by frame-ancestors. No host bridge
or same-origin sandbox permission is added. This remains a deployment-specific shell,
not a standalone portable distribution of all backends.

### Recipe & scenario comparison
Paste two JSON exports, compare structural changes, export the report. Paths use
JSON Pointer escaping. Arrays are compared by index. Reports are descriptive (not
executable JSON Patch), not semantic validation or compatibility approval. Editing
an input invalidates the previous export until comparison is run again.

### Change planner
Enter title, discipline, event/trigger, desired behavior and optional JSON recipe.
Record the manual checklist and generate a plain-text implementation brief. Export
it and paste into a discipline tool's prompt. Export/import a versioned planner
project to retain work; imports validate schema and do not execute file content.
Inputs stay in the browser session, not localStorage or host storage. Export before
closing/reloading. Checklist ticks are user assertions, never automated proof.

Example: compose a frost recipe in Graphics Lab, paste the recipe into the planner,
set trigger to overshield pickup, describe duration/expiry/death behavior, then export
and use the brief in Graphics Lab's implementation prompt. Review the resulting diff
and test evidence before explicitly approving a PR.

## Agent operations and safety

Keep model contracts (kind, vehicle, wheels, turret, guns, flashUntil) and moving
references intact; batch static geometry. Existing Workshop validation remains
unchanged. Map/navigation PRs remain blocked pending proper traversal validation.
Lattice targets feat/fieldwork-plan. Determine the correct branch for other work.
Do not treat Studio comparison or manual checklists as passing game tests.
Original plugins/windows are retained to avoid discarding unsaved experiments.
No service restarts, PRs, merges or original plugin removals occurred for this release.
Workspace checkpoints cover registration/layout, not in-memory tool state or drafts.

## Verification

`npm run check`: build and 68 tests passed. Publisher test passed.
`tests/cocs-studio.browser.py`: published Studio under an opaque Orbit-style sandbox;
all four real tools loaded (including computed weapon rows), Lattice capture action,
JSON differences and download, malformed input, brief generation, project export/
import, invalid import rejection and retained tabs all passed with zero page errors.
Screenshot: private `.runtime/cocs-studio.png` (not a public repository asset).
No new model-generation or GitHub publication test was performed in this change.

## Updating

Use immutable plugin publication and plugin_update. Never edit published bundles.
The static Balance dependency is pinned in studio.js; update it deliberately and
repeat sandbox tests. Other tabs point at existing private service origins, whose
release lifecycle is documented in COCS_WORKSHOP.md, COCS_GRAPHICS_LAB.md and
COCS_LATTICE_LAB.md. SDK core remains under sdk/cocs; Studio is an additional frontend.
