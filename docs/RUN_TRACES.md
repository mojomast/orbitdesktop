# Local Run Traces

The trusted host surface `orbit://surface/traces` displays a bounded, private,
derived projection of events actually observed by Orbit. It is not a verdict,
execution receipt, conversation archive, or proof that an unobserved operation
failed. Normal and Workbench remain authoritative.

## Integration

```js
const runTraces = createRunTraces({
  root: runtimeRoot,
  workspaceRead: workspaceService.read,
  workbenchData, // optional, read-only committed record subscription
});
const runTracesHandler = createRunTracesHandler({
  token, port, devOrigins, reply, traces: runTraces,
});
// POST /api/run-traces -> runTracesHandler
// createAgentHandler(..., onRunEvent: event => runTraces.observe(event))
// Shutdown: runTraces.close()
```

Construction subscribes without opening a database. Store opening is lazy;
capability reports `available:false, reason:'store_unavailable'` on failure.
Observation failures are counted and never escape into an authoritative submit.
Do not wire this service through a browser/model-controlled observation API.

The trusted agent callback is exactly:

```js
{
  workspace_id, profile_id, session_id, run_id, // checked by the caller
  event: {event:'tool.started', tool:'read_file',
          tool_call_id:'call-1', timestamp:1700000000},
  at: Date.now(), // optional local observation time
}
```

Names must be bounded identifier strings (`[A-Za-z0-9_.:-]`), not free-form text.
The adapter recognizes explicit run/tool lifecycle event names, fixed status
values, opaque call IDs and timestamps only. Unknown names/shapes are omitted.
Tool arguments/results, prompts, output, file paths, errors, tokens and costs are
never copied. A timestamp number below `1e12` is Unix seconds, otherwise Unix
milliseconds; a bounded date string is parsed as a timestamp. Workbench record
timestamps are milliseconds and copied directly, without this heuristic.

Workbench job/evidence relationships are resolved through read-only committed
toolcall/grant/job records and their provenance. If only a candidate relationship
exists, it is projected only when exactly one recorded attempt matches, with
`relationship:'unique_candidate'`; this is not an assertion the attempt initiated
the owner action. Ambiguous relationships are omitted. Supply `workbenchData` to
the factory even when the parent also delivers commit notifications externally;
duplicate delivery is idempotent. Attempt creation is an instant fact rather
than invented run execution; native grant transitions provide run status.

For the existing Hermes SSE forwarding branch, after run/session/pane/profile
checks, create `createRunTraceTee({binding,onRunEvent})`, call `tee.write(chunk)`
inside the existing forwarding loop, and `tee.close()` in its `finally`. Original
bytes are forwarded unchanged. The decoder handles split/multiline frames,
drops frames exceeding 32 KiB, and caps parsing at 4,000 frames per connection.
Malformed/oversized frames emit a metadata-only `trace.gap` callback; the trace
becomes partial. Exceptions in callback/error hooks are swallowed. No trace SSE
endpoint or token-bearing URL is needed: the pane polls authenticated POST pages.

For accepted starts and verified status snapshots, call the callback best-effort
with `event:{event:'run.status',status:run.status,started_at:run.started_at,
ended_at:run.ended_at}`. Do not use `output`, `last_event` text or a browser-supplied
profile/session/run to bypass the existing binding checks. Start-only and
poll-only observations remain explicitly local-observation timing.
Normal tool observations exist only while Orbit receives the proxied Hermes SSE
stream; this feature does not create a background gateway subscription. Status
polling can observe run state without recovering missed tool events. An absent
trace or an open span is not proof that a remotely running process is idle.

## Timing and lifecycle honesty

* Paired upstream timestamps: `duration_origin:'observed'`.
* Server observation/Workbench commit timestamps:
  `duration_origin:'local_observation'`; not model/process execution duration.
* Completion with no observed start: zero-duration `instant`, partial lifecycle.
* Evidence/results/reviews/candidates/patches: instant recorded facts, no invented
  execution interval.
* Open spans have `end_unix_ms:null`. Restart flags retained active traces partial
  without inventing a terminal status or end timestamp.
* Unknown/revoked/expired outcomes remain partial. A stop request is not a stop.
* No backfill from conversation text. Historical Workbench records predating the
  subscription are not reconstructed as observed transitions.

Trace identity hashes include workspace, method, project or profile/session and
run/attempt. Reusing an upstream run ID in another workspace/profile/session
cannot merge traces. API pages/detail/export/remove require the owning workspace;
profile/session and method/status filters select within it. Opaque record
references provide the IDs to inspect in the authoritative conversation or
Workbench view; copying an ID does not grant access to its content.

## OpenTelemetry and persistence

Pinned `@opentelemetry/api@1.9.1` and
`@opentelemetry/sdk-trace-base@2.11.0` are used for actual targeted completed spans:
`BasicTracerProvider -> SimpleSpanProcessor -> synchronous private SQLite
SpanExporter`. Each service has its own provider and deterministic ID generator;
no global provider is installed. Open projections persist locally until a real
end is observed. The local exporter persists validated allowlisted metadata;
there is no HTTP exporter, collector, telemetry endpoint or network export.
Owner export produces bounded OTLP-shaped JSON with timing provenance and an
explicit open-span attribute; open spans intentionally lack a fabricated OTLP end.

`<runtimeRoot>/run-traces.sqlite` and its `-wal`/`-shm` sidecars are private derived
records, outside core SQLite migrations, layouts and checkpoints. Include them
in complete private runtime backups, or omit/delete them intentionally when a
derived history is not desired. SQLite files are mode `0600`; newly created root
directories are `0700`. Existing runtime directory permissions are not rewritten.
Symlink/hardlink database files are rejected before opening.

Limits: 200 traces per workspace and 400 across the private file, 2,000 spans per trace, 4 KiB per span, 500 spans
per page, 4 MiB explicit JSON export, 16 KiB requests, and a seven-day retention
eligibility window. Durable replay identities are bounded at 8,000 per trace.
Eviction removes only derived rows. Owner `retention {dry_run:true}` previews age
eligibility; `dry_run:false` applies it. `remove` deletes one owned projection.
Future observed events can recreate a removed projection; removal does not stop
a run or delete upstream authoritative records. SQLite can retain reusable free
pages; row removal is not secure erasure.

## UI and verification

**Share diagnostic summary** captures fresh bounded metadata for the selected run
and opens the selected-conversation draft review. The actual draft includes trace
and run identity, observed status, gap/open/error counts, timing provenance and an
explicit snapshot caveat. It includes at most 500 spans in its aggregate and marks
omitted pages; summed spans may overlap and are not wall-clock duration. Tool names,
arguments, results, arbitrary attributes and paths are not copied. Insertion never
sends a message and does not grant access to the referenced run. The summary is a
derived observation, not an execution verdict or authoritative receipt.

`mountRunTracePane(host,token,options?)` returns `{dispose()}`. It lazily requests
the current workspace, lists method/status filters, renders at most 500 visible
waterfall rows, labels timing provenance/open/partial states, exposes opaque
references and bounded export/removal/retention controls. Requests and polling
are aborted on disposal. The host token comes from the live callback only.

Focused gates:

```sh
node --experimental-strip-types --test tests/run-traces.test.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
 /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/run-traces.browser.py
```

The Node suite exercises real WorkbenchData commit subscription, SQLite/SDK
exports, scope rejection, redaction, idempotence, restart, retention, owner auth,
parser bounds and a real pane/profile/session-bound agent handler with fake Hermes
responses. The callback test fails if the optional core hook is not integrated.
The browser test copies/builds the full server into a disposable directory with
private HOME/runtime and a synthetic HTTP Hermes gateway, runs actual start/SSE
callbacks, inspects the waterfall/export, and reconnects after reload. No browser
response interception, trace import endpoint, live owner runtime or inference is
used. Run it after the parent integrates the core hook and host surface.
