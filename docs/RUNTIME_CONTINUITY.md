# Built-UI runtime continuity acceptance

`tests/runtime-continuity.browser.py` launches a **disposable copy** of the built Orbit UI/server. It uses a fresh loopback port, token, workspace UUID, SQLite runtime, HOME, cwd, private `TMUX_TMPDIR`, unique `ORBIT_TMUX_SOCKET`, `/dev/null` tmux config, and a new Playwright browser context. The iframe fixture is published into that disposable runtime as a content-addressed local app; no live workspace, owner's browser profile, external endpoint, or owner's tmux socket is accessed. The script terminates its server and kills only its own tmux socket. It requires a freshly built `dist/` (`npm run build` or `npm run check`).

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/runtime-continuity.browser.py --pty
```

Omit `--pty` for a browser-only run. Requesting PTY without tmux or socket-override support is an explicit nonzero failure, **not** a green skip. The private socket override must cover both terminal attachment and history; tests must never run a terminal against the default `orbit-persistent` socket. A fresh output marker is injected through *only* the fixture's tmux socket after each transition and verified in new WebSocket data frames alongside the retained variable and original shell PID (historical xterm text is not accepted). Layout-only changes must create no extra terminal WebSocket.

The sequence has **93 browser-only / 94 PTY transitions**: 10 cycles of real UI Windows ↔ Spatial, focus/unfocus, minimize/restore, plus revision-checked controller operations for title/geometry/spatial metadata, window reorder, split axis/ratio and cross-window pane swap. Additional transitions change appearance, move surviving panes while removing their source windows, and restore the checkpoint. PTY mode also verifies that irrelevant terminal URL metadata does not replace the terminal view. Each transition checks two sandboxed iframe document-unique nonces, unsaved textarea drafts, **same parent pane/iframe/contentWindow DOM objects**, absence of iframe navigations/page errors, and terminal WebSocket count; PTY mode checks terminal pane DOM identity and fresh shell output each time. The deliberate URL-change negative control must replace/reload that iframe (fresh nonce and empty draft) without reloading the other; closing the target pane must remove its DOM.

Lead reruns against the built UI passed **93 browser-only / 94 PTY transitions**, Chromium 145.0.7632.6. The initial delegated runs passed 91 transitions before the additional cases above. No pre-fix baseline was captured, so these runs do not establish the original failure. These are fixture browser/session continuity checks, not host-reboot, full-session recovery or external provider guarantees. A failing numbered transition is a regression requiring investigation, not a reason to weaken nonce/draft assertions.

## Scope and remaining gates

- Native `Element.moveBefore` is required; its absence is an explicit failing capability check, not a green skip. Firefox/WebKit and fallback-mode iframe preservation remain unverified.
- No new docking library, tabs or cross-document popout implementation is tested here. Compare actual candidate adapters before selecting one.
- No live Hermes agent/conversation binding, native-app/CDP integration, browser reload recovery, persistent app drafts or host reboot continuity is established. The unsaved draft lives only in the still-running iframe document.
- URL changes and closing panes deliberately dispose content. Checkpoints retain documents only when their pane identity/kind/URL still corresponds to a live runtime; they cannot resurrect a disposed document.
- `tests/runtime-import.browser.py` separately verifies explicit import visibility and stale-anchor cleanup. Import/preset replacement intentionally destroys old pane views rather than claiming continuity.
