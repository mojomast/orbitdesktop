# Selected sources and editable briefs: explicit local adapter

This development candidate implements a **dedicated local recipient channel**, not
private-content tools in Normal gateway conversations. In Knowledge search, expand
**Delegate selected sources to a dedicated local Hermes run**, select exact source
snapshots, declare the model/provider disclosure destination configured for that
process, and optionally allow creation of new editable briefs. Granting does not
start inference. The UI lists scopes, remaining budgets, expiry, and Revoke.

## Runtime identity and the Normal blocker

The inspected upstream checkout is Hermes
`d0288be5b3330d2442e3907185b8e9d0958297bb`, matching
`contracts/hermes-runtime-contract.json`. Actual source inspection established:

- `hermes_cli/plugins.py`, `PluginContext.register_tool`, supports registration and
  private plugin configuration. `tools/registry.py:dispatch` forwards
  signature-filtered handler kwargs.
- `model_tools.py:_execute_tool` supplies `task_id`, `session_id`, and `user_task`.
  These are observability/session context, not an Orbit admission credential or a
  gateway-authenticated binding to the durable Orbit submission receipt.
- `gateway/platforms/api_server_runs.py` creates its `run_id` and launches with
  the selected `session_id`. Orbit's `server/workbench-hermes.mjs` freezes the
  Runs payload and receives the accepted run ID later. There is no verified
  per-submission private plugin configuration/credential handoff in this path.
- Importantly, `_RunLaunch.approval_session_key` **is** the gateway `run_id`, and
  `_run_agent_sync` sets it in `tools.approval_context` using a `ContextVar`.
  `effective_task_id` is instead `session_id or run_id`, so handler `task_id`
  is conversation-scoped for ordinary Orbit submissions. The internal approval
  context is a plausible future authenticated adapter seam; this increment has
  **not** validated its propagation through every plugin/concurrent execution
  path or joined it to Orbit's accepted submission receipts and profile identity.
  Normal's remaining gap is that integration/verification, not proof that upstream
  has no internal run identity. It is not safe to substitute model arguments.
- The existing native Workbench adapter uses a dedicated local process and private
  socket precisely because generic gateway plugin registration is not attempt
  authorization. This implementation reuses that transport pattern without
  modifying Workbench authority or execution.

Consequently Normal's workspace-scoped credential is **never accepted** by the new
channel. A model's conversation, pane, profile, task, or workspace argument cannot
select authority. The adapter ignores handler kwargs. No owner token is loaded by
`hermes-plugin/resources.py`.

## Explicit adapter setup

After owner consent, the UI shows a private `resource_channel_file` path. A trusted
operator supplies this setting to the Orbit plugin in a **dedicated, one-run local
Hermes process/profile** using the pinned supported `register(ctx)` and
`ctx.get_config` API. Enable only `orbit_resources` for that process. Do not put
the setting into a shared gateway profile, copy the key into a prompt, or reuse
the profile for another recipient. There is no automated provider launcher or
Normal conversation attachment in this increment. The destination label is the
owner's declaration of the configured recipient's model destination, not a probe
or cryptographic attestation of its provider configuration.

The host-issued channel file selects a server-owned recipient UUID; its HMAC key
and monotonically increasing transport sequence authenticate calls on a mode-0600
Unix socket inside a mode-0700 directory. Tool arguments contain neither key nor
recipient selector. This is same-UID trusted execution, not an OS sandbox. Server
restart invalidates all channels; retained grants cannot resurrect themselves.
Existing revoked records stay revoked. Paths longer than the bounded Unix socket
limit report unavailable rather than falling back to a TCP/owner-token route.

## Finite authority and content

Each immutable grant binds workspace, recipient, selected source IDs and hashes,
source consent generation, independently selected verbs, declared disclosure
destination, expiry, and budgets. Limits are 32 sources, one hour, 100 content/effect
calls, 1 MiB cumulative JSON read results, ten new documents, and 100,000 UTF-8
bytes of brief text. `describe` and receipt lookups do not spend the execution
budget. At most 64 recipient records are retained; exhaustion requires explicit
operator archival of resolved records. There is no silent eviction or replay of
expired creates.

Supported tools are `describe`, `search`, `read_source`, `create_document`, and
`receipt`. Search is keyword-only and intersects the exact source set **before**
ranking, limits, snippets, or counts. Scoped ranking uses only admitted passages,
not global FTS/BM25 corpus statistics. An empty source set returns no hits.
`read_source` returns bounded text, source/content hashes, exact UTF-16 offsets,
and truncation metadata. It does not return original file bytes or another source's
title. Authorization is checked around asynchronous access and again before
disclosure/commit. Source deletion returns `resource_gone`; changed consent
generation returns `stale_resource`. Revoke prevents future reads/effects but cannot
retract bytes already disclosed.

`create_document` accepts a retained UUID `op_id`, title, text, and bounded citations
to granted snapshots with validated ranges. The trusted adapter converts this into
reviewed editable Lexical content with durable plain-text citation identities and
server-derived recipient provenance. It does not grant document-library reads,
existing-document updates, source import/delete, arbitrary HTML, filesystem access,
or browser execution. Create-only grants may have no selected sources.

## Saved, opened, and recovery

`create_content` is an atomic document-service operation, distinct from creating an
empty document then saving it. Content and the document receipt commit together.
The delegation journal reserves one document identity per recipient/op ID before
dispatch. Exact retries return that artifact; changed payloads fail
`operation_mismatch`. Unknown responses retain the operation identity and are
recovered using `receipt` or the exact same request/key. A pending journal entry is
not proof of failure and never licenses a new create key.

Success reports artifact URI, content hash, revision, request digest and
`saved:true`, `opened:false`, `browser_acknowledged:false`. The owner can open the
artifact from Document library, or a separately authorized workspace operation can
open the returned URI. Saved content survives pane closing and layout restoration;
it remains outside layout checkpoints. Browser synchronization and actual rendering
inspection remain separate evidence.

Normal's existing workspace adapter also retains credential-free mutation envelopes
before dispatch under `workspace-adapter-requests/<workspace>`, capped at 128 records,
and preserves safe allowlisted server categories rather than treating every HTTP
409 as a revision conflict. Only resolved records should be explicitly archived.

## Discovery and verification

`contracts/feature-capabilities.mjs` is shared by owner capability discovery,
the Knowledge consent surface, and controller `describe`. It describes feature
types and surface-opening authority separately from owner content verbs and
delegated readiness. It enumerates no private sources/documents. Baseline discovery
does not initialize services or provision assets. Availability is advisory and
rechecked at invocation. Large workspace contexts omit whole records and contain
valid bounded JSON with counts, a truncation flag, and the discovery action.

`tests/resource-delegation.test.mjs` uses real stores and authenticated Unix sockets
for recipient isolation, tampered authority selectors, revocation around reads,
expiry/restart, deletion, byte budgets, ranking isolation, create-only authority,
and lost-response recovery. `tests/resource-grants.browser.py` uses a disposable
workspace, real owner HTTP route, shipped Python adapter, and real Lexical renderer:
select → grant → search/read → cited brief → owner edit/save → revoke. It makes no
provider calls. This is adapter/UI acceptance, not acceptance of Normal gateway
delegation or an actual model-authored response.
