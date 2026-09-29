# Agent pane information hierarchy

The agent pane separates **conversation and work**, **contextual activity**, and
**configuration/troubleshooting**. This is a presentation boundary; it does not
change execution authority or the meaning of a recorded outcome.

## Visibility budget

Workspace arrangements are a compact disclosure below the primary Changes review
surface and a host-owned card in the Project Inspector. Preview shows named
semantic changes; exact operations, revision, digest and viewport live in
Advanced details. Recipe editing, legacy role-order import and proposal history
are further disclosures. Apply saves an exact staged proposal; the UI then waits
for browser acknowledgement without calling that visual verification. Reloaded
pending save/apply identities are reconciled explicitly against durable records;
opening an arrangement never submits a model request or releases an execution
lane. See [arrangement contracts](WORKSPACE_ARRANGEMENTS_API.md).

Normal mode keeps the conversation title, one concise runtime status, the
Normal/Workbench switch, and an overflow control in its permanent header. The
composer has one primary Send control and compact secondary actions. Profile and
session binding, rename/color, notification preferences, workspace-agent overview,
healthy submission receipts belong in secondary surfaces.

Normal chat has a visible **Show tools / Hide tools** toggle below its header.
It restores the existing per-pane preference and exposes the retained tool view
inside the conversation, with bounded scrolling, observed call counts and expanded
arguments/results. **Load saved details** retrieves persisted conversation tools.
The overflow **Saved tools** shortcut opens this same view. Toggling visibility
does not submit a model request or change execution; mode changes retain its DOM.
Only the preference is stored locally, never tool payloads. Gateways without live
call IDs show separate observations rather than invented correlated executions.

The restored inline view is exercised by `tests/agent-pane-ux.browser.py` in both
renderers at four viewport sizes: live SSE observations, saved tool details,
hide/show, reload preference, retained mode-switch DOM and composer drafts. These
fixtures assert that inspection does not submit or approve model work.

Use **Agent pane menu → Conversation settings / Activity / Saved tools /
Troubleshooting**. The activity summary counts retained event observations, not
verified tool executions. An empty event history adds no conversation block.
Ordinary completed runs say **Ready**; raw lifecycle labels remain in
Troubleshooting. A settings-catalog failure marks the menu and retains its detail
in Settings without pretending that a running model failed.

Activity remains subscribed when its Inspector panel is closed. Closing a panel
does not cancel a run, clear a transcript, discard retained events, acknowledge an
unknown result, or release the shared execution lane. An offline activity stream
does not imply that execution has stopped. Successful completion returns to the
quiet Ready presentation; actual approvals and unknown outcomes remain actionable.

Workbench presents project/task names and the selected candidate generation before
technical identifiers. Exact task, attempt, grant, candidate and receipt identities
remain available in Details. Selection is not authorization: all execution and
handoff previews still use their existing server-validated records and immutable
context captures. The Changes and Review surfaces retain the same exact historical
diff component and independent recorder evidence.

Selecting live or retained job output is a view choice independent of whether
tail polling is active. Completion, pause or a read failure must not let a late
initial detail response replace that chosen output. Superseded read responses are
ignored; changing the view never reruns the job or changes its recorded verdict.

Use **Task settings** for project/task selection and the nested candidate,
attempt and result chooser. Exactly one explicitly selected option is a label;
an unselected option still requires a deliberate choice. **Exact scope and runtime
details** retains IDs, hashes and budgets. Authority controls live in **Checks**;
**Task handoff** retains immutable excerpt preview/capture. Changes keeps verified
patch and integration operations in a separate disclosure below the shared diff.
Explicit tab choices persist as visual preferences and suppress automatic tab
changes; they do not persist any running, approved or verified conclusion.

## Interaction boundaries

Secondary panels retain their existing DOM and behavior adapters. Moving a
configuration control does not alter its binding-change guards. Switching modes
does not copy drafts or start inference. Exceptional state cards are driven by
current authenticated state, not persisted visual preferences. Visual choices may
be persisted locally; runtime conclusions must be re-read.

Keyboard users can open the Inspector, select a panel and close it with Escape,
returning focus to the invoking control. On narrow panes, secondary information
uses a dedicated overlay rather than wrapping the permanent header into multiple
configuration rows. Conversation and Inspector have separate scroll regions.

## Verification

Acceptance includes both renderers, preserved authority/workflow regressions, and
visual inspection at desktop and narrow viewport sizes. Fixtures use disposable
workspaces and synthetic states; screenshots and private source stay outside Git.
DOM assertions alone are insufficient: header/composer height, visible message
area, exceptional-state prominence and code-review placement are reviewed visually.

The production-build visual fixture covers 56 combinations: seven states × two
renderers × 1326×947, 1000×800, 760×700 and 520×700. The states are Normal idle,
running, approval, Workbench running, Result review, exact diff, and unknown
execution. It uses intercepted synthetic authority responses, with deliberately
offline live-stream fallback in running examples, and never dispatches a model.
Twenty-four additional idle/accessibility cases cover Paper, XP and Classic.

Measured agent header height was 44 px; idle composer height was 82 px by default
and in Paper, 88 px in XP and 72 px in Classic. Conversation occupied 78–91% of
the pane body. These measurements exclude the surrounding desktop/window chrome.
The reconstructed before-state uses the archived `0a93350` source, not an original
owner screenshot. Private before/after images and machine-readable reports are
kept under `/tmp/opencode/orbit-agent-ux-qa`, outside Git.

Real-server regressions separately cover both-renderer mode independence,
immutable context and authority handoff, shared execution fences, historical diffs,
scope clearing, project revocation, result review/placement and reload. The
separate trusted Review window is covered there; the visual fixture's “review”
state represents Workbench Result, not that independent window.

Binding invalidation releases the superseded Workbench load's busy ownership
before launching its replacement. The accepted chat binding is installed first.
A deterministic delayed-import regression covers this reload interleaving: the
replacement must reconnect retained activity without a manual refresh or replaying
execution. Old asynchronous loads remain fenced by their epoch checks.
