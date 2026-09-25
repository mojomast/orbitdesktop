# COCS Graphics Lab

Separate sandboxed plugin `cocs-graphics-lab`, installed in owner workspace eed047a8-e519-495e-a7ca-1c8c150a6ef4. Initial enable revision 805 was acknowledged by browser (observed_revision 805). Existing pane layouts were verified unchanged. Wrapper entry: `/apps/cocs-graphics-lab-a74ebc8f3d38e5a93b5a2d7a/index.html`.

## Scene and recipes

Six actual COCS procedural character models use actual CharacterRig/characterPose with frozen aiming, sprinting, airborne, reloading, crouching and hit states. Weapons and Puma use repository model builders. The studio, cover blocks and material chart are lab staging geometry, not an authored game map. Studio/night lighting, eye/overview/focus cameras, orbit/pan/zoom and WASD/QE navigation. Bots never advance simulation; grain animation is independently opt-in and respects OS reduced-motion.

Bundled source snapshot e79fcc048d7d97e7418d2e6fdbdd304b69362fa0. Unlike the Asset Viewer, this lab does not have live GitHub source updating. Implementation drafts fetch current GitHub main separately.

Effects: exposure, UnrealBloomPass, saturation, contrast, tint, vignette, RGB separation, grain, scanlines, pixelation, radial warp and FOV. Presets plus four deterministic bounded variations per click. Single-camera baseline bypass/split comparison keeps FOV matched. Render order: scene, bloom, OutputPass, display-referred grade shader. Recipe values and complete shader source are included in change briefs. These are lab settings, not assumed native COCS configuration keys.

Named recipes save privately in `.runtime/cocs-graphics-lab/recipes/` (500-document cap). Unnamed slider changes are in-memory until saved/exported. JSON roundtrip includes scene/camera/context. Exported recipes and screenshots intentionally contain no service token. Workspace checkpoints do not cover recipe documents or source drafts.

## Situation → draft → review → PR

Select actual POWERUPS event ID, duration and fades, describe custom behavior, generate implementation. This uses the configured Hermes Runs API, not a simulated model response. Drafts persist in `.runtime/cocs-graphics-lab/<id>/repo` and are isolated from the owner's game checkout and existing Asset Workshop drafts.

Drafts support only tracked existing game/**/*.mjs edits. Syntax, restricted bundling and real selected-character browser rendering validate source smoke preview. This does NOT verify the powerup lifecycle, player isolation, HUD readability or visual parity in gameplay. UI requires acknowledgement of source/diff review and in-game verification before offering the PR confirmation dialog. Source preview is explicitly separate from frozen recipe staging.

The backend uses current-diff SHA-256 approval and rechecks before publishing. Pushes a `graphics-lab/<id>` branch, creates a PR against main, never merges. Partial publish failures require manual reconciliation rather than blind retries. No GitHub writes happened in verification. Prompt/source processing uses the configured model provider and normal tool approvals.

## Trusted service

Private Tailscale HTTPS 10447 → loopback 4414. Owner Tailscale identity plus short-lived HMAC session capability required for API calls, including recipe persistence. Token only in private HTML; never in static wrapper, config or URLs. Source preview iframe has no privileged bridge or token. Service code is trusted host code, not an OS sandbox. No automatic reboot supervision is provided by the extension runner.

Active initial release `c4d30b7c67a0dfb913a9a88c3b2ee1a39c41a9ed884c804cecf44e4ac459065c`. Source under `extensions/cocs-graphics-lab/`, UI source under `apps/cocs-graphics-lab/`, secret-free wrapper under `apps/cocs-graphics-wrapper/`. Build: `node apps/cocs-graphics-lab/build.mjs`. Uses existing trusted Three.js/esbuild installs from the asset viewer. Upstream duplicate `impact` key warnings in game/data.mjs are unchanged.

Service health: `python3 scripts/extensions.py health cocs-graphics-lab`. Stage and health-gated activate on a free distinct port, then repoint only Tailscale Serve 10447. Do not replace/restart during active draft or publish. Backend and frontend are versioned together by stage. Checkpoint restore cannot undo source files, recipes, service deployment or GitHub effects.

## Real verification

- `node tests/cocs-graphics-recipe.test.mjs`: presets, 300 reproducible bounded variations, invalid numeric/color recipes and shader/lifecycle brief.
- `python3 tests/cocs-graphics-lab.test.py`: 9 passing tests, real local Git/syntax/diff/auth checks, confirmation/stale-digest guards. External push and PR calls are explicitly mocked only in the publication contract test.
- `tests/cocs-graphics-lab.browser.py`: real private service and published wrapper inside opaque workspace-style sandbox; 6 rigged frozen bots, pixel-changing effects, bypass/split, free/eye/focus camera, frozen poses, variants, JSON roundtrip, private recipe save/load, invalid PR rejection, zero JS/shader errors. Uses configured Playwright venv.
- `tests/cocs-graphics-generate.browser.py`: actual Hermes generation completed; local draft 90d03973c4104ecaa8d2bc9531b02a35 modifies game/post.mjs and game/view.mjs for the overshield recipe. Compilation and real Chromium character preview passed (57 meshes, 6468 triangles, no JS errors). PR confirmation opened then cancelled. In-game activation/lifecycle remains unverified; this test is not artistic approval or permission to publish it.
- Orbit `npm run check`: build and 67 existing tests passed. Plugin publisher test passed. Additional recipe test passed independently.

Browser evidence remains private: `.runtime/cocs-graphics-lab/browser-test.png` and `draft-review.png`. No owner app/terminal sessions restarted. A failed initial service launch due to Python isolated-import behavior was fixed via explicit file import before activation; a test-harness ancestor-origin mismatch was corrected before published sandbox tests passed.
