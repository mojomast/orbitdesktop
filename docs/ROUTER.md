# Optional token router

**Leave the router unchecked to use direct providers.** On a fresh install,
Orbit writes no router files, enables no router profile and opens no router
port. The included Compose service has `profiles: ["router"]`; its inclusion
does not select it. `docker compose config --services` lists only `orbit`.

| Choice in setup | What Orbit does |
| --- | --- |
| Direct (default) | Uses the chosen provider and model without a router. |
| Built-in (Bifrost) | Prepares a profile, private environment and role policies. A separate Linux foreground command accepts an operator-approved binary. |
| Advanced (LiteLLM) | Records the pinned engine choice. An operator can issue one inference-only role key against an existing database-backed local service. |
| External | Uses one OpenAI-compatible base URL and one key reference. No local router, generated role keys or Compose profile. |

OpenCode free models stay **direct**, through the OpenCode adapter. An
`opencode-free` provider cannot be selected as a router upstream.

## Built-in configuration

In Custom setup select Token router, add the upstream providers you want it
to use, and map each routed role to provider `router` and a model. The
supervisor only prepares Bifrost files for an enabled built-in selection.
Selection and file presence are not evidence that inference or limits work.

| Private path under the Orbit runtime | Purpose |
| --- | --- |
| `keys/<provider>.key` | Owner's original provider key. Only file references of configured upstreams are copied; other providers and unrelated keys are excluded. |
| `router/router.env` | Only generated **router input** containing upstream values. Also holds management and role credentials. Never print a resolved Compose config for an owner's runtime. |
| `router/data/config.json` | Provider definitions, mandatory virtual-key governance, role-specific grants, budgets and rate limits. Secrets appear as `env.NAME` references. |
| `keys/router-vk-<role>.key` | Credential for exactly one built-in role. Its contents match that role's environment reference. |
| `.env` | Adds `router` to `COMPOSE_PROFILES`, preserving other profiles. |

Generated files use mode `0600`, router/key directories `0700`. Use an
owner-private runtime outside the source tree. These permissions do not isolate
processes running as the same OS user. The registry includes only the endpoint,
model and role's key-file reference for a routed role. The default endpoint is
`http://router:8080/v1` on the Compose network; it is **not** reachable from
host-run agents by default. Ordinary direct provider mappings stay direct.

The four default budget windows are `$2/day` (setup), `$10/month` (chat),
`$20/month` (workers) and `$2/month` (summarize). Edit `router.virtualKeys`
in configuration or the role budget controls; these are requested limits, not
measured enforcement. Credential/policy rendering follows the [Bifrost
transports/v2.5.1 schema](https://github.com/maximhq/bifrost/blob/transports/v2.5.1/transports/config.schema.json).
Online key rotation is refused until reload and revocation can be verified.

### Host binary: explicit foreground start and stop (Linux)

Set `bind: "loopback"`, select at least one upstream with a private key file,
map at least one role to `router`, and prepare the configuration in setup.
Use a dedicated **unprivileged** router account/runtime inaccessible to workers;
do not put an operator manifest, executable or master key in a workspace.
Orbit does not ship or fetch a binary. Before use, the administrator must
verify the artifact's provenance and approve its SHA-256 independently.

Create a private JSON manifest **outside** the runtime, containing exactly
`engine` (`bifrost`), `version` (`2.5.1`, the supported config contract),
`binary` (canonical absolute path to that Linux ELF executable), `sha256`
(64 lowercase hex digits for that file), and `runtimeDir` (canonical absolute
path). Manifest and runtime inputs must be `0600` or stricter, runtime
directories `0700`, and the binary not group/world writable or set-ID.
Do not substitute an image digest or use a version command as a checksum.

```sh
node scripts/orbit-router-host.mjs start "$RUNTIME" "$MANIFEST"
```

This is an operator command, never a wizard or setup-agent action. It checks
the copied executable bytes, compares the entire prepared Bifrost config with
the current Orbit configuration and checks each credential binding, including
role-file separation. It runs with loopback-only host arguments, a private
config snapshot and only the required router environment. Child output is not
forwarded. It reports child startup, **not** health or budget enforcement.
Stop with Ctrl-C or SIGTERM to the foreground launcher; it signals only its
own child, waits, then cleans up the snapshot. Do not edit/disable the router
until it has exited. A stale `router/host-run` after an unclean shutdown blocks
another start: verify the old process is stopped before manually removing it.
There is no detached service, reboot startup, stale-PID kill or automatic pull.

### Advanced LiteLLM: issue one scoped role key

The operator must already operate the **reviewed LiteLLM image** with its
database, model mappings, loopback inference port and a protected Unix socket
which forwards `POST /key/generate` **only to that same proxy**. Orbit does
not install LiteLLM/Postgres, create its master key, or start a socket proxy.
Do not use a public or workspace-controlled management transport. Keep the
socket and master key file under operator-owned `0700` directories outside
the Orbit runtime; no master credential is accepted through the wizard,
environment, command line, or agent registry. Use External instead when all
you need is an existing endpoint and one ordinary inference key.

For each routed role set `engine: "litellm"`, `bind: "loopback"`, a concrete
model allowed by that role, a positive dollar budget with a minutes/hours/days
window, and explicit positive per-minute token and request limits (`reset:
"1m"`). The issuer refuses unsupported windows and absolute expiry rather
than changing their meaning. The CLI's private operator manifest contains
exactly `runtimeDir`, `baseUrl` (`http://127.0.0.1:<configured-port>/v1`),
`socketPath`, and `masterKeyFile` (both canonical absolute paths).

```sh
node scripts/orbit-router-litellm.mjs plan "$RUNTIME" workers
# Review the exact role, inference URL, model, budget, and rates, then:
node scripts/orbit-router-litellm.mjs issue "$RUNTIME" workers "$MANIFEST" "$POLICY_SHA256"
```

The command requests `key_type: llm_api` and **only** the mapped model. It
checks the returned `allowed_routes`, model list, limits and issuance alias
before publishing the proxy-issued key to the role's never-overwritten `0600`
file. The API contract is [LiteLLM virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys).
A lost or incompatible response leaves `keys/.litellm-issue-<role>.pending`;
reconcile/revoke the named alias in the proxy before removing that marker or
retrying. A successful receipt ends in `.json` and records the alias, not the
key. Local disable/file deletion **does not revoke** the remote key. Revoke
at the issuer and reconcile receipts before rotating or changing engines.

## External mode

Supply the service's base URL (including its API prefix) and its key in the
owner setup form, never in chat or the URL. Use HTTPS outside loopback. The
supervisor probes `GET <base-url>/models` with the key, refusing redirects.
All externally routed roles use that **same** key file. Budgeting, issuance
and rotation belong to the external service, not Orbit. API reachability is
not a successful inference test.

## Known limitation: the built-in router when Orbit itself runs in Docker

The shipped Compose file (v2.30+ for raw env files) fixes Bifrost to the
version and digest in `server/orbit-config.mjs`. The root filesystem is
read-only, privileges and capabilities are dropped, and no host port or Docker
socket is mounted. Orbit's container runtime volume is not the host bind
directory used by the router service. Do not mount the Docker socket or
weaken file modes to bridge that gap.

The supervisor's Compose executor remains an integration seam. The explicit
host binary command does not grant Docker control to Orbit. Container UID
access, network reachability, engine acceptance/enforcement and LiteLLM's
pinned-image response scope still need a separately authorized rehearsal.
Changes to shipped image or binary dependencies require operator review.
