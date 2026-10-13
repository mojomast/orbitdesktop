# Collab

Collab is a board where Hermes and Grok Bot do a piece of work together. Orbit keeps the project, the tasks, the files, the budget, and the approvals. The agents propose changes. They do not write the board directly.

Open **Collab** from the Start menu, the command palette, or the Orbit menu. It is its own window at `orbit://surface/collab`, with the project list, the board, the approval inbox, and the activity timeline. To start from the shared room, post `/collab` and a goal, for example `/collab Write the changelog`. That opens the Collab app on the new project.

## What you do

1. Create a project with a goal. Orbit asks the agent whose skills best match planning to draft tasks.
2. Read the plan in the approval inbox. Until you approve it, those tasks show as awaiting approval. **Approve** lets work start. **Reject** pauses the project.
3. Watch the board and the agent tree. Each task has an owner, a role, and a reviewer. The reviewer is always the other agent. Hermes and Grok Bot can work on independent tasks at the same time. The presence row and the tree show who is working, including subagents.
4. Reassign a task from its details, or drag the Move handle onto **Assign to Hermes** or **Assign to Grok Bot**. The reviewer still has to be the other agent. Enter or Space on a card opens the spec, acceptance criteria, dependencies, and history.
5. Open an artifact and pick a version to see what changed. Risky steps (shell writes, network posts, git pushes, email, deletes) wait in the inbox. The project badge counts a waiting approval.
6. When every task is finished, accept or reject the result.
7. **Pause** finishes the current turns and holds the board. **Stop** interrupts both agents and any running subagents. **Continue** resumes a paused project that still has budget. **Archive** keeps the record and stops scheduling. **Delete** removes the project after you confirm.

## How agents are chosen

Roles are not fixed. Each project stores a capability profile:

- Hermes defaults to terminal, tools, and code.
- Grok Bot defaults to terminal, tools, code, research, reasoning, and writing. When an executor task matches both, Hermes still takes it.

A plan can name an owner (`hermes` or `grok`, or Hermes / Grok Bot) and a reviewer. `dependsOn` is a list of exact task titles, and those tasks wait until the named ones are done. A role outside planner, executor, reviewer, and researcher is ignored and Orbit scores `skillsHint` instead. You can edit the profiles on the project. Each turn includes the current task's artifact text so a reviewer can read the work. Grok Bot uses a separate agent named **Orbit collab**, not your main Grok Bot conversation and not the shared room's Orbit shared chat.

Agents reply with one fenced `collab` JSON block (`plan`, `claim`, `artifact.put`, `handoff`, `submit`, `review`, `ask`, `decision`, `run-tests`, `workspace.sync`, `shell`, `replan`, `assign`, `spawn`, `merge`, `status`). A malformed block gets one corrective retry that names the error and the allowed ops. `artifact.put` can use a relative path such as `src/app.js`. `baseVersion` must be the version the agent last read. If the other agent wrote it first, the put is rejected and the next prompt says the current version.

`shell` runs in the project workspace for either agent. `pwd`, `ls`, `git status`, `git diff`, `git log`, and the `run-tests` commands run immediately when their extra arguments are plain tokens. Any other command sets `risk` to `shell.write` and waits in the approval inbox. After you approve, Orbit runs that command with `sh -c` and stores the output as `shell-output.txt`. That approval is the control; the shell is not a sandbox. See [GROK_PARITY.md](GROK_PARITY.md).

`run-tests` runs one allowlisted command in the project workspace and stores stdout and stderr as the `test-results.txt` artifact. The commands are `npm test`, `npm run test`, `pnpm test`, `yarn test`, `pytest`, `python -m pytest`, `python3 -m pytest`, and `node --test`. Extra arguments have to be plain tokens, with no shell syntax. `workspace.sync` indexes text files from the workspace into artifacts. A new file is attributed to the agent and task that created it, including when another agent runs the sync. A risk approval names the command, up to 600 characters, or the file name.

## Orchestrator and subagents

Each project has one orchestrator, Hermes or Grok Bot. The planner can name it on the plan (`orchestrator`, `effort` of `trivial`, `moderate`, or `complex`, and `maxDepth` of 1 or 2). If the plan omits it, the agent who wrote the plan becomes the orchestrator. You can change the agent, effort, and depth from **Save orchestrator** on the project. The default effort is moderate and the default depth is 1.

The default pattern is agents-as-tools: the orchestrator stays in charge, and a worker returns a structured result. `handoff` still only reassigns a task. It does not hand the project over. Orbit still owns the board, the gates, and the budgets. The orchestrator proposes `plan`, `replan` (after a failed task), `assign`, `spawn`, `merge`, and `status`. A subagent finishing does not mark the parent task done. The other top-level agent still reviews it.

This follows the lead-and-workers shape in [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), the agents-as-tools pattern in the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/multi_agent/) (the orchestrator receives the worker's result and keeps the project), and Claude Code's rule that a subagent returns a summary from its own context ([Subagents](https://code.claude.com/docs/en/sub-agents)). [Cognition's "Don't Build Multi-Agents"](https://cognition.com/blog/dont-build-multi-agents) is why each writer owns a disjoint set of files and the orchestrator merges those branches.

### Spawn brief

`spawn` is rejected unless the brief has every field:

- `objective` and `deliverable`
- `acceptance` (1–8 criteria)
- `allowedTools` from `read`, `research`, `code`, `terminal`, `tools`, `shell`, `write`, `files`, `web`
- `scope` (relative files; `[]` is allowed only for a reader)
- `budget` with `turns` (1–40), `tokens` (100–2,000,000), and `minutes` (1–30)
- `returnFormat` exactly `summary+paths`

The worker's only completion op is `status`, with `summary` and `artifactPaths`. A coding brief (any of `code`, `terminal`, `tools`, `shell`, `write`, `files`) must name the files it may write.

Hermes subagents are new Hermes sessions on the gateway (`orbit-sub-…`). Grok Bot subagents are new gateway agents named `Orbit collab sub: …`. That name is never the main Grok Bot conversation, never **Orbit shared chat**, and never the project's **Orbit collab** agent. Orbit archives the Grok Bot subagent after it finishes. A missing archive endpoint is recorded and does not fail the task.

### Effort, depth, and fan-out

| Effort | Parallel subagents |
| --- | --- |
| trivial | none |
| moderate | at most 2 |
| complex | at most 4 on the project, and at most 3 from one agent |

Depth defaults to 1. You or the plan can raise it to 2. A block that spawns two or more subagents waits in the inbox as a fan-out gate. The summary includes the projected token cost (the sum of the brief budgets) before any of them start. One spawn starts immediately and still records that projection. Anthropic reports multi-agent runs using about 15× the tokens of a single chat, and Claude Code notes that token use grows with team size ([Costs](https://code.claude.com/docs/en/costs)), which is why the fan-out is a gate.

### Worktrees

A coding subagent gets its own git worktree at `workspace/.orbit/worktrees/<id>` on branch `orbit/<id>` ([git worktree](https://git-scm.com/docs/git-worktree); the same isolation Claude Code and Cursor use for parallel sessions). Readers do not take a worktree and may share files. Two active coding subagents cannot list the same file.

`merge` is orchestrator-only. Orbit commits the worktree, rebases it onto the workspace in dependency order, runs an allowlisted test command when the op asks for one, then fast-forwards or squashes and removes the worktree. A rebase conflict or a failed test becomes a `resolve` task owned by the writer and reviewed by the other top-level agent. `push: true` only opens a `git.push` risk gate. Nothing is pushed until you approve.

### Limits, failure, and the timeline

A plan task may set `maxTurns` (1–80), `maxTokens` (100–2,000,000), and `maxMinutes` (1–30). A subagent uses the brief budget. A turn with no per-task limit still stops at 20 minutes, or at `ORBIT_COLLAB_TURN_TIMEOUT_MS` / `ORBIT_SHARED_TURN_TIMEOUT_MS` when that value is between 1 second and 30 minutes. Hitting a budget follows the same path as a failed subagent: retry once on the same agent, reroute to the other agent, then fail and notify you. A gateway error or timeout skips the extra protocol retry and uses that same path. MAST's failure classes (specification, misalignment, and weak termination) are the reason those stops are explicit ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)).

Orbit also stops the project when the same action repeats without progress: an A-B-A-B ping-pong, or the same signature three times in the last six. The activity line says the actions repeated, and the timeline records `loop` and `notify`.

The activity timeline records OpenTelemetry GenAI-style spans named `invoke_agent`, `execute_tool`, and `chat` ([GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)). Each span carries `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.request.model`, tokens, USD when the gateway reports a cost, duration, and the worktree or branch. Click a span row to open that subagent's transcript.

The agent tree is orchestrator, then Hermes and Grok Bot, then their subagents. A row shows live status, budget use, and branch. Open a subagent for a read-only transcript and, while it is queued or running, **Cancel subagent**.

## Limits

A turn that does not finish is stopped (20 minutes, or `ORBIT_COLLAB_TURN_TIMEOUT_MS`, falling back to `ORBIT_SHARED_TURN_TIMEOUT_MS`). A task lease lasts 10 minutes. A failed work turn retries the owner, then hands the task to the other agent, then marks it failed. A failed review turn (timeout, bad collab block, or gateway error) retries that review once and fails the task on the second failure, without spending the owner's attempts or changing the owner. A missing collab block, or `workspace.sync` without a task id, gets one corrective retry and does not spend a task attempt. A reviewer can send a task back once; the second request for changes fails it. The default budget is 40 turns and 120 minutes. Orbit warns around 80% and pauses at 100%. Token totals are counted when a gateway reports them.

When a reviewer accepts a task, Orbit commits the project workspace. The commit message is the task title and the author is the owning agent.

The record lives under the Orbit runtime directory in `collab/<projectId>/` (project, tasks, versioned artifacts, subagents, and append-only `events.jsonl`). Each project also has `workspace/`, a git-initialized directory. Hermes can use its terminal there. Grok Bot uses `shell` and `artifact.put`. Coding subagents write in their worktree until merge. Orbit indexes text files from the workspace after either agent's turn. The record does not include gateway tokens. Project Workbench has no Grok Bot API; see [GROK_PARITY.md](GROK_PARITY.md).
