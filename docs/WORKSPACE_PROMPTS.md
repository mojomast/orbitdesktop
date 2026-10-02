# Workspace prompts and feature workflows

These examples describe the implemented development candidate, not a new published
release. Copy a prompt into Hermes and adapt its goal. Prompts are editable drafts;
they do nothing until you send them. The workspace-aware runtime receives
[AGENT_GUIDE.md](AGENT_GUIDE.md); its scoped controller can arrange/open panes, but
private feature actions still use the owner UI or documented trusted adapters.

## Discover, arrange and recover

> Inspect this workspace and suggest which existing Orbit tools fit my research
> task. Reuse the built-in tools where possible. Tell me which need configuration
> before making changes.

Start and the command palette show shared prerequisite observations and supported
formats, refreshed on discovery/connection. Configured assets remain unverified
until use; microphone permissions, browser launch and inference are checked only
when the corresponding action is requested. Metadata alone grants no resource access.

> Put my existing terminal beside this conversation and the document library.
> Preserve pane IDs, running shells and other windows. Preview the layout change,
> checkpoint it, and verify browser acknowledgement. Distinguish saved state from
> a visually inspected result.

Use **Arrange workspace** for Grid/Focus/Compare. **Saved workspace layouts** saves
geometry and placement; preview before applying and explicitly map missing windows.
**Browser layout snapshots** auto-update locally and are separate from host Saved
layouts and Workbench role recipes. Opening a built-in tool preserves Spatial view.
**Workspace checkpoints** compares before restoring the full checkpoint; it does
not undo file edits, messages or processes.

Guides: [Usability](WORKSPACE_USABILITY.md), [Saved layouts](SAVED_WORKSPACE_LAYOUTS.md),
[Checkpoints](CHECKPOINTS.md), [Themes](THEMES.md).

## Conversations, outputs and context

> Help me find the conversation titled “Release research” using Conversation
> library. Explain how I can pin it and resume it without discarding my current
> draft or interrupting an active run.

> Open Outputs beside chat so I can find and pin the published report. Help me
> preview a reference for this conversation's draft; leave submission to me.

Library search matches loaded titles/IDs, with explicit bounded older-page search,
not full transcripts. The chooser stays open until selection succeeds; pending
initial linking can be cancelled. Rename/pin/archive
are Orbit metadata, not changes to Hermes's saved sessions. Drafts are host-backed
per workspace/profile/session with tab recovery and conflict handling. Explicit
context insertion chooses one conversation and never submits a turn. Chat reuses
message DOM incrementally; supported live updates depend on the gateway.

Guides: [Conversations](CONVERSATION_LIBRARY.md), [Outputs](OUTPUT_LIBRARY.md),
[Context handoff](CONTEXT_HANDOFF.md), [Hermes](HERMES.md).

## Search and cited research

> Open Knowledge search beside our conversation. I will import the source files
> I want searched. Help me search for deployment constraints and insert an exact
> cited passage into my chosen draft for review.

Import explicit text/excerpts or UTF-8 files. Keyword search needs no model;
semantic search needs the provisioned MiniLM assets. Citations bind exact snapshot
bytes and text ranges and are included in the actual draft text. The single review
shows the existing draft plus the excerpt and exact citation. Importing one file
does not authorize directory or transcript crawling. Selected-resource delegation
has its own authenticated channel and explicit scope; see
[Resource delegation](RESOURCE_DELEGATION.md) for supported recipient types.
Guide: [Knowledge search](KNOWLEDGE_SEARCH.md).

> Use the sources I delegated to this conversation's next run to write a cited
> project brief. Read only that scope, create a new saved editable document, and
> open its returned URI beside chat. Distinguish saved content from browser
> acknowledgement; preserve my other documents and panes.

This requires the configured pinned local Normal resource adapter. Select the
actual linked conversation and grant sources before sending the request. Repeated
reads within that run need no repeated dialogs; another turn needs a new grant.
If the channel is unavailable, use explicit cited draft handoffs instead.

## Interactive result cards

> Open Interactive results and help me use Load editable comparison. I want to
> compare three options, edit the decision notes, save and pin the result, then
> review a summary in a selected conversation draft.

The synthetic example needs no model. Real imports use A2UI v0.9 JSON/NDJSON;
plain prose is not automatically converted into a card. If asking Hermes to
produce a card, include the [producer contract](INTERACTIVE_RESULTS.md). A complete
authenticated reply in the supported envelope offers **Open interactive result**;
choose an already-open results pane, review the queued entry, then save explicitly.
Plain prose is not a card, and importing does not approve execution.

## Voice transcription

> Open Voice transcript. Help me check whether the local model is available,
> record a short clip, edit the transcript and insert it into this conversation's
> draft. I will review it before sending.

Microphone capture is explicit and requires browser permission/secure context;
audio-file input is also available. Moonshine assets are provisioned separately,
with no automatic remote inference fallback. This is transcription, not voice
generation. Guide: [Voice dictation](VOICE_DICTATION.md).

## Local data analysis

> Open the Asteria Mission Control simulator. Add the two reliability upgrades,
> then cut the original equipment budget by 15%. Show how the actual cost,
> reliability and constraint checks change, and export the current decision brief.

The [Asteria simulator](ASTERIA_MISSION_CONTROL.md) is a separately published
synthetic example with local deterministic calculations and a shared scenario
model. Its controls recalculate results directly. Exports are downloads; its
in-page state and outputs are distinct from private Orbit documents and grants.

> Publish the synthetic CSV you just authored and open it in Data workbench for me
> using its exact SHA-256. Use a new pane if an existing analysis might be lost.
> Check layout acknowledgement and distinguish it from verified input loading.

The supported pinned-publication route downloads an already-public, same-origin
CSV (up to 5 MiB), verifies its hash and loads `input_1` in the built-in workbench.
It needs no file picker or OpenCode Desktop connection. It runs no SQL and sends
no message; use **Run SELECT** after reviewing the query. Restoring this route
reloads its exact public input. See [Data Lab](DATA_LAB.md) for the URI contract.

> Open Data workbench for the CSV files I will choose. Once I provide the displayed
> table and column names, help write a SELECT that totals revenue by month. Help me
> save the recipe and export the bounded result.

> I will share the Data workbench schema and selected result rows into this draft.
> Explain the actual values, preserve their numeric precision, and propose another
> bounded SELECT using the exact input fingerprint. Leave running it to me.

Data stays in the browser engine; choosing files does not attach them to Hermes.
Use the actual assigned `input_1`, `input_2`, … names. Saved recipes bind exact file
hashes and table identities, not file bytes; reselect inputs when reopening.
**Ask about schema** shares table/column/type metadata without sample rows.
Selected-result sharing includes actual values, input/result identities and explicit
omission bounds. A reviewed SQL proposal fills the editor without running it.
JSON/Parquet require pinned local extensions. Guide: [Data Lab](DATA_LAB.md).

## Rich documents and whiteboards

> Open Document library so I can create a rich-text project brief and a canvas
> whiteboard. Keep both beside chat. Explain explicit saving, draft recovery and
> export before I close them.

Create through the library; do not invent document UUIDs. Lexical supports rich
text; Excalidraw supports shapes, text and drawing. Save explicitly, resolve stale
revisions without discarding edits, and retry the exact save after an uncertain
response. Private document bytes are not workspace-checkpoint contents.
Dirty-close review can save, keep editing or retain a same-tab recoverable draft;
Document library lists retained drafts from closed panes. Create from supported
text/Markdown/editor-state imports after review. A supported complete document
result can create a retained editable draft, but its imported body still needs Save.

> Using the document excerpt I shared, propose a revised brief in the documented
> whole-document format bound to its saved revision and draft digest. I will review
> and apply it, try Undo, and explicitly save the version I want to keep.

Revision/digest-bound proposal review refuses concurrent edits rather than merging
silently. Native Undo is editor-local, not a persistent historical version archive.
Guides: [Documents](DOCUMENTS.md), [Canvas](CANVAS.md).

## Run timing

> Open Run traces and help me interpret a run's observed timing. Separate events
> Orbit observed from authoritative completion/check evidence, and explain what
> the explicit trace export includes.

Traces are a redacted local projection, not a transcript, hidden reasoning,
provider-cost report or proof of unobserved work. Guide: [Run traces](RUN_TRACES.md).
**Share diagnostic summary** previews redacted aggregate observations in a selected
draft, with gap/open-state and timing caveats; it never sends automatically.

## Optional browser and MCP Apps

> Check whether Browser copilot is configured and open its surface. Help me stage
> a navigation to an allowed site, inspect the snapshot and review the next action
> before I execute it.

The context is disposable and signed out. Operator rules control exact origins,
wildcard subdomains and explicit local access; opening the panel grants no extra
network access. WebSockets, uploads, downloads and password entry are blocked.
It is distinct from Shared Chromium. Guide: [Browser Copilot](BROWSER_COPILOT.md).
Selected observation sharing includes exact captured provenance and labels page
text as untrusted historical evidence. A finite action suggestion can populate
controls; the existing fresh Preview and Execute-once checks still decide action.

> Open MCP Apps if configured. Help me prepare a self-contained report snapshot
> using Orbit's documented import envelope, then I will import and open it and
> check its local controls.

MCP Apps needs the server gate and separate sandbox origin. Imports are snapshots
with closed capabilities, not arbitrary MCP server connections or tool execution.
The application must bundle its SDK and assets inline; network dependencies are
blocked. Guide: [MCP Apps](MCP_APPS.md).
Compatible complete-result snapshot envelopes can stage into an empty mounted MCP
import editor. Import and Open are separate; staging does not fetch `ui://` resources.

## Custom widgets and experimental Workbench

> Build a self-contained focus timer with typed duration settings. Publish and
> test the content-addressed plugin, then add two independent instances without
> replacing my windows. Configure each separately and preserve the prior bundle.

Prefer supported instance/configuration operations over duplicate source copies.
Generated frames do not gain a host API bridge.
Guides: [Plugins](PLUGINS.md), [Widget configuration](WIDGET_CONFIGURATION.md).

> Help me prepare a Workbench task brief for this project, with clear acceptance
> criteria and a stopping point. Propose setup for my review; preparation is not
> approval to execute.

> Save this prepared task for later review while the execution lane is busy.
> When I return, show its current task status, checks and review state. Keep
> starting work separate from saving the waiting intention.

Setup offers **Save for later review**, status, cancellation and fresh review.
The existing Workbench task chooser includes a **Task status inbox** with exact
read acknowledgment and Live/Checks/Result links. Completion labels mean observed
runtime exit, not passing checks or human approval. A retained publication with a
complete verified journal can use **Finalize integration receipt** to settle its
metadata without rerunning work; unknown or tampered effects remain unresolved.

Workbench remains experimental and off by default in Orbit settings. Optional
gVisor runs only approved `node-test` checks on a separately provisioned compatible
host. A displayed capability is not approval; unavailable isolation cannot fall
back to trusted-host execution. Guides: [Setup](WORKBENCH_SETUP.md),
[Isolated checks](ISOLATED_CHECKS.md).
