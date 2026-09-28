# Milestone: conversational, goal-first Workbench

Started 2026-09-28 from `b7ed08c`, following the owner-approved
[research](WORKBENCH_CONVERSATIONAL_UX_RESEARCH.md).

## Outcome

Describe a goal in chat, receive an editable setup suggestion, prepare a private
task from a semantic review, and explicitly start bounded work. The owner should
not assemble candidate, attempt and context identifiers to begin. Ordinary chat
remains available without creating a task.

## Parallel implementation plan

The three research passes are complete. Implementation uses separate ownership:

1. **Backend and recovery (Astra):** strict setup contracts, private durable
   suggestions/drafts/reviews, idempotent preparation, actual task/candidate/
   attempt/context creation, exact execution review and launch reconciliation.
2. **Goal-first interface (Sol):** goal/project input, editable brief, explicit
   setup and start actions, suggestion adoption, truthful status, reload recovery,
   selection integration with existing Workbench views and preserved chat drafts.
3. **Normal-agent proposal transport (Flash):** bounded `orbit_workspace`/CLI
   proposal action using existing workspace capability, with no execution,
   approval, private-read or owner-token authority.
4. **Lead integration:** route/service wiring, real-server browser acceptance,
   documentation, portable source parity, final regression checks and review.

Backend/frontend share a frozen `/api/workbench/setup` owner contract with
`state`, `draft`, `preview`, `prepare`, `launch_preview` and `launch` actions.
The controller can only propose untrusted workspace suggestions; the owner adopts
one into the current authenticated pane binding before any setup mutation.
Implementation may refine response details, but not weaken these boundaries.

## Delivery slices

- **Enter:** a visible “Set up task” action and “What are we working on?” empty
  state; choose a project only when necessary. Existing registration previews
  remain available through a clearly labelled action.
- **Prepare:** derive a title and initial success statement, select a meaningful
  supported check, show source/context/effects, then create a private task and its
  internal records. This action does not start a model or run checks.
- **Work:** review actual recipient, context, checks and limits; explicitly start
  the existing native worker. Reuse Live/Changes/Checks/Result for collaboration.
- **Recover:** exact keys and durable receipts prevent duplicate preparation or
  launch; stale reviews fail closed and unknown execution is not auto-replayed.

Two purposeful decisions (prepare the private task, then approve/start work) are
acceptable. A single vague “Continue” that silently authorizes every later effect
is not. No arbitrary command generation, implicit full-conversation disclosure,
automatic project choice, model-selected authority, or new paid-provider test is
part of this milestone.

## Acceptance gates

- Strict owner/controller separation; suggestions cannot create tasks or grants.
- Same-key retries, changed-payload conflict, partial failure/restart, stale
  source/binding/project/policy refusal and no duplicate worker dispatch.
- Private setup/context stays outside layouts, checkpoints, public assets and
  workspace metadata events.
- Real disposable server and browser journeys under both renderers: manual goal,
  agent proposal, editable review, preparation, uncertain-response recovery,
  reload, preserved composer, meaningful missing-prerequisite messages and a
  supported worker review/start path using a local synthetic provider where needed.
- `npm run check`, relevant Python controller/plugin tests, portable archive
  parity, `git diff --check`, and independent final review of authority/recovery.

Only intended changes will be committed/published. Deployment is a separate
release decision: the branch includes the not-yet-deployed schema-11 Studio
increment, while the last verified owner runtime is schema 10. A live rollout
requires the documented rehearsal, full stopped-writer backup and terminal
preservation procedure; development tests use isolated fixtures.

## Progress

- Research and scope: complete.
- Backend, frontend and proposal transport: implemented and integrated.
- Independent authority/recovery review: three reproduced findings fixed with
  regression coverage (late startup authority drift, native-preview loss on
  restart, and completed preparation replay after launch). Follow-up review also
  closed a stop-during-final-authorization race; its regression verifies zero
  spawns and zero input deliveries. Final focused review found no remaining
  blockers within this scope.
- `npm run check`: 778 tests, 770 passed, 0 failed, 8 optional integration skips;
  contract generation and isolated build passed. Log:
  `/tmp/opencode/orbit-goal-setup-check.log`.
- Focused final setup/native/result regression: 55 passed, 3 optional integration
  skips. Python plugin/controller tests and publisher tests passed.
- New goal-first browser journeys: passed on default and docking renderers using
  real services, private records and pinned Hermes with a local deterministic
  model. Coverage includes missing-project entry, composer transfer, edited
  success criteria, proposal-only transport, a discarded preparation response and
  exact retry, reload recovery, native execution and recorded passing evidence.
  Original fixture project bytes remain unchanged.
- Desktop and narrow decision screenshots inspected; narrow setup/control
  overflow assertions passed. Logs:
  `/tmp/opencode/orbit-setup-default-browser.log` and
  `/tmp/opencode/orbit-setup-docking-browser.log`.
- Portable source archive regenerated; bundle and portable endpoint tests passed.
- Existing agent-pane presentation/continuity regression: **56/56 passed** across
  both renderers, zero page errors and zero unhandled agent reads.
- Existing real-server Normal/Workbench mode journey: passed on both renderers.
  The test opens the retained manual handoff explicitly after the new guided
  entry, preserving its exact-excerpt/context assertions. No-task tabs are now
  asserted hidden, then visible once a task is selected.

## Delivery boundaries

The implementation is in the local integration checkout. No owner-runtime
activation or new paid-provider acceptance was performed. The guided profile is
limited to discoverable Node tests. Abrupt death during filesystem candidate
materialization before its SQLite receipt remains an explicit inspection-required
`prepare_unknown`, not an automatically replayed copy; see
[setup recovery](WORKBENCH_SETUP.md#recovery-and-privacy).
