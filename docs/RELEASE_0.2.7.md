# Comet / Orbit Desktop 0.2.7

This release adds 14 distinct theme presets, local wallpapers, theme-specific icon artwork and surrounds, and differentiated taskbar treatments, including Nous Atelier. See NOUS_THEME.md for artwork attribution. Reduced-motion preferences remain respected; embedded applications retain their own styling.

Agent chats gain a per-pane Show tools toggle, inline expandable tool details, durations, running/completed/failed totals, grouped successful calls and Hide completed. Auto-follow pauses when reading older events. Events without call IDs remain explicitly uncorrelated rather than falsely matched.

An activity strip reports agent status and opens details. Workspace agents lists registered agent panes and focuses their windows. Agent toolbar controls sit beside the pane selector and wrap at narrow widths.

The Hermes adapter capabilities and trust boundaries are unchanged: loopback scoped control, mutations disabled by default, no self-updater. Source is bundled for explicit setup; optional external services still require separate consent/configuration. Workspace checkpoints restore workspace settings, not source deployments or external side effects.

Release verification: clean npm ci (0 vulnerabilities), production TypeScript/Vite build, Node test suite, and Chromium fixture tests for activity/overview, narrow toolbar and inline tools. These tests use an isolated checkout and do not inspect or mutate the owner's live workspace.
