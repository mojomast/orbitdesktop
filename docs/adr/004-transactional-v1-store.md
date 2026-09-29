# ADR 004: transactional workspace store on SQLite

Status: accepted; implemented as SQLite store schemaDBv1 with workspace layout/state v1.

## Decision

Replace the mutable JSON-file authority with `workspace.sqlite`, accessed through
`better-sqlite3` in `server/sqlite-workspace-store.mjs`. The database is the
authoritative store for workspace records, validated state, revisions, checkpoints,
command receipts, migration originals, and event outbox rows. JSON connection files
under `workspace-access/` are rebuildable discovery projections, not another writable
authority.

This is a transactional persistence change, **not** a normalized workspace-model
migration. Database `user_version` is 1; the workspace payload and command contract
remain `layoutv1`/workspace-v1 as defined by `contracts/workspace-v1.mjs`. Workspace
records and revision/checkpoint states remain JSON documents inside SQLite. The
database schema does not introduce normalized v2 layout entities, a dual v1/v2 write
path, or a lossy downgrade. A database with a newer user version and a workspace
whose state version is not 1 refuse writes from this implementation.

## Transaction and concurrency boundary

Each command has one synchronous logical writer. The store uses SQLite
`BEGIN IMMEDIATE` transactions to arbitrate writers in separate processes and keep
revision validation, state change, applicable pre-change checkpoint, receipt, and
event row atomic. A failed transaction leaves those changes uncommitted. No network
request or other asynchronous work is allowed inside a write transaction: callbacks
that produce state and responses are synchronous, and promise-like results are
rejected. For example, Jev/provider work and filesystem app indexing happen before
the command commit path.

The connection enables `foreign_keys`, requires WAL mode, and selects
`synchronous=FULL`. Its busy timeout defaults to 1000 ms and is configurable only
from 0 through 5000 ms; a lock timeout is surfaced as `RESOURCE_BUSY` rather than
waiting indefinitely. WAL is a local-filesystem deployment requirement, not an
endorsement of network filesystems or a multi-host database. Keep database and WAL
sidecars together for raw-file handling; use the SQLite backup API for a consistent
standalone backup.

This remains a local, single-owner workspace service. There is one logical command
writer at a time, not multi-writer semantic merging. SQLite serializes competing
processes, while base-revision compare-and-swap ensures only a command based on the
current revision can newly commit. An unseen stale command fails with
`REVISION_CONFLICT`; reread and reconsider rather than silently overwriting newer
state. Contention tests exercise lock timeout behavior and two independent
processes competing from the same base revision.

## Command identity and receipts

The server, not the caller, derives the receipt actor: `owner` for the authenticated
browser route or `workspace-controller:<workspace_id>` for the scoped controller.
Receipt identity is the workspace, actor, and operation key. The server computes a
canonical request hash; a committed receipt retains that hash, intent, base revision,
result, and resulting record. Retrying the same command key with the same canonical
request returns the stored result, including after a later revision. Reusing the key
with a different request fails with `IDEMPOTENCY_CONFLICT`.

For compatibility, commands without an operation key are assigned a fresh key by
`commandIdentity` and marked legacy in the response. They still get an attempt's
receipt, but repeating the old command creates another new key. Consequently, legacy
commands without a caller-retained key are **not retry-safe** after an uncertain
outcome. New adapters generate a key before sending and support caller-supplied keys.
An exact retry requires retaining the original key, base revision, intent and payload;
a new invocation without them is not recovery of the prior command. Transport errors
expose safe command identity where available, and sync holds uncertain local changes.
The server never trusts a client-supplied actor or hash.

## Checkpoint behavior

Checkpoints contain the validated workspace state/layout and metadata, not runtime
processes, external effects, app files, or conversations. Controller/plugin changes
and restore create pre-change checkpoints in the same transaction as the mutation;
an explicit checkpoint is a checkpoint-only commit and does not advance the workspace
revision. Restore is a new revision-checked command and also saves the state before
restore.

Browser `sync` now checkpoints a changed state before committing it (the checkpoint
label is “Before browser workspace change”). This gives synchronization a durable
pre-change recovery point. It does not group user gestures: the sync protocol carries
a whole workspace snapshot and revision, not gesture boundaries or transaction
groups. No claim is made that a checkpoint corresponds to one drag, one UI gesture,
or a visually rendered frame. Unchanged syncs can retain the current revision and do
not create the changed-state checkpoint.

## Outbox scope

Each new committed command appends a minimal event row with a monotonically assigned
SQLite sequence cursor, command type, action, revision, changed flag, and
causation/correlation identity. Events commit atomically with their receipt and
workspace change. They omit private workspace state and capabilities. This is durable
outbox metadata with a read-after-cursor API (`eventsAfter`), **not** an implemented
eventstream: there is no subscriber delivery, acknowledgement, retry worker, or
external consumer guarantee in this decision. Legacy imports do not fabricate past
receipts or events.

## Native dependency and deployment assessment

The application minimum remains Node 22.12 (`package.json`); this change does not
raise it. The pinned binding is `better-sqlite3@12.11.1`, MIT licensed, declaring
Node 20 and 22–26 support. The assessed tested installation is Node 22.23.1 on Linux
x64, built from source with `--nodedir=/usr`. This is evidence for that tested
environment, not a claim of tested prebuilt installation on every target.

The 13.x line is excluded because its Node-API 10 requirement needs Node 22.14 or
newer, which conflicts with the project's 22.12 minimum. `prebuild-install` is
deprecated, creating maintenance risk for binary acquisition; source compilation is
the assessed fallback. Other operating systems and architectures have not been
tested here and require their own install/build verification before deployment.

## Verification basis

The decision is reflected in `server/sqlite-workspace-store.mjs`,
`server/workspace.mjs`, `scripts/workspace_store.mjs`, the v1 contract and adapters
(`src/workspace-client.ts`, `src/workspace-sync.ts`,
`scripts/workspace_control.py`, and `hermes-plugin/__init__.py`). Focused tests cover
receipts and replay, cross-process contention, atomic rollback, migration, checkpoint
behavior, backup safety, and client command identity in `tests/sqlite-*.test.mjs`,
`tests/workspace-receipts.test.mjs`, and `tests/client-command.test.mjs`.
