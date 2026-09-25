# Spatial scene upgrade

The spatial renderer uses a Three.js perspective camera and native CSS3D DOM surfaces, not screenshots of applications. Windows have independent world-space position, width, height, yaw and pitch. It is not WebXR, a browser compositor replacement, or a WebGL texture/occlusion system.

## Controls

Select Spatial after loading the new frontend once. Existing clients need one reload; subsequent geometry, camera, resolution and tiling edits are immediate. The owner workspace is not automatically rearranged.

- Drag a title bar to move in the camera plane; Shift-drag changes world Z; Ctrl/Command-drag changes yaw/pitch.
- Drag the bottom-right handle to resize width and height independently, anchoring the opposite corner.
- Double-click a title or use Approach to frame the selected window without entering flat Focus mode.
- Background drag orbits; Shift/right/middle drag pans; wheel dollies. Alt-drag can navigate over native window content. Cross-origin iframe input cannot bubble into the host.
- Navigate makes window surfaces non-interactive and captures workspace focus. WASD/arrows travel relative to the camera; Q/E travel vertically. Escape restores interaction. A visible Interact button is another exit.
- Fit all recovers a lost camera view.
- Arrange / edit offers grid, single row and curved-wall layouts, column count, gap, dialog-local arrangement undo, precise coordinates/dimensions/angles and surface resolution.

## Persistence and quality

Optional Monitor.spatial contains x/y/z (-10000 to 10000), width/height (0.3 to 200 world units), yaw (-360 to 360 degrees), pitch (-89 to 89) and resolution (1280/1920/2560/3840 CSS pixels wide). Tall surfaces are capped at 4096 CSS pixels high. Default width is 1920 instead of the old 600. Native text remains live browser-rendered text; remote video/Xpra/VNC streams retain their own source resolution. Resolution is explicit and does not change during navigation, avoiding iframe/terminal reflow on each camera move. More pixels fit more content and make text smaller at the same distance; use Approach, zoom, or text-size controls. Browser perspective/compositing can still soften text at extreme angles or magnifications.

Workspace.spatialCamera stores target x/y/z, azimuth/elevation and distance. It survives local export/reload and authenticated server sync. Existing layouts without these optional fields retain legacy placement until moved or tiled. Spatial tiling retains pane identities and 2D frame geometry. Geometry-only remote synchronization updates in place without detaching iframe/terminal nodes; actual pane/layout/view changes can still reload embedded content.

The legacy shape/position inspector redirects explicitly placed windows to the new 3D editor rather than exposing ineffective legacy controls.

## Independent text scaling and view controls

Each window now stores desktop `fontSize` (6–32px) and optional `spatialFontSize` (6–96px). Legacy windows initially use the existing size in both views; the first text edit freezes the previous 3D size before changing either view. The sidebar and window options label the active setting Desktop text size or 3D text size. A+/A− also target only the active view. Focus retains the underlying view's scale. Switching views reapplies pane fonts/iframe zoom without changing the other saved setting. Remote font-only edits update panes in place. Backend controller support for the new field needs its normal controlled reload; the browser UI and existing workspace sync preserve the optional field without a server restart.

The view switcher (Windows/Spatial/Focus) now lives in the orbit menu drawer opened from the ◉ logo in the top-left corner, together with Themes, Show panel, Full viewport, Wallpaper and Transparency; the drawer can pin those controls to the top toolbar. Browser regression tests cover independent edits, reload persistence and hit-testing the view buttons at widths 390, 700, 1024 and 1600px. This frontend change needs one page reload; no owner workspace layout or terminals were changed. Prior build: `.runtime/view-scaling-backup-1790188233/dist`. Core build rollback is separate from workspace checkpoints.

## Core operations and deployment boundary

New source-level operations: arrange_spatial (mode grid/row/curve, optional columns/gap/window_ids), set_spatial_camera (camera object), and update_window with spatial. They validate atomically and use existing scoped operation/checkpoint machinery when the backend loads this code. The running backend was intentionally not restarted during the frontend release, to avoid interrupting live connections. These new operation names require a later controlled backend reload; browser editing and server sync were verified on the existing backend. Do not claim the new controller operation names are live until verified.

Old frontend assets are retained by Vite emptyOutDir:false. Pre-upgrade dist is backed up in .runtime/spatial-upgrade-backup/dist. Workspace checkpoints restore layout/camera fields, not core JavaScript, arbitrary files or running applications. Reverting the renderer requires restoring the prior build separately; arrangement undo in the open dialog restores placements only and reframes the camera.

## Verification

npm run check: production TypeScript/Vite build and 79 tests passed, including legacy migration, tiling/pane identity preservation, camera round trip and invalid geometry rejection.

Tests/spatial-scene.browser.py (lowercase tests directory) exercises the served production build using actual mouse/keyboard actions: grid/row/curve/undo, 3840-pixel surface, drag, depth, nonuniform resize, rotation, WASD, orbit, pan, persistence and view switching. Tests/spatial-sync.browser.py uses a separately generated authenticated workspace and real server requests to verify live remote geometry/resolution/camera sync without DOM or iframe reload. No user workspace layout is used as a test fixture.
