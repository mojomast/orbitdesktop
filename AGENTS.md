# Working on Orbit Desktop

Orbit is a single-owner, agent-customizable workspace, not just a spatial terminal demo. Hermes is the runtime; generated widgets use the sandboxed plugin lifecycle. Read `docs/AGENT_GUIDE.md` before changing a live workspace, `docs/PLUGINS.md` for plugins, and `docs/ARCHITECTURE.md` before changing core code.

Preserve uncommitted owner changes. Never stage everything blindly. Keep credentials, `.runtime`, transcripts and personal screenshots out of Git. Use a separate browser workspace for tests/screenshots. Do not restart a server with live terminals without considering session preservation.

Prefer validated workspace operations over source edits. Use content-addressed plugin publication for new widgets. Do not overwrite old bundles needed by checkpoints. Do not claim browser visibility without acknowledgement and inspection. Run `npm run check`, relevant publisher tests and real browser tests; report limitations honestly.
