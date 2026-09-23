# Interface themes

Themes now style Orbit's parent UI rather than only the desktop background. Windows XP (Luna-inspired, no Microsoft assets), Classic 95, Paper Studio and Cyberpunk join the existing color presets. Open Themes for miniature previews and a Customize individual UI elements editor. Changes require host authentication and a pre-change checkpoint. Wallpaper, panes, layout, plugins and full-viewport settings are retained. Existing custom overrides survive preset changes.

Themes cover window title bars and borders, taskbar, Start and layout menus, sidebar, dialogs, buttons, input controls and chat surfaces. They do not inject styles into sandboxed apps, third-party iframes, native apps or terminal contents. Owner-specific per-window transparency rules remain higher-priority exceptions.

Agent operation example:

```json
{"action":"patch_appearance","patch":{"theme":"xp","titlebarHeight":40,"controlRadius":3,"surfaceColor":"#ece9d8","titlebarColor":"#0754d7","uiFont":"classic"}}
```

Read current revision and apply using the scoped controller and base_revision. Supported theme IDs: midnight, xp, classic, paper, cyberpunk. Additional six-digit hex fields: surfaceColor, panelColor, borderColor, mutedColor, titlebarColor, titlebarTextColor, buttonColor, buttonTextColor. Existing textColor and accentColor also style chrome. controlRadius is 0–24px; titlebarHeight is 24–64px; uiFont is system, classic or mono. CSS strings, remote URLs, arbitrary fonts and unknown theme IDs are rejected.

Use reset_appearance with specific keys to remove overrides without removing the theme. Resetting theme disables the new chrome skin and returns to the deployment's existing CSS. Workspace checkpoints restore appearance state but not deployed code or external app styling.

Core frontend and backend must both be updated. One frontend reload loads the implementation; later theme changes use normal live workspace synchronization. No reload is needed between themes. Tests: npm run check and .runtime/browser-venv/bin/python tests/theme-chrome.browser.py (isolated backend/runtime, real browser, checkpoint/apply, all four skins, custom height, reload, mobile overflow).

## Windows XP details and regression coverage

The Luna-inspired skin includes beveled blue scrollbars, arrow buttons where the browser supports scrollbar pseudo-elements, glossy blue window controls and a red Close button with a white X. The taskbar runs edge-to-edge with a green Start button and recessed active-window tabs. Start uses a blue header and cream panels; its results scroll independently so search and quick launch remain accessible. Native overlay scrollbars and Firefox may use simplified browser-supported styling. This does not theme scrollbars inside cross-origin or sandboxed applications.

The browser regression checks reach the last Start result, search for terminal actions, restore keyboard focus with Escape, check 390px menu bounds, and assert the red Close control. All four skins, custom title-bar height, persistence and JavaScript errors are checked against an isolated deployment, not the owner's workspace.

## Release and upgrade

These features ship in Hermes plugin 0.2.6. The plugin includes the matching tracked source bundle. Updating the catalog pin does not update an already-running Orbit deployment. Use the plugin setup workflow in a new directory and migrate deliberately; do not overwrite live runtime data. Keep the previous release directory for rollback. No third-party Windows assets or wallpaper are bundled with the XP-inspired theme.
