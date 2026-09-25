# COCS Asset Workshop

## Compatibility gate upgrade (1.1.0)

Live on loopback 4415 / private HTTPS 10446. Wrapper plugin 2.1.0 acknowledged
at workspace revision 872. Before readiness and again before publication, real
baseline/draft browser probes check Puma/Hornet userData contracts and attached
vehicle/character/weapon references, finite geometry and baseline draw budgets.
Vehicle key spelling in source is `vehicle`, not `vehicule`. Added stationary
meshes must be batched to avoid increasing the static draw count. This does not
retroactively optimize existing geometry or guarantee all animation behavior.

Old ready drafts cannot publish until Revalidate compatibility passes the new
policy/digest check. Map/navigation drafts are deliberately blocked from automatic
PRs until trusted traversal/ground-reachability validation is available; no claim
that this repairs Blood Gulch or verifies map playability. The explicit error is
shown in the review UI. Asset Workshop still targets main; Lattice Lab targets
feat/fieldwork-plan separately. Details, runtime probes and SDK packaging evidence
are in COCS_LATTICE_LAB.md. The original deployment record below is historical.


Owner-authorized local edit/preview/review/PR workflow. Trusted backend extension `cocs-workshop`, sandboxed UI wrapper updates existing `cocs-viewer` plugin. No Orbit core handler changes or service restart required.

## Usage
Select an asset in the library, enter a request, Generate new draft. The server clones a separate repository into `.runtime/cocs-workshop/<id>/repo`, fetches GitHub main, and starts a real authenticated Hermes Runs API request using the existing configured gateway. Edits remain local until final PR confirmation. Refine this draft continues from its current source; it does not start from main again. Prompt and source are model input; normal provider processing applies.

When ready, Preview draft in 3D. Review the actual source diff and validation, enter a PR title, tick the approval checkbox, Create pull request, and confirm Push branch & create PR. This creates `asset-workshop/<id>` in mojomast/cocs, opens a PR targeting main, and never merges. Review uses a SHA-256 digest of the validated source diff; stale diffs, unsupported changes, untracked files, and invalid syntax are rejected. Repeat requests return the recorded PR. Unknown/partial publishing failures block retries to avoid duplicates; a branch may already exist and needs manual reconciliation.

Existing maps, characters, weapons, vehicles and procedural materials can be requested by asset ID. Shared builders can affect several assets. Automatic publication currently supports modifications to existing `game/**/*.mjs` files only; added/deleted files, mode changes, binary assets and non-game changes require manual review. This is not a general repository editor. Edits start from current GitHub main, which may be newer than the library snapshot. Existing GitHub-update and offline-save controls remain inside Library / GitHub updates.

Saved drafts persist across browser reloads. Refine is available only for ready drafts. Blocked requests must be inspected; create a separate draft rather than blindly retry an unknown agent run. The active run offers stop and explicit allow-once/deny tool approvals. Restarted jobs are marked blocked, not automatically reissued. No daemon/reboot supervisor is installed.

## Security and deployment
Service listens only on loopback (active port recorded by `scripts/extensions.py status`). Private Tailscale Serve HTTPS 10446 routes to it. Require owner Tailscale identity plus a short-lived HMAC session capability for all API operations. Capability appears only in the private HTML, never in static published app files, plugin config, logs or URLs. Opaque sandbox CORS requests require that capability and identity. Source-builder frames receive no capability or privileged host bridge. Local owner-level processes remain trusted. The editing Hermes run is a trusted host agent governed by normal approvals and scoped instructions, not an OS sandbox.

Only local code compilation and browser preview are automatic; no repository package scripts are executed. The compiler restricts dependencies to game modules and the trusted installed Three.js package. Validation runs node --check on changed files, bundles the draft with esbuild, and actually renders the selected asset with isolated Chromium/SwiftShader; this checks initialization, nonempty meshes and JavaScript errors, not artistic correctness or every game's behavior. Human visual/diff review remains necessary.

Source: `extensions/cocs-workshop/` (Python backend, private UI, build and verification harness). Viewer selection metadata and optional initial selected asset: `apps/cocs-viewer/viewer.js`, relay in `updater.js`. Secret-free wrapper: `apps/cocs-workshop-wrapper/`. Runtime drafts and screenshots are owner-private and must not be published or committed. Main source checkout remains unchanged.

Deployment uses stage, activate with --trust-host-code on a free loopback port, health check, then change only Tailscale Serve 10446. Do not restart during an active edit/publish. Plugin update preserves existing pane/window identities and unrelated layout. Workspace checkpoints cover only plugin/layout metadata, not draft files, extension deployments, agent runs, branches or PRs. Extension code rollback likewise cannot undo GitHub actions.

## Tests
`python3 tests/cocs-workshop.test.py`: real temporary Git repos, HTTP create/auth path, signatures, supported-file boundaries, syntax rejection, confirmation and stale-diff guards. External git push and gh PR creation are explicitly mocked in the publication contract test; it does not create a real GitHub PR.
`tests/cocs-workshop.browser.py --generate`: real private service inside opaque workspace-style iframe, selected asset context, actual Hermes edit, generated preview, source review and PR confirmation cancelled before publishing. Run with the configured Playwright venv. The test creates a local-only draft, never pushes.
`npm run check` and `python3 tests/plugin-publish.test.py` cover Orbit build/core and publisher regressions.

Verified deployment: workspace revision 779, observed_revision 779, browser_applied true; unrelated panes preserved. Nine workshop tests, 67 Orbit tests, and publisher tests passed. The real Hermes test changed Puma body paint in game/view.mjs; Chromium rendered 92 meshes / 4324 triangles with no JS exceptions. An initial compiler dependency-resolution issue was corrected, and that actual draft was rebuilt and reopened through the published opaque iframe; preview/review/PR confirmation passed with confirmation cancelled. A second generation attempt genuinely returned HTTP 429 (Hermes busy); the UI retained it as blocked rather than claiming success. No branches were pushed or PRs opened during testing. GitHub push permission was checked with the authenticated account, while the external write contract was tested with explicitly mocked push/PR commands. Current service release is 95e8de0bf8c05bf056edca9c9c27ac7aa6f689d26cf6908712a84d3bd6d16556 on loopback 4413; private HTTPS 10446 maps there. Plugin entry: /apps/cocs-viewer-7b0acda75f4ab60e72fb2113/index.html.
