# Interface themes

Themes now style Orbit's parent UI rather than only the desktop background. Windows XP (Luna-inspired, no Microsoft assets), Classic 95, Paper Studio and Cyberpunk join the existing color presets. Open Themes for miniature previews and a Customize individual UI elements editor. Changes require host authentication and a pre-change checkpoint. Wallpaper, panes, layout, plugins and full-viewport settings are retained. Existing custom overrides survive preset changes.

Themes cover window title bars and borders, taskbar, Start and layout menus, sidebar, dialogs, buttons, input controls and chat surfaces. They do not inject styles into sandboxed apps, third-party iframes, native apps or terminal contents. Owner-specific per-window transparency rules remain higher-priority exceptions.

Agent operation example:

```json
{"action":"patch_appearance","patch":{"theme":"xp","titlebarHeight":40,"controlRadius":3,"surfaceColor":"#ece9d8","titlebarColor":"#0754d7","uiFont":"classic"}}
```

Read current revision and apply using the scoped controller and base_revision. Supported theme IDs: midnight, xp, classic, paper, cyberpunk. Additional six-digit hex fields: surfaceColor, panelColor, borderColor, mutedColor, titlebarColor, titlebarTextColor, buttonColor, buttonTextColor. Existing textColor and accentColor also style chrome. controlRadius is 0–24px; titlebarHeight is 24–64px; uiFont is system, classic or mono. CSS strings, remote URLs, arbitrary fonts and unknown theme IDs are rejected.

Use reset_appearance with specific keys to remove overrides without removing the theme. Resetting theme disables the new chrome skin and returns to the deployment's existing CSS. Workspace checkpoints restore appearance state but not deployed code or external app styling.

## Distinct desktop personalities

The picker also offers Aurora Glass (frosted dock and lifting buttons), Phosphor (green command log, scanline chrome and inverted hover), Blueprint (drafting grid, double borders and ruled chat), and Pop Art (halftone, heavy outlines and press-depth buttons). Paper, Cyberpunk, Midnight, Ocean, Forest, Plum and Ember have additional scoped chrome/chat treatments. XP Messenger and Classic 95 Fixedsys Notepad remain intact.

These presets deliberately reuse the existing validated theme families plus their background color; `themePersonality` resolves the pair to a presentation-only `data-orbit-style`. This avoids a live backend restart or schema migration. Changing a preset's background to an unrelated custom color returns to its base family. Apply complete presets from `themePatch`, not invented theme IDs. New picker previews reflect the personality tokens.

CSS effects do not change saved window geometry or pane identities. Reduced motion disables hover movement; forced colors removes decorative clipping/shadows. Explicit wallpaper (including an empty string disabling wallpaper) takes precedence over procedural theme backgrounds. Clear only the wallpaper override to see the theme's default procedural background. Custom token overrides continue to take precedence where supported. Iframe and terminal internals retain their own styling.

Verification: production build and 92 unit tests passed; `tests/theme-personalities.browser.py` verifies all thirteen public personalities through the actual authenticated picker, reload persistence, unchanged panes, responsive chat, mobile picker, dock motion/reduced motion, console hover, double borders and press depth. `tests/theme-chrome.browser.py` verifies XP/95 regressions and base skins. Tests use isolated runtime/browser storage, not the owner's workspace. Previous frontend build is in `.runtime/theme-personality-backup/dist`; workspace checkpoints do not roll back source/build files. Existing tabs require one frontend reload, then theme changes apply live without reload.

## Orbit menu and whole-interface coverage

The orbit menu (the popout drawer opened from the top-left logo, its pinned
top-toolbar strip and the logo button itself) is themed by the same preset as
the rest of the workspace, using that preset's own design language rather than a
generic panel: midnight is a flat graphite rail with a lime active rule, XP gets
a Luna caption and tactile gradient rows, Classic 95 gets gray outset bevels and
a sunken selection, Paper Studio gets ruled serif rows on a hard-offset card,
Cyberpunk gets clipped hazard corners with offset neon type, Aurora Glass is
frosted with hover lift, Phosphor is an uppercase mono log with reverse-video
selection, Blueprint is a dashed drafting field with a crosshair cursor, Pop Art
gets inked rows with press depth and candy colours, Ocean has porthole rims that
fill on hover, Forest swaps leaf radii, Plum adds dotted ticket edges and glow,
Ember is a ridged brass rack with heat illumination, Nous Atelier is a ruled
celestial folio and the private brand set keeps its accent rails and price-tag
hovers.

Coverage was extended beyond the original chrome list so the whole host UI
follows the theme: Start menu (panel, heading, search, quick actions, results),
layout switcher panel and list, desktop shortcuts and folder panels, minimised
tray, spatial toolbar and dialog, plugin manager, Hermes tools dialog and
activity strip/overview, inline tool cards, the full-viewport escape hatch,
toasts, inspector/sidebar fields, the first-run tour and scrollbars/selection.
Every declaration keeps its pre-theme value as a fallback, so an unthemed
workspace renders exactly as before.

Implementation: `src/theme-menus.css` (menu/toolbar/logo design language) and
`src/theme-coverage.css` (everything else), both imported from
`src/theme-chrome.ts` immediately after `theme-chrome.css` so preset-specific
rules in the later personality/brand files still win ties. `theme-chrome.css`
gains derived surface tokens — `--theme-menuColor`, `--theme-menuTextColor`,
`--theme-menuItemColor`, `--theme-menuItemTextColor`, `--theme-menuBorderColor`,
`--theme-menuRadius`, `--theme-menuHead`, `--theme-menuShadow`,
`--theme-dockColor`, `--theme-dockTextColor` and `--theme-background` — all
aliases of the existing eight colour tokens plus radius/shadow. The menu
controls are excluded from the blanket control rule in `theme-chrome.css` so the
menu owns its own styling instead of fighting it.

Live tests drive these controls through the menu; `tests/orbit_menu.py` now
dismisses the first-run tour (its "Skip tour" button) before touching the logo,
because the modal dialog otherwise intercepts the click on a fresh profile.

The README gallery shows the agent chat window under each public preset. Regenerate
it with `python3 scripts/capture_theme_gallery.py`, which boots an isolated server
in a throwaway runtime, seeds a synthetic workspace containing an agent pane, and
screenshots every public preset with clearly-labelled demo chat content. The six
owner-only brand presets are intentionally excluded from that public gallery.

Verification for this change: `npm run build` and `npm test` (92/92) pass; an
isolated browser run applied all twenty presets through the real picker and
confirmed each produced a distinct menu background, border, radius, header,
item, pin and logo treatment; `tests/theme-personalities.browser.py` passes for
all thirteen public personalities; full viewport keeps the compact logo and a
34x34 exit hatch, the menu stays reachable inside full viewport, and pinning
moves 18 controls onto the toolbar with themed styling. `theme-chrome.browser.py`
reaches a pre-existing Start-menu overflow assertion (`start-results`
scrollHeight > clientHeight) that fails identically with this change reverted —
a fresh isolated workspace has only ten Start entries, so the list does not
overflow; that assertion is unrelated to theming.


Core frontend and backend must both be updated. One frontend reload loads the implementation; later theme changes use normal live workspace synchronization. No reload is needed between themes. Tests: npm run check and .runtime/browser-venv/bin/python tests/theme-chrome.browser.py (isolated backend/runtime, real browser, checkpoint/apply, all four skins, custom height, reload, mobile overflow).
