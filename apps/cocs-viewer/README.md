# COCS Asset Observatory

Sandboxed Orbit plugin for https://github.com/mojomast/cocs. The viewer imports the actual procedural builders from a pinned local checkout, not invented meshes or approximate map proxies. No game server, credentials, external CDN, or privileged host bridge is required. Three.js and the referenced game code are bundled locally.

## Collection and controls

41 maps, 9 characters, 10 current weapons, 10 legacy weapons, 5 vehicle definitions, and 21 procedural surface materials. The current upstream renderer uses the same Puma chassis for Titan, Scout and Transport; the viewer explicitly identifies that upstream limitation. Materials are presented on viewer-created sphere/cube swatches.

Drag to orbit, right-drag to pan, wheel/pinch to zoom. Focus the canvas for WASD translation, Q/E vertical movement, Shift acceleration and F to frame. Double-click a surface to change the orbit focus. Top/front/side presets, wireframe, autorotation, grid, sky/fog, authored ceiling visibility and exposure update immediately. Search and category filters share one catalog. The library is collapsible; the window and renderer resize live.

Maps use ArenaView.buildArena with the original terrain, architecture, materials and traversal geometry. This is a static asset inspector, not gameplay: bots, gameplay simulation, weather animation and live match pickups are not run. WebGL 2 is required. Camera and selection are currently in-memory, reset if the plugin reloads. Assets are a commit-pinned snapshot, not automatic GitHub sync.

## Build

From this directory, `npm ci --cache /tmp/cocs-npm-cache --ignore-scripts`, then `npm run build`. Build expects the reviewed checkout at workspace/cocs-source (a sibling of orbitdesktop). It copies game sources to ignored vendor/, bundles referenced imports and Three.js into dist/, and writes provenance.json with the exact source commit. Upstream currently emits four duplicate-key warnings in game/data.mjs; no upstream files are modified by this viewer.

Publish dist with scripts/plugin_publish.py using id cocs-viewer. Install the emitted manifest disabled, test its actual served sandboxed URL, then enable through the workspace controller. Never overwrite published content-addressed bundles. Upgrade by rebuilding a reviewed checkout, publishing a new version and applying plugin_update. Workspace checkpoints recover registration/config/window metadata, not source files or application state.

## GitHub updates (1.1.0)

The header's Update from GitHub button asks for confirmation, resolves the public repository's default-branch HEAD to an immutable commit, fetches required game modules from raw.githubusercontent.com at that commit, and rebuilds locally with bundled esbuild WASM. Three.js stays pinned to the tested bundled version. No remote npm installs, host writes, credentials or privileged bridge are involved. The previous viewer remains active while a hidden sandboxed candidate initializes and renders its first asset. Network/build/initialization failures retain the previous collection. This is an initialization check, not exhaustive validation of every future upstream asset or a security review of upstream code. New unsupported dependencies or breaking export changes fail closed.

Updates last for the window session; reload restores the bundled version. Save snapshot downloads a self-contained HTML viewer that works offline. Bundled snapshot restores the installed collection immediately. GitHub API rate limits and network connectivity apply. Existing workspace checkpoints restore the published plugin version, not a session's downloaded source or a saved file. No automatic background synchronization occurs.

Run `test-update.py /apps/ACTUAL-HASH/index.html` and `test-update-embedded.py /apps/ACTUAL-HASH/index.html` using Orbit's `.runtime/browser-venv/bin/python` from the repository. Verified real GitHub fetch at e79fcc04: 95 source modules, all 96 assets with geometry, offline downloaded HTML, failed-network retention, bundled reset, and nested workspace sandbox update plus map/wireframe/camera interaction. No JavaScript errors. Core build and 67 tests plus publisher tests passed.

## Verification

Run `.runtime/browser-venv/bin/python apps/cocs-viewer/test-browser.py /apps/ACTUAL-HASH/index.html` from the Orbit repository. This exercises every asset in Chromium, checks geometry and rendered frames, searches and selects, exercises camera/wireframe/keyboard controls, collapses the library and resizes the canvas. Reports and screenshots stay local and are excluded from Git and publication. Browser executable is explicitly pinned to this host's installed Playwright build in the test script.
