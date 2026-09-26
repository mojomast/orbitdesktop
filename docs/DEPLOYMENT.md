# Testing candidate deployment and rollback

## Result-delivery increment (schema 8; not deployed)

### Recreating the native acceptance environment

Temporary implementation paths are not deployment prerequisites that survive a
host/container change. Recreate the test runtime from the same upstream and
lockfile used in `.github/workflows/workbench.yml`. The pinned commit belongs to
**https://github.com/NousResearch/hermes-agent**, not the owner's Hermes fork.
Use a new private directory; do not overwrite an existing Hermes installation.

```sh
git clone --no-checkout https://github.com/NousResearch/hermes-agent /tmp/opencode/orbit-hermes-native
git -C /tmp/opencode/orbit-hermes-native checkout --detach d0288be5b3330d2442e3907185b8e9d0958297bb
git -C /tmp/opencode/orbit-hermes-native rev-parse HEAD
uv sync --project /tmp/opencode/orbit-hermes-native --frozen --python 3.14 --no-default-groups
export HERMES_NATIVE_SOURCE=/tmp/opencode/orbit-hermes-native
```

CI uses uv 0.11.2. Provision this isolated environment only where dependency
downloads are authorized, then verify the commit and `.venv/bin/python`. Preserve
any existing directory and inspect it instead of blindly cloning over it.
The browser virtualenv and Chromium cache may use other vetted paths; set
`PLAYWRIGHT_BROWSERS_PATH` accordingly. These deterministic fixtures do not
authorize product-model inference. Full Git history is required in the Orbit
checkout because the real-project tests read the pinned `5b31fda` baseline.

Local acceptance and remote CI are distinct gates. Check the completed CI
conclusions for the exact candidate before activation, not just the historical
local acceptance ledger. The first published candidate `ae3b1f7` failed remote
CI on umask-dependent test expectations and missing shallow-checkout history;
its local results do not supersede those failures.

Schema 7→8 adds private result receipts, host-card delivery records and reviewed
patch-export records. Native explanations are separate from runtime termination,
recorded checks and human acceptance. Backups must also include
`native-result-journal/` and
`workbench-execution/patch-verification-pending/` alongside candidate generations, job and
ordinary-submission journals, dependency environments, private Hermes homes and
integration/patch artifacts. SQLite alone is not a complete backup.

Take a consistent backup with all writers excluded before a separately authorized
upgrade. A schema-7 binary must not open a schema-8 runtime. Roll back using the
matching schema-7 backup and binary in a separate runtime; never lower
`user_version`. Reconcile pending results without launching another worker.

`npm run build` now writes to a separate scratch output and reports its path.
It does not refresh a served checkout's `dist/`. Explicit build destinations are
validated before writes against source, runtime and configured protected roots.
Release selection, verified process activation, database migration and rollback
are separate operator operations. No operator deployment or activation was
performed by this increment. See `WORKBENCH_RESULT_INCREMENT.md` for current
integration and acceptance status.

### Isolated builds and pinned releases

- `node scripts/isolated_build.mjs --json` returns a fresh scratch destination.
  Its `--source` and `--dest` arguments must be explicit absolute paths when
  supplied. A missing value is an error. Source, runtime and declared protected
  roots are checked before writes. A non-scratch destination requires a declared
  protected-root policy; it is not a shortcut for replacing a live `dist/`.
- `scripts/release_package.mjs` exports `packageRelease(...)` for assembling a
  **new** release root from the tracked source allowlist and isolated built
  assets. The versioned manifest binds file inventory, bytes, modes, source/build
  identity, Node/schema/Hermes compatibility and lockfile metadata. Credentials,
  runtime data and the owner-specific mobile proxy are excluded. Package and
  cleanup operations reject symlink/hardlink escapes; cleanup is restricted to
  an exact, marker-bound disposable release inventory.
- Node dependencies remain external. The declared dependency root must be the
  root actually resolved from the physical release entrypoint; runtime package
  versions and Node ABI must match the pinned metadata. Merely setting
  `NODE_PATH` does not configure ESM resolution. Provision the tested directory
  layout and dependency tree explicitly; ordinary builds do not install them.
  The release file-inventory hash covers the packaged root, not the external
  dependency bytes. Version/lockfile/resolution checks do not enforce external
  tree immutability; that tree remains operator-managed.
- `scripts/release_pin.mjs` selects or rolls back a validated release pointer in
  the external runtime. Pointer selection is distinct from a running process.
  A health probe must return the selected release ID and manifest integrity;
  bare HTTP 200 is insufficient. Failed or throwing probes restore the prior
  pointer. Schema-incompatible rollback is refused.
- `node scripts/release_launch.mjs --runtime /absolute/private/runtime --start`
  resolves the pointer once, validates it and launches the physical release
  entrypoint. The server verifies that its source and assets match the pinned
  release before opening the workspace store, and exposes the captured release
  identity through `/api/health`. Changing the pointer does not switch an already
  running process's source or assets.

Inspect each script's versioned API/options before operating it. These tools do
not preserve arbitrary process sessions, stop old writers, migrate an owner's
runtime by themselves, or authorize a deployment. Perform the consistent backup
and session-preservation steps below before a separately approved activation.

## Agent-loop candidate (schema 7; not deployed by implementation)

Use the [current ledger](WORKBENCH_AGENT_LOOP_LEDGER.md) for exact source and
verification evidence. Schema 6→7 is additive but rejects duplicate scoped job
operation keys; investigate a restored copy rather than deleting receipts. A
separately authorized upgrade requires writer exclusion and a consistent schema-6
backup plus candidate generations, job/finalization journals, ordinary chat
submission journals, dependency environments, native runtime homes and integration
artifacts. SQLite alone is not a complete evidence backup. Protect these as private
data. Do not resurrect a native channel key or process-local lease from a backup.

Rollback uses the matching pre-upgrade binary and a schema-6 backup restored into a
new runtime with `restore --preserve-schema`; never lower `user_version`. Any
post-backup execution receipts must be reconciled explicitly before admitting new
work. No owner/test credential rotation or deployed-runtime change is implied.

The native adapter additionally requires the explicitly configured pinned local
Hermes source/Python/model endpoint/profile described in `PROJECT_WORKBENCH.md`.
Deterministic runtime compatibility does not authorize external inference spending.

This is an owner-operated, single-writer deployment. **Local loopback operation is
supported without Tailscale.** An ordinary reverse proxy or Tailscale Serve may
optionally provide HTTPS. Configure the exact external origin when using a proxy;
do not weaken Host/Origin checks to accommodate it. Tailscale is neither a runtime
dependency nor a required acceptance-test environment.

## Before upgrading

1. Identify the exact runtime directory, current binary/source revision, database
   schema, immutable app bundles, and terminal provider/socket. Do not discover
   these by dumping credentials or personal transcripts into a report.
2. Obtain owner authorization and schedule writer exclusion. Stop **all** old
   Orbit writers before migration, not the tmux server. Account for PTY session
   preservation before stopping a service/container. A schema gate at startup
   cannot eject an already-open old writer.
3. Retain the previous tested build and a consistent pre-upgrade SQLite backup,
   plus the matching immutable bundles and required non-database configuration.
   Include private managed-terminal continuity metadata (ledger and `.initialized`
   sentinel) and the input operation journal under the same stopped-writer plan.
   SQLite backup alone does not copy these files. Do not roll the input journal
   backwards to permit an old command to execute again, or delete a sentinel to
   bypass an identity failure. Process-local grants are deliberately never restored.
   Protect backup files as private data. Verify the backup by restoring to a
   **new disposable directory**, never by overwriting the owner runtime.
4. Test the candidate with a separate runtime, HOME, working directory, tmux
   namespace, port, and browser context. Never reuse a personal browser profile
   for automated tests. The commands in [Testing branch](TESTING_BRANCH.md) are
   local-origin gates; optional tailnet acceptance is an additional operator step.

## Schema mismatch: owner procedure

- If startup says `UPGRADE_REQUIRED`, keep that runtime stopped. Do not lower
  `PRAGMA user_version`, delete SQLite sidecars, or copy old JSON over the database.
  Use a binary supporting the actual schema, or the rollback procedure below.
- If legacy JSON requires migration, retain its original bytes and invoke the
  documented explicit migration only with writer exclusion. JSON is archival,
  not a concurrent writable fallback.
- Schema 4 adds docking placement adjuncts to schema 3. Layout/plugin manifests
  stay v1. See [Docking persistence](DOCKING_PERSISTENCE.md) and
  [Store operations](WORKSPACE_STORE.md) for the implementation contract.
- Schema 5 adds Project Workbench project/resource/surface-binding metadata outside
  layout state. See [Project Workbench](PROJECT_WORKBENCH.md). Backup includes these
  tables, but layout checkpoints do not restore them. Return to a schema-4 build
  using its compatible pre-upgrade backup, never by lowering `user_version`.
- Schema 6 adds private context/task/attempt/candidate/job/evidence/review records.
  Stop writers under an authorized operator plan and retain a consistent schema-5
  backup before upgrade. Back up candidate/log directories separately with the
  database for complete evidence preservation. Unknown run/job records do not
  authorize automatic retries. Context approvals and runtime grants are not
  revived by restart or layout recovery. See [Project Workbench](PROJECT_WORKBENCH.md).
- **No mixed-version rolling upgrade.** Old binaries must refuse a newer schema;
  a newer binary is not permission to run alongside an older writer.

## Rollback is restore, not down-migration

Keep the pre-upgrade database and old build together. Use that build's offline
restore tool to restore its compatible backup into a **new** runtime directory,
with writers stopped and immutable bundles retained. Verify it there before
repointing the service. Running the new build's normal restore tool may upgrade
the copy; it is not a way to manufacture an old-schema database.

The candidate also provides an explicit non-upgrading restore mode:

```sh
node --experimental-strip-types scripts/workspace_store.mjs restore \
  --source /PRIVATE/BACKUPS/pre-upgrade.sqlite \
  --runtime /NEW/PRIVATE/rollback-runtime \
  --confirm-stopped --preserve-schema
```

This validates and copies the backup without opening the copy through the newer
store/migrator. Start the **matching older build** against that new directory only
after verification and owner approval. The CLI test proves a schema-3 backup stays
schema 3 in this mode; normal restore migrates its separate copy to schema 4, the
source remains unchanged, and an existing destination is refused. It does not
convert a schema-4 backup into schema 3. Deployed old-binary acceptance is still
an operator test, not implied by checking the copied schema number.

Newer changes made after the backup are not present in that rollback. Legacy
export is deliberately lossy: old binaries cannot preserve new placement,
command receipts, event history, or newer recovery/authority semantics. Review
the export warning and do not treat a successful export as lossless downgrade.

## Runtime boundaries

- Checkpoints restore layout and its docking placement adjunct, **not processes,
  shell side effects, disposed iframe documents, or external actions**.
- A browser reload is not a shell restart. Existing tmux panes must reattach by
  the same pane identity; uncertainty must not trigger replacement or respawn.
- Managed-terminal identity metadata is not a permission grant. Private capture
  and input require explicit owner consent; restart/restore must not resurrect
  authority. See [Managed terminals](MANAGED_TERMINALS.md).
- The test service has **no promised reboot supervision**. A manual test process
  and a surviving tmux server are not a system startup/recovery solution.
- Workspace events use bounded polling only, not SSE/push. Retention planning is
  dry-run only; there is no supported destructive cleanup command.
- Generated plugins receive no privileged host bridge from these features.

## Evidence handoff

Do not call a deployment accepted on a build result alone. Record build revision,
browser/version, origin class (loopback, ordinary HTTPS, optional tailnet), exact
assertions, page-error count, and screenshots of visual assertions. For workspace
mutations record committed revision and the subsequent `browser_applied` or
observed-revision evidence. Acknowledgement alone is not visual correctness.

The owner requested Hermes Orbit to perform the optional tailnet acceptance.
Until its evidence is received, that deployment-specific gate remains **pending**.
No command in this document authorizes migration/restart of an owner runtime.
