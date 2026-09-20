# Roadmap

## 0.1 — delivered foundation

Configurable Three.js monitors, nested splits, local PTY server, embedded browser, local chat stub, focus mode, saved/exported layouts, and bounded terminal transport.

## 0.2 — everyday local workspace

Delivered since the foundation: movable/resizable 2D windows with persistent geometry and stacking, a persistent sidebar toggle, and Windows/Spatial/Focus switching. The private deployment now runs native host-account terminals through an enabled user service, with Tailscale HTTPS/WSS access. Live Playwright checks cover window controls, persistence, host-shell access, and agent-built app previews; see [verification](WORKSPACE_VERIFICATION.md).

- Add explicit session IDs and an independent session manager. Decide whether disconnect should detach or terminate; make that user-visible.
- Add tmux integration on Unix and an equivalent lifecycle plan for Windows. Test restart/reconnect without duplicated input or output.
- Extend the delivered 2D window view with keyboard window navigation, screen-reader status announcements, and adjustable source resolution per monitor.
- Add snapping and optional layout collision warnings to the delivered window dragging/resizing. Preserve manual overlap as a deliberate option.
- Move action/state coordination from `main.ts` into workspace and pane controllers as the interface grows.
- Add actual browser regression automation in CI, Linux/macOS/Windows PTY jobs, and a hardware-backed WebGL visual test.
- Acceptance: geometry changes preserve active shell identity; reconnect contract is explicit; layout migrations are reversible; no unbounded per-session memory growth.

## 0.3 — direct SSH hosts

Browsers cannot open a general TCP SSH socket directly. Implement SSH from the local backend to the target; the browser continues to use Orbit's authenticated WebSocket protocol.

- Add a `HostProvider` registry and `ssh` adapter compatible with the local adapter's normalized lifecycle.
- Store host profiles with address, port, user, and credential reference, never private keys in exported workspace JSON.
- Prefer local SSH agent / OS credential-store integration. Keep private material server-side.
- Verify server host keys with known-hosts storage and a first-connect fingerprint confirmation. Refuse changed keys.
- Add connection timeout, cancellation, keepalive, and categorized authentication/network errors.
- Map PTY resize and flow control; test Unicode, terminal applications, disconnect races, and multi-host isolation.
- Acceptance: two different hosts operate simultaneously, reconnect cannot attach to the wrong host, invalid/changed host keys fail, and credentials never reach the frontend.

## 0.4 — agent adapters

Delivered: authenticated Hermes Runs integration, separate pane conversations, server-loaded follow-up history, reload restoration, run status, cooperative Stop, and allow-once/deny approvals. Workspace-scoped capabilities provide layout inspection/control, revision conflicts, browser acknowledgement, and static app publishing into sandboxed previews. See [workspace control](WORKSPACE_CONTROL.md). Streaming tokens, independent chat/shell access grants, and additional adapters remain future work.

- Extend the working Hermes adapter with additional providers only after checking their supported APIs.
- Add streaming chat and reconnect cursors to the existing run IDs, cancellation, status, and approval controls.
- Separate chat access from shell execution access. Bind each run to a host/workspace and scoped permissions.
- Store provider secrets on the backend; protect transcript storage and avoid secret logging.
- Acceptance: chat can be interrupted; tool actions have real status and bounded authority; reconnect does not repeat tool execution.

## 0.5 — remote deployments and additional hosts

- Add HTTPS/WSS, real user authentication, short-lived scoped sessions, CSRF/origin policy, revocation, and per-user host authorization.
- Run shells as isolated unprivileged workers; add quotas and explicit audit/retention policy.
- Add container exec, WSL, remote agent gateways, and other providers behind the host adapter interface.
- Keep the current loopback backend closed until the remote boundary is implemented and reviewed. An environment-variable bind-address switch alone is insufficient.

## Browser-engine track

If arbitrary websites and stable browser sessions are essential, use a dedicated browser process with per-workspace profiles and a streamed view, or a carefully isolated desktop shell. Assess credential handling, input forwarding, clipboard, download isolation, browser updates, resource budgets, and streaming latency. Iframes remain the lightweight option for embeddable tools; they cannot become unrestricted browser tabs by changing CSS.

## VR/XR track

CSS3D DOM surfaces are not native WebXR layers. A headset product needs a separate text/input/rendering strategy, accessible desktop parity, and performance validation. Keep the schema and host transports reusable, but do not assume this renderer can be toggled into VR.
