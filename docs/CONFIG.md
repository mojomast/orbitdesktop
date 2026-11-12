# Orbit configuration

`orbit-config.json` is the one owner-facing configuration document for the
first-run setup, provider choices, model roles and the optional token router. It
lives in the private runtime directory:

```
<runtime>/orbit-config.json
```

Set `ORBIT_CONFIG_FILE` to an absolute path to use a different document. A
relative override is refused so a working directory cannot silently change which
configuration Orbit reads. The JSON Schema is
[`config/orbit-config.schema.json`](../config/orbit-config.schema.json) (draft
2020-12). `schemaVersion` is `1`.

The file is written atomically with mode `0600`. It never contains an API key,
token, password or secret value. Keys are stored separately, by reference (see
[Key storage](#key-storage)).

## Top-level fields

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | `1`. Older writers refuse a different version. |
| `mode` | no | Setup path from wizard step 1: `minimal` (recommended) or `custom`. Absent means `custom`, so older files are unchanged. |
| `defaultModel` | minimal: yes | `{ "provider", "model" }` that every role inherits when its own `roles` entry is empty. |
| `components` | yes | What Orbit may install. Only `core` is required and always `true`. |
| `providers` | no | Provider definitions. Each contains only a key *reference*. |
| `roles` | no | Which provider and model each part of Orbit uses. |
| `router` | no | Optional token-router settings. Defaults to disabled. |
| `providerMode` | no | Compatibility summary: `direct` when the router is off, `router` when it is on. `router.enabled` is authoritative; Orbit rewrites this field on save. |
| `appliedAt` | no | ISO timestamp of the last review/apply action. |
| `installState` | no | Per-component `pending`, `installed`, `failed` or `skipped`. |

Unknown top-level fields are rejected. Provider, role and router objects also use
closed shapes: a misspelled field fails validation instead of being ignored.

## Components

| Component | Default | Purpose |
| --- | --- | --- |
| `core` | `true` | The local workspace and host server. Required. |
| `pi` | `false` | Optional Pi agent adapter. |
| `opencode` | `false` | Optional OpenCode CLI. Free OpenCode models require this client. |
| `hermes` | `false` | Optional Hermes runtime integration. |
| `bundlebees` | `false` | Optional bundled worker tooling. |
| `workerPairing` | `false` | Optional local worker pairing. |
| `colab` | `false` | Optional multi-agent project board. |
| `apps` | `[]` | Optional app ids to record for installation. |
| `router` | `false` | Optional token router. Must equal `router.enabled`. |

With zero providers and every optional component off, Orbit is still deployable:
core opens, and the wizard asks what to add. No agent runtime is assumed. Hermes,
Grok Bot, Pi, OpenCode and an OpenAI-compatible endpoint are all optional
adapters.

`components.router` and `router.enabled` must agree. If they differ, validation
fails instead of guessing which one the owner meant.

## Providers

Each provider has:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable id matching `^[a-z0-9][a-z0-9-]{0,31}$`; unique in the document. |
| `kind` | yes | `opencode-free`, `openai-compatible`, `openrouter`, `anthropic`, `pi` or `router`. |
| `label` | yes | Short owner-facing name (1–80 characters). |
| `baseUrl` | conditional | `http` or `https` URL. Required for `router`; loopback URLs are allowed. Credentials, query strings and fragments are refused. |
| `keyRef` | no | `{ "file": "<name>.key" }` or `{ "env": "ENV_NAME" }`. Exactly one form. |
| `privacyNote` | no | Short note shown with the provider (up to 500 characters). |
| `routerType` | router only | `hosted` or `self-hosted`. Forbidden on other kinds. |

`opencode-free` providers stay direct and are used only by the OpenCode adapter.
Free OpenCode models cannot be fronted by a token router: they are
user-agent-gated and restricted to OpenCode's own clients. Add the provider
without a router and let the OpenCode adapter run it with
`opencode run --model opencode/<id>`.

When the router is enabled there is exactly one provider of kind `router`, and its
id is `router`. The wizard creates it. A distinct upstream provider is not a
router provider.

## Setup modes: Minimal install and Custom

Step 1 of the wizard offers two paths.

**Minimal install** (recommended, preselected). Pick one provider (a direct
provider, or an external router) and one model. That model is used for every
role: setup agent, chat, bee workers and summarizing (and compaction or vision
when those roles are present). Only the minimal components are installed: core
Orbit plus the one first-agent adapter that matches the provider (`opencode` for
OpenCode free, `pi` for Pi, none extra for OpenAI-compatible, OpenRouter,
Anthropic or an external router). The built-in router, bundlebees, worker
pairing, Colab and optional apps stay off. The wizard then skips the model step
and goes straight to Review and apply.

```json
{
  "schemaVersion": 1,
  "mode": "minimal",
  "defaultModel": { "provider": "opencode", "model": "deepseek-v4.1-flash-free" },
  "components": { "core": true, "pi": false, "opencode": true, "hermes": false, "bundlebees": false, "workerPairing": false, "colab": false, "apps": [], "router": false },
  "providers": [ { "id": "opencode", "kind": "opencode-free", "label": "OpenCode free" } ],
  "roles": {
    "setup": { "provider": "", "model": "" },
    "chat": { "provider": "", "model": "" },
    "workers": { "provider": "", "model": "" },
    "summarize": { "provider": "", "model": "" }
  }
}
```

Rules: minimal mode requires `defaultModel`, whose provider must exist in
`providers`; minimal mode rejects an enabled built-in router (an external router
is allowed because it starts nothing locally). Choose Custom to install the
built-in router.

**Overrides.** Any role can be overridden later in Settings by giving it its own
provider and model; the other roles keep inheriting `defaultModel`. Clearing the
override (empty provider and model) falls back to `defaultModel` again.
Switching from Minimal to Custom writes the effective model of every role into
`roles`, so nothing changes until you edit them.

**Custom** is the granular path: choose components, configure providers or a
router, then pick a model for each role. Files without `mode` behave as Custom
exactly as before.

Code reads the effective mapping with `resolveRoles(config)` from
`server/orbit-config.mjs`; `buildMinimalConfig({ provider, model, keyRef? })`
builds a validated minimal document and `switchToCustom(config)` materializes
roles.

## Roles

Four roles are defined, with optional extras:

| Role | Used for |
| --- | --- |
| `setup` | The setup agent that installs selected components. |
| `chat` | Ordinary conversation. |
| `workers` | Background or paired workers. |
| `summarize` | Conversation and document summaries. |
| `compaction` | Optional context compaction. |
| `vision` | Optional image understanding. |

Each role is `{ "provider": "<provider id>", "model": "<model id>" }`. An empty
provider/model means “not chosen yet”; a non-empty provider must exist in
`providers`. A role that uses the router names the `router` provider and one model
id from the router's model list. The same shape works for direct providers.

Default per-role router budgets, editable in the model step and later in
Settings:

| Role | Budget | Reset |
| --- | --- | --- |
| `setup` | 2 USD | 1 day |
| `chat` | 10 USD | 1 month |
| `workers` | 20 USD | 1 month |
| `summarize` | 2 USD | 1 month |

## Provider paths

### Path 1 — direct providers

The default. Each provider is reached directly and each role references the
provider it needs. This is the only path for `opencode-free`.

```json
{
  "schemaVersion": 1,
  "providerMode": "direct",
  "components": {
    "core": true,
    "pi": false,
    "opencode": true,
    "hermes": false,
    "bundlebees": false,
    "workerPairing": false,
    "colab": false,
    "apps": [],
    "router": false
  },
  "providers": [
    {
      "id": "local",
      "kind": "openai-compatible",
      "label": "Local models",
      "baseUrl": "http://127.0.0.1:8000/v1",
      "keyRef": { "file": "local.key" },
      "privacyNote": "Runs on this machine."
    },
    {
      "id": "openrouter",
      "kind": "openrouter",
      "label": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "keyRef": { "file": "openrouter.key" }
    },
    {
      "id": "opencode-free",
      "kind": "opencode-free",
      "label": "OpenCode free",
      "privacyNote": "Free models run only through the OpenCode client."
    }
  ],
  "roles": {
    "setup": { "provider": "local", "model": "small-model" },
    "chat": { "provider": "openrouter", "model": "chat-model" },
    "workers": { "provider": "local", "model": "worker-model" },
    "summarize": { "provider": "local", "model": "small-model" }
  }
}
```

### Path 2 — built-in token router

The router is opt-in. With `components.router` and `router.enabled` both `false`,
nothing router-related is rendered, configured or started: no container, no
process, no port and no router profile. The wizard defaults to direct providers
and leaves the router unchecked.

The default engine is Bifrost. LiteLLM is available under an **Advanced**
disclosure. Both use pinned image digests and never `latest`:

| Engine | Pinned image |
| --- | --- |
| Bifrost | `maximhq/bifrost:v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8` |
| LiteLLM | `litellm/litellm:v1.108.6-lts@sha256:c64fe10f82a1f77906f88574f954317c50f67c617e0c97b70ac8fc61b74d3ec3` |

Orbit never installs a router from PyPI at runtime and never uses a floating tag.

```json
{
  "schemaVersion": 1,
  "providerMode": "router",
  "components": {
    "core": true,
    "pi": false,
    "opencode": true,
    "hermes": false,
    "bundlebees": false,
    "workerPairing": false,
    "colab": false,
    "apps": [],
    "router": true
  },
  "providers": [
    {
      "id": "openrouter",
      "kind": "openrouter",
      "label": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "keyRef": { "file": "openrouter.key" }
    },
    {
      "id": "anthropic",
      "kind": "anthropic",
      "label": "Anthropic",
      "baseUrl": "https://api.anthropic.com",
      "keyRef": { "file": "anthropic.key" }
    },
    {
      "id": "router",
      "kind": "router",
      "label": "Built-in token router",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "routerType": "self-hosted"
    }
  ],
  "roles": {
    "setup": { "provider": "router", "model": "small-model" },
    "chat": { "provider": "router", "model": "chat-model" },
    "workers": { "provider": "router", "model": "worker-model" },
    "summarize": { "provider": "router", "model": "small-model" }
  },
  "router": {
    "enabled": true,
    "mode": "builtin",
    "engine": "bifrost",
    "image": "maximhq/bifrost:v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8",
    "bind": "loopback",
    "port": 8080,
    "contentLogging": false,
    "allowPrivateNetwork": false,
    "upstreams": [
      { "providerId": "openrouter", "weight": 1, "models": ["*"] },
      { "providerId": "anthropic", "weight": 1, "models": ["*"] }
    ],
    "fallbacks": [
      { "model": "chat-model", "then": ["small-model"] }
    ],
    "virtualKeys": [
      {
        "role": "setup",
        "keyRef": { "file": "router-vk-setup.key" },
        "allowedModels": ["small-model"],
        "budget": { "usd": 2, "reset": "1d" },
        "rateLimit": { "requests": 100, "tokens": 200000, "reset": "1h" },
        "expiresAt": null
      },
      {
        "role": "chat",
        "keyRef": { "file": "router-vk-chat.key" },
        "allowedModels": ["chat-model", "small-model"],
        "budget": { "usd": 10, "reset": "1mo" },
        "rateLimit": { "requests": 600, "tokens": 2000000, "reset": "1h" },
        "expiresAt": null
      },
      {
        "role": "workers",
        "keyRef": { "file": "router-vk-workers.key" },
        "allowedModels": ["worker-model"],
        "budget": { "usd": 20, "reset": "1mo" },
        "rateLimit": { "requests": 600, "tokens": 2000000, "reset": "1h" },
        "expiresAt": null
      },
      {
        "role": "summarize",
        "keyRef": { "file": "router-vk-summarize.key" },
        "allowedModels": ["small-model"],
        "budget": { "usd": 2, "reset": "1mo" },
        "rateLimit": { "requests": 100, "tokens": 500000, "reset": "1h" },
        "expiresAt": null
      }
    ],
    "external": {
      "baseUrl": "",
      "keyRef": { "file": "external-router.key" }
    }
  }
}
```

`bind` is `internal` (reachable only on the deployment's private network) or
`loopback` (`127.0.0.1` only). The wizard never selects a public bind.
`contentLogging` defaults to `false`; usage metadata and cost accounting do not
require prompt/response content. `allowPrivateNetwork` defaults to `false` and
applies to the router as a whole; turn it on only when every upstream is a
loopback or LAN server the owner controls. The wizard shows a per-provider
checkbox that edits this one global policy.

### Path 3 — external router

One OpenAI-compatible endpoint that the owner already operates or subscribes to,
such as a hosted router or a LiteLLM/Bifrost proxy elsewhere. Orbit starts
nothing locally. The key is optional only for a loopback router the owner
controls.

```json
{
  "schemaVersion": 1,
  "providerMode": "router",
  "components": {
    "core": true,
    "pi": false,
    "opencode": false,
    "hermes": false,
    "bundlebees": false,
    "workerPairing": false,
    "colab": false,
    "apps": [],
    "router": true
  },
  "providers": [
    {
      "id": "router",
      "kind": "router",
      "label": "External router",
      "baseUrl": "https://router.example.com/v1",
      "routerType": "hosted"
    }
  ],
  "roles": {
    "setup": { "provider": "router", "model": "small-model" },
    "chat": { "provider": "router", "model": "chat-model" },
    "workers": { "provider": "router", "model": "worker-model" },
    "summarize": { "provider": "router", "model": "small-model" }
  },
  "router": {
    "enabled": true,
    "mode": "external",
    "engine": "bifrost",
    "image": "maximhq/bifrost:v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8",
    "bind": "internal",
    "port": 8080,
    "contentLogging": false,
    "allowPrivateNetwork": false,
    "upstreams": [],
    "fallbacks": [],
    "virtualKeys": [],
    "external": {
      "baseUrl": "https://router.example.com/v1",
      "keyRef": { "file": "external-router.key" }
    }
  }
}
```

`router.enabled` false means no profile and no process regardless of the other
router fields. Switching to direct providers sets `components.router` and
`router.enabled` to `false`. A stored router provider may remain in the document
so the owner can switch back, but Orbit ignores it while the router is off.

## Router fields

| Field | Meaning |
| --- | --- |
| `enabled` | Opt-in switch. Must equal `components.router`. |
| `mode` | `builtin` runs an engine locally; `external` uses one endpoint and runs nothing. |
| `engine` | `bifrost` (default) or `litellm` (Advanced). |
| `image` | Digest-pinned container image. `latest` is rejected. |
| `bind` | `internal` or `loopback`. Never public. |
| `port` | Local or internal router port, default `8080`. |
| `contentLogging` | Prompt/response logging. Default and recommended value `false`. |
| `allowPrivateNetwork` | Whether private-network upstreams are allowed. Default `false`. |
| `upstreams` | `{ providerId, weight, models }` entries. `models` is a list of model ids or `["*"]`. |
| `fallbacks` | `{ model, then }` ordered fallback preferences. |
| `virtualKeys` | One key per role: `keyRef` file, allowed models, budget, rate limit and expiry. |
| `external` | `baseUrl` and `keyRef` for the external path. |

Virtual-key entries use these fields:

| Entry field | Meaning |
| --- | --- |
| `role` | Role id this key belongs to, for example `chat` or `workers`. |
| `keyRef.file` | File under `<runtime>/keys/`; file references only. |
| `allowedModels` | Model ids this key may call, or `["*"]`. |
| `budget.usd` | USD budget for the reset window. Defaults come from the role table above. |
| `budget.reset` | Budget window: `Nm`, `Nh`, `Nd`, `Nw` or `Nmo`. |
| `rateLimit.requests` | Optional request cap for the window. |
| `rateLimit.tokens` | Optional token cap for the window. |
| `rateLimit.reset` | Rate-limit window. |
| `expiresAt` | `null` or an ISO date after which the virtual key is refused. |

`external.baseUrl` is the one OpenAI-compatible endpoint used by the external
path and `external.keyRef.file` points at its optional key file. Upstream entries
use `providerId`, a relative `weight` and a `models` allow-list. Fallback entries
name a `model` and the ordered `then` models to try after it.

Virtual keys are generated server-side and stored as
`<runtime>/keys/router-vk-<role>.key` with mode `0600`. The router configuration is
rendered from `orbit-config.json` plus key files. Upstream keys appear only as
environment/file references in the generated router configuration, never inline.
The generated router environment file is `0600`, and the proxy binds to loopback
or the deployment's private network with its own generated master key. The
management surface is not exposed directly to the browser.

## Key storage

Secrets live only in:

```
<runtime>/keys/                    mode 0700
<runtime>/keys/<provider>.key      mode 0600
<runtime>/keys/router-vk-<role>.key
<runtime>/keys/external-router.key
```

Rules:

- `orbit-config.json` stores only `keyRef`. A key value is never serialized into
  it, including when a provider is created or edited.
- `setKey(providerId, value)` writes the file atomically with mode `0600` and sets
  `keyRef.file` to `"<provider-id>.key"`. `clearKey(providerId)` removes the file
  and the reference.
- `keyRef.file` must be a basename ending in `.key`; traversal, separators and
  symlinks are refused. Environment references use an uppercase environment
  variable name and are resolved only on the server.
- `resolveKey(providerId)` is server-only and is never exported to a browser
  route. API responses use `view()`, which returns
  `{ "key": { "set": true, "masked": "sk-…abcd" } }` using at most the last four
  characters, or `{ "set": false, "masked": null }`.
- Keys never appear in logs, errors, events or model-list responses. A failing
  provider fetch returns `{ "models": [], "manual": true }`; its upstream error
  text is discarded because it can echo a request header.
- The OpenCode install route shows `npm i -g opencode-ai` first and requires
  `{ "confirm": true }`. It never installs on page load.

## How other modules read the document

`server/orbit-config.mjs` is the only writer and validator:

```js
import { createOrbitConfig } from './server/orbit-config.mjs';

const config = createOrbitConfig({ runtimeDir, env, fs });
config.load();                       // validated document
config.save(next);                   // validate + atomic 0600 write
config.view();                       // document plus masked provider key status
config.setKey(providerId, value);    // write keys/<id>.key, return masked
config.clearKey(providerId);
config.resolveKey(providerId);       // server-side only
config.toRegistryConfig();           // { agents: [...] } for the gateways
```

`toRegistryConfig()` emits one agent per chosen role:

```json
{
  "agents": [
    {
      "id": "chat",
      "kind": "router",
      "label": "Built-in token router",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "model": "chat-model",
      "apiKeyFile": "<runtime>/keys/router-vk-chat.key"
    }
  ]
}
```

Direct file references become `apiKeyFile`; environment references become
`apiKeyEnv`. The shape is consumed by the agent registry and the
OpenAI-compatible gateway. It never contains a key value.

`server/onboarding.mjs` exposes these owner routes (mounted by the coordinator):

| Route | Purpose |
| --- | --- |
| `GET state` | Validated document plus providers with masked key status. |
| `PUT components` | Update components and the router toggle/engine. |
| `GET providers` | Provider list with masked key status. |
| `POST providers` | Add or update a provider. |
| `DELETE providers/:id` | Remove a provider, its key and role references. |
| `POST providers/:id/key` | Store a key; response is masked only. |
| `DELETE providers/:id/key` | Clear a stored key. |
| `GET providers/:id/models` | Runtime model list; manual fallback on failure. |
| `GET opencode` | Read-only binary detection and the exact install command. |
| `POST opencode/install` | Requires `{ "confirm": true }`. |
| `POST apply` | Record `appliedAt` and pending/skipped install state. |

Routes call the injected router supervisor only when the router actually becomes
enabled or disabled. With `router.enabled` false, no supervisor call, profile,
process, port or generated router configuration exists.

Model lists are fetched at runtime. `openai-compatible`, `openrouter` and the
router call `GET {baseUrl}/models` with the key server-side; `anthropic` calls
`GET /v1/models`; `opencode-free` calls
`https://opencode.ai/inference/v1/models` and keeps models whose id ends in
`-free` or whose reported price is zero, attaching a privacy note. The preferred
free model is chosen at runtime from the returned list, never from documentation.
Any failure returns the manual-entry fallback.

## Settings

Everything here is editable after first run in Orbit Settings: components, the
router toggle/engine, provider keys, roles/models and budgets. Turning the router
off stops and removes the service and generated router configuration; upstream
key files stay unless the owner deletes them. None of these changes silently
start an install; the setup agent applies the reviewed plan.
