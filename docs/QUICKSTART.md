# Quick start

Orbit is a single-owner, local-first workspace. This page gets a stranger from a
fresh machine to a usable desktop with one command, using whatever agent they
already have. Hermes, Grok Bot, Pi, OpenCode and any OpenAI-compatible endpoint
are optional adapters; Orbit does not assume that any of them is installed.

Local operation stays on loopback (`127.0.0.1`). Read
[Optional: remote access](#optional-remote-access) only when you deliberately
want to reach Orbit from another machine.

## Prerequisites

Pick one of the two install paths below.

- **Docker path:** Docker Engine with the Compose v2 plugin. No Node.js install
  is required on the host.
- **Node path:** Node.js 22.12 or newer and npm. Python 3 and tmux are useful for
  optional terminal and integration features, but they are not required to open
  the desktop.

You also need a terminal and a current browser. A model provider key is optional
at startup because the onboarding screen offers a free OpenCode model as one of
the choices.

## Path 1: Docker Compose

Clone the repository, then start the stack. The Compose file publishes only
`127.0.0.1:4318` and keeps the private runtime in a named volume.

```sh
git clone https://github.com/mojomast/orbitdesktop.git
cd orbitdesktop
docker compose up -d
```

Get the one-time login URL and token from the running container:

```sh
docker compose exec orbit node scripts/orbit-up.mjs --print-login-url
```

The command prints a loopback URL and a one-time token. Open the URL, choose
**Connect host**, and paste the token. The token is stored in the private runtime
as a `0600` file; it is not part of the Compose file or the service logs. Never
put it in a screenshot, an issue or a chat message.

Follow the container logs if startup takes longer than expected:

```sh
docker compose logs -f orbit
```

## Path 2: npm run up

The launcher installs locked dependencies if they are missing, builds the UI into
the checkout's `dist/` when needed, and starts the server on loopback.

```sh
git clone https://github.com/mojomast/orbitdesktop.git
cd orbitdesktop
npm ci
npm run up
```

In a second terminal, read the one-time login URL and token:

```sh
npm run up -- --print-login-url
```

Open the printed `http://127.0.0.1:4318` URL and paste the token into
**Connect host**. To use another loopback port, pass `--port`:

```sh
npm run up -- --port 4319
```

Use the same port when reading the login URL. The launcher never binds a public
interface by default. `npm run up -- --dry-run` prints the plan without
installing, building, starting a process or reading a token.

## First-run setup wizard

After the host is connected, Orbit opens the setup wizard. There is no required
vendor: at run time you can choose a free OpenCode model, a Pi key, or another
provider from the list, and no agent runtime is assumed. Step 1 offers two
paths. The wizard and server wiring are developed in parallel with this page;
the behavior and fields below are the contract in
[docs/CONFIG.md](CONFIG.md).

### Minimal install (recommended, preselected)

Pick one provider and one model. That model is used for every role: the setup
agent, chat, workers and summaries. Orbit installs only the core workspace plus
the one first-agent adapter that matches the provider (`opencode` for OpenCode
free, `pi` for Pi, and no extra adapter for a generic OpenAI-compatible,
OpenRouter, Anthropic or external-router endpoint). The built-in router,
optional apps, bundlebees, worker pairing and Colab stay off. The wizard skips
the per-role model step and goes straight to **Review and apply**.

Minimal mode is stored as `mode: "minimal"` plus a `defaultModel` object. An
external router is allowed because it starts nothing locally; the built-in
router is not part of Minimal install. See
[Setup modes](CONFIG.md#setup-modes-minimal-install-and-custom).

### Custom (the granular path)

Custom is the full wizard:

1. **Choose what to install** — core is required; choose optional components and,
   separately, whether the built-in token router should run.
2. **Providers and keys** — choose a provider path and enter keys, or configure
   one endpoint.
3. **Models** — choose one model per role: `setup`, `chat`, `workers` and
   `summarize`, plus `compaction` and `vision` when present.
4. **Connect GitHub (optional)** — paste a token or use device sign-in, or
   choose **Skip GitHub for now**. The token is stored on this machine only
   (0600) and never shown again.
5. **Repos to watch** — the `owner/name` repositories whose commits, pull
   requests and CI Orbit tracks. Empty by default.
6. **Review and apply** — confirm the components, providers, models and router
   choice.

Minimal install skips steps 3 to 5. Its Review step has a card that opens
Connect GitHub and Repos to watch, and both are also in Settings. See
[ONBOARDING-GITHUB.md](ONBOARDING-GITHUB.md).

The review step records `appliedAt` and marks each selected component pending.
The setup agent then installs only what you selected and reports progress back
to the wizard. It never asks for a key in chat; enter secrets only in the
onboarding form or through a server-side environment reference.

### Where keys and configuration live

`orbit-config.json` contains no secret values. A provider stores only a `keyRef`,
and the key itself is written server-side to the runtime directory:

```text
<runtime>/keys/                mode 0700
<runtime>/keys/<provider>.key  mode 0600
```

The UI and the API return a masked value such as `sk-…abcd`, never the full key.
Key values never appear in log lines, events, errors or model lists. Read
[Key storage](CONFIG.md#key-storage) for the exact rules and the server-side
`setKey`, `clearKey` and `resolveKey` behavior.

Everything chosen in the wizard is editable later in **Settings**: components,
providers and keys, `mode`, `defaultModel`, role mappings and router budgets.
Per-role overrides let one role use its own provider and model while the other
roles keep inheriting `defaultModel`; clearing an override falls back to
`defaultModel` again. Switching from Minimal to Custom writes each role's
effective model into `roles`, so nothing changes until you edit it. The full
field reference is [docs/CONFIG.md](CONFIG.md).

## Step 2: choose a provider path

Both paths end at the same place: a provider the roles can call.

### Direct providers

The default. Configure each provider directly and point each role at the one it
needs. The wizard supports a generic **OpenAI-compatible** endpoint, **OpenRouter**,
**Anthropic**, **OpenCode free** and the **Pi** harness. Loopback URLs are
allowed for a local server. OpenCode free models stay direct and run only through
the OpenCode client; they cannot be fronted by a router.

### Token router (opt-in, unchecked by default)

A token router lets several agents or roles share one endpoint, one set of
upstream credentials and per-role budgets. It is not required for a first
deployment.

- **Hosted router:** use one base URL and one key from a service you already
  subscribe to, such as a hosted OpenRouter-style or LiteLLM-style endpoint.
- **Self-hosted router:** use one base URL and one key for a router you run
  yourself, such as LiteLLM behind a proxy.

External mode starts nothing locally. The built-in router is a real, opt-in
component: it is unchecked by default, and an ordinary `docker compose up` does
not start a router container. When enabled, the default engine is **Bifrost**,
pinned by image digest. **LiteLLM** is offered only under the **Advanced**
disclosure, also pinned by digest. No router image is ever a floating tag and
nothing is installed from a package index at runtime. See
[docs/ROUTER.md](ROUTER.md) for the modes, virtual keys, budgets, health checks,
upgrade and rollback, and the security checklist.

## The setup agent

The setup agent is the installer for the reviewed plan; it is not a general chat
agent and it is not assumed to be available at first launch. It reads
`orbit-config.json` and installs only the selected components. It does not start
the built-in router by itself and never asks for secrets in conversation.
Progress is recorded in the wizard's install state. If no agent runtime is
configured, the core workspace still opens and the wizard asks what to add.

## Add agents

Other agents are adapters, not assumptions. Read
[docs/ADAPTERS.md](ADAPTERS.md) for the gateway command set, capability flags,
error codes, event stream and how to add a translator for a new runtime. The
short version:

- **Hermes** is one optional profile with its own API connection and tools.
- **Grok Bot** is another optional profile when its gateway is present.
- **Pi** can be hosted on loopback when the harness binary is installed.
- **OpenCode** is optional; free models require the OpenCode client.
- **Any OpenAI-compatible endpoint** can be configured as a direct provider.

None of these is required to run Orbit. A configured chat connection alone does
not enable shell tools, file access, approvals or background workers; those are
separate capabilities and setup steps.

## Add an SSH host (optional)

Orbit can add remote Linux hosts for infrastructure and workers without putting
SSH key material in the browser, model context or logs. Read
[docs/HOSTS.md](HOSTS.md) before you start. The **Settings → Hosts** wizard uses
the system OpenSSH tools and Orbit's own client config; it never reads your
`~/.ssh/config`.

The `tailcat` transport and remote host cleanup are **untested**. Treat the
tailcat bearer address as a secret and review the cleanup plan manually before
removing a host. The core deployment does not require any SSH host.

## Stay on loopback

Orbit grants a real shell as the server's operating-system user. Do not run it as
root and do not expose it directly to the public Internet.

- The default bind is `127.0.0.1`.
- Docker publishes only `127.0.0.1:4318`; the router, when enabled, publishes no
  host port by default.
- A wildcard bind (`0.0.0.0`) rejects other Host headers until
  `ORBIT_PUBLIC_ORIGIN` is the exact browser origin.
- Keep keys in the runtime directory; never paste a key into chat, an app bundle,
  a screenshot or a tracked file.

### Optional: remote access

Remote access is optional and outside the first-run path. If you need it, use a
private overlay network or an authenticated reverse proxy that you control, and
set `ORBIT_PUBLIC_ORIGIN` to the exact origin the browser uses. Use placeholder
values such as `<private-host>` and `<port>` in your own notes; do not commit a
real hostname, tailnet address or personal path. See
[docs/DEPLOYMENT.md](DEPLOYMENT.md) for the supported bind and rollback
procedure. Never expose Orbit to the public Internet.

## Troubleshooting

**The port is already in use.** Start on another loopback port with
`npm run up -- --port 4319`, or change the published port in a local Compose
override. Do not stop an unrelated process you did not start.

**The login command says no token is available.** Start Orbit first, then run
`--print-login-url` again. The generated token is written after the server
starts. With Docker, use the container name from
`docker compose ps`.

**The browser rejects the Host header.** You opened a non-loopback address
without setting `ORBIT_PUBLIC_ORIGIN` to that exact origin. Return to the
loopback URL or configure the origin deliberately.

**Onboarding does not appear.** Confirm the page is the loopback URL, allow
JavaScript, and reload. Check the server with
`curl http://127.0.0.1:4318/api/health`. If you upgraded an existing runtime,
read [docs/DEPLOYMENT.md](DEPLOYMENT.md) before changing the configuration.

**A router container exists or is missing unexpectedly.** A plain
`docker compose up` should not create a `router` container; the service is under
the opt-in `router` profile. Enable it in the wizard or in Settings, and remove
`COMPOSE_PROFILES=router` to turn it off. See [docs/ROUTER.md](ROUTER.md).

**The build or install fails.** Confirm Node.js 22.12 or newer on the Node path.
Re-run `npm ci` to restore locked dependencies. On the Docker path, check
`docker compose logs orbit` and rebuild with `docker compose up -d --build`.

**Keys are missing after a restart.** Keys live in the runtime directory or the
Docker named volume. Removing that volume deletes them. Back up the runtime
deliberately; never copy a key into a tracked file.

## Uninstall

For the Docker path, stop the container and remove its network. This keeps the
runtime volume, including configuration and keys:

```sh
docker compose down
```

Remove the runtime volume as well when you want a clean uninstall. This deletes
the configuration, generated tokens and key files:

```sh
docker compose down -v
```

For the Node path, stop the launcher with `Ctrl+C`. The private runtime is the
`.runtime` directory in the checkout and the served UI is `dist/`. Remove them
only after you have exported anything you want to keep:

```sh
rm -rf .runtime dist
```

Then delete the checkout if you no longer need it. No system service, cron job or
global package is installed by the launcher.

## Verify a fresh install in development

The repository includes a container smoke check. It builds the image, starts a
fresh container with an empty volume on a random loopback port, reads the login
URL with the documented command, and checks that the onboarding screen is
reached. It never uses port 4318 and never touches an existing container. It
uses Docker or Podman, whichever is available, and uses the Playwright already in
`node_modules` when present; otherwise it performs curl-only checks and says so.

```sh
scripts/smoke-fresh-container.sh --dry-run
scripts/smoke-fresh-container.sh
```

The pull-request workflow runs the same script and uploads the onboarding
screenshot as an artifact.
