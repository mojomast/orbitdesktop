# Port log: reconcile/port-onto-0.2.7

Trunk target: origin/main @195d529 (release 0.2.7). Main and the live workspace are untouched.

## Corrected understanding of the theme split

Earlier guidance said the two lines had two incompatible theme architectures. That was
wrong, and the diffs prove it. `theme-tokens.ts` and `theme-picker.ts` are **byte-identical**
on both lines (md5 verified), as are `theme-icons.ts`, `theme-icon-surrounds.css`,
`theme-nous.css`, `theme-personalities.css`, `theme-taskbars.css` and `theme-95.css`.

The 14-preset catalogue is byte-identical too. So the token contract was never forked.
Our line *extends* the shared contract additively; it does not replace it. The port is
therefore an additive merge for the theme layer, not the two-architecture refactor that
was originally described.

A second correction: our line is largely a *superset*, not a parallel fork. `main.ts` on
our side already contained three of upstream's four 0.2.7 additions (the `orbit-focus-agent`
listener, the 3-arg `showThemes` call, and the `window-close` class). A three-way merge of
every changed `src/` file (base 438044e, ours=main, theirs=0.2.7) produced only **five**
genuine conflicts in `src/`, and the whole port reduced to a small number of real deltas.

## Slices

- **Slice 1 — theme layer (DONE, 045a73a).** New: `orbit-menu.ts/.css`, `theme-menus.css`,
  `theme-coverage.css`. Modified: `theme-chrome.ts` (import the two new stylesheets),
  `theme-chrome.css` (derived `--theme-menu*`/`--theme-dock*`/`--theme-background` tokens;
  exclude `.orbit-logo`/`.orbit-menu-*`/`.orbit-toolbar-item` from the blanket button rule),
  `theme-xp.css` (XP chat skin, a pure superset of upstream). Owner-private brand files
  deliberately excluded so a clean checkout builds.

- **Slice 2 — core type contract (DONE, 3fa9c0e).** `model.ts` gains `Monitor.spatial`,
  `spatialFontSize`, `opacity`, `Workspace.spatialCamera`, and `validSpatial`/`validCamera`
  validation — a pure superset of upstream (zero removals). `scene.ts` becomes our spatial
  camera/navigation superset (`frameAll`, `frameWindow`, `setNavigation`, `configureCamera`,
  `spatialWindow` layout). Upstream `scene.ts` is unchanged since the merge base, so nothing
  upstream is reverted. New: `spatial-layout.ts`, `spatial-controls.ts`.
  This resolved the slice-2 blocker: the UI modules now typecheck.

- **Slice 3a — ours-only UI modules (DONE, e49b18d).** `layout-presets.ts`,
  `layout-switcher.ts`, `mobile-boot.ts`, `mobile.ts`, `mobile.css`, `onboarding.ts/.css`,
  `spatial.css`, `unified-taskbar.css`. Typecheck clean; not yet wired into `main.ts` (they
  are imported by slice 3b's `main.ts`).

- **Slice 3b — src wiring (DONE, f7d5deb).** Three-way merge of the changed `src/` files.
  Clean auto-merges installed for `agent-chat.ts`, `compact-windows.css`, `desktop-icons.css`,
  `minimize.ts`, `panes.ts`, `plugins.ts`, `shared-browser.ts`, `viewport.css`, `viewport.ts`,
  `workspace-extensions.ts`, `workspace-ops.ts`, `workspace-theme.css`, `xpra-apps.ts`.
  Manual resolutions:
  - `main.ts` — single conflict (top bar). Resolved to ours (the `orbit-toolbar` structure);
    upstream's `orbit-open-devplan-studio` listener auto-merged in.
  - `desktop-icons.ts` — resolved to ours (`Shortcut.pinned` + folder grouping; superset).
  - `workspace-appearance.ts` — kept both our `orbit-wallpaper-state` and upstream's
    `orbit-viewport-state` dispatch.
  - `themes.ts`, `theme-personality.ts` — kept upstream's clean public roster; the only delta
    was the owner-brand entries, which stay on-host per slice policy.
  - `theme-chrome.ts` — already correct from slice 1 (imports `theme-menus.css` /
    `theme-coverage.css`, omits the owner-private brand imports).
  - `linux-app-url.ts` — upstream-only; unchanged from HEAD.

## Verification

- `tsc --noEmit` (strict) green; `vite build` green.
- `npm test` 77/78. The single failure, "unconfigured bridge fails closed"
  (`tests/agent.test.mjs`), is pre-existing and environmental — it fails on a clean
  origin/main checkout too and cannot be reached by theme/UI changes.
- **Live headless check** (Playwright, isolated port 4390, fresh workspace): the orbit logo
  renders, the drawer is closed by default, opens on click, exposes **19 items across 3
  sections** — including upstream's *Devplan Studio* entry alongside our Hermes shortcuts —
  and produces **zero console/JS errors**. The menu resolves the derived theme tokens
  (themed border/radius, not hardcoded). Screenshot: `/tmp/orbit-reconcile-menu.png`.
- The first-run onboarding tour is a modal `<dialog>` that intercepts the logo click on a
  fresh profile; the check dismisses it first. This matches the `tests/orbit_menu.py` fix.

## Remaining slices

4. Server: `agent.mjs` (shared-chats link/validate path), add `shared-chats.mjs`,
   `mobile-proxy.mjs`, `mobile-security.mjs`. Note upstream has `automation.mjs` which we lack.
5. Owner-brand themes: on-host only, never committed (matches main's posture).
6. Content corpus: `extensions/`, `apps/`, `docs/`, `tests/`.

## Reversibility

Each slice is one commit on `reconcile/port-onto-0.2.7`. Revert a slice with
`git revert <sha>`; abandon the whole port by deleting the branch — main, the backup
bundle and `backup/pre-reconciliation-20260925` are unchanged.
