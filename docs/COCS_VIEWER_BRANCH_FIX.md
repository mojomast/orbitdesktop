# Viewer branch update fix

The library updater resolved commits/HEAD (main), which still has shared Puma geometry for Titan/Scout/Transport. The dedicated model pack is on feat/fieldwork-plan.

Added explicit branch selection (default feat/fieldwork-plan), immutable SHA resolution for that selected branch, branch+SHA success status, and removed the obsolete hardcoded shared-chassis description. Rebuilt the Workshop's served apps/cocs-viewer/dist snapshot from isolated detached worktree .runtime/cocs-viewer-fieldwork at 18c6c41. Original cocs-source checkout and published immutable bundles untouched. build.mjs accepts COCS_SOURCE for reproducible branch builds.

The Workshop serves this dist directory directly; no extension or Orbit restart needed. Existing clients must click Library / GitHub updates to reload this nested viewer. No Studio reload or workspace mutation required. Selecting a library branch does NOT change draft or PR target (currently main); UI explicitly warns of this limitation. No drafts, PRs or backend workflows changed.

Verification: tests/cocs-viewer-branch.browser.py passed through real authenticated Workshop under opaque sandbox. Bundled and live GitHub-updated Titan/Scout/Transport have distinct mesh/triangle counts: Titan 86/42136, Scout 29/34200, Transport 52/53992 (Puma 92/4324). Live update fetched feat/fieldwork-plan @ 08e32dfd, 146 modules. Offline saved snapshot, network-failure retention, bundled reset, and no JavaScript errors passed. Existing tests/cocs-workshop.browser.py also passed selected asset relay and PR gating. Build passed with four pre-existing upstream duplicate impact key warnings.
