# Workspace plugins v1

This is a working sandboxed-app lifecycle and trusted built-in extension registry, not a complete conversion of Orbit into plugins.

## Partial configuration and window customization

`plugin_patch_config` with `plugin_id` and `patch` merges individual primitive-valued settings while preserving omitted fields. Example: `{"action":"plugin_patch_config","plugin_id":"notes","patch":{"message":"Updated"}}`. Use `plugin_configure` only when replacing the whole config is intended.

`plugin_window` with `plugin_id` and `settings` customizes name, fontSize, frame, diagonal, aspect, height, distance, pitch, yaw and offset. It works while disabled and applies saved settings when enabled. IDs/layout cannot be overwritten through this operation. The manager exposes **Window settings** as a JSON editor. All changes use the existing revision/checkpoint boundary.

Configuration and enable cycles now preserve window names and split trees instead of rebuilding a single browser pane. This preserves added terminal pane IDs; the plugin iframe itself may still reload. First matching app/browser pane is treated as the plugin surface; arbitrary multiple-app routing is not supported.

## User controls

Hermes tools → Workspace plugins, or Ctrl+Alt+P while the parent workspace has focus. The shortcut works without a chat pane. Install a manifest (disabled first), enable/disable, edit JSON configuration, remove, or disable all. Core terminals/chat are not optional plugins. Every plugin mutation through the manager or agent controller creates a workspace checkpoint. Restore via Workspace checkpoints. Closing a plugin window also makes its displayed status disabled; enable opens it again.

## Agent workflow

1. Build static HTML/CSS/JS using relative paths. Do not include secrets. `examples/plugins/notes` is a working example.
2. Publish: `python3 scripts/plugin_publish.py /absolute/build --id notes --version 1.0.0 --title 'Workspace notes'`. This emits a manifest, writes a new content-addressed folder under `.runtime/apps/`, rejects symlinks/hidden files, and limits bundles to 20 MB / 500 files. Identical files reuse the folder. Existing files are checked before reuse. Retain old folders for rollback. Atomic directory rename is publication, not proof that the app is safe or correct.
3. Use `scripts/workspace_control.py --workspace ID apply` with `{"action":"plugin_install","manifest":<emitted manifest>,"config":{"title":"My notes","message":"Hello"}}`. Install is disabled by default.
4. Enable with `{"action":"plugin_enable","plugin_id":"notes"}`. Read and verify observed_revision; inspect the actual iframe in browser tests before claiming it works.
5. Configure with `plugin_configure`, `plugin_id`, `config`. Config replaces the prior object. It allows up to 32 primitive-valued fields / 4096 serialized characters. No secrets: config is visible in the iframe URL fragment.
6. Publish changed files, then `plugin_update` with `plugin_id` and the new manifest. It retains plugin/window identity. Roll back with a workspace checkpoint, which restores the old entry URL and config.
7. `plugin_disable`, `plugin_remove`, or `plugin_disable_all` detach plugin windows. Removal does not delete published assets. There is no garbage collector yet.

All operations can be batched in the controller's existing atomic validated apply. Browser management uses authenticated `plugins_apply` with `base_revision` and `operations`; it only accepts plugin operations. Authentication and origin checks remain in the core.

## Manifest contract

API v1: `{"apiVersion":1,"id":"notes","version":"1.0.0","title":"Workspace notes","entry":"/apps/notes-HASH/index.html"}`. Supported fields only; arbitrary permissions, backend hooks and executable host code are rejected. Maximum 32 installed plugins, also subject to existing maximum window count.

Plugins render through existing sandboxed browser panes in Windows or Spatial view. They do not receive host tokens, parent DOM access or a privileged postMessage bridge. Network access remains allowed under the existing app CSP; this is NOT a network-denying sandbox. Static published files are not private credential storage. Entry existence and app behavior must be tested before activation; manifest validation alone does not verify them. Config changes can reload the affected iframe; its in-memory state is not preserved. Workspace checkpoints do not snapshot plugin internal application data.

Read config in the plugin with `JSON.parse(decodeURIComponent(location.hash.replace(/^#orbit-config=/,'')))`, using a try/catch and defaults. Render configuration text with textContent, not innerHTML. The sample demonstrates this.

## Reviewed live-tool feed exception

`src/tool-feed.ts` adds a one-way, read-only integration for the exact content-addressed Hermes Live Tools entry named in that module. Other plugin entries receive nothing. The trusted parent consumes the existing authenticated, conversation-scoped SSE endpoint for open Orbit chat panes only while the widget is attached. It passes only validated tool names, lifecycle event names, timestamps, durations and error flags via postMessage to the sandboxed frame. No credentials, arguments, previews, results, conversation text, requests or host actions cross this bridge. Plugin updates to a different bundle require a reviewed entry change and frontend build; this is not a generic permission system. Disable/remove disposes the sink and stops stream subscriptions on the next tick. History is bounded to 80 in-memory events and reconnect replay is not guaranteed. Refresh Orbit once after deploying this frontend integration; plugin installation itself remains live. Workspace checkpoints revert plugin registration/layout but not these source changes.

## Trusted built-in modularization

`src/workspace-extensions.ts` defines a typed activation registry for plugins, checkpoints, skills catalog, outputs and scheduled tasks. These are independently imported UI modules rather than hardwired imports inside chat. Live activity is lazy-loaded too. Activation failures are reported rather than silently swallowed. This registry is trusted application code and is NOT the sandbox plugin registry; adding a trusted built-in still requires a frontend build. Core terminal, chat, scene and layout renderer remain built in.

## Recovery and boundaries

The independent `/recovery` console has a persistent registered-plugin activation hold,
separate from reversible disable-all. The owner can enter hold to disable registered
plugins and prevent later sync, restore or enable from activating them. Layout undo
cannot release the hold; explicit owner release does not auto-enable plugins. This is
not a full pre-boot safe mode: cached/offline clients and already-running frames can
still consume resources, static app URLs remain available, and backends are not stopped.
See [Recovery](RECOVERY.md). General dependency resolution, capability-granted host
APIs, persistent plugin storage, signed packages, background workers, preview/test
promotion and full conversion of the pane/scene renderer are outstanding.

Content-addressed folders avoid overwriting through this publisher; filesystem owner edits or the older generic publisher can still mutate/delete them. These are version-pinned references, not a filesystem-enforced immutable store or disaster backup. Never rewrite published hash folders. No installer dependencies or third-party packages are executed.

## Deployment and tests

Historical deployment notes describe a Tailscale backend on 4333 and
`orbitdesktop-plugins.service`, with older services retained for pre-upgrade shells.
These are not freshly verified deployment status. Do not restart or upgrade them
without checking session preservation and obtaining deployment authorization. A new
frontend needs a page load once; subsequent plugin operations are live.

Use `npm run check` and `python3 tests/plugin-publish.test.py` for current regression
checks, including content-addressed reuse, changed-version retention and symlink
rejection. `tests/recovery.browser.py` and `tests/recovery-real-server.browser.py`
exercise independent recovery in isolated runtimes/browser contexts. Fresh results
and counts are recorded in `ORBIT_EVOLUTION_HANDOFF.md`. Older
`browser-plugins-live.py` and `browser-terminal-reload-live.py` scripts describe earlier
integration checks; audit their isolation before use and do not present their past
results as fresh evidence of current renderer/session continuity.
