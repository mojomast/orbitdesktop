# Local security boundary

## Plugin and persistence additions

Sandboxed app plugins reuse the app CSP described below. They have no privileged host bridge, but network access is allowed. Configuration is passed in a URL fragment and must not contain secrets. Trusted built-in extensions run in the parent page; they are application code, not arbitrary installable plugins. Content-addressed publication is not filesystem-enforced immutability.

Terminal client cleanup now detaches tmux-backed shells rather than ending them. Connection limits do not bound the total number of detached tmux sessions. Owners must monitor and terminate unused sessions; host reboot persistence and per-user isolation are not implemented. Checkpoints restore workspace metadata, not security revocations, external actions or process state.

This release grants the holder of its session token a real shell as the server user. It intentionally serves only on IPv4 loopback. It is a single-user development foundation, not an Internet-facing terminal service.

The current native deployment runs as mojo on the host. The Orbit token therefore grants real host-account access, not a disposable container. Workspace control also uses owner-only per-workspace capability files; these are not sent to browsers or previews. Agent tools retain their existing Hermes permissions.

Published static apps under `/apps/<slug>/` are readable within the tailnet without the Orbit token, just like the main static UI. Do not publish secrets in app bundles. HTML previews have CSP sandbox restrictions and omit `allow-same-origin`; they cannot access the parent workspace, its token, or its localStorage. Static asset CORS is allowed only on the app-file routes; authenticated control endpoints do not enable CORS. Preview isolation is not a substitute for reviewing code that Hermes executes on the host to build an app.

Implemented controls:

- Fresh 256-bit random startup token by default, held only in browser memory after entry.
- Exact Host allowlist to resist DNS rebinding; exact Origin checks on auth and WebSocket upgrade.
- Five-second initial authentication deadline; token is in a WebSocket message, not a URL.
- Same-origin frontend assets; no runtime CDN scripts or webfont loaders.
- CSP, nosniff, no-referrer, and framing denial for the Orbit host.
- Sandboxed third-party iframe panes; same-origin Orbit embedding rejected.
- Maximum 16 pending/active connections; bounded input/output and PTY dimensions.
- Consumption-based output flow control, stalled-consumer timeout, heartbeat, and session cleanup.
- No automatic Orbit shell connection. Hermes chat can execute tools in the separately configured Hermes environment; its normal approval policy applies. Orbit exposes only allow-once and deny, never persistent approvals.
- Tokens are excluded from layout exports. `ORBIT_TOKEN` and `HERMES_API_KEY` are removed from the child shell's explicit environment. This is not protection against a malicious same-UID process inspecting its parent's environment; this remains a trusted single-owner service.

Out of scope: malicious local OS users/processes, compromised npm dependencies, an exploited allowed remote iframe/browser, full process-tree supervision of deliberately detached jobs, remote identity, multi-user isolation, credential vaults, auditing, shell sandboxing, and independent penetration testing. High-entropy token authentication is not rate-limited by identity in this prototype; connection and payload limits bound the local service.

Run as a normal user. Do not expose this port publicly. The deployed private setup uses Tailscale Serve, an exact `ORBIT_PUBLIC_ORIGIN`, and the existing Orbit token for both terminal and chat access. For development origins, allow only exact origins you control; do not add wildcard handling. Public or multi-user deployment still needs the dedicated security work in the roadmap. See [Hermes integration](HERMES.md) for scope and limitations.
