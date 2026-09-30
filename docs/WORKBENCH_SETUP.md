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

One preparation crash window deliberately stops for inspection: if the server dies
during candidate filesystem materialization before its SQLite step receipt
commits, setup reports `prepare_unknown` /
`setup_candidate_materialization_unknown`. It does not create another candidate or
guess that the partial directory belongs to a safe retry. Automatic cleanup and
resumption of that window are not implemented.

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
