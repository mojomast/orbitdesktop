# Roadmap

Orbit's direction is an agent-customizable workspace with reversible changes and a small trusted core. This page distinguishes shipped behavior from proposed work; version labels in old research are not release promises.

## Delivered

- Windows/Spatial/Focus views, drag/resize, pane splits, sidebar controls and persistent layout.
- Real Hermes chat, scoped workspace control, runtime steering/activity, supported live events, skills/toolsets discovery and scheduled-task listing with confirmed pause/resume.
- Linux tmux-backed shells that retain shell state across browser reload and authenticated reconnect.
- Live structured appearance controls and automatic checkpoints before agent/controller and plugin-manager mutations.
- Sandboxed app plugins: install, enable, configure, update, disable, remove, disable-all; strict manifest/config contract; content-addressed static publication.
- Checkpoint restoration of workspace state, plugin configuration and versioned entry references.
- Trusted integration registry and on-demand loading of existing tool dialogs.
- Request-time workspace operator instructions, repository agent guide and real browser verification workflows.

## Next: finish the modular boundary

1. Extract pane/rendering coordination behind tested interfaces without changing stable pane IDs or losing sessions.
2. Add scoped, permission-reviewed service APIs for plugins that need actual host data. No ambient filesystem/shell authority.
3. Add independent pre-boot safe mode and recovery UI that does not mount optional plugins.
4. Add staging, preview, reproducible tests and promotion of the exact tested bundle.
5. Add dependency/version compatibility checks, resource limits and auditable lifecycle events.
6. Enforce bundle integrity and retention; protect checkpoint-referenced assets from garbage collection.

Acceptance: install/configure/upgrade/rollback a plugin while a terminal and chat remain usable; a deliberately broken plugin must not block recovery. Full modularity is not achieved merely by wrapping app iframes in manifests.

## Reliability and everyday use

- Explicit terminal session listing/termination and orphan retention policy; race/reconnect/backpressure stress tests.
- Readable checkpoint diffs, preview and conflict handling; server-side transaction strategy for concurrent processes.
- Persist plugin-owned data separately from UI configuration, with explicit backup scope.
- Cross-device Orbit-only conversation library; streaming transcript and reconnect semantics.
- Accessible window navigation, keyboard manipulation and responsive small-screen layouts.
- Automated browser CI and platform support matrix. Linux is verified; other persistent terminal platforms need adapters/testing.

## Later / separate tracks

Direct SSH hosts with host-key validation; multi-user auth and per-user execution isolation; additional host adapters; full browser-engine sessions; headset/WebXR rendering. Iframes cannot become unrestricted browsers by weakening CSP. Host reboot persistence requires a separate process restoration strategy.

## Non-goals for current plugins

Arbitrary unreviewed code in the parent page, silent credential distribution, public unauthenticated shells, and pretending workspace rollback can undo external side effects.
