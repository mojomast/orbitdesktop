# Orbit docking spike: integrated adapter gate

Status: isolated experiment. The implementation contract is
[`experiments/orbit-docking/CONTRACT.md`](../experiments/orbit-docking/CONTRACT.md).
This experiment evaluates Dockview placement against real Orbit PaneView browser
and terminal surfaces and the v1 workspace model; it is not a production renderer
or a normalized persistence migration.

## Reproduce

```sh
bash experiments/docking/setup.sh /tmp/opencode/orbit-docking-deps
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/orbit-docking.browser.py
```

The test compiles the adapter under `/tmp/opencode/orbit-docking-build` and copies
the existing `dist/`, server, contracts and built adapter into a disposable server.
It publishes the existing local continuity iframe fixture into a private runtime,
creates fresh token/HOME/cwd/workspace UUID, runs a unique tmux socket with
`TMUX_TMPDIR` and `-f /dev/null`, and opens a fresh Playwright context. The server
environment is explicitly allowlisted. The existing `dist/` is copied, not modified;
the owner's `.runtime`, browser profile, default tmux socket and server are not
used. The disposable token is injected into the top frame, not the URL or storage.
Terminal evidence comes from fresh WebSocket data after test-only private
socket `send-keys`; old xterm scrollback is not accepted as evidence of a live PID.

The gate checks two published sandbox iframe documents' nonce/draft and original
parent pane, iframe and contentWindow object identities on every continuity
transition. It also checks original terminal PaneView identity, one terminal
WebSocket, a retained shell variable and original PID after each operation.
Mapping, docking/tabbing/floating, spatial/focus, geometry/reorder and v1
checkpoint-state reconciliation use an actual isolated server sync, controller
checkpoint/apply/restore and adapter reconciliation, not a fabricated JSON save/load.
Invalid mapping/reorder/unsupported appearance must reject without mutating state.
Physical sash dragging and keyboard Tab/Enter plus button-activated select/move/
dock/float with returned focus are checked separately. Deliberate URL and kind replacements and close
are negative controls; they must dispose the affected runtime, not retain it.

## Measured result

Two successive disposable Chromium 145.0.7632.6 runs passed **84/84 measured API
transitions** across seven rounds: seven each of select, tab, dock, float,
spatial, focus, unfocus, Windows, resize, reorder; fourteen server-state
reconciliations (seven actual checkpoint restores). Each step checked both
published sandbox iframe nonces, unsaved drafts, pane/iframe/contentWindow
object identities, pane-to-monitor/kind/URL bindings, unchanged single terminal
WebSocket, and original shell PID/retained variable in *new* terminal frames
from the private tmux session. The terminal pane ID is a fresh UUID and the
actual session `pane-<UUID>` received all test commands. Physical sash drag
changed group width **299→344 px**. Tab and Enter reached/activated native
toolbar buttons; authored keyboard select/move/dock/float retained focus. Seven
negative controls rejected invalid pane ownership/selected-window mapping,
reorder and unsupported appearance
atomically or intentionally replaced URL/kind and closed a pane. No page
exceptions or unexpected iframe navigations occurred in the continuity steps.
`python3 -m py_compile`, experiment TypeScript no-emit, isolated Vite build,
and the separate 11-transition browser-only smoke passed. The first integrated
run revealed a non-UUID synthetic pane ID: real PaneView then used a direct
shell, not private persistent tmux. UUIDs fixed that; later runs exposed hidden
tab xterm sizing, sash hit-testing and truncated tmux repaint output. Connected
hidden monitor geometry, overlay pointer layering and fresh-frame probe were
adjusted before the final passing runs. Two Chromium runs are not a
performance benchmark or a cross-engine guarantee.

## Architectural boundary and recommendation

Dockview owns transient grid/tab/floating placement; Orbit remains responsible
for pane identity, iframe document retention, PTY/WebSocket lifetime, v1 layout,
focus/spatial scene and checkpoint policy. Dockview placement does not invent v1
serialized tab fields. The harness obtains restored v1 state through real
disposable-server controller checkpoints and reconciles the adapter against it;
it does not exercise production UI browser acknowledgement or actual revision
conflicts. Native `Element.moveBefore` is required to preserve connected iframe documents on the
measured Chromium path. A same-ID URL/kind change or close deliberately disposes
runtime; no checkpoint can resurrect that iframe draft.

Recommendation: limit any production follow-up to a behind-the-adapter docking
placement experiment with explicit compatibility and accessibility gates. Do not
replace the current renderer or change the v1 persistence schema based on this
spike alone. Outstanding coverage includes other browser engines/fallback move,
assistive technology and robust keyboard docking, production checkpoint/ack behavior,
larger pane/split graphs, plugins/chat ownership and production performance.
If authorized, the next narrow production change would be an **off-by-default
trusted renderer entrypoint** with an application-owned connected pane-slot
adapter and explicit v1 unsupported-state error path; keep the existing renderer
as the default and preserve its 94-transition PTY acceptance gate. Only then
test actual browser acknowledgement/checkpoint sync, complex split ownership,
plugin/Hermes binding, keyboard focus order and bundle/cold-load cost before
considering selection. No v1 schema change or privileged plugin API is needed
for that gate.
Terminal commands deliberately use a short shell function so hidden-tab tmux
repaints do not scroll a long command beyond its viewport. Lead review removed an
over-permissive clipped-marker fallback: each probe now requires the complete
fresh marker, retained variable and PID together in new WebSocket output. Echoing
a command followed by an old repaint alone is not acceptable evidence. The lead
rerun passed all 84 transitions with this stricter assertion.
No Hermes request is made and no real agent/conversation binding is claimed.
