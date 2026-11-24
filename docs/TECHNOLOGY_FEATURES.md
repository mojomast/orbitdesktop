# Technology feature shell integration

Owner capability discovery and controller descriptions share reviewed feature-type
descriptors that distinguish opening a surface from private-content authority.
The [scoped resource adapter](RESOURCE_DELEGATION.md) supports selected-source
search/read and creation of cited editable briefs. Normal delegation binds the
next accepted run through the configured pinned local gateway; a dedicated-local
recipient remains available separately. Missing configuration or runtime identity
fails closed, and feature-type discovery alone does not grant content access.

Start, the palette, owner technology discovery and scoped controller `describe`
share content-free prerequisite descriptors. Discovery performs bounded file-stat
and configuration observations at request time, with an observation timestamp and
30-second freshness budget. Model/extension presence is **unverified**, never a
claim of valid checksums, inference, microphone permission or successful execution.
Feature invocation independently validates these things. Discovery does not open
private libraries or start engines. Known input formats and contract references
accompany the observations. Owner use and separately granted agent tools remain
distinct from opening a surface.

Optional unconfigured tools remain discoverable with setup explanations; opening
their UI does not enable the backend. Shell observations refresh on discovery,
connection, focus and expiry; credential/workspace changes and newer requests
fence responses.

For task-oriented examples, see [Workspace prompts](WORKSPACE_PROMPTS.md). These
features are implemented in the development candidate; package metadata remains
0.3.1 and no new release is implied. [Verification](VERIFICATION.md) distinguishes
exact-head CI, deployment checks and pending owner visual acceptance.

The separately published [Asteria Mission Control](ASTERIA_MISSION_CONTROL.md)
example uses a shared deterministic scenario model for an interactive mission
dashboard, comparison and brief exports. It follows the sandboxed plugin lifecycle
and uses bundled synthetic data; installation is separate from the built-in tools.

The Start menu and command palette expose Shared sources, Interactive results,
Voice transcript, Document library and Run traces, including setup explanations
when optional services are unconfigured. Each opens a stable, ordinary
browser-kind window with an exact reviewed `orbit://surface/…` URL. Document
windows use `orbit://document/<uuid>`. URLs carry identity only. Owner credentials
are supplied by the live host callback. The shell enforces the existing 100-window
bound for these creation paths and passes the stable pane ID to each mount. Moving
a surviving pane keeps its existing view; closing or replacing it disposes its
requests, workers and subscriptions. Restored interactive-result panes refresh
their private libraries/capabilities after host unlock. Credential/workspace
changes fence old responses. Reconnection preserves local form edits and does not
execute an action automatically.

| Surface | Guide | Input / capability boundary |
| --- | --- | --- |
| Shared sources | [Resource delegation](RESOURCE_DELEGATION.md) | Explicit text, excerpt or UTF-8 file snapshots; keyword-only local index |
| Interactive results | [A2UI](INTERACTIVE_RESULTS.md) | Reviewed A2UI v0.9 JSON/NDJSON imports and trusted adapter calls |
| Voice transcript | [Dictation](VOICE_DICTATION.md) | Microphone/audio file → local model → editable transcript → selected draft |
| Document library | [Documents](DOCUMENTS.md), [Canvas](CANVAS.md) | Private rich text and whiteboards with independent revisions and recovery |
| Run traces | [Traces](RUN_TRACES.md) | Observed Normal events, redacted local projection and explicit export |

Provisioning a model is separate from opening its UI. Authenticated completed
Hermes replies can offer explicitly reviewed A2UI and document actions. This does
not provide automatic transcript crawling, unattended A2UI generation or an
autonomous browser planner.

## Setup at a glance

| Capability | Operator setup |
| --- | --- |
| Shared sources | Available without model assets; import sources explicitly |
| Voice | `node scripts/provision_voice_models.mjs --models-root /absolute/private/runtime/models`; match `ORBIT_VOICE_MODELS_ROOT` when overridden |

Provisioning commands explicitly download pinned assets; normal server startup
does not. Read each guide before provisioning into an existing runtime. Configuration
changes belong in the private service environment; packaged application updates
follow [Deployment](DEPLOYMENT.md). Do not put credentials or models in Git.

## Persistence at a glance

Workspace layout/checkpoints retain pane identities and placement, not private
feature contents. Conversation drafts and library metadata, source snapshots,
documents/canvases, saved A2UI edits and trace stores have separate lifecycles.
Documents require explicit Save. Preserve the complete runtime and configured
external asset roots when making deployment backups. See the feature guides for
exact storage and recovery behavior.

## Host integration contract

Owner JSON routes are POST-only, origin-checked, bearer-authenticated, strict UTF-8,
byte-bounded and `no-store`. Optional service initialization is lazy and single-flight;
initialization failures return explicit `unavailable` errors without stopping Orbit.
Document CAS failures preserve a bounded current revision; arbitrary exception text
and private paths are not reflected to the browser.

The app and worker CSP permits same-origin WebAssembly (`wasm-unsafe-eval`) and
same-origin/blob workers required by the reviewed local engines. No general
`unsafe-eval`, CDN origin or global cross-origin isolation is enabled. Voice model
assets use the feature's explicit checksum-verifying allowlist. Unversioned engine
paths are not immutable cached. Static WASM and font responses have their correct
MIME types.

Private feature data is separate from layout checkpoints. Complete runtime backups
must include each feature's private directories and sidecars in addition to the
workspace database; consult the individual feature documentation for retention and
provisioning. Voice models are explicitly provisioned and never auto-downloaded by
the server. Real engine acceptance is reported by the feature capability surfaces,
not inferred from window creation.
