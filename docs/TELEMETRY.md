# Pulse: private desktop telemetry

## 1.1.1 transparency fix

Active release bff5d9bc6606d99a7e2a02b951ca740dcaa29fddd6a3fc0c3a44a6515f85193b on loopback 8683, HTTPS 4365 retargeted; health verified. Pulse pane URL updated to ?v=1.1.1; revision 1453 acknowledged. Removed opaque outer monitor background/shadow/border and matched iframe/document color-scheme normal. Transparent header has no blur. Pulse owns its border, with a visible Hide border / Show border button and browser-local persisted preference. Native drag bar and resize handle remain. No geometry or unrelated pane edits.

npm run check passed 71 tests/build. telemetry-glass.browser.py passed real composed pixel comparison with entire monitor hidden, computed host transparency, border toggle both ways and reload persistence. telemetry-activity.browser.py passed drag/resize/reload and live activity rendering. These used an isolated browser, not owner-screen inspection. Previous extension release retained; workspace checkpoints do not roll back CSS, extension deployment or browser-local preferences. No core/terminal restarts.


## 1.1.0 update

Active release fe5dddc0724976da35210a7352ff432c3bd359f651d0ed41c869aaf28d28a1dd on loopback 8682; HTTPS 4365 retargeted. Health verified. Workspace acknowledged revision 1431. Existing pane retained, URL ?v=1.1.0. Native drag bar and resize handle restored by removing hard-pinned geometry/chrome-hiding CSS; 650x1180 starting size. Native position/size persistence verified with real Playwright drag/resize/reload in an isolated workspace.

Request activity now adds OpenCode input/output recorded token rates, recent-session counts, active candidates and provider/model/endpoint-host rows. Activity reads ONLY model and lifecycle timestamps from latest 100 session_v2 rows, never messages. Candidates mean updated within five minutes with neither idle nor suspended timestamps; this is explicitly NOT verified in-flight HTTP activity. The installed OpenCode service does not expose legacy /session/status. Exact provider-call concurrency and per-request routing remain unimplemented, not zero. Provider hosts are resolved through authenticated local service /api/provider (49374); credentials, headers, queries and URL paths are excluded. Saved session attribution may differ from individual request overrides. Endpoint failures show unavailable rather than stale configuration.

Verification: npm run check passed 71 tests and production build; telemetry.test.py passed five tests; live OpenCode sampler and URL credential sanitization assertions passed; telemetry.browser.py passed; telemetry-activity.browser.py passed native drag/resize/persistence, real OpenCode activity/rate/route rendering and disconnected-value withholding. Old token-layer.browser.py fixed-corner test is superseded by telemetry-activity.browser.py because pinning was intentionally removed. Display sync acknowledged, owner screen pixels not inspected. Prior extension release retained for rollback; CSS and browser-local preferences are outside workspace checkpoints. No core or terminal service restart.

Historical 1.0.1 details below (superseded where noted):

Deployed 2026-09-22. Reviewed trusted host integration, not an unprivileged static plugin: process metrics must not be placed in public /apps JSON. The separate Python extension serves its UI and read-only metrics through owner-authenticated Tailscale HTTPS. It grants no shell, process-kill, or generic filesystem API and shares no credentials with the iframe.

## Deployment

Source: extensions/orbit-telemetry. Extension version 1.0.1.
Release: 147b87a1ef37598bd8b677677e7f3ca5d9cf7bcbcab17743335ea52b3882ad14.
HTTPS https://kimi.tailec998.ts.net:4365/ proxies to 127.0.0.1:8681.
Extension runner: scripts/extensions.py health orbit-telemetry.
Previous healthy 1.0.0 release is retained by the runner.
No core server, gateway, or terminal service restarted.

Reused workspace eed047a8-e519-495e-a7ca-1c8c150a6ef4, window 480f30c9-9d43-4be3-950e-63832e4f50de, pane 85090444-a890-4b0c-aa3e-887966f64404.
Pane URL: https://kimi.tailec998.ts.net:4365/#pulse-1.0.1.
Final controller update acknowledged: revision = observed_revision = 1416, browser_applied=true.
Existing 650px-wide bottom-right anchoring and below-windows layering retained. CSS height increased from 560px to 1180px, capped at viewport height minus 100px. Existing font scale changed from 16 to neutral 19; built-in size control now adjusts actual text. No other windows/panes edited.

## Metrics and semantics

Host /proc CPU tick differences sampled every 2 seconds; per-logical-core utilization, CPU total, RAM used = MemTotal - MemAvailable, swap, 1/5/15-minute system load averages. Process CPU 100% means one logical core and can exceed 100%. Process identity includes start ticks to handle PID reuse. Exited/inaccessible processes are skipped and unreadable count shown. Ranking by executable name (comm, not command arguments) combines same-named processes; this is not semantic application attribution. Individual PID mode is also available. Memory is RSS and can double-count shared pages.

Fresh gateway /health/detailed authenticated privately using existing .env.deploy configuration. Only active_api_runs count, delegation count, generic status, and sample time are retained. The in-flight metric includes tool time; it is not concurrent provider HTTP calls and does not include OpenCode/other gateway instances. No prompts, run/session IDs, commands, process environments, or transcript text are exported.

Existing .runtime/apps/hermes-token-stats/usage.json remains authoritative for saved token totals, model breakdowns, and reporting periods. Existing 15-second exporter was not modified. Rate measures deltas of recorded input/output counts over a rolling approximately one-minute sample window, not true streaming token generation. Warming-up/reset/unavailable rates are null, not invented zeroes. Counter publication is bursty; stale counter age >60s suppresses rates. 24h/7d/30d views mean lifetime counters for sessions started in that interval, not precise within-period usage. Existing Hermes and OpenCode cache accounting retained. OpenCode in-flight data explicitly unavailable.

## Customization

Gear: five themes (Nebula, Graphite, Midnight mint, Paper, Transparent), vertical/two-column/compact layout, small/normal/large text, 2/5/10-second browser polling, 3/5/8 ranking rows, grouped-app/individual-process rankings. Toggle activity, resources, core grid, rankings, Hermes, OpenCode, and trends independently. Pause and collapse controls. Preferences stored in this origin's localStorage, not workspace checkpoints; no tokens/private data are stored there. Backend sampler remains read-only at two-second intervals even when a section is hidden or browser polling paused. Hidden browser tabs stop polling.

## Security and lifecycle boundaries

Loopback-only service. All UI and data routes require Tailscale-User-Login matching the owner plus expected Host. Cross-origin data requests rejected; no permissive CORS. CSP restricts embedding to the Orbit origin, scripts/assets to self. /health exposes only health/release for the deployment runner. Local owner/root can forge proxy headers, consistent with other trusted host services; this is not protection from local privileged code. Tailscale Serve is tailnet-only, not Funnel.

The extension runner does not provide reboot supervision; after reboot use its health-gated restart on an unused port and retarget HTTPS 4365. Browser reload preserves preferences, not process lifecycle. No reboot-persistence claim.

Workspace checkpoints retain old pane URL/name/font, not extension processes, CSS, or preferences. Original CSS and window metadata backed up under .runtime/telemetry-before/. For rollback, use a scoped current-revision pane update to the old /apps/hermes-token-stats/ URL and targeted font/name edits; revert only the telemetry CSS height to 560px through workspace_appearance.py, preserving intervening owner edits. Stop orbit-telemetry and disable just HTTPS 4365 if removing the service. Extension rollback requires health-gated launch on a free port plus explicit proxy retarget; it does not restore CSS/layout.

## Executed verification

npm run check: production build and 70 tests passed (pre-existing mixed import warning).
python3 tests/telemetry.test.py: 5 passed; includes real host and authenticated gateway sampling, CPU deltas, PID/name parsing, rate warmup/duplicates/reset.
.runtime/browser-venv/bin/python tests/telemetry.browser.py: passed against actual HTTPS UI/API and Orbit-origin iframe. Real per-core data, rankings, grouped/PID modes, reporting periods, five themes, preferences surviving reload, section toggles, pause/collapse, mobile overflow, no JS errors. Explicit synthetic failure injection verified stale/live-value withholding, network disconnect, and recovery; those are tests, not claimed live measurements.
Anonymous, wrong-owner, and foreign-Origin metric requests returned 403.
Existing token-layer.browser.py anchoring/occlusion test passed.
Separate live-browser measurement of deployed CSS at 1800x1600: x1130 y400 width650 height1180 (20px right/bottom).
Extension health gate verified active release. Desktop/mobile screenshots retained privately in .runtime/telemetry-desktop.png and telemetry-mobile.png. Owner workspace acknowledged state, but owner-screen pixels were not inspected; iframe behavior tested in isolated Chromium. Browser tool session itself unavailable; Playwright tests ran successfully.
Repository-wide git diff --check reports an existing trailing space in untouched apps/hermes-token-stats/index.html line 10; left intact to preserve owner edits.
