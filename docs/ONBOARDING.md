# First-run onboarding

The desktop frontend opens a seven-step Getting started tour on the first load without `orbit.onboarding.v1=done` in localStorage. Existing installations also see it once after loading this release. Finish, Skip tour and Escape mark it seen. Start → Getting started reopens it anytime. The marker is browser-local, not workspace state or a server checkpoint; clearing browser storage offers it again. With unavailable storage, the tour still works but dismissal cannot persist.

The tour covers Start/taskbar/window controls, the orbit menu (the ◉ logo drawer holding the view switcher, themes, panel, full viewport, wallpaper and transparency), independent Desktop/3D scaling, spatial navigation and tiling, mixed named 2D/3D layouts, agent customization requests, sandboxed app creation, and safety/recovery boundaries. Example prompts have explicit copy buttons and manual selection fallback. Nothing is submitted to Hermes, no app is installed, and no layout is changed by the tour. It does not collect analytics or require host unlock.

Implementation: src/onboarding.ts and src/onboarding.css, wired into src/main.ts. Native modal dialog provides top-layer display, focus containment and Escape dismissal. Titles receive focus on step changes; status feedback announces copy results; focus returns on closing when the previous element still exists. Responsive scrollable content supports small screens. This tour belongs to the desktop frontend, not the separate phone interface.

## Related guides

For the controls introduced by the tour, see [Spatial navigation and text scaling](SPATIAL_SCENE.md) and [Taskbar and named layouts](LAYOUT_SWITCHER.md). For agent execution, see [Agent guide](AGENT_GUIDE.md), [workspace operations](WORKSPACE_CONTROL.md), and [plugin publishing](PLUGINS.md). The [README](../README.md#getting-started-with-your-workspace) provides a quick-start walkthrough and example customization requests.

## Recorded release verification

The following records the original onboarding release, not a guarantee that every deployment has the same services or test results.

Verification: npm run check passed the production build and 82 automated tests. tests/onboarding.browser.py passed against https://kimi.tailec998.ts.net:4325/ in isolated browser storage: all steps, back/finish/skip/Escape, Start replay, reload suppression, clipboard success and denial fallback, widths 320/390/1440, workspace unchanged, no agent submissions and no page errors. tests/layout-switcher.browser.py also passed against the live site after dismissing onboarding.

Deployment: production dist is served live; existing tabs need one reload for new JavaScript. No backend restart or owner workspace mutation was performed. Previous build: .runtime/onboarding-backup-1790192343/dist. Workspace checkpoints do not roll back source/build files or the browser-local tour marker.
