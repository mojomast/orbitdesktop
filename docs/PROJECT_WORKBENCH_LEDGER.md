# Comet Project Workbench — implementation ledger

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
