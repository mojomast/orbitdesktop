# Selected sources and editable briefs

This development candidate supports **one-run Normal conversation grants through
the pinned local Hermes gateway**, plus a dedicated-local recipient fallback.
In Knowledge search, choose an actual linked conversation, select exact source
snapshots and optionally permit creation of new editable briefs. A Normal grant
attaches only to that binding's next accepted run; granting does not start inference
or add authority to an already-running turn. The UI lists scope, budgets, expiry
and Revoke. Host and gateway configuration are explicit prerequisites.

## Authenticated Normal identity

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
  the selected `session_id`. `_RunLaunch.approval_session_key` is the run ID;
  `_run_agent_sync` sets its ContextVar and binds the API session/profile context.
  `effective_task_id` is instead `session_id or run_id` and is not run authority.
- `hermes-plugin/normal_resources.py` pins eight relevant upstream source files,
  reads direct gateway/approval ContextVars and requires matching run keys,
  session, profile and `api_server` platform. It rejects inherited child-agent
  contexts and environment-only identity. Actual pinned thread/context propagation
  and registry dispatch are exercised by the acceptance test; no handler kwargs or
  model-provided identity can select a grant.
- The existing native Workbench adapter uses a dedicated local process and private
  socket precisely because generic gateway plugin registration is not attempt
  authorization. This implementation reuses that transport pattern without
  modifying Workbench authority or execution.

After `server/agent.mjs` durably saves the accepted submission receipt, a trusted
callback consumes the exact pending grant and publishes a private per-run channel
file. Admission checks current pane generation, profile fingerprint, accepted
receipt/run and recalculated payload hash. It verifies active status/session at
the original configured gateway and reauthorizes after the awaited read. Subsequent
turns, switched bindings, unknown receipts, disposed panes and revoked scopes cannot
inherit authority. A bounded adapter wait permits channel publication after a fast
gateway starts; it never retries an effect automatically.

Normal's workspace-scoped credential is **never accepted** by this channel. Neither
adapter loads an owner token. Run-specific keys stay in private files, not prompts,
model arguments, Runs payloads or shared process environment variables.

## Configure the pinned local Normal gateway

1. Set host `ORBIT_RESOURCE_NORMAL_PROFILES` to an explicit JSON map from Orbit
   profile IDs to actual upstream API profile context names, for example
   `{"default":"","studio":"studio"}`. The default upstream context is `""`;
   `/p/studio` uses `"studio"`. Do not infer context names from display labels.
2. In that local pinned gateway profile's Orbit plugin configuration, set
   `normal_resource_directory` to the private profile directory shown by the owner
   grant panel: `<runtime>/resource-delegation/normal/<Orbit-profile-id>`.
3. Enable `orbit_resources` alongside the desired existing toolsets. This directory
   is a locator, not a shared grant key. The adapter selects a separate run file
   solely from trusted runtime context. Do not configure the fallback's
   `resource_channel_file` in a shared Normal profile.

The gateway must share the provisioned filesystem/Unix-socket access. Remote
gateways without that adapter and unverified Hermes source versions are unavailable;
there is no session-ID or environment fallback. Owner readiness remains
`configured_unverified` until successful authenticated use. Normal disclosure
destination is derived from the configured gateway/profile; that gateway chooses
its configured model/provider. This source change does not configure a live gateway
or authorize provider inference.

### Separate compatible testing gateway

When the existing Hermes gateway differs from the eight adapter source pins,
provision a separate checkout of `NousResearch/hermes-agent` at
`d0288be5b3330d2442e3907185b8e9d0958297bb`, with its own frozen Python environment,
private `HERMES_HOME`, workspace, API key and unused loopback port. Follow the
[pinned-runtime provisioning procedure](DEPLOYMENT.md#recreating-the-native-acceptance-environment).
Do not modify the pinned context/gateway files or point this test gateway at the
existing Hermes home. Disable profile multiplexing and configure only its API
server platform. Install the reviewed Orbit plugin into that home's plugin
directory and enable `orbit_resources` in the API-server toolsets.

Add a separately named Orbit profile through `HERMES_PROFILES_JSON`, retaining all
existing entries and the ordinary `HERMES_API_URL`/`HERMES_API_KEY` default. For an
Orbit profile named `agency-test` served at the new gateway's root, use
`ORBIT_RESOURCE_NORMAL_PROFILES={"agency-test":""}` and set that gateway plugin's
`normal_resource_directory` to
`<Orbit-runtime>/resource-delegation/normal/agency-test`. The empty upstream name
is the isolated gateway's default context; it is not the Orbit display label.
Store API/provider credentials only in private operator configuration.

Before switching a conversation, verify exact source hashes, plugin registration,
authenticated session/model discovery, refusal without authentication, loopback
binding and the observed Orbit profile list. Use a new test conversation and
synthetic sources for the first delegated run. A healthy listener and a configured
profile do not establish authenticated grant consumption or provider task quality;
record those separately. Provider configuration does not authorize an automated
billable inference test. Gateway rollback removes the new profile after its runs
settle and stops only the dedicated test service.

## Dedicated-local fallback setup

After owner consent, the UI shows a private `resource_channel_file` path. A trusted
operator supplies this setting to the Orbit plugin in a **dedicated, one-run local
Hermes process/profile** using the pinned supported `register(ctx)` and
`ctx.get_config` API. Enable only `orbit_resources` for that process. Do not put
the setting into a shared gateway profile, copy the key into a prompt, or reuse
the profile for another recipient. There is no automated provider launcher for
this fallback. The destination label is the
owner's declaration of the configured recipient's model destination, not a probe
or cryptographic attestation of its provider configuration.

The host-issued channel file selects a server-owned recipient UUID; its HMAC key
and monotonically increasing transport sequence authenticate calls on a mode-0600
Unix socket inside a mode-0700 directory. Tool arguments contain neither key nor
recipient selector. This is same-UID trusted execution, not an OS sandbox. Server
restart invalidates all channels; retained grants cannot resurrect themselves.
Existing revoked records stay revoked. The ephemeral listener uses an exclusive
mode-0700 `orbit-resource-*` temporary directory, keeping long durable runtime paths
within Unix socket limits. Normal shutdown removes that directory; crash-orphan
cleanup is an operator task. There is no TCP/owner-token fallback.

## Finite authority and content

Each immutable grant binds workspace, recipient, selected source IDs and hashes,
source consent generation, independently selected verbs, declared disclosure
destination, expiry, and budgets. Limits are 32 sources, one hour, 100 content/effect
calls, 1 MiB cumulative JSON read results, ten new documents, and 100,000 UTF-8
bytes of brief text. `describe` and receipt lookups do not spend the execution
budget. The host admits at most **64 live or closing channels**, across workspaces,
including prepared grants awaiting their next run. Historical grant records and
operation identities do **not** consume those slots. No historical record or
committed/unknown create identity is physically garbage-collected by this feature.

### Channel and history retention

Cleanup is demand-driven on owner operations, accepted Normal runs and tool-call
completion. Revoked/expired channels retire, as do Normal channels whose trusted
host binding was superseded or whose accepted run was reconciled as completed.
An authenticated terminal gateway status can also retire its exact channel.
Unavailability, an unknown submission, or an unobserved run outcome is not proof
of completion: the channel remains bounded by its expiry until authoritative
reconciliation. Retirement removes the disposable key file and releases in-memory
authority, while retaining the complete grant and operation journal. A retired
call still in flight keeps its capacity slot until it returns; its commit and
disclosure fences still apply. An unknown create is never automatically retried.

On restart, old disposable key projections (including files left by an abrupt
exit) are invalidated. Grant history is not reopened as authority. This assumes
the existing single authoritative host writer per runtime root. Short private
ephemeral Unix socket directories remain independent of durable runtime path length.

The Normal adapter's 64-entry limit likewise applies to live/in-flight channel
handlers. On calls, idle cached handlers can be removed only when their host key
file has been removed or their immutable expiry has passed. Transient file-access
errors do not prove retirement. Live/in-flight handlers keep their sequence and
lock; capacity pressure never evicts them, resets their sequence or causes an
effect retry. Exhaustion of genuinely live entries returns
`normal_channel_capacity`, with no mutation started. Older key files without an
expiry remain supported and are eligible for eviction when the host removes them.

Owner **Refresh delegated recipients** displays live/closing capacity and retained
history separately, with available slots. Each response includes all current
workspace channels plus at most 32 historical records. **Next retained history
page** and **First retained history page** use an exclusive UUID cursor, ordered
by recipient ID (not chronology); refresh the first page to see newly retired
records that sort before a previous cursor. Scanning history retains only a bounded
page of record projections in memory. **Retained operation receipts** shows exact
operation ID, request digest, document identity and `committed` versus `unknown`.
This is observation, not permission to replay an old operation or regrant a closed
recipient. The full private receipt records remain on disk across restart.

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
before dispatch under `workspace-adapter-requests/<workspace>`, capped at 128 unresolved records,
and preserves safe allowlisted server categories rather than treating every HTTP
409 as a revision conflict. An exact successful `command_receipt.operation_id`
moves its immutable envelope into retained `completed/` history without consuming
unresolved capacity. Historical exact retries remain valid; changed payloads with
old keys are refused. Missing/mismatched receipts, errors and unknown effects stay
pinned. Physical history removal is not automatic. A failed history move reports
`retention: archive_pending` without turning a known response into an unknown effect.

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
provider calls. With `--normal` and the pinned Hermes source/interpreter configured,
the browser fixture also exercises real Normal recipient selection, accepted host
submission, actual gateway-context adapter execution, cited brief/edit/save and
revoke. `tests/normal-resources.test.mjs` covers cross-run/profile/session fences,
subsequent turns, terminal status, tampered receipts and awaited revocation. Its
pinned Python driver uses actual gateway lifecycle, registry and thread-context
code with a deterministic agent body. These are transport/context/UI checks, not
evidence of an actual model-authored response or live provider quality.
