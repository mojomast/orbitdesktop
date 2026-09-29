# Workspace checkpoints

## Included

Checkpoints persist the validated Workspace model: window/pane layout and geometry, font/view/sidebar settings, structured appearance, plugin manifests/configuration/enabled windows and published entry references. They live in the owner-only SQLite workspace store. Original `.runtime/checkpoints/<workspace>/` JSON remains unchanged after explicit migration, but is no longer authoritative. Workspace authentication capabilities are not part of checkpoint state.

Agent controller `apply` and browser `plugins_apply` save prior state in the same transaction as the validated mutation. Changed browser `sync` snapshots now also create pre-change checkpoints. Manual saves are available in Hermes tools → Workspace checkpoints. Gesture grouping/retention are not implemented: one drag can produce multiple coalesced sync checkpoints, not necessarily one undo unit.

Restore requires explicit confirmation and the current revision. It validates the saved state, creates a before-restore checkpoint, then persists a new revision. The connected browser synchronizes without requiring document reload. Restore can remove panes; persistent tmux shells detach, while legacy direct shells may exit.

## Not included

Arbitrary CSS/theme source, wallpaper image bytes, plugin internal data, conversation contents, live processes, filesystem edits, sent messages and remote API effects are not snapshotted. Plugin rollback restores old entry references; it only restores the previous app code if that bundle is still present and unchanged. Use content-addressed publication and retain old assets. Checkpoints are not a disaster backup.

There is no retention pruning yet; monitor database growth. SQLite transactions cover revision/checkpoint/receipt/outbox changes and arbitrate competing writers with bounded busy handling. They do not cover files or external effects. Stop all JSON-writing servers before migration and never run an old binary against the migrated runtime. See [Workspace store](WORKSPACE_STORE.md) for SQLite-aware backup and explicit downgrade exports.

## API

Authenticated `/api/workspace` and capability-scoped `/api/workspace/control` actions:

- `history`: checkpoint metadata and current revision.
- `checkpoint`: optional `label`; new clients send `base_revision`, `operation_id`, `intent`; returns checkpoint ID and receipt.
- `restore`: `checkpoint_id`, `base_revision`, `confirm:true`.

The controller CLI exposes `history`, `checkpoint --label TEXT`, and `restore CHECKPOINT_ID --base-revision N --confirm`, as well as read/apply/preview/publish. Restore requires explicit user intent. The independent `/recovery` page also offers authenticated history and revision-checked restore without loading the normal renderer. See [Recovery](RECOVERY.md) for its narrower guarantees and limitations.

## Verification

Automated tests cover persisted restoration, stale revision rejection, required confirmation, authorization, plugin batch atomicity and receipt replay. The isolated `tests/recovery-real-server.browser.py` exercises UI restore through the real server despite a broken renderer/app; `tests/workspace-store.browser.py` verifies a built-UI sync and pre-change checkpoint. Older `*-live.py` scripts are not fresh verification and must be audited for isolation before use. No iframe document-continuity guarantee follows from a saved checkpoint.
