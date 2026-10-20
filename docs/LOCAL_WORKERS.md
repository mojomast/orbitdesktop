# Local workers (Cua + OpenCode on Kyle's PC)

Orbit (box) coordinates; OpenCode workers execute in Cua sandboxes on **brrrrrrrr** (Windows 11, Docker Desktop, runc).
The OpenCode Go key lives only on the PC. Orbit holds a per-launcher API token only.

## Topology
```
Orbit (box, 127.0.0.1:4318) ─ server/local-workers.mjs (ledger, board sync via collab-board API, key stays on box)
      │  Tailscale only  →  http://100.120.158.68:47821  (Bearer: per-launcher token)
      ▼
PC: pc-launcher/launcher.py (uv, cua 0.5.0 SDK) → Docker Desktop → Cua sandbox (ghcr.io/trycua/linux@sha256:fd00735c…)
      └─ Cua built-in `opencode` harness (ACP) → OpenCode Go → deepseek-v4.1-flash
```
No cua-spacesd or Cua host token is exposed off the PC; the launcher uses Cua embedded/local only.

## Pinned versions (verified 2026-10-20)
| Component | Pin |
|---|---|
| cua CLI + Python SDK | 0.5.0 (`-Version 0.5.0`; PyPI `cua==0.5.0`, win_amd64 wheel) |
| Sandbox image | ghcr.io/trycua/linux:24.04 = sha256:fd00735ceb6c65ab628d962640068c9f63076a49a62d86f6b6eb5ac4bbcbbf6b |
| Runtime | Docker Desktop, `kind=container runtime=runc` |
| Harness | Cua `opencode` (version pinned by cua 0.5.0; `cua agent harnesses`) |
| Provider/model | OpenCode Go, model id `deepseek-v4.1-flash`, base_url `https://opencode.ai/inference/go/openai/v1` (chat/completions), wire `openai-chat` |
| Launcher | 0.1.0, Python 3.12 via uv |

Workers get `OPENCODE_CONFIG_CONTENT={"permission":{"task":"deny"}}` (no subagents). Cua auto-approves ACP permission requests; the sandbox is the boundary.

## Start / stop / status / diagnostics
My PC — PowerShell (in the launcher folder):
```
.\pc-launcher\scripts\start.ps1     # starts the launcher hidden; logs in %USERPROFILE%\.orbit-launcher\launcher.log(.err)
.\pc-launcher\scripts\status.ps1    # health: version, max_concurrent, active, queued, model
.\pc-launcher\scripts\stop.ps1      # stops the API; journal kept; live sandboxes are reattached on next start
.\pc-launcher\scripts\doctor.ps1    # docker, tailscale ip, cua, key present (not shown), cua runtime doctor
.\pc-launcher\scripts\probe.ps1     # real sandbox + harness + deepseek-v4.1-flash round-trip (run before real tasks)
```
Orbit host:
```
curl -s -H "Authorization: Bearer $(cat ~/.orbit-runtime/local-workers/launcher.token)" http://100.120.158.68:47821/v1/health
cat ~/.orbit-runtime/local-workers/ledger.json | python3 -m json.tool | less
```

## Reconnect the PC
Launcher down or PC asleep: attempts show `disconnected` (not failed). After `start.ps1`, the adapter `reconcile()` reattaches by attempt id → run id + cursor. It never re-dispatches. An attempt whose POST was never acknowledged stays `outcome_unknown` until the launcher answers. If the launcher has no record, it becomes `not_started` (safe to retry).

## Authorize a project
Edit `%USERPROFILE%\.orbit-launcher\config.json` → `"projects": {"name": {"repo": "https://…"}}`, then stop/start. Briefs naming another project are rejected (403 → `not_started`). The repo is cloned inside the sandbox; nothing on the Windows filesystem is mounted.

## Where things live
| What | Where |
|---|---|
| Attempt journal, events, result manifests | PC: `%USERPROFILE%\.orbit-launcher\attempts\` |
| Go key / Orbit API token (user-only ACL) | PC: `%USERPROFILE%\.orbit-launcher\go.key`, `orbit-api.token` |
| Sandboxes, harness installs, images | PC: `%USERPROFILE%\.cua\` + Docker Desktop |
| Ledger, event copies, result copies | Orbit host: `~/.orbit-runtime/local-workers/` |

## Provider/model + concurrency
`config.json`: `model` (default `deepseek-v4.1-flash`), `max_concurrent` (default 1, clamped to 3), `backoff_s` (429 retries; visible as state `backoff` with the retry time). The adapter has a matching `maxConcurrent` (clamped 1..3).

## Task lifecycle
1. Orbit host: create a board task: `~/bin/collab-board <group> new "<title>" --as MR.INDIA --spec "..." --status todo`.
2. Coordinator: `lw.create({taskId, boardEntry, group, brief})` with a brief per `pc-launcher/brief.schema.json`. The ledger is persisted before dispatch.
3. Supervise: `lw.tick()` polls events/state. The board column follows the state (`todo` queued; `doing` dispatching/running/backoff/disconnected/outcome_unknown/cancel_requested; `review` succeeded; `blocked` failed/cancelled/not_started; `done` accepted). The detailed state goes in the note.
4. Cancel: `lw.cancel(id)`. The state stays `cancel_requested` until the launcher confirms `cancelled`.
5. Review: read `result.json`. `observed` (sha256 per file, scope flags) is evidence. `worker_claims` is the model's self-report. Then `lw.review(id,{accepted})`.
6. Retry: `lw.create` again for the same task. The prior live attempt becomes `superseded` and can't write the board.

## What survives what
| Event | Effect |
|---|---|
| Orbit restart | Ledger reloads; `reconcile()` reattaches; no re-dispatch |
| Launcher restart | Journal reloads; controllers reattach by run id; an attempt mid-start (no run id) → failed, needs retry |
| Tailscale drop | `disconnected` until reachable |
| PC reboot | Docker sandboxes stop; reattach fails → `failed` with error; retry from Orbit |

## Rollback / uninstall (scoped)
My PC — PowerShell: `.\pc-launcher\scripts\stop.ps1`; `Remove-NetFirewallRule -DisplayName "Orbit launcher (Tailscale only)"`; `cua sb ls` then `cua sb rm <orbit-*>`; delete `%USERPROFILE%\.orbit-launcher`. Cua itself: `irm https://cua.ai/uninstall.ps1 | iex`.
Orbit host: the adapter is not mounted by default; delete `~/.orbit-runtime/local-workers/`; drop branch `feat/local-workers`.
