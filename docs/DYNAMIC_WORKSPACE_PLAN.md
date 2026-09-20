# Dynamic workspace architecture proposal

Status: research/design, not implemented. Sources checked against official DeepSeek Harness, Hermes, and VS Code documentation. Open-web discovery used WebXNG/SearXNG.

## Recommendation

Keep Hermes as the agent runtime. Adopt a small stable Orbit host with versioned plugin contributions, capability-scoped APIs, declarative appearance/layout configuration, and transactional workspace checkpoints. Do not replace Hermes with DeepSeek Harness or treat a plugin lifecycle framework as a security sandbox.

DeepSeek Harness uses Cordis for mounting/unmounting, dependencies, services and events. Its official safety notice says it is experimental, unaudited, and not a security boundary for untrusted workloads. Borrow its composition/lifecycle ideas, not unrestricted in-process execution for generated plugins.

## Stable host and extension boundaries

Host-owned: authentication, permissions, snapshot/restore, asset serving, plugin registry, window/session identities, recovery UI, Hermes bridge. Plugins cannot replace these through the ordinary customization API.

Contributions: pane types, dashboard widgets, sidebar sections, toolbar commands, themes, app/output viewers, data subscriptions. Convert existing tools/jobs/catalog/shelf dialogs incrementally into bundled contributions.

Three extension tiers:
1. Declarative layout/theme/widget recipes: schema validated, no arbitrary code.
2. Generated UI apps: isolated iframe or worker; constrained network/storage permissions; no host credentials or arbitrary DOM access.
3. Trusted server integrations: separate restricted processes and explicit owner approval; not enabled merely because Hermes generated a manifest.

Iframe RPC must verify window/source identity, schema, channel binding and capability scope. Sandboxed opaque origins require source/channel validation rather than trusting an `origin` string alone. CSS scoping or Shadow DOM is not a security sandbox. Capabilities enforced server-side, not just declared in manifests. Raw host shell access can bypass these controls; retain it as a separately approved administrative escape hatch rather than claiming complete confinement.

Manifest fields: id, immutable version/content hash, host API range, entrypoint, contributions, config schema, requested capabilities, dependencies, migration version. Track config/state outside immutable plugin bundles. Lifecycle includes mount, dispose, health, export/import state. Dispose timers, listeners, streams and pending RPC; preserve core terminal and conversation identities.

## First-class agent customization contract

Expose typed inspect/plan/stage/validate/preview/commit/restore operations through the existing controller, later native Hermes tools if useful. Describe every exposed control with input schema and current state. Every mutation includes expected revision, actor/run identity and human-readable intent. Reject stale changes; report precise failures instead of rewriting unrelated settings.

Support theme tokens (wallpaper, colors, density, typography), per-pane appearance, layout presets, widget bindings, plugin activation/configuration and published outputs. Never require arbitrary edits to core TypeScript for ordinary customization. Keep structural state on the server so Hermes can prepare changes with no browser connected; distinguish committed revision from client-observed revision.

## Transactional checkpoints

A checkpoint captures one coherent workspace revision: layout, theme, plugin configuration, exact plugin bundle hashes, versioned published assets, and plugin state/schema versions. Keep secrets, upstream credentials, live shell processes, and session databases outside ordinary snapshots. Reference session IDs without pretending to roll back their external effects.

Immutable content-addressed bundles plus a transactional metadata store (SQLite is a reasonable choice) allow an atomic active-revision switch. Log successful and failed mutations separately for auditing. Do not use git reset of the working tree as runtime rollback; unrelated owner edits must survive.

Automatically checkpoint before agent customization commits and before restore. Restore creates a new revision referencing previous content, preserving an undo path. Retain named checkpoints, bounded automatic history, and garbage-collect only unreferenced bundles. Include data migration versions; reject rollback when plugin data cannot safely be restored instead of silently running downgrade code.

Provide a host-owned history panel with preview/diff, restore, and last-known-good recovery. Recovery must work with all optional plugins disabled. Database and asset backups are separate from checkpoints.

Explicit exclusions: emails sent, remote writes, shell side effects, running processes, third-party schedules and external services are not undone by workspace restore. Show exclusions and any restart/disconnection consequences before confirmation.

## Live rollout and verification

Build generated extensions in a staging area. Validate manifest/capabilities, run lint/build and contract tests, then browser smoke tests in a disposable workspace. Present screenshot/layout diff and requested permission changes. Promote exact tested bundle hashes atomically; never activate a half-written folder. Clients fetch versioned assets and acknowledge the committed revision. Replace only affected plugins, not the whole document.

Automatic rollback should require plugin-attributed failures and a bounded policy to avoid rollback loops caused by unrelated browser/network errors. Quarantine repeatedly failing plugins. Use a safe-mode host route and retain previously functioning bundles.

Test concurrent user/agent edits, offline mutations, iframe privilege escalation, secret leakage, plugin exceptions, stale updates, broken schema migrations, restore after reload/server restart, and terminal/chat continuity.

Metrics: committed-to-observed latency, failure-free activation rate, checkpoint restoration success, regressions caught before promotion, lost session count, orphaned resources after disposal, snapshot storage growth. Establish baseline measurements before setting numeric SLOs.

## Delivery order

1. Revisioned theme/layout API plus automatic checkpoints, history/diff/restore and safe mode. Verify restore actually reproduces appearance and layout.
2. Plugin SDK/manifest and lifecycle; migrate a low-risk existing widget and the app shelf. Add persistent draggable panes and safe data bindings.
3. Staged agent plugin generation, preview/testing/promotion, permission review and immutable assets.
4. Broader reusable recipes, model/session/jobs integrations and optional plugin sharing after the local trust model is proven.

Acceptance scenario: owner asks for compact dark workspace plus token widget; Hermes stages a revision, builds only the widget, tests it, publishes a checkpointed commit; open client updates without losing terminal/chat. Owner restores the prior checkpoint; layout/theme/widget version revert after reload too. A deliberately broken plugin must not break recovery.

## Sources

- https://www.deepseek.com/harness/en/
- https://github.com/deepseek-ai/deepseek-harness (default branch master)
- https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md
- https://code.visualstudio.com/api/extension-guides/webview
- https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

Hermes filesystem checkpoints are useful additional protection, not a substitute for Orbit's coherent runtime snapshots. Official docs currently describe them as opt-in. Do not assume they are enabled in the running profile.
