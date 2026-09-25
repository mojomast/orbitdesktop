# Workspace store: compatibility, migration, and operations

Orbit's workspace authority is `PATH/workspace.sqlite` (schema `user_version=3` after bundle indexing and event-query indexing), where `PATH` is the configured runtime directory (`ORBIT_RUNTIME_DIR`, or the repository's `.runtime` by default). `server/workspace.mjs` uses `SqliteWorkspaceStore`; this is still a single-owner workspace, not a multi-user database service. The v1 workspace state and command shapes remain defined by `contracts/workspace-v1.mjs`. Layout, plugin registration/configuration, checkpoint state, independent recovery policy, bundle metadata and workspace capability are stored in the database; published app bytes, terminal processes, conversations, external effects and arbitrary runtime files are not workspace snapshots.

Schema 3 adds the bundle registry and a workspace-scoped outbox index without changing
layout representation. Schema 1/2 stores upgrade on open, retaining state, policy,
receipts and checkpoints. Plan a backup and stop older writers before cutover. Database
backup carries bundle metadata, **not app bytes**; preserve the content-addressed
directories separately. See [Bundle registry](BUNDLE_REGISTRY.md) and
[Workspace events](WORKSPACE_EVENTS.md) for refresh, retention and cursor behavior.

## Earlier recovery-policy schema upgrade (version 2)

The database schema advanced to version 2 for independent registered-plugin hold
policy and receipt-generation fencing; **the serialized layout remains v1**. Existing
SQLite v1 stores upgrade transactionally on open, with hold initially off. Back up
first and stop all older writers before opening with the new server. Old binaries
reject schema 2 at startup, but cannot be relied on to terminate an already-open
database connection: no mixed-version rolling upgrade is supported. Consider live
terminal preservation before scheduling that stop; this change does not authorize it.

Hold policy is excluded from layout checkpoints. Enabling a hold disables registered
plugins; only explicit owner recovery release clears it, and release does not enable
them again. Receipt replay is exact only within the same policy generation. A replay
from an older generation fails with `RECOVERY_POLICY_CHANGED`. This intentionally
prevents serving a pre-hold active snapshot as a successful new activation. See
[Recovery](RECOVERY.md) for the narrower boundary compared with full safe boot.

## Compatibility and cutover

- A fresh runtime creates `workspace.sqlite` automatically. If the database does not exist and legacy `workspaces/*.json` records exist, normal startup refuses with `MIGRATION_REQUIRED`; it does **not** silently import or fall back to JSON. An existing uninitialized database is not accepted as a valid backup. A database with a newer schema version refuses with `UPGRADE_REQUIRED`.
- Before migration, stop **all** old and new servers/writers using the runtime, considering live terminal/session preservation. The CLI's `--confirm-stopped` is an operator assertion; it does not stop or detect servers. Preserve a separate copy/backup of the entire runtime, including app bundles and other resources, before cutover. Then run exactly:

  ```sh
  node --experimental-strip-types scripts/workspace_store.mjs migrate --runtime PATH --confirm-stopped
  ```

  `PATH` must already exist. The command reports diagnostics as JSON; do not publish that runtime's capability files. Start the new server only after a successful migration and review. Do not point an old server at the migrated runtime: the current `JsonWorkspaceStore.write` compatibility guard rejects writes when `workspace.sqlite` exists, but an older deployed binary might still write stale JSON and cannot understand the new database/receipts.
- Import runs once, in a single SQLite transaction. It validates the legacy record IDs/revisions/capabilities, v1 states, checkpoint IDs/metadata/states and file types; each JSON file is limited to 8 MiB and all imported files to 128 MiB. Corrupt or invalid input aborts import rather than partially promoting records. A killed import can be retried after investigating its cause. It preserves complete workspace records (including capability, revision, observed/browser metadata and unknown record metadata), checkpoint states/metadata, and the exact original JSON bytes and SHA-256 hashes in `legacy_imports`. It does not delete or rewrite the original workspace/checkpoint JSON files. Once initialized, subsequent opens do not reimport edits made to those originals.
- Imported current records receive a `revisions` entry at their existing revision, with import-time marker `created=0`; old intermediate revisions are **not** reconstructed. Legacy checkpoints remain available. Pre-migration command receipts and outbox events cannot be reconstructed; imported records do not generate historical command events. New commits create their own receipts and events. The retained JSON is an archive, **not** a second writable store or a continuously synchronized fallback.
- State references to `/apps/...` remain references: migration does not package or verify immutable plugin bundles, external services or other runtime files. Retain those directories separately for checkpoint restores and rollback. Stable pane IDs/layout metadata are preserved, but stopping/restarting services can interrupt clients; SQLite backup or checkpoint restore does not preserve terminal processes or buffers.

## Command behavior and client compatibility

The server still distinguishes authenticated owner browser requests (Orbit token and origin check) from the controller route (workspace-scoped capability). State-changing commands (`sync`, `apply`, `plugins_apply`, `restore`, `checkpoint`, `jev_apply`) accept `operation_id`, `intent` and `base_revision`; if an operation ID is supplied, intent and base revision are required. New clients provide all three. The response includes `command_receipt: {operation_id, legacy}`. The actor is assigned by the server (`owner` or `workspace-controller:<workspace_id>`), never accepted from the request. Receipts are keyed by workspace, actor and operation ID and include a canonical request hash and the original response. A replay with the **same complete payload** returns that response even after a newer revision; reuse with a changed payload yields `IDEMPOTENCY_CONFLICT`. An unseen stale base revision yields `REVISION_CONFLICT`; read and reconsider rather than blindly replaying a new operation. A busy writer returns `RESOURCE_BUSY` (503); retry an uncertain mutation only with its exact key and payload. Legacy requests without an operation ID get a generated ID and receipt for that attempt but cannot safely recover an unknown outcome by sending a fresh request.

`scripts/workspace_control.py`, `hermes-plugin/__init__.py` and the browser adapter `src/workspace-client.ts` generate mutation IDs/intents. Only the Python clients use private filesystem connection projections; browser code uses its authenticated owner connection and never receives a controller capability. The controller and Hermes adapter require an explicitly chosen workspace and a numeric loopback API; they do not discover another owner's workspace. `src/workspace-sync.ts` reads before creating/syncing, sends the current revision with sync, and holds/backups local changes on uncertain outcomes. The independent recovery page generates IDs for confirmed restore/disable-all operations. Keep the original request metadata when retrying after transport failure; a new ID is a new command. CLI explicit retries require the original `--operation-id`, `--intent` and `--base-revision` with the unchanged payload. A fresh CLI/tool invocation without a retained key cannot reconcile a prior unknown outcome automatically. Receipt durability does not make external side effects or browser rendering transactional.

One synchronous logical writer executes each command in a SQLite `BEGIN IMMEDIATE` transaction: revision check, validated state update, pre-change checkpoint (where applicable), receipt and ordered outbox event commit together or roll back together. SQLite also arbitrates competing processes with a bounded busy timeout. An unchanged browser `sync` may leave the revision unchanged; explicit checkpoint creates a checkpoint without advancing the state revision. Checkpoint restore is itself a revision-checked new commit and saves a pre-restore checkpoint. `preview` is validation only. `read` through the browser route updates browser-seen/optional observed-revision metadata; control and recovery reads do not acknowledge the desktop. `observed_revision` means synchronization, not visual correctness. Outbox events have ordered numeric cursors and minimal action/revision metadata, not private state or capabilities; this is a stored event stream, not a promise of an external event consumer.

`PATH/workspace-access/<workspace-id>.json` is a rebuildable, private discovery projection containing `workspace_id`, `storage: "sqlite-v1"`, loopback `api` and capability, **not** state. The database is authoritative. Projection publication failures do not undo committed commands; startup/reconciliation repairs projections, their permissions and API URLs. Do not expose these files or mistake a missing projection for a missing workspace. The controller/Hermes adapter can use legacy JSON connection records only before SQLite exists; once SQLite exists they refuse a missing projection rather than falling back to stale JSON. New directories use mode 0700, database/projection files use 0600, and the projection directory is protected at reconciliation. Review permissions of an existing runtime and retained originals explicitly; migration does not silently change its entire permission policy. Protect backups and exported JSON with the same care because records contain capabilities.

## Operator review, backup and recovery

Use an explicit runtime path and a **new** destination. These are administration commands, not workspace checkpoint operations:

```sh
node --experimental-strip-types scripts/workspace_store.mjs diagnose --runtime PATH
node --experimental-strip-types scripts/workspace_store.mjs backup --runtime PATH --destination /private/new-backup.sqlite
node --experimental-strip-types scripts/workspace_store.mjs restore --runtime /private/new-runtime --source /private/new-backup.sqlite --confirm-stopped
node --experimental-strip-types scripts/workspace_store.mjs export-legacy --runtime PATH --destination /private/new-export --confirm-stopped
```

`diagnose` reports schema version, WAL mode, foreign keys, SQLite `quick_check`, counts of workspaces/checkpoints/receipts/events and whether a connection projection error was observed. It is a point-in-time diagnostic, not a rendering or external-resource check. The store requires WAL journaling and `synchronous=FULL`; keep the live database and its SQLite sidecars together rather than treating a raw copy of `workspace.sqlite` as a consistent online backup. `backup` uses SQLite's backup API, checks its standalone output and atomically publishes to an unused path without overwriting an existing destination. It does not copy app bundles or other runtime resources. Coordinate with writers when taking an operationally consistent whole-runtime backup.

`restore` validates a SQLite schema 1, 2 or 3 backup (`quick_check` and bootstrap marker), stages it, upgrades older schemas if needed, and publishes an entirely **new**, nonexistent runtime directory; it will not overwrite a runtime. Schema 2/3 backups retain recovery hold and generation. Stop servers first, and separately provide required bundles/other runtime resources before use. Restore does not restart a server. `export-legacy` refuses if any workspace has an active recovery hold. Otherwise it writes a new offline directory of current workspace/checkpoint JSON and an `EXPORT_WARNING.txt`; old binaries do not preserve SQLite receipts/outbox, bundle indexing or policy enforcement, and exporting does not remove SQLite authority or migrate app bundles. A rollback to an old binary requires a separately prepared runtime and deliberate handling of lost receipt/event/policy continuity; never run old and new writers against one directory. None of these procedures undo shell, conversation, network or external side effects.

Review the diagnostics and current workspace via the controller after cutover; verify checkpoint listings and the intended state, and inspect the real browser separately before reporting displayed success. Relevant isolated verification is covered by `tests/sqlite-migration.test.mjs`, `tests/sqlite-workspace-store.test.mjs`, `tests/sqlite-contention.test.mjs`, `tests/sqlite-backup-safety.test.mjs`, `tests/workspace-receipts.test.mjs`, client/adapter tests and `tests/workspace-store.browser.py`. Run `npm run check` and the isolated browser/publisher checks for deployment changes; do not use a live owner's runtime as a test fixture.

No revision/checkpoint/receipt retention pruning is implemented yet. Monitor disk
growth and retain successful receipt identities when designing future pruning;
deleting them changes retry semantics. Tests exercise process crashes and contention,
not physical power loss, disk-full behavior or every supported operating system.
Full safe boot, permission revocation, indexed bundles and event delivery remain
separate gates. The registered-plugin hold is narrower; a durable outbox does not
implement event delivery or resource revocation.
