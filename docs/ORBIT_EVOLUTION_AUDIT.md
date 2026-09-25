# Evolution audit — September 25, 2026

Status: initial audit, not a completed evolution gate.

The supplied directory was empty and inherited Git discovery from the unrelated
parent ClawDeck repository. Orbit was cloned into this directory without changing
that parent's dirty files. Orbit HEAD is `38a9d56bbe056ba3083cce7ca805077fb3662911`,
not the reviewed `195d5299e683b9668c50ebf5ded7f5c8a966083c`. The clone was clean.
Subsequent commits add theme/spatial/mobile/shared-chat work and remove Devplan
Studio. Preserve those changes. No deployment or owner runtime was inspected.

## Source findings

- Implemented: revision-checked controller batches, per-workspace capabilities,
  immutable publishing, checkpoints, trusted backend activation and Build Queue.
- Incomplete: `server/workspace.mjs` uses independent JSON renames for records and
  checkpoints. Synchronous mutations serialize in one process; this is not an
  atomic multi-record crash or cross-process transaction.
- `appVersions()` recursively scans bundles on ordinary safe-state reads.
- Preview recomputes operations; it is structural validation, not rendered proof
  or an exact persistent proposal.
- Pane identity is still embedded in pane/split placement. `main.ts` rebuilds
  containers and remote reconciliation can dispose a moved same-ID pane.
  Object reuse alone does not establish iframe document continuity.
- Independent recovery boot, grants, service broker and transactional v2 migration
  are proposed, not implemented. Static app CSP allows broad HTTPS; do not grant
  these legacy apps new private-data access.
- Obsolete documentation: AGENT_GUIDE/CHECKPOINTS deny CLI history/restore that
  `scripts/workspace_control.py` actually implements. WORKSPACE_CONTROL describes
  an eight-window limit absent from model validation. These need contract-led repair.
- The requested `hermes-plugin/init.py` path does not exist; inspect `__init__.py`.

## Fresh baseline

Node v22.23.1, npm 10.9.8, Python 3.13.7; declared Node minimum >=22.12.
`npm ci --ignore-scripts`: installed existing lock, audit reports zero vulnerabilities.
Dependency install scripts were deliberately not executed.

`npm run check`: build passed; tests 68 passed, 10 failed (78 total). Failures
include missing native node-pty binding and resulting server fixture failures.
Log: `/tmp/opencode/orbit-baseline-check.log`. This is not a clean baseline.

- `python3 tests/plugin-publish.test.py`: 1 passed.
- `python3 tests/orbit-catalog.test.py`: 18 passed.
- `python3 tests/test_portable_endpoints.py`: 2 passed, 1 failed: distributed archive
  contains author-specific mobile proxy hostname. Do not publish the existing
  archive as a clean portable release.
- `python3 -c 'import playwright'`: unavailable. Browser acceptance not run.

No live Hermes, tmux continuity, native desktop, paid model, CDP or screenshot
claim is established. Test fixtures are not evidence of deployed integration.

## Subsequent implementation evidence

The initial findings above are historical baseline, not the final working tree.
Contract parity/strict validation, JSON store boundary and independent layout recovery
are now implemented; see ORBIT_EVOLUTION_HANDOFF.md for exact commands and boundaries.
Native PTY dependency and test isolation were repaired. A real isolated tmux reconnect
test now proves retained variable/PID (not general layout continuity). Recovery was
exercised in Chromium against the real server with an actually throwing renderer/app.
CLI/docs contradictions and portable archive admission are repaired in this increment.
Transactional storage, v2 migration and persistent safe mode remain unimplemented.

## Transactional store increment (later on September 25)

SQLite persistence and durable keyed receipts are now implemented and verified in
isolated fixtures; this supersedes the storage status in the preceding historical
paragraph. Explicit import retains originals and keeps layout v1. Cross-process CAS,
bounded contention, SIGKILL during import, committed-receipt restart recovery, and
SQLite-aware backup/restore/export have fresh tests. Normal built UI synchronization
and independent recovery both passed against the real SQLite-backed server.
No owner runtime has been migrated. Normalized v2 models and persistent safe mode
are still outstanding. See the current handoff and WORKSPACE_STORE.md for scope.

## Registered-plugin recovery hold increment

Owner-only persistent activation policy now lives outside layout/checkpoints, with
transactional disable, generation-fenced receipts, and mutation-time enforcement.
The recovery UI can enter/release hold without loading the normal renderer. SQLite
schema 2 migration, SIGKILL rollback, held backup/restore and legacy-export refusal
are tested. A separate adversarial review identified sync false-success and missing
backup messages after uncertain responses; those were corrected and covered by
isolated client regressions. Full safe boot, cached/offline frame revocation and
backend termination remain outside this increment; no live deployment was changed.
