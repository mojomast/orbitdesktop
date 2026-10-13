# Grok Bot provider

Grok Bot is a second Orbit chat profile. Hermes stays the default. Project Workbench native workers stay on Hermes.

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

The profile id is `grok` and the label is **Grok Bot**. Choose it in the agent pane, then New conversation or an existing bot. An existing bot must be one of `listAgents`.

New conversation asks for a name. Cancel leaves the current conversation in place. A name of 1–80 characters calls `createAgent` with that name. A blank name reuses an idle `Orbit chat` whose transcript has no user or assistant text; if none exists, Orbit creates one. The rename control still changes only the Orbit display title.

Normal chat maps onto the host gateway:

- send: `POST /api/sendPrompt` with `prompt`, `agentId`, and `clientNonce`. Orbit does not send a model.
- before send, Orbit records the transcript tail (`getAgentTranscriptTail`)
- status: `promptAcceptanceStatus` with `accountSlot: "host"`, `clientNonce`, and `agentId`, then the transcript tail
- stop: `interruptAgentRun`

A turn is complete when a new transcript entry appears after the recorded position: a `send-message` text entry (`message.type` `text`) or a non-streaming assistant message. That reply is shown even if `listAgents` still reports the bot running or composing. Background tasks do not hold the pane open. `promptAcceptanceStatus` of `not-found` stays in progress for about eight seconds, then counts as accepted, because a server-hosted bot only stores the nonce when `agentId` is present. `rejected` fails the turn. `pending` keeps it running. The pane stops with an error if ten minutes pass without a reply.

Run records are stored under `ORBIT_RUNTIME_DIR/grok-runs` (mode `0600`, no gateway token) so a restarted Orbit process can keep polling. If a pane still points at a run that is no longer on disk or in memory, status ends that pane run as interrupted instead of returning 404 forever.

The token is sent only on server-side gateway requests. It is not returned by the profile list, written into shell environments, or printed in the Orbit log.

A gateway rejection, including `sendPrompt` for an unknown conversation, is returned to that chat as an error. Transport failures and unexpected handler errors are HTTP 502. The response body is always read or cancelled. It does not stop the Orbit process or other Hermes runs. The live gateway listens on port 1340, often bound to `0.0.0.0`; Orbit dials `127.0.0.1` for that wildcard.

## Jobs, catalog, approvals, guidance, and live events

These use the Grok Bot gateway when the Grok Bot profile is selected. Orbit does not call the Hermes URL for them. The build queue and Project Workbench stay on Hermes; a Grok Bot build-queue request returns 409.

| Orbit action | Gateway | Gap |
| --- | --- | --- |
| Scheduled tasks list | `listAllAutomations` | The list omits prompts. An automation id must match `[A-Za-z0-9_-]{1,100}` or it is left out. |
| Pause / resume | `setAgentAutomationEnabled` | |
| Get, create, update, delete, run now | `get` is the list lookup; create/update/delete/run-now use `createAgentAutomation`, `updateAgentAutomation`, `deleteAgentAutomation`, `runAgentAutomationNow` on the bot that owns the automation. New tasks are created on the open conversation. | The create/update body is `{ name, prompt, schedule, trigger: { type: "cron", schedule } }`. A delivery target other than empty or `local`, and any skills list, are rejected with 409. Orbit does not drop those fields silently. |
| Skills catalog | `skillsCatalog` | Category is the entry `category`, `source`, or `publisher`. HTTP 404 becomes “Grok Bot does not advertise this catalog.” |
| Toolsets | `listBoxMcpServers` | Each server becomes a toolset named by `serverIdentifier`. `enabled` means status `connected`. `configured` means status is not `error`. Tool names are not in this gateway row, so `tools` is empty. |
| Tool activity | `getConversationOutline`, or the transcript tail if that command is missing | Rows are `tool-call` / `tool-result`. This is not Hermes `/api/sessions/.../messages`. |
| Tool approval | Status is `waiting_for_approval` when `awaitingUserResponse` is set or the transcript has a widget, permission, or approval entry, and no reply for this turn exists yet. Allow once calls `resolveLocalToolPermission` or, for a widget entry, `respondToWidget`. Deny calls `dismissWidget` or a deny decision on `resolveLocalToolPermission`. A 404 falls through to `resolveAutoReviewApproval`. | The gateway SDK does not type those decision bodies. Orbit sends `{ id, decision, choice }` or `{ entryId, agentId, value }`. A gateway error is shown; it is not turned into a Hermes approval. |
| Mid-run guidance | Another `sendPrompt` on the same bot, with a new nonce | This is a follow-up prompt, not Hermes in-turn steer. The open Orbit run still completes from the next assistant text. |
| Live activity | `GET /events` with the gateway bearer token | Capabilities report `run_events_sse: true`. Payloads that name a different `agentId` are dropped. Events with no `agentId` are forwarded. This is the host event feed, not a per-run Hermes transcript, and it does not replay history. |

## Together with Hermes

Leave Hermes unset and Orbit uses `~/.hermes` as the default profile. See [HERMES.md](HERMES.md). Grok Bot is an extra choice in the same menu. To serve the desktop on a tailnet, set `ORBIT_HOST=0.0.0.0` and `ORBIT_PUBLIC_ORIGIN` as described in the README.
