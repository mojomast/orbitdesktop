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
gain library-provided tabs, docking and floating placement while
Orbit keeps owning pane identity, iframe document retention, PTY/WebSocket
lifetime, v1 layout, focus/spatial behavior and checkpoints.

- v1 `Workspace` (windows, panes, kind, URL, plugins) remains the authoritative
  pane/runtime layout. Docking placement is a separate versioned per-workspace
  adjunct, persisted only when the opt-in renderer is active.
- Layout-only changes (select, tab, dock, float, resize, reorder, spatial, focus)
  reuse the existing connected monitor elements through
  `src/connected-dom.ts` (`Element.moveBefore`) and must not dispose, reload or
  reconnect any iframe or terminal.
- The default renderer is behaviorally unchanged when the opt-in is absent.

The rendering approach and its measured limits were established by
[the docking spike](ORBIT_DOCKING_SPIKE.md): Dockview owns grid/tab/
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
- No new credential, grant or privileged plugin API is added. Dockview close/tab-action controls that could destroy a runtime are
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

- Tabs, split ratios, floating frames and the active docking window are saved
  through the additive `placement_save` command as a versioned per-workspace
  adjunct with shared workspace-revision CAS and durable command receipts.
  Reloading `?renderer=docking` restores that saved arrangement. Opening the
  default renderer leaves its v1 layout and behavior unchanged.
- Placement references stable v1 window ids; it is never written to v1 state,
  v1 layout or localStorage. Layout-only movement retains PaneViews and does
  not dispose panes. A full page reload creates fresh iframe documents but a
  reconnected terminal can reattach to its surviving tmux shell.
- Offline or rejected saves report an unsaved/conflict status rather than
  claiming persistence. An authoritative remote placement replaces pending
  local placement with a visible conflict notice. Recovery reads expose a
  placement summary independently of Dockview; checkpoint restore restores
  placement, and an old checkpoint without placement restores an empty adjunct.
- Checkpoints retain a document only while its pane identity/kind/URL still
  corresponds to a live runtime; they cannot resurrect a document disposed by
  a URL change or close.
- Closing a pane or changing a browser URL still disposes/replaces that runtime;
  docking adds no way to preserve it.

## Verification

Existing opt-in docking acceptance evidence (Chromium 145.0.7632.6, disposable
runtime) predates versioned placement and is recorded in the handoff. For the
placement change, the focused checks are:

- `node --experimental-strip-types --test tests/docking-renderer.test.mjs tests/docking-placement.test.mjs`: **10 passed**.
- `npx tsc --noEmit` and `npm run check`: passed; the full Node suite is **255/255**
  on this checkout.
- `tests/docking-persistence.browser.py`: **PASS** (Chromium 145.0.7632.6, disposable
  runtime). It grouped two windows and floated a third, the server persisted the
  adjunct (`placement_revision` 3), a reload restored the grouped + floating
  arrangement and the float frame within 6 px, hydration did **not** autosave
  (revision unchanged), the iframe document was fresh, and the reconnected tmux
  shell reported the same PID.
- `tests/docking-workspace.browser.py --pty`: **exit 0, 86 checks pass**, including
  the physical sash drag and the real controller checkpoint restore now carrying
  placement.

```sh
npm run check
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/docking-persistence.browser.py
```

The browser gate copies the built UI/server into a disposable runtime (fresh
token, workspace UUID, HOME, cwd, private tmux socket and `/dev/null` config) and
drives `?renderer=docking` in real Chromium. Private tmux socket names must stay
short so the unix socket path fits the OS limit (the harnesses use short
`orbit-dock-` / `orbit-persist-` prefixes). They never contact the owner's
server, tmux socket or profile.

## Limitations

- Measured on Chromium only; Firefox/WebKit and non-`moveBefore` fallbacks are not
  compatibility guarantees.
- No Dockview Enterprise keyboard docking, popouts, cross-document iframe
  preservation or docking-library selection is claimed.
- This is a single-owner workspace experiment, not a permission boundary, not a
  normalized v2 surface model, and not a performance or accessibility
  certification. Live Hermes/conversation binding and production checkpoint
  conflict behavior are out of scope.
