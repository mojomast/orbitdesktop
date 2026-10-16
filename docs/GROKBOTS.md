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
| `<runtime>/grokbots-prefs.json` (0600) | first draft/setting | `{version:1, drafts:{<conv>:{text,queue:[{id,text,attachments?}],attachments?}}, themes:{<conv>:'#rrggbb'}, muted:{<conv>:true}, context:{<conv>:true}, settings:{notifications}}`; `<conv>` is `profile|agent[|session]` or `__group|<id>` |
| `<runtime>/grokbots-uploads/<id>/` (0700, files 0600) | attachments | uploaded file + `meta.json`; pruned after 30 days |
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

## Parity with the agent chat pane

Grok Bots is meant to replace the agent chat pane (`src/agent-chat.ts`). The
gap list from the parity audit is now a done list (branch
`feat/grokbots-parity`, app marker `grokbots@11`). Features that need the
Orbit host go through the postMessage bridge in `src/grokbots-bridge.ts`:
the app runs in an opaque-origin sandbox, holds only its own capability key,
and the host accepts messages only from that frame's window.

| # | Feature | Status | How |
|---|---------|--------|-----|
| 1 | 100,000-character prompts | Done | Composer `maxlength` + counter; server validates 1–100,000 for send, Pi/Hermes steer and group posts (`GROUP_MAX_MESSAGE`; other shared rooms keep 16,000). Body read with a byte limit. |
| 2 | Copy message / copy code / create document from a reply | Done | Copy falls back from the async clipboard to `execCommand` to the host (`copy` op). "📄 Document" imports Markdown with `importDocument` and opens the same owner review as the agent chat (`orbit-review-document-result`). |
| 3 | Draft persistence and queued-message editing | Done | Drafts, attachments and an outgoing queue per conversation/group live in `<runtime>/grokbots-prefs.json` (the sandbox has no localStorage). Sending while busy queues; queued items can be edited, reordered, sent now or removed; the queue drains when idle and pauses on failure. |
| 4 | Attachments and paste-to-attach | Done | 📎, paste and drag-and-drop upload to `POST /api/grokbots-app/upload` → `<runtime>/grokbots-uploads/<id>/` (0600, 30-day retention). Limits: 10 files, 25 MB each, 100 MB per message. Provider send APIs are text-only, so the message carries the host paths; small text files are also inlined within the 100,000 cap (group rooms flatten newlines, so paths only there). |
| 5 | Inline tool cards and the activity timeline | Done | History returns redacted, truncated tool calls/results (Grok/Pi transcript entries, Hermes `tool_calls` + `tool` rows) anchored to the message they followed; shown as collapsible cards (status, duration, input, output, copy) with a 🔧 toggle. Activity panel: filter, hide finished, jump to first failure, copy id. |
| 6 | Conversation library, open in new window, export | Done | 📚 / Ctrl+Shift+O lists every gateway bot and Hermes session with search and "Search older sessions"; Open, New window (bridge `open` → `orbit-grokbots-open` → a new Grok Bots window with `p/a/s`), ⤓ Markdown / JSON (messages + tool calls). ⤓ in the top bar exports the current conversation. Group rooms are not in the library yet. |
| 7 | Orbit workspace context | Done | 🧭 per-conversation toggle; the server attaches the agent chat's operator block + guide path once per conversation (checked against the transcript), for gateway agents and Hermes. History hides the block. |
| 7b | Workbench context | Partial | Workbench context is owner-approved and bound to Workbench/Hermes panes (`server/workbench-context.mjs`); it is not exposed to the app. ◧ opens a Workbench window through the bridge. Task setup, submissions and candidate review stay in Workbench. |
| 8 | Notifications and colour themes | Done | Desktop notification (bridge `notify`, Notification API) when a roster bot finishes or needs input while unseen, or a Hermes run ends while hidden; toast fallback; global toggle, permission request, per-conversation mute, click opens the conversation. Per-conversation colour, sidebar dot. Group-room turns do not notify yet. |
| 9 | Shared-agent handoff | Done | Group rooms pass through the shared-agents operations: give the floor (speak), pause/continue, auto handoff, next speaker, 1–8 turn limit, delegated tasks with Cancel. |
| 10 | Voice input | Done | 🎤 opens Orbit's voice surface (local Moonshine transcription). Each Grok Bots window registers as a conversation-transfer recipient, so "Choose draft…" appends the transcript to the draft; nothing is sent automatically. |

Still different from the agent chat: several panes side by side on different
sessions work by opening more Grok Bots windows (library → New window) rather
than split panes; Workbench submissions/receipts remain Workbench-only.

### Tests

- `tests/grokbots-app.test.mjs` (in `npm test`): prompt caps, prefs/drafts,
  uploads and attachment composition, tool extraction and redaction,
  workspace context, group handoff.
- `tests/grokbots-app.browser.mjs` (headless Chrome via `playwright-core`;
  `ORBIT_TEST_CHROMIUM` may point at a browser): runs the real app in a
  sandboxed iframe under a stub host page against stub gateways, covering every
  feature above. Run with
  `node --experimental-strip-types --test tests/grokbots-app.browser.mjs`.
