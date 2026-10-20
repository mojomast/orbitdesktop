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
.\pc-launcher\scripts\doctor.ps1    # docker, tailscale ip, cua, key present (not shown), cua SDK contract check, cua runtime doctor
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
`config.json`: `model` (default `deepseek-v4.1-flash`), `max_concurrent` (default 1, clamped to 6), `backoff_s` (429 retries; visible as state `backoff` with the retry time). The adapter has a matching `maxConcurrent` (clamped 1..6).

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

## Verified on brrrrrrrr (2026-10-20, 11:32–11:45 ET)
Real runs from a separate test Orbit (127.0.0.1:4391, own runtime and board) to the real launcher. Model deepseek-v4.1-flash via OpenCode Go. Inside the sandbox: opencode **1.18.32**, container kernel `6.18.54.1-microsoft-standard-WSL2` (Docker Desktop, runc), workdir `/home/cua/work/<project>`.

| Test | Result | Evidence |
|---|---|---|
| A: single worker | pass | run-8ba3961e, sandbox orbit-154ccad0934f, base a3d924f. The patch applied on the PC, sha256 matched for both files, unittest passed 4/4. Board: review → completed after acceptance |
| B: 2 concurrent | pass | run-6e875705 and run-69b2d37f ran at the same time in separate sandboxes. Both patches integrated cleanly; combined unittest passed 6/6 |
| C: Orbit restart mid-run | pass | Same run id after restart; only one dispatch in the history |
| C: connection interruption | pass | Drop → `disconnected` → `running`, same run, no duplicate |
| C: cancel | pass | `cancel_requested` for about 15s → `cancelled`, confirmed by the launcher |
| C: failing task | pass | Unauthorized project → `not_started` with the reason, board blocked (shown as `input-required`) |
| C: uncertain outcome | pass | Dispatch while blocked → `outcome_unknown` → reconciled to `not_started` → retry (generation 2) succeeded |

Board statuses observed on this Orbit: submitted (new), review, completed (done), input-required (blocked). The in-flight `doing` label was not captured.
Cleanup: `pc-launcher\scripts\cleanup-sandboxes.ps1` (My PC — PowerShell). Removes `orbit-*` sandboxes only.

## Fixes (Oct 20, 2026, launcher 0.1.1)
- **LF-exact export**: the project is exported with `git -c core.autocrlf=false -c core.eol=lf archive HEAD`, so patches and sha256s match the committed bytes even on a Windows clone with `core.autocrlf=true` (`pc-launcher/tests/test_export_and_scripts.py`).
- **stop/start**: the launcher writes `%USERPROFILE%\.orbit-launcher\launcher.py.pid` (the real python pid; `launcher.pid` is only the uv wrapper). `stop.ps1` kills both plus any `launcher.py ... serve` process found by command line and fails if one survives; `start.ps1` cleans up stale launchers and refuses to start if the port is held by something else.
- **Board identity**: adapter board updates post as the system identity `local-workers` (`SYSTEM_POSTERS` in `server/collab-board.mjs`), with the coordinator prefixed in the note. Every other `--as` must still be a group member (`tests/collab-board-system-poster.test.mjs`).
- **6 workers / branch tracking (0.1.2)**: `max_concurrent` and `ORBIT_LOCAL_WORKERS_MAX` are clamped to 6. A project may set `"sync_branch": "<branch>"`; before every run the launcher fetches `origin/<branch>` and exports that commit (the PC checkout is not touched).
