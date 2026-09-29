# Dynamic workspace architecture proposal

Status: historical broad research/design; not an implementation contract. Current source schema is 9 (schema 8 is the historical pre-arrangements baseline) and serialized workspace layout remains v1. The scoped M1/M2 arrangement release has passed its frontend/browser acceptance; see [current evidence](ENVIRONMENT_MALLEABILITY_LEDGER.md). The broader extension vision below remains unimplemented unless explicitly identified as current behavior in the plugin documentation.

## Recommendation

Keep Hermes as the agent runtime. Adopt a small stable Orbit host with versioned plugin contributions, capability-scoped APIs, declarative appearance/layout configuration, and transactional workspace checkpoints. Do not replace Hermes with DeepSeek Harness or treat a plugin lifecycle framework as a security sandbox.

DeepSeek Harness uses Cordis for mounting/unmounting, dependencies, services and events. Its official safety notice says it is experimental, unaudited, and not a security boundary for untrusted workloads. Borrow its composition/lifecycle ideas, not unrestricted in-process execution for generated plugins.

## Stable host and extension boundaries (broad future vision; narrowed for first release)

Host-owned: authentication, permissions, snapshot/restore, asset serving, plugin registry, window/session identities, recovery UI, Hermes bridge. Plugins cannot replace these through the ordinary customization API.

The older broad contribution list (pane types, dashboard widgets, sidebar sections, toolbar commands, themes, app/output viewers and data subscriptions) is **not** the first-release scope. Initial M3 is limited to finite trusted components and private data remaining host-owned; no broad contribution types or capability-registry expansion. No general dependency solver is in scope.

Three extension tiers:
1. Declarative layout/theme/widget recipes: schema validated, no arbitrary code.
2. Generated UI apps: isolated iframe or worker; constrained network/storage permissions; no host credentials or arbitrary DOM access.
3. Trusted server integrations: separate restricted processes and explicit owner approval; not enabled merely because Hermes generated a manifest.

Iframe RPC must verify window/source identity, schema, channel binding and capability scope. Sandboxed opaque origins require source/channel validation rather than trusting an `origin` string alone. CSS scoping or Shadow DOM is not a security sandbox. Capabilities enforced server-side, not just declared in manifests. Raw host shell access can bypass these controls; retain it as a separately approved administrative escape hatch rather than claiming complete confinement.

The historical broad manifest/lifecycle sketch (dependencies, generalized contributions, capability requests and export/import lifecycle) is not approved for initial implementation. First release contracts must remain finite and explicit; private data stays host-owned. Any later plugin data contract requires separate review and tested lifecycle/migration behavior.

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

## Scoped arrangement increment and later extension work

1. **M1/M2 backend implemented:** durable preview digest over exact staged state and placement; authenticated apply revalidates project/recovery generations, bindings/resource identities, proposal and recipe revisions under the transaction; state, placement, checkpoint, proposal and receipt commit atomically. Return is checkpoint-derived and fenced to the exact resulting workspace revision. Recipes are source-owned portable definitions that resolve role constraints against target project bindings; ambiguity requires an explicit choice. Direct small workspace operations remain supported. See [Workspace arrangements API](WORKSPACE_ARRANGEMENTS_API.md).
2. Limits are 32 recipes per workspace, 200 proposals per project with pages of 32, and 512 append-only actor-scoped recipe-save receipts per workspace. Measured viewport belongs to preview identity. Windows/Docking support measured frames; spatial supports ordering only and rejects columns/rows geometry. Focused backend and default/Docking browser/PTY journeys passed; exact evidence and limits are in the current malleability ledger.
3. Legacy layout import is only an adapter from saved window order to portable role-order constraints. It explicitly omits pixel frames, scaling, minimized/selected state and camera, leaving those only in the retained local layout; it does not claim exact geometry migration.
4. **M3/M4 later and narrowed:** finite trusted components/private data remain host-owned; no general dependency solver, capability registry expansion, or broad contribution types in the initial release. No full extension model or private plugin-data feature is shipped. Any later staged artifact or extension work requires a separate frozen contract and acceptance evidence.

Acceptance scenario: owner asks for compact dark workspace plus token widget; Hermes stages a revision, builds only the widget, tests it, publishes a checkpointed commit; open client updates without losing terminal/chat. Owner restores the prior checkpoint; layout/theme/widget version revert after reload too. A deliberately broken plugin must not break recovery.

## Sources

- https://www.deepseek.com/harness/en/
- https://github.com/deepseek-ai/deepseek-harness (default branch master)
- https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md
- https://code.visualstudio.com/api/extension-guides/webview
- https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

Hermes filesystem checkpoints are useful additional protection, not a substitute for Orbit's coherent runtime snapshots. Official docs currently describe them as opt-in. Do not assume they are enabled in the running profile.
