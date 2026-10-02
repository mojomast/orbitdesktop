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

## Implemented development candidate (not a new published release)

The usability and technology branches now include:

- Shared Start/palette discovery, incremental chat rendering, persistent Outputs/
  Activity, typed settings, normal workspace arrangement and checkpoint comparison.
- Saved workspace layouts, a conversation library with host-backed drafts,
  independent stateless widget instances, declarative configuration forms,
  output metadata/search and explicit selected-draft context insertion.
- Source-backed keyword/optional semantic search, A2UI v0.9 imports, local voice
  transcription, DuckDB Data Lab, Lexical documents, Excalidraw canvases and traces.
- Configurable disposable Browser copilot, separate-origin imported MCP Apps, and
  an optional gVisor check provider requiring suitable host acceptance.
- Predictable Start keyboard navigation and Spatial tool reveal; acknowledged
  conversation selection, bounded older-title search and goal-first onboarding.
- One exact-final-draft handoff with full citations and selected data values;
  explicit complete-result delivery to A2UI, document and MCP snapshot surfaces.
- Same-tab closed-document recovery, reviewed imports, selected-content sharing,
  digest/revision-bound proposals and native editor Undo.
- Logical arrangement history outside active-preview capacity, recovery of proven
  completed setup copies and published integrations, review-only durable waits and
  authoritative task-status snapshots.
- Selected-resource local adapter grants and atomic cited editable-brief creation;
  actual recipient support and configuration are in [Resource delegation](RESOURCE_DELEGATION.md).

See [Usability](WORKSPACE_USABILITY.md), [Technology features](TECHNOLOGY_FEATURES.md),
[prompt examples](WORKSPACE_PROMPTS.md) and [verification status](VERIFICATION.md).
Owner walkthrough, merges and release-version selection remain pending. Workbench
stays experimental/off by default. Automatic source crawling, Hermes A2UI/MCP
server discovery and autonomous browser planning are not implemented. The
[agency evolution](AGENCY_EVOLUTION.md) records cross-feature outcome acceptance.
Physical task/history compaction, automatic recurring dispatch and a durable
historical task-transition stream remain separate work.

## Continuing work: finish the modular boundary

Some foundations below now have bounded implementations (connected pane retention,
registered-plugin recovery hold, exact-artifact Studio and bundle retention plans).
Their documented limits still apply; this list describes the broader remaining goal.

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
