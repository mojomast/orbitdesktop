# Technology feature shell integration

The Start menu and command palette expose Knowledge search, Interactive results,
Data workbench, Voice transcript, Document library, Run traces, Browser copilot and
MCP Apps (when configured). Each opens a stable, ordinary browser-kind window with an exact reviewed
`orbit://surface/…` URL. Document windows use `orbit://document/<uuid>`.
URLs carry identity only. Owner credentials are supplied by the live host callback.
The shell enforces the existing 100-window bound for these creation paths and passes
the stable pane ID to each mount. Moving a surviving pane keeps its existing view;
closing or replacing it disposes its requests, workers and subscriptions.
Restored interactive-result, browser-copilot and MCP panes refresh their private
libraries/capabilities after host unlock. Credential/workspace changes fence old
responses. Reconnection preserves local form edits and does not launch a browser,
execute an action or open an imported app automatically.

| Surface | Guide | Input / capability boundary |
| --- | --- | --- |
| Knowledge search | [Search](KNOWLEDGE_SEARCH.md) | Explicit text, excerpt or UTF-8 file snapshots; local embeddings are optional |
| Interactive results | [A2UI](INTERACTIVE_RESULTS.md) | Reviewed A2UI v0.9 JSON/NDJSON imports and trusted adapter calls |
| Voice transcript | [Dictation](VOICE_DICTATION.md) | Microphone/audio file → local model → editable transcript → selected draft |
| Data workbench | [Data Lab](DATA_LAB.md) | Owner-picked CSV/JSON/Parquet; saved recipes bind exact file/table identities |
| Document library | [Documents](DOCUMENTS.md), [Canvas](CANVAS.md) | Private rich text and whiteboards with independent revisions and recovery |
| Run traces | [Traces](RUN_TRACES.md) | Observed Normal/Workbench events, redacted local projection and explicit export |
| Browser copilot | [Browser](BROWSER_COPILOT.md) | Configured disposable browser, exact selected target and explicit owner actions |
| MCP Apps | [Apps](MCP_APPS.md) | Owner-imported self-contained app/result snapshots in a separate-origin sandbox |

These are source-development features. Provisioning a model or execution backend
is separate from opening its UI. Automatic transcript crawling, automatic Hermes
A2UI/MCP production, and an autonomous browser planner are not implemented.

Owner JSON routes are POST-only, origin-checked, bearer-authenticated, strict UTF-8,
byte-bounded and `no-store`. Optional service initialization is lazy and single-flight;
initialization failures return explicit `unavailable` errors without stopping Orbit.
Document CAS failures preserve a bounded current revision; arbitrary exception text
and private paths are not reflected to the browser.

The app and worker CSP permits same-origin WebAssembly (`wasm-unsafe-eval`) and
same-origin/blob workers required by the reviewed local engines. ORT proxying and
Transformers blob WASM caching are disabled; `script-src` does not permit blobs.
No general `unsafe-eval`, CDN origin or global cross-origin
isolation is enabled. DuckDB EH assets are served through a fixed allowlist checked
against the installed exact version. Voice model assets use the feature's explicit
checksum-verifying allowlist. Unversioned engine paths are not immutable cached.
Static WASM and font responses have their correct MIME types.

Private feature data is separate from layout checkpoints. Complete runtime backups
must include each feature's private directories and sidecars in addition to the
workspace database; consult the individual feature documentation for retention and
provisioning. Voice models are explicitly provisioned and never auto-downloaded by
the server. Optional browser/MCP configuration and real engine acceptance are
reported by their feature capability surfaces, not inferred from window creation.

Browser copilot discovery requires `ORBIT_BROWSER_EXECUTABLE` and
`ORBIT_BROWSER_ALLOWED_ORIGINS`; the feature still checks actual driver availability.
MCP Apps requires `ORBIT_MCP_APPS=1`. Set
`ORBIT_MCP_APPS_SANDBOX_ORIGIN` to an independently served exact proxy origin, or
use the optional loopback listener with an explicit `ORBIT_MCP_APPS_SANDBOX_PORT`.
It serves only the static proxy, validates Host and has no owner APIs.
Configuration errors disable this optional integration. Proxy host origins include
the configured development/public origins. A remote/public host must provision a
reachable separate proxy origin rather than relying on the client's loopback.

Workbench environments and execution receive the same IO-free sandbox provider.
Provider status is exposed through the existing owner execution dispatch. Its
configuration/probe failures remain truthful capability failures, and execution is
closed before the provider during shutdown. See `docs/ISOLATED_CHECKS.md` for the
provisioning and approval contract.
