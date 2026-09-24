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

Verification: production build and 91 tests passed; `tests/theme-personalities.browser.py` verifies all nine non-retro personalities through the actual authenticated picker, reload persistence, unchanged panes, responsive chat, mobile picker, dock motion/reduced motion, console hover, double borders and press depth. `tests/theme-chrome.browser.py` verifies XP/95 regressions and base skins. Tests use isolated runtime/browser storage, not the owner's workspace. Previous frontend build is in `.runtime/theme-personality-backup/dist`; workspace checkpoints do not roll back source/build files. Existing tabs require one frontend reload, then theme changes apply live without reload.

Core frontend and backend must both be updated. One frontend reload loads the implementation; later theme changes use normal live workspace synchronization. No reload is needed between themes. Tests: npm run check and .runtime/browser-venv/bin/python tests/theme-chrome.browser.py (isolated backend/runtime, real browser, checkpoint/apply, all four skins, custom height, reload, mobile overflow).
