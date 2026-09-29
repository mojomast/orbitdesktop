# Orbit Desktop 0.3.0 — release candidate notes

Status: **draft**, not a published stable release. Target: `0.3.0-rc.1`, followed
by `0.3.0` after the [release gates](RELEASE_READINESS_PLAN.md) pass. Product/plugin
metadata still carry their previous versions pending the versioned candidate cut.
Use the exact commit and immutable release identity when reporting a test result.

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

The candidate uses workspace database schema **11**; the serialized workspace and
sandboxed plugin manifest formats remain independently versioned. Read
[Deployment](DEPLOYMENT.md) and [Workspace store](WORKSPACE_STORE.md) for supported
migrations and full backup/restore. Preserve journals, receipts, notebooks,
candidates, content-addressed artifacts, configuration and bootstrap assets as
well as SQLite. Workspace checkpoints are not filesystem/runtime backups.

Rebuilds require loading the new frontend once. A controlled service restart must
preserve tmux session identities and defer active/uncertain execution. Rollback
must retain compatible data and reconcile post-backup durable writes.

## Known limits and remaining acceptance

- Docking remains experimental; Chromium continuity tests are not cross-browser
  or accessibility certification. The owner renderer walkthrough remains a gate.
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

Final version metadata, exact-head CI, supported-main upgrade rehearsal, owner
acceptance, merge-artifact verification and tagged publication must be recorded
before these notes become a stable release announcement.
