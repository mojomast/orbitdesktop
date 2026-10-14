# Pi agent provider

[Pi](https://pi.dev) is a third agent profile beside Hermes and Grok Bot. It is the
Pi agent harness (`@earendil-works/pi-coding-agent`), a coding agent with its own
`read`, `bash`, `edit`, and `write` tools, its own sessions, and its own permission
settings. The profile id is `pi` and the label is **Pi**.

Orbit reaches Pi the same way it reaches the Grok Bot host gateway: over loopback,
with the agent command set (`listAgents`, `createAgent`, `sendPrompt`,
`getAgentTranscriptTail`, `promptAcceptanceStatus`, `interruptAgentRun`,
`getConversationOutline`, `GET /events`). The chat surface is one
provider-parameterized implementation (`server/gateway-chat.mjs`) and one provider
list (`server/agent-providers.mjs`), so a gateway provider does not need a second
copy of the pane, the shared room, or the run tracking.

## Two ways Pi appears

**1. A gateway you run yourself.** Set `PI_GATEWAY_URL` and `PI_GATEWAY_TOKEN` in
the Orbit server environment. An explicit URL runs the agent pane exactly as
described below, and Orbit does not start anything. A URL that is not a plain
HTTP(S) origin, or a URL without a token, leaves the Pi profile out of the menu;
the Orbit server still starts.

**2. A harness on this computer (default).** Orbit looks for the `pi` binary:

1. `PI_BIN`, when it is an absolute path to an executable file
2. every absolute directory on `PATH`
3. `~/.local/bin/pi`, `~/bin/pi`, `/usr/local/bin/pi`, `/opt/homebrew/bin/pi`

When it finds one, Orbit starts its own gateway
(`server/pi-gateway.mjs`, `startPiGateway`) on a loopback port with a token
generated in memory for that process, and stops it on shutdown. Optional knobs:
`PI_LABEL` (menu label), `PI_MODEL` (display-only model label), and
`PI_HARNESS_DISABLED=true` to leave Pi out even when the binary exists.

Orbit never reads a model-vendor key from another application. Pi uses its own
credentials: `pi /login`, `~/.pi` configuration, or a provider entry in
`~/.pi/models.json` that interpolates an environment variable such as
`$OPENCODE_GO_API_KEY`. A Pi profile without credentials still appears and its
turns fail with the harness reason, in the conversation.

## Chat

Choose **Pi** in the agent pane header. The profile is an OS process per
conversation: an Orbit conversation *is* a Pi session, opened with
`pi --mode rpc --session-id <orbit conversation id> --session-dir <runtime>/pi-gateway/sessions`.
The same id reopens the same Pi session, so a conversation survives an Orbit or
gateway restart and Pi keeps its own transcript.

- send: the gateway writes the `prompt` command and waits for its correlated
  response. A prompt sent while Pi is streaming goes in as `streamingBehavior: "steer"`.
- status: `promptAcceptanceStatus` reports `pending`, `accepted`, `rejected`,
  `cancelled`, or `not-found`, and the reply is the first assistant text entry
  after the recorded position.
- stop: `abort`. Pi settles the run and the pane gets a stop notice.
- new conversation: a name of 1–80 characters creates a Pi session with that name
  (`--name`); a blank name reuses an idle **Orbit chat**.
- context: an estimate from the transcript (`characters / 4`), labeled
  **≈ estimated**. Compact confirms, summarizes, and continues in a new Pi session
  seeded with the summary; the previous session stays in history.
- live activity: `GET /events` streams `note`, `run`, `message`, and `tool`
  records scoped to the conversation. Tool history also comes back through
  `getConversationOutline`.

## Workspace knowledge and app building

A Pi turn carries the same workspace operator block a Grok Bot turn gets: the
repository path, `scripts/workspace_control.py` `read` / `apply` / `publish`,
`scripts/plugin_publish.py` plus `plugin_install` / `plugin_enable`, and the
current workspace metadata. The block is attached to the first turn of a
conversation and to a later turn when it is not already in the conversation.
`docs/AGENT_GUIDE.md` is named, not inlined: Pi reads it from disk when it needs
the full guide. Pi can build and publish apps the same way Hermes and Grok Bot do,
using its `bash` and `write` tools.

## Other agents

Pi joins the **Shared agents** room as a participant when the Pi profile is
configured. The room lists its participants, so a three-way room reads
`@hermes`, `@grok`, `@pi`; an @mention only selects a participant that is actually
in the room. Pi can be handed the floor, and either agent can end a reply with a
`delegate` block whose `target` is `pi`. Delegation depth (2), the task cap (8),
the per-task timeout, and the owner's floor behave exactly as they do between
Hermes and Grok Bot.

**Collab now accepts any configured agent.** The project board can assign owners,
reviewers, orchestration and capability profiles to Hermes, Grok Bot or Pi when
those profiles are configured. Pi uses the same gateway-backed turn path as Grok
Bot and is not a special-cased board member.

## Limits, stated plainly

| Surface | Pi |
| --- | --- |
| Chat, sessions, history, stop, live events | Yes, through the gateway |
| Workspace operator block, app build and publish | Yes |
| Shared room, @mention, delegate target | Yes, when the profile is configured |
| Collab board | Yes, when Pi is configured |
| Build queue, Project Workbench | No API. 409, as for Grok Bot |
| Scheduled tasks (`listAllAutomations`) | Empty list. The Pi gateway has no automations surface |
| Skills catalog | 404. The pane says Pi does not advertise this catalog |
| Toolsets | One built-in toolset reported: `pi-builtin` (`read, bash, edit, write`) |
| Tool approvals | None. Pi runs its own tools under its own permission settings; Orbit has no approval inbox for it |
| Extension dialogs | Cancelled. Pi extensions can ask for input (`confirm`, `select`, `input`, `editor`); Orbit has no widget surface for them, so the gateway answers `cancelled: true` and records one line in the conversation so the turn cannot deadlock |
| MCP servers | Not bridged. Pi's own MCP configuration applies inside Pi |

A harness failure is never turned into a plausible reply. When Pi's provider
refuses a turn, the gateway records `Pi could not finish this turn: <reason>` as
Pi's message so the pane shows the real reason, and the run is marked rejected.

## State on disk

Everything lives under `ORBIT_RUNTIME_DIR/pi-gateway/`:

- `agents.json` (mode `0600`): conversation id, name, Pi session id, timestamps
- `<conversation id>.jsonl` (mode `0600`): the Orbit-facing transcript (user
  prompt, assistant text, tool call and result entries)
- `sessions/`: Pi's own session storage for this gateway

Run records for the pane are written by the shared gateway chat to
`ORBIT_RUNTIME_DIR/pi-runs/` (mode `0600`, no token), so a restarted Orbit process
can keep polling a turn.

The gateway binds `127.0.0.1` only, requires the bearer token on every route,
caps a request body at 1 MiB and a prompt at 100,000 characters, and never logs a
prompt or a token. A conversation that has been idle is released after 15 minutes;
the conversation itself is kept.

## Tests

- `tests/pi-gateway.test.mjs`: gateway commands, transcript, tool outline, live
  stream, abort, restart persistence, extension-dialog cancellation, one-shot
  framing (U+2028/U+2029 are not record boundaries), and a command timeout.
- `tests/pi-provider.test.mjs`: the full chain through `createAgentHandler`, the
  workspace operator block, conversation naming, stop, and the failure path.
- `tests/pi-discovery.test.mjs`: external gateway, harness binary, refusal cases.
- `tests/fixtures/pi-rpc-stub.mjs`, `tests/fixtures/pi-rpc-framing.mjs`: recorded
  Pi RPC children, so the gateway tests need no model credential.
