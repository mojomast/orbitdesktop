# Orbit Observatory

Read-only dashboard installed in workspace `eed047a8-e519-495e-a7ca-1c8c150a6ef4`. It adds a sandboxed plugin, not a replacement desktop. Existing windows, layout and appearance are retained.

## Sources and boundaries

`scripts/observatory_export.py` runs every ~10 seconds. It reads Linux `/proc`, workspace-filesystem disk usage, the active profile's SQLite session counters, scheduler JSON and the explicitly scoped workspace record. It probes the existing Orbit service and local `/api/health`. It does not run inference or modify jobs.

Only allowlisted numeric aggregates, fixed source-status strings and timestamps are exported to `/apps/orbit-observatory-data/snapshot.json`. This feed is accessible to anyone able to reach the Orbit app server, like the existing token widget feed. No names, addresses, hostnames, commands, credentials, IDs, prompts, tool arguments/results, job errors or billing amounts are exported. Do not deploy this app server publicly without access controls. Private diagnostic integrations must use authenticated endpoints, not public assets.

The immutable dashboard bundle is `/apps/orbit-observatory-8aa34f2601b1358f33e1a6e5/index.html`. Live data is separate from the versioned bundle; preserved mtimes prevent app-watcher reloads on every sample. Private collector state is `.runtime/observatory-previous.json` with mode 0600. Up to 360 samples from the last hour persist there. First CPU/network readings have no baseline and are null, never guessed.

Token counters are saved session totals, not live billing. The 24h scope selects sessions started in the last day; it does not timestamp individual token events. The dashboard explicitly labels cost, Jev savings, inference latency, external services, security events and other unconnected coverage. No measured Jev baseline exists. It supplies local threshold alerts, not notifications or distributed tracing.

## Runtime

A transient user timer `orbit-observatory.timer` invokes the exporter. Direct writes to the user systemd configuration directory were rejected as read-only; a permanent timer was not installed. This timer continues beyond the agent turn but does not survive reboot. Re-establish after reboot using the following, only if the unit does not already exist:

```
systemd-run --user --unit=orbit-observatory --on-active=1s --on-unit-active=10s --timer-property=AccuracySec=1s --property=TimeoutStartSec=20 --property=UMask=0077 /usr/bin/python3 /home/mojo/.hermes-instances/fresh/workspace/orbitdesktop/scripts/observatory_export.py
```

Inspect with `systemctl --user list-timers orbit-observatory.timer` and `systemctl --user show orbit-observatory.service --property=Result --property=ExecMainStatus`. Stop collection with `systemctl --user stop orbit-observatory.timer orbit-observatory.service`. Dashboard pause stops browser polling, not collection. Plugin disable/removal and workspace checkpoint restoration do not stop the timer. Stopping collection leaves the last snapshot; the dashboard marks it stale after 35 seconds. Data is not sent to external providers.

## Tests

`python3 tests/observatory.test.py`: five collector tests (live numeric-only allowlist, failure sanitization, bounded history, atomic writes/mtime stability/private permissions, job-detail exclusion).

`PLAYWRIGHT_BROWSERS_PATH=/home/mojo/.hermes-instances/fresh/cache/ms-playwright uv run --with playwright python tests/observatory.browser.py`: actual published sandbox against the real collector; scope switch, filters, pause/resume, JSON download, 390/320px widths, stale/offline/source-failure/recovery states. Failure fixtures are browser-test routes only, never written to the live feed. Screenshots remain private in `.runtime`.

`npm run check`: production build and 66 existing tests passed. `python3 tests/plugin-publish.test.py` passed.

Pre-install checkpoint: `5c9c176c-1a4b-4955-9221-54bfcdd671dd`, label “Before Orbit Observatory”. Normal installation also created automatic checkpoints. Restore only after owner confirmation; it may undo intervening owner edits, and does not revert source files, collector timers or metric history. Prefer disabling just this plugin for narrow UI rollback.
