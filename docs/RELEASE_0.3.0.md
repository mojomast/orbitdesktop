# Orbit Desktop / Hermes plugin 0.3.0

Version 0.3.0 packages the integration merged into `main` through PR #10. Desktop
and Hermes plugin metadata now use the same product version; workspace schema,
API and sandboxed app-manifest formats remain independently versioned. The
`hermes-plugin-v0.3.0` GitHub release records the exact catalog-pinned commit and
bundled-source checksum. Catalog acceptance is a separate reviewed SHA update.

> **Post-publication note (source `main` after `hermes-plugin-v0.3.0`).** Project
> Workbench became an experimental, off-by-default surface enabled in Orbit
> settings. The published 0.3.0 plugin pin still bundles the version described
> above; the changed default ships in the next versioned package.

## Highlights since main

- **Conversation-first Workbench:** describe a goal, edit a brief, review task
  preparation and separately approve configured execution. Guided setup supports
  discoverable Node-test projects; preparation does not invoke a model or checks.
- **Project work and evidence:** project inspection, bounded context sharing,
  candidate worktrees, approved checks, native task-scoped tools, recorded results,
  exact diffs, human review, project notebooks and reusable recorded-check tools.
- **Finite Studio generation:** the local Focus timer template uses reviewed,
  content-addressed publication and scoped lifecycle/revocation.
- **Better conversations:** inline tool inspection, binding-specific drafts,
  visible New chat and History, stable Send during background refresh and direct
  missing-history recovery. Separate confirmed Normal conversations may overlap,
  within the configured gateway's limits.
- **More workspace control:** contract-derived discovery, durable workspace
  arrangements/recipes, validated previews, exact-operation recovery and an
  independent recovery surface with durable activation hold.
- **Renderer choice:** Desktop remains the default. Experimental Docking adds
  tabs, tiled panels, floating groups and saved placement. All arrangement controls
  are in Docking beside host connection in the top Orbit bar.
- **Coherent appearance:** merged theme personalities and preset switching that
  clears unchanged preset-owned chrome defaults while retaining custom overrides.
- **Release infrastructure:** SQLite persistence/migrations, indexed immutable
  bundles, isolated builds, integrity-checked release packaging and controlled
  activation with full runtime/configuration backups.

## Everyday use

1. Connect the host and send a message in Normal chat.
2. Use **New chat** above the conversation to start another thread in that pane;
   use **History** to return to an earlier thread and its draft.
3. Use **Set up task** for reviewed Workbench preparation. Native execution needs
   explicit host runtime/provider configuration beyond ordinary chat setup.
4. Compare [Desktop and Docking](RENDERER_COMPARISON.md) before choosing a layout.

## Upgrade and compatibility

This release uses workspace database schema **11**; the serialized workspace and
sandboxed plugin manifest formats remain independently versioned. Read
[Deployment](DEPLOYMENT.md) and [Workspace store](WORKSPACE_STORE.md) for supported
migrations and full backup/restore. Preserve journals, receipts, notebooks,
candidates, content-addressed artifacts, configuration and bootstrap assets as
well as SQLite. Workspace checkpoints are not filesystem/runtime backups.

Rebuilds require loading the new frontend once. A controlled service restart must
preserve tmux session identities and defer active/uncertain execution. Rollback
must retain compatible data and reconcile post-backup durable writes.

## Known limits

- Docking remains experimental; Chromium continuity tests are not cross-browser
  or accessibility certification. Desktop remains the default renderer.
- Native Workbench execution is optional configuration and is currently absent
  from the owner's live service. Local deterministic-model acceptance does not
  establish paid-provider behavior.
- Workbench/native/check execution and unknown outcomes retain their fences.
  Concurrent Normal chat is not unlimited concurrency or multi-owner isolation.
- Explicit next-turn conversation history remains bounded user/assistant text;
  prior tool arguments/results are inspectable but are not included in that history.
- Abrupt death during candidate materialization before its durable receipt can
  leave `prepare_unknown`; automatic resumption/cleanup of that window is pending.
- A reload recreates embedded iframe documents. Layout-only movement preserves
  them only on the supported connected-DOM path; terminal reconnection is a separate
  tmux capability.

## Verification and release identity

The integration candidate passed all seven Workbench CI suites, the aggregate
gate, plugin checks and catalog admission. Local checks reported 774 passed,
0 failed and 8 optional skips. The deployed candidate preserved 41 database
tables, 22 chat bindings and six tmux process identities; both-renderer HTTPS
smoke checks passed. PR #10's merge tree matched that tested candidate exactly.

The versioned package is verified separately. Its release page carries the final
commit, checksums and packaging/installation evidence. Tests use disposable
workspaces and deterministic model fixtures; they do not certify paid-provider
behavior, cross-browser coverage or universal upgrades from arbitrary runtimes.
