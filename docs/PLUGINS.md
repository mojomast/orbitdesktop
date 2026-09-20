# Workspace plugins v1

This is a working sandboxed-app lifecycle and trusted built-in extension registry, not a complete conversion of Orbit into plugins.

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

## Trusted built-in modularization

`src/workspace-extensions.ts` defines a typed activation registry for plugins, checkpoints, skills catalog, outputs and scheduled tasks. These are independently imported UI modules rather than hardwired imports inside chat. Live activity is lazy-loaded too. Activation failures are reported rather than silently swallowed. This registry is trusted application code and is NOT the sandbox plugin registry; adding a trusted built-in still requires a frontend build. Core terminal, chat, scene and layout renderer remain built in.

## Recovery and boundaries

The disable-all control is useful recovery, but not independent pre-boot safe mode: a bad plugin can still consume browser resources. General dependency resolution, capability-granted host APIs, persistent plugin storage, signed packages, background workers, preview/test promotion, independent recovery boot and full conversion of the pane/scene renderer are outstanding.

Content-addressed folders avoid overwriting through this publisher; filesystem owner edits or the older generic publisher can still mutate/delete them. These are version-pinned references, not a filesystem-enforced immutable store or disaster backup. Never rewrite published hash folders. No installer dependencies or third-party packages are executed.

## Deployment and tests

Current Tailscale backend: 4333, `orbitdesktop-plugins.service`. Older services are preserved for pre-upgrade shells. Persistent unit and default.target symlink installed. New frontend needs a new page load once; subsequent plugin operations are live.

`npm run check`: 43 passing Node tests. `python3 tests/plugin-publish.test.py`: content-addressed reuse, changed-version retention and symlink rejection. `tests/browser-plugins-live.py`: real publish/install/enable, controller configure, disable and checkpoint restore, same document, no JS errors. `tests/browser-terminal-reload-live.py`: actual browser reload retains shell variable. These operate in separate temporary browser workspaces, not the owner's active layout.
