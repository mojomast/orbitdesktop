# Architecture

## Rendering

A shared Three.js PerspectiveCamera drives two scenes: WebGL for the room/grid and CSS3DRenderer for real HTML monitor surfaces. This keeps text selectable, xterm inputs functional, and browser/chat controls native. It avoids trying to photograph live DOM into a canvas texture.

`DesktopScene` owns transforms, camera, renderer lifecycle, geometry and materials. Rendering is invalidated by geometry/camera/viewport changes, with device pixel ratio capped at 1.75. The scheduling callback remains active but skips render work while clean or hidden. CSS3D and WebGL have separate compositing: arbitrary physical occlusion between them is not implemented. The shallow room deliberately avoids geometry in front of screens.

Each CSS3D object wraps a stable monitor DOM element. Focus mode moves that element to a regular document layer while its Three.js anchor remains in the scene. It returns to the same anchor without re-creating terminal instances. CSS3D overview is the arrangement surface; flat focus is the dense text/accessibility surface.

Spatial positions are relative scene units; diagonal inches express proportions, not real-world calibration. Monitor presets arrange screens horizontally with optional wrap. Height/offset support stacked or staggered arrangements. Automatic collision avoidance is not implemented; users can intentionally overlap monitors.

## Source map

| File                    | Responsibility                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `src/model.ts`          | Versioned workspace schema, validation, split tree operations, relative dimensions         |
| `src/dom.ts`            | Safe DOM helpers; user content uses textContent                                            |
| `src/scene.ts`          | Three.js camera, monitor transforms, rendering and disposal                                |
| `src/panes.ts`          | Terminal, embedded browser and stub agent pane lifecycles                                  |
| `src/main.ts`           | Workspace UI/actions, local persistence, monitor inspector, import/export, optional WebMCP |
| `server/index.mjs`      | Same-origin static server and authenticated WebSocket protocol                             |
| `server/local-host.mjs` | Local PTY adapter; the seam for future host providers                                      |
| `server/security.mjs`   | Token, origin/Host and dimensions validation                                               |
| `tests/`                | Local PTY/security integration and workspace-model tests                                   |

Pane views are keyed by stable pane IDs. Rebuilding a split tree reuses terminal objects; switching a pane's kind disposes the old view. LocalStorage and exports store layout metadata and browser addresses only. Tokens live in JavaScript memory for that tab. Browser iframe reparenting can reload a page when changing its split/layout or switching focus; a real browser-engine integration is required for robust browser tab persistence.

## Protocol v1

Connection: same-origin `/api/terminal`, one PTY per authenticated WebSocket.

| Direction       | Message                    | Meaning                                             |
| --------------- | -------------------------- | --------------------------------------------------- |
| Client → server | `auth {token, cols, rows}` | First message, within 5 seconds                     |
| Server → client | `ready {protocol: 1}`      | PTY created                                         |
| Client → server | `input {data}`             | Raw terminal input                                  |
| Client → server | `resize {cols, rows}`      | Validated PTY dimensions                            |
| Server → client | `data {data}`              | Raw terminal output, rendered only by xterm         |
| Client → server | `ack {length}`             | UTF-16 code-unit count after xterm's write callback |
| Server → client | `exit {code}`              | Shell exit code                                     |
| Server → client | `error {message}`          | Safe user-facing failure                            |

ACK units deliberately match JavaScript `string.length` on both sides; they are not UTF-8 byte counts. At 128,000 unacknowledged code units the server pauses its PTY; below 32,000 it resumes. There are additional transport/output bounds, a stalled-consumer timeout, and a ping/pong health check. Do not replace the write-callback ACK with an ACK on WebSocket receipt: that would stop measuring xterm consumption.

## Extension contracts

The implemented local host adapter returns node-pty's `write`, `resize`, `pause`, `resume`, `kill`, `onData`, and `onExit` interface. A future `HostProvider` must normalize those semantics and errors rather than exposing SSH-specific transport details to the UI. Add a validated host ID to pane state/protocol only alongside authorization and credential lookup.

A real `AgentProvider` should stream typed events: message-start, text-delta, tool-proposal, approval-required, tool-result, message-end, error. The current stub is intentionally not a provider implementation. Keep agent execution authority separate from the terminal's input transport. Never turn model text directly into terminal commands.

Optional WebMCP tools expose layout metadata and focus navigation only. They do not expose credentials, terminal output/input, or agent chat. They are feature-detected, and ordinary browsers work without them.
