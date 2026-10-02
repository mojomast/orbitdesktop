# Working on Orbit Desktop

Orbit is a single-owner, agent-customizable workspace, not just a spatial terminal demo. Hermes is the runtime; generated widgets use the sandboxed plugin lifecycle. Read `docs/AGENT_GUIDE.md` before changing a live workspace, `docs/PLUGINS.md` for plugins, and `docs/ARCHITECTURE.md` before changing core code.

For current features, read `docs/WORKSPACE_USABILITY.md`, `docs/TECHNOLOGY_FEATURES.md` and the linked feature contracts. `docs/WORKSPACE_PROMPTS.md` contains owner-facing examples; `docs/AGENT_GUIDE.md` is injected into workspace-aware Hermes requests. Keep both aligned with implemented capabilities. Reuse reviewed built-in surfaces before generating replacements. Owner-only feature APIs are not workspace-controller or generated-plugin capabilities; explicit draft insertion never sends a message. Private documents, drafts, sources and recipes are outside layout checkpoints.

Preserve uncommitted owner changes. Never stage everything blindly. Keep credentials, `.runtime`, transcripts and personal screenshots out of Git. Use a separate browser workspace for tests/screenshots. Do not restart a server with live terminals without considering session preservation.

Prefer validated workspace operations over source edits. Use content-addressed plugin publication for new widgets. Do not overwrite old bundles needed by checkpoints. Do not claim browser visibility without acknowledgement and inspection. Run `npm run check`, relevant publisher tests and real browser tests; report limitations honestly.

The development candidate uses workspace schema 12 while package metadata remains 0.3.1; do not imply a new release is published. Read `docs/DEPLOYMENT.md` before activation. Regenerate the tracked Hermes source archive with `scripts/bundle_hermes.py` after included source/documentation changes and verify archive parity. Keep expensive browser CI scoped with weekly/manual coverage.
