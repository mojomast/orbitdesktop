# Grok Bot parity with Hermes

Hermes stays the default profile. Grok Bot is a second profile on the same Orbit agent pane, shared room, and Collab board. This matrix is the audit of every Hermes integration that Orbit exposes to the owner. Status means:

- **Parity** — the same Orbit action works on the Grok Bot gateway.
- **Bridged** — the gateway cannot do it, and Orbit performs it with the same owner-facing control (usually the existing approval gate).
- **Partial** — the owner can use the feature, with a named difference.
- **Equal gap** — Hermes in Orbit does not have it either.
- **Impossible** — the gateway has no API for it, and inventing a second copy inside Orbit would not be the Hermes feature. The pane refuses the call instead of sending a Grok Bot profile to a Hermes worker.

Gateway commands below are the host commands Orbit already calls (`listAgents`, `sendPrompt`, `promptAcceptanceStatus`, `getAgentTranscriptTail`, `interruptAgentRun`, `skillsCatalog`, `listBoxMcpServers`, automation commands, permission and widget commands, and `GET /events`).

## Matrix

| Area | Hermes | Grok Bot | Status |
| --- | --- | --- | --- |
| Profile discovery | `~/.hermes` or `HERMES_API_URL` | `gateway.json` search, then `GROK_BOT_API_URL` / token | Parity |
| Pane binding and conversation switch | `/api/sessions`, new `orbit-<UUID>` | `listAgents`, `createAgent`, reuse an empty **Orbit chat** | Parity |
| Send, status, stop | `POST /v1/runs`, run status, stop | `sendPrompt`, `promptAcceptanceStatus`, transcript tail, `interruptAgentRun` | Parity |
| Cancellation | Stop on the Hermes run | `interruptAgentRun` on that bot | Parity |
| Tool approvals | Hermes pending approvals | `waiting_for_approval` from `awaitingUserResponse`, widgets, or permission entries. Allow once uses `resolveLocalToolPermission` or `respondToWidget`. Deny uses `dismissWidget`, a deny decision, or `resolveAutoReviewApproval` | Parity |
| Tool activity history | `/api/sessions/.../messages` | `getConversationOutline`, then transcript tail | Parity |
| Live tool events | `GET /v1/runs/:id/events` copied into the run trace | `GET /events`, filtered by `agentId`. Tool-shaped payloads are also emitted as `tool.started`, `tool.completed`, or `tool.failed` for the same tool feed | Partial. The host feed is not a per-run Hermes transcript and is not copied into the Hermes trace tee |
| Skills catalog | `/v1/skills` | `skillsCatalog` | Parity |
| Toolsets | `/v1/toolsets` with tool names | `listBoxMcpServers`. `tools` is empty because that row has no tool list | Partial |
| Scheduled tasks | `/api/jobs` and `/api/jobs/:id` | `listAllAutomations`, `setAgentAutomationEnabled`, `createAgentAutomation`, `updateAgentAutomation`, `deleteAgentAutomation`, `runAgentAutomationNow` | Partial. See automations below |
| Automation skills | Hermes attaches a skills list | Names are prepended to the prompt: `Apply these skills: …`. The stored job still reports `skills: []` because the gateway has no skills field | Bridged |
| Automation delivery | Hermes delivery targets | Anything other than empty or `local` returns 409 | Impossible. The gateway spec has no delivery target |
| Mid-run guidance | In-run steer | A new `sendPrompt` on the same bot. The open Orbit turn still completes from the next assistant text | Partial |
| Model setting | Hermes profile model | Display label from `settings.json` `agentDefaultModel.modelId` or `GROK_BOT_MODEL`. Orbit does not send a model on `sendPrompt` | Partial. The host already selected the model |
| Session list past the first page | Hermes `offset` | Orbit slices `listAgents` into pages of 100. The gateway returns the full list in one call | Bridged |
| Conversation drafts, pins, archive, export | Orbit metadata, not the gateway | Same Orbit metadata. A Grok Bot export is labeled Grok Bot | Parity |
| Shared room and delegation | Hermes session for the pane | Separate **Orbit shared chat** agent. Same mentions, backstop, timeout, and delegate block | Parity |
| Collab board, gates, budget, reviews | Hermes turns | Grok Bot turns on **Orbit collab**. Same JSON ops, gates, and budget | Parity |
| Collab orchestrator | Either agent can be the project's orchestrator. Plan ops include `replan`, `assign`, `spawn`, `merge`, and `status` | Same ops on **Orbit collab** | Parity |
| Collab subagents | A new Hermes session (`orbit-sub-…`) on the gateway. The session is abandoned when the subagent finishes | A new gateway agent named **Orbit collab sub: …**, archived with `archiveAgent` after completion. Never the main conversation, **Orbit shared chat**, or the project's **Orbit collab** agent | Parity. Hermes has no archive call, so Orbit starts a fresh session id instead |
| Collab files | Hermes terminal, then Orbit indexes the git workspace | `artifact.put` and the same index after a Grok Bot turn | Parity |
| Collab terminal | Hermes terminal tool in `workspace/` | `shell` op. Read-only commands run in the workspace. Anything else needs `risk: "shell.write"` and Kyle’s approval, then Orbit runs `sh -c` there and stores `shell-output.txt` | Bridged. `sh -c` is not a sandbox; approval is the control. Read-only commands are `pwd`, `ls`, `git status`, `git diff`, `git log`, and the `run-tests` prefixes, with plain tokens only |
| Collab tests | `run-tests` | Same allowlist and `test-results.txt` | Parity |
| Collab default skills | terminal, tools, code | terminal, tools, code, research, reasoning, writing. An executor tie still prefers Hermes | Parity for the skill names. Planner and researcher ties still prefer Grok Bot |
| Chat composer, tools dialog, menu jobs and catalog | Hermes wording, default profile | Labels follow the selected agent. The Orbit menu passes the focused pane’s `profile_id` | Parity |
| Capabilities flag for live events | Hermes advertises `run_events_sse` | Reported true. The stream is the host `/events` feed | Partial |
| Assistant token streaming | The pane polls until the run completes | The pane polls until a finished transcript entry exists. `streaming: true` entries are ignored until they finish | Equal gap |
| Chat attachments on Send | `start` accepts text only | `start` accepts text only | Equal gap |
| Project Workbench and pane workbench | Hermes `/v1/runs` workers, native workers, submission receipts | The Grok Bot pane shows an unavailable state and does not call those APIs | Impossible. The gateway has no Hermes run, workbench, or resource API |
| App build (agent chat) | Full workspace context: operator commands and `docs/AGENT_GUIDE.md` | The first turn of a conversation, and a follow-up when that block is missing, sends the full operator block untruncated: repository path, `workspace_control.py` `read` / `apply` / `publish`, `plugin_publish.py`, `plugin_install`, `plugin_enable`, and workspace metadata. The prompt tells Grok Bot to read `docs/AGENT_GUIDE.md` from disk. Shell and publish still need the owner's approval | Parity |
| Build queue | Default Hermes profile only | 409: `The build queue uses Hermes workers. Grok Bot has no build-queue API.` | Impossible |
| Durable submission journal and resource delegation | Pane `start` writes a receipt and can delegate workspace resources into a Hermes run | Grok Bot `start` is `sendPrompt` plus a local run record under `grok-runs` | Impossible. There is no `/v1/runs` receipt to reconcile |
| Memory | Collab project memory is Orbit’s record | The same Collab memory. The gateway has no separate memory API Orbit can read or write | Parity for Collab memory. A Hermes-style memory store on the gateway is not available |

## What Orbit refuses on purpose

A Grok Bot profile never receives:

- `build_queue`
- Project Workbench or pane-workbench routes (the pane does not mount them)
- a non-local automation `deliver` value
- a Hermes `/v1/runs` body, including durable submission receipts and resource delegation

The menu says so when the focused chat is Grok Bot and the owner opens the build queue or Project Workbench.

## Collab shell bridge

Hermes can already use its own terminal in `collab/<projectId>/workspace`. The Grok Bot gateway has no terminal pointed at that directory. Orbit therefore accepts a `shell` op from either agent:

1. `pwd`, `ls`, `git status`, `git diff`, `git log`, and the existing test commands run as an argument vector, with a reduced environment (`PATH`, `HOME`, `LANG`, `TMPDIR`, `USER`, `CI=1`). Extra arguments must be plain tokens and cannot contain `..`.
2. Any other command must set `risk` to `shell.write`. That uses the same risk inbox as deletes and git pushes. The approval summary includes the command, up to 600 characters, or the file name for a risky write. Nothing runs until Kyle approves.
3. After approval, Orbit runs `sh -c` in the workspace for at most 60 seconds and stores the output as `shell-output.txt`.
4. Text files the command creates are indexed as artifacts under the agent and task that created them, including when another agent or the approval runs the sync.

Do not treat step 2 as a sandbox. A shell can still leave the working directory. The approval is what makes the command allowed.
