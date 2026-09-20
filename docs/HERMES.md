# Hermes agent chat

## Workspace operator guidance

The bridge now injects `docs/AGENT_GUIDE.md` into workspace-aware run context alongside the active workspace ID, controller path and bounded state metadata. It is read at context-generation time, so subsequent requests pick up guide edits. The guide teaches plugin-first publication/lifecycle, safe config replacement, checkpoint limits, persistent terminal identity and acknowledgement-based verification. `AGENTS.md` covers repository work. This is guidance, not a guarantee of model compliance; inspect actual changes and tests.

The current plugin-oriented architecture is documented in [PLUGINS.md](PLUGINS.md) and [ARCHITECTURE.md](ARCHITECTURE.md). The current private backend is `orbitdesktop-plugins.service` on 4333; older deployment port notes below are historical. A live read-only browser test verified the embedded agent used the workspace controller and correctly identified the plugin publisher, install operation, browser acknowledgement and tmux persistence. The first live attempt reached ATTENTION; a retry passed, so this is not a claim of infallible availability.

## Skills and toolsets

The tools menu's **Skills and tools** browser reads `/v1/skills` and `/v1/toolsets` only when advertised by the gateway capabilities endpoint. Search names/descriptions and tool names, expand entries, switch catalog types, or refresh. Toolsets display upstream enabled/configured flags and concrete tool names; these flags are metadata, not a guarantee that execution succeeds. The view is read-only and neither installs nor enables anything. API keys and filesystem paths are not forwarded. Lists are bounded to 500 entries and text fields to 2000 characters. No inference is used.

Live acceptance (`tests/browser-hermes-catalog-live.py`) retrieved 83 skills and 28 toolsets from the actual gateway, checked filtering and state display, and completed without browser JavaScript errors.

## Live activity and published outputs

The tools menu offers **Live activity** during an active run when the gateway advertises `run_events_sse`. It proxies the native event stream with server-side authentication and checks the run's Orbit session before subscribing. Expand event rows to inspect their payloads (up to 150 rows, 12K characters per displayed payload). This is an initial event inspector, not a polished token-by-token transcript. Closing the viewer disconnects its stream, not the agent. Normal chat status polling continues; on stream failure use Check status and saved Tool activity. Reopening is possible but replay is not guaranteed. Avoid multiple viewers for the same run: upstream stream fan-out semantics vary by Hermes version. Event payloads can contain sensitive tool data.

**Apps and outputs** lists deliberately published files under Orbit's existing app publication root, never arbitrary home-directory files. HTML apps/reports, text, CSV, and common images can be opened in a sandboxed preview dialog or downloaded. The shelf is profile-wide and persists through the published files themselves, bounded to 100 app folders, 300 entries and four nested directory levels; hidden files and symlinks are excluded. Refresh updates the index. Use the existing workspace controller `publish` command to publish folders. This is not yet a separate artifact registry, PDF viewer, or draggable persistent shelf pane. Published URLs retain the existing app-serving access model; do not publish secrets.

`tests/browser-hermes-surfaces-live.py` verified an existing published preview and real Hermes SSE tool events, then confirmed the chat finished after the stream viewer closed. No mocked agent results were used.

## Scheduled tasks

Open ⋯ → Scheduled tasks to inspect this gateway profile's real cron jobs through Hermes `/api/jobs?include_disabled=true`. The view shows task names/IDs, available state, schedule, next/last run timestamps and last result. It refreshes every 15 seconds while open, supports filtering and manual refresh, and marks refresh failures as potentially stale data. Timestamps retain the upstream timezone. This is profile-wide, not limited to tasks created by the current chat.

Pause and Resume call the native Hermes job endpoints after a confirmation dialog. Pausing prevents future scheduled executions; it does not cancel an active task. Orbit does not create, run-now, or delete jobs. Tasks continue on the gateway independently of Orbit. The authenticated server allowlists metadata fields and excludes job prompts and delivery destinations; up to 200 jobs are displayed. No extra inference is used. Closing the dialog stops polling. Errors preserve uncertainty: refresh job state before retrying a timed-out mutation.

Control verification: backend tests exercise exact endpoint forwarding, confirmation, authentication, and rejection of unsupported operations/path traversal. Browser tests exercise cancellation and both confirmation flows with intercepted mutation responses, while listing real jobs. Production schedules were not modified; successful real gateway mutations have not been tested in this pass.

Live acceptance: `tests/browser-hermes-jobs-live.py` displayed seven actual gateway tasks and checked filtering, refresh, close, omitted private fields, and browser JavaScript errors. No production schedules were modified.

## Direct Hermes runtime integration

**Send guidance** appears while a run is active. Type a correction in the composer and press that button to call Hermes's native `/v1/runs/{id}/steer` endpoint. This does not start another turn or stop/restart the existing run. Guidance is consumed at a safe point; already-executing commands are not undone. Rejected/late guidance leaves the draft intact. Orbit confirms acceptance only when Hermes reports `accepted: true`.

**Tool activity** in the tools menu fetches the current Orbit conversation's actual persisted tool calls, arguments, and results from Hermes. It polls every three seconds while open. Expand entries to inspect commands, file operations, and tool output. This is persisted history, not SSE streaming: in-flight tools may appear only after persistence. The latest 80 message records are queried, with bounded/truncated output. System instructions are excluded. Tool results can contain private file contents or credentials produced by tools; this owner-authenticated view is not a secrets-redaction boundary. Nothing is rendered as HTML.

The server retains upstream authentication and checks that steering targets the requested Orbit session. Non-Orbit session identifiers are rejected. Tool activity is read-only; it does not rerun commands. Existing Stop and approval controls remain separate.

Live verification: `tests/browser-hermes-runtime-live.py` starts a real harmless terminal tool call, sends native steering through Orbit, observes the changed final answer, and verifies the real terminal arguments/result in the activity viewer. No mocked Hermes replies were used for that acceptance test.

## Tools menu, history, and drafts

The `⋯` button beside the composer opens Hermes tools without adding another header row.

- **Recent conversations:** New chat retains the previous completed conversation. Up to ten are kept per pane in this browser tab. Restore switches back to its original Hermes session, preserving server-side follow-up context. Switching is blocked during an active run.
- **Draft recovery:** Unsent text survives reloads in the same tab. You can compose the next message while a run is active; Send remains disabled until that run ends. Drafts are not automatically queued or submitted.
- **Export conversation:** Downloads a plain-text copy of the currently retained transcript (up to 100 messages), not the entire server history. Exports can contain sensitive content; choose where to store them accordingly.
- **Workspace shortcuts:** Inspect workspace, Organize windows, Build an app, and Change appearance prepare an editable prompt. They never execute without Send. The appearance/build prompts ask Hermes to clarify the desired result first.

History and drafts use sessionStorage, not a global Hermes session browser or cross-device archive. Closing the browser tab can discard them; export important conversations. Existing active-run restoration, Stop, and explicit approval controls remain available. No upstream API credentials enter the browser.

Verification: `tests/browser-hermes-tools-live.py` exercises draft reload, a shortcut, real Hermes response, New chat/archive/restore, a follow-up recalling the original conversation's code, and transcript download. It completed without browser JavaScript errors. Unit tests cover bounded/deduplicated archives, exclusion of active runs, malformed storage, and plain-text export.

Current deployment: the native mojo user service on loopback 4327 replaces the container deployment below. It provides real host shells, movable windows, a hideable sidebar, and agent-driven workspace control/app previews. See [WORKSPACE_CONTROL.md](WORKSPACE_CONTROL.md) for the current operational guide.

Orbit's agent pane connects to the owner's existing Hermes profile via a server-side bridge. It does not inherit another dashboard thread or impersonate an already-running turn. Each pane gets an unpredictable `orbit-<UUID>` conversation ID. Requests go to Hermes Runs; polling provides status and final replies, Stop, and explicit allow-once/deny approvals. Text replies are rendered as text, not HTML.

## Configuration

Set these server environment variables (never Vite/client variables):

- `HERMES_API_URL`: the Hermes API origin, e.g. `http://127.0.0.1:28643`.
- `HERMES_API_KEY`: the configured profile's API_SERVER_KEY.
- `ORBIT_TOKEN`: a private 32+ character Orbit access token.
- `ORBIT_PUBLIC_ORIGIN`: exact private HTTPS origin when using Tailscale Serve.
- `PORT`: loopback listener port.

The existing Connect host token unlocks both shells and agent chat. Never send the Hermes API key to the browser. `.env.deploy` is chmod 0600, Git-ignored, and excluded from Docker build contexts. `HERMES_API_KEY` and `ORBIT_TOKEN` are removed from the spawned terminal's explicit environment. This is not isolation from a malicious same-UID process or Docker administrator; Orbit remains a trusted single-owner service.

## Prior container deployment (superseded)

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
