Supra2 Image Studio — prompt cache update (current deployment)

Version 1.2.1; HTTPS 4363 now proxies to loopback 8678.
Release: c30e50eb66b7f34ceb7da1d679a391c392e9d5fe102696496c2ad4a6345d2922
Exact-prompt LRU stores conditional embeddings and masks within the worker only.
Bounded to 32 entries and 32 MiB tensor storage. Model/tokenizer/context settings
are fixed for the worker lifetime; idle unload/restart clears the cache. No disk
embedding cache. Seeds/steps/guidance do not invalidate text embeddings. Internal
benchmark-only bypass is not accepted by public API validation. Job metadata
includes prompt_cache_hit and prompt_encode_seconds; UI is unchanged.

Verification: four cache, six lifecycle and three batch tests passed. Real paired
benchmark generated nine images across four seeds, 10/20 steps, guidance 1/3;
cached/uncached PNG hashes matched for each seed/settings pair. Warm uncached
encoding took 0.038–0.044s; cache lookups 0.000005–0.000011s. Median warm 20-step
generation: 2.314s uncached vs 2.310s cached (three samples each). Overall savings
are small relative to timing noise; no significant throughput claim is justified.
Raw evidence: ../supra2-service/prompt-cache-benchmark.json.
Real tailnet sandbox browser smoke/security test passed: cold 8.24s, warm 2.47s;
API confirmed miss then hit, no browser JS errors. This cold/warm difference is
mostly model loading, NOT prompt caching. Existing gallery retained; history
backed up privately before idle-service activation. No core restart or layout
change. Previous release retained for code rollback plus proxy retargeting;
checkpoints do not restore service/history files. Unrelated owner edits untouched.

Supra2 Image Studio — batch gallery update (historical deployment)

Version 1.2.0, same HTTPS 4363 URL, now proxying to loopback 8677.
Release: 6dde38156062d49555356a68212b97d3663c0c4074729d6809ffc7a7200c9b74
This section supersedes history/retention/UI details in historical notes below.

Random batches support 1–32 distinct seeds. Comparison mode accepts up to eight
steps and eight guidance values and reuses each seed across their Cartesian
product. Maximum 128 images per batch. One active batch, serial inference on
existing 16-thread warm worker. POST /api/batch validates the complete batch
before accepting; other submissions receive 429. POST /api/cancel cancels queued
work only; the current image finishes. Closing/reloading a pane leaves work alive.
The old /api/generate fixed-seed contract remains supported.

Gallery: responsive thumbnail grid, 120–400px tile-size control, latest/all batch
filter, newest or seed/steps/guidance sorting, per-card metadata and PNG links.
Inspector provides larger preview, prompt, timing, seed/settings and reuse action.
Forms display total image count before submit. Progress includes queued, failed,
cancelled and finished counts (finished includes failed/cancelled, not just PNGs).

Retention: latest 256 job records and bounded PNG files. Private history.json
is atomically replaced with mode 0600 in studio-outputs, outside published code.
Successful history persists across service restarts; incomplete jobs become
cancelled on startup, never auto-replayed. Existing 20 owner gallery entries
were privately migrated before activation while the prior service was idle.
Download important assets before eviction. No archive/ZIP export or auto-start
supervision is provided. Service restart is distinct from browser reload.

Verification: three new offline batch tests and six worker tests passed.
Real isolated tailnet iframe browser test generated eight PNGs (two seeds,
two step values, two guidance values), verified paired seed coverage, metadata,
gallery inspector, save popup, reuse, reload, mobile no-overflow and queued
cancellation. Auth/origin/invalid-value/concurrency checks passed; no JS errors.
The first browser test attempt stopped at a test-harness Frame.reload API error
after generating its images; corrected harness and complete rerun passed.
Updated legacy single-generation browser test also passed: 20-step warm renders
2.32s and 2.38s. These are fixture timings, not broad performance claims.
npm run check: build and 70 tests passed (existing chunk import warning only).
Workspace pane URL was refreshed with #gallery-1.2; browser_applied=true,
observed_revision=1368. Pane ID and window geometry retained. Actual owner
screen pixels were not inspected; UI behavior tested in a separate browser.

Rollback: retained previous extension release plus retarget HTTPS proxy. Back up
outputs before reverting: old code enforces a 20-image cap and ignores history.
Workspace checkpoint only covers pane URL/layout, not service/files/history.
No core service restart, GPU changes, paid calls, commit or push performed.

Historical warm-worker update follows:
Supra2 Image Studio — warm-worker update (historical deployment)

Version 1.1.0 is active at the same HTTPS URL, proxying to 127.0.0.1:8676.
Release: 8672d92a0a1aa04ce84d71903e090d38d7b4128e321412a29caffefffdfe4b3b
The cold-process resource policy and port in the historical notes below are superseded.

CPU concurrency increased from 4 to 16 intra-op threads; inter-op threads fixed
at 1. One image request at a time remains enforced. A private JSON-lines worker
loads DiT/T5/VAE once, reuses them, and exits after 600 seconds idle. The parent
kills/reaps a timed-out or failed worker; the next request starts a fresh one.
240-second request deadline includes cold loading. No GPU changes or paid APIs.
Upstream inference.py and model checkpoint were not modified.
The UI displays cold/warm timings, thread count and warm/idle state. Existing
open pages need reloading for the updated UI, but backend changes apply already.
Service remains manually managed, not reboot-supervised. In-memory history resets
on deployment. Existing PNG files remain subject to the 20-image retention cap.

Verification:
Six lifecycle tests passed: reuse/close, timeout recovery, crash recovery, idle
unload/reload, no unloading during work, malformed protocol cleanup. These use
an explicitly synthetic protocol peer, not fabricated inference results.
Real benchmark generated nine PNGs: three runs each at 4, 8 and 16 threads.
At 16 threads two warm runs took 2.914 and 2.710 seconds. At 8 threads they took
3.011 and 3.076 seconds. Original four-thread CLI took 12.98 seconds including
loading/exit. Original and all benchmark PNG SHA-256 hashes matched exactly
for this seed/prompt/20-step fixture; not a general quality or speed guarantee.
Raw timings: ../supra2-service/warm-benchmark.json (outside repository).
Live tailnet browser test: cold 7.81s, warm 2.28s; 256px output; popup save path;
auth/origin/validation/concurrency checks; no JS errors. Extension health passed.
Test ran in a separate page with the matching Orbit iframe sandbox; it did not
inspect or alter the owner's page. No workspace geometry/pane IDs were changed.

Rollback: use the extension runner's retained previous release on a free port,
then retarget Tailscale HTTPS 4363 to that port. Workspace checkpoints do not
restore service code, worker state or output files. Unrelated edits preserved.

Historical initial deployment notes follow:
Supra2 Image Studio — local test deployment

Live URL: https://kimi.tailec998.ts.net:4363/
Orbit workspace: eed047a8-e519-495e-a7ca-1c8c150a6ef4
Window: b50e14dd-2e99-4cfb-8183-e3a7193295db
Pane: 3ad22bc4-12fd-4dd8-b75b-74549dab412e
Addition acknowledged: browser_applied=true, observed_revision=1352.

Source: extensions/supra2-studio/{main.py,index.html,app.js,extension.json}
Runner ID: supra2-studio
Active release: 81aa42541cfc6b67b871e7258e1c72cd0df30dd83bfb89cc5ce27f9d6dc5d594
Loopback: 127.0.0.1:8675
Tailnet HTTPS 4363 proxies to that port. Not public internet / not Funnel.
Uses trusted extension runner, not a core Orbit service restart.

Security boundary: owner Tailscale-User-Login supplied by Tailscale Serve is
required for UI, API, images. Loopback processes are trusted (they can spoof
proxy headers); never expose the backend socket. POST additionally requires
exact HTTPS Origin and JSON. No wildcard/null CORS; no tokens in layout/source.
The health endpoint returns only release/liveness metadata, not model readiness.
Embedding restricted to the configured Orbit origins by frame-ancestors.

A static plugin wrapper was published during exploration but never installed:
/apps/supra2-studio-ba32af260853d9d0715c444c/index.html
Do not use it: static plugins have opaque origins, deliberately incompatible
with this same-origin authenticated API. Use the external browser pane instead.
No sandbox or parent privilege rules were weakened. Published bundle retained.

Resource policy: CPU-only existing isolated Supra2 venv; four OMP/MKL threads;
local cached model files and HF offline mode. Each request invokes original
inference.py as a subprocess, releases models on exit. One image at a time;
concurrent submissions return 429 rather than queuing. 240-second subprocess
timeout. Closing pane does not cancel. No GPU/driver modifications.
Prompt: 1–1000 chars (upstream tokenizer truncates to 128 tokens).
Seed: integer 0–2147483647; steps 1–100; guidance finite 1–10; n fixed at 1.
Unknown fields and booleans for numeric integers rejected.
Outputs: /home/mojo/.hermes-instances/fresh/workspace/supra2-service/studio-outputs
Latest 20 PNGs retained (pruned on successful generation and startup).
History and prompt/settings metadata are in memory only; lost on restart.
Save via Open PNG to save, then browser Save image. Automatic download is not
promised because Orbit's external iframe policy does not allow downloads.

Verification:
npm run check: build + 70 passing Node tests.
python3 tests/plugin-publish.test.py: passed.
.runtime/browser-venv/bin/python tests/supra2-studio.browser.py: passed.
Actual tailnet test in a separate browser page with the same external iframe
sandbox policy: generated seed 42, 20 steps, guidance 3, red sailboat prompt;
real PNG naturalWidth=256; total subprocess time=17.45 seconds including load.
Verified popup image save path, no JS errors, 429 concurrency, invalid origin,
missing identity, NaN, invalid bounds, whitespace and unknown fields rejected.
Initial route-fulfilled test harness hit Chromium Local Network Access checks;
using a real network navigation to the Orbit origin resolved that test artifact.
Screenshot: supra2-service/studio-browser-test.png (outside repository).
The owner's workspace acknowledged layout; its actual pixels were not inspected.

Operations (relative to Orbit repo):
python3 scripts/extensions.py health supra2-studio
python3 scripts/extensions.py status
python3 scripts/extensions.py stop supra2-studio
Stop only when no generation is running if results must be retained.
Remove HTTPS proxy: tailscale serve --https=4363 off
Runner is NOT reboot-supervised. HTTPS proxy persists but service needs manual
reactivation after reboot/crash. Warm-load service, cancellation, durable job
history and ROCm remain future work, not delivered here.
Workspace checkpoint covers window/layout only, not service or generated files.
Existing unrelated work was preserved. No commit or push performed.
