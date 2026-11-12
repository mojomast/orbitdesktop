# Agent adapters

Orbit is agent-customizable, not tied to one vendor. Hermes, Grok Bot and Pi are
optional adapters. Any OpenAI-compatible endpoint can be another adapter, and a
new agent can be added by translating the same small gateway command set.

The examples use reserved `.example` origins and loopback addresses. Replace them
with the origin your provider documents. Do not put an API key in a tracked file.

## Three layers

- **Workflow is the protocol.** A conversation, a run, an interruption, a
  transcript and an event feed have the same meaning whatever runtime answers.
  The protocol is the stable part; the model vendor is not.
- **Bundlebees is the execution layer.** Work that needs a bounded environment,
  files, checks or a candidate is executed by the execution service, under its
  own authority. An adapter does not gain shell or file access by existing.
- **Orbit is the interface.** The desktop owns panes, layout, history and owner
  consent. It talks to adapters only through reviewed server-side routes.

An adapter is therefore a translator at the boundary. It must not pretend that a
runtime can do work it cannot do. If a capability is absent, the adapter reports
the absence and Orbit keeps the corresponding surface closed.

## Gateway command set

Orbit reaches a gateway provider over loopback with these commands. The module
`server/openai-compat-gateway.mjs` implements the same names as the Grok Bot host
gateway and `server/pi-gateway.mjs`:

| Command | Transport | Request body | Successful result |
| --- | --- | --- | --- |
| `listAgents` | `POST /api/listAgents` | `{}` | `[{ id, name, isRunning, isComposingMessage, updatedAt, awaitingUserResponse }]` |
| `createAgent` | `POST /api/createAgent` | `{ name?, description?, isIntroductionSuppressed? }` | `{ agent: { id, name } }` |
| `sendPrompt` | `POST /api/sendPrompt` | `{ agentId, prompt, clientNonce? }` | `{ accepted: true, nonce }` |
| `getAgentTranscriptTail` | `POST /api/getAgentTranscriptTail` | `{ id, limit? }` | `{ entries: [{ seq, id, at, kind, role, content }] }` |
| `promptAcceptanceStatus` | `POST /api/promptAcceptanceStatus` | `{ clientNonce, agentId }` | `{ outcome: "found", record: { status, agentId, error? } }` or `{ outcome: "not-found" }` |
| `interruptAgentRun` | `POST /api/interruptAgentRun` | `{ id }` | `{ ok: true }` |
| `getConversationOutline` | `POST /api/getConversationOutline` | `{ id }` | `{ items: [] }` when the adapter has no tool outline |
| `listModels` | `POST /api/listModels` | `{}` | `{ models: [string] }` |
| `capabilities` | `POST /api/capabilities` | `{}` | capability flags, below |
| `GET /events` | SSE | bearer token when configured | `{ channel, payload }` frames |

A run status is `pending` while the adapter is working, `accepted` after the
assistant text is recorded, `rejected` after a provider or transport failure, and
`cancelled` after an interrupt. `getAgentTranscriptTail` always returns the
Orbit-facing transcript, not a vendor-native transcript. Entries are ordered by
an increasing `seq` and carry a stable `id`.

An adapter may also answer `listBoxMcpServers` with `{ servers: [] }` and
`listAllAutomations` with `[]`. Those two answers mean “this runtime has no tools
or schedules”, not “unsupported route”.

## Capability flags

The OpenAI-compatible adapter reports:

```json
{
  "streaming": true,
  "nonStreamingFallback": true,
  "models": true,
  "transcripts": true,
  "interrupt": true,
  "approvals": false,
  "tools": false,
  "skills": false,
  "automations": false,
  "collab": true,
  "buildQueue": false,
  "projectWorkbench": false
}
```

`collab` is true only when the adapter behaves as a conversation participant. It
does not imply that the runtime can run shell commands, edit files, expose an
approval inbox, or join the build queue. Build queue and Project Workbench still
require Hermes worker APIs.

## Error codes

| Status | Meaning |
| --- | --- |
| `400` | Invalid prompt, name or request body. |
| `401` | The Orbit gateway bearer token was missing or wrong. |
| `404` | Unknown command or conversation. |
| `409` | Configuration problem, missing key, unsafe key-file permissions, or the conversation already has an active run. |
| `413` | Request body exceeds the adapter limit. |
| `502` | The upstream endpoint refused, returned invalid JSON, or attempted a redirect. |
| `504` | The upstream request exceeded its time limit. |

An upstream `401` or `403` is reported as `502`: the Orbit gateway token is not
the provider key, and an upstream authentication failure must not read as an
Orbit authorization failure. Error text is bounded and scrubbed of the key.

## Event stream

`GET /events` is server-sent events. Each frame is:

```
data: {"channel":"run","payload":{"agentId":"oai_...","kind":"prompt","nonce":"..."}}

```

Channels used today:

- `note`: lifecycle and readiness, for example `{ kind: "connected" }` or
  `{ kind: "created", agentId, text }`.
- `run`: `{ kind: "prompt" }`, `{ kind: "settled", text }`,
  `{ kind: "failed", text }`, or `{ kind: "aborted", text }`.
- `message`: assistant text, with `streaming: true` for partial text.
- The Grok and Pi gateways also use `tool` frames; the OpenAI-compatible adapter
  has no tool surface, so it emits none.

Comment frames (`: keep-alive`) keep idle connections alive. Clients must drop
events whose `agentId` is not the conversation they are viewing. The feed does
not replay history.

## OpenAI-compatible adapter

`createOpenAICompatGateway({ id, label, baseUrl, model, apiKeyEnv, apiKeyFile, fetchImpl, runtimeDir, now })`
returns an object with `handle`, `events`, the gateway commands above, `listModels`,
`capabilities`, `archiveAgent`, `describe` and `close`. `startOpenAICompatGateway`
wraps the same object in a loopback HTTP listener when a process-level gateway is
needed.

### Endpoint shape

- `baseUrl` must be a plain `http` or `https` origin, optionally with a path such
  as `/v1`. Credentials, a query, a fragment, or another scheme are rejected.
  Loopback is allowed.
- Send: `POST {baseUrl}/chat/completions` with an OpenAI Chat Completions body.
- Models: `GET {baseUrl}/models` is used by `listModels`, and to pick the first
  listed model when `model` is omitted.
- Streaming is requested first with `stream: true` and `Accept: text/event-stream`.
  A JSON reply to a streaming request is parsed directly. If the endpoint rejects
  streaming with a fallback status, the adapter retries once with `stream: false`.
- Redirects are never followed. A `3xx` response is an error, so a key cannot be
  forwarded to another host.
- `AbortController` cancels the in-flight request for `interruptAgentRun`.

### Keys

The key is resolved at request time, in this order:

1. the environment variable named by `apiKeyEnv`, when set and non-empty;
2. the file named by `apiKeyFile`.

A key file must be an absolute path to a regular, non-symlink file with mode
`0600`. The adapter rejects a looser mode. No key is required when `apiKeyEnv` and
`apiKeyFile` are both absent, which is the normal case for a local endpoint such
as Ollama. The key is never logged, never returned by a command, and is replaced
with `[redacted]` in any error text. Conversation stores and transcripts are
written with mode `0600` under `runtimeDir`.

### Transcript and runs

Each conversation is an adapter-side agent with an `oai_` id. The transcript is
one bounded JSONL file per conversation under `runtimeDir`; the store is
`agents.json`. A send records the user entry immediately and the assistant entry
when the turn settles. A rejected turn records an assistant message that names the
provider failure, so the pane shows the real reason instead of a plausible reply.
An interrupt keeps any partial text and appends a stop notice.

### Models and tools

The adapter lists models from the endpoint when available. It does not invent a
model, a tool, an approval, a schedule or a skill. `model` is optional; without it,
the first model the endpoint lists is used.

## How today's providers map

| Provider | Transport | Mapping |
| --- | --- | --- |
| Hermes | Hermes run API | Orbit starts a run, polls status, streams messages and activity, and uses Hermes tool and approval surfaces. It is not the gateway command set. |
| Grok Bot | Agent gateway on loopback | `listAgents`, `createAgent`, `sendPrompt`, transcript tail, acceptance status, interrupt and events. The host owns tools and approvals. |
| Pi | Orbit-hosted gateway or external gateway | The same command set on top of a Pi process per conversation. Pi owns its tools and permission model; extension dialogs are cancelled. |
| Any OpenAI-compatible endpoint | This module | The same command set on top of Chat Completions. No native tools, approvals, schedules or skills. |

The adapter contract is the common part. Orbit's pane does not grow a second copy
of chat, run tracking or history for each provider.

## Adding OpenCode or Codex

An OpenAI-compatible endpoint, including an OpenCode Go endpoint, can use
`server/openai-compat-gateway.mjs` as-is: set `baseUrl`, `model`, and either
`apiKeyEnv` or a `0600` `apiKeyFile`. No new gateway code is needed when that
service speaks Chat Completions.

A runtime with its own protocol needs a small adapter with the same commands:

1. Keep one Orbit conversation identity and one runtime session identity, and
   persist the mapping in the runtime directory with mode `0600`.
2. Translate `sendPrompt` into the runtime's own turn start. Resolve the run as
   `accepted`, `rejected` or `cancelled`; never synthesize assistant text.
3. Translate `getAgentTranscriptTail` from the runtime's events into ordered
   `{ seq, id, at, kind, role, content }` entries.
4. Map `interruptAgentRun` to the runtime's cancel operation and abort the local
   request when it has one.
5. Implement `listAgents`, `createAgent`, `promptAcceptanceStatus` and
   `GET /events`. Report absent tools, approvals, schedules and skills as absent.
6. Add a hermetic test against a local fake server. No network, real key, host
   name, or personal path belongs in that test.

For a Codex-style runtime whose protocol is not Chat Completions, implement the
same adapter surface directly rather than emulating a model endpoint. Keep the
capability flags honest: an adapter that cannot run tools must say so.

## Configuration example

`config/agents.example.json` shows three documented examples: a local endpoint
without a key, a hosted endpoint that reads a key from an environment variable,
and a second hosted endpoint with the same key-source pattern. Copy the shape into
your private configuration. Do not commit real keys, and do not use a `.example`
origin in production.

## Tests

`tests/openai-compat-gateway.test.mjs` starts a local fake OpenAI server on
`127.0.0.1` and covers listing and creating conversations, streaming and
non-streaming sends, transcript tails, interruption, key-file permissions,
redaction in payloads and errors, a refused cross-host redirect, model listing,
and the live event feed. The tests inject the runtime directory, environment and
fetch implementation; they never read the owner's home directory or contact a
real provider.
