# Hermes pane activity

Normal Hermes keeps its conversation, profile/session binding, composer, queue,
approvals and existing tools. The Activity view is an observation surface; it
never authorizes work or starts execution on its own.

## What the timeline means

Normal chat exposes the timeline through **Agent pane menu → Activity**. Its
subscriptions and bounded retained rows continue while the Activity panel is
closed. See the [agent pane information hierarchy](AGENT_PANE_UX.md) for
settings, exceptional-state visibility and visual acceptance measurements.

| Label | Meaning | Verification? |
| --- | --- | --- |
| AGENT | Public agent-reported status or explanation | No |
| OBSERVED | Host-observed lifecycle or tool metadata | Not by itself |
| RECORDER | Structured check or artifact-verification result | Only for the exact recorded identity and check contract |
| YOU | Recorded human action, such as approved authority | Authorization is still revalidated by the execution service |

An agent's literal final answer stays separate from the recorder summary.
A completed tool call is not proof that its output is correct. A stop request is
not termination confirmation. An unknown outcome never authorizes a replay.

Live job output is a bounded private tail marked **unverified**. It is not parsed
into pass counts or precise progress. Structured recorder results supply test and
required-file totals. Missing metrics, tokens and costs remain unknown.

The shared timeline offers category filters, safe-summary search, follow control,
compact/detailed density, completed-row collapse, failure/latest navigation and
reference details. Its visual preferences are local to the browser. Follow can
be paused; inspecting an older row must not scroll the reader back to the tail.

## Sources, persistence and reconnect

Normal activity adapts the existing authenticated Hermes event stream and saved
tool history. It does **not** claim upstream replay support: after an interruption,
the warning is “Events may be missed; exact replay unavailable.” Existing run
status polling and saved activity remain available.

The fetch stream uses SSE framing (`page`, `heartbeat`, `fenced`) with
`Cache-Control: no-store`. It requires the host/origin checks and owner bearer
used by other private Orbit routes. It is not an unauthenticated EventSource or
plugin feed.

Disconnecting, reconnecting or reloading a pane never replays work. Intermediate
transitions are replayable only if observed and retained. Heartbeats and live
output tails are live-only, not persisted timeline events.

Expanded live output uses a focused bounded `tail` read once per second while
the user has enabled it in the private job drawer. It pauses on demand and stops
on terminal status, drawer closure, scope change or pane disposal. This is a
live-only observation path; it does not refetch all tasks or persist stdout.
Event metadata itself uses the fetch stream.

## Privacy and references

Timeline rows contain whitelisted bounded metadata, not source files, full tool
arguments/results, terminal output, conversation excerpts, environment dumps,
provider payloads, prompts, hidden reasoning or credentials. Expanded details
are separate owner-authorized requests scoped to the selected durable IDs.
Private activity is never published to workspace metadata events, generated
plugins, sandboxed iframes or `/apps`.

Conversation handoff is explicit owner-selected snapshot text. The preview shows
the task statement and selected excerpts before capture. Roles on selected text
are labels, not a host-authenticated claim that Hermes authored those bytes.
Snapshots retain hashes and exact bytes privately; editing the conversation
later does not update the snapshot.

## Recovery and shared lane

The existing single agent execution lane remains authoritative. A view change
does not free it, queue another mode's inference, or expand a grant. Hidden-mode
status remains visible, and drafts may be edited while immediate dispatch is
blocked. Outcome-unknown quarantine stays in force until the existing explicit
recovery flow resolves it. Loss of the activity projection degrades presentation;
it must not change an authoritative operation's outcome.
