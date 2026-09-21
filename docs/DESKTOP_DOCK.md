# Desktop Dock: privileged shared-desktop bridge

Owner authorized this integration explicitly. Source: `projects/desktop-dock/`. Deployed through trusted extension runner as `desktop-dock`, active release `d1d88b0607cab02e03af4e2d7485cb9774793f71fe7d3cac68a19246ba634541`, loopback 4357. Tailnet-only HTTPS `https://orbit.example.invalid:4347/` proxies that listener. No core server, desktop or Chromium restart. This is an authenticated external browser application, NOT a sandboxed static plugin granted host permissions. No global sandbox or CSP relaxation.

Owner workspace eed047a8-e519-495e-a7ca-1c8c150a6ef4: new browser pane 4e065054-2e23-4ec3-a611-4b2c5c6961dd in existing shared Linux window 925e8d26-fdbd-4722-a9dd-c2a2f44a965e. Planet Remote and desktop pane IDs preserved. Browser acknowledged revision 556. Rendering and interaction were tested in a separate real Orbit test workspace; owner session still requires manual pairing.

## Use

Open `/home/browser/Desktop/Orbit Dock Pairing.txt` within the shared Linux desktop and enter its secret code in Desktop Dock. Never paste this code in chat or workspace configuration. The file is 0600, outside the transfer folder. Sessions expire after eight hours; the browser token is kept only in sessionStorage. Disconnect all invalidates all sessions and rotates the desktop code. Reopen the file after rotation (an already open editor may show the old text).

Save desktop files in `/home/browser/Orbit Inbox` to expose them in the Dock. Uploads and text notes go only there. No overwrites, deletion, arbitrary path access or automatic execution. Simple filenames only, 8 MiB per transfer, 128 MiB aggregate upload quota, 1000-entry upload limit. Existing desktop files over 8 MiB may be listed but cannot be retrieved. Symlinks and multi-link files cannot be read. Read uses a directory fd and O_NOFOLLOW. Text files can be previewed in the embedded Dock; actual downloads require opening the HTTPS Dock address directly in a browser tab and pairing there because Orbit's external iframe disallows downloads. This limitation is explicit in the UI; do not weaken all iframe sandboxes for it.

Fixed launch allowlist: Inbox file manager, text editor, Writer, Calc, Impress. Live window list and focus use wmctrl/xdotool only inside `orbit-shared-desktop`. Focus affects both users. Launch completion means the launch request was submitted, not that an application rendered; the live window list provides confirmation. Delivery receipts are an in-memory bounded history of RPC results, not persistent job scheduling or progress for document conversions. No arbitrary shell, keyboard typing, automatic clipboard reading, document opening, slideshow controls, chat submission or unattended tasks are exposed.

## Security and limits

Separate high-entropy pairing credential, Bearer sessions, exact Host and mutation Origin checks, no CORS, no cookies, login throttling, CSP restricts scripts/connects to self and embedding to the private Orbit origin. Never embed credentials in URLs, static bundle files, logs or workspace state. Health is public and exposes only release identity. State/file/window endpoints require authentication. Titles and text render using textContent. Helper input selects fixed operations; no user strings become shell commands. Desktop/file access runs under the non-root container browser account; the host service itself is trusted owner code with Docker access, NOT a security sandbox against malicious service source or a compromised owner account. Private tailnet plus possession of the pairing code grants access independently of Orbit login. There is no automatic relationship between Orbit locking and existing Dock sessions.

HTTP service is small, single-threaded and bounded, not a public-internet hardened server. Tailnet-only. Session/history state is not persistent; restart rotates pairing credentials. No reboot supervisor configured by the extension runner. Tailscale route and Inbox files persist independently; after reboot restart the managed extension and update the proxy to its new loopback port. Failure of the Dock should not close Linux apps.

## Recovery

`python3 scripts/extensions.py health desktop-dock`

`python3 scripts/extensions.py stop desktop-dock` stops only the bridge. `tailscale serve --https=4347 off` removes its network route. Neither stops desktop or Chromium.

For restart/rollback choose a distinct free loopback port, use `scripts/extensions.py restart|rollback desktop-dock --port PORT --trust-host-code`, health-check, and route Tailscale HTTPS 4347 to that port. A retained previous release exists but contains the initial busy-click UI bug; prefer restarting the current release. Workspace checkpoints roll back pane layout only, not transfers, launched apps, Tailscale configuration or extension processes. Do not restore the entire workspace without owner confirmation.

## Verified evidence

`python3 tests/desktop-dock.live.py`: actual authentication, foreign-origin rejection, forbidden command/path/symlink tests, no-overwrite behavior, exact bidirectional file bytes, real launch request, live window list, session invalidation and code rotation passed against the final HTTPS deployment.

`.runtime/browser-venv/bin/python tests/desktop-dock.browser.py`: real separate Orbit workspace iframe paired, uploaded bytes verified in container, desktop-edited text returned into UI, file-manager launch and actual X active-window focus verified, standalone browser download bytes verified, no JavaScript exceptions. Found and fixed dropped clicks during overlapping operations by disabling buttons while requests run. Private test screenshot `.runtime/desktop-dock-acceptance.png`.

`npm run check`: build and all 66 tests passed. Final extension health passed; shared desktop running, restart count zero.
