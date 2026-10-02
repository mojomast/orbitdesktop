# Goal-first Workbench setup

Project Workbench is **experimental and off by default**. Enable it in Orbit
settings first: open the **orbit menu** (◉) → **Orbit settings** → **Project
Workbench**. That switch only reveals the Workbench controls; it does not
configure a worker, approve execution or send anything. Disabling it hides the
surface again without deleting stored tasks, candidates, results or drafts, and
each pane's earlier Normal/Workbench preference is restored when re-enabled.

The guided path turns a goal into a private task without asking the owner to
manually assemble task, candidate, attempt and context identifiers. The existing
manual Workbench controls remain in **Task settings**.

## Start from chat

Type the goal into Normal chat and choose **Set up task**. The unsent chat draft
stays in the composer. Opening setup does not send that message, create a task or
start a model. You can also select Workbench and describe the goal there.

An agent can suggest a work brief using `orbit_workspace` with
`action:"workbench_setup"`. Suggestions appear as **Agent suggestion — review
before setup**. **Adopt suggestion** copies one into an editable brief; the
suggestion is not owner consent or proof of which chat produced it. The tool is
workspace-scoped, not a forged pane identity.

Choose the intended registered project. **Register project** opens the existing
folder registration/preview flow if necessary. Under **Adjust plan**, refine the
title, success criteria and supported verification. The first guided profile
supports projects with discoverable Node tests. It does not invent a test command
or treat Orbit's host-regression suite as validation of arbitrary project code.

## Review, prepare, then start

**Review setup** saves a private binding-scoped draft and previews the exact
preparation. **Set up task** creates the task, private candidate, bound attempt and
goal context. It does not execute a model or run checks.

**Review start** then shows the actual worker scope and limits. **Start work**
explicitly approves that execution. Work proceeds through the existing native
Hermes lifecycle and the task's Live, Changes, Checks and Result views. The original
project is not modified by setup. Agent explanation, recorded test evidence,
human review and applying changes remain separate outcomes.

The starting work limits are editable. A launch uses the frozen reviewed limits,
not later edits. Preparing a task does not make an unconfigured worker available;
the server still enforces runtime availability, binding, project authority and
the shared execution lane.

## Recovery and privacy

The owner endpoint is `POST /api/workbench/setup`. It accepts only the closed
actions in `contracts/workbench-setup-v1.mjs`. Workspace capability holders cannot
use this owner route. The controller's proposal action accepts only a bounded
goal/brief, optional project/check references and an operation UUID; it cannot
read owner drafts or invoke preparation, approval or execution.

Drafts and reviewed identities are private runtime records, not workspace layout,
checkpoint, public app, or event-feed content. Full runtime backups must preserve
setup records together with the underlying Workbench data and private candidates.

On an unknown response, inspect saved state or explicitly retry the exact original
request. Do not generate another operation key to retry. Changed goals, project
identity, source, recipient or policy invalidate reviews. A known prepared task can
be resumed after reload; unresolved execution never gets silently launched again.

Candidate preparation now records an operation-owned directory identity before
copying, then flushes a private completion manifest outside the candidate tree.
An exact prepare retry after a crash verifies that manifest, the kernel directory
identity, every expected byte and absence of extra entries against the freshly
revalidated frozen source. A proven complete copy can finish the SQLite candidate,
task link and setup-step receipt atomically under the same identity. It does not
copy again or launch work. Backups must include sibling `*.setup.json` completion
manifests with the private candidate directories.

Missing, partial, tampered or legacy unjournaled copies still report
`prepare_unknown` / `setup_candidate_materialization_unknown`. Source, project,
binding or policy drift refuses promotion. Partial-copy discard/rebuild is not
implemented; unknown filesystem effects are never re-executed automatically.

### Durable review-only waiting intentions

The owner setup API adds `wait` (`draft_id`, `op_id`, `deadline`, `budget`) for a
prepared task, and `wait_cancel` (`intent_id`, `op_id`). Deadlines are at most 24
hours ahead. Waiting saves the exact task/candidate/attempt, binding, frozen
source/policy and requested budget before returning; the operation key is exact.
It grants **no execution authority**. The existing serial gate remains the only
execution lane. Cancellation changes only the waiting record, never a process.

`state.waiting_intents` gives durable insertion order and queue position. While
the lane is busy or quarantined, intentions stay `waiting_lane`; when it is free
they become `needs_review`. Drift also requires review with an explicit reason.
Deadline expiration becomes `expired`. The owner must still request a fresh
`launch_preview` and approve the existing exact launch; a reviewed waiting item is
marked `reviewed`. Queue order is informative, not an unattended dispatcher or an
authority to prevent an owner explicitly reviewing another task. Budgets must be
reviewed again in that native launch preview. Setup state includes journal byte
and per-record capacity diagnostics.

In guided setup, **Save for later review** saves the reviewed task's requested work
limits and a deadline from 1 to 1440 minutes. **Check saved state** refreshes the
waiting list; **Review waiting task** selects that saved task and requests a fresh
start review. **Cancel waiting intention** only cancels the saved intention.
Unknown save/cancel responses retain the exact request across page reload in the
browser session, with an explicit **Retry exact request** action. No reconnect
automatically retries a mutation. **Setup capacity** shows journal bytes and
remaining record slots. Expired and cancelled intentions remain visible as history.

## Scope and verification

This is the first bounded conversational setup path, not a generic workflow
builder. Discussion and non-code collaboration can remain in chat and project
notebooks. Advanced environments/checks retain their existing manual controls.

Focused service/route tests cover proposal authority, binding isolation, stale
reviews and recovery. `tests/workbench-setup.browser.py` exercises the real service
and native Hermes with a deterministic local provider under both renderers. This
does not establish paid-provider task quality. Source publication and live
deployment are separate; consult the milestone and deployment records for the
verified release rather than assuming the owner runtime has been upgraded.
