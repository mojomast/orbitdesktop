# Orbit + Dockview spike browser contract

Build: `node experiments/orbit-docking/build.mjs` (output defaults to
`/tmp/opencode/orbit-docking-build`; optional first argument overrides within
`/tmp/opencode`). Dependencies: first run
`bash experiments/docking/setup.sh /tmp/opencode/orbit-docking-deps`.
Copy build contents into a **disposable server's** `dist/orbit-docking/`, then open
`/orbit-docking/index.html?fixture=ENCODED_LOCAL_APP_PATH`.
The private browser fixture injects a disposable token through a top-frame init
script (`window.__orbitSpikeToken`), consumed and deleted during initialization;
credentials never enter the URL or browser storage.
The fixture must be a same-origin `/apps/<slug>/...` published fixture. Token is
optional for browser-only tests; connect the terminal explicitly using its real
“Connect to local host shell” button. No production server or dist is touched.

`await window.orbitSpike.ready` resolves after initialization and two animation
frames (fixture document loading is independently awaited by the harness).
Native `Element.moveBefore` is required; ready rejects if absent.

Stable initial window IDs: `window-a`, `window-b`, `window-terminal`.
Pane IDs are fresh UUIDs per load; discover them in window order from
`snapshot().state.monitors[*].layout.pane.id`. They remain stable throughout a
running experiment and enable the actual private-socket tmux pane binding.
Initial state has three windows, one pane each, two sandboxed fixture browsers
and one real `createPane` xterm terminal. No agent/chat is instantiated.

`await window.orbitSpike.command(name, args = {})` resolves to `snapshot()` with
`details`; invalid/unsupported operations reject before state mutation.

Commands:
- `apply`: `{operations: [v1WorkspaceOperation, ...]}` atomic candidate validation.
- `checkpoint` / `reconcile`: `{state: completeV1Workspace}` externally supplied.
- `select`: `{window_id}` (default selected window).
- `tab` / `move`: `{window_id, target_window_id, index?}` moves a whole window
  to another Dockview tab group; v1 window/pane ownership remains intact.
- `dock`: `{window_id, target_window_id, direction?: 'left'|'right'|'above'|'below'}`.
- `float`: `{window_id, x?:32, y?:32, width?:600, height?:420}`.
- `resize`: `{window_id, width?:600, height?:420}` group size; transient Dockview geometry.
- `reorder`: `{window_ids: all IDs exactly once}` applies v1 ordering and dock order.
- `spatial`: `{enabled?:true}`; `windows`: `{}`.
- `focus`: `{window_id}`; `unfocus`: `{}` (transient flat focus layer).
- `minimize` / `restore`: `{window_id}` (transient; connected DOM retained).
- `set-pane`: `{pane_id, kind?, url?}` uses v1 set_pane; owning window inferred.
- `close`: `{pane_id}` uses close_pane, or removes its window if sole pane.

Snapshot is JSON-serializable: `{state, panes: {[id]: {identity, kind, url,
connected, iframeIdentity, contentWindowIdentity, iframeLoads, terminalStatus}},
docking, focused, minimized, nativeMoveBefore, details?}`. Identity numbers are
per actual object via WeakMap, not inferred from IDs. Opaque sandbox document
nonce/draft and WebSocket/PID evidence must be checked by Playwright externally.
DOM selectors remain `.pane[data-pane-id="..."] iframe` / `.xterm-helper-textarea`.

Dockview owns window tabs/grid/floating placement; Orbit owns live connected
monitor/pane elements overlaid on library content rectangles. Tab/dock/float
placement is experiment-only transient state, never encoded as invented v1
fields. V1 checkpoint restoration reconciles panes and windows, while retaining
surviving Dockview panel identities. Cross-window pane ownership/splits use v1
`apply` or injected state. Unknown layout nodes (including persisted tabs), agent
panes, shared-browser panes, plugins, appearance overrides and sidebar overrides
are explicitly unsupported and rejected atomically. Supported monitor metadata
is retained; spatial geometry uses the real DesktopScene. No server workspace
sync is performed by the API itself; the harness supplies revision-checked
states from actual disposable-server checkpoint APIs for reconciliation.

Toolbar buttons have `data-command` matching command names. Target selectors
have accessible labels “Window” and “Target window”. Buttons are native keyboard
focusable. Dockview native tabs/sashes provide pointer drag; spatial background
navigation uses DesktopScene. This is an Orbit-authored command path, not a claim
of Dockview Enterprise keyboard docking support.
