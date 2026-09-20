# Workspace checkpoints

## Included

Checkpoints persist the validated Workspace model: window/pane layout and geometry, font/view/sidebar settings, structured appearance, plugin manifests/configuration/enabled windows and published entry references. They live as owner-only JSON under `.runtime/checkpoints/<workspace>/`. Workspace authentication capabilities are not copied.

Agent controller `apply` and browser `plugins_apply` save the prior state after validating the complete operation batch and before commit. Manual saves are available in Hermes tools → Workspace checkpoints. Ordinary browser layout synchronization does not automatically checkpoint every drag.

Restore requires explicit confirmation and the current revision. It validates the saved state, creates a before-restore checkpoint, then persists a new revision. The connected browser synchronizes without requiring document reload. Restore can remove panes; persistent tmux shells detach, while legacy direct shells may exit.

## Not included

Arbitrary CSS/theme source, wallpaper image bytes, plugin internal data, conversation contents, live processes, filesystem edits, sent messages and remote API effects are not snapshotted. Plugin rollback restores old entry references; it only restores the previous app code if that bundle is still present and unchanged. Use content-addressed publication and retain old assets. Checkpoints are not a disaster backup.

There is no retention pruning yet. Monitor disk growth. Atomic file rename protects individual records but is not a multi-file database transaction. Multiple old backend processes may remain for existing terminals; concurrent writes across processes require additional coordination work.

## API

Authenticated `/api/workspace` and capability-scoped `/api/workspace/control` actions:

- `history`: checkpoint metadata and current revision.
- `checkpoint`: optional `label`; returns checkpoint ID.
- `restore`: `checkpoint_id`, `base_revision`, `confirm:true`.

The controller CLI currently exposes read/apply/publish; do not invent CLI restore/history commands. The UI handles the restore confirmation flow.

## Verification

Automated tests cover persisted restoration, stale revision rejection, required confirmation, authorization and plugin batch atomicity. Real browser tests cover save/restore, appearance rollback and plugin configuration/window restoration without document reload. See `tests/browser-checkpoints-live.py`, `tests/browser-appearance-checkpoint-live.py`, and `tests/browser-plugins-live.py`.
