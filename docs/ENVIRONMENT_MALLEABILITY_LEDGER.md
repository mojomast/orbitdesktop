# Environment malleability implementation ledger

## Baseline and scope

Started 2026-09-28 on `workbench/next-integration` at
`d35142f812619c1a2492f0223fce2798cf105b6d`, with a clean working tree.
The first independently useful release is M1–M2: durable arrangement proposals,
receipt recovery, strict revision-bound Return, and portable project recipes.
M3–M6 remain later dependencies until their preceding journeys are verified.
No deployment, owner runtime migration, or paid provider acceptance is part of
the development fixtures. Hermes remains the runtime; layout remains v1.

## M0 capability matrix

| Area | Current source-backed behavior | Required increment |
| --- | --- | --- |
| Workspace operations | Strict bounded v1 operations, CAS, checkpoints and durable command receipts | Persist exact proposed result before approval; semantic diff |
| Structural preview | Uncommitted reducer output; new IDs can differ on later apply | Stage IDs once; bind renderer/viewport and exact digest |
| Workbench arrangements | Project bindings and Investigate/Implement/Review; process-local preview/Return maps | Durable proposals and Return across restart |
| Saved layouts | Browser-local geometry keyed to existing window IDs | Add server recipes without changing legacy geometry-only meaning |
| Runtime continuity | Stable pane views; native moveBefore supports same-document moves | Verify both renderers; state fallback limits explicitly |
| Plugins | Disabled-first v1 registration, retained content-addressed bundles | Instances/data/declarative contributions are later M3 work |
| Execution | Private candidates, independent check evidence, shared lane | Artifact-producing Studio profile is later M4 work |
| Store | Source schema 8; v1 layout plus separate placement and Workbench tables | Additive migration; never a competing writable store |

Older schema-3/6 prose and unimplemented-authority proposals are historical
design context, not current behavior or authority to extend generated frames.

## Ownership and gates

Frozen implementation direction:

1. `server/workspace-arrangements.mjs` extracts arrangement compilation/persistence
   from `server/workbench-workflow.mjs`, retaining `recipe_preview` /
   `recipe_apply`, `preview_id` and `preview_digest` compatibility. Schema 9 in
   `server/sqlite-workspace-store.mjs` / `server/workbench-data.mjs` adds private
   proposals and versioned recipes. Exact staged state/placement is committed;
   Return stages an inverse from the pre-change checkpoint only at the exact
   applied revision. Proposal disposition and workspace receipt share a transaction.
2. `src/workbench-workflow.ts`, `src/project-workbench.ts` and
   `src/pane-workbench.ts` supply the compact semantic preview and retained retry
   key. Advanced identities stay in Details; saved and browser-acknowledged states
   stay distinct. Existing verified patch/integration controls retain their scope.
3. `server/workspace-description.mjs`, `server/workspace-arrangement-control.mjs`,
   `contracts/workspace-v1.mjs`, `scripts/workspace_control.py` and
   `hermes-plugin/__init__.py` expose discovery and the same layout-only compiler
   to Normal. Same-workspace project names and binding identities are intentional
   metadata disclosure under this brief; private resource contents remain excluded.
4. Focused migration/receipt/auth tests plus
   `tests/workspace-arrangements.browser.py` establish restart, stale/undo,
   second-project portability and actual renderer continuity. Then run the full
   check, publisher, relevant Workbench/browser regressions and portable parity.

Named recipe definitions store role constraints and renderer/layout preferences,
not copied resource UUIDs. Missing and duplicate roles require explicit handling.
No operation batch is silently split; no preview creates or attaches a shell.

- Lead: shared contract decisions, integration, Normal adapter, generated parity,
  ledger, cross-worker review and final gates.
- Flash: proposal/recipe backend investigation and scoped implementation after
  interface freeze.
- Sol: compact preview/recipe UX and isolated browser journeys after API freeze.
- Luna: extension boundary investigation and scoped documentation/verification.
- `src/main.ts`, `src/panes.ts`, `server/workspace.mjs`, store code and generated
  contracts have one assigned editor at a time.

Acceptance gates: exact staged IDs/digests; receipt recovery after lost response
and restart; stale preview refusal; atomic state/placement/checkpoint/receipt;
revision-fenced inverse proposal; real bindings and explicit role ambiguity;
second-project reuse; reload/second-browser retrieval; no session replacement or
execution replay in tested layout journeys. Browser acknowledgement and visual
inspection are separate facts. No preview attaches or creates live resources.

## Fresh evidence

- Baseline: `node --experimental-strip-types --test --test-concurrency=1
  tests/workbench-workflow.test.mjs tests/workspace-receipts.test.mjs
  tests/sqlite-workspace-store.test.mjs`: **28 passed**, no failures/skips.
  Disposable local fixtures, real SQLite and local Git; no model request.
- Confirmed isolated old-wrapper defect: first recipe apply commits revision 2;
  identical apply retry returns `expired`; a new workflow instance cannot Return.
  Private reproduction: `/tmp/opencode/repro-recipe-retry.mjs`. The durable store
  itself is receipt-first; the wrapper checks its consumed process-local preview
  first. This is the targeted M1 regression, not an execution-lane failure.
- Baseline frontend continuity (release build from `d35142f`), disposable runtimes:
  `tests/runtime-continuity.browser.py --pty --renderer default` and `--renderer
  docking`: **94 transitions passed each**, Chromium **145.0.7632.6**, real private
  tmux shell, two iframe nonces/drafts and DOM identities retained; URL/close
  negative controls passed, zero page errors. Revisions observed 53/53 and 52/52.
  These establish renderer primitives, not the new recipe journey.
- Publisher: `python3 tests/plugin-publish.test.py`: **6 passed** (Luna).
- Description increment: real HTTP/SQLite auth/catalog/privacy test passed;
  `python3 tests/test_hermes_plugin.py`: **12 passed**, synthetic HTTP responses
  testing the real Python transport, no Hermes/model invocation.
- Migration: `tests/workspace-arrangements-migration.test.mjs`: **2 passed**.
  Real archived `d35142f` schema-8 store creates the fixture; upgrade preserves
  state/checkpoint/receipt/bundle and Workbench identities. Schema-9 backup/restore
  passes; old schema-8 code refuses schema 9; both readers refuse schema 10.
  This does not authorize mixed-version writers or an owner-runtime upgrade.
- Final dependency-enabled `npm run check`: **695 tests, 693 passed, 0 failed,
  2 gated skips**, 370.472 s. Command:
  `HERMES_NATIVE_SOURCE=/tmp/opencode/orbit-hermes-native
  ORBIT_ROUTETOK_TEST_SOURCE=/tmp/opencode/orbit-diff-routetok-source
  ORBIT_ROUTETOK_TEST_CACHE=/tmp/opencode/orbit-live-acceptance/cache npm run check`.
  The release-instance skip was separately exercised successfully (below). The
  deployed-verifier endpoint gate remains unconfigured; no new paid model run.
  The last stale-disposition fix also passed its focused 41-test
  arrangement/controller/workflow gate.
- First integration `npm run check` exceeded its 120-second command timeout
  during dependency-backed artifact tests (no reported test failure before
  timeout). This is an incomplete run, not a green gate; the final gate must use
  an appropriate timeout after the remaining implementation changes.
- Dependency-enabled integration gate completed afterward: **691 tests, 689
  passed, 0 failed, 2 gated skips**, 368.256 s. Actual-Hermes fixture source and
  the preprovisioned RouteTok dependency cache were enabled; no provider request.
  Additional final role-choice/preview-guard changes require a final gate below.
- Updated built frontend, isolated continuity fixtures: **94 transitions each**
  under default and Docking, real private tmux shell and Chromium 145.0.7632.6;
  zero page errors, iframe documents/nonces/drafts retained. Observed revisions
  were 53/53 and 51/51. Native `moveBefore` was available; this does not claim
  document continuity across reload or on unsupported browsers.
- Review caught and sent back backend gaps in exact receipt identity, actor
  scoping, in-transaction authority checks, cross-project reuse, renderer geometry,
  and recipe-save receipt retention after later edits. These are acceptance gates,
  not waived limitations.
- Normal adapter journey: the real Python adapter against a real disposable
  HTTP/SQLite service now discovers the catalog, saves a recipe, previews/applies,
  recovers the same receipt and Returns to exact previous state/placement. This
  is transport/service evidence, not a live-model or browser-rendering claim.
- Extended `tests/workspace-arrangements.browser.py --renderer default --pty`
  and `--renderer docking --pty`: **passed both**. Real disposable servers and
  Chromium verify stale preview/viewport refusal, explicit duplicate binding
  choices, missing-role reporting, stable iframe documents/drafts/pane identities,
  a private tmux shell's PID/marker, restart-safe Return, second-project apply and
  exact Return, a pending preview across server restart, independent-browser
  retrieval, durable save/apply response recovery, and original local-layout
  bytes retained through import. No new model execution is requested.
- Existing `tests/workbench-results-ui.browser.py` passed under **default and
  Docking** after adapting its selectors to the new disclosed arrangement slot.
  Exact patch round trips, Review visibility, Return/stale-owner-edit refusal,
  unrelated-pane continuity and disclosure revocation remain asserted. Both runs
  reported zero page errors and zero admitted live-model trials; their synthetic
  gateway requests are not live-provider evidence.
- Eight desktop/narrow preview/Changes screenshots were inspected by Sol;
  the lead additionally inspected representative desktop and narrow images for
  both renderers. Semantic diffs and Apply/Cancel are visible, while the Changes
  pane keeps arrangements collapsed below the primary review surface. Screenshots
  and raw fixture logs remain under `/tmp/opencode`, outside Git.

### Initial journey measurements

From an open, already-bound project: a built-in arrangement takes **2 deliberate
actions** (Preview, Apply), named reuse takes **3** (Select, Preview, Apply), and
Return takes **2**. Ambiguous bindings add an explicit choice. The historical
wrapper could not complete restart-safe Return or same-key response recovery;
there is no honest before/after timing for those previously failing paths.

| Renderer | Request → observed ms: first Apply / Return / second-project Apply / Return | DB / WAL / SHM bytes before fixture cleanup |
| --- | --- | --- |
| Default | 1900.3 / 1094.5 / 1173.9 / 1077.7 | 520192 / 609792 / 32768 |
| Docking | 1903.7 / 1089.0 / 1187.0 / 1080.7 | 536576 / 642752 / 32768 |

These eight samples start just before the UI apply request, not at the database
commit; they include the request and polling/ack path. Initial local-fixture
target: **≤3 seconds request-to-observed**, with zero unintended session
replacement and zero replayed execution. This is not a production SLO or a
statistical reliability estimate. Pure commit-to-ack latency, subscription leak
counts and Studio draft-to-preview time have not been independently instrumented.
The last metric requires M4. Recovery outcomes and retained-byte samples above
are actual fixture observations, not projected success percentages.

### First published CI follow-up

Published `e695db36cca5097911884aa8f94cdf898e647f67`. Plugin CI
[`36461741968`](https://github.com/mojomast/orbitdesktop/actions/runs/36461741968)
passed. Workbench CI
[`36461742038`](https://github.com/mojomast/orbitdesktop/actions/runs/36461742038)
passed its dependency-enabled Node gate, Python/portable parity, real release
instance, both new arrangement/PTY journeys, continuity/recovery, live timeline,
candidate diff and result/review boundaries, but failed three existing browser
fixture gates. This is a failed CI run, not a release-wide green result.

Confirmed fixture mismatches: Project Workbench's Doctor assertion still expected
schema 8 rather than 9; the delayed-load fixture's strict read allowlist omitted
`recipe_list` and `proposal_list`. The native browser failure was diagnosed using its
separately captured diagnostic log. Corrections and their focused reruns are
recorded below before republishing; no owner deployment is involved.

- Doctor fixture: both displayed and API schema assertions now require 9.
  Default/Docking × ordinary/linked registration: **4 browser runs passed**,
  zero page errors, zero agent requests and zero terminal WebSockets.
- Delayed-load fixture: only the exact workspace/project-scoped `recipe_list`
  and `proposal_list` reads were admitted with bounded empty responses. Fixed
  source passes; historical `ca7dd89` still fails the retained-activity assertion
  as intended. Mutation/dispatch and zero-click assertions remain enforced.
- Native fixture: arrangement selectors now target their sibling Inspector slot
  and current button labels. In its two-window fixture, Investigate/Implement
  are already satisfied, so Apply correctly stays disabled. The fixture still
  previews all three recipes, then explicitly applies the changed Review
  arrangement and Returns. Revision, exact prior state, pane IDs, chat/profile,
  grant and reload assertions remain intact. Default and Docking **both passed**
  using the pinned actual Hermes runtime and synthetic local model endpoint:
  8 fixture model requests, 6 tool calls, fail/pass check verdicts, zero page
  errors per run. These are not paid/live-provider trials.

All three corrections are confined to browser fixtures; application source and
contracts are unchanged from `e695db3`. The updated portable archive carries this
ledger, and publication triggers new exact-head CI rather than reclassifying the
failed run as passing.

The corrected exact head `ae14c4f327765dc5ff8786070dedc9eb7e9b3abe` subsequently
passed both [plugin CI](https://github.com/mojomast/orbitdesktop/actions/runs/36466650831)
and [Workbench/browser CI](https://github.com/mojomast/orbitdesktop/actions/runs/36466650882).
These completed runs establish the M1–M2 baseline, not the later M3 source.

## Milestones

Reviewable backend increments:

- `cf70568`: exact durable proposals, actor-scoped recovery, versioned role
  recipes, schema-9 migration, bounded description and Normal adapter routing.
  Lead combined focused Node/HTTP/migration/Python-adapter gate: **40/40 passed**.
- `cdb70c4`: require `op_id` for every new recipe save (no newly introduced
  unreceipted legacy mutation path). Focused arrangement/adapter/controller gate:
  **31/31 passed**. UI already supplies retained keys; fixture callers must too.
- `21695c9`: restart recovery of original recipe-save receipts after
  later edits, retained-recipe budgeting across revoked source projects, and
  revision-based Return selection independent of wall-clock order. Focused
  regressions pass.
- `ad0af07`: compact preview/recipe UI, explicit built-in role choices, named
  semantic diffs, measured renderer/viewport guards, exact uncertain-operation
  recovery and non-destructive local-layout role-order import.
- `45a27b0`: persist stale proposal disposition after a refused workspace
  transaction rolls back; retrieval through a new service sees the stale state.

Packaging/adapter verification after this increment:

- Python command adapters **8**, generated contract **7**, batch-limit regression
  **2**, Hermes transport **12**, publisher **6**, catalog **18**, portable
  endpoint checks **3**: **56 passed** total. Negative fixtures deliberately
  print argparse rejection messages; no failures.
- Portable `hermes-plugin/orbit-source.tar.gz` was regenerated from the admitted
  source inventory. `python3 tests/test_orbit_bundle.py`: **2 passed**, including
  byte parity and presence of the new arrangement/description module closure.
  Combined Python verification: **58 passed**. Private runtimes, credentials and
  screenshots remain excluded.
- `RELEASE_INSTANCE=1 node --experimental-strip-types --test
  tests/release-package-launch.test.mjs`: **2 passed**, real disposable immutable
  release packaging/launch, schema 9, Node 22.23.1 / ABI 127. Prior process stayed
  pinned, failed health probe rolled back the pointer, older-schema downgrade
  was refused. No owner service was used.

These increments have not been deployed to an owner runtime.

## Admitted release limits

- Recipes retain portable role order, renderer and grid intent. Current-layout
  capture/import does not save arbitrary pixels, theme, camera, minimized state,
  instance data or resource authority. The legacy local layout stays intact.
- Windows and opt-in Docking support measured grids; Spatial supports role
  ordering. A viewport that cannot meet minimum sizes reports deferred geometry.
  The staged semantic preview is not a disposable rendered-layout preview;
  `rendered:false` and `tested:false` remain distinct from commit and browser ack.
- Role resolution never creates a terminal or picks a different conversation.
  A missing role is unbound; an ambiguous role requires an explicit binding ID.
- Return requires the exact committed workspace revision. It is not a
  conflict-aware field merge or restoration of terminal/application contents.
- Retention is bounded: 32 retained recipes and 512 recipe-save receipts per
  workspace; 200 proposals per project, with 32-row history pages and a 60-second
  pending-preview lifetime. Retained records in revoked projects still count.
  Committed receipts are not deleted to make room; capacity exhaustion refuses
  a new operation. Expired uncommitted previews can be pruned.
- Mixed-version writers are unsupported. Schema-8 code refuses schema 9 when
  opening the database; deployment requires coordinated writers, and downgrade
  uses a compatible pre-upgrade backup. No owner database was upgraded here.
- Live model evidence is unchanged from the historical handoff. New acceptance
  uses real servers/browsers/PTYs with synthetic project and gateway fixtures.

| Milestone | Status | Commit/evidence |
| --- | --- | --- |
| M0 source map and contract freeze | Complete | Baseline/reproduction and ownership/API decisions above |
| M1 durable proposals and Return | Complete for admitted arrangement scope | Exact proposals/receipts, atomic/CAS tests, restart/browser/PTY journeys passed |
| M2 durable role recipes and description | Complete for portable role-order/grid contract | Two-project apply/Return, independent browser, Normal adapter, import and role-choice gates passed; limits below |
| M3 instances/private useful tools | Implemented for the closed host-tool contract | Schema-10 trusted notebooks/checks cards; acceptance evidence below |
| M4 exact-output Extension Studio | First finite focus-timer profile implemented in source | Exact public artifact, durable review, atomic install and registered-release revocation; see Studio contract |
| M5 trusted integrations/workflows | Not implemented | Requires first-release use and lifecycle decisions |
| M6 verified Orbit Git integration | Not implemented | Requires explicit supported Orbit execution profile |

## Next dependency boundary

M3 should add workspace-scoped extension definitions/releases, project-scoped
instances and separately revisioned private notebook data. Use existing project,
binding and evidence identities and trusted host rendering; do not forward notes
or detailed evidence into network-capable generated frames. Every new optional
contribution must obey recovery hold, including host-rendered contributions;
releasing hold must not re-enable one. Layout/code rollback must preserve later
notes, and incompatible data-schema downgrade must refuse. The next complete
journey is two notebook instances in two projects, independent edits, reload,
disable/revoke, placement undo, compatible update and recovery. Read-only worker
scoping is not an implemented extension SDK or Studio. The M1–M2 release above
did not activate schema 10; the follow-on implementation is recorded below.

## M3 follow-on: persistent project tools

The next source increment adds owner-only trusted notebooks and recorded
checks/review cards. Shared contracts were frozen before exclusive Flash backend,
frontend and migration work; the lead owns store, route and renderer integration.
Schema 10 separates definitions, immutable finite host-release descriptors,
instances, grants, authoritative pane bindings, data revisions, proposals and
metadata-only mutation receipts. Layout remains v1 and contains opaque selectors.

Notebook text stays in private instance data. Compatible renderer repin, placement
undo and instance disable do not roll it back. Recovery hold disables all enabled
instances transactionally and release never re-enables them. Instance grants have
finite host-only scopes; project-generation fencing prevents project re-registration
from reviving an earlier grant. This does not introduce a generic broker or the M4
Describe → Draft → Preview → Check → Review → Install loop.

Local integrated verification:

- Dependency-enabled `npm run check`: **726 tests, 724 passed, 0 failed, 2 gated
  skips**. Log: `/tmp/opencode/orbit-m3-final-check.log`. The source includes the
  pinned actual Hermes and offline RouteTok dependency fixtures. An earlier run
  failed the final fresh-base RouteTok subprocess without useful stdout in its
  assertion; diagnostic output was improved, the isolated **293/293** rerun
  passed, and the final serialized full gate passed. No production-code workaround
  was made for that transient failure.
- Python adapters/contracts/publisher/catalog/portable checks: **58 passed**,
  including exact portable-archive parity.
- Real disposable schema-10 release packaging/launch: **2/2 passed**, including
  identity-bound pointer rollback and incompatible-schema refusal.
- `tests/project-tools.browser.py`: Default and Docking pass against real
  disposable servers. Two-project independent notes, save/conflict/reload,
  intentional empty drafts, edits during an in-flight save, explicit exact retry,
  compatible renderer repin in both directions, disable/configure/enable,
  recovery hold/release, placement undo and late-response revocation are covered.
  Both runs report zero page errors, zero terminal WebSockets, and unchanged
  unrelated terminal/conversation pane identities.
- Existing Project Workbench browser coverage passes in all four variants
  (Default/Docking × ordinary/linked projects); the delayed-load binding-race
  positive control also passes. Chromium **145.0.7632.6**, zero page errors.
- Live-PTY continuity passes **94 transitions per renderer**, preserving retained
  iframe DOM/document nonces and drafts, terminal pane identity and one PTY
  connection; both reach `revision=observed_revision=53` with zero page errors.
- The checks-card browser fixture inserts explicitly synthetic retained evidence,
  review and supersession records into its private database. It verifies real
  non-empty rendering, live updates and supersession rather than treating an
  empty card as acceptance of the projection. No provider or check is invoked.
- Lead inspected Default/Docking manager and notebook screenshots, including
  corrected 430px narrow captures. Default uses the existing Focus control to
  fit its window. Screenshots remain under `/tmp/opencode/project-tools-*`, outside
  Git. Browser acknowledgements, DOM assertions and visual inspection are
  separate evidence.

Remote exact-head CI and packaging acceptance are recorded separately when
complete. M3 has not been deployed to an owner runtime. The separately authorized
schema-8 conversation-history hotfix does not activate these tables or UI. Its
activation was stopped at the owner's request to preserve the other agent's
concurrent theme deployment; no backend restart was performed by this workstream.
No paid-provider acceptance is part of this increment.

## Concurrent theme work and history-fix integration

At the owner's request, the completed theme branch was imported from its separate
checkout and merged with its original commit ancestry intact:

- `c162998448be888635cfb9c10a44e1b722ed9dfd`: Hermes Relay personality, icons and wallpaper.
- `e70f6d413daf1d270b10bf9df4c075036d783738`: MS-DOS personality, icons and wallpaper.

The independently reviewed conversation-history fix is also integrated. Pane-backed
Runs submissions freeze bounded server-loaded user/assistant history before payload
hashing; malformed history and missing established sessions fail before dispatch.
An unmarked absent session requires explicit **New chat**, preserving its draft and
binding. Pinned Hermes does support native Runs history reconstruction; the fix is
cross-version and silent-empty-history hardening, not proof that Runs never reloads
history. See [Hermes](HERMES.md) for bounds and delivery/wake tradeoffs.

The separate schema-8 backport passed **658 tests, 656 passed, 2 gated skips** and
both real-server browser context and cross-mode journeys. The context fixture
advertises native continuation, sends an identical Normal prompt twice, verifies
the earlier completed turn in the second exact Runs body, then verifies Workbench
retains both turns without the unsent draft. Gateway/model endpoints are synthetic;
the cross-mode fixture uses the pinned actual Hermes runtime with a local model.

The other agent's schema-8 `orbit-e70f6d4` deployment is preserved. This source merge
does not deploy M3 or upgrade that runtime to schema 10. A runtime-only
`KillMode=process` override was added to the copied-main service during the
authorized restart preflight so its tmux server is not killed with the backend;
the rollout was then stopped when the concurrent deployment was detected. No
backend restart or pointer activation was performed by this workstream.

Combined-source local acceptance:

- Dependency-enabled `npm run check`: **732 tests, 730 passed, 0 failed, 2 gated
  skips**, including the merged themes and reviewed history implementation.
  Log: `/tmp/opencode/orbit-merged-final-check.log`.
- Python adapters/contracts/publisher/catalog/portable checks: **58 passed** on
  the regenerated merged archive. Real disposable schema-10 release packaging
  and launch: **2/2 passed** on the combined source.
- Both isolated theme browser fixtures pass all **16** personalities and icon
  packs, including Relay, MS-DOS and Nous Atelier. They build disposable source
  copies, use private runtime/HOME/tmux settings and ephemeral ports, verify
  asset responses and preserve layout/pane identities through apply and reload.
  Chromium **145.0.7632.6**, zero page errors.
- Both project-tool renderers preserve the exact notebook editor DOM node,
  unsaved draft and saved data revision/text while applying Relay and MS-DOS.
  Lead inspected synthetic themed notebook/manager screenshots; artifacts stay
  outside Git. The theme fixtures are included in the Workbench CI workflow.
- The conversation-context browser journey passes again on the combined source
  in Default and Docking, including repeated Normal submissions and bounded
  Workbench handoff without the unsent draft.

These are local results; publication must obtain new exact-head remote CI rather
than treating the M1–M2 baseline runs as validation of this merge.

## M3 publication/deployment and parallel CI follow-on

The combined `a15d7eb947d0c5936ce7ac66b5cda0ce49b5fea3` passed both
[plugin CI](https://github.com/mojomast/orbitdesktop/actions/runs/36475557044) and
[Workbench CI](https://github.com/mojomast/orbitdesktop/actions/runs/36475556992).
The authorized release `orbit-a15d7eb` then upgraded the owner runtime from schema
8 to 10 after a private rehearsal and stopped-writer full backup. Activation took
1.6 seconds. All 30 existing tables' rows survived migration; all 79 saved layouts
and revisions, 20 conversation files and three tmux panes were preserved. Both
renderers passed fresh-context HTTPS smoke checks; the owner-authenticated tools
route exposed two definitions/four releases. No paid model turn or personal-pane
interaction was used to establish that result; everyday owner acceptance remains
separate from those measured deployment checks.

`76262c3` splits CI into seven isolated parallel suites with fail-fast disabled and
a required aggregate gate. All suites passed in
[the first parallel run](https://github.com/mojomast/orbitdesktop/actions/runs/36482575086).
Runner wall time fell from **44m42s** to approximately **11m**, with the same tests.
This timing precedes the new Studio browser cases.

## M4 first profile: focus timer

The owner selected a finite local focus-timer generator as the first end-to-end
Studio journey. See [the frozen profile/lifecycle contract](EXTENSION_STUDIO.md).
This is template-backed generation, not Hermes-authored arbitrary code. Public
artifact bytes are previewed, structurally checked and approved by exact digest;
private notebook data is never forwarded. Timer countdown state is memory-only;
code rollback preserves later public instance configuration.

Schema 11 fences older writers that cannot honor permanent registered-release
revocations. It adds no tables and keeps all schema-10 data. This source increment
does not upgrade the live M3 deployment. Exact-head verification for Studio is
recorded separately from the successful M3 and CI-only heads above.

Local first-profile acceptance:

- Dependency-enabled `npm run check`: **740 tests, 738 passed, 0 failed, 2 gated
  skips** (`/tmp/opencode/orbit-studio-full-check.log`). The final frontend build,
  focused Studio tests and both browser journeys also pass after the bounded-record
  and uncertain-HTTP-response refinements.
- **8 focused Studio tests** passed, including the real archived schema-10 reader;
  combined Studio/tools/migration/backup guards passed **24/24**.
- Real publisher, endpoint and portable archive checks: **11/11 passed**.
  Disposable schema-11 release packaging and launch: **2/2 passed**.
- Both real-server Studio browser journeys passed: timer Start/Pause/Reset;
  exact source and preview; parent DOM, storage and fetch denial; stale review;
  committed-but-lost response (transport abort and HTTP 503) and identical retry
  after reopening; update and
  code rollback preserving later configuration; hold/release and revocation.
- Lead inspected synthetic preview and narrow-dialog screenshots under
  `/tmp/opencode/orbit-studio-*`. Narrow inspection found a global button-style
  override of the native `hidden` attribute; Studio now explicitly hides retry
  controls when no request is pending. Both browser journeys and the final build
  passed after that correction. No private owner screenshot or model call was used.
