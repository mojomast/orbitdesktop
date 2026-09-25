# COCS Lattice Operations Lab / SDK 0.1

Installed in workspace eed047a8-e519-495e-a7ca-1c8c150a6ef4; revisions 872
(update Workshop + install disabled Lab) and 873 (enable Lab), both acknowledged
with browser_applied:true and observed_revision equal to committed revision.
Existing pane IDs, unrelated layouts and appearance were verified unchanged.

## Source authority and behavior

Lattice Strike (`cocs`) and Operations (`cocs-coop`) are on GitHub branch
`feat/fieldwork-plan`, not the older `main`. Baseline was built from actual commit
18c6c41 (full SHA stored in generated source-index.js). Previous reports that no
Lattice implementation existed on fieldwork were incorrect.

The lab includes authored Foundry supply topology, node ownership experiments,
actual capture legality/HQ connectivity/income, cut/repair scenarios, endgame,
actual Director wave plans/pacing/budget probes, scoring/REQ catalog, searchable
module/import/export/source-line wiring, and a seeded real Match engine stepper
for both modes. The graph is not a navigation pathfinder. Owner overrides are
experimental setup, not legal game actions. Budget probes do not include full
wave spending/history. The engine is local and headless, not a live match feed.
Source links show the pinned baseline; uncommitted draft edits appear in local
source excerpts and review diffs, not yet on GitHub.

Export scenario+change briefs as versioned JSON. Experiments are in-memory until
exported; import/persistent scenario storage is not yet implemented. Source index
and helper build are a static snapshot; creating a draft fetches the current
named branch independently. Current scope permits existing mechanics/config
modules only. UI, rendering and network changes require separate review.

Prompt generation uses the configured authenticated Hermes Runs API, isolated
checkout, source diff/digest validation, sandboxed draft mechanics preview,
explicit approval and final push/PR confirmation. PRs target feat/fieldwork-plan;
no automatic merge. Preserves normal once/deny tool approvals, stop, saved drafts,
partial-publishing fail-closed behavior. GitHub writes were not exercised during
verification. A local comment-only real model draft was generated successfully;
behavior-changing generation is not claimed as tested.

## Deployment

Source: apps/cocs-lattice-lab, extensions/cocs-lattice-lab, sdk/cocs.
Builder/package scripts: scripts/build_lattice.py, scripts/package_cocs_sdk.py.
Private Tailscale HTTPS 10448 → loopback 4416; identity plus short-lived HMAC
capability gates API operations. No tokens in static wrapper/config/URLs.
Active extension release f7506049f2f538f0c0af3c36a7084498fcb27f44288b35089a9374310d613f50.
Plugin entry /apps/cocs-lattice-lab-aabc58272cbf16d1a97562b0/index.html.
Do not restart while edits/publishing are active. No automatic reboot supervisor.

Workshop updated to compatibility-gated backend 1.1.0 on loopback 4415 / HTTPS
10446, release 6793b8d253423ccd511021f3f5aee6d430369c6c3d440fb9dce923c5f2f6d38b.
Wrapper 2.1.0 /apps/cocs-viewer-5b61a0c577823c22dda70c05/index.html.
Previous release is retained by the extension manager. Workspace checkpoints only
cover layout/plugin metadata; they do not roll back service code, drafts or PRs.

## SDK artifact

Portable core package: .runtime/cocs-dev-sdk-0.1.0.tgz (10 source/doc/schema files).
SHA256: 6cd76b0a8fd30c3d0b6d87fbf6c3844ac9768aa3b07bc7aaf1f63e462308f01d.
Built with npm pack, unpacked and tested; source-index CLI ran on real checkout
from unpacked package. This is not a published npm/catalog plugin. Host adapters
remain deployment-specific; see sdk/cocs/README.md. No secrets/runtime data in
package. Existing asset/graphics/balance UIs are not all folded into a universal SDK.

## Verification evidence

- npm run check: build + 68 tests passed.
- tests/plugin-publish.test.py: passed.
- tests/cocs-workshop.test.py: 12 tests, old-policy rejection, map gate, auth,
  confirmation/digest/scope checks. External push/PR are mocked in unit tests only.
- tests/cocs-contracts.real.py: real 21-model baseline/draft browser execution;
  missing vehicle flag, removed wheels, detached turret and extra static mesh
  rejected; paint-only change accepted.
- tests/cocs-lattice.browser.py: real game topology, income 4→0→4 on cut/repair,
  D4 wave 5, source search, real PvP/co-op stepping and exported JSON; no JS errors.
- tests/cocs-lattice.generate.py: actual Hermes draft 0b9decf6e9bf43a093fd086bc546755b,
  game/cocs-director.mjs comment; ready with actual helper+engine smoke evidence.
- tests/cocs-lattice.live.py: published wrapper in opaque workspace-style sandbox,
  real authenticated API, generated draft preview and PR modal cancelled; invalid
  publication denied; new Workshop gate visible; no JS errors.
- tests/cocs-lattice.test.py: four tests including mechanics scope, obsolete policy
  rejection, real generation evidence and mocked external PR target branch check.
- SDK npm test: two tests also passed from unpacked archive.
- Both extension health checks passed after deployment.

Private screenshots: .runtime/lattice-published-sandbox.png and lattice-lab-test.png.
The normal browser tool failed initialization (local /tabs HTTP 500); independent
Playwright browser tests completed successfully instead. A preliminary Codex CLI
attempt failed authentication and Claude CLI model resolution failed; neither
made changes. Implementation was completed directly; the lab's actual inference
verification used the required Hermes gateway, successfully.
