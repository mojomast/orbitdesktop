# Hermes pane modes and private live activity

**Workbench mode supervises a separate restricted Hermes runtime. It does not
turn the ordinary conversation into the supervised worker.**

Normal Hermes retains its conversation, profile/session binding, composer,
queue, approvals and existing tools. Workbench uses an explicit task, candidate,
context snapshot and separately approved native grant. The pane provides two
views of those independent contexts. Selecting a view neither authorizes nor
starts execution, and does not merge worker messages into Normal ChatState.

## What the timeline means

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
