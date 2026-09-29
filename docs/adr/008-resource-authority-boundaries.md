# ADR 008: Resource authority, revocation and restore boundaries

Status: **design-only architectural recommendation**. The decisions marked accepted
below are the recommended architecture for a future implementation, not evidence of
owner approval, implemented grants, new APIs or permission to deploy. Owner-policy
choices remain explicitly pending. ADR number 008 was unused when this file was
created. Layout remains v1; the inspected database baseline is schema 3.

## Context and inspected evidence

Read this decision with [Architecture](../ARCHITECTURE.md), the
[operator guide](../AGENT_GUIDE.md), [resource proposal](../RESOURCE_AUTHORITY_PROPOSAL.md),
[store operations](../WORKSPACE_STORE.md) and [recovery boundaries](../RECOVERY.md).
This ADR selects the proposal's first gate and makes its concurrency and restore
requirements explicit; it does not specify route names or wire contracts.

- [`LocalHostProvider.spawn` and `captureHistory`](../../server/local-host.mjs)
  attach/create `pane-<id>` sessions using `new-session -A`, and separately capture
  history by session name. Capture currently reads full retained history plus the
  alternate screen, with a 5-second timeout and 8 MiB buffer **per subprocess**.
  Neither a syntactically valid pane ID nor that capture target proves workspace
  ownership or session incarnation. These helpers are not the proposed adapter.
- [`server/index.mjs`](../../server/index.mjs) authenticates the interactive terminal
  WebSocket using origin/token checks, spawns a PTY, and delivers asynchronous
  history results through `send`. It is not an exact-resource read-only grant path.
- [`server/workspace.mjs`](../../server/workspace.mjs) distinguishes owner access
  from workspace-controller capability and assigns command actors server-side.
  [`SqliteWorkspaceStore.commit`](../../server/sqlite-workspace-store.mjs) checks
  authorization and recovery-policy generation inside an immediate transaction,
  including on receipt replay. It stores full result/record JSON in receipts.
  Its synchronous transaction cannot encompass an awaited provider capture.
- The store uses WAL, FULL synchronous mode and bounded busy timeout. SQLite
  serializes concurrent writers; a JavaScript mutex or cancellation flag does not
  coordinate another server process. The existing recovery generation concerns
  registered-plugin activation, not resource authority.
- [`backup`/`exportLegacy`](../../server/sqlite-workspace-store.mjs) and the
  [administration helper](../../scripts/workspace_store.mjs) use SQLite backup and
  staged publication. Restore validates schema 1–3 and publishes a new runtime,
  preserving existing recovery policy. `--confirm-stopped` is an assertion, not
  writer exclusion. Startup newer-schema refusal cannot stop already-open older
  connections. No resource-grant quarantine or anti-rollback authority exists.

## Decision table

| Topic | Accepted architectural recommendation | Owner policy still requiring approval |
| --- | --- | --- |
| First gate | One bounded recent **terminal output snapshot**, from one verified existing tmux resource, delivered exclusively to a trusted owner UI. Deny by default; no streaming, input or full-history shortcut. | Approve this resource/field set and private-content exposure before implementation/use. |
| Subject | Authenticate owner subject and bind the grant to the current trusted UI session/channel; derive identity server-side. Grant IDs, pane IDs, plugin IDs and controller capabilities are not subject credentials. | Session lifetime and owner reauthentication UX. |
| Identity | Separate placement, provider-issued resource descriptor/incarnation, and grant. Exact workspace/provider/resource/incarnation scope; no wildcard. | Whether detach itself revokes; recommended conservative first policy is revoke on detach/close. |
| Expiry | All grants finite, no silent renewal; expiry and request deadline checked before capture and final release. | Proposed default **60 seconds**, hard cap **5 minutes**, renewable only through fresh explicit owner consent. These numbers are not current defaults. |
| Bounds | Enforce capture, output, concurrency and deadline limits before and after capture; render output as inert text. | Proposed maximum **16 KiB UTF-8**, **200 recent lines**, **2 seconds** total request budget; one outstanding capture per grant, with separately approved aggregate limits. Reject oversize/timeout without partial delivery. |
| Revocation | Independent transactional authority epoch/generation, cross-process final-decision fencing, terminal revocation state and cancellation. No atomic SQLite/socket claim. | Owner-facing wording must disclose the release race and already-delivered-data limit. |
| Undo and retry | Grants excluded from layout/checkpoints, plugin config and generic command receipts. Retries cannot replay private bodies or reactivate old authority. | No automatic retry with renewed consent. |
| Restore/restart | Administrative restore enters broker-disabled quarantine, zero active grants and a fresh epoch. Without independent anti-rollback proof, each authority-broker startup invalidates grants/channels conservatively. | Approve loss of grant continuity on restart; seamless continuity requires a separately reviewed external authority. |
| Audit | Private metadata-only decision ledger, bounded denials, no observation-body persistence. | Audit access, count/time retention limits and deletion policy must be approved before enablement. |
| Egress | Private plugin/model delivery stays closed. No private data in events, tool feeds, postMessage bridges, model tools or public bundles. | Any later recipient requires a separate decision, explicit consent and independently tested egress controls. |

Accepted architecture is a restriction on future implementation, not authorization
to exercise owner resources. Pending policies and strict prerequisites below block
enablement; approving numeric limits alone does not open the gate.

## Strict prerequisites

1. **Real, side-effect-free identity.** A trusted adapter resolves an existing shell
   without calling `spawn` or any create/attach operation. Verify workspace binding
   and exact tmux server/session/pane incarnation using provider-controlled identity;
   a name, PID or creation timestamp alone is insufficient against reuse. Recheck
   identity across capture and before release, including server restart and target
   replacement during capture. If this cannot be proved with the adapter, deny.
    Missing, ambiguous, foreign or unknown providers are unavailable, never created
    to make a read succeed. Layout moves do not change a verified incarnation;
    restoring/copying/retyping a placement cannot restore its authority.
    `tests/resource-identity.test.mjs` probes tmux `session_id`, `pane_id`,
    `session_created` and server PID on an isolated socket. Counters reset after
    server restart; process IDs and second-resolution times can recur. These are
    useful diagnostics, **not** a hard ABA-proof incarnation key. The future
    provider must issue/register an unpredictable binding token and a server
    lifetime epoch, verify both at side-effect-free lookup, and invalidate them
    on target loss/replacement and server restart. A legacy pane without such a
    trusted registration remains unavailable for grants until explicitly bound.
    A tmux command's exit status alone does not prove the selected target exists:
    validate a nonempty exact-name/session/pane result and deny malformed output.
2. **Owner consent and independent subject authentication.** Show exact target,
   recipient, operation, bounds, expiry and disclosure consequences in trusted UI.
   Authenticate owner/origin and bind consent to a server-issued UI session/channel;
   do not accept a client-supplied actor as identity. Each observation separately
   authenticates that subject and matches its grant. Controller credentials cannot
   create, use, extend or revoke an owner grant. No credentials in URLs or layout.
   This is not isolation from a compromised trusted UI or owner-token holder.
3. **Durable authority and writer discipline.** Introduce separately versioned
   authority records outside layout undo with an epoch, monotonic workspace
   generation, grant state and revocation tombstones. Every authority mutation and
   final release decision uses the same cross-process serialization domain. Cached
   grants, outbox notifications and process-local locks cannot authorize delivery.
   Overflow, unavailable store, lock timeout or ambiguous state denies release.
4. **Bounded capture and inert display.** Validate exact scope and strict sizes
   before provider work, bound subprocess output as well as response encoding,
   strip/neutralize terminal controls and render plain text without active links,
   HTML or escape execution. No clipboard integration, automatic download, browser
   persistence or server response cache. Secrets in terminal output are still
   secrets after sanitization. Treat all captured text as untrusted data.
5. **Recovery, clocks and migration proven.** Meet the following sections with
   disposable-runtime, actual asynchronous-provider and real-browser evidence.
   No live runtime or owner terminal is a test fixture.

## Cross-process revocation and final release

Use `(authority epoch, workspace generation)` as the fence, distinct from layout
revision and registered-plugin hold generation. A revoke transaction marks the
grant inactive, advances generation and records metadata. Every policy-changing
mutation advances generation; conservatively invalidate outstanding reads on any
generation mismatch, including changes to another grant in that workspace.

An observation follows this order:

1. Authenticate subject/channel; read current authority and exact provider binding.
   Allocate a short-lived request identity carrying epoch, generation, grant,
   subject, resource incarnation and deadline. Authorization is not release.
2. Capture asynchronously outside a database write transaction. Cancellation on
   revoke, expiry, disconnect or provider loss is best effort; a late completion
   must still be discarded. Cross-process notifications improve cancellation
   latency but are not the correctness mechanism.
3. With one bounded result buffered privately, enter a short immediate authority
   transaction. Recheck current epoch/generation, active grant, subject/channel,
   incarnation, expiry/deadline and limits. Persist a metadata-only, single-use
   **release decision** if valid. Commit is the linearization point relative to a
   revoke commit. Do not hold this transaction across tmux work or socket I/O.
4. Only the same live request may attempt one bounded response handoff. No delayed
   work queue, streaming/chunks, durable send job or reusable release ticket. Drop
   on channel/deadline failure. A transport error does not permit body replay.

If revoke commits first, the final decision denies and discards the buffer, even
when capture started earlier in another process. If the release decision commits
first, that request is ordered before revoke and may still hand bytes to the
transport after revoke commits. A last-moment cancellation check can reduce this
window but cannot eliminate it across processes. There is **no atomic transaction
between SQLite and a socket write**, and no promise that revoke returning means
all previously authorized bytes have stopped arriving. Already handed-off or
received bytes cannot be reclaimed. If a stricter physical no-send-after-revoke
guarantee is required, this design is insufficient and must be replaced before
enablement, not relabeled as atomic.

Distinguish authorization, capture completion, release decision, release attempt
and recipient acknowledgement. A process crash between commit and send leaves a
decision with unknown delivery; never infer receipt or resend the snapshot from
it. Acknowledgement proves at most receipt by that channel, not rendering, erasure
or lack of further disclosure. First-gate responses are single buffered messages;
transport fragmentation does not introduce independently authorized chunks.

## Receipts, audit and recovery hold

Grant-command idempotency may retain metadata keyed by authenticated subject,
workspace and operation identity with a canonical request hash. Reuse with changed
intent fails. An exact retry must reauthenticate and check current epoch,
generation, grant state and expiry before reporting current authority. A stale
create receipt must never regrant or return a historically active grant as active;
report an explicit stale/no-current-authority outcome. Repeated revoke can report
already inactive without minting authority. Observation retries are new checks
and captures; there is no replayable private response in generic receipts.

The private audit ledger contains opaque request/resource/subject/grant identifiers,
epoch/generation, operation, fixed decision/error categories, timestamps and bounded
byte/line counts. Never include output, terminal names/titles, URLs, selectors,
credentials, raw provider errors, prompts or free-form owner intent. Keep these
out of generic receipts, workspace outbox/events, exports and diagnostic logs.
Denials need a separately bounded flood-resistant path rather than an insert that
rolls back with a rejected operation. Audit write failure blocks new releases;
revocation must not be prevented by denial-log saturation. No server-side body
retention is admitted; transient buffers are discarded after use, without claiming
secure erasure from process memory.

Registered-plugin recovery hold remains independent. Hold release, checkpoint
restore, sync and plugin activation cannot mint grants; a resource grant cannot
bypass hold. Neither hold nor this read-only gate terminates shells, cached frames
or external services. See [ADR 005](005-registered-plugin-recovery-hold.md).

## Time, startup and backup rollback

Persist wall-clock creation/expiry for inspection, with an immutable maximum
lifetime. Within a running authority-broker lifetime enforce both wall expiry and
a monotonic elapsed-time deadline; whichever expires first wins. A backward wall
jump must not extend an existing grant, and a forward jump may expire it early.
Detected rollback/discontinuity or inability to establish time safely fails closed.
Process-local monotonic values are not transferable across processes or restarts:
use a single lifetime-owning authority broker for timing/release, or prove a common
boot-scoped monotonic clock for all participating processes. Reconstructing a fresh
TTL from rolled-back wall time is forbidden. Suspend/resume behavior must be tested;
an unaccounted interval invalidates authority before further release.

An old backup contains old grants **and** old generations/tombstones. A generation
or epoch stored only in that backup is not an independent freshness proof. Current
restore validation checks structural validity, not that a later revoke occurred.

- Future administrative restore must stage a broker-disabled quarantine, invalidate
  all grants and grant-command receipts/channels, retain only historical metadata,
  and establish a fresh unpredictable authority epoch before publication. There
  must be **zero active grants**, including if the restore/startup crashes. Owner
  review exits quarantine but does not reactivate any grant; fresh exact-resource
  consent and provider resolution are required.
- Directly copying an old valid database can bypass a restore helper. Without an
  independent trusted anti-rollback authority, this is indistinguishable from an
  ordinary startup using only database contents; file paths, mtimes and a marker
  inside the copied runtime do not solve it. Therefore the recommended first slice
  invalidates all grants and rotates epoch on **every authority-broker startup**,
  before serving observations, including ordinary restart. This deliberately
  sacrifices grant continuity and never clears the separate recovery hold.
- Startup invalidation must be coordinated across processes: an exclusive broker
  lifetime/ownership fence controls epoch initialization and all release decisions.
  Workers join that lifetime; takeover fences the old broker and rotates epoch.
  If exclusive ownership cannot be established, disable the broker. Independent
  servers may not each trust cached startup state or resume old release decisions.
  Raw replacement beneath live database connections is unsupported; all writers
  must stop. Same-UID hostile copying/tampering is outside the sandbox guarantee.
- Seamless grant survival requires a separately reviewed anti-rollback service or
  high-water record that is not restored with the database/runtime, including its
  own disaster-recovery rules. No such service is assumed here.

## Migration and rollback prerequisites

A future schema migration starts with zero active grants and a new authority epoch,
retains layout/checkpoints and historical receipts, and never interprets existing
controller capabilities as grants. Stop **all** writers before migration with a
session-preservation plan; newer-schema rejection on open does not fence an
already-running older writer. Prove exclusive cutover operationally, and require
future authority writers to check schema/epoch inside their transactions. No mixed
older/newer writer rollout. Do not allocate a schema number in this design ADR.

Test interrupted migration, restart, newer-schema refusal and restore publication
failures. Backups remain private security-state artifacts, not safe authority undo.
Legacy export must refuse authority-bearing use or produce explicitly grant-free
offline data that can only start quarantined. Rollback first disables the broker
and invalidates grants/channels; a schema downgrade must not recover old authority.
Existing backup helpers do not yet implement these requirements. No service stop,
migration, rebuild or deployment is authorized by this document.

## Acceptance matrix — required future evidence

| Scenario | Required outcome/evidence |
| --- | --- |
| No grant; wrong subject/channel/workspace/operation/resource/incarnation | No bytes and no provider capture; bounded generic denial without resource enumeration. Test controller credentials and forged grant/actor IDs. |
| Consent and expiry | Real trusted owner UI shows exact scope/destination/bounds; explicit consent only. Defaults, cap rejection, boundary expiry and no silent renewal tested. |
| Missing/reused tmux target | No implicit shell creation. Real isolated tmux tests replace session/pane/server during capture; old incarnation never receives a release decision. |
| Placement/lifecycle | Move/split preserves only verified identity; close/detach follows approved policy. Copy/restore/recreate, plugin update/enable and old sync confer no authority. |
| Two-process revoke races | Separate SQLite connections/processes race queued, in-capture and buffered reads against revoke. Revoke-first denies; decision-first has the documented transport window. Pause the sender after commit to prove the limit explicitly. |
| Cancellation and bounds | Actual asynchronous capture times out, exceeds limits, disconnects and completes after cancellation; late results discarded. No streaming, partial oversize response or retry-body replay. |
| Crash at decision/send/ack | Metadata distinguishes committed decision from attempted/acknowledged delivery; ambiguous results are not resent, and restart invalidates all outstanding work. |
| Stale receipt and layout undo | Pre-revoke/pre-expiry/pre-epoch grant receipt cannot restore authority; changed request hash conflicts. Generic receipts and checkpoints contain no grant/body; hold remains independent. |
| Clock and process lifecycle | Backward/forward wall jumps, suspension, restart and competing broker takeover cannot extend grants or revive pending reads; inaccessible clock/store denies. |
| Backup and copied database | Backup before revoke, revoke, restore via helper and separately copy the older DB to a stopped runtime. Both start grant-free with new epoch; structural validity is not mistaken for freshness. |
| Multi-process startup/migration | Exclusive lifetime and cutover tested; old workers fenced, already-open older writers stopped. Crash/retry migration creates no grants; unsupported newer schema refuses. |
| Audit and disclosure | Inspect SQLite receipts/outbox/audit, logs, exports, response caches and browser storage with synthetic secret markers; no body/secret retention. Denial flood remains bounded and does not block revocation. |
| Owner view and egress | Isolated real browser proves inert rendering, subject/channel checks and revoke UX. No bytes reach plugins, tool feeds, Hermes/model calls or public assets; current network-capable plugin CSP is not represented as egress isolation. |

Use disposable runtime/provider fixtures and a separate browser workspace. Existing
[receipt](../../tests/workspace-receipts.test.mjs),
[contention](../../tests/sqlite-contention.test.mjs),
[backup safety](../../tests/sqlite-backup-safety.test.mjs),
[migration](../../tests/sqlite-migration.test.mjs) and
[recovery storage](../../tests/recovery-policy-storage.test.mjs) tests provide
patterns, not proof of the new gate. Executable implementation requires
`npm run check`, relevant publisher tests and isolated real-browser checks. This
design-only ADR introduces no API or runtime behavior and claims none of those
future acceptance cases passed.
