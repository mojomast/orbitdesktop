# Collab orchestration

Collab keeps one orchestrator per project. Orbit still owns the board, the gates, the budget, and the record. The orchestrator proposes `replan`, `assign`, `spawn`, `merge`, and `status`. Kyle can leave the choice on auto, or set Hermes or Grok Bot.

Auto uses the same planner scoring as the rest of Collab. The agent tree in the Collab window shows who the orchestrator is, the subagents under each agent, live status, budget, cancel, and a read-only transcript.

## Agents as tools

The default spawn mode is `tool`. The worker returns a summary and artifact paths to its parent. It does not take over the conversation. `mode: "handoff"` is accepted only with `audience: "kyle"`, and only when Kyle should talk to that agent directly. Kyle approves that handoff before Orbit opens the session.

This follows Anthropic’s orchestrator-worker research system, where a lead agent delegates parallel workers and synthesizes their results ([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)), and the OpenAI Agents SDK “agents as tools” pattern, where specialists return to the manager instead of handing off the thread ([Multi-agent portfolio collaboration](https://developers.openai.com/cookbook/examples/agents_sdk/multi-agent-portfolio-collaboration/multi_agent_portfolio_collaboration.md)).

## Brief and effort

A spawn brief must include an objective, a deliverable, acceptance criteria, allowed tools, a scope, a budget (`turns` 1–20 and `minutes` 1–30), and a return format. `effort` is 1–4. One subagent starts immediately. Two or more wait on a scale approval whose summary is the projected turn and minute cost. Coding spawns name disjoint files; one spawn cannot share a file list across several workers.

The brief shape matches the task description Claude Code expects of a subagent: objective, deliverable, and a bounded set of tools ([Create custom subagents](https://code.claude.com/docs/en/sub-agents)). Effort stops at four parallel workers so a project cannot fan out without Kyle seeing the cost first.

## Worktrees

Each subagent gets its own git worktree and `collab/<id>` branch under the project record, beside the shared workspace. The orchestrator merges in dependency order. A conflict becomes a `Resolve <file>` task. Merge never pushes. A push stays on the existing `git.push` approval.

Claude Code isolates parallel edits in worktrees ([Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees)). Orbit keeps that isolation per subagent and adds an explicit owner for each declared file so two coding workers are not writers of the same path.

## Limits

Defaults are 3 concurrent subagents per agent and depth 1. Kyle can raise concurrency to 4 and depth to 2. A spawn that repeats a parent brief on the same task is rejected. A failed subagent is retried once, then rerouted to the other provider, then failed with a status Orbit shows Kyle. A subagent turn uses its brief minute budget, capped at 30 minutes. Those turns count against the project turn budget.

Each subagent emits timeline events shaped as OpenTelemetry GenAI spans (`gen_ai.operation.name`, `gen_ai.agent.name`, status, start, and end). The timeline already shows those events.

Hermes subagents try `POST /v1/delegate_task`. A 404, 405, or 501 means that route is not on this Hermes, and Orbit starts a new Hermes session instead. Grok Bot subagents are new gateway agents named `Orbit collab sub: …`, never the main conversation and never the project’s Orbit collab agent. Orbit archives the Grok Bot agent when the subagent completes, fails, or is canceled.

## Sources

- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- OpenAI, [Multi-agent orchestration with the Agents SDK](https://developers.openai.com/cookbook/examples/agents_sdk/multi-agent-portfolio-collaboration/multi_agent_portfolio_collaboration.md)
- Claude Code, [Subagents](https://code.claude.com/docs/en/sub-agents) and [Worktrees](https://code.claude.com/docs/en/worktrees)
