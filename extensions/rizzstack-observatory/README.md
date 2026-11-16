# Rizzstack Observatory

A static, catalog-style Orbit app that renders one
`rizzstack.observability/snapshot/1` document: the live bee fleet, token/cost
usage charts, the pipeline timeline, a backlog board mirror, a health strip and
alert banners.

The served bundle lives at `apps/rizzstack-observatory/` (`index.html` +
`app.js` + `styles.css`). It follows the plugin-catalog admission rules: a
static bundle with `index.html` and relative assets only, no build or install
scripts, no remote scripts/modules, no hidden files or symlinks, no private
endpoints and no credentials in code, well under the size/file limits.

## What it renders

| Section | Content |
| --- | --- |
| Fleet table | Live bee attempts: attempt id, branch, model, state, elapsed time (sortable columns) |
| Usage | Tokens and cost by model / provider / repo as bar charts; unknown costs render as `UNKNOWN`, never as `0` |
| Pipeline timeline | Jobs → tasks → attempts → verify → integrate → accept, with escalation and blocker reasons |
| Backlog board | Column/card mirror of the backlog board |
| Health strip | Launcher, docker, gateway-vs-installed parity, quota `x / max`, scheduler liveness |
| Alerts | Error / warn / info banners from the snapshot |

Missing sections render as empty states, a snapshot older than 10 minutes gets
a `STALE · <age> old` badge, a snapshot without `generated_at` gets a
`FRESHNESS UNKNOWN` badge, and an unrecognized `schema` value raises a banner
note.

## Snapshot document

The app fetches a single JSON document and is tolerant to partial input. The
canonical shape it renders best:

```json
{
  "schema": "rizzstack.observability/snapshot/1",
  "generated_at": "2026-11-16T09:30:00Z",
  "fleet": { "attempts": [ { "id": "bee-a1", "branch": "feat/bee-usage-observability",
    "model": "zoo/glm-5.3-flash", "state": "running", "elapsed_ms": 93000 } ] },
  "usage": {
    "tokens": { "total": 12345, "by_model": {}, "by_provider": {}, "by_repo": {} },
    "cost": { "total_usd": null, "by_model": {}, "by_provider": {}, "by_repo": {} }
  },
  "pipeline": { "jobs": [ { "id": "job-1", "state": "running", "tasks": [
    { "id": "task-1", "state": "blocked",
      "attempts": [ { "id": "bee-a1", "model": "zoo/glm-5.3-flash", "state": "failed" } ],
      "stages": { "verify": { "state": "passed" }, "integrate": { "state": "blocked", "reason": "conflict" }, "accept": { "state": "waiting" } },
      "escalation": { "reason": "human review requested" },
      "blocker": { "reason": "merge conflict" } } ] } ] },
  "backlog": { "board": [ { "name": "Todo", "cards": [ { "id": "BL-12", "title": "Add stale markers", "assignee": "bee-a1", "points": 3 } ] } ] },
  "health": {
    "launcher": { "state": "ok", "detail": "pid 4242" },
    "docker": { "state": "ok" },
    "gateway": { "installed": "1.2.3", "running": "1.2.4" },
    "quota": { "used": 3, "max": 10 },
    "scheduler": { "alive": true, "last_beat_at": "2026-11-16T09:29:40Z" }
  },
  "alerts": [ { "level": "error", "message": "Gateway version mismatch", "detail": "running 1.2.4 vs installed 1.2.3" } ]
}
```

Tolerances: `fleet` may be an array or `{attempts|rows|bees: [...]}`; elapsed
comes from `elapsed_ms`/`elapsed_s`/`started_at` (+ `ended_at`); usage and cost
breakdowns accept maps or arrays under `by_model`/`by_provider`/`by_repo`; a
`null`/absent cost value renders `UNKNOWN`; `stages` may also be flat
`verify`/`integrate`/`accept` keys on the task; `escalation`/`blocker` accept a
string or `{reason}`; `backlog.board` may be a column list, a
`{column: [cards]}` map, or flat `cards` grouped by `column`/`status`.

## Configuration

- **Snapshot URL** resolution order: the `#orbit-config=` plugin config
  fragment field `snapshot_url` (highest), then the operator value saved in the
  app's Settings (localStorage key `rizzstack.observatory.snapshot_url`), then
  the default `./snapshot.json` relative to the bundle.
- **Bearer token**: entered once by the operator in the in-app Settings dialog
  and stored only in localStorage key `rizzstack.observatory.token`. It is sent
  exclusively as the `Authorization: Bearer …` header of the snapshot request.
  It is never in code, never in the config fragment (that fragment is public
  and visible in the pane URL), never in request URLs, and never logged — the
  app contains no logging calls at all. *Forget token* removes it.
- If the pane sandbox denies localStorage, both settings degrade to
  session-only and the status line says so.
- The snapshot endpoint must permit CORS from the Orbit origin
  (`Access-Control-Allow-Origin` plus `Access-Control-Allow-Headers:
  Authorization`) unless it is served same-origin. Requests use
  `cache: no-store` and `credentials: omit`.

## Register and open as an Orbit pane

The supported path is the workspace-plugin lifecycle
([docs/PLUGINS.md](../../docs/PLUGINS.md)); install is disabled-first and every
mutation creates a workspace checkpoint.

1. **Publish** the content-addressed bundle (never copies config into the
   served files; identical files reuse the same folder):

   ```
   python3 scripts/plugin_publish.py "$PWD/apps/rizzstack-observatory" \
     --id rizzstack-observatory --version 1.0.0 --title "Rizzstack Observatory"
   ```

   The command prints a manifest whose `entry` looks like
   `/apps/rizzstack-observatory-<digest>/index.html`.

2. **Install** into the workspace (disabled first), passing the snapshot URL as
   public config — never the token:

   ```
   python3 scripts/workspace_control.py --workspace <WORKSPACE_ID> apply \
     '{"action":"plugin_install","manifest":<manifest from step 1>,"config":{"snapshot_url":"https://<host>/<path>/snapshot.json"}}'
   ```

3. **Enable** — Orbit creates the sandboxed browser pane (Windows or Spatial
   view):

   ```
   python3 scripts/workspace_control.py --workspace <WORKSPACE_ID> apply \
     '{"action":"plugin_enable","plugin_id":"rizzstack-observatory"}'
   ```

4. **Configure later** with `plugin_patch_config`, e.g.
   `{"action":"plugin_patch_config","plugin_id":"rizzstack-observatory","patch":{"snapshot_url":"..."}}`.
   Updating to a changed bundle is `plugin_update` with the new manifest.
   Remove with `plugin_remove`; published assets are retained.

5. **Enter the token** once: open the pane, press ⚙ Settings, paste the bearer
   token, Save. It persists per browser profile until *Forget token*.

Alternative: serve the bundle directory directly (e.g. copied under the
runtime `apps/` directory, reachable at `/apps/<slug>/index.html`) and add a
browser pane with that URL; configure URL and token in the in-app Settings.
Content-addressed publication is still preferred because checkpoints and
rollback reference the manifest entry URL.

Before claiming the pane works, inspect the actual iframe in a real browser
per docs/PLUGINS.md; manifest validation and publication alone do not prove
the app renders.

## Admission checklist

- Static bundle: `index.html` + relative `./app.js` / `./styles.css`, no build
  or install scripts, no remote assets, no inline scripts.
- No private endpoints or credentials in code; the only network call targets
  the operator-configured snapshot URL.
- No hidden files or symlinks; size and file counts within the publisher
  limits (this bundle is a few KB).
- Accessibility: labelled controls, keyboard-navigable (native buttons, native
  `<dialog>` focus handling, sortable table headers with `aria-sort`), dark
  theme consistent with Orbit's built-in apps.

## Tests

```
python3 -m pytest tests/test_rizzstack_observatory.py -q
```

The suite covers bundle admissibility (including a real
`scripts/plugin_publish.py` publication), snapshot rendering (fleet, usage with
UNKNOWN costs, pipeline reasons, backlog, health, alerts, stale markers),
token/request handling and the registration documentation.
