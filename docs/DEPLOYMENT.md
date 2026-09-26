# Testing candidate deployment and rollback

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
