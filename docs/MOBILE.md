# Orbit Pocket

Phone URL: https://kimi.tailec998.ts.net:4367/
Workspace: eed047a8-e519-495e-a7ca-1c8c150a6ef4

The independent mobile entry flattens all open window split leaves into tabs. The picker supports search, previous/next, lazy mounting, and retaining mounted panes when switching. Per-pane font/app scale and whole-pane opacity are stored only in phone localStorage. Wallpaper follows workspace appearance. Mobile workspace requests are read-only and do not acknowledge desktop display revisions.

## Fullscreen and phone keyboard

The top-bar fullscreen button requests native browser fullscreen and compacts Pocket's chrome, retaining tab switching, appearance settings and an exit button. If the browser refuses fullscreen, reversible compact mode remains available. Fullscreen is not automatically restored after reload because browsers require a user gesture. Pane DOM and session IDs are retained.

Pocket follows VisualViewport height, width and pan offsets on resize/scroll, with an innerHeight fallback, and requests `interactive-widget=resizes-content`. The pane and navigation shrink into the visible area above the keyboard; ResizeObserver refits the selected terminal. This cannot control the internal layout of third-party embedded apps. Reload Pocket once to receive the new frontend; no service restart is needed.

Verification: all 75 project tests pass. The phone-sized Chromium browser test verifies native fullscreen entry/exit, denied-fullscreen fallback, retained pane identity and simulated keyboard viewport shrink/pan. This is not physical Pixel keyboard verification.

## Authentication

`server/mobile-proxy.mjs` terminates TLS directly on the host's Tailscale IPv4 address, port 4367. It does NOT trust X-Forwarded-For or identity headers. It requires the socket peer address to match Pixel 8 Pro and `tailscale whois` to return stable node ID `nZ5x4zzBKX11CNTRL`. Successful identities are cached for ten seconds. Other devices, even the same owner's host, receive 403. The phone does not receive the upstream Orbit token. The nonsecret frontend sentinel cannot authenticate directly to Orbit. POST/WS origins are exact checked; null/cross-site origins are rejected. Mobile actions are allowlisted and workspace/pane scoped. No Funnel/public listener is configured.

The Pixel was offline at deployment. Live host rejection and spoofed-header rejection passed, and device-policy unit tests passed. Actual Pixel acceptance still requires testing from that device with Tailscale enabled. If the device is re-enrolled with a new stable ID, reauthorize deliberately rather than falling back to account-wide access.

Certificates are private under `.runtime/mobile`. This initial deployment uses transient user units `orbitdesktop-pocket` and `orbitdesktop-pocket-backend`; reboot persistence and automatic certificate renewal are not yet installed. Renew the certificate with `tailscale cert` into that directory and restart only Pocket when needed. Do not print the private key or deployment environment.

## Sessions and migration

Desktop ingress :4325 now routes to backend loopback :4335; the former :4334 service was left running, preserving its current clients. New backend and mobile reuse the existing deployment environment without exposing credentials. One desktop reload/unlock is needed to load the shared-chat client and register its existing sessionStorage conversation links. Do not close/recreate panes or create replacement conversations. A phone cannot initialize an unlinked chat, preventing silent divergence.

`server/shared-chats.mjs` stores workspace/pane-to-conversation links and bounded user/assistant display history in private `.runtime/shared-chats` files. Server start/status handling updates the shared run and transcript; concurrent starts on the new backend are rejected. Desktop and phone poll the same links. Archives, unsent drafts, pending local queues, and personalization remain browser-local. Existing runs started on the previous backend can still be polled through the new backend.

Terminals reuse the stable pane ID and `orbit-persistent` tmux socket; concurrent clients share the same process and output. Terminal geometry can adapt to attached client sizes. Reloads detach clients, not shells. Host reboot still does not preserve shell processes.

Ordinary iframes are separate browser documents: phone cookies, localStorage and unsaved DOM state are NOT a mirror of desktop. Backend-backed services can share state according to their own implementation. Xpra/Shared Chromium viewers can access their existing remote server sessions, subject to their separate connection credentials. No universal iframe session replication is claimed.

## Verification and recovery

`npm run check`, `tests/mobile.test.mjs`, `tests/mobile-terminal.test.mjs`, and `.runtime/browser-venv/bin/python tests/mobile.browser.py` cover the build, security policy, shared chat concurrency, simultaneous real tmux clients, and phone layouts using real workspace data. Browser test has a test-only Playwright bootstrap/auth adapter; production has no test-auth bypass. It does not claim on-device Pixel verification.

Predeployment workspace checkpoint: 4c67b216-2c6e-4770-90ec-defde648af63. No layout changes were required. Checkpoints do not restore source, services, TLS certificates, shared transcript files, or network routing. To revert routing, point Tailscale Serve HTTPS :4325 back to http://127.0.0.1:4334. Stop only Pocket's new units if retiring mobile access; do not stop the original desktop service or kill existing tmux shells.
