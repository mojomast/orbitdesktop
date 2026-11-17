# Orbit Rails read service (R12)

This optional loopback service reads one configured coordinator Rails SQLite ledger. Its GET handlers do not initialize a database, run imports, open a source, or fall back to Observatory snapshots, example ledgers or fixtures. Nothing here activates the service.

## R16 proxy contract

Register only exact GET paths at the existing Orbit **owner** boundary. Send requests to one fixed numeric loopback backend. Supply its dedicated `Authorization: Bearer …` server-side, a Host matching the backend socket (address **and port**), no Origin, no Cookie, no body, no credentials in the URL. Do not forward client-supplied auth/Host or enable CORS. This service cannot authorize a pane, append, post feedback or submit interventions.

| Backend path | Parameters and response |
|---|---|
| `/v1/health` | No parameters. Reports ledger readability, last import if observed, runtime/contract identifiers, unknown source freshness and unchecked integrity. Unavailable DB: 503. |
| `/v1/events` | Required `kind=attempt\|job\|campaign\|session\|event` and opaque `id`. Optional `limit` (1–500), `after` (opaque page cursor), `format=json\|markdown`, `max_bytes` (up to 32768), `include` (comma-separated tools,verification,review,feedback), `show_tokens=true\|false`. Returns the shared `rizzstack.rails-result/1`. |
| `/v1/view` | Same selector and paging. Returns the shared `rizzstack.rails-view/1` directly. Forward `X-Rails-Next-Cursor` when present, `X-Rails-Has-More`, `X-Rails-Truncated`, and `X-Rails-Stream-Cursor` headers. |
| `/v1/stream` | `kind` and `id` only; optional `Last-Event-ID`. Returns `text/event-stream`. |
| `/v1/feedback/export` | `kind`, `id`, optional `limit`, `after`, required `format=csv\|jsonl`. Paged, sanitized feedback/intervention observations. Same pagination headers. |

For snapshot-to-stream handoff, save the **first** page's `X-Rails-Stream-Cursor`; forward it as `Last-Event-ID`. Query page cursors (`after`) are not SSE IDs. SSE IDs bind a local ingest position to ledger and selector. The `ready` event confirms subscription; without a cursor it starts at the then-current head (take a fresh snapshot). An `invalidate` event means refetch the selected snapshot; changes may be coalesced or replayed. Keep its ID after processing; dedupe marks by origin event ID/revision. No transcript or event envelope travels in a stream. Flush each frame without proxy buffering. A comment heartbeat is sent every 15s. Propagate disconnects; close the upstream stream on owner logout/expiry. On EOF reauthorize/reconnect with jittered 1–30s backoff. On 409 `reset_required` discard the cursor and refetch; on 401 stop until reauthorized. Polling alternative: refetch first page every 5s visible, 30s hidden. Do not use a stable snapshot page cursor to poll for new appends.

Errors are JSON `{ "ok": false, "error": { "code": "…", "retryable": false, "request_id": "…" } }`. A missing selector is 404; a valid selector without observations has empty history. Read scope cannot post even from loopback. Capacity is 429. There are no redirects or token-in-query exceptions. The service rechecks its credential file during streams; the proxy independently owns Orbit session authorization.

## Local configuration and acceptance

Run `python3 -B -E -s -m contrib.rails_server` from the Orbit root. Set `RIZZSTACK_RAILS_DB` to an **absolute**, existing local Rails database. For a WAL database the writer must maintain its WAL and shared-memory companions. If absent, the service returns 503: `mode=ro` alone can otherwise create them on the first GET. Never remove a running writer's journal files. The service's view of the DB **directory** must be read-only (including during writer restarts); the user unit requests filesystem protection, which must be verified on the installed system. For isolated offline checks, an explicitly configured rollback-journal backup also works. No such backup is auto-selected or described as live ingestion.

`ORBIT_RAILS_PORT` is required. `ORBIT_RAILS_BIND` defaults to `127.0.0.1`; keep that for the R16 backend. `ORBIT_RAILS_READ_TOKEN_FILE` names an absolute, owner-private regular file containing the dedicated backend bearer (use 32 random bytes, base64url encoded; keep separate from Orbit's owner credential). Only file paths and listener settings belong in the private environment file. No mutation secret is loaded. `rails.service` is an example user unit; set its working directory privately before any separately authorized activation.

From the Orbit root, use `python3 contrib/rails_server/vendor_runtime.py --source ../bundlebees --rev <full-reviewed-commit>` to vendor the twelve named runtime modules from Git objects (offline, unaffected by local edits). Repeat with `--check` for a read-only parity test. During cross-repo integration only, `--working-tree` instead of `--rev` explicitly marks the manifest as unreviewed. It never invents a commit for uncommitted bytes. Every byte, path and size is pinned in `contrib/rizzstack_rails/vendor-manifest.json`; re-run `--check` after upstream changes. Orbit server execution does not use these tools or require BundleBees installed.

`python3 -m unittest discover -s tests -p test_rails_http.py` uses disposable credentials, numeric loopback sockets and temporary real canonical SQLite ledgers. It covers bounded pages, CSV/JSONL, integrity failure, auth/Host/origin/size/mutation refusal, no-write GETs, missing storage and SSE replay, expiry, rotation, capacity and ledger replacement. One test appends a synthetic worker observation through the canonical writer, imports its original bytes via R04, resumes the SSE reader and retrieves that same origin event ID through HTTP. These are service tests; the R16 proxy and R17 browser acceptance must verify the same ID through the authorized shell before claiming a worker-to-browser path.

## Optional local producer append

The frozen `http.schema.json` grants `POST /v1/append` to a `producer_append` principal. The coordinator-only `contrib.rails_server.producer` entry point implements this route on its own numeric loopback port. It is opt-in; `rails.service` runs the reader only. Keep the producer port and credential out of the Orbit proxy and app configuration. It is independent of owner feedback/intervention submission. Existing worker chains still arrive via authenticated launcher pull and original-byte import; do not configure a worker callback here.

One dedicated producer credential maps to one **local** adapter/instance, exact lane and exact scope, a fixed `imported_observation` role, and a subset of `tool.start`, `tool.finish`, `lane.open`, `lane.close`. Keep credentials in separate private files (including the existing reader credential, required to detect accidental reuse on startup and rotation). Use only an operator-controlled local directory and a pre-initialized canonical ledger. Start explicitly from the packaged Orbit root when authorized:

```sh
python3 -B -E -s -m contrib.rails_server.producer --port "$PRODUCER_PORT" \
  --ledger "$RIZZSTACK_RAILS_DB" --policy "$PRODUCER_GRANT_FILE" \
  --producer-token-file "$PRODUCER_TOKEN_FILE" --read-token-file "$ORBIT_RAILS_READ_TOKEN_FILE"
```

The private grant is a closed JSON object (≤8 KiB; absolute owner-private file). Example with synthetic identifiers; replace the UUID with that of the existing coordinator ledger:

```json
{"ledger_uuid":"00000000-0000-4000-8000-000000000001","adapter":"local-trace","instance":"trace-1","lane_id":"trace-lane","scope":{"job_id":"demo-job"},"kinds":["tool.start","tool.finish"]}
```

Send `application/json` UTF-8 with one bounded `Content-Length`, exact backend Host, private producer bearer, and no browser headers or URL parameters. Request: `{"schema":"rizzstack.rails-append/1","records":[...]}`. Each record is a **full** frozen `rizzstack.rails-candidate/1` including every nullable scope key, null parent IDs, and `redaction_policy:"rails-safe/1"`. Prefix each stable dedupe key with `push:<adapter>:<instance>:`. Use only known tool/family labels and the summary `Tool call observed` / `Tool completion observed` (or empty/`[redacted]`). No free-form source content, origin envelopes, ledger IDs, authority upgrades or source cursors may be submitted.

One admitted batch, ≤1 MiB UTF-8, ≤500 records, ≤64 KiB canonical bytes per record. One R04 transaction appends all new observations and its checkpoint. The server acknowledges only after commit: `{"ok":true,"receipts":[{"event_id":"…","seq":1,"hash":"…","duplicate":false}],"committed_cursor":null}`. Push has no upstream read cursor. An identical keyed retry returns the original receipt with `duplicate:true` and adds no checkpoint; conflicting reuse rolls back the entire batch with 409. If a reply is lost, resend with the same keys. Stop the producer process to disable this listener; reads and stored history continue independently.

`python3 -B -m unittest discover -s tests -p test_rails_append.py` exercises the two real HTTP listeners, producer provenance and scope refusals, receipt identity, full rollback, replay, malformed wire objects and size limits on a temporary local ledger.
