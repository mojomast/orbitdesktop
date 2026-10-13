# Collab

Collab is a board where Hermes and Grok Bot do a piece of work together. Orbit keeps the project, the tasks, the files, the budget, and the approvals. The agents propose changes. They do not write the board directly.

Open **Collab** from the Start menu, the command palette, or the Orbit menu. It is its own window at `orbit://surface/collab`, with the project list, the board, the approval inbox, and the activity timeline. To start from the shared room, post `/collab` and a goal, for example `/collab Write the changelog`. That opens the Collab app on the new project.

## What you do

1. Create a project with a goal. Orbit asks the agent whose skills best match planning to draft tasks.
2. Read the plan in the approval inbox. Until you approve it, those tasks show as awaiting approval. **Approve** lets work start. **Reject** pauses the project.
3. Watch the board. Each task has an owner, a role, and a reviewer. The reviewer is always the other agent. Hermes and Grok Bot can work on independent tasks at the same time. The presence row shows who is working on what.
4. Reassign a task from its details, or drag the Move handle onto **Assign to Hermes** or **Assign to Grok Bot**. The reviewer still has to be the other agent. Enter or Space on a card opens the spec, acceptance criteria, dependencies, and history.
5. Open an artifact and pick a version to see what changed. Risky steps (shell writes, network posts, git pushes, email, deletes) wait in the inbox. The project badge counts a waiting approval.
6. When every task is finished, accept or reject the result.
7. **Pause** finishes the current turns and holds the board. **Stop** interrupts both agents. **Continue** resumes a paused project that still has budget. **Archive** keeps the record and stops scheduling. **Delete** removes the project after you confirm.

## How agents are chosen

Roles are not fixed. Each project stores a capability profile:

- Hermes defaults to terminal, tools, and code.
- Grok Bot defaults to terminal, tools, code, research, reasoning, and writing. When an executor task matches both, Hermes still takes it.

A plan can name an owner (`hermes` or `grok`, or Hermes / Grok Bot) and a reviewer. `dependsOn` is a list of exact task titles, and those tasks wait until the named ones are done. A role outside planner, executor, reviewer, and researcher is ignored and Orbit scores `skillsHint` instead. You can edit the profiles on the project. Each turn includes the current task's artifact text so a reviewer can read the work. Grok Bot uses a separate agent named **Orbit collab**, not your main Grok Bot conversation and not the shared room's Orbit shared chat.

Agents reply with one fenced `collab` JSON block (`plan`, `claim`, `artifact.put`, `handoff`, `submit`, `review`, `ask`, `decision`, `run-tests`, `workspace.sync`, `shell`). A malformed block gets one corrective retry that names the error and the allowed ops. `artifact.put` can use a relative path such as `src/app.js`. `baseVersion` must be the version the agent last read. If the other agent wrote it first, the put is rejected and the next prompt says the current version.

`shell` runs in the project workspace for either agent. `pwd`, `ls`, `git status`, `git diff`, `git log`, and the `run-tests` commands run immediately when their extra arguments are plain tokens. Any other command sets `risk` to `shell.write` and waits in the approval inbox. After you approve, Orbit runs that command with `sh -c` and stores the output as `shell-output.txt`. That approval is the control; the shell is not a sandbox. See [GROK_PARITY.md](GROK_PARITY.md).

`run-tests` runs one allowlisted command in the project workspace and stores stdout and stderr as the `test-results.txt` artifact. The commands are `npm test`, `npm run test`, `pnpm test`, `yarn test`, `pytest`, `python -m pytest`, `python3 -m pytest`, and `node --test`. Extra arguments have to be plain tokens, with no shell syntax. `workspace.sync` indexes text files from the workspace into artifacts. A new file is attributed to the agent and task that created it, including when another agent runs the sync. A risk approval names the command, up to 600 characters, or the file name.

## Limits

A turn that does not finish is stopped (20 minutes, or `ORBIT_COLLAB_TURN_TIMEOUT_MS`, falling back to `ORBIT_SHARED_TURN_TIMEOUT_MS`). A task lease lasts 10 minutes. A failed work turn retries the owner, then hands the task to the other agent, then marks it failed. A failed review turn (timeout, bad collab block, or gateway error) retries that review once and fails the task on the second failure, without spending the owner's attempts or changing the owner. A missing collab block, or `workspace.sync` without a task id, gets one corrective retry and does not spend a task attempt. A reviewer can send a task back once; the second request for changes fails it. The default budget is 40 turns and 120 minutes. Orbit warns around 80% and pauses at 100%. Token totals are counted when a gateway reports them.

When a reviewer accepts a task, Orbit commits the project workspace. The commit message is the task title and the author is the owning agent.

One agent is the orchestrator (auto, or Hermes or Grok Bot if you set it). That agent can replan, assign, spawn subagents, merge their worktrees, and post status. Subagents are tools by default: they return a summary and file paths. A handoff is only for a conversation you should have yourself. Each coding subagent has its own worktree. Merge does not push; you approve a push first. See [Orchestration](COLLAB_ORCHESTRATION.md).

The record lives under the Orbit runtime directory in `collab/<projectId>/` (project, tasks, versioned artifacts, and append-only `events.jsonl`). Each project also has `workspace/`, a git-initialized directory. Hermes can use its terminal there. Grok Bot uses `shell` and `artifact.put`. Orbit indexes text files from that directory after either agent's turn. The record does not include gateway tokens. Project Workbench has no Grok Bot API; see [GROK_PARITY.md](GROK_PARITY.md).
