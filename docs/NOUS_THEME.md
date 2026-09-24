# Nous Atelier for Comet / Orbit

A research-informed, unofficial theme, available in Themes → Nous Atelier. Applying it through the picker checkpoints previous appearance and preserves windows, panes and plugin registrations. Existing custom color/font overrides still take precedence. Source changes are not covered by workspace rollback. One frontend refresh is needed to load the new code; no backend restart is required.

## Research and interpretation

Inspected the official https://nousresearch.com and https://hermes-agent.nousresearch.com sites on 2026-09-24, including browser screenshots and DOM asset URLs. WebXNG/SearXNG searches returned no results; direct official-site inspection supplied the references.

Nous's visual language uses very condensed editorial display typography, ultramarine/indigo, halftone textures, a girl seal, and internet-native illustration. The Hermes landing page also uses classical engraved winged-helmet imagery and radial linework. The girl seal is identified as Nous Research by the official site; it should not be confused with the separate mythological Hermes hero illustration.

The original Comet composition combines a radial celestial diagram, offset orbital ellipses, restrained halftone dots, a prominent girl seal and spacious editorial lettering. This is an interpretation, not an official Nous product or endorsement.

## Unique interface details

- Local Barlow Condensed Light display typography, restrained uppercase headings and double-rule title bars.
- An edge-to-edge numbered index ribbon. Tabs illuminate their baseline on hover/focus; the selected tab becomes a pale index leaf. Click targets do not translate.
- Nine original astrolabe-framed semantic icons, plus the girl seal on the Start button and agent desktop shortcut. Desktop medallion registration rings rotate on hover/focus; reduced motion disables rotation and transitions.
- Field-journal chat: serif paragraphs, numbered marginal folios, ruled edges, monospace code, and a separate shaded user entry. These are presentation counters, not message IDs or audit records.
- Narrow-screen rules, keyboard focus treatments and forced-color fallbacks. No terminal/iframe theme injection or geometry changes.

## Assets and rights

Official girl seal (locally stored, embedded in wallpaper):
https://web-assets.nousresearch.com/nousnet-web/assets/hermes-landing/teams/nous-girl.66f8944c40c50f8c.svg

Official wing reference (locally stored):
https://web-assets.nousresearch.com/nousnet-web/assets/hermes-landing/teams/hermes-wing.6ee276e9bff5a166.svg

These are attributed Nous brand assets, not newly authored artwork. No blanket license or redistribution permission is inferred from the website's software license footer. Review brand/illustration permissions before distributing this theme publicly. The surrounding wallpaper composition and instrument icon framing were made for this workspace.

Barlow Condensed Light is from Google Fonts, https://github.com/google/fonts/tree/main/ofl/barlowcondensed . Its SIL Open Font License is included in public/fonts/BarlowCondensed-OFL.txt. No external font or artwork requests occur when using the theme.

## Rebuild and verification

python3 scripts/build_nous_wallpaper.py
python3 scripts/build_theme_icons.py
npm run check
.runtime/browser-venv/bin/python tests/nous-theme.browser.py

Browser tests launch a separate server with disposable runtime and authentication, never the owner's workspace. They exercise picker application, XP switch-away/back, persistence, pane preservation, local asset responses, font availability, taskbar counters/hover, rotating rings/reduced motion, journal styling, 320/480/800px chat widths, 390px picker width, and JavaScript error detection. Chat presentation samples are explicitly labeled fixtures, not actual agent responses. Screenshots are private under .runtime/nous-theme-*.png. No live owner-tab visual inspection is claimed.
