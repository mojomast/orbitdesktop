# Comet / Orbit Desktop 0.2.7

This is the historical 0.2.7 UI feature note, not the acceptance record for the
current evolution candidate. The menu/themes/catalog are retained in that
candidate under the same v1 workspace contract. See [Testing branch](TESTING_BRANCH.md)
for the combined evidence and [Deployment](DEPLOYMENT.md) for the schema-4
placement migration, rollback and optional network-access choices. Use the exact
build/commit when testing; a plugin/UI version label alone does not identify the
store or renderer implementation.

This release adds 14 distinct theme presets, local wallpapers, theme-specific icon artwork and surrounds, and differentiated taskbar treatments, including Nous Atelier. See NOUS_THEME.md for artwork attribution. Reduced-motion preferences remain respected; embedded applications retain their own styling.

Agent chats gain a per-pane Show tools toggle, inline expandable tool details, durations, running/completed/failed totals, grouped successful calls and Hide completed. Auto-follow pauses when reading older events. Events without call IDs remain explicitly uncorrelated rather than falsely matched.

An activity strip reports agent status and opens details. Workspace agents lists registered agent panes and focuses their windows. Agent toolbar controls sit beside the pane selector and wrap at narrow widths.

The Hermes adapter capabilities and trust boundaries are unchanged: loopback scoped control, mutations disabled by default, no self-updater. Source is bundled for explicit setup; optional external services still require separate consent/configuration. Workspace checkpoints restore workspace settings, not source deployments or external side effects.

Release verification: clean npm ci (0 vulnerabilities), production TypeScript/Vite build, Node test suite, and Chromium fixture tests for activity/overview, narrow toolbar and inline tools. These tests use an isolated checkout and do not inspect or mutate the owner's live workspace.
