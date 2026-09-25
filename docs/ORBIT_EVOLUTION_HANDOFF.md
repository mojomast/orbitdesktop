# Evolution handoff — September 25, 2026

## Latest increment: connected surface-runtime reconciliation

Layout and plugin schemas remain v1; SQLite remains schema 3. This increment does
not migrate a runtime, install a docking library, or change permissions. No live
service was restarted and nothing was pushed or deployed.

- Stable pane-ID views now move between connected layout slots, with connected
  parking before old containers are removed. Native `Element.moveBefore` preserves
  connected iframe documents; the explicit fallback cannot promise that behavior.
- CSS3D anchors connect before accepting retained views and are pruned in Windows
  mode too. Pane callbacks find their current monitor rather than a captured one.
  Runtime replacement is keyed on kind and browser URL, not irrelevant terminal URLs.
- Explicit imports/presets still replace views. Import now reconciles view classes,
  existing same-ID spatial anchors, camera and appearance. Confirmation text no
  longer incorrectly claims a detached persistent tmux shell has been terminated.
- `ORBIT_TMUX_SOCKET` and `ORBIT_TMUX_CONFIG` allow isolated server/PTY tests; history
  capture uses the provider's same socket. Production defaults are unchanged.
- [Docking evaluation](DOCKING_EVALUATION.md) records exact npm metadata, licensing
  boundaries and required adapter experiments. No candidate has passed an Orbit
  bake-off; `Element.moveBefore` is not a cross-browser compatibility guarantee.

Verification: `npm run check` builds and passes **181/181 Node
tests**. `tests/runtime-import.browser.py` passes same-ID spatial import, imported
Windows visibility and removed-anchor cleanup. Existing Chromium recovery fixture
**13/13**, real-server recovery/hold, and built-UI scoped events/indexed bundle
restore tests pass. Eight Python suites pass **55/55 tests** after regenerating the
source archive; archive parity and portable-endpoint checks were repeated after
final documentation. `npm audit` reports zero vulnerabilities.

Lead reviewed and extended the continuity fixture, then independently reran it:
**93 browser-only / 94 PTY transitions passed** in Chromium 145.0.7632.6. Two iframe
documents retain nonce, unsaved draft and DOM identity through view/focus/minimize,
split/reorder/swap, appearance, source-window deletion/reparent and checkpoint
restoration. PTY mode retains its pane DOM, single WebSocket, and fresh shell
variable/PID output, including irrelevant terminal URL edits. URL-change and close
negative controls pass. No pre-fix baseline or live conversation-binding test exists.

Continuity evidence and reproduction commands belong in
[runtime continuity](RUNTIME_CONTINUITY.md). Browser reload, explicit import/preset,
URL/kind changes and disposal are not promises of unsaved draft recovery. Cross-document
popouts, Firefox/WebKit, persistent app data and live Hermes/native integrations
remain separate gates. Actual adapter comparison, accessible docking commands and
stable runtime/placement interfaces precede a docking-library or v2 schema choice.

Delegation ledger:
- `ses_f25fb1277ffetZpCIjeECrf6qI`: renderer implementation — complete.
- `ses_f25f7a074ffeTgi18I6RthW4K1`: independent lifetime review — complete;
  import visibility, semantic URL replacement and stale-anchor findings fixed by lead.
- `ses_f25fac7c9ffeezFQY7k73051l7`: isolated continuity fixture — complete;
  lead added appearance, irrelevant terminal URL and source-window deletion cases.
- `ses_f25eac593ffebm8Rf7dpG81E4I`: independent resource authority proposal — complete;
  design only, no privileged API implementation or live integration activation.

All children and their descendants are complete. The parallel work produced
[resource authority proposal](RESOURCE_AUTHORITY_PROPOSAL.md), grounded in the actual
terminal/browser/native/controller routes. Its first proposed slice is an exact-resource,
bounded terminal observation to trusted owner UI, not plugin/model forwarding.
Provider incarnation proof, stale-backup grant quarantine and future egress/subject
authentication require explicit decisions before implementation. These protections
are proposed, not delivered by the renderer changes.

## Historical increment: bundle index and scoped event delivery

This supersedes schema/event/bundle status in the older sections below. **SQLite is
now schema 3; serialized workspace layout and plugin manifests remain v1.** No live
runtime was migrated, no service restarted, and nothing was pushed or deployed.

Implemented in parallel:
- A SQLite bundle/file index with publisher-compatible hashes, explicit startup/admin
  refresh and indexed `app_versions`. Normal workspace reads no longer recursively
  scan application directories. The publisher validates exact reuse and registers
  bundles via the local Node CLI; the generic publisher cannot overwrite hash slugs.
- Indexed new/activated relative bundle-reference validation at the store boundary.
  Existing broken refs cannot trap disable/recovery edits. HTTP serving of hash-addressed
  bundles checks exact file bytes against stored digests, including stale-index cases.
  Legacy nonhashed apps remain compatible but unverified. Database backup includes
  metadata, not app bytes; retain those directories separately.
- Retention inventory includes current records, all retained revisions/checkpoints,
  disabled plugin manifests and saved split panes. Absolute app URLs conservatively
  retain matching local slugs without claiming remote verification. **Cleanup is
  dry-run only**, even with confirmation: no destructive GC is shipped.
- Owner/capability-authenticated finite POST event pages, filtered by workspace before
  limit. Last-1000-event retrieval horizon, explicit expired/future-cursor reset,
  strict metadata allowlists and byte/page budgets. This is polling, **not SSE/push**.
  The outbox itself remains unpruned.
- Browser in-memory cursors, bounded catch-up, abortable requests, coalesced sync hints,
  existing state-polling fallback, and pagehide/pageshow suspension/resumption.
  Callback errors request snapshot reset instead of replaying one event forever.

Migration: schema 1/2 upgrades transactionally on core/admin store open. Bundle
refresh/publication refuses older schema rather than silently upgrading a running
old deployment. Stop old writers and arrange terminal preservation before cutover.
Schema 3 backups and restores preserve recovery policy/receipts and bundle metadata.

Verification: build and **174/174 Node tests passed**, no skips, including schema-3
SIGKILL rollback, publisher-to-live-index integration, modified-byte serving refusal,
checkpoint-pinned version restore, retention, scoped cursors and client lifecycle.
Eight Python adapter/publisher/archive suites passed **55/55 tests**, including
regenerated source parity. Chromium fixture recovery **13/13 passed**; real broken-renderer
recovery/hold passed. The normal built UI test passed actual scoped event delivery,
publish/render of two indexed plugin versions and checkpoint restoration of the
original version. This does **not** prove iframe document continuity. Two browser
harness issues were corrected during testing: response bodies are captured after
request completion, and fixture localStorage seeding runs only in the top frame.
`npm audit`: zero vulnerabilities.

Logs: `/tmp/opencode/orbit-bundles-events-check.log` and
`/tmp/opencode/orbit-bundles-events-python.log`. Reproduction uses existing handoff
commands plus `node --experimental-strip-types scripts/workspace_bundles.mjs
refresh|plan --root /absolute/runtime` for deliberate owner administration only.

All child work and descendants complete:
- Bundle registry/publisher/retention: `ses_f260e58f6ffe1NV0ze0anVZyrg`.
- Event endpoint/client: `ses_f260e0930ffeePlenkwNsLqdU3`.
- Read-only event reliability audit: `ses_f26096facffenSElTFbFmr7h0X`.
Lead integrated schema/store/routes, exact-byte serving, normal UI event lifecycle,
publisher compatibility, cross-module tests, browser verification and documentation.

Next gate: renderer/surface-runtime continuity research and a measured isolated
50-transition iframe/PTY/draft test before selecting docking architecture. Broader
resource grants, safe boot, revocation and broker authority remain unimplemented.
Do not conflate metadata events, content hashes or a registered-plugin hold with
permission isolation. Destructive bundle GC needs its own publication/serving/writer
coordination design; every retained revision currently keeps its references alive.

## Historical recovery-hold increment

### Persistent registered-plugin recovery hold

This section supersedes the recovery-policy and schema status in the historical
transactional-store increment below. Layout remains v1; **SQLite schema is now 2**.

- Owner-authenticated `/api/workspace/recovery` accepts strictly validated
  `recovery_policy` with `held`, `confirm:true`, base revision, operation ID and intent.
  Ordinary browser and scoped controller routes cannot change policy.
- Hold disables registered plugins atomically and is independent record metadata,
  never checkpoint layout. Every committed candidate state is checked under the write
  lock, including full sync, restore and controller replacement. Release leaves apps
  disabled. Unrelated layout edits still work.
- Receipt generations fence old responses after policy transitions; obsolete retries
  return `RECOVERY_POLICY_CHANGED`, not an active pre-hold snapshot. Exact replay is
  now explicitly conditional on unchanged policy generation.
- SQLite v1 upgrades transactionally on open; backups preserve policy; administrative
  restore accepts schema 1/2; export to legacy refuses active holds. Stop old writers
  before upgrade: schema checks cannot eject already-open old connections. No runtime
  upgrade or live service stop was performed here.
- The recovery console shows status/generation and separate confirmed Enter/Release
  controls. Missing policy metadata leaves controls unavailable. Existing disable-all
  remains labeled reversible layout-only behavior.
- Normal sync backs up rejected/uncertain local state and reads rather than blindly
  retrying. `ensureWorkspaceSynced` rejects unresolved saves so dependent actions do
  not proceed on a false success; storage quota failure is reported honestly.

Fresh verification for this increment: `npm run check` **147/147 Node tests passed**,
including a SIGKILL during schema upgrade, hold-preserving CLI restore, rejected legacy
export and unknown-outcome client tests. Eight adapter/publisher/archive Python suites
passed **49/49 tests** against the regenerated portable source bundle. `npm audit`
reported zero vulnerabilities. Browser fixture has **13/13** passing cases. The
real-server browser fixture passed hold/reload, rejection of an enabled-plugin
checkpoint, and release without activation. The normal built UI's initial sync and
sidebar edit also passed against the SQLite-backed server.
No Firefox/WebKit, physical power loss, live Hermes or complete runtime-continuity
claims are made. Logs: `/tmp/opencode/orbit-recovery-hold-check.log` and
`/tmp/opencode/orbit-recovery-hold-python.log`.

This is **not full safe boot**: cached/offline frontends, disconnected frames, direct
static app URLs, arbitrary browser surfaces and host backends are not stopped or
revoked. Plugin-only layouts still have the model's minimum-window limitation on
disable-all/hold; no shell is silently created. The next bounded slice is indexed
immutable bundles and authenticated bounded event delivery, before broader grant/
resource authority and normalized renderer migration. See ADR 005 and RECOVERY.md.

Parallel task ledger (all complete, all descendants finished):
- Backend and policy tests: `ses_f261fe819ffe2pbRWqK72OVmzX`.
- Recovery UI and browser tests: `ses_f261fa223ffewLhfmOviEOXhZ5`.
- Read-only adversarial review: `ses_f261a9f46ffe41EdhOH68S9GFL`.
Lead integrated generated schemas, compatibility tests, client fixes, crash/CLI
tests and documentation. Review findings about unresolved-save false success and
missing backups on 5xx/invalid JSON were fixed with regression coverage.

## Historical transactional-store increment

## Current checkout / deployment boundary

Branch: `evolution/contracts-recovery-foundations`. Original checkout was cloned at
`38a9d56bbe056ba3083cce7ca805077fb3662911` into an empty directory; the unrelated parent
repository was not modified. Local commits only: no push, main merge, deployment,
owner runtime migration, credential change or live service restart was performed.

- `427f0e1`: isolated terminal/server tests.
- `54984d6`, `879ffbf`: strict contracts, independent recovery and contract metadata.
- `a682126`: SQLite store, migration, crash/concurrency tests and safe backup tools.
- The following integration commit wires server/clients and bundles this source;
  use `git log` for its final hash (a commit cannot embed its own hash).

**Upgrade requires an operator decision:** a runtime containing legacy workspace JSON
will refuse normal startup until explicit offline migration. Do not deploy this branch
over an active server. See `WORKSPACE_STORE.md`; no stop/restart was authorized here.

## Implemented

- Strict versioned JSON Schema input registry, generated JSON/TS/Python limits/reference,
  Ajv 8.20.0 validation, structured errors, UTF-8 byte budgets and extra-field rejection.
- SQLite database schema v1 while **retaining workspace layout v1**. Atomic revision,
  pre-change checkpoint, command receipt and durable metadata event commits. WAL,
  foreign keys, FULL synchronization, short IMMEDIATE transactions and bounded busy
  handling. No network/model/browser work within write transactions.
- Auth-derived actor/workspace/operation-key receipts and canonical request hashes.
  Exact keyed retries return the stored response, including generated creation IDs;
  changed payloads with the same key fail. Legacy missing-key commands are translated
  with a fresh key and are not retry-safe after unknown outcomes.
- Explicit import-once legacy migration. Original JSON bytes and checkpoint references
  remain intact; raw bytes/SHA-256 are also archived in SQLite. Corrupt or interrupted
  imports do not become partial authoritative workspaces. No application migrations
  or service activation occur. No normalized surface/placement migration exists yet.
- Private `workspace-access` credential/API projections are rebuildable from the DB,
  never state authority. Python adapters prefer these and fail closed if missing after
  SQLite migration. Agent pane validation now reads authoritative state and honors the
  configured runtime. The standalone mobile proxy uses an authenticated metadata read
  rather than stale JSON (not live-provider tested; still omitted from portable bundle).
- Browser/Python/recovery clients send mutation identity, intent and base revision.
  Normal reads no longer send an invalid `base_revision`; checkpoint pre-reads preserve
  acknowledgement. Uncertain syncs hold/back up local changes rather than creating new
  mutation attempts automatically. Explicit CLI/Hermes retries retain original keys.
- Browser sync changes now create pre-change checkpoints. **Gesture grouping and
  retention are not implemented**; one drag can create several sync checkpoints.
- Independent `/recovery`: authenticated history, explicit restore and disable-all
  without normal rendering. It is not persistent safe mode or permission revocation.
- SQLite-aware backup, new-directory restore and explicit legacy export. Backup uses
  private staging, standalone verification and exclusive publication; existing targets
  cannot be overwritten, including binding filename-trimming/racing-destination cases.
- Native terminal test checks retained variable and shell PID using a private tmux
  socket, HOME, cwd, environment and config; no owner tmux socket is used by the test.

## Verification and versions

Node v22.23.1, npm 10.9.8, Python 3.13.7, TypeScript 5.9.3, Vite 7.3.6,
tmux 3.5a. SQLite 3.53.2 via pinned **better-sqlite3 12.11.1 (MIT)**, source-built
on Linux x64 with `npm_config_build_from_source=true npm rebuild better-sqlite3
--nodedir=/usr`. Package installation used `--ignore-scripts` before the reviewed
native build. Node minimum remains 22.12. Other OS/architecture installations are
untested; `prebuild-install` is deprecated and is a dependency maintenance risk.

Final commands for this increment:

```sh
npm run check
python3 tests/test_command_adapters.py
python3 tests/test_workspace_contract.py
python3 tests/test_workspace_batch_limit_regression.py
python3 tests/test_hermes_plugin.py
python3 tests/plugin-publish.test.py
python3 tests/orbit-catalog.test.py
python3 tests/test_orbit_bundle.py
python3 tests/test_portable_endpoints.py
npm audit
git diff --check

PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/recovery.browser.py
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/recovery-real-server.browser.py
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/workspace-store.browser.py
```

Fresh `npm run check`: build and **131/131 Node tests passed**, no skips. The eight
Python suites passed **49/49 tests**, including regenerated packaged-source parity.
`npm audit` reported zero vulnerabilities. Browser: pinned Playwright Python 1.58.0 / Chromium 145.0.7632.6
(v1208), using Ubuntu fallback binaries on the unsupported host OS. Fixture UI suite
10/10 passed. Real-server broken-renderer/app recovery passed, and the built normal
UI committed initial sync + sidebar change with keyed receipts and a pre-change
checkpoint. Browser-only surfaces prevented PTY attachment in that test. Firefox,
WebKit, live Hermes/model endpoints, native-app control and full session rearrangement
remain untested. No screenshots of owner content were taken.

Process-crash evidence includes SIGKILL during import, exit after commit without
close, durable replay after reopening, two real writers racing the same revision,
bounded writer-lock contention, and rollback on callback/response failure. Physical
power loss and disk-full behavior are not proven. Logs:
`/tmp/opencode/orbit-sqlite-final-check.log`, `orbit-sqlite-final-python.log`,
`orbit-sqlite-contention.log`.

## Remaining dependency-ordered work

1. Persistent server-enforced recovery hold/quarantine, outside reversible layouts;
   reject activation across sync/restore and revoke future broker authority. Current
   disable removes views only; disconnected frames and external services continue.
2. Indexed immutable bundles, referenced-bundle retention and authenticated bounded
   event delivery. Only a durable metadata outbox exists today, not an SSE subscription
   system. Bound revision/receipt/checkpoint storage growth without breaking retries.
3. Deterministic normalized v2 surfaces/resources/placements migration with retained
   unknown-provider descriptors, plus gesture undo grouping and per-client view state.
4. Renderer spike and real 50-transition iframe/PTY/draft continuity tests; then
   accessible tabs/dock/float/roles/project recipes.
5. Grants/observations/leases, broker egress policy, Project Inspector, app data storage,
   persistent exact drafts/promotions, and evidence-backed tasks. Both full product
   scenarios remain incomplete. No unrestricted private-data bridge was introduced.

Rollback is not a UI checkpoint: database backup includes credentials and must remain
private. An old binary needs a separate deliberate legacy export plus retained bundles
and other runtime resources, losing receipt/outbox continuity. Review credentials before
activating an old backup; this is not a permission-revocation recovery guarantee.

## Delegation ledger — all complete, no descendants running

Earlier completed sessions: `ses_f268fe272ffeaqwALhpSlFl1mN`,
`ses_f268d6ad0ffe70L84JX4eAFhlY`, `ses_f268aa654ffeiL8C2W28VW0n05`,
`ses_f268a82f5ffeLNdMcvmSD0oSKV`, `ses_f2686aa5dffedNV04DPy6pgrJI`,
`ses_f26867b8dffeLy4iCwiq3kkkVq`.

This slice:
- Luna binding research: `ses_f26738ccdffevQDSzlYnqhDEUD`.
- Flash consumer audit: `ses_f26736456ffegiuRNVrKpHOnd8`.
- Luna clients: `ses_f266d3821ffefoOLf4w6xw12mX`.
- Flash store tests: `ses_f266cd356ffe7CDmI6Ehb5k6n0`.
- Luna API regressions: `ses_f26626575ffeynip524h6irFMw`.
- Flash adversarial review: `ses_f26623b1fffevVRYafEVW7Qu7r`.
- Luna operations docs: `ses_f264bac54ffeyoeUk3ovX3P863`.

Lead integrated and corrected review findings: backup filename overwrite risk,
interrupted artifact acceptance, projection permissions, acknowledgement reset,
unsupported Hermes actions, preserved retry keys and adapter discovery/transport
boundaries. New regressions retain these checks; missing store modules/bindings fail
tests rather than being skipped.
