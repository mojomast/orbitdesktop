# Comet Project Workbench — implementation ledger

Current extension: [agent-loop hardening ledger](WORKBENCH_AGENT_LOOP_LEDGER.md).
The B/C results below are historical baseline evidence, not acceptance of that extension.

## Active increment — B + C (starting at c553778)

Owner authorized parallel implementation of one-shot context sharing and managed
candidate execution/evidence. Shared interfaces were fixed before delegation:
private SQLite schema-6 records via `WorkbenchData`, owner-authenticated dedicated
routes, shared serial runtime gate, immutable snapshot IDs and candidate hashes.
No layout-v1 migration, owner deployment, restart or credential borrowing.

- Flash `ses_f24769b20ffe4LCjUnDLMgcMa7`: B context/Hermes adapter/tray, owns new
  context modules, agent binding integration, and its scoped tests.
- Flash `ses_f24760ccdffeFugNKSb0n2Pyoo`: C candidate/check/job/evidence/review UI,
  owns execution modules, staged legacy queue adapter, and its scoped tests.
- Lead owns shared persistence/migrations, route/auth integration, terminal source
  mapping, normal Inspector integration, contracts/artifacts/docs and independent
  release checks. Supporting reviewers get non-overlapping file ownership.

Both actual GitHub workflows for the starting SHA now pass: plugin run
`36211424601`, Workbench/browser run `36211424626` (including Python 3.11 browser
execution). The older follow-up notes below describe results before CI finished.
### B/C integrated verification (local, completed)

- Independent isolated `npm run check`: **388/388 Node tests**, zero failures,
  skips or TODOs; generated contracts, TypeScript and production build pass.
  Log: `/tmp/opencode/comet-bc-final-check.log`.
- Python adapters/publisher/catalog/portable-source checks: **55/55**, including
  regenerated archive parity. All Python fixtures parse using Python 3.11 syntax.
- Real Node/SQLite browser tests pass **default and docking** for context sharing,
  managed execution, and the joined failed-check → exact share → owner-applied
  candidate repair → passing check → exact human review workflow. Each joined
  journey has one synthetic gateway POST, zero page errors and zero terminal
  connections. Shared bytes occur exactly once in the recorded payload; durable
  request hashes and project/task/attempt/candidate references agree.
- Context journeys: 20 API responses, one Stop request, one synthetic POST per
  renderer. Execution journeys: 19 responses and measured fail/pass verdicts.
- Inspector regression passes both renderers: 20 responses, no agent requests or
  terminal connections. Live-PTY continuity: **94 transitions per renderer**,
  revision/observed revision **53/53**, `browser_applied=true`, zero page errors.
  Real-server recovery/hold regression also passes.
- Independent authority tests use real SQLite; the final cleanup regression swaps
  a job temporary directory for an external symlink and verifies external data is
  preserved. Temporary cleanup now uses bounded descriptor-relative traversal.
- All three Flash workstreams and descendants finished; lead independently reran
  integration after freeze. No deployed service restart, migration or token
  rotation was authorized/performed. Current GitHub publication is recorded below
  when available; local fixtures do not establish deployment acceptance.

**Limitations:** real-Hermes installation/capability acceptance is still blocked
on separately authorized credentials/budget. Browser upstream is explicitly
synthetic. Reusable runtime tools remain blocked; repair uses an owner-reviewed
patch bridge. Integration into the original worktree is unsupported. The trusted
host job lane has no filesystem/network sandbox or disk quota. Escaped descendants
are not contained; detected survival is inconclusive. Context expiry cannot erase
old backups/WAL pages or recall upstream conversation content.

**Verification-wrapper incident:** a missing optional `LICENSE` file made a copy
step fail, and a wrapper without fail-fast handling fell through to rebuilding
checkout `dist`. No server was restarted. The previously verified `78b6a8f`
entrypoint and referenced assets were restored atomically; entrypoint SHA-256
`dc62f47d8dc59c798d2c032b38a98882e3838b8e208de15476d3aa5fa3e5d3ed`
matches the known pre-task baseline. The corrected wrapper uses `set -e`, an
explicit existing-file list and nonempty/distinct-root assertions. The final
388-test build ran in `/tmp/opencode/comet-bc-final-2f5s1kkq`, not the checkout.

### Publication follow-up

Integrated increment published as `4b8d3c4`. Its Workbench CI run `36214123941`
failed because checks assumed `/usr/bin/node`, whereas setup-node installs Node
under the runner tool cache (real command exit 127). Follow-up pins the server's
absolute `process.execPath` in the immutable check definition and adds a regression
assertion. No fail/pass or cancellation assertions were skipped or relaxed.
Follow-up `4a730aa` passed Node/Python gates; run `36214225213` then exposed
an Inspector reload waiting for `networkidle` while workspace streams/polling
remain connected. Fixtures now wait for DOM load followed by their existing
explicit connected/application assertions, rather than incidental network silence.
Run `36214534334` exposed a response-listener race: reading JSON inside the
Playwright callback could yield before app assertions consulted the recorded
response. The Inspector fixture now records response headers synchronously and
reads bodies when asserting them; no product assertion or status check is removed.
Run `36214762041` passed Inspector/continuity/recovery and all default B/C journeys,
then caught a redundant fixture `shared_chat` request racing the actual pane's
initial bind (409 busy). Context/joined fixtures now await and assert the actual
normal-UI binding response instead of issuing a second competing bind.

## Starting point (2026-09-26)

- Branch: `testing/orbit-docking-managed-terminals`; inspected HEAD
  `78b6a8f2eb35ff05db009ba1cc2b06bcdd974792`; clean working tree at start.
- Existing: workspace/layout v1, SQLite schema 4, owner-managed terminal controls,
  opt-in durable docking, per-pane Hermes profile/session selection. Terminal
  owner observation is **not** permission to disclose to a model.
- Historical evolution handoffs are not current source truth. GitHub runs
  `36204972433` (78b6a8f) and `36193836614` (3fec20e) both failed the real-tmux
  resource-identity test. Ubuntu 24.04 has tmux 3.4; local host has 3.5a. A held-
  shutdown reproducer fails on both versions: `kill-server` acknowledges before
  exit, so the next lookup can receive `server exited unexpectedly`. The test now
  waits for observed server exit, with a hard deadline, before asserting absence.
  It does not swallow this error or retry the assertion until green. Isolated
  baseline from `git archive 78b6a8f` plus this fix: **278/278 Node tests**, build
  passed; CI Python plugin suite **10/10**. New GitHub CI remains to be observed.
- No owner runtime, gateway credentials, live workspace, or personal browser
  profile may be used. Baselines/builds/tests use disposable directories and
  private tmux sockets. No live migration, restart, deployment or main merge.
- The agent environment has no `ORBIT_RUNTIME_DIR`, `HERMES_API_URL`,
  `HERMES_API_KEY` or `HERMES_PROFILES_JSON`. Owner service configuration was not
  read or borrowed. This does not imply the owner's gateway is unconfigured;
  authorized real-Hermes capability/smoke acceptance remains pending.
- Baseline synchronization fix committed separately as `4f6cd7d`.

## Ordered slices and gates

1. **A — implemented and locally verified:** strict project/resource/binding records outside layout;
   explicit root registration; confined bounded file reads and content identities;
   normal-UI inspector, real status/diff, stable bindings and Doctor; migration,
   adversarial filesystem and both-renderer browser gates.
2. **B — pending:** one-shot context tray and recipient/configuration-bound consent;
   exact private snapshots and durable disclosure/submission receipts. Real Hermes
   delivery requires separately permitted credentials/budget; no owner borrowing.
3. **C — pending:** migrate serial queue semantics, candidate/check identities,
   managed jobs and recorder evidence; ambiguous dispatch never blindly replayed.
4. **D — pending:** supervision, recipes, review/integration conflicts and full
   release acceptance. No swarm or parallel runtime dispatch.

The full requested workflow is not complete merely because Slice A is usable.
Reusable agent resource tools stay disabled until authenticated request-scope
binding is proven. Worktrees and owner-UID processes are not sandboxes.

## Delegation ledger

- Flash `ses_f24b92e3bffetlZ5yi67UF02Qs`: CI/baseline, adversarial tests and browser
  workflow — completed; all workers finished.
- Flash `ses_f24b8f4d9ffeLXVx311FlNqAhi`: seam discovery, normal UI and browser
  fixture — completed; all workers finished.
- Flash `ses_f249d68d7ffePGvasuSSj7qI4l`: bounded raw-Git/diff provider and additional
  adversarial tests — completed; all workers finished.
- Flash `ses_f24a22552ffeD864e6rUVTDttI`: independent continuity/recovery regression
  checks — completed; final frontend build passed; all workers finished.
- Lead: shared contracts, schema migrations, project provider and integration.

## Evidence

Baseline log: `/tmp/opencode/orbit-verify-78b6a8f-check.log`.
Slice A parent tests currently cover registration expiration/root replacement,
stable IDs/stale file snapshots, cross-workspace/controller denial, descriptor
symlink race/hardlinks/FIFO/large-file rejection, private Git materialization,
bindings/whole-state sync separation, and schema-4 backup/5 migration. Browser
integration, adversarial review, and final isolated combined check are in progress.
No real-agent acceptance claimed. The final isolated `npm run check` passes
**309/309 Node tests**, with **zero skips and zero TODOs**, including the new
registration revocation/late-result, immutable-binding-ID reassignment and malformed
filename alias regressions. Log: `/tmp/opencode/comet-slice-a-final-check.log`.
Frontend build SHA-256:
`a2f1faa8b93bd1282b5664bc6731c13f691e2f30469367809bdcf818fd9a1786`.

Both Workbench browser fixtures pass **20 API responses, zero page errors, zero
agent requests, zero terminal connections**. They additionally prove registration
revocation survives a disposable server restart, old previews cannot be approved
after restart, and fresh reapproval retains the project ID. Independent live-PTY
continuity passes **94 transitions under each renderer**, revision **53/53**, with
`browser_applied=true` and zero page errors. Real-server recovery/hold passes.
Logs: `/tmp/opencode/cw-logs-final/{continuity-default,continuity-docking,recovery-real-server}.log`.
Chromium **145.0.7632.6** only; Firefox/WebKit continuity is not claimed.

GitHub CI now includes both Workbench renderers, live-PTY continuity under each,
real-server recovery, Node contracts/migration/adversarial tests, and the eight
Python publisher/adapter/archive suites. Only masked synthetic screenshots are
uploaded on failure. Query the published commit's actual workflow status; these
local results are not a claim that an unobserved GitHub run passed.

All eight Python publisher/adapter/portable suites pass **55/55**; archive parity
passes after regenerating `hermes-plugin/orbit-source.tar.gz` with the new tracked
sources. Logs: `/tmp/opencode/comet-slice-a-python.log`,
`/tmp/opencode/comet-slice-a-{default,docking}.log`. All delegated workstreams and
their descendants are complete. Slice B is next; there is no authorized configured
real-Hermes endpoint in this execution environment, and no live-agent gate was run.

Parent served-browser checks passed under default and docking: real synthetic
Git defect/diff, registration, stable IDs/reload, stale explicit file refresh,
line selection and text sizing, metadata bindings, private-data exclusions and
Doctor, persistent revocation, disposable service restart and fresh reapproval;
zero agent requests / terminal connections / page errors. An unrelated
published iframe kept its DOM identity, document nonce and draft through open /
close. Review additionally found an unbounded directory-only traversal; it now
has tested global entry/directory budgets (no TODO/skip). The hardened provider
uses only raw Git-object reads plus bounded `/usr/bin/diff`, with enforced
address-space/CPU/descriptor and time/output limits. Binary/historical large blobs
and oversized historical trees are withheld, not accidentally inflated into UI.

An early local verification wrapper failed while copying an optional absent
`LICENSE`, then erroneously continued to `npm run check` in the checkout. It did
not start a server or touch an owner runtime, but did rebuild checkout `dist`.
That run is **not** claimed as isolated evidence. The wrapper was corrected to
fail immediately and require a distinct disposable working directory; subsequent
integration and browser checks build only disposable copies.
The accidentally replaced checkout entrypoint was restored atomically from the
independently built `78b6a8f` baseline after verifying its SHA-256 exactly matched
the pre-task `dc62f47d…` build; its referenced baseline assets were restored too.
No server was restarted or browser reloaded. Workbench build evidence remains in
disposable copies; the checkout's existing served entrypoint is not the new build.

## Deployment-agent report and CI follow-up

The owner relayed successful isolated deployment acceptance for `7a4fc17`: a
consistent schema-4 pre-upgrade backup (`integrity_check` OK), schema-5 migration,
matching `a2f1faa8…` frontend, 309 Node / 55 Python tests, both Workbench renderers,
both 94-transition live-PTY gates, recovery, and 12/12 deployed-origin checks.
These are **deployment-agent reported results**, not a second inspection by this
checkout. The private screenshot and deployment host details are not copied here.
The isolated service is transient across host reboot; credential separation and
startup logging remain operator concerns reported by the deployment agent.

Actual GitHub status for `7a4fc17`: plugin run `36210612154` **passed**; Workbench
run `36210612310` **failed** (308/309), before Python, in the real-server cleanup
replacement fixture. That fixture injected `kill-server` then immediately started
the replacement; it now waits for the original PID's observed exit before issuing
the replacement command, keeping all destructive ownership checks intact.

The reported Python 3.11 parser failure is also fixed: the continuity diagnostic
computes its saved-state expression outside the f-string. CI now parses all Python
test files before the expensive gates. Actual Python 3.11 parsing passes locally;
Playwright is only installed in the existing Python 3.13 environment here, so the
local browser result is not represented as a Python 3.11 runtime pass.

Follow-up verification: isolated `npm run check` **309/309**, provider tests
**18/18**, and both continuity renderers **94 transitions / revision 53/53 / zero
page errors**. The first combined shell command hit its 120-second tool deadline
after default passed, interrupting docking; docking then completed with a larger
deadline. Logs: `/tmp/opencode/comet-ci-followup-{check,default,docking-complete}.log`.
No deployment, live restart, token rotation, stash operation or owner-runtime
access was performed by this checkout during this follow-up.
