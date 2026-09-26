# Renderer parity acceptance (default vs opt-in docking)

`tests/renderer-parity.browser.py` is a disposable real-Chromium gate that proves
the opt-in `?renderer=docking` renderer is behaviorally identical to the
default renderer for **runtime continuity**, and that docking adds its placement
overlay without disposing any pane runtime.

It runs the *same* deterministic scenario twice against one disposable server —
once at `/` (default renderer) and once at `/?renderer=docking` — in two isolated
browser contexts and two isolated workspaces, then asserts their normalized
behavior transcripts are equal. This is the parity companion to
[runtime continuity](RUNTIME_CONTINUITY.md) and
[optional docking](OPTIONAL_DOCKING.md).

## Commands

Build first (`npm run build`); a `dist/` without the docking contract fails
explicitly instead of skipping.

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/renderer-parity.browser.py

# Real private tmux shell probed at every transition:
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/renderer-parity.browser.py --pty
```

The run prints one `PASS` JSON line with the per-renderer transition count,
Chromium version, zero page errors, final `revision`/`observed_revision`, whether
the restored frame coordinates match on **both** renderers
(`rollbackFrameXY.bothMatchRestored`), and the docking placement-revision fields
(`passive_placement_revision`, `saved_rollback_revision`, `placement_revision`).
Screenshots are written to
`/tmp/opencode/orbit-renderer-parity-{default,docking}.png` (never in Git).

## Final results

Measured against the final build — `dist/index.html` sha256
`dc62f47d8dc59c798d2c032b38a98882e3838b8e208de15476d3aa5fa3e5d3ed`, identical
before and after the runs; `npm run check` reports **278/278** passing on this
build — all with `--pty`:

| Gate | Result | Transitions | Page errors | `revision` / `observed_revision` |
| --- | --- | --- | --- | --- |
| `renderer-parity.browser.py` | PASS | 34 per renderer | 0 | default 21/21 · docking 26/26 |
| `runtime-continuity.browser.py --renderer default` | PASS | 94 | 0 | 53/53 |
| `runtime-continuity.browser.py --renderer docking` | PASS | 94 | 0 | 53/53 |

Chromium `145.0.7632.6`. The parity gate reported
`rollbackFrameXY.bothMatchRestored: true` — restored coordinates `[30,30]`,
`[250,75]`, `[470,120]` are identical on both renderers and equal the checkpoint's
expected frames — plus docking `passive_placement_revision: 0` (no auto/default
placement write from passive reconciliation or checkpoint rollback),
`saved_rollback_revision: 23` unchanged after a saved-placement rollback (no
feedback echo), and `placement_revision: 24` after an explicit physical sash drag.
`identicalTranscripts: true` across the full normalized transcript.

## What "parity" means here

For every step the harness records a normalized transcript entry containing
`view`, `selected` (by stable index), `monitors` with normalized `layout` pane
indices, full frame x/y/width/height, minimized state, focus-host count, cumulative iframe
navigations, terminal WebSocket count, and the retained-iframe continuity
booleans. Equality is asserted across the whole transcript; the scenario is
deterministic and uses stable window/pane indices, so the two runs are directly
comparable.

Both renderers are driven through the same sequence, mixing real UI interactions
with revision-checked controller API calls:

- real UI: switch to spatial view, focus selected display, exit focus view,
  switch to movable windows, minimize/restore a window;
- controller API: nested split ratio/axis, `update_window` name/frame,
  `reorder_windows`, `update_split`, cross-window `swap_panes`,
  `patch_appearance`, source-window removal + runtime reparent via
  `set_workspace`, and checkpoint **rollback** via `restore`;
- negative controls: a deliberate pane URL change must replace *only* that
  sandboxed iframe document (fresh nonce, empty draft, other iframe retained),
  and `close_pane` must remove only that pane's DOM.

## Invariants asserted on BOTH renderers

- Zero `pageerror` events and no unexpected navigation of a retained iframe.
- Retained sandboxed iframes keep the same pane element/iframe/`contentWindow`
  DOM objects across every transition (`Element.moveBefore`), unchanged
  document nonce, and the unsaved textarea draft.
- No transition adds a terminal WebSocket. In `--pty` mode each transition must
  produce a **new** terminal WebSocket data frame carrying the retained exported
  variable and the original shell PID via the private tmux socket.
- Checkpoint rollback restores the exact saved v1 window ids/names/layouts and
  exact saved frame x/y on both renderers, while retaining the iframe documents.
- Every controller mutation is acknowledged: the browser matches the committed
  state and the server `read` reports `observed_revision >= revision` with
  `browser_seen` set (never a localStorage-only claim).

## Docking-only invariants

While the docking renderer is active: `dataset.dockingRenderer === 'docking'`,
`window.__orbitDocking.supported === true`, `panels` exactly equals the v1 window
set in every view and focus state. In windows view (not focused),
`active === selected`, one `.docking-placeholder` per window with exactly one
matching `.docking-surfaces > .monitor[data-docking-surface]` whose geometry
matches within 3 px. A toolbar `Tab to target` placement change must not navigate
a retained iframe, must not mutate v1, must not add a terminal WebSocket, and must
keep every retained runtime and the live shell intact.
The controller API must report `placement_revision: 0` after passive reconciliation
and checkpoint rollback (including a delay beyond layout suppression and save
debouncing). The explicit toolbar edit must then advance that revision.
A second checkpoint with user-saved placement is restored after a float command;
its returned placement revision must remain unchanged after settling (no echo).
A physical sash drag must subsequently advance the server placement revision,
with retained iframe identities, nonces, drafts and live shell still intact.
The companion `tests/runtime-continuity.browser.py` asserts the same strict
`panels == live v1 window ids` pruning at **every** transition for the docking
renderer — including source-window removal/reparent in spatial view and checkpoint
restoration — without ever switching back to windows view to reconcile.

## Findings

- **Authoritative frames and panel reconciliation preserved.** The default renderer
  now preserves authoritative frames across spatial → windows transitions, even
  when the desktop host is unsized. The parity gate hard-asserts exact restored
  frame equality for both renderers and compares full frames across renderers.
  Docking reconciles its complete panel set in every view/focus state, including
  immediately after source-window removal in spatial view.
- **CSP-safe predicates.** The served UI sets `script-src 'self'`, so Playwright
  `wait_for_function` with a plain-expression string fails with a CSP `EvalError`
  when it must poll. The gate uses arrow-function predicates; the same fix is
  required in any harness that polls this UI.

## Isolation and limitations

- The gate copies the built `dist`, `server`, `src` and `contracts` into a
  `/tmp/opencode` temp dir with a fresh loopback port, token, workspace UUIDs,
  HOME, cwd, private `TMUX_TMPDIR`, a short unique `ORBIT_TMUX_SOCKET` and
  `/dev/null` tmux config. It never contacts the owner's server, browser profile,
  tmux socket or personal data, and kills only its own tmux socket.
- Chromium only. No Firefox/WebKit or non-`moveBefore` fallback claim.
- No host-reboot, full-session recovery, live Hermes/conversation binding, or
  external-provider guarantee. The unsaved draft lives only in the still-running
  iframe document; a URL change or pane close still disposes/replaces it.
- Docking remains opt-in and off by default; this gate does not change the v1
  schema, permissions or owner settings.
