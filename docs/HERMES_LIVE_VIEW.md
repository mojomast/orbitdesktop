# Hermes pane modes and private live activity

**Workbench mode supervises a separate restricted Hermes runtime. It does not
turn the ordinary conversation into the supervised worker.**

Normal Hermes retains its conversation, profile/session binding, composer,
queue, approvals and existing tools. Workbench uses an explicit task, candidate,
context snapshot and separately approved native grant. The pane provides two
views of those independent contexts. Selecting a view neither authorizes nor
starts execution, and does not merge worker messages into Normal ChatState.

## Separate Normal and Workbench windows

Use **Open Workbench window** beside the Normal composer to create an independent
Workbench window while keeping Normal chat open. The windows have distinct pane
and conversation identities; opening one copies no messages, draft, context,
candidate or grant and starts no inference. Repeating the action focuses the
paired window. **Open Normal chat window** in Workbench returns to the paired
Normal window, or creates a fresh one if it no longer exists.

The Start menu and Hermes menu also offer **New Workbench window**. Window layout
uses normal workspace persistence; mode and opaque pairing IDs are browser-local
preferences. The two windows still respect the shared execution lane, and context
handoff remains explicit. Existing in-pane mode controls remain available.

## What the timeline means

Candidate change details use the shared trusted [candidate diff review
surface](CANDIDATE_DIFF_REVIEW.md). Historical Live references retain their exact
generation transition; cumulative review explicitly compares against the initial
retained candidate generation. Rendered diffs and raw/copy conveniences are
observed changes, not recorder evidence or verified patch artifacts.

| Label | Meaning | Verification? |
| --- | --- | --- |
| AGENT | Public agent-reported status or explanation | No |
| OBSERVED | Host-observed lifecycle or tool metadata | Not by itself |
| RECORDER | Structured check or artifact-verification result | Only for the exact recorded identity and check contract |
| YOU | Recorded human action, such as approved authority | Authorization is still revalidated by the execution service |

An agent's literal final answer stays separate from the recorder summary.
A completed tool call is not proof that its output is correct. A stop request is
not termination confirmation. An unknown outcome never authorizes a replay.
No event grants permissions or changes candidate, review or acceptance state.

Live job output is a bounded private tail marked **unverified**. It is not parsed
into pass counts or precise progress. Structured final recorder results supply
test and required-file totals. Missing metrics, tokens and costs remain unknown.

The shared timeline offers category filters, safe-summary search, follow control,
compact/detailed density, completed-row collapse, failure/latest navigation and
reference details. Its visual preferences are local to the browser. Follow can
be paused; inspecting an older row must not scroll the reader back to the tail.

## Sources, persistence and reconnect

Normal activity adapts the existing authenticated Hermes event stream and saved
tool history. It does **not** claim upstream replay support: after an interruption,
the warning is “Events may be missed; exact replay unavailable.” Existing run
status polling and saved activity remain available.

Workbench reads use owner-authenticated `POST /api/workbench/live`. Actions are
`stream`, `page`, `detail` and `tail`; none dispatches execution. The fetch stream
uses SSE framing (`page`, `heartbeat`, `fenced`) with `Cache-Control: no-store`.
It requires the host/origin checks and owner bearer used by other private
Workbench routes. It is not an unauthenticated EventSource or plugin feed.

The private `workbench-live.sqlite` sidecar is a bounded observability projection,
not a second execution journal. Authoritative grants, tool calls, candidates,
jobs, evidence, results, reviews and patches remain in the workspace database.
Committed record observations acquire monotonically increasing sequence numbers;
the client resumes an exact project/attempt scope after its last cursor.
Disconnecting, reconnecting or changing pane modes never replays work.

Intermediate transitions are replayable only if observed and retained. Startup
reconciliation can recover current records as explicitly labelled snapshots; it
cannot reconstruct missing intermediate transitions. A truncated cursor resets
the visible retained history and refreshes current durable summary state.
Heartbeats and live output tails are live-only, not persisted timeline events.

The v1 presentation contract uses `kind` plus `status`, rather than pretending
that every suggested event name has a durable source:

| Record family | Projection | Authority |
| --- | --- | --- |
| `grant` | Approved, starting/running, stop requested, confirmed exit, unknown/finalization states; bounded counters | Human approval/stop request; host-observed lifecycle |
| `toolcall` | Requested/started and completed/failed native calls, safe target and exact mutation references | Agent request; host-observed completion |
| `candidate` | Recorded generation/hash and retained-version reference | Host-observed; source bytes loaded separately |
| `job` | Managed-check admission, process lifecycle, cancellation/unknown states | Host-observed, not verification |
| `evidence` | Exact structured recorder verdict and test/file totals | Recorder |
| `result` | Receipt availability/finalization metadata | Host-observed; explanation remains separately agent-authored |
| `review` | Recorded review decision | Human |
| `patch` | Preparation/verification/availability or failure | Observed lifecycle; recorder for verified artifact results |

These families are durable/replayable within retention. A context/consent preview
that has no durable record is not fabricated as a replayable event. Late snapshot
reconciliation is labelled as such. Partial projection history remains visibly
incomplete even while retained pages continue from a valid cursor.

Expanded live output uses a focused bounded `tail` read once per second while
the user has enabled it in the private job drawer. It pauses on demand and stops
on terminal status, drawer closure, scope change or pane disposal. This is a
live-only observation path; it does not refetch all tasks or persist stdout in
the projection. Event metadata itself uses the fetch stream.

## Privacy and references

Timeline rows contain whitelisted bounded metadata, not source files, full tool
arguments/results, terminal output, conversation excerpts, environment dumps,
provider payloads, prompts, hidden reasoning or credentials. Expanded details
are separate owner-authorized requests scoped to the selected durable IDs.
Private activity is never published to workspace metadata events, generated
plugins, sandboxed iframes or `/apps`.

Historical candidate details bind exact retained generation/hash identities.
A generation comparison reads and revalidates both versions; later edits cannot
substitute the current candidate. If either retained version is unavailable or
has drifted, the UI must report historical detail unavailable. Detailed source
comparisons are byte/file bounded and may be partial.

Conversation handoff is explicit owner-selected snapshot text. The preview shows
the task statement and selected excerpts before capture. Roles on selected text
are labels, not a host-authenticated claim that Hermes authored those bytes.
Snapshots retain hashes and exact bytes privately; editing the conversation
later does not update the snapshot. Capturing context is not worker consent.

## Recovery and shared lane

The existing single agent execution lane remains authoritative. A view change
does not free it, queue another mode's inference, or expand a grant. Hidden-mode
status remains visible, and drafts may be edited while immediate dispatch is
blocked. Finish/stop/revoke and result-finalization recovery are distinct actions.

Project revocation or generation drift fences private stream/detail reads.
Outcome-unknown quarantine stays in force until the existing explicit recovery
flow resolves it. Result persistence recovery is journal finalization, not another
worker run or check replay. Loss of the activity projection degrades presentation;
it must not change an authoritative operation's outcome.

Workbench remains **trusted-host execution**, not a filesystem or network
sandbox. The live view adds observability, not stronger execution isolation.

## Isolated real-provider observation (2026-09-27)

Release `orbit-live-96fede4` was packaged from
`96fede4cea54bde48ba1ce1748c62d5fbd52c76f` after both CI workflows passed:
[plugin gate](https://github.com/mojomast/orbitdesktop/actions/runs/36330034644)
and [Workbench gate](https://github.com/mojomast/orbitdesktop/actions/runs/36330034665).
The owner separately authorized one DeepSeek `deepseek-flash` attempt, limited
to 24 calls, 3 checks and 180 seconds, on a disposable RouteTok regression clone
with a private runtime, copied offline dependency cache and isolated browser.

The one grant completed in **108.837 seconds**, using **7 calls and 1 check**:
`inspect`, `read_context`, three `candidate_read` calls, `candidate_patch`, and
`job_start`. Only `src/net-address.ts` changed (candidate generation 2).
The recorder independently reported **293/293 passed**, **60/60 required files
covered**, zero skipped tests, and a `pass` verdict. The literal model explanation
incorrectly claimed 59 required files; it remains separate from recorder truth.
No measured provider token or cost totals were available.

The acceptance driver switched to Normal during the running grant and verified
the Normal DOM/session/draft continuity, but stopped on a misleading Workbench
badge: “1 pending · 1 result(s)” instead of explicit running status. Thus this
run is **successful task execution, but not a complete live-UI acceptance pass**.
The subsequent UI correction derives the badge from the selected grant, excludes
pending receipts from completed-result counts, and keeps conflicting Normal
dispatch blocked during an unresolved execution. Deterministic tests exercise
running, requested stop, unknown outcome and completion despite a stale idle lane
snapshot. These tests do not retroactively turn the real run into a UI pass.
No replacement model run was dispatched. Subsequent read-only browser inspection
confirmed durable event replay, visible 293/293 and 60/60 recorder totals, exact
generation comparison, an available unverified retained tail, separate result
presentation, and reload with one grant and unchanged call count. A continuously
observed running-output drawer and real-provider verified export were not
established by this run; those flows have separate deterministic coverage.

Private evidence and screenshots remain outside Git. Existing owner deployments
were not changed. The earlier consent-refused setup had zero grants and zero
worker starts; it did not consume the single real-model authorization.
