# Architecture

## Connected surface rendering

Pane views are keyed by stable pane IDs, with kind and browser URL determining
runtime replacement. Layout reconciliation creates connected slots and parks
surviving views in a connected host before removing old containers; native
`Element.moveBefore` preserves iframe document state during same-document moves.
CSS3D anchors are connected before accepting existing views and are pruned even
in Windows mode. The non-native fallback warns and **does not guarantee iframe
continuity**. Explicit imports/presets intentionally replace views; checkpoints
cannot resurrect a disposed document. See [runtime continuity](RUNTIME_CONTINUITY.md)
for measured coverage and [docking evaluation](DOCKING_EVALUATION.md) for candidate
research, not a selected replacement framework.

Test servers can set `ORBIT_TMUX_SOCKET` to a validated private socket name and
`ORBIT_TMUX_CONFIG=/dev/null` to avoid loading personal tmux configuration. History
capture uses the same socket as the provider. Defaults remain `orbit-persistent`
and normal tmux configuration; these settings do not isolate an entire host.

Orbit is a single-owner agent-customizable workspace. It separates trusted core/integration code from sandboxed generated app plugins; it is not fully modular yet.

## State and control

`src/model.ts` validates layout, structured appearance and plugin instances. `src/workspace-ops.ts` applies targeted operations to a clone; `src/plugins.ts` implements plugin lifecycle. The service in `server/workspace.mjs` authenticates browser requests with Orbit token/origin checks, and agent requests with a workspace-scoped capability. Strict request schemas precede semantic checks. `SqliteWorkspaceStore` atomically commits state/revision, applicable checkpoints, keyed command receipts and metadata outbox rows in `.runtime/workspace.sqlite`. Existing JSON runtimes require an explicit offline migration; originals remain archived, never a writable fallback. Private `workspace-access` files are credential/API discovery projections only. The serialized layout remains v1; there is no normalized surface migration yet. See [Workspace store](WORKSPACE_STORE.md).

`src/workspace-sync.ts` polls and tracks browser acknowledgement. An acknowledged revision does not prove a widget rendered correctly. Local layout persistence and imports remain supported. Offline changes can be saved server-side; display acknowledgement waits for the browser.

Schema 3 adds an indexed bundle registry and workspace-scoped metadata event queries.
Normal reads use indexed asset versions; startup/admin publication refresh performs
filesystem scanning. Hash-addressed asset responses verify indexed bytes before serving.
Retention plans include all saved revisions/checkpoints and are dry-run only.
`server/workspace-events.mjs` provides authenticated bounded POST event pages, not SSE;
`src/workspace-events.ts` keeps an in-memory reconnect cursor and triggers coalesced
state reads. Ordinary polling remains the fallback. Neither events nor acknowledgement
prove rendering, and no credentials or terminal/conversation content belong in events.

The owner-only recovery console can persist a registered-plugin activation hold
outside checkpoint state. Policy generation and candidate-state checks share the
command transaction. Entering hold disables plugins; release never auto-enables them.
Receipts from older policy generations fail closed rather than replaying an obsolete
activation snapshot. This does not stop cached/offline frames or external backends,
block public app files, or implement general safe boot. See [Recovery](RECOVERY.md).

## Two extension boundaries

Trusted built-ins use `src/workspace-extensions.ts`: typed activation entries dynamically load plugin manager, checkpoints, skills catalog, outputs and jobs. Live activity is also loaded on demand. These modules run in the parent page and are reviewed application code. They are not user-installable privileged plugins.

Generated app plugins use a strict API-v1 manifest and config contract. `scripts/plugin_publish.py` copies static bundles to content-addressed folders. Lifecycle/config/entry references are part of workspace state and checkpoints. The existing sandboxed browser pane hosts the app; no host credentials or privileged message bridge are granted. Network access is allowed by the current app CSP. See [PLUGINS.md](PLUGINS.md) for limitations, including the absence of filesystem-enforced immutability, dependency resolution and independent safe boot.

## Hermes

`server/agent.mjs` bridges authenticated runs, bounded server-loaded conversation history, approvals, stop, steering, activity, capabilities, catalog and job controls. `server/workspace.mjs` supplies the active workspace context and reads `docs/AGENT_GUIDE.md` into it at request time. Editing that guide updates subsequent contexts without copying instructions into several prompts. `src/agent-chat.ts` retains per-pane UI state; Hermes is a real runtime, not a chat stub.

The gateway's tool environment may differ from the terminal host. Local workspace control requires access to the repository/runtime; it is not automatically available to a remote gateway. Layout metadata does not expose terminal buffers or embedded app DOM.

## Terminals

An authenticated same-origin `/api/terminal` WebSocket creates a node-pty client. `auth` accepts `token`, `cols`, `rows` and stable `pane_id`. On the verified Linux deployment, `LocalHostProvider` attaches valid pane IDs to `/usr/bin/tmux -L orbit-persistent` session `pane-<id>`. The client can die while the shell survives. Unlock/reconnect after page reload reattaches; `exit` ends the shell. Legacy requests without a valid pane ID still use direct shells. Host reboot persistence is not implemented.

Transport retains input/resize/data/ack/exit/error messages, bounded output, heartbeat and backpressure. ACK uses JavaScript UTF-16 string length after xterm consumes output. Killing a tmux client is not killing the detached shell. Detached sessions consume resources and require owner cleanup. This is one OS user's workspace, not per-user process isolation.

## Rendering

Three.js PerspectiveCamera drives WebGL decoration plus CSS3DRenderer HTML monitor surfaces. Text, xterm and iframe controls remain native DOM. Stable pane IDs preserve views where possible. Focus mode moves a monitor element to a flat layer; iframe reparenting can reload embedded content. CSS3D is not a browser engine or WebXR layer. Spatial units express relative layout, not real-world calibrated dimensions.

`src/scene.ts`, `src/windows.ts`, `src/main.ts` and `src/panes.ts` still contain the core renderer/pane coordination. These have not been replaced by plugins. Appearance tokens apply through `src/workspace-appearance.ts`; built stylesheet swapping is separate from plugin lifecycle and does not hot-replace production JavaScript.

## Source map

| Component | Files |
| --- | --- |
| State and operations | `src/model.ts`, `src/workspace-ops.ts`, `src/plugins.ts` |
| Workspace persistence / context | `server/workspace.mjs`, `src/workspace-sync.ts` |
| Checkpoints / recovery policy | `server/sqlite-workspace-store.mjs`, `src/workspace-history.ts`, `public/recovery.js` |
| Trusted extensions | `src/workspace-extensions.ts` |
| Plugin management / publishing | `src/plugin-manager.ts`, `scripts/plugin_publish.py` |
| Agent bridge / UI | `server/agent.mjs`, `src/agent-chat.ts` |
| Host PTYs | `server/local-host.mjs`, `server/index.mjs`, `src/panes.ts` |
| Security | `server/security.mjs`, sandbox headers in `server/workspace.mjs` |
| Agent instructions | `docs/AGENT_GUIDE.md`, `AGENTS.md` |

For operation contracts use [Workspace control](WORKSPACE_CONTROL.md), not architecture prose. For shipped versus proposed scope use [Roadmap](ROADMAP.md).
