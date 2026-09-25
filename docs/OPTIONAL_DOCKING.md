# Optional docking placement (off by default)

Status: opt-in experimental renderer. It is **not** the default workspace
renderer, it does not change the v1 layout schema, and it grants no new
permission or private-data path. Use it only by explicitly opting in from a local
browser URL. Nothing enables it automatically for the owner.

## What it does

The normal Orbit renderer places each window as a movable desktop window inside
`.desktop-host`. The optional docking renderer keeps that same DOM and the same
`PaneView` runtimes, but positions each live `<article class="monitor">` element
over a rectangle owned by a pinned `dockview-core@8.3.1` grid. Windows therefore
gain library-provided **transient** tabs, docking and floating placement while
Orbit keeps owning pane identity, iframe document retention, PTY/WebSocket
lifetime, v1 layout, focus/spatial behavior and checkpoints.

- v1 `Workspace` (windows, panes, kind, URL, plugins) remains the **only**
  authoritative persisted layout.
- Dockview tab/group/floating placement is transient: it is **not** written to
  v1, localStorage, the server or checkpoints, and it **resets on reload**.
- Layout-only changes (select, tab, dock, float, resize, reorder, spatial, focus)
  reuse the existing connected monitor elements through
  `src/connected-dom.ts` (`Element.moveBefore`) and must not dispose, reload or
  reconnect any iframe or terminal.
- The default renderer is behaviorally unchanged when the opt-in is absent.

The rendering approach and its measured limits were established by
[the docking spike](ORBIT_DOCKING_SPIKE.md): Dockview owns transient grid/tab/
floating placement, Orbit owns runtime identity. See
[runtime continuity](RUNTIME_CONTINUITY.md) for the default connected-DOM gate.

## Enabling

Append the local query flag to the built UI URL:

```
http://127.0.0.1:<port>/?renderer=docking
```

- The flag is read only from the current browser URL (`dockingRequested`). It is
  never stored. Opening the UI without `?renderer=docking` uses the unchanged
  default renderer.
- The small adapter logic is imported by the main entrypoint; its Dockview library
  and styles load through dynamic `import()` only on explicit installation.
  `dockview-core` is not part of the main bundle.

## Fail-closed behavior

- **No `Element.moveBefore`**: the renderer refuses explicitly. It renders a
  `.docking-unsupported` alert naming `Element.moveBefore`, sets
  `document.documentElement.dataset.dockingRenderer = "unsupported"` and
  `window.__orbitDocking = { renderer: "docking", supported: false, reason }`, and
  leaves the default movable-window renderer in place. This is an explicit
  refusal, never a silent `insertBefore` fallback presented as success.
- **Unsupported layout constructs**: `dockingUnsupportedReason` rejects a missing
  workspace, no windows, or duplicate/empty window ids before any DOM or Dockview
  mutation. Complex split layouts, plugin-backed windows, appearance overrides,
  spatial fields and every `PaneKind` are supported and placed as whole-window
  panels — the renderer does not second-guess main's normal renderer.
- **Invalid placement operations** (tab/dock onto the same window, float an
  already-floating window, return a docked window, unknown target) are rejected
  atomically with a status message; panels, placement and v1 state are unchanged
  and no runtime is disposed.
- No server route, credential, grant, observation or privileged plugin API is
  added. Dockview close/tab-action controls that could destroy a runtime are
  hidden; closing panes still goes through the normal Orbit confirmation and
  workspace operations.

## Keyboard and pointer controls

`.docking-toolbar` exposes native, focusable, labeled controls (no Dockview
Enterprise feature):

| Control (accessible name) | Effect |
| --- | --- |
| `Docking window` select | chooses the window the commands act on |
| `Docking target` select | chooses the tab/dock target window |
| `Select window` | runs the normal Orbit select operation |
| `Tab to target` | docks the window as a tab in the target group |
| `Dock left` / `Dock right` | docks the window beside the target |
| `Float window` | detaches the window into a floating group |
| `Return to grid` | returns a floating window to the docked grid |

Toolbar activation via pointer or keyboard returns focus to the activating
control when it is still connected. Dockview's native tabs and sashes provide
pointer drag; pointer resize changes actual panel geometry (not just a
hit-testable handle). `.dv-default-tab-action` is hidden so the library cannot
silently close a pane.

## Persistence and recovery

- Tabs, dock direction, floating position and transient geometry are not saved
  and are intentionally absent after reload. Reloading shows the v1 layout.
- Normal workspace sync, browser acknowledgement, checkpoints and restore are the
  authoritative behavior and are reused unchanged. Checkpoints retain a document
  only while its pane identity/kind/URL still corresponds to a live runtime; they
  cannot resurrect a document that a URL change or close deliberately disposed.
- Closing a pane or changing a browser URL still disposes/replaces that runtime;
  docking adds no way to preserve it.

## Verification

Measured on this checkout (Chromium 145.0.7632.6 via the pinned Playwright
environment; no owner runtime, server, tmux socket or profile was used):

- `tests/docking-renderer.test.mjs`: **4/4**. Full build/Node and managed-provider
  verification is recorded in [the handoff](ORBIT_EVOLUTION_HANDOFF.md).
- `tests/docking-workspace.browser.py --pty`: **85 checks / 73 layout and
  continuity transitions pass, 0 fail**, exactly **1 terminal WebSocket**, with
  retained sandboxed iframe nonces/drafts/DOM identities, a fresh private-socket
  shell marker + retained variable + original PID at every transition, a real
  **45 px sash drag that changed measured panel geometry**, keyboard focus
  restoration, the self-target rejection controls, plugin publish/enable/update/
  disable, recovery-hold activation rejection, the separate-context missing-
  `moveBefore` explicit refusal (default placement still operational), and the
  URL-change / `close_pane` disposal negative controls. Browser acknowledgement
  was proved against the normal `main.ts` committed controller state (frame.z
  excluded), with the **server's `observed_revision` reaching the committed
  revision**, i.e. the real workspace path, not a module-only fixture.
- Lead review found opaque grid/floating backgrounds obscuring live panes despite
  passing identity checks. Those backgrounds are now transparent. A screenshot
  pixel probe verifies actual iframe paint, not only DOM visibility; synthetic
  screenshots were inspected outside Git. Additional regressions verify Windows
  focus/unfocus and that hidden docking tabs become visible when entering Spatial.
- `tests/runtime-continuity.browser.py` (default renderer, browser-only):
  **93/93 transitions pass** in the delegated run. The parent also runs the full
  **94-transition PTY** gate before final acceptance; see the handoff for results.

```sh
npm run check
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/docking-workspace.browser.py --pty
```

The browser gate copies the built UI/server into a disposable runtime (fresh
token, workspace UUID, HOME, cwd, private tmux socket and `/dev/null` config) and
drives `?renderer=docking` in real Chromium. The private tmux socket name must
stay short so the unix socket path fits the OS limit; the harness uses a short
`orbit-dock-` prefix. It never contacts the owner's server, tmux socket or
profile.

## Limitations

- Measured on Chromium only; Firefox/WebKit and non-`moveBefore` fallbacks are not
  compatibility guarantees.
- No Dockview Enterprise keyboard docking, popouts, cross-document iframe
  preservation or docking-library selection is claimed.
- This is a single-owner workspace experiment, not a permission boundary, not a
  normalized v2 surface model, and not a performance or accessibility
  certification. Live Hermes/conversation binding and production checkpoint
  conflict behavior are out of scope.
