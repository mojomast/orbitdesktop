# Goal-first Workbench: research and proposed interaction design

Date: 2026-09-28. Source baseline: `b7ed08c`.

**Status: research and design proposal, not implemented behavior.** The owner
requested parallel Flash research into easier Workbench entry, conversational
setup, and the wider agent experience. This document distinguishes existing
capabilities from proposed changes; it does not authorize runtime migration or
deployment.

## Product outcome

The owner can say what they want to accomplish, refine the agent's understanding,
and start a correctly scoped piece of work without assembling execution records.
The agent helps prepare the workspace; the interface explains the proposed work
and exposes the controls needed at the current step.

The central design rule is **goal first, setup second, execution explicitly
scoped**. Simple questions and small direct actions should remain simple. Not
every request needs a project, private worktree, worker, or review pipeline.

## Recommended user journey

1. **Describe the goal in ordinary chat.** Also expose a prominent “Work on a
   project…” entry point and an empty Workbench prompt: “What are we working on?”
   Both lead to the same setup experience rather than separate forms.
2. **Resolve only missing information.** Reuse an explicitly selected project and
   conversation. If the project is ambiguous, offer named choices; if no project
   is registered, ask the owner to choose a folder. Do not discover a project by
   scanning unrelated private runtime records. Ask about the desired outcome only
   if the request does not already establish it.
3. **Present an editable work brief.** Show the goal, project, proposed next step,
   relevant context to share, work scope, verification and stopping point. Mark
   inferred choices as suggestions. Explain the meaningful effects in ordinary
   language; keep IDs, generations and raw settings in Details.
4. **Start from that exact reviewed brief.** The primary action is either “Set up
   task” or “Start work,” depending on the effects actually covered by the review.
   Do not hide model execution inside an action labelled setup. Combine existing
   record-creation steps behind the interface, retaining retry/recovery semantics.
5. **Keep the goal and next action visible.** A task card links the originating
   conversation to work status, changes, checks and the result. The user can
   inspect tool activity, give guidance, stop supported work, or return later.
6. **Review the outcome.** Explain what changed, which checks ran, what remains,
   and the available next action. Applying changes to the original project stays
   distinct from preparing a private candidate or receiving an agent explanation.

Example proposed interaction:

> **Owner:** Help me make the dashboard work on mobile.
>
> **Agent:** Is this for the Website project you have selected?
>
> **Owner:** Yes. Keep the current desktop design.
>
> **Work brief:** Improve the Website dashboard on mobile while preserving the
> desktop design. First inspect the relevant layout, make a focused change in a
> private working copy, and run the relevant checks. Stop when the change is ready
> for review. Context: this goal and the selected project scope.
>
> **[Start work] [Adjust plan] [Keep discussing]**

If the project is already unambiguous, omit the extra question. “Keep discussing”
must remain usable without creating candidates or launching a worker.

## Findings from three independent Flash passes

Research lanes: (1) Workbench setup/API audit, (2) published HCI and agent-product
guidance, (3) chat/navigation/status coherence. The lead reviewed the critical
contracts and task-preview code, independently fetched the primary sources below,
and inspected existing **synthetic** first-use and narrow-viewport screenshots.
No owner workspace was accessed and no Orbit agent execution was started for this
research; the three Flash research sessions were the requested delegated work.

### The workflow exposes implementation objects too early

The first-use screenshot `/tmp/opencode/orbit-pane-workbench-default.png` shows
task, candidate, attempt and result selectors above a second authority panel,
before a goal has been established. Source corroborates the ordering:

| Finding | Evidence at baseline |
| --- | --- |
| Empty state asks for project/task, rather than a goal | `src/pane-workbench.ts:163–167` |
| The goal/excerpt handoff lives in a disclosure near the end | `src/pane-workbench.ts:292–344`, `898–965` |
| Task creation needs title, acceptance and an allowlisted check; pane binding is already derived | `src/pane-workbench.ts:1059–1078` |
| The pane's task preview is client-side JSON, not a persisted server proposal | `src/pane-workbench.ts:1081–1088` |
| Lost task-create responses require manual reconciliation; no operation key | `src/pane-workbench.ts:1094–1129`; `server/workbench-execution.mjs:110` |
| Owner task/candidate/attempt/check operations already exist separately | `server/workbench-execution.mjs:108–133` |
| Worker approval/start and bounded budgets already exist | `contracts/workbench-native-v1.mjs:10–18` |

The current setup spans project registration, task creation, private candidate
creation, attempt binding, context capture, acceptance/check configuration and
worker admission. These are dependency-linked operations, **not a claim that
every task must manually run every check before a worker can start**. Existing
check-only and worker paths must continue to work.

### Chat and Workbench are presented as equivalent modes, but play different roles

Normal chat contains the conversation; Workbench mode is a task/control surface
with selected chat excerpts and a task statement, not a second free-form model
composer (`src/pane-workbench.ts:898–959`). Native workers are separately scoped
executions. The same name also refers to a separate window and a full project
management dialog (`src/main.ts:1083–1115`; `src/pane-workbench.ts:140–154`).

`pairedPaneId` exists, but the relationship is not clearly communicated. The
“Task from draft” composer action and settings-hidden separate-window action
make it unclear which path is the normal way to begin (`src/agent-chat.ts:831–845`).
Recommend a stable **Chat + linked task** mental model. Initially improve labels,
entry and cross-links while retaining current navigation; defer removing the mode
switch until usability tests show the replacement is easier. Never merge worker
messages or imply shared model memory just because views are linked.

### The agent cannot yet deliver the desired setup experience through a supported contract

The existing draft handoff copies text; there is no typed, proposal-only chat tool
for turning a goal into a server-validated Workbench setup. Existing owner routes
are suitable for trusted UI orchestration, not for exposing the owner's token to
the model. This is a real product capability gap, not solvable solely with copy
changes or by telling Hermes to call the current owner endpoints.

Title and success criteria can be proposed from the goal; project display names
can be derived from an owner-chosen folder. Binding IDs are already host-derived.
Check selection must come from supported definitions and actual project support,
not blindly select the first check or invent shell commands. Current native
check tools admit `node-test` and `host-regression`
(`contracts/workbench-native-v1.mjs:32`). Non-code collaboration can remain in chat
and project notebooks; do not claim this executor supports arbitrary workflows.

### Cross-cutting usability gaps

- Use an inline connection action where the current empty state only directs the
  user to the top bar (`src/agent-chat.ts:718`, `732`).
- Explain why Send is blocked inline. Attribute another task only from authoritative
  ownership data; a busy pane in a client-side activity registry is not proof that
  it holds the execution lane (`src/agent-chat.ts:577–612`).
- Consolidate human-facing status vocabulary, while retaining distinct real states:
  Ready, Working, Needs you, Ready to review, Stopping, Stopped, Needs attention and
  Outcome unknown. Put connection health alongside, not in place of, execution state.
- Preserve the recently restored opt-in tool view and make effort legible. Tool
  event observations are not automatically exact call totals.
- The handoff statement is memory-only, and some browser draft writes swallow
  storage errors (`src/pane-workbench.ts:1230–1232`; `src/agent-chat.ts:21`, `63–64`).
  A resumable setup needs an explicit private persistence design and a visible
  save failure, not a silent promise that drafts survive closing the tab.

The source baseline includes restored inline tools; the last verified deployed
`a15d7eb` does not. This is a source/deployment distinction, not a recommendation
to roll out the intervening schema-11 changes as part of a UX research task.

## Implementation sequence

### 1. Make entry and the next action obvious

Build one goal-first empty state shared by the chat action and Workbench entry.
Use the current project when explicitly selected; otherwise offer active project
names and a folder-registration action. Show one work-brief card with editable
goal/success criteria and a recommended supported check. Hide candidate/attempt/
result selectors until there is something meaningful to select. Add a next-step
summary linked to the actual missing prerequisite, plus a visible route back to
the originating chat.

Reuse existing owner APIs and existing registration previews. This increment
reduces navigation and typing but must be labelled **guided setup**, not fully
conversational automation. It cannot truthfully promise a single transactional
start because several current operations lack persisted request identity.

### 2. Deliver conversational setup with reliable orchestration

Introduce a narrow proposal-only tool available to the originating chat. Suggested
fields: goal, success criteria, an authorized project reference or unresolved
project choice, relevant conversation references, and a supported work/check
profile. These are proposed contract concepts, not existing endpoints.

The trusted service binds workspace/pane/session and resolves authoritative IDs;
the model supplies neither owner credentials nor authority attestations. Render a
structured setup card from validated data, not commands parsed out of arbitrary
assistant prose. Use the current chat turn when possible instead of adding a
planning call to every message.

Before combining mutations behind one action:

- Add actor-scoped operation identity and receipt lookup to task creation; audit
  candidate/attempt creation and the other composed steps for equivalent recovery.
- Persist a bounded private setup draft and a frozen reviewed revision, bound to
  the originating conversation, project generation and relevant policy state.
- Implement orchestration as a resumable sequence of validated effects. A series
  of HTTP calls is not one atomic transaction. Report already-created artifacts
  honestly after a later failure; do not silently recreate or delete them.
- Group approvals only when the server binds them to the exact effects, context,
  recipient, checks and budget. Some later previews depend on newly created
  candidates, so one advance approval cannot simply substitute for every current
  digest-bound preview. Revalidate or request an amended review when scope changes.
- Keep human review and applying to the original tree distinct. Opening a view,
  accepting a draft suggestion or receiving a result never authorizes these steps.

This increment is the actual fulfillment of “tell the agent what we're trying
to do, and have it help set up the Workbench.” Do not stop at renaming the existing
draft-copy button and call the goal complete.

### 3. Make collaboration coherent across the app

Add a linked task chip/card, consistent navigation terms and an always-discoverable
next action. Align status language across chat, task view and agent overview. Keep
tool details optional but easy to open. Show a meaningful blocked reason and
supported recovery action without hiding unknown execution in a generic error.
Persist setup drafts privately and surface storage failures. Avoid forcing a
second window, a second conversation or a new task for each follow-up.

## Decisions after reviewing the research

- **Adopt:** ask only for missing facts, editable work brief, named next action,
  host-derived technical records, contextual controls and proportional execution.
- **Do not substitute another long wizard:** project, goal and success criteria
  interact; allow editing the brief in place without restarting a step sequence.
- **Do not default all reads to allowed:** private project/context disclosure is
  already an explicit Orbit boundary. Lower friction by composing reviewed effects.
- **Do not infer lane ownership from UI activity:** use an authenticated binding or
  say that another execution is busy without naming an unverified owner.
- **Do not persist raw project paths in generic browser preferences:** prefer
  registered project IDs/names; any new recent-folder feature needs private storage
  and revalidation of the chosen root.
- **Do not copy generic SaaS examples into Orbit's scope:** Slack, ticket systems,
  multi-user access and arbitrary external integrations are not implied here.
- **Do not collapse confirmed stop, requested stop and unknown outcome:** simpler
  copy must preserve what the service actually knows.

## Progressive disclosure rules

- Initial screen: goal input, project chip when known, one primary next action.
- Put settings next to the decision they affect. A worker model belongs in the
  work brief; a historical candidate selector belongs in version/history details.
- Derive record IDs, attempt bindings and labels from authenticated records and
  the reviewed task. Do not ask users to copy identifiers between controls.
- Show editable defaults, not silently assumed consent. Discovery and authority
  are separate: knowing a folder or selecting a pane is not permission to read it.
- Preserve explicit historical selections. “Latest” is a convenience only when
  it does not replace the version being reviewed.
- Empty states explain what the user can do now. Missing prerequisites should
  point to a specific remedy instead of displaying a large inactive control panel.
- Keep conversation drafts and scroll positions when opening task details. A mode
  switch alone must not start work, transfer context, or change the selected agent.

## Keep work proportional

The setup assistant should recommend the lightest existing path that satisfies
the request: answer/discuss, a targeted workspace action, or a bounded Workbench
task. It should not add a separate planning-model call to every ordinary message.

The work brief should include a concrete stopping condition and reuse the existing
execution-budget controls. Display observed effort while work proceeds: elapsed
time, tool observations, changed files and recorded checks where available.
Distinguish actual runtime counters from incomplete event observations; unavailable
usage/cost stays unavailable. Expanding scope or budget should require an explicit
decision rather than silent repair/research loops.

The earlier text-only history tradeoff remains a separate efficiency issue: tool
results omitted from the next model turn can cause repeat reads. UI changes alone
will not fix that. See `docs/HERMES.md` for the current behavior and limitations.

## Acceptance plan (proposed targets, not measured results)

Test these tasks in disposable workspaces on both renderers, at desktop and narrow
widths, including keyboard-only operation:

| Scenario | Expected experience |
| --- | --- |
| New user, no registered project | Clear goal entry and folder choice; no candidate/attempt/result fields required |
| Existing project, clear goal | Goal plus one understandable reviewed-start decision; no repeated known questions |
| Ambiguous project | One targeted project question; no arbitrary selection |
| Simple informational question | Direct answer; zero task/worker creation |
| Follow-up to an existing task | Offer continuation; preserve exact task/version/binding and avoid duplicate setup |
| Scope changes during review | Mark review stale and refresh its effects; do not dispatch an older proposal |
| Lost setup/start response | Recover the exact request; never launch duplicate work |
| Reload or disconnect during work | Restore truthful task status and next action; unknown is not failed or completed |
| Switch chat/task views | Preserve unsent drafts and selected context; no implicit handoff |
| Stop or budget reached | Clear supported action and accurate stopping/unknown state; no automatic rerun |
| Results ready | Separate explanation, recorded checks, review and application |

Measure time to a reviewed work brief separately from model execution time;
required user decisions; abandoned setup; repeated questions; wrong-project
corrections; duplicate launches; and whether the owner can identify what is running
and how to stop it. The initial usability target is a prepared brief within one
minute for a known project, without requiring the owner to understand “candidate,”
“attempt,” or “grant.” Validate this with observed sessions before claiming a gain.

## Research sources

- Nielsen Norman Group, [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/),
  published 2006-12-03, retrieved 2026-09-28. Keep common actions visible and defer
  specialized options; clearly label the route to advanced details. Warns that a
  multi-step wizard is problematic for interdependent decisions. Orbit implication:
  expose the goal and next step, not the entire execution record model.
- Microsoft, [Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/),
  CHI 2019 foundation, retrieved 2026-09-28. Evidence-based guidance across initial
  interaction, use, errors and adaptation. Orbit implication: explain capabilities,
  make correction easy, clarify uncertain choices and expose useful user controls.
- Microsoft Copilot Studio, [Slot-filling best practices](https://learn.microsoft.com/en-us/microsoft-copilot-studio/guidance/slot-filling-best-practices),
  retrieved 2026-09-28. Extract facts already supplied in the first request and
  skip redundant questions. Orbit implication: don't re-ask title/goal/project facts
  the owner has already established; validate inferred references before use.
- Google PAIR, [Feedback + Control](https://pair.withgoogle.com/guidebook-v2/chapter/feedback-controls),
  retrieved 2026-09-28. Balance automation with meaningful control, editability and
  manual fallback. Orbit implication: let the owner refine or dismiss the proposed
  setup and keep discussing without forcing task execution.
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
  published 2024-12-19, retrieved 2026-09-28. Recommends the simplest sufficient
  solution, explicit cost/latency tradeoffs, well-defined tools and stopping
  conditions. This supports proportional orchestration; it is engineering guidance,
  not a usability study of Orbit.

The Flash research also consulted Horvitz's mixed-initiative UI principles,
Anthropic's 2026 agent-oversight material, and the OpenAI Agents SDK interruption
documentation. These informed discussion; the recommendation above relies on the
five primary sources independently inspected by the lead, plus repository evidence.
External product patterns are inspiration, not substitutes for Orbit's contracts.

## Verification limits

This is a research artifact only. Source references were checked and existing
synthetic screenshots inspected; no new UI, benchmark or user study was run.
Quantitative targets above are proposed acceptance goals, not observed improvements.
No runtime code, owner data, deployment, grants or execution settings were changed.
