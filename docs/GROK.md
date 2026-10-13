# Grok Bot provider

Grok Bot is a second Orbit chat profile. Hermes stays the default. The parity matrix, including bridges and the few Hermes APIs the gateway cannot provide, is [GROK_PARITY.md](GROK_PARITY.md).

## What Orbit looks for

Orbit reads the Grok Bot host that is already running on this computer. It does not ask the host to change models and it does not copy a model-vendor key into Orbit.

Search order for the gateway file `gateway.json`:

1. `SAND_DATA_ROOT`
2. `GROK_BOT_AGENT_DATA_DIR`
3. `SAND_USER_DATA_DIR/sand-data`
4. `/home/box/agent-data`
5. `/home/box/sand-data`
6. `~/.grokbot/agent-data`
7. `~/sand-data`
8. `~/Library/Application Support/Grok Bot/agent-data` on macOS

`gateway.json` needs an integer `port`. `scheme` is `http` or `https` (anything else is treated as `http`). `host` defaults to `127.0.0.1`. A bind of `0.0.0.0` or `::` is dialed as `127.0.0.1` on this machine. `token` is the gateway bearer token.

The model label comes from `settings.json` at `agentDefaultModel.modelId` in the same directory. Orbit does not send that model on `sendPrompt`; the host already selected it.

## Fallback when those files are missing

Set these in the Orbit server environment, never in the browser:

- `GROK_BOT_API_URL` or `GROKBOT_GATEWAY_URL` or `SAND_GATEWAY_URL`: gateway origin, for example `http://127.0.0.1:1340`. Userinfo, query, and fragment are rejected.
- `GROK_BOT_API_KEY` or `GROKBOT_GATEWAY_TOKEN` or `SAND_GATEWAY_TOKEN`: bearer token. A token in `gateway.json` is used when these are unset.
- `GROK_BOT_MODEL` or `SAND_XAI_MODEL`: optional display label only.

An explicit URL that is not a plain HTTP(S) origin disables Grok Bot for that process, even if `gateway.json` exists. A missing token leaves the profile out of the menu. The Orbit server still starts.

## Chat

The profile id is `grok` and the label is **Grok Bot**. Choose it in the agent pane header. History lists `listAgents` pages. Context use is an estimate from the transcript. Compact confirms, then continues in a new agent and keeps the old one in history. See [Agent pane session](AGENT_PANE_SESSION.md). An existing bot must be one of `listAgents`.

New conversation asks for a name. Cancel leaves the current conversation in place. A name of 1–80 characters calls `createAgent` with that name. A blank name reuses an idle `Orbit chat` whose transcript has no user or assistant text; if none exists, Orbit creates one. The rename control still changes only the Orbit display title.

Normal chat maps onto the host gateway:

- send: `POST /api/sendPrompt` with `prompt`, `agentId`, and `clientNonce`. Orbit does not send a model.
- before send, Orbit records the transcript tail (`getAgentTranscriptTail`)
- status: `promptAcceptanceStatus` with `accountSlot: "host"`, `clientNonce`, and `agentId`, then the transcript tail
- stop: `interruptAgentRun`

A turn is complete when a new transcript entry appears after the recorded position: a `send-message` text entry (`message.type` `text`) or a non-streaming assistant message. That reply is shown even if `listAgents` still reports the bot running or composing. Background tasks do not hold the pane open. `promptAcceptanceStatus` of `not-found` stays in progress for about eight seconds, then counts as accepted, because a server-hosted bot only stores the nonce when `agentId` is present. `rejected` fails the turn. `pending` keeps it running. The pane stops with an error if ten minutes pass without a reply.

Run records are stored under `ORBIT_RUNTIME_DIR/grok-runs` (mode `0600`, no gateway token) so a restarted Orbit process can keep polling. If a pane still points at a run that is no longer on disk or in memory, status ends that pane run as interrupted instead of returning 404 forever.

The token is sent only on server-side gateway requests. It is not returned by the profile list, written into shell environments, or printed in the Orbit log.

Agent chat can build and publish apps. On the first turn of a Grok Bot conversation, and on a follow-up when that block is not already in the conversation, Orbit sends the full workspace operator block: the repository path, `python3 scripts/workspace_control.py` `read`, `apply`, and `publish`, `plugin_publish.py` plus `plugin_install` / `plugin_enable`, and current workspace metadata. `docs/AGENT_GUIDE.md` is not inlined; the prompt tells Grok Bot to read that file from disk. Shell and publish commands still wait for approval. This is separate from the build queue, which stays Hermes-only. See [GROK_PARITY.md](GROK_PARITY.md).

A gateway rejection, including `sendPrompt` for an unknown conversation, is returned to that chat as an error. Transport failures and unexpected handler errors are HTTP 502. The response body is always read or cancelled. It does not stop the Orbit process or other Hermes runs. The live gateway listens on port 1340, often bound to `0.0.0.0`; Orbit dials `127.0.0.1` for that wildcard.

## Jobs, catalog, approvals, guidance, and live events

These use the Grok Bot gateway when the Grok Bot profile is selected. Orbit does not call the Hermes URL for them. The build queue and Project Workbench have no Grok Bot API; those requests return 409 or stay closed on a Grok Bot pane. See [GROK_PARITY.md](GROK_PARITY.md).

| Orbit action | Gateway | Gap |
| --- | --- | --- |
| Scheduled tasks list | `listAllAutomations` | The list omits prompts. An automation id must match `[A-Za-z0-9_-]{1,100}` or it is left out. |
| Pause / resume | `setAgentAutomationEnabled` | |
| Get, create, update, delete, run now | `get` is the list lookup; create/update/delete/run-now use `createAgentAutomation`, `updateAgentAutomation`, `deleteAgentAutomation`, `runAgentAutomationNow` on the bot that owns the automation. New tasks are created on the open conversation. | The create/update body is `{ name, prompt, schedule, trigger: { type: "cron", schedule } }`. A delivery target other than empty or `local` is rejected with 409. Skill names are prepended to the prompt (`Apply these skills: …`) because the gateway has no skills field. The job record still shows `skills: []`. |
| Skills catalog | `skillsCatalog` | Category is the entry `category`, `source`, or `publisher`. HTTP 404 becomes “Grok Bot does not advertise this catalog.” |
| Toolsets | `listBoxMcpServers` | Each server becomes a toolset named by `serverIdentifier`. `enabled` means status `connected`. `configured` means status is not `error`. Tool names are not in this gateway row, so `tools` is empty. |
| Tool activity | `getConversationOutline`, or the transcript tail if that command is missing | Rows are `tool-call` / `tool-result`. This is not Hermes `/api/sessions/.../messages`. |
| Tool approval | Status is `waiting_for_approval` when `awaitingUserResponse` is set or the transcript has a widget, permission, or approval entry, and no reply for this turn exists yet. Allow once calls `resolveLocalToolPermission` or, for a widget entry, `respondToWidget`. Deny calls `dismissWidget` or a deny decision on `resolveLocalToolPermission`. A 404 falls through to `resolveAutoReviewApproval`. | The gateway SDK does not type those decision bodies. Orbit sends `{ id, decision, choice }` or `{ entryId, agentId, value }`. A gateway error is shown; it is not turned into a Hermes approval. |
| Mid-run guidance | Another `sendPrompt` on the same bot, with a new nonce | This is a follow-up prompt, not Hermes in-turn steer. The open Orbit run still completes from the next assistant text. |
| Live activity | `GET /events` with the gateway bearer token | Capabilities report `run_events_sse: true`. Payloads that name a different `agentId` are dropped. Events with no `agentId` are forwarded. Tool-shaped payloads are also emitted as `tool.started`, `tool.completed`, or `tool.failed`. This is the host event feed, not a per-run Hermes transcript, it is not copied into the Hermes trace tee, and it does not replay history. |

## Shared agents

An agent chat pane has a **Shared agents** button. It opens one transcript for Kyle, Hermes, and Grok Bot. Kyle can post at any time, including while an agent is replying. `@hermes`, `@grok`, or `@all` chooses who answers. A message with no mention goes to whoever was addressed most recently, or to both when it is a question. Agents speak to each other only when they use an @mention or a delegate block, so the exchange stops when nobody is handed the floor. **Pause** finishes the current reply and holds the floor. **Stop** interrupts it. If the agents hand the floor back and forth without Kyle, a quiet backstop pauses the room and shows **Continue**. It does not show a turn counter. The backstop is a cap of 20 agent replies since Kyle last spoke, or a repeated back-and-forth. **Back to this chat** returns to the single-agent conversation.

Hermes uses its own Orbit session for this pane. Grok Bot uses a separate agent named **Orbit shared chat**. That is not the owner’s main Grok Bot conversation and it is not reused by New conversation. Each speaker receives the recent shared transcript and is told who the other participant is. A failure from either side is a message in the transcript. The record is stored under the Orbit runtime directory in `shared-agents` and does not include gateway tokens. A shared turn that does not finish within 3 minutes (`ORBIT_SHARED_TURN_TIMEOUT_MS`) is stopped, and the room keeps advancing on the server even if the pane is closed. Post `/collab` and a goal to open the Collab app on a new project. A Collab subagent is another gateway agent named `Orbit collab sub: …`, not this shared chat and not the main Grok Bot conversation. See [COLLAB.md](COLLAB.md) and [COLLAB_ORCHESTRATION.md](COLLAB_ORCHESTRATION.md). Tool approvals stay on the agent that is executing. Project Workbench has no Grok Bot API; the reason is in [GROK_PARITY.md](GROK_PARITY.md).

Either agent can delegate by ending a reply with a fenced block:

```delegate
target: grok
task: what the other agent should do
context: optional details
```

`target` is `hermes` or `grok` (the other participant). Orbit tracks the task in the pane as pending, running, done, or failed. **Cancel** stops a pending or running task. Hermes runs the task on the Hermes API server Orbit already uses. Grok Bot runs it as **Orbit shared chat** on the Grok gateway. The result is posted in the shared transcript and sent back to the delegating agent so it can continue.

A chain stops at depth 2 so the agents cannot ping-pong. A conversation keeps at most 8 delegated tasks. A task times out after 3 minutes. If the executing agent is waiting for a tool approval, the task stays running until that agent's existing approval flow resolves it, or until the owner cancels the task.

## Together with Hermes

Leave Hermes unset and Orbit uses `~/.hermes` as the default profile. See [HERMES.md](HERMES.md). Grok Bot is an extra choice in the same menu. To serve the desktop on a tailnet, set `ORBIT_HOST=0.0.0.0` and `ORBIT_PUBLIC_ORIGIN` as described in the README.
