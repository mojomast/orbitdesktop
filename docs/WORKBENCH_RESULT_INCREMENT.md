# Comet task results, provenance and safe handoff

## Inspected baseline

- Owner checkout `/home/mojo/projects/orbit`: clean, branch
  `testing/orbit-docking-managed-terminals`, SHA
  `5b31fdaba1f867eeaf7b0aa30438f096a55b54f6`.
- Baseline CI: Workbench `36220879554` and plugin `36220879552`, both successful.
- Existing native loop, schema 7, complete-check review, linked-root registration
  and dependency-bearing deterministic runtime acceptance are preserved baselines.
- Owner checkout, served assets and runtime are protected. Integration is in
  `/tmp/opencode/comet-next-integration`, branch `workbench/next-integration`.

## Exact workers and ownership

Local OpenCode agent aliases were read from the configured `agents` entries and
model availability confirmed through the supported model catalogue. No inferred
API IDs or substituted models:

| Requested worker | Configured agent / model | Worktree / branch | Session |
| --- | --- | --- | --- |
| GPT Sol | `worker-sol` / `openai/gpt-6-sol` | `/tmp/opencode/comet-next-sol` / `workbench/next-sol` | `ses_f21f90ef9ffeygExjQQpw0goLO` |
| GPT Luna | `worker-luna` / `openai/gpt-6-luna` | `/tmp/opencode/comet-next-luna` / `workbench/next-luna` | `ses_f21f8cbecffe7Sgqt5EvpMyGUW` |
| DeepSeek Flash | `worker-flash` / `deepseek/deepseek-flash` | `/tmp/opencode/comet-next-flash` / `workbench/next-flash` | `ses_f21f879f3ffeDgJ61tycNG77Rn` |

All four worktrees began at the same baseline. No recursive workers. Separate
temporary HOME/runtime/database/ports/tmux/browser/build directories are mandatory.
Heavy tests serialize on `/tmp/opencode/comet-next-heavy-check.lock`; source work
and lightweight checks remain parallel. Tooling now uses private dependency
copies per lane; see the shared-symlink incident and mitigation below.

- **Sol:** `hermes-plugin/workbench.py`, native runtime/service, execution/data,
  SQLite migrations and authoritative source contracts; new result/provenance
  tests. Environment provider changes only in wave 2.
- **Luna:** existing task authority/execution/workflow frontend modules, new
  task-result component, workflow/patch provider and dedicated UI/patch tests.
- **Flash:** CI, independent result-boundary/runtime/browser evaluation fixtures,
  isolated verification/release scripts and separation tests. Packaging source
  scripts are Flash-owned; archive regeneration is parent-owned.
- **Parent only:** `server/index.mjs`, `src/project-workbench.ts`,
  `src/agent-chat.ts`, `src/workspace-extensions.ts`, package/lockfiles,
  generation script/artifacts, portable archive and current capability docs.

## Schedule and gates

1. Parallel short contract audits: Sol proposes trusted result/provenance;
   Luna supplies consumer fields; Flash independently reproduces both findings
   and specifies observable acceptance. Commit the agreed baseline before
   dependent implementation, then fast-forward all clean lane branches.
2. Parallel result/provenance, handoff/result UI/patch, and independent harness /
   build isolation work. Integrate schema/contracts before consumers.
3. **Gate 1:** actual pinned Hermes, deterministic model, real private channel,
   SQLite/check providers, visible explanation/provenance and reload on both renderers.
4. Parallel representative-project extension, patch round-trip/review placement,
   evaluation/release tests. Cross-review by the other assigned models; owners fix.
5. **Gate 2:** final integrated regressions and separate disposable-release gate.
   Reports are not acceptance; all evidence binds its actual source/build/runtime.

Live-model evaluation is **unrun** by explicit user choice. Six concrete case
families are prepared without product-model inference.
Owner deployment/activation, runtime migration, token rotation and main merge are
not authorized. A disposable activation test does not authorize owner activation.

## Current status

### Latest verification checkpoint (source `1c99936`)

Full parent `npm run check` passed contract generation, isolated build and
**560 Node tests, zero failures, one explicitly gated disposable-release skip**
with `HERMES_NATIVE_SOURCE` enabled. Log:
`/tmp/opencode/comet-next-final-candidate-check.log`.

Flash's `GATE2_FINAL=1 L4_GEOMETRY=1` journeys passed both renderers on
`1c99936`, preserving an explicitly owner-arranged unrelated float, its live
iframe document nonce and unsaved draft, with revision acknowledgement and exact
Return restoration. A newer owner sync refuses Return. Both recorded seven
deterministic requests, one chat message and zero page errors. Strict CI is
enabled. Parent inspected both masked screenshots and confirmed visible actual
diff and check verdicts. Inspection also caught an explanation lookup defect:
the view expected `task_id` on a native grant, which instead identifies its
attempt. That producer fix and a literal-text browser assertion are pending;
the earlier heading-only assertion did not establish explanation availability.

The full disposable release/archive/final-source run and merged-provider
lost-reply recovery acceptance remain pending. Live-model trials remain zero.

Subsequent independent real-provider tests confirmed lost-reply replay and
revoked-project DB-only settlement, but exposed a re-registration fence gap:
old artifact bytes and available receipts became accessible under the project's
new generation. Parent reproduced the failure in
`tests/workbench-recovery-boundary.test.mjs`; the generation-fence fix is pending.
Strict Review tests now require literal recorded explanation text instead of
just a heading and intentionally fail on the lookup defect above. Thus the
earlier 560-test pass is checkpoint evidence, **not a green final-source gate**.

### Earlier integrated checkpoint (after `b45ee86`)

- Gate 1 is accepted. Checked patch export also passed intermediate strict
  `GATE2_FINAL=1` browser journeys on default and Docking against `a417f2b`:
  exact downloaded hashes, frozen required checks, persisted receipt discovery
  without an ID fallback, and retrieval after reload. Each retained seven
  deterministic model requests, one chat message and zero page errors.
- The project-bound trusted Review pane mounts through explicit owner controls,
  and repeated opening reuses its pane identity. Parent inspected the synthetic
  screenshots. Metadata obscured the diff/check verdicts, so mounting is accepted
  but useful Review placement is **not yet accepted**.
- Sol's revoked-project recovery fixes are integrated as `ff18aff`; independent
  parent execution/result/native tests passed **48/48**, with actual Hermes
  enabled and no skipped tests. Observed artifact recovery after revocation is
  inconclusive rather than publishable; historical intervention does not restore
  text disclosure or execution authority. Cursor contracts are generated.
- Luna's remaining consumer fixes cover reachable cancellation, historical
  recovery controls, older receipt pagination, literal patch preview and useful
  Review geometry. Flash's strict `L4_GEOMETRY=1` acceptance remains pending;
  its pre-placement visibility and browser-ack assertions are being corrected
  before final-source verification.
- Final full-source checks, portable archive regeneration/parity and disposable
  release-instance repetition remain pending. Product-model trials remain zero.

The following entries retain the chronological integration history; earlier
pending-work statements describe their recorded checkpoint.

All three requested aliases completed their initial contract/audit phase. Sol's
contract-only `b76b6e8` was integrated as `a1fa0f7`; the ownership ledger baseline
is `99a1990`. Worker branches received that shared contract baseline, preserving
Sol's original commit with a merge. All three implementation lanes are active.

Flash independently ran the actual pinned runtime baseline: existing fixture
7/7 passed; the new boundary regression produced one pass and two expected
failures (lost final response and owner attribution on native checks). The
separate two-attempt Python runtime test rejected the host terminal fallback.
Sanitized logs live under `/tmp/opencode/comet-next-flash-scratch/`.

The representative real-project selection is the maintained Orbit agent-profile
subproject at `5b31fda`: `server/agent-profiles.mjs` and its existing
`tests/agent-profiles.test.mjs`. This is an explicit selected subproject, not a
claim of full-repository executable capture. Its existing meaningful tests need
only Node built-ins. Selection/profile implementation and acceptance are pending.

The user explicitly chose **Keep live gate unrun**. No real-model trials will
be admitted in this increment. Deterministic acceptance remains a separate gate.

## Independent review findings during integration

Flash's first implementation produced five scoped commits (`607b30b`, `497f068`,
`fb50d52`, `b8c756b`, `0366eca`). Parent integrated the independent regression /
evaluation catalogue and pinned subproject fixture as `578f9c6` and `6b607ad`.
Release/browser integration is held for owner-applied fixes:

- Manifest canonical serialization omits nested keys; parent reproduced changing
  `compat.schema_max` without changing the digest and getting `ok:true` in a
  disposable fixture `/tmp/opencode/comet-release-review-MGWq1m`.
- Manifest verification needs exact inventory, required-component, path/mode and
  ancestor-symlink checks, plus complete compatibility metadata.
- Default SQLite opener is asynchronous but the schema reader calls it
  synchronously; acceptance needs the real default SQLite path/opener.
- Pointer selection needs canonical runtime/release separation and an actual
  physical-release launcher. An arbitrary old server's HTTP 200 cannot prove
  activation of the selected release.
- Default scratch creation precedes protected-root validation; empty/missing
  path arguments and source/destination collisions need pre-write rejection.

These are pending review findings, not accepted release capability. The assigned
Flash owner is applying fixes and regressions. The generic failing-evidence and
candidate-CAS tests are baseline coverage; they do not yet prove contradictory
delivered explanations or moving-target patch export.

## Integration evidence and tooling incident

Sol's initial S1/S2 commits are integrated as `4779afb` and `3aee029`. Parent
independent verification passed **51/51** native/result/provenance/five-finding/
execution-loop tests with the actual pinned Hermes enabled, plus the separate
Python two-attempt runtime test. Follow-up recovery and disclosure review fixes
remain pending; these passes are not final acceptance.

Flash's reviewed release/build fixes and concrete evaluation fixtures are
integrated through `7713101`. Parent independently passed **24/24** build/release
boundary, fixture setup and pinned-subproject tests. An ordinary `npm run build`
completed into `/tmp/opencode/orbit-isolated-build-85766ad9-7c6f-462d-81a8-c59f7efaa8b5`.
No checkout build was used. A running disposable release gate remains pending.

Luna's result/patch commits are integrated through `03ef306`. Parent mounted the
result panel in normal Project Workbench and added exact evidence/candidate
navigation callbacks. TypeScript and **7/7** patch/workflow tests pass. Handoff
completion, historical candidate reader, real UI and patch cross-review remain
pending.

### Dependency permission incident (2026-09-26)

Flash's **unintegrated** release-package fixture called `unlockRelease` on a test
base containing a symlink to shared owner dependencies. Its recursive chmod
treated the symlink as a file and followed it, changing only
`/home/mojo/projects/orbit/node_modules` from the worker-observed `0700` to `0644`.
Parent observed TypeScript/Node import failures, stopped permission/release work
and notified all workers. Flash confirmed the exact call and single-path change.

Parent restored only that directory's confirmed original `0700` mode. Adjacent
dependency directories remained `0700`; AJV/SQLite imports and subsequent checks
passed. No recursive permission repair, dependency installation, service restart
or owner cleanup was performed. All **181** served asset files still match the
pre-increment SHA-256 manifest. The faulty `07af700` package commit is held out of
integration. Only private sentinel-based permission regression tests are cleared
until the fix is independently reviewed. Evidence is retained under
`/tmp/opencode/comet-next-flash-scratch/`; no raw transcripts are committed.

Further inspection found Vite's `.vite`/`.vite-temp` caches beneath the shared
dependency symlink, so the intended read-only use was not structurally read-only.
Parent copied installed dependencies locally into distinct
`/tmp/opencode/comet-next-{integration,sol,luna,flash}-private-deps` trees (no
install/network) and atomically repointed each worktree's dependency symlink.
Future fixture/cache writes are lane-local. Owner caches were preserved, not
deleted. This supersedes the initial shared-tooling setup.
Each private dependency path resolves to its own
`comet-next-<lane>-dependency-root/node_modules` directory, preserving Node and
TypeScript sibling-package resolution. An initial copy-root naming error caused
one TypeScript module-resolution failure; the directory layout was corrected and
TypeScript passed without changing package bytes or source declarations.
The copies also contained a nested `node_modules` symlink back to the owner
dependency root. Parent removed that link from the four private copies and
verified TypeScript again. The corresponding owner-tree link has an increment-
window timestamp but its creator is not established; it was preserved rather
than removed without provenance. No remaining private dependency link resolves
into the owner tree.

### Renderer evidence correction

Flash reported two API-browser runs labelled default/docking. Parent source review
found the renderer argument was only used in reporting; navigation omitted the
docking query. Those runs therefore do **not** establish docking acceptance.
The fixture must select and assert the actual renderer before new evidence counts.
Those historical runs do not count toward Gate 1; worker reports alone do not
satisfy it. The corrected fixture selects and asserts the installed renderer.

## Gate 1 accepted; Wave 2 active

On integrated source `5e2abdf`, parent independently ran
`tests/workbench-results-ui.browser.py` for **default and docking** with the
actual pinned Hermes and a deterministic loopback model. Each run reported the
matching actual renderer, UI handoff and result panel, **7 model requests** and
**0 page errors**. Normal UI controls created the task/candidate/attempt and
previewed/approved/started the supervised worker. The explicit fresh-worker
packet boundary was visible before consent; the result panel separated the
explanation, recorded checks and human review, then explicitly delivered the
host-authored conversation card. Logs:
`/tmp/opencode/comet-next-gate1-ui-{default,docking}.log`.

Parent also independently ran the corrected API/reload fixture on both renderers:
each observed the actual selected renderer, persisted card, 7 model requests,
unchanged single chat message, native-agent provenance and zero page errors.
Logs: `/tmp/opencode/comet-next-gate1-reload-{default,docking}.log`.

The independent Node suite on the integrated source passed **537/538**, with
**0 failures and 1 explicit skip** (the separately gated release-instance test).
The prior run's 15 failures were resolved through schema-8 administrative CLI
compatibility and isolated static-server fixture fixes, preserving historical
schema-7 backup behavior. Log:
`/tmp/opencode/comet-next-integration-node-second.log`.

Result recovery/historical reads and public newest-first card projection are
integrated. The corrected release package was integrated together with its
symlink/hardlink/path safety fixes, after parent **24/24** private permission,
minimal-package and release-boundary tests passed. The earlier hold on the
faulty package implementation is superseded by those fixes. Flash reports a
passing disposable release-instance gate; final-source parent verification is
still required. True contradictory-explanation and moving-source patch boundary
regressions are integrated.

Wave 2 is authorized in the same three worker lanes: Sol's pinned real-project
journey/private credential configuration and recoverable artifact verifier;
Luna's checked private patch publication and useful Review arrangement; Flash's
independent integrated patch/project/release acceptance. Gate 2, final full checks,
portable archive regeneration and final capability documentation remain pending.
Live product-model evaluation remains **unrun** by explicit user choice.

### Wave 2 integration evidence (not final Gate 2)

- Parent independently passed **25/25** execution/artifact-recovery and pinned
  real-project tests after integrating `b1f56c5`. The selected two-file project
  runs through actual Hermes, meaningful failure, repair, existing structured
  tests, human review and separate artifact verification. No new dependency
  profile was necessary.
- Parent independently passed **2/2** disposable release-instance tests on build
  `7b3a4418bd54dbb5710102e0f9a54000655e8aa817b3128f94b94b1c8811eeb9`,
  Node 22.23.1 / ABI 127 / schema 8: physical-process pinning across pointer
  changes, failed-probe restoration and downgrade refusal. Newer source still
  needs final verification.
- Python checks passed **59/59** (32 discovered runtime/plugin/bundle/contract
  tests, 6 publisher tests, 18 catalog tests, 3 telemetry tests). The real-server
  recovery browser gate also passed with broken-renderer and bad-app fixtures.
- The retained full native-workflow browser fixture failed before attempt
  creation; Flash is diagnosing that regression without removing its dependency
  profile, complete-check or continuity assertions. The new Gate-1 result fixture
  is not a substitute for this older gate.
- Private key-file configuration is integrated, but parent review found the
  normal startup metadata path did not resolve the same key snapshot as runtime
  creation. Sol owns the correction and integration regression.
- Browser download/apply tests are integrated with unrelated-file sentinels and
  explicit unchanged message/model counts. Their final verifier/receipt-discovery
  assertions remain gated pending Luna's checked exporter integration.

Follow-up resolutions: private-key startup snapshot fix `c217cd4` passed the
parent's **9/9** actual-Hermes/native/real-project run. Flash's native-fixture fix
waits for authority refresh completion and selects the current three-part workflow
option; it preserves all old assertions. Parent independently reran the existing
native browser journey on **both renderers**, each with 8 model requests,
6 completed tool calls, fail→pass evidence, dependency-profile execution, recipe
revision 1→3, unchanged original source and zero page errors/external requests.
Logs: `/tmp/opencode/comet-native-browser-{default,docking}.log`.

Flash's retained-browser run on snapshot `4ef4a93` passed project inspection
plain/linked (4 runs), context (2), execution (2), joined workflow (2), and live
PTY continuity (2, 94 transitions each). The stale Doctor fixture expectation
was updated to schema 8 without changing its remaining assertions. Logs are
under `/tmp/opencode/comet-next-flash-scratch/`.

Parent integrated exact-pointer restoration on failed release activation or
rollback, including preservation of the previous-release reference and
idempotent same-release activation. Independent release-boundary tests passed
**14/14**. CI now supplies the pinned Hermes path to the full Node gate so the
new result-boundary and real-project cases execute; the separate actual-runtime
step retains Python isolation coverage without repeating the same Node cases.
