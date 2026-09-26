# Workbench result/provenance contract v1

Authoritative schemas/constants: `contracts/workbench-result-v1.mjs`; owner native
request union: `contracts/workbench-native-v1.mjs`. This contract describes the
new result and patch consumers before implementation. Existing runtime check
evidence and human reviews remain independent of explanation availability.

## Runtime result and receipt

Pinned Hermes `d0288be5b3330d2442e3907185b8e9d0958297bb` returns a dict
with `final_response`, `completed`, `messages`, and `api_calls` from
`run_conversation`. Only `final_response` (string) and `completed` (boolean)
enter the result channel. Incomplete/error Hermes results can carry public
text; it must be labelled `runtime_failed`, not represented as task verification.
Never extract `messages`, hidden reasoning, environment, session history, tool
logs or upstream errors into the explanation. Model text is untrusted plain text.

FD3 remains private runtime input; FD4 is a separate single terminal NDJSON
frame: `{"version":1,"type":"final_response","text":"Repaired sum; see evidence:<uuid>","completed":true}\n`.
Bound **aggregate** FD4 bytes to 73,728, UTF-8 text to 65,536 bytes, fatal
UTF-8 decode and exact JSON object shape. Require a terminating newline. An
identical second frame is idempotent; a different second frame is `conflict`;
excess frames/bytes are `duplicate`/`oversized`. Truncation is `incomplete`.
Stdout/stderr never supply fallback text. Empty/whitespace explanation is
`empty`; malformed JSON/UTF-8/type is `malformed`; exit without frame is
`missing`; nonzero exit or `completed:false` is `runtime_failed` (a bounded
partial public text may be retained as untrusted, explicitly marked as failed).
Zero exit with missing explanation does not erase independent check evidence.
Existing fixtures with no FD4 result obtain `explanation_unavailable`, not a
fabricated answer; their check/verifier assertions remain authoritative.

Persist a `results` record with stable `id`, `{workspace_id,project_id,task_id,
attempt_id,grant_id,run_id,project_generation,candidate_id,
candidate_generation,candidate_hash}`, and original recipient
`{pane_id,profile_id,session_id}` from authenticated grant/binding, never the
model frame. `availability` is `pending|available|explanation_unavailable`;
the frozen result `provenance` records its actual native attempt/run initiator,
owner grant/authority generation authorizer and source-build service recorder;
it does not reuse whichever principal later views or delivers the result.
`unavailable_reason` is null or one of the authoritative enum. `text` is a
bounded string or null; `hermes_completed` separates actual Hermes completion
from process exit. `frame_hash` hashes the validated exact frame; `received_at`
is the service timestamp. `retained_until` bounds explanation payload retention
(default 24 hours, bounded like context retention); after expiry the owner sees
typed `expired` availability with historical hash/IDs but not active text. Purge
does not claim cryptographic erasure from SQLite pages/WAL/backups. A result
receipt is durable before announcing final
completion. Failure to persist transitions to a distinct `result_pending`
finalization state, retains the bounded frame in a private recovery journal,
blocks new admission on unhealthy storage, and permits only `result_retry`
(expected digest, DB-only finalization). Never re-run Hermes on reconnect or
delivery failure. Unknown process ownership remains separately quarantined.
The shared runtime lease is held through settlement. A filesystem fault before
the observed journal is durable yields `dispatch_unknown` and shared-gate
quarantine, not a healthy empty completion. Observed-only recovery after
restart finalizes as fenced/unavailable; a prepared authorized receipt may
finalize its exact saved contents. Post-commit journal cleanup failure is
non-fatal; exact finalized-receipt retry is idempotent.

Owner-authenticated native `status` retains safely projected grant/toolcalls/
health and adds
`result: <receipt|null>` (null only before creation or for historical runs);
`result_get` fetches one scoped durable receipt by ID. `result_retry` is
receipt persistence recovery only. At completion, publication checks that the
grant/attempt/project generation were active and unexpired **then**. At later
owner reads, require current owner authentication and active project generation
plus result retention, **not** that the grant is still running/unexpired; valid
completed explanations remain readable after normal completion or budget
exhaustion. Stopped/revoked/expired *late* output must be fenced, not shown.
Never spread raw result text through `publicGrant`; dedicated `results` records
and an explicit safe projection are preferred.
Result metadata for historical revoked runs may remain visible to the owner
without revealing late text. Result GET does not share content with a model.

## Evidence references and host cards

Only up to 16 literal `evidence:<uuid>` tokens in the public final text become
`model_suggested_references` (`[{evidence_id}]`), and remain **untrusted**.
Resolve independently to `resolved_references` (`[{evidence_id,job_id,verdict}]`)
only where evidence belongs to the exact task/attempt's approved candidate
generation/hash, workspace/project and current permissible grant scope. Missing,
revoked, superseded or foreign IDs remain text/unlinked. Suggested references
never override check verdict. Revalidate stored resolved references on every
owner read, removing newly superseded/revoked or stale candidate links from
the public projection. Render text without links/HTML interpretation;
create links only for server-resolved IDs. A model sentence claiming checks
passed is never evidence of a pass.

`result_deliver` is an explicit owner action binding an available result to its
original pane/profile/session; it stores an idempotent **host-authored** card
receipt keyed by `op_id`. It neither posts to Hermes nor inserts a fake assistant
turn. `cards_list` uses workspace and pane/profile/session binding, no
caller-selected project; the server filters to owner-authorized results and
returns bounded card records `{id,result_id,task_id,attempt_id,pane_id,
profile_id,session_id,text,availability,provenance,created_at}`. Cards persist
across reload, but `cards_list` filters current active project/generation,
retention and exact current pane/profile/session/configuration binding. It is
host UI data, never agent disclosure. Later forwarding to another agent needs a separately reviewed
one-shot disclosure. `result_deliver` rechecks current binding, result authority
and original recipient; request principal/binding fields are selectors, not
trusted attestations. No card is generated automatically on completion.
`cards_list` accepts optional `after_id` pagination and returns
`{cards,next_cursor,truncated}` with intact explanations under a 1.5 MiB JSON
budget; consumers follow `next_cursor` rather than assuming the first page is
the entire pane history.

## Trusted provenance

Jobs and evidence store `{version:1,initiated_by,authorized_by,recorded_by}`.
Native initiation includes `attempt_id/grant_id/run_id/tool_call_id` resolved
from authenticated private UDS, authorization includes the owner grant and
`authority_generation`, recorder is server-computed `{kind:'comet_service',
component:'workbench-check-recorder',build_id,verifier_id,verifier_hash}`.
Owner-started checks use `{kind:'owner_action'}` and
`{kind:'owner_approval',preview_id}`; recorder is still Comet, not owner.
Build ID is the Doctor definition: SHA-256 over sorted `server/*.mjs` and
`contracts/*.mjs` names/bytes (excluding `mobile-proxy.mjs`), computed by
service helper, never Git HEAD or a caller tag. The source hash is snapshotted
at module load, not recalculated from mutable disk while serving. Verifier
ID/hash come from the check definition. Historical records without trustworthy origin project
`{kind:'legacy_unknown'}` rather than inferred native/owner claims.

Admission persists immutable provenance; observed-result staging/finalization
reuses the job's provenance even when another owner later retries recovery.
Identical operation replay preserves original provenance; changed operations
conflict. Review approval remains a separate owner action referencing exact
evidence, not an assertion that the owner initiated its check.

## Reviewed patch request boundary

For a result's exact candidate generation, owner execution actions
`candidate_version_get({workspace_id,project_id,candidate_id,candidate_hash,
generation})` and `candidate_version_read` (same fields plus `path`) select only
the current private root or internally recorded `root_history`. They recapture
the bounded tree and check its candidate hash before exposing metadata/text;
the read action rechecks after reading the bound file. A missing/tampered old
root fails typed unavailable/stale. These are owner reads, not model tools;
result links must pass the stored hash/generation rather than load the current
candidate by ID alone.

`patch_preview({workspace_id,project_id,task_id,candidate_id,review_id})`,
`patch_export` (same IDs plus `preview_id,preview_digest,op_id`), and
`private_patch_get({workspace_id,project_id,artifact_id})` are owner-only
workflow actions; no arbitrary caller path. Export persists a scoped `patches`
receipt with `{artifact_id,status,artifact_hash,bytes,format:'git-unified-diff',
source,candidate,review,changes,exclusions,unsupported,roundtrip}`. Source and
candidate bind manifest/hash/head, file paths/bytes/hashes/modes and capture
completeness; review binds identity, evidence and required check state; changes
bind add/modify/delete old/new hashes/modes. Roundtrip records exact approved
base/result identities, `verified:true` and `unrelated_unchanged:true` only
after applying to a disposable exact base. Exclusions/unsupported paths are
explicit, never inferred deletions. Maximum patch bytes 1 MiB (inside owner
2 MiB response cap). Private get returns only scoped verified patch bytes and
receipt, never an arbitrary path or static public URL. Failed parity/roundtrip
has no downloadable artifact; neither export nor human review implies merge,
deployment or original-tree writes.
