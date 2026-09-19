# Orbit Desktop

A local-first spatial workspace built with **Three.js + TypeScript + Vite**, real **xterm.js / node-pty terminals**, embedded browser panes, and a deliberately stubbed agent chat interface.

## Start locally

Requires Node.js **22.12+** (verified here on Node 24, Linux). Extract the ZIP and open a terminal in `orbit-desktop`:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4318**. Click **Connect host**, paste the session token printed in your terminal, then click **Connect shell** in a terminal pane. A fresh token is generated each server start. Keep the server terminal open.

The shell runs on the machine running `npm start`, as that OS user. This is a real terminal: interactive programs, ANSI output, Ctrl-C, and resize are supported. Use an ordinary user account.

`node-pty` is a native dependency. If installation needs compilation, Linux needs Python 3, make and a C++ compiler; macOS needs the Xcode command line tools; native Windows needs Python and Visual Studio C++ build tools. Windows selects PowerShell. Native Windows/macOS execution is not verified in this release. WSL2 runs the Linux path; its terminals operate inside WSL, not the Windows host.

## What works

- 1–8 independently configured monitors; up to 8 panes per monitor.
- 16:9, 16:10, 21:9, 32:9, 4:3, portrait 9:16, and square screens.
- 20–55 inch relative diagonal sizes, height, depth, pitch, yaw, horizontal offset, and layout wrap angle. Position values use scene units (`u`), not calibrated physical meters.
- Nested side-by-side and stacked pane splits; pointer or keyboard divider resizing.
- Switch each pane between terminal, browser, and agent chat.
- On-monitor text controls, settings selection, and focus button. Browser text controls scale the embedded page as a whole; they cannot change a cross-origin site's typography.
- Spatial camera orbit and zoom; full-size flat focus mode using the same pane instances.
- Local layout persistence, validated JSON import/export, and single/dual/triple presets.
- Real host shells with authentication, origin/Host checks, output backpressure, heartbeat, session limits, and disconnect cleanup.
- Browser URL navigation, home, reload, and open in a new tab. The built-in workspace guide works without network access.
- Stub chat accepts messages and returns a clearly labeled local placeholder. It sends no agent requests and does not execute tools.
- Three.js CSS3D remains interactive without WebGL; the decorative WebGL room is optional.

## Controls

| Action            | Control                                              |
| ----------------- | ---------------------------------------------------- |
| Select a monitor  | Click its surface or its bottom display tab          |
| Move camera       | Drag empty space, or Alt + drag                      |
| Zoom camera       | Scroll over empty space, Alt + scroll, or bottom −/+ |
| Restore camera    | Bottom crosshair button                              |
| Focus one display | Monitor ⛶ or top Focus button                        |
| Leave focus       | Back button or Escape                                |
| Split a pane      | ◫ for columns; ⬒ for rows                            |
| Resize a split    | Drag the divider; focus it and use arrow keys        |
| Resize text       | Monitor A−/A+ or inspector slider                    |
| Change pane type  | Pane dropdown                                        |

More monitors make the overview smaller. Focus mode is the primary reading/typing surface on small screens. Use 100% browser/display zoom for spatial mode; Three.js documents this CSS3DRenderer limitation. Focus mode supports normal browser zoom.

Layouts persist, but shell processes, terminal buffers, session tokens, and chat messages do not survive a page reload. Adjusting geometry or using focus mode preserves connected terminals. Closing a pane, switching its type, changing presets, or importing a replacement layout closes affected shells after confirmation. Reconnecting starts a new shell. Deliberately detached background programs are not a job-management feature; use tmux if that is needed.

## Browser limits

A pane embeds a website in a sandboxed iframe; it is not a complete Chromium browser. Sites can refuse embedding through CSP `frame-ancestors` or `X-Frame-Options`, and some sign-in flows will not work in an iframe. Use **↗** for those sites. Orbit does not strip these protections or proxy arbitrary sites. Iframe success cannot reliably be detected cross-origin, so the UI does not claim that a remote page loaded successfully.

## Development

Terminal A (POSIX shell):

```sh
ORBIT_DEV_ORIGINS=http://localhost:4173,http://127.0.0.1:4173 npm start
```

Terminal B:

```sh
npm run dev
```

Open http://localhost:4173. Vite proxies `/api` to port 4318. On PowerShell, set `$env:ORBIT_DEV_ORIGINS="http://localhost:4173,http://127.0.0.1:4173"` before `npm start`. The production single-origin path requires no development-origin setting. The Vite server binds broadly for development preview; use the production server for normal local use.

```sh
npm run check   # TypeScript, production build, integration + model tests
npm run format # Format source and docs
```

Environment:

| Variable            | Default           | Purpose                                                      |
| ------------------- | ----------------- | ------------------------------------------------------------ |
| `PORT`              | `4318`            | Local HTTP + WebSocket port                                  |
| `ORBIT_CWD`         | OS home directory | Starting shell directory                                     |
| `ORBIT_TOKEN`       | Random each run   | Optional 32+ character secret for controlled local setups    |
| `ORBIT_DEV_ORIGINS` | Empty             | Exact comma-separated frontend origins for local development |

## Foundation and next steps

Read [Architecture](docs/ARCHITECTURE.md), [Research decisions](docs/RESEARCH.md), [Roadmap](docs/ROADMAP.md), [Security boundary](docs/SECURITY.md), and [Verification](docs/VERIFICATION.md).

This release is single-user and loopback-only. It is ready for local experimentation, not Internet-facing deployment. Direct SSH host adapters, durable sessions, real agent connections, remote authentication, and a full browser engine are roadmap work.
