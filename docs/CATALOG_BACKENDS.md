# Trusted catalog backends

Static catalog apps remain sandboxed and disabled-first. An optional `backend` object declares `path`, `runtime: "python3"`, and a nonempty `permissions` list. UI and backend use the same immutable GitHub SHA. CI downloads and validates both without importing or executing downloaded Python. Maintainers must review host code separately; declarations are not enforced permissions.

## Live Telemetry: portable host edition

The first package displays actual Linux CPU utilization, physical RAM and 1/5/15-minute load. It does not ship the author's private services, token exporter, agent sessions, process details, passwords or endpoints. These richer private integrations are not part of version 1.0.0. Python's standard library and Linux `/proc` are required.

Installation is intentionally two-stage. Catalog sync publishes only the static setup UI. Clicking Install does not execute a backend. An owner/agent performs these steps on the deployment host:

1. Review the catalog entry and its exact GitHub commit, including all backend files.
2. Run `python3 scripts/catalog_backend.py orbit-live-telemetry`. Before the catalog PR merges, use `--catalog /path/to/reviewed/plugin-catalog` explicitly. This downloads the pin into the owner-only extension release store and returns the release hash; it does not execute downloaded code.
3. Create `~/.config/orbit/live-telemetry.json` with owner-only permissions. It has exactly three non-secret fields: `host` (private telemetry hostname including HTTPS port), `owner` (expected Tailscale login), and `orbitOrigin` (the HTTPS origin of your Orbit desktop). Example using deliberately fictitious values:

   ```json
   {"host":"desktop.example.ts.net:8443","owner":"owner@example.com","orbitOrigin":"https://desktop.example.ts.net:443"}
   ```

4. Review the staged code, then activate explicitly: `python3 scripts/extensions.py activate orbit-live-telemetry RELEASE_FROM_STAGE --port UNUSED_LOOPBACK_PORT --trust-host-code`. The runner health-checks before promotion. It does not configure external proxies.
5. Configure a private Tailscale Serve HTTPS proxy to that loopback port using your deployment's approved procedure. Never use Funnel or expose the raw listener. Check your Tailscale policy: Serve must inject authenticated identity and the expected Host. Verify anonymous and wrong-owner requests return 403, and authorized `/api/metrics` returns current host metrics. `/health` exposes only readiness and release.
6. Install the catalog UI, choose Connect backend, and enter only that HTTPS origin. Confirm the external-service trust boundary, then Enable. The plugin window loads the private service directly, not through a sandbox escape or privileged iframe bridge. Endpoint configured is not a claim that the service is healthy. An inaccessible service remains a browser error, not a fake success.

The backend reads configuration from the actual OS account's home, not from inherited secrets. It binds only 127.0.0.1. Only aggregate CPU/RAM/load and timestamps are served. No shell, write API, arbitrary file API, telemetry analytics or CORS bridge exists. Local owner/root can forge proxy identity headers; the deployment assumes that account is trusted. Connections must use a distinct HTTPS service origin, not Orbit's own origin.

## Updates, disconnect and recovery

Backend updates require another pinned review and explicit stage/activate; catalog UI updates never execute code. `extensions.py health`, `stop`, `rollback`, `releases` and `safe-mode` remain the operational controls. Use a new free port for health-gated replacements and retarget the private proxy only after verification.

Connect backend with a blank input restores the sandboxed setup UI. Disable/remove closes the UI but does not stop the service. Stop it explicitly with `python3 scripts/extensions.py stop orbit-live-telemetry`, then remove the dedicated proxy if no longer needed. Never stop an unrelated service.

`plugin_backend` is an authenticated owner workspace operation requiring `confirm_host_access:true`, a plugin ID, and a credential-free HTTPS origin (or null to disconnect). Connection metadata is checkpointed, preserves pane IDs, and does not grant host credentials to app code. Generic config cannot opt an app out of its sandbox. Checkpoints cannot restore processes, roll back host effects or reverse proxy changes. There is no reboot supervision, dependency installer, browser-side host installer, resource sandbox or automatic backend health monitor.
