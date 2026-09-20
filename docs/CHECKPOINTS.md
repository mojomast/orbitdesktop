# Layout checkpoint foundation

Implemented first stage of DYNAMIC_WORKSPACE_PLAN.md only. Plugins, theme/asset snapshots, staging/promotion, safe mode and garbage collection are NOT yet implemented.

Tools menu → Workspace checkpoints supports manual save, history and confirmed restore. Server-side agent `apply` saves a checkpoint after validating all operations and before writing the new layout. A restore validates the old layout, checks the current revision and saves a before-restore checkpoint. Snapshots persist as owner-only JSON under `.runtime/checkpoints/<workspace>/`; authentication/capabilities are not copied. History has no retention pruning yet: monitor disk growth. Filesystem atomic rename protects individual records but is not a multi-file database transaction or disaster-recovery backup.

Snapshots cover the validated Workspace model (windows, pane types/URLs, geometry, fonts, sidebar/view settings). They do NOT cover CSS/theme files, app/plugin assets, conversations, shell processes or external actions. Restoring removed panes may dispose terminals. No promise of terminal process resurrection. Do not use layout checkpoints as a substitute for the proposed full workspace snapshots.

Authenticated `/api/workspace` and workspace-capability `/api/workspace-control` service actions: `history`, `checkpoint` with optional `label`, and `restore` with `checkpoint_id`, `base_revision`, `confirm:true`. See server routing for control path; ordinary controller `apply` automatically checkpoints without client changes.

Current Tailscale target is port 4330, orbitdesktop-checkpoints.service. Earlier 4329 service was left alive because it had two active terminals. Persistent unit installed through host user systemd; enable symlink established for default.target. New tabs load the new UI; old backend clients do not gain checkpoint endpoints until reconnecting.

Verification: npm run check passed 38 tests, including HTTP restore, stale revision rejection, confirmation requirement, authorization and persisted revision. Live browser test passed manual save, confirmed restore and before-restore listing in an isolated browser workspace. Existing uncommitted edits in main.ts, scene.ts and workspace-theme.css were preserved and are not part of this feature commit.
