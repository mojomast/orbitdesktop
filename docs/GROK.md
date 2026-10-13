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

The profile id is `grok` and the label is **Grok Bot**. Choose it in the agent pane, then New conversation or an existing bot. New conversation calls `createAgent`. An existing bot must be one of `listAgents`.

Normal chat maps onto the host gateway:

- send: `POST /api/sendPrompt` with `prompt`, `agentId`, and `clientNonce`
- status: `promptAcceptanceStatus`, `listAgents`, `getAsyncTasks`, `getSubagents`, and `getAgentTranscriptTail`
- stop: `interruptAgentRun`

The token is sent only on those server-side requests. It is not returned by the profile list, written into shell environments, or printed in the Orbit log.

A gateway rejection, including `sendPrompt` for an unknown conversation, is returned to that chat as an error. The response body is always read or cancelled. It does not stop the Orbit process or other Hermes runs. The live gateway listens on port 1340, often bound to `0.0.0.0`; Orbit dials `127.0.0.1` for that wildcard.

These Hermes tools are not available on the Grok Bot profile: build queue, skills/tool catalog, scheduled jobs, activity history, mid-run guidance, tool approvals, and the run event stream. Capabilities report `run_events_sse: false`. Use a Hermes profile for that work.

## Together with Hermes

Leave Hermes unset and Orbit uses `~/.hermes` as the default profile. See [HERMES.md](HERMES.md). Grok Bot is an extra choice in the same menu. To serve the desktop on a tailnet, set `ORBIT_HOST=0.0.0.0` and `ORBIT_PUBLIC_ORIGIN` as described in the README.
