# Hermes workspace operator guide

## Default behavior

Act on the workspace ID supplied by the Orbit conversation context. Never choose another workspace by scanning runtime records. Run the controller yourself rather than instructing the owner to paste commands. Read current state first. The CLI keeps capability credentials private; never print runtime JSON or `.env` files.

1. `python3 scripts/workspace_control.py --workspace WORKSPACE_ID read`
2. Pick the narrowest supported operation. Layout/appearance changes use `apply`. New widgets use the plugin publisher and lifecycle below. Preserve existing pane IDs, running terminals and unrelated configuration.
3. Apply through the controller. Mutations validate the complete batch, check revision and create a checkpoint. If a conflict occurs, read again and reconsider the request; do not blindly replay destructive operations.
4. Check `browser_applied` / `observed_revision`. If offline, say saved and pending display; do not claim the owner can see it. Acknowledgement proves state synchronization, not that a plugin rendered correctly. Inspect the page for visual or behavioral claims.

Commands are relative to the repository; context supplies an absolute controller path. Hermes tools must have access to this repository/runtime. A remote gateway needs an explicitly provisioned adapter; do not assume its filesystem is the terminal host.

## New widgets: plugin-first

Build a static app using relative assets in a new source folder. Never package tokens, credentials, private reports or personal data in public app files. Read `docs/PLUGINS.md`.

```sh
python3 scripts/plugin_publish.py /absolute/build --id focus-timer --version 1.0.0 --title 'Focus timer'
```

Capture the emitted manifest. Do not invent its content hash or entry path. Then pass this operation, with that actual manifest, to the controller:

```json
{"action":"plugin_install","manifest":{"apiVersion":1,"id":"focus-timer","version":"1.0.0","title":"Focus timer","entry":"/apps/ACTUAL-PUBLISHED-SLUG/index.html"},"config":{"minutes":25}}
```

Installation is disabled. Test the published entry, then `{"action":"plugin_enable","plugin_id":"focus-timer"}`. Use `plugin_configure` to replace primitive-valued config. Read/merge existing config first when making a partial change. Config is passed in the URL fragment and must not contain secrets. Plugins receive no privileged host bridge.

For an update, publish changed files, use `plugin_update` with `plugin_id` and the new manifest, inspect, and restore a checkpoint on regression. Do not overwrite the previous content-addressed bundle. Disable/remove operations retain files. `plugin_disable_all` is a recovery action affecting all plugin windows and should reflect the user's intent, not routine housekeeping.

## Appearance and layout

`set_appearance` replaces the entire object: preserve existing fields when adjusting one. Supported: six-digit hex `background` and `textColor`, local `wallpaper` path (empty string means none), numeric `cornerRadius` 0–40. `{}` removes overrides. Text color is inherited monitor text, not terminal or iframe internal styling.

Layout operations: `add_window`, `update_window`, `close_window`, `split_pane`, `set_pane`, `close_pane`, `select`, `set_view`, `sidebar`, `set_workspace`. Read `docs/WORKSPACE_CONTROL.md` for shapes and limits. Prefer targeted updates; replacing the workspace is not a shortcut for adding a widget.

## Persistence and recovery

New terminal panes attach to tmux by stable pane ID. Reload → unlock host → reconnect resumes the shell. Do not delete/recreate terminal IDs to rearrange a workspace. Closing a pane detaches its persistent shell; `exit` ends it. Legacy non-tmux shells cannot be migrated automatically. Host reboot does not preserve shell processes. Layout metadata is not terminal output.

Checkpoint history and confirmed restore are available in Workspace checkpoints. API actions `history`, `checkpoint`, `restore` are supported by the authenticated workspace service (control route `/api/workspace/control`); the CLI currently exposes read/apply/publish, not standalone history/restore commands. Restore requires current `base_revision`, `checkpoint_id` and `confirm:true`. Use the UI rather than inventing CLI commands. Checkpoints restore plugin registrations/config/entry references and structured layout/appearance, not emails, shell effects, conversations, image bytes or arbitrary files.

## Boundaries and completion

No fully modular renderer, backend plugin permissions, dependency resolver or independent safe-mode boot exists yet. Trusted built-ins use `workspace-extensions.ts`; those changes need a build and new frontend load. Ordinary workspace/plugin operations do not. Generated code stays in sandboxed app panes, never injected into the parent page.

Completion reports should name the operation, test evidence, checkpoint/rollback limitations and whether browser display was verified. Never replace real tests with plausible sample output. Keep current user appearance and other uncommitted work intact.
