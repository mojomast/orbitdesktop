# Grok Bots app

Grok Bots is Orbit's built-in multi-agent chat: one pane that lists every agent
from every configured provider (Grok Bot gateway, Pi, Hermes and any
Hermes-compatible profile), with 1-on-1 chat, group rooms, per-provider session
controls, context/cost meters, approval cards and a live Activity panel. It is
intended to replace the older agent chat pane over time (see the gap list below).

## How it ships and installs

| Piece | Where |
| --- | --- |
| Frontend (single sandboxed page) | `apps/grokbots/index.html` (tracked; carries `<meta name="orbit-builtin-app" content="grokbots@N">`) |
| Installer | `server/builtin-apps.mjs`, called from `server/index.mjs` before the bundle registry refresh |
| Launch route (host only) | `POST /api/grokbots-app/launch` (Orbit token + origin check) returns `/apps/grokbots/#k=<app key>` |
| App API (sandboxed iframe, origin `null`) | `POST /api/grokbots-app` (`server/grokbots-app.mjs`) |
| Group rooms | `server/grokbots-groups.mjs` |
| Activity feed / subagent board | `server/grokbots-activity.mjs`, `server/agent-status.mjs` (`POST /api/agent-status`) |
| Provider controls | `server/grokbots-controls-{grok,pi,hermes}.mjs` |
| Group build board | `server/collab-board.mjs` (`POST /api/collab-board`) |
| Host entry points | desktop icon, command palette (Apps → Grok Bots) and Orbit menu (`src/main.ts`) |

No manual step is needed. On every server start the installer copies
`apps/grokbots/` into `<runtime>/apps/grokbots/` (runtime = `ORBIT_RUNTIME_DIR`,
default `.runtime/`) when it is missing, and upgrades it only when the installed
copy carries an older version marker or is a known earlier shipped build. A copy
with local edits or a newer marker is never overwritten; an upgrade keeps the
old copy in `<runtime>/apps/grokbots.previous/`. When you change the app, bump
the marker version in `apps/grokbots/index.html`.

Open it from the desktop icon, the command palette ("Grok Bots") or the Orbit
menu. The host fetches the capability URL and opens (or re-focuses) a browser
window on `/apps/grokbots/`. The app key travels only in the URL fragment.

## Runtime files (created on first run, never committed)

| File | Created by | Purpose |
| --- | --- | --- |
| `<runtime>/grokbots-app.key` (0600) | `loadGrokBotsKey` | capability for `/api/grokbots-app` |
| `<runtime>/agent-status.key` (0600) | `createAgentStatus` | auth for `~/bin/agent-status` posts |
| `<runtime>/collab-board.key` (0600) | `createCollabBoard` | auth for `~/bin/collab-board` |
| `<runtime>/grokbots-groups.json` (0600) | first group create | `{version:1, groups:[{id,name,members:[{id,label,provider,profile,agentId?,sourceId?,cloneId?,hermesSession?}],defaultResponder,defaultChosen?,mode:'parallel'|'sequential',createdAt,board?:{workspace,projectId}}]}` |
| `<runtime>/grokbots-groups/<group-id>/` | groups | per-room transcripts |
| `<runtime>/collab-board.json` | optional | `{workspace}` for the board; or set `ORBIT_BOARD_WORKSPACE` |

## Providers and settings

Profiles come from the same catalog as the agent chat provider menu
(`server/agent-discovery.mjs`):

- Grok Bot gateway: auto-discovered from `SAND_DATA_ROOT`, `GROK_BOT_AGENT_DATA_DIR`
  or `/home/box/agent-data`; override with `GROK_BOT_API_URL`/`GROK_BOT_API_KEY`
  (`GROKBOT_GATEWAY_URL`/`_TOKEN`, `SAND_GATEWAY_*`), `GROK_BOT_MODEL`.
- Pi: hosted in-process when the `pi` binary is found (`PI_BIN`), or remote via
  `PI_GATEWAY_URL`/`PI_GATEWAY_TOKEN`; `PI_LABEL`, `PI_HARNESS_DISABLED`, `PI_DIALOG_HOLD_MS`.
- Hermes: `HERMES_API_URL`/`HERMES_API_KEY`/`HERMES_PROFILES_JSON`, otherwise
  discovered from `HERMES_HOME` (`~/.hermes/.env`, `API_SERVER_KEY`). Optional
  dashboard controls use `HERMES_DASHBOARD_TOKEN` or
  `HERMES_DASHBOARD_BASIC_AUTH_USERNAME`/`_PASSWORD` (env or `~/.hermes/.env`).

## Agent-side helpers (optional)

Subagent phases in the Activity panel and the group build board need two
loopback CLIs and a skill. They live in the repo and are installed with:

```sh
scripts/install-grokbots-helpers.sh          # ~/bin/agent-status, ~/bin/collab-board, report-subagent-progress skill
scripts/install-grokbots-helpers.sh --force  # replace differing copies (old ones are backed up)
```

The CLIs honour `ORBIT_RUNTIME_DIR` (default `~/.orbit-runtime`) and
`ORBIT_PORT`/`PORT` (default 4318). The skill goes to `GROK_WORKFLOWS_DIR`,
`$SAND_DATA_ROOT/workflows` or `~/sand-data/workflows`.

## Gap list versus the agent chat pane

Features the older agent chat pane (`src/agent-chat.ts` and friends) has that
Grok Bots does not have yet:

- Attachments / file and image upload, paste-to-attach, and inserting a
  conversation transfer into the draft.
- Voice capture with local transcription.
- Orbit workspace context injection (workspace description, operator block,
  Workbench context) and workspace-aware actions (open windows, plugins, checkpoints).
- Project Workbench integration (task setup, submissions, receipts, candidate review).
- Conversation library: cross-session catalog search, open in new window, export.
- Export conversation; copy-message buttons; "create document from result".
- Inline tool cards with saved details, tool feed and the Live activity timeline
  (search, first failure, collapse completed, copy safe ID).
- Draft persistence across reloads and host-draft recovery; queued-message
  editing ("send next queued").
- Notifications, per-conversation colour themes, multiple panes on different
  sessions side by side.
- Shared agents (pause/continue handoff) and resource delegation.
- 100,000-character prompts (Grok Bots caps at 20,000).
