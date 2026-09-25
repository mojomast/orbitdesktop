# Opt-in Orbit / Dockview integration spike

This directory is self-contained experiment source. See [CONTRACT.md](CONTRACT.md)
for the exact browser API and disposable server setup. Build output and pinned
third-party dependencies live under `/tmp/opencode`.

```sh
bash experiments/docking/setup.sh /tmp/opencode/orbit-docking-deps
./node_modules/.bin/tsc --noEmit -p experiments/orbit-docking/tsconfig.json
node experiments/orbit-docking/build.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python experiments/orbit-docking/smoke.py
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/orbit-docking.browser.py
```

## Design boundaries

- Real `createPane`/`PaneView`, v1 `validate`/`applyOperation`, connected DOM parking,
  and real `DesktopScene`. No agent pane is instantiated.
- Dockview hosts empty geometry placeholders. Orbit owns live monitor/pane DOM
  over those rectangles, so Dockview may rebuild its own containers without
  disconnecting an iframe or terminal. Switching to spatial/focus uses native
  `moveConnected`, with an explicit native capability failure at startup.
- Dockview tab grouping, docking and float geometry are transient adapter state.
  V1 ownership/split trees are authoritative. Checkpoint injection reconciles
  those trees, retains surviving runtime signatures, and disposes changed URL/kind
  or removed panes. It does not invent a tabs schema or promise checkpointed tab
  topology. Monitor frame metadata is preserved but Dockview controls flat geometry.
- Candidate state is fully validated before DOM reconciliation. Unsupported
  kinds/URLs, plugins, sidebar and appearance overrides fail before state changes.
  This does not promise rollback after an unexpected renderer/library exception.
- The prototype samples library geometry each animation frame. It has not been
  optimized or established as a production accessibility/performance solution.
- Pane IDs are fresh UUIDs required by Orbit's persistent tmux binding, not
  deterministic labels. A hidden Dockview tab retains connected 960×700
  geometry to avoid collapsing its live PTY to a tiny terminal grid.

## Verification recorded

Chromium 145.0.7632.6 smoke passed 11 API transitions, native keyboard activation
of Spatial/Windows buttons, and a physical Dockview sash drag (533 → 578 px).
Both sandboxed iframe document nonces, unsaved drafts and actual pane/iframe/window
object identities survived. Atomic unsupported-layout rejection, deliberate URL
replacement and close disposal passed without page exceptions. TypeScript check
and isolated Vite build passed. This smoke does **not** connect the terminal;
the separate acceptance harness passed 84 real-PTY transitions with one
WebSocket, fresh variable/PID frames, seven server checkpoint restores and
physical pointer resize (299 → 344 px). See the full evidence and limitations
in [`docs/ORBIT_DOCKING_SPIKE.md`](../../docs/ORBIT_DOCKING_SPIKE.md).
Native tab drag/drop, floating-window pointer drag, screen readers and additional
browser engines have not been established by this smoke.

The real pane module transitively imports more Orbit code/styles than this spike
uses: Vite reports a roughly 1.2 MB uncompressed main JS chunk, unresolved optional
font/art/wallpaper references, and a mixed static/dynamic shared-browser import.
Those are reported build warnings, not measured runtime/model calls. The full
`npm run check` writes production `dist`; it is deliberately left to the lead
session's verification scope rather than executed by this source-only subagent.
