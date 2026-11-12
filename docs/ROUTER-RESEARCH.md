# Built-in token router for Orbit — best-practice research (Nov 12, 2026)

Scope: an optional, self-hosted LLM token router that Orbit (mojomast/orbitdesktop) can install and configure from the onboarding wizard, as an alternative to configuring each provider directly. **Hard constraint from Kyle: opt-in, off by default; when not selected, nothing runs** (no container, no process, no port, no config file).

## Recommendation

- **Default router: Bifrost** (maximhq/bifrost, Apache-2.0, Go). One container, no database needed (file-only `config.json` with `config_store.enabled: false`), 128–319 MB idle RAM, ~104 MB compressed image. OpenAI-compatible `/v1/*` and Anthropic-compatible `/anthropic/v1/messages`; virtual keys with per-key budgets, token/request rate limits, model allow-lists and expiry, weighted load balancing and fallbacks, cost/token logging. Pin `v2.5.1` or later by digest (two 2026 management-API RCE CVEs were fixed in v2.0.0/v2.1.0).
- **Fallback router: LiteLLM proxy** (BerriAI/litellm, MIT core + proprietary `enterprise/`), offered as "Advanced" only. Widest provider coverage and the most governance in OSS, but needs Postgres for virtual keys, ~2 GB RAM with 3 workers, a 1.7 GB image, slow cold start, and it had **two supply-chain compromises in 2026** (PyPI 1.82.7/1.82.8 in March; PyPI + official Docker tags 1.107.0/latest/main-latest/main-stable on Oct 21) plus CVE-2026-42208 (unauth SQLi, fixed 1.83.7) and an SSRF (fixed 1.83.9). Only ever install by image digest, never `latest`.
- **Third path, zero processes: "External router"** — the user pastes one URL + one key (OpenRouter, or their own LiteLLM/Bifrost elsewhere). Nothing runs locally.
- **Watch: agentgateway** (Linux Foundation, Rust, Apache-2.0): standalone binary, YAML config, virtual keys + token/dollar budgets (SQLite). Promising, younger LLM feature set; revisit as a lighter fallback.
- **Rejected:** TensorZero (repo archived June 12, 2026), Portkey OSS gateway (no virtual keys in released 1.15.2, no release since Jan 2026, open log stream leaks prompts/keys unless `NODE_ENV=production`, 2.0 unreleased after Palo Alto acquisition), Helicone gateway (GPL-3.0, maintenance mode), Kong AI Gateway (heavy unless you already run Kong).
- **OpenCode free models cannot be fronted by any router.** OpenCode Zen free models are user-agent-gated and policy-restricted to OpenCode's own clients. Keep them as a direct "opencode-free" provider that only the OpenCode adapter uses. A paid OpenCode Zen key (OpenAI-compatible at `https://opencode.ai/zen/v1`) can be a router upstream.

## Comparison

| | Bifrost | LiteLLM proxy | agentgateway | Portkey OSS | TensorZero |
|---|---|---|---|---|---|
| License | Apache-2.0 (enterprise build separate) | MIT + proprietary `enterprise/` | Apache-2.0 (LF) | MIT | Apache-2.0 |
| Language | Go | Python | Rust | TypeScript/Node | Rust |
| Idle RAM | 128 MB (no log store) – 319 MB | 541 MB (1 worker) – 2.1 GB (3 workers) + Postgres | small single binary | ~36 MB | small |
| Image | ~104 MB compressed / 412 MB disk | ~403 MB compressed / 1.72 GB disk | single binary | small | one container |
| OpenAI-compat | yes | yes | yes | yes | yes (`/openai/v1`) |
| Anthropic-compat | yes (`/anthropic`) | yes (`/v1/messages`) | yes | partial | no native |
| Fallbacks / LB | weighted, retries (circuit breaker = enterprise) | router: retries, cooldowns, fallbacks | yes | yes (JSON config) | yes |
| Virtual keys + budgets | yes, in file or DB; $ budgets, token/request limits, expiry | yes, needs Postgres | yes, SQLite for budgets | no (released) | auth only |
| Cost/token tracking | yes, SQLite log store | yes, Postgres spend logs | yes | hosted only | needs Postgres/ClickHouse |
| Caching | exact + semantic | exact (Redis) + semantic | — | in-memory | yes |
| Config | file-only possible | YAML + Postgres for keys | YAML (+SQLite) | per-request headers | TOML |
| Maturity / security | active; 2 RCE CVEs fixed 2026; private-network SSRF guard on by default | very active; 2 supply-chain incidents + SQLi + SSRF in 2026 | young | stalled | archived Jun 2026 |

Measured comparison source (Bifrost v2.4.0 vs LiteLLM v1.106.6, Nov 2026): +2.4 ms vs +30–55 ms p50 overhead at 100 req/s; both passed key-429 and killed-backend failover with 0 failed requests; streaming TTFT within ~20–40 ms of direct for both.

## How to run it inside Orbit (opt-in)

### Packaging: sidecar container, gated by a compose profile
- Compose: the router service carries `profiles: ["router"]`. Services with a profile do not start unless the profile is active, so a default `docker compose up` / `npm run up` starts **nothing** router-related.
- The wizard activates it only when chosen, by writing `COMPOSE_PROFILES=router` to Orbit's runtime `.env` (and removing it when the user turns the router off; then `docker compose --profile router down router`).
- Non-Docker installs (systemd / `npm start`): Orbit's supervisor runs the router as a **subprocess** only when `components.router === true`, using a checksum-pinned binary Orbit downloaded at install time (not `npx @latest`). No embedded Node library: the only Node option (Portkey) lacks virtual keys and is stalled.

```yaml
services:
  orbit:
    # ...existing service, unchanged
  router:
    profiles: ["router"]            # off unless COMPOSE_PROFILES=router
    image: maximhq/bifrost:v2.5.1@sha256:<digest-pinned-by-orbit-release>
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    user: "10001:10001"
    env_file: ./runtime/router/router.env   # 0600, generated, gitignored
    environment:
      GOMEMLIMIT: 450MiB
    volumes:
      - ./runtime/router/data:/app/data      # config.json (0600) + logs.db
    networks: [orbit-internal]
    # No host port by default. Only if host-run agents need it:
    # ports: ["127.0.0.1:8080:8080"]
    mem_limit: 512m
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/health"]   # confirm tool exists in image; else Orbit polls /health
      interval: 15s
      timeout: 3s
      retries: 5
networks:
  orbit-internal:
    internal: false   # router needs egress to providers; not published to host
```

### Config generated by the wizard (Bifrost file-only)
- Orbit renders `runtime/router/data/config.json` from `orbit-config.json` + key files. Upstream keys appear only as `env.<NAME>` references; actual values live in `router.env` (0600) which Orbit writes from `runtime/keys/*.key`.
- `config_store.enabled: false` (file is the single source of truth; changes = re-render + restart router).
- `encryption_key: env.BIFROST_ENCRYPTION_KEY` (32 random bytes generated by Orbit).
- Management auth on with a generated setup token; management UI never exposed to the browser directly (Orbit server proxies read-only usage stats if wanted).
- Content logging off by default (metadata/tokens/cost only).
- One virtual key per role: `setup`, `chat`, `workers`, `summarize` (optionally per agent), each with allowed models, a $ budget + reset window, token/request rate limits.
- Local model servers (Ollama/vLLM on LAN): Bifrost blocks private-network upstreams by default; set `allow_private_network: true` only on that provider, and use a custom provider with `base_provider_type: openai` for self-hosted OpenAI-compatible URLs (built-in `openai` ignores `base_url`).

### Secrets handling
- Upstream keys: `runtime/keys/<provider>.key` (0600, dir 0700) → rendered into `runtime/router/router.env` (0600). Never in `orbit-config.json`, never in compose files, never in git.
- Virtual keys: generated server-side (`crypto.randomBytes`, `sk-bf-` prefix), stored in `runtime/keys/router-vk-<role>.key` 0600, injected into each agent's config/env by Orbit's server. API responses show masked only (last 4 or "set").
- Logs: redact `Authorization`, `x-api-key`, `x-bf-vk`, `sk-` patterns in Orbit logs; router content logging off.
- Docker secrets are an alternative to env_file for Swarm/compose-file `secrets:`, but Bifrost reads `env.*`, so an env_file (0600) is the simplest correct choice.

### Pointing agents at it
- OpenAI-style base URL: `http://router:8080/v1` from containers on the compose network, `http://127.0.0.1:8080/v1` from host processes (only if the loopback port is enabled). Key = that role's virtual key.
- Anthropic-style: `http://router:8080/anthropic` (e.g. `ANTHROPIC_BASE_URL`), key = virtual key.
- Pi agent: custom provider with that base URL + virtual key (OpenAI-compatible).
- OpenCode: custom provider via `@ai-sdk/openai-compatible` with `baseURL` pointing at the router — for paid/router models only. **Free OpenCode models stay direct** (router cannot front them).
- Hermes: custom OpenAI-compatible endpoint (base URL + key) in its config.
- bundlebees DeepSeek workers: OpenAI-compatible base URL + the `workers` virtual key (budget-capped, rate-limited, model allow-list = DeepSeek models).
- Orbit's `toRegistryConfig()` emits `{ baseUrl: <router>, apiKeyFile: router-vk-<role>.key, model }` for each role routed via the router.

### Health and upgrades
- Readiness: Orbit waits for `/health` before marking `installState.router = installed`; shows status in Settings.
- Upgrades: Orbit releases pin router image digests; Settings shows "update available"; user-confirmed; keep previous digest for one-click rollback; re-render config and run a smoke request (`/v1/models` with the setup VK) after upgrade.
- Never auto-pull `latest`. Verify digest/checksum before start.

## Wizard (router path only appears if chosen)

1. **Choose what to install** — "Token router (optional, off)" toggle, with one line: "Runs a local gateway so every agent uses one URL with its own budget. Not needed for OpenCode free models." Engine select (Bifrost default; LiteLLM under Advanced).
2. **Providers and keys** — choose: *Direct providers* (today's flow) | *Built-in router* (only if toggled in step 1) | *External router* (one URL + key). For built-in router: add upstream providers + keys (masked), optional local model server with an explicit "allow private network" checkbox.
3. **A model for each part** — model list pulled from the router's `/v1/models`; per role set model + monthly budget + rate limit (sane defaults: setup $2/day, chat $10/mo, workers $20/mo, summarize $2/mo — editable). OpenCode-free stays selectable for roles served by the OpenCode adapter.
4. **Review and apply** — shows what will run ("1 container: router, localhost-only, ~300 MB RAM") or "nothing extra" if not selected. Apply: write keys → render config → set `COMPOSE_PROFILES=router` (or start subprocess) → wait for health → issue virtual keys → wire agents → smoke test.
5. **Settings later** — turn off (stops + removes service, deletes generated config and virtual keys after confirmation; upstream keys kept unless user deletes them), change budgets, rotate keys, upgrade.

## Config schema additions (orbit-config.json, schemaVersion 1 → 2 or additive)

```json
{
  "components": { "router": false },
  "router": {
    "enabled": false,
    "mode": "builtin | external",
    "engine": "bifrost | litellm",
    "image": "maximhq/bifrost:v2.5.1@sha256:...",
    "bind": "internal | loopback",
    "port": 8080,
    "contentLogging": false,
    "allowPrivateNetwork": false,
    "upstreams": [ { "providerId": "openrouter", "weight": 1, "models": ["*"] } ],
    "fallbacks": [ { "model": "deepseek-chat", "then": ["openrouter/deepseek/deepseek-chat"] } ],
    "virtualKeys": [
      { "role": "workers", "keyRef": { "file": "router-vk-workers.key" },
        "allowedModels": ["deepseek-chat"],
        "budget": { "usd": 20, "reset": "1M" },
        "rateLimit": { "requests": 600, "tokens": 2000000, "reset": "1h" },
        "expiresAt": null }
    ],
    "external": { "baseUrl": "https://openrouter.ai/api/v1", "keyRef": { "file": "external-router.key" } }
  },
  "providers": [ { "id": "router", "kind": "router", "label": "Built-in router" } ],
  "roles": { "workers": { "provider": "router", "model": "deepseek-chat" } }
}
```
Rules: `router.enabled` false ⇒ no render, no profile, no process; `components.router` and `router.enabled` must agree; no secret values anywhere in this file.

## Security checklist

- [ ] Off by default; nothing runs or listens unless the user opts in.
- [ ] No host port by default; if enabled, `127.0.0.1` only. Never `0.0.0.0`.
- [ ] Image pinned by digest (or binary by checksum); never `latest`; no PyPI install at runtime.
- [ ] Bifrost ≥ v2.1.0 (prefer ≥ v2.5.1); management auth + setup token on; management UI not exposed.
- [ ] If LiteLLM: digest-pinned, ≥ safe versions (not 1.82.7/1.82.8/1.107.0; ≥ 1.83.9 for CVEs), `disable_env_credential_login`, master key + salt key generated, Postgres on internal network only.
- [ ] Upstream keys only in 0600 files; masked in every API response; redacted in logs.
- [ ] One virtual key per role/agent with budget, rate limit, model allow-list; rotate on demand.
- [ ] Content logging off; usage metadata only.
- [ ] Container: read-only rootfs, non-root user, `cap_drop: ALL`, `no-new-privileges`, memory limit + `GOMEMLIMIT`, `drop_excess_requests: true` so overload sheds instead of OOM.
- [ ] Private-network upstreams blocked unless explicitly allowed per provider (SSRF guard).
- [ ] Disabling the router removes the service, generated config and virtual keys.
- [ ] Health check gates "installed"; post-upgrade smoke test; rollback digest kept.

## Sources
- LiteLLM March 2026 incident: https://docs.litellm.ai/blog/security-update-march-2026
- PyPI incident report: https://blog.pypi.org/posts/2026-04-02-incident-report-litellm-telnyx-supply-chain-attack/
- LiteLLM Oct 21 2026 incident: https://docs.litellm.ai/blog/security-incident-oct-21-2026
- Microsoft analysis of 1.107.0: https://www.microsoft.com/en-us/security/blog/2026/10/23/inside-the-litellm-1-107-0-supply-chain-compromise-credential-theft-through-python-startup-hooks/
- Datadog analysis: https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-docker/
- LiteLLM CVE-2026-42208: https://docs.litellm.ai/blog/cve-2026-42208-litellm-proxy-sql-injection
- LiteLLM virtual keys (needs Postgres): https://docs.litellm.ai/docs/proxy/virtual_keys
- Bifrost vs LiteLLM benchmark (Nov 2026): https://computingforgeeks.com/litellm-vs-bifrost/
- Bifrost config.json modes: https://docs.getbifrost.ai/deployment-guides/config-json
- Bifrost virtual keys: https://docs.getbifrost.ai/features/governance/virtual-keys
- Bifrost Anthropic endpoint: https://www.getmaxim.ai/bifrost/guides/providers/anthropic
- Bifrost security advisories: https://github.com/maximhq/bifrost/security/advisories
- Bifrost Docker tags: https://hub.docker.com/r/maximhq/bifrost/tags
- Portkey review (Oct 2026): https://geekflare.com/open-source/portkey-gateway/
- TensorZero archived: https://github.com/tensorzero/tensorzero
- agentgateway virtual keys: https://agentgateway.dev/docs/standalone/latest/llm/cost-controls/virtual-keys/
- OpenCode Zen free-tier policy: https://github.com/anomalyco/opencode/issues/49144
