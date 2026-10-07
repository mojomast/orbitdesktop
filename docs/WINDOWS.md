# Orbit Desktop on Windows

Orbit's verified deployment target is Linux (see [DEPLOYMENT.md](DEPLOYMENT.md) and the
quick start in [README.md](../README.md)). This page documents running the same source
natively on a Windows host: what works, what degrades, and the compatibility boundaries
that make it work.

Windows is **not** a verified target. Nothing here changes the Linux path, and the
deployment, packaging and rollback procedure in [DEPLOYMENT.md](DEPLOYMENT.md) remains
authoritative for a served release.

## Do not use Docker Desktop for this

`server/index.mjs` binds the host server with `server.listen(port, "127.0.0.1")` — a
loopback-only listener. Docker Desktop for Windows does not provide host networking;
published ports are proxied to the container's own interface, so a service bound to the
container's loopback is not reachable from a host browser. Run Orbit natively, or add an
in-container forwarder if a container is required.

## Prerequisites

- Node.js 22.12 or newer, and npm.
- PowerShell (Windows PowerShell 5.1 is present by default; PowerShell 7 is preferred).
- tmux is **not** required. Its absence degrades persistent terminals rather than
  blocking startup — see [Expected degradations](#expected-degradations).

## Build the served frontend

```powershell
npm ci
node_modules\.bin\vite build --outDir dist --emptyOutDir
```

`npm run build` is the guarded isolated build: by design it writes to a private scratch
directory and refuses to replace the served `dist/`. A host server started without a
`dist/` will not serve the desktop.

## Choose a port outside the Windows reserved ranges

Docker Desktop and Hyper-V reserve TCP port ranges on the host. Binding a reserved port
fails with `EACCES` — **not** `EADDRINUSE`, which is the tell that the port is reserved
rather than occupied:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

Orbit's default port 4318, and the `--port 4319` fallback suggested in
[hermes-plugin/README.md](../hermes-plugin/README.md), commonly both fall inside the
reserved range 4286-4385. Choose a port outside every listed range and pass it as `PORT`.

## Configure

| Variable | Purpose |
| --- | --- |
| `PORT` | Loopback listener port. Must be outside the reserved ranges above. |
| `ORBIT_TOKEN` | Owner access token, 32+ characters. Set it explicitly so it stays stable across restarts. |
| `HERMES_API_URL` | Hermes API origin, e.g. `http://127.0.0.1:8642`. |
| `HERMES_API_KEY` | The gateway's `API_SERVER_KEY`. |
| `ORBIT_HOST_SHELL` | Optional. Shell for terminal panes. See [Host shells](#host-shells). |
| `ORBIT_TMUX_BIN` | Optional. Explicit tmux binary path (default `/usr/bin/tmux`). |

Keep these in a private, Git-ignored env file (the Linux deployment uses `.env.deploy`;
see [HERMES.md](HERMES.md)) and load them into the server process environment. Do not
pass an access token or API key to the browser or through a Vite variable.

With `ORBIT_TOKEN` unset, the server generates a token per start and writes it to
`.runtime/session-token`. Setting a stable `ORBIT_TOKEN` means the browser has to
"Connect host" only once; if you set it, keep `.runtime/session-token` in agreement with
it, because a stale file there is what makes Connect host reject an otherwise valid token.

## Agent chat requires a running Hermes API server

Orbit's agent pane reports *"Could not link this conversation. Check the host connection"*
when the Orbit server has no Hermes gateway configured. Both sides must be wired:

1. Hermes — in `$HERMES_HOME/.env`, set `API_SERVER_ENABLED=true` and an
   `API_SERVER_KEY` (a credential belongs in `.env`, never in `config.yaml`), then run
   `hermes gateway run`. The API server listens on `127.0.0.1:8642` by default.
2. Orbit — set `HERMES_API_URL` and `HERMES_API_KEY` on the Orbit server as above.

Verify the link without a browser. `POST /api/agent` requires both the owner bearer token
and an allowed `Origin`; without the Origin header every action returns `"Origin rejected"`.

```powershell
$headers = @{ Authorization = "Bearer $env:ORBIT_TOKEN"; Origin = "http://127.0.0.1:8318" }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8318/api/agent -Headers $headers `
  -ContentType application/json -Body '{"action":"profiles"}'
```

`{"jobs":[]}` from `{"action":"jobs"}` (with a `session_id` of the form `orbit-<uuid>`)
proves the bridge reached the gateway.

## Host shells

Terminal panes request a persistent shell. `server/local-host.mjs` resolves the tmux
binary and, when it is absent, opens the configured shell directly instead of failing the
pane. `ORBIT_HOST_SHELL` overrides the shell choice; the default on Windows is
`powershell.exe`.

**Point it at a real executable.** A `pwsh` resolved from the Microsoft Store is a
WindowsApps App Execution Alias (a reparse point). node-pty cannot launch it and reports
`File not found`, while `Test-Path` still returns true for it. Use
`C:\Program Files\PowerShell\7\pwsh.exe` when PowerShell 7 is installed from the MSI, or
the versioned Store path
`C:\Program Files\WindowsApps\Microsoft.PowerShell_<version>_x64__8wekyb3d8bbwe\pwsh.exe`,
which works but changes when the Store app updates. `C:\Program Files\WindowsApps` is
ACL-restricted, so the alias cannot be resolved with `readlink`/`realpath` (both return
`EACCES`); verify a candidate by launching it, not by testing for its existence.

## Launch

[scripts/orbit_windows.ps1](../scripts/orbit_windows.ps1) starts and stops a detached
local instance, loading a Git-ignored env file and resolving the host shell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\orbit_windows.ps1 start
powershell -ExecutionPolicy Bypass -File scripts\orbit_windows.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\orbit_windows.ps1 stop
```

The server binds loopback only and is not a reboot-persistent service. Registering a
Scheduled Task that runs `start` is a local operator choice, not part of this repository.

## Expected degradations

- **No persistent or resumable shells.** Without tmux, reconnecting a terminal pane
  starts a fresh shell; the pane's own "reconnect resumes this pane's persistent shell"
  copy does not hold on this host. Running processes and scrollback are not preserved
  across a reload. The managed-terminal route is disabled.
- **Linux-only Workbench features are unavailable.** Repository inspection
  (`server/project-files.mjs`) and bounded child execution (`server/workbench-checks.mjs`)
  require Linux and their `/proc`-based, descriptor-relative path handling. They refuse
  rather than degrade silently.
- The server logs `Managed terminals unavailable (invalid_request)` at startup. This is
  expected, not a failed setup.

## Compatibility boundaries in this source

Three Windows-specific boundaries were required. Each is narrow and inert on Linux.

### Windows cannot fsync a read-only handle

`FlushFileBuffers` requires a handle opened for write, so `fs.fsyncSync` on a handle
opened `'r'` fails with `EPERM` — for directories and regular files alike. Orbit's durable
stores use the POSIX pattern fsync(file) → rename → fsync(directory), where the second
and third flushes re-open read-only. Without a fix, the first such flush aborts a durable
write; in agent chat the `start` handler recorded a receipt as `denied`, then failed while
persisting that receipt and reported the submission outcome as *unknown*, without anything
having been sent.

`server/fsync-compat.mjs` installs a process-wide, deliberately narrow shim before the
first durable write: only on `win32`, only `EPERM`/`EINVAL`/`ENOTSUP`, and only after
`fstatSync` confirms a valid descriptor, with a one-time notice. The write itself always
used a writable handle whose own flush succeeds, so only this secondary durability step is
unavailable. Note that an ESM named import (`import { fsyncSync } from 'node:fs'`) binds at
link time and is not covered by patching the default export.

### An unreadable legacy queue is not the same as an absent one

`server/workbench-legacy-state.mjs` projects the pre-Workbench build queue through
`openProjectRoot()`, which throws code `'unsupported'` off Linux. Its catch forgave only
`ENOENT`/`unavailable`, so `'unsupported'` fell through to the deliberate
`uncertain: 1` branch. `server/agent.mjs` maps that to `execution_lane.unknown`, which
fences chat sending — permanently, with nothing running. The fix treats `'unsupported'`
as "no legacy state", which is what it means: a platform without the reader cannot have
this queue.

### Host shell resolution

Covered under [Host shells](#host-shells): tmux absence degrades to a direct shell rather
than failing the pane, and a Store `pwsh` alias must be replaced by a real executable path.

## Verifying a Windows instance

```powershell
# 1. Host server is up
Invoke-RestMethod http://127.0.0.1:8318/api/health

# 2. The gateway answers, and enforces its key
Invoke-RestMethod http://127.0.0.1:8642/v1/models -Headers @{ Authorization = "Bearer $env:HERMES_API_KEY" }

# 3. The shared chat lane is not fenced (expect agent_busy/job_busy/unknown false)
#    POST /api/agent with action "shared_chat" and the pane's ids.

# 4. A real turn completes (expect submission_state "accepted" and a run_id)
#    POST /api/agent with action "start"; then GET /v1/runs/<run_id> and expect
#    "status":"completed" with an output.
```

Workspace and pane identifiers are the components of the filenames under
`.runtime/shared-chats/`, which are named `<workspace-id>.<pane-id>.json`.
