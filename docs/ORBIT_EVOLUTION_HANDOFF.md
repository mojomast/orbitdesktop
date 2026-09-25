# Evolution handoff — September 25, 2026

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
