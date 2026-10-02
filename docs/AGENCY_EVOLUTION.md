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

## Implemented cross-feature workflows

- **Discover and resume:** Start skips unavailable actions for keyboard execution;
  built-in tools preserve Spatial view. Conversation selection is acknowledged,
  initial-link waiting is cancellable, and older-title search is bounded and explicit.
- **Share exact evidence:** one recipient review includes the existing draft and
  exact inserted text. Knowledge keeps full citation/hash/range provenance; Data Lab
  shares selected values and numeric precision, with schema-only and SQL-proposal
  paths. Final source/draft/recipient changes refuse stale insertion.
- **Use complete results:** authenticated completed replies offer reviewed A2UI,
  document and self-contained MCP snapshot actions. Queues are ephemeral and
  mount-bound; creating a document draft is distinct from saving its imported body.
- **Recover and edit:** whole-window and split-pane closes honor dirty-document
  review. Original-pane drafts and journalled uncertain creations are recoverable
  through Document library after same-tab reload. Reviewed snapshot edits bind
  revision/digest, preserve concurrent changes and use native Undo.
- **Delegate useful content work:** the configured source-pinned local Normal
  adapter binds selected sources and finite create-new-brief authority to the next
  accepted run of an actual conversation. A dedicated-local fallback remains
  separate. Source bodies and saved document contents stay outside layout snapshots.
- **Recover durable work:** committed arrangements no longer consume active-preview
  capacity. Complete operation-owned candidate copies and retained publication
  manifests can settle without repeating side effects. Review-only waiting and
  authoritative current task state reuse the existing Workbench authority. Setup
  exposes waiting/review/cancel controls; the existing task chooser embeds the
  status inbox, capacity diagnostics and exact read acknowledgments, while the
  workflow surface offers retained-publication receipt finalization.

See [Resource delegation](RESOURCE_DELEGATION.md), [Documents](DOCUMENTS.md),
[Context handoff](CONTEXT_HANDOFF.md), [Interactive results](INTERACTIVE_RESULTS.md),
[Data Lab](DATA_LAB.md), [Workbench setup](WORKBENCH_SETUP.md) and
[Project Workbench](PROJECT_WORKBENCH.md) for precise controls and limits.

This increment does not add autonomous browser planning, arbitrary MCP resource
connections, recurring unattended dispatch, physical task/history garbage
collection, durable historical transition replay or cross-device unsaved editor
drafts. Browser and SQL suggestions stage existing owner controls. Model capability
acceptance and owner-workspace visual acceptance remain distinct from the isolated
engine/context tests below.

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
