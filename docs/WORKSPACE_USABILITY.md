# Workspace usability development round

This development work is based on `release/0.3.1`. It does not change the product
version, publish a release, or update an existing deployment automatically.

## Find and compose tools

The command palette and Start share a typed action registry. Search window names
or commands such as settings, themes, plugins, checkpoints and arrangement from
one entrypoint. Commands retain their experimental gates and report when a
prerequisite is missing.

Outputs and Workspace Activity can be opened as persistent host-owned browser
panes using the allowlisted `orbit://surface/outputs` and
`orbit://surface/activity` URLs. These are reviewed host modules, not a privileged
bridge for generated plugins. Their placement is saved with the workspace; live
contents are reloaded from their existing authorized sources.

## Local technology surfaces

The subsequent [technology feature round](TECHNOLOGY_FEATURES.md) adds normal
workspace surfaces for [source-backed search](KNOWLEDGE_SEARCH.md),
[interactive results](INTERACTIVE_RESULTS.md), [voice dictation](VOICE_DICTATION.md),
[data analysis](DATA_LAB.md), documents/whiteboards and [run traces](RUN_TRACES.md).
Optional [MCP Apps](MCP_APPS.md) and [browser copilot](BROWSER_COPILOT.md) require
their documented configuration. These integrations retain the same pane identities
and explicit draft handoff; private content is separate from layout checkpoints.

## Plugin editing

Configure and Window settings use typed forms with inline validation. Existing
string, number and boolean configuration values retain their types; advanced JSON
remains available. Added/changed fields use a partial patch; removing a config key
uses the existing full-config operation. Window edits send only changed settings.

This preserves the v1 primitive-map configuration format. The next feature round
adds optional finite author-declared field metadata; see
[Widget configuration](WIDGET_CONFIGURATION.md). Generated widgets still have no
private host storage. For an externally connected backend, the editor explains
that static-app config is not sent to the external service.

## Chat reading and copying

Normal chat retains unchanged message DOM and reading position across unrelated
updates. New output follows automatically only near the bottom; otherwise a
**New messages / Jump to latest** control appears. Copy controls are available for
whole messages and fenced code. Formatting is intentionally bounded to paragraphs,
code fences and safe links; generated HTML stays literal text.

History opens the conversation library over the existing Hermes profile/session
catalog. The next feature round adds host-backed drafts and private Orbit
names/pins/archive flags without duplicating transcripts. See
[Conversation library](CONVERSATION_LIBRARY.md) for identity, conflict handling
and close-time save limits.

## Default-workspace composition

The normal workspace arranger works on existing windows without registering a
Workbench project or enabling Project Workbench. It reads the current revision,
measures the desktop area and previews validated layout operations before applying
them. Window and pane identities are retained; it does not start terminal shells,
replace conversations or install widgets.

The owner-only `layout_preview` and `layout_apply` workspace commands accept a
restricted operation set: `arrange_windows`, `arrange_spatial`, `reorder_windows`,
`select`, `set_view`, and frame-only `update_window`. Other operations, including
creating/closing panes, plugin changes and whole-workspace replacement, are
rejected by the contract. These commands are not exposed on the controller or
independent recovery routes. Existing controller `preview`/`apply` semantics are
unchanged.

`layout_apply` uses the same revision/checkpoint/receipt boundary as other
workspace mutations. Retain the exact operation ID and payload after an uncertain
response; a new operation ID is not a retry. The exact apply envelope is retained
in this browser tab before dispatch, allowing an uncertain result to be retried
after closing/reopening the dialog or reloading the same tab. This is not
cross-device storage. An intervening workspace edit requires
a fresh preview. Structural/geometry previews do not render arbitrary iframe
content and are not evidence that a browser has displayed the committed result.

The default renderer supports Grid, Focus and Compare. Docking Grid/Compare now
use a dedicated compiler that commits geometry and Dockview placement atomically;
Docking Focus selects an existing window. Named layouts reuse the same placement
boundary; see [Saved workspace layouts](SAVED_WORKSPACE_LAYOUTS.md).

## Checkpoint comparison

Workspace checkpoints now show a bounded comparison before restore: changed
windows, panes, appearance fields, plugin settings and Docking placement. The
comparison does not expose config values or pane URLs. It is revision-bound and
read-only, and restore still checks the current revision, recovery hold, revoked
releases and bundle availability.

This is full-checkpoint restore, not selective undo. It does not restore
conversations, files, live processes or external effects. See [Checkpoints](CHECKPOINTS.md).

## Runtime efficiency

- Visible workspace state and event polls retain their 1.2-second cadence. Hidden
  pages back off to 15 seconds; returning to the foreground immediately refreshes
  authoritative state. Page hide/show suspension and polling fallback remain.
- Enumerated content-hashed build assets receive immutable cache headers. Entry
  HTML, API responses, unversioned resources and published `/apps` content retain
  their existing fresh-read policy. New build assets require a server restart to
  enter the immutable asset set; otherwise they remain uncached.

## Delivery verification

Workbench CI remains path-triggered, weekly, manually runnable and full on release
branches/tags. The scope detector now treats unreadable diffs conservatively,
recognizes the deferred entrypoint/fixture paths, and includes pull requests into
release branches. The default browser suites continue to run for normal changes.

Portable bundle verification checks both included-file bytes and reverse
completeness using the publisher's inclusion policy. Rebuild the source archive
after source/document changes; newly added source files must be tracked before
publication because the bundler intentionally includes tracked files only.

## Arrangement proposal retention

Project-bound Workbench arrangement previews now reclaim expired never-committed
records and, under capacity pressure, cancelled/stale never-committed records.
Committed replay identities and Return references are retained. The existing
200-record bound still blocks a project with 200 retained committed proposals;
solving that case needs a separate history/archive design. The new normal
workspace arranger uses ordinary workspace receipts, not this proposal table.
