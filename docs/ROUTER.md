# Optional built-in token router

Orbit can route model traffic for all of your agents through one local gateway.
This is an **opt-in** feature: it is off by default, and when it is off Orbit
renders no profile, writes no router configuration, starts no container or
process and listens on no port. A direct provider configuration remains the
default path and never depends on this feature.

The router is useful when several agents or roles should share one URL, one set
of upstream credentials and per-role budgets instead of repeating provider keys
in every agent. It is not required for a first deployment, and it is not needed
for the OpenCode free models described at the end of this page.

## What the three modes mean

| Mode | What runs locally | Use it when |
| --- | --- | --- |
| Built-in router (Bifrost) | One container, internal compose network | You want budgets, virtual keys and fallbacks managed by Orbit |
| Built-in router (LiteLLM, Advanced) | One container, internal compose network | You specifically need LiteLLM coverage and accept its larger footprint |
| External router | Nothing | You already run a compatible router elsewhere, or use one hosted endpoint |

`components.router` and `router.enabled` in `orbit-config.json` must agree. When
`router.enabled` is false, Orbit skips rendering and never calls the supervisor's
start path. Provider kind `router` (id `router`) is the identity that roles
reference; it is not a generic pass-through for a free tier.

## Engine choice

**Bifrost is the default.** It is a single Go container with a file-only
configuration, no database, a small idle footprint and OpenAI- and
Anthropic-compatible endpoints. The pinned release is:

```
maximhq/bifrost:v2.5.1@sha256:5ec9873acaf1687556b6e4dd854b92b539d9debf87a5a683b66338648b84d3c8
```

Two management-API remote-code-execution issues in 2026 were fixed in earlier
v2 releases; stay at or above the pinned version and keep management
authentication enabled.

**LiteLLM is offered only under the Advanced disclosure.** It has wider provider
coverage, but in 2026 it had two supply-chain compromises (the March package
incident and the October image/tag incident), plus a SQL-injection issue and an
SSRF issue fixed in later releases. It also needs more memory and a database for
virtual keys. Orbit pins one reviewed digest and never installs LiteLLM from a
package index at runtime:

```
litellm/litellm:v1.108.6-lts@sha256:c64fe10f82a1f77906f88574f954317c50f67c617e0c97b70ac8fc61b74d3ec3
```

Do not substitute `latest`, `main-latest` or another floating tag. If an image is
not pinned by digest, the supervisor refuses to start it.

## External router mode

External mode runs nothing locally. Configure one base URL and one key reference;
Orbit stores the key under the runtime directory and probes the endpoint's models
route server-side. This mode never invokes the container supervisor or writes a
compose profile. It is suitable for a router you operate elsewhere or for a
hosted OpenAI-compatible endpoint, subject to that service's own policy and
retention terms.

## What runs, and where

When a built-in engine is enabled, Orbit writes:

- `runtime/router/router.env` (mode 0600, parent directory 0700)
- `runtime/router/data/config.json` for Bifrost, or `config.yaml` for LiteLLM
  (mode 0600)
- `runtime/keys/router-vk-<role>.key` for each role (mode 0600)
- `COMPOSE_PROFILES=router` in the runtime `.env`, preserving other lines

The supervisor runs exactly `docker compose --profile router up -d router`.
Because the service carries `profiles: ["router"]`, an ordinary
`docker compose up` starts nothing router-related. The container runs read-only,
as a non-root user, with all capabilities dropped, `no-new-privileges`, a 512 MB
memory limit and `GOMEMLIMIT=450MiB`.

### Ports

No host port is published by default. Containers on the compose network use
`http://router:8080`. A host-run agent needs the commented loopback publish
`127.0.0.1:8080:8080` and `router.bind: "loopback"`. Never publish the router on
`0.0.0.0` or a LAN address. External mode has no local listener at all.

## Key handling

- Upstream keys stay in `runtime/keys/<provider>.key` (mode 0600). The renderer
  emits only `env.<NAME>` references; the supervisor copies values into the 0600
  `router.env` and nowhere else.
- `orbit-config.json` contains no secret values, only key-file references.
- Bifrost's file configuration uses `config_store.enabled: false`, an encryption
  key referenced through the environment, management authentication, content
  logging off and `drop_excess_requests: true`.
- LiteLLM configuration uses `os.environ/<NAME>` references, an environment-held
  master key and salt key, and `disable_env_credential_login: true`.
- Virtual keys are generated server-side as `sk-bf-` plus 32 random bytes. They
  are written to the role's 0600 file and are never returned in API status
  output. Logs redact `Authorization`, `x-api-key`, `x-bf-vk` and `sk-` values.
- Rotation replaces one role's key file. Disabling the router keeps upstream
  keys but deletes generated router configuration and virtual keys.

## Virtual keys and budgets

Each routed role gets its own virtual key with an allow-list, a dollar budget, a
rate limit and an optional expiry. Default budgets are editable during setup:

| Role | Default budget | Reset |
| --- | --- | --- |
| `setup` | $2 | daily |
| `chat` | $10 | monthly |
| `workers` | $20 | monthly |
| `summarize` | $2 | monthly |

Agents receive a role-specific base URL and key file, not the upstream
credentials. The registry projection is an OpenAI-compatible entry whose base
URL is `http://router:8080/v1` (or `http://127.0.0.1:8080/v1` for loopback) and
whose key file is `router-vk-<role>.key`.

Private-network upstreams are blocked unless that provider explicitly permits
them (the private-network option in the setup flow). Self-hosted
OpenAI-compatible servers use a custom provider with an OpenAI base type.

## Health

The Orbit server polls `GET /health` on the built-in router and only then issues
virtual keys and marks the router installed. External mode probes
`GET {baseUrl}/models` with the external key server-side. There is deliberately
no compose healthcheck that assumes `wget` or another tool exists inside the
image. Settings show the current health and the pinned image.

## Upgrade and rollback

Upgrades are explicit and digest-based. Orbit never auto-pulls a moving tag and
never runs a package install. To upgrade, switch `router.image` to the reviewed
digest, re-render and restart, then run a models request as a smoke test. Keep
the previous digest for one-step rollback. To roll back, pin the previous digest,
re-render and restart. Do not reuse a container from another digest.

## Turning it off

Turning the router off requires confirmation. Orbit runs
`docker compose --profile router down router`, removes `COMPOSE_PROFILES=router`
from the runtime `.env`, and deletes `router.env`, the generated config and the
`router-vk-*.key` files. Upstream key files are retained unless you delete them.
The router status then reports disabled and no process or listener remains.

## Security checklist

- [ ] Off by default; no render, profile, process or port unless opted in.
- [ ] No host port by default; loopback only, never `0.0.0.0`.
- [ ] Image pinned by digest; never `latest`; no PyPI install at runtime.
- [ ] Bifrost at the reviewed version or later with management auth enabled.
- [ ] LiteLLM only if needed, digest-pinned, with master and salt keys from the
      environment and environment credential login disabled.
- [ ] Upstream keys only in 0600 files; masked or absent in API responses and
      redacted in logs.
- [ ] One virtual key per role with a model allow-list, budget and rate limit.
- [ ] Content logging off; usage metadata only.
- [ ] Container is read-only, non-root, capability-dropped and memory-limited.
- [ ] Private-network upstreams blocked unless explicitly allowed per provider.
- [ ] Disabling removes the service, generated config and virtual keys.
- [ ] Health-gated status, post-change smoke test and a kept rollback digest.
- [ ] The workspace UI stays in the existing dark theme; no light-theme variant
      is introduced by this feature.

## OpenCode free models stay direct

OpenCode Zen free models are gated to OpenCode's own clients and cannot be
fronted by any router. They remain a direct `opencode-free` provider used only by
the OpenCode adapter. A paid OpenCode Zen key can be a router upstream because it
is an ordinary OpenAI-compatible credential, but the free tier is separate.
