# OmniVoice experiment bench

Owner-authorized Python backend and sandboxed Orbit plugin, built 2026-09-20.

## What is connected

- Workspace: eed047a8-e519-495e-a7ca-1c8c150a6ef4
- Plugin ID: omnivoice-bench
- Published wrapper: /apps/omnivoice-bench-d35a4fc207db2eb5944d344f/index.html
- Window: cf65f95a-4d9c-4423-85b3-d3eccd95e5c3
- Backend extension: omnivoice-bench, version 1.0.1
- Private URL: https://kimi.tailec998.ts.net:10445/
- Tailscale Serve currently forwards that dedicated HTTPS port to loopback 4410. It is NOT a Funnel/public endpoint. No other Serve mapping was replaced.
- Fixed upstream: http://127.0.0.1:3900. Only /generate, /health and /model/status are called. No profiles, arbitrary files, uploads, engine selection, system management or open proxy.

The static plugin is a secret-free iframe shell. The private extension serves its own HTML/CSS/JS inside that shell, preserving Orbit's existing opaque-origin sandbox. No Orbit parent integration or restart was required. Generated speech additionally appears in Studio's own generation history because Studio's /generate endpoint records it.

## Authentication and privacy

The extension binds 127.0.0.1 only. Tailscale Serve supplies the authenticated Tailscale-User-Login header; the extension requires the configured owner identity. Local processes with owner-level host access remain trusted and can forge proxy headers. This is not protection from hostile host code.

An expiring HMAC session capability is embedded in the private, non-CORS HTML, never in the published app, config, query parameters or logs. API requests require X-Bench-Token. API CORS permits the opaque sandbox origin and the dedicated service origin; CORS alone is not treated as authentication. Tokens expire in 24 hours and on backend restart: reload the bench when necessary. No browser cookies or host credentials are shared with the plugin.

Data: .runtime/omnivoice-bench/bench.sqlite3 plus take-ID WAV files; directory 0700 and files created under umask 077. Notebook exports and WAV downloads intentionally deliver the owner's selected data. Screenshots used for private tests remain in that runtime directory. Do not publish it.

## Usage

Enter a passage and comma-separated voice tags, choose seed, steps, speed, guidance and raw/broadcast output, then Queue take. The current model rejects natural-language acting prose. English tag categories are validated before queueing. The guide and three presets use the installed model's supported vocabulary. Preset names are creative starting points, not acoustic guarantees.

The worker serializes generation; queue limit is eight, text limit 2000, steps 1–64, speed .5–2, guidance 0–5. Seed is saved explicitly but is not a promise of cross-device reproducibility. The bench always requests denoise and model postprocess_output; Raw means Studio DSP mastering is skipped, not that every model-level processing option is disabled.

Completed takes have WAV playback/download, duration, computation time, exact recipe, notes and favorites. A/B slots load individual takes; starting one player pauses other bench players. Recipe library is server-persisted. Single recipe imports and JSON notebook exports are supported; full notebook restore is not implemented. Exported JSON does not include WAV bytes.

Only queued takes can be cancelled. Active inference cannot be interrupted through this limited adapter. Network uncertainty pauses the worker rather than risk overlapping a still-running upstream job. Restart marks unfinished takes interrupted and never automatically retries them. Before restart or promotion, check that Studio is idle and no take is running; the runner is not a job migration system.

## Tests actually exercised

- npm run check: build and all 66 repository tests passed.
- tests/plugin-publish.test.py: passed.
- tests/omnivoice-bench.test.py: 10 isolated validation/persistence tests passed. These do not simulate synthesis.
- tests/omnivoice-live.py --generate: real Tailscale and session rejection tests, blocked management routes/profile injection, actual Studio inference and WAV validation. Successful seed-42 smoke take: 81644 bytes, mono 24000 Hz, 40800 frames (1.7 s), 8.91 s end-to-end generation.
- tests/omnivoice.browser.py: actual published nested sandbox, CPU status, presets, saved recipe, JSON download, invalid import rejection, reload persistence and mobile width; no JS/console errors.
- tests/omnivoice-audio.browser.py: Generate button called real Studio, A/B WAV decoding and playback/currentTime advanced, non-overlap, persisted notes and favorite, actual downloaded WAV (49200 frames at 24000 Hz), recipe export/import; no JS errors.
- Initial prose-instruction smoke test genuinely failed. It was retained in the notebook as compatibility-test evidence; presets and validation were corrected, and subsequent real synthesis passed.

Run browser tests with PLAYWRIGHT_BROWSERS_PATH=/home/mojo/.hermes-instances/fresh/cache/ms-playwright and /home/mojo/.hermes-instances/fresh/venvs/tuta-mail/bin/python. Browser generation tests create real takes, and the preset test saves a recipe. They use separate test documents, not the owner's live workspace. The generic browser tool was unavailable; Playwright performed the browser verification.

## Operations and recovery

Use scripts/extensions.py health omnivoice-bench for current release health. No systemd/reboot supervision was installed. Tailscale Serve mapping persists, but the extension must be started again after host reboot. Running generation depends on the existing Studio service.

To stop the backend: python3 scripts/extensions.py stop omnivoice-bench. Remove only this private mapping with tailscale serve --https=10445 off. Disable only the omnivoice-bench plugin through the scoped workspace controller; never disable all plugins for routine recovery.

For an update, stage a clean source bundle, ensure idle, activate on a different free loopback port with --trust-host-code, update only the 10445 Tailscale Serve mapping, run health/security/browser tests and reload only this plugin. Review code before activation. A code rollback via extensions.py rollback requires a distinct free port and corresponding Serve mapping update.

Workspace checkpoints capture plugin registration/config/layout, not Python deployments, Tailscale mappings, SQLite, audio files or Studio history. Extension rollback likewise does not undo generated audio or database writes. Back up the private data directory independently. Other source changes and workspace panes were preserved; no core source edits were made for this bench.
