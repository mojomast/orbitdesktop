# Xpra pilot

2026-09-20: isolated Xpra 6.5.3-r0, official signed xpra.org Bookworm packages. Xpra seamless server on Xorg virtual display :100, HTML5 WebSocket client. No VNC component. Dedicated container orbit-xpra-pilot and named home volume orbit-xpra-home. Existing desktop and shared Chromium unchanged.

Viewer: https://kimi.tailec998.ts.net:4348/ (Tailscale Serve, tailnet only). Host mapping is 127.0.0.1:4348 to container 14500. Password authentication required; separate random secret in .runtime/xpra/password. Parent directory mode 0700; mounted read-only file mode 0444 permits container UID 1000 to read despite host owner UID 1001. Owner access instructions are mode 0600 at /home/browser/Desktop/Orbit Xpra Access.txt in the existing shared Linux desktop. Never publish secret in URLs, logs or source. Anyone with tailnet access AND this password has access independently of Orbit login.

Orbit window 24ffd152-cebb-4380-9d9d-6fd0429f7894 added with revision protection, acknowledged revision 675. Uses normal external browser pane, not sandboxed static plugin. Xpra CSP frame-ancestors allows only itself and the exact Orbit origin https://kimi.tailec998.ts.net:4325. No global Orbit security relaxation.

Non-root UID 1000, all capabilities dropped, no-new-privileges, 2 GiB RAM, 2 CPUs, PID limit 512, shm 256 MiB. No host X, host home, Docker socket, or existing desktop home mounts. Clipboard, file transfer, printing, open-url, remote new commands, audio and webcam disabled. Networking egress is not blocked. Pilot starts Mousepad; current Welcome.txt contains the browser-test sentence.

Build: DOCKER_BUILDKIT=0 docker build -t orbit-xpra:pilot deploy/xpra
Deploy new container: python3 scripts/xpra_pilot.py start
Status: python3 scripts/xpra_pilot.py status
Stop: python3 scripts/xpra_pilot.py stop
Disable private viewer: tailscale serve --https=4348 off
Do not recreate a live pilot without coordinating unsaved work. start is for a NEW container, not an idempotent restart. Docker start orbit-xpra-pilot resumes a stopped container but starts fresh processes. Persistent files survive; running applications do not survive container restart. restart-unless-stopped configured, host reboot not tested. Do not delete the named volume for rollback.

Package workaround: Bookworm xpra 6.5.3 xkb extension import failed with undefined symbol XDefaultRootWindow. Launcher preloads system libX11.so.6. xauth and libx264 installed explicitly because --no-install-recommends omitted them.

Tests executed:
.runtime/browser-venv/bin/python tests/xpra.browser.py
- wrong password rejected before canvas
- valid authentication and real Linux application canvas
- physical keyboard events (including Shift) save exact mixed-case text
- refresh/re-authentication retains same Mousepad PID
- two simultaneous viewers
- closing browsers preserves application
.runtime/browser-venv/bin/python tests/xpra-orbit.browser.py
- separate authenticated Orbit test workspace, actual external browser iframe
- private HTTPS connection, authentication and rendered application canvas
npm run check: build and all 67 tests passed (existing Vite mixed static/dynamic import warning).

Historical pilot scope (per-app OpenOffice and launchers are now implemented separately; see [XPRA_APPS.md](XPRA_APPS.md)): pilot integration, not a replacement of existing desktop. OpenOffice, Python application compatibility, latency/resource comparison, clipboard policy, per-application Orbit windows, scoped launch controls and migration remain future work. Multiple Xpra application windows currently live inside one Orbit viewer, not individual Orbit windows. Checkpoints only revert workspace metadata, not services, volumes, files or credentials.
