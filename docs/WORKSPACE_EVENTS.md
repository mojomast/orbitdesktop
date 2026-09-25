# Workspace event polling

Workspace command commits already write small metadata outbox entries atomically with their receipts. The authenticated event endpoint exposes **finite, bounded pages**, not server-sent events or a push subscription. A browser can use a page as a hint to read the authoritative workspace through the existing sync path; it must never interpret event metadata as an instruction or assume that receiving an event proves rendering.

`POST /api/workspace/events` requires the owner Orbit Bearer token and the normal allowed Host and Origin. `POST /api/workspace/control/events` instead requires the capability of the requested workspace; the server verifies it against the current record on **every** request. Controller capabilities must not be sent to browser code. Neither endpoint mutates or acknowledges workspace state. The server routes are integrated separately from the reusable `server/workspace-events.mjs` handler.

The JSON request is at most 4096 bytes and accepts only `workspace_id` (UUID), `cursor` (nonnegative safe integer, default `0`) and `limit` (integer 1–100, default `100`). Unknown fields and malformed inputs fail closed. A page contains `workspace_id`, `events`, `cursor`, `has_more`, and `reset_required`. Each event is limited to `sequence`, `type`, `timestamp`, `causation_id`, `correlation_id`, and `payload` with `action`, `revision`, `changed`, and optional `recovery_policy`. It contains no state, credentials, capability, request intent, terminal content, or plugin output.

The store filters events to the requested workspace **before** limiting and retains a bounded retrieval horizon of the latest 1000 events for that workspace. The page cursor advances only through events of that workspace; a global maximum or another workspace's events must not be used as the response cursor. An expired or future cursor sets `reset_required`; the client requests a full authoritative workspace read and resets its in-memory cursor to the returned workspace-local position, rather than inferring missed mutations. The store's durable outbox itself is not pruned by this retrieval horizon.

`connectWorkspaceEvents({workspaceId,getToken,onChange,onReset,status?})` is a browser-side optional accelerator: `onChange` asks the existing sync layer to read the authoritative state, and `onReset` asks it to reconcile after a gap. Its cursor lives only in memory, never in URLs or local storage. Pages, retries and intervals are bounded; `close()` aborts an outstanding request and stops future polls. Keep the existing 1200 ms workspace sync timer as the independent fallback for missed events, transport failures and older clients. Browser reconnection or reload may reread metadata and must tolerate duplicates. This transport is periodic **polling**, not instantaneous notification, long polling, SSE, or a guarantee of exactly-once delivery.

The normal frontend now wires these hints into coalesced sync reconciliation (which
may also submit pending local edits through the existing revision checks). It requests
at most four pages per polling turn, then yields for 1200 ms; each request has a 15 s
timeout and a 2,000,000-byte response limit. Slow consumers never leave a server-side
subscription or unbounded response queue. Unexpected response fields are stripped
before callbacks. A throwing consumer advances past that event and requests a snapshot
reset rather than wedging replay forever; consumers must treat metadata as advisory.
Both event polling and state polling suspend on `pagehide` and resume on `pageshow`
for restored pages. Lifecycle behavior is unit-tested; full browser back/forward-cache
admission is browser-dependent and not a demonstrated session-continuity guarantee.
