# Hermes agent chat

Orbit's agent pane connects to the owner's existing Hermes profile via a server-side bridge. It does not inherit another dashboard thread or impersonate an already-running turn. Each pane gets an unpredictable `orbit-<UUID>` conversation ID. Requests go to Hermes Runs; polling provides status and final replies, Stop, and explicit allow-once/deny approvals. Text replies are rendered as text, not HTML.

## Configuration

Set these server environment variables (never Vite/client variables):

- `HERMES_API_URL`: the Hermes API origin, e.g. `http://127.0.0.1:28643`.
- `HERMES_API_KEY`: the configured profile's API_SERVER_KEY.
- `ORBIT_TOKEN`: a private 32+ character Orbit access token.
- `ORBIT_PUBLIC_ORIGIN`: exact private HTTPS origin when using Tailscale Serve.
- `PORT`: loopback listener port.

The existing Connect host token unlocks both shells and agent chat. Never send the Hermes API key to the browser. `.env.deploy` is chmod 0600, Git-ignored, and excluded from Docker build contexts. `HERMES_API_KEY` and `ORBIT_TOKEN` are removed from the spawned terminal's explicit environment. This is not isolation from a malicious same-UID process or Docker administrator; Orbit remains a trusted single-owner service.

## Current private deployment

Access: https://kimi.tailec998.ts.net:4325/

Tailscale Serve proxies HTTPS port 4325 to loopback HTTP port 4326. Container `orbitdesktop-hermes` uses image `orbitdesktop:hermes-chat`, host networking, non-root user `node`, dropped capabilities, no-new-privileges, and restart-unless-stopped. Named volume `orbitdesktop-home` persists `/home/node`.

The original `orbitdesktop` container on loopback 4325 was left running to avoid killing an existing terminal connection during the upgrade. It no longer receives new HTTPS connections. Remove it only after its `/api/health` reports zero shell sessions.

Build and run from this directory after `npm ci` and `npm run check`:

```sh
DOCKER_BUILDKIT=0 docker build -t orbitdesktop:hermes-chat .
docker run -d --name orbitdesktop-hermes --restart unless-stopped \
  --network host --user node --cap-drop ALL --security-opt no-new-privileges \
  --env-file .env.deploy -e PORT=4326 \
  --mount type=volume,src=orbitdesktop-home,dst=/home/node \
  orbitdesktop:hermes-chat
tailscale serve --bg --https=4325 http://127.0.0.1:4326
```

The legacy builder flag works around the deployment environment's read-only default buildx configuration; ordinary environments can use normal `docker build`. An existing container must be stopped/replaced to update it; doing so ends its live shells. Tailscale Funnel/public exposure is not supported.

## History and lifecycle

The installed Hermes version saves Runs transcripts but does not automatically reload them by session ID. Before each new run the bridge retrieves that Orbit session's messages and supplies bounded user/assistant text history: up to 80 messages, 16,000 characters per message, and 120,000 characters total. Tool-call internals/results are not replayed by this compatibility layer. This is conversational continuity, not unbounded archival recall.

The browser retains the most recent 100 displayed messages and active run ID in sessionStorage. Reloading requires unlocking again, then polling resumes. New chat starts a separate conversation but does not delete Hermes's saved history. Closing the tab or pane is not cancellation; use Stop. Stop is cooperative and cannot undo actions already performed. Replies appear after the turn completes; token streaming and file/image attachments are not implemented in this version.

A request that loses its network connection while creating a run may have reached Hermes. Do not blindly resend an ambiguous action. Use the Hermes dashboard to reconcile such cases. The upstream API limits concurrent runs; a busy response is shown without automatically submitting another run.

## Security

Every bridge action requires exact Origin/Host validation and Orbit bearer auth. Only the configured Hermes origin is callable, redirects are rejected, and API paths/actions are allowlisted. Run status/stop/approval operations verify the upstream run belongs to the supplied Orbit-namespaced session, so they cannot operate on dashboard threads. Client-supplied models, system instructions, and histories are ignored. Payloads and request durations are bounded; upstream errors are sanitized. Only once/deny approvals are allowed, not persistent approval rules.

Hermes tools can operate on the Hermes host, beyond the terminal container. Keep the Orbit token private and limit Tailscale access to trusted devices. This is a single-owner app, not a multi-tenant permission boundary.

## Verification

`npm run check` builds TypeScript/Vite and runs the model, terminal, and agent-bridge tests. Agent tests use an explicit mock transport for validation/error/control cases. `node verify-agent-live.mjs` separately exercises the deployed HTTPS endpoint with real Hermes replies, follow-up memory, and a harmless terminal command; it requires `.env.deploy` and consumes real model requests. Browser verification uses Playwright and is stored in `tests/browser-live.py`.

Authoritative API reference: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
