# Usability and agent-agency evolution

This development round builds on the usability/technology candidate at
`efc8c221bb8721205b6e53111695a4fca645a48c`. Package metadata remains 0.3.1.
Implementation, deployment and owner acceptance are separate milestones.

## Goal

Make existing tools work together with fewer manual transfers, preserve unfinished
work during ordinary navigation, and let Hermes complete explicitly delegated
resource tasks through truthful, recoverable capabilities.

The reference task is: **use selected sources to create a cited, saved, editable
brief and open it beside the conversation**. Opening a tool window, inserting a
draft and submitting a model request are different actions. A successful workflow
must identify which actions actually completed.

## Workstreams

| Workstream | Intended outcome |
| --- | --- |
| Navigation and continuity | Predictable keyboard discovery, preserved workspace mode, acknowledged conversation selection and clearer saved-layout naming |
| Evidence handoffs | Citations and selected data values in the actual draft, one exact insertion review, explicit interactive-result delivery |
| Documents | Reachable recovery after closing a dirty pane, reviewed imports and revision-bound collaborative editing |
| Scoped agency | Accurate capability discovery and authenticated selected-resource search/read/create authority |
| Durable workflows | Sustained arrangement history, interrupted-work reconciliation and reconnectable pending/review state |

Feature guides describe the implemented contracts. This page records the common
goals and acceptance method; an intended outcome is not a claim that a deployed
Hermes profile supports it.

## Outcome-oriented acceptance

Use disposable workspaces with synthetic data. Check authoritative saved state
and unaffected work, not just final assistant prose or a sequence of tool calls.

| Owner task | Required evidence |
| --- | --- |
| Navigate Start past an unavailable action | Keyboard focus reaches enabled actions, Enter executes an actionable result, Escape remains available |
| Open a built-in tool from Spatial | Chosen view remains Spatial; existing pane identities survive |
| Share an exact source passage | The actual recipient draft contains the passage and full source/hash/range citation; no message is sent |
| Explain selected query results | Shared rows/columns contain real bounded values with provenance and preserved numeric precision |
| Recover a closed dirty document | Reopen through the library and recover exact content from the original pane without conflating divergent drafts |
| Switch conversation during linking | The selection succeeds visibly or retains an actionable failure; cancellation prevents a later surprise switch |
| Open an interactive assistant result | A complete valid result reaches its intended pane, edits persist, and duplicate delivery does not overwrite unrelated results |
| Discover useful capabilities | Readiness and effective authority match the runtime; unavailable reasons are actionable; private contents do not leak through metadata |
| Delegate selected sources | Repeated permitted reads need one delegation; unselected sources and revoked/changed recipients cannot be read |
| Save a cited brief | The intended document exists with correct content and revision; save and browser acknowledgement are reported separately |
| Review a proposed document edit | Concurrent owner edits invalidate the old proposal; accepted edits can be undone and saved explicitly |
| Continue sustained Workbench use | New previews and revision-valid Return remain possible after retained history grows; original exact retry identities remain valid |
| Recover interrupted work | Proven effects finalize without duplicate execution; unprovable effects remain explicitly unknown |

Measure manual transfers, navigation actions, correction turns and elapsed time
separately from correctness. Establish a baseline before claiming numerical gains.
Record source/build identity, fixture configuration and optional engine assets.
Inspect synthetic screenshots before claiming visual acceptance.

Deterministic engine/browser tests establish integration behavior. Separately
authorized real-Hermes trials are needed to measure autonomous tool selection and
task completion; a synthetic gateway is not evidence of model capability. Keep
expensive coverage path-scoped, with weekly/manual deep runs, and preserve the
distinction between optional missing-engine skips and executed tests.

## Design references

Research consulted the following primary sources in October 2026:

- [Microsoft HAX guidelines](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/): understandable capabilities and efficient correction.
- [W3C keyboard interface practices](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/): predictable focus and deliberate handling of disabled items.
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): discoverable schemas, structured results and actionable errors.
- [AWS idempotent API guidance](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/): operation identity, equivalent retries and defined retention semantics.
- [Lexical editor state](https://lexical.dev/docs/concepts/editor-state): canonical snapshots and update boundaries.
- [Agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): distinguish trials, traces and verifiable outcomes.

These inform incremental changes to Orbit's existing runtime and surfaces. They
do not establish automatic protocol interoperability or installed-version support.
