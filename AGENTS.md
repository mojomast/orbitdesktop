# Working on Orbit Desktop

Orbit is a single-owner, agent-customizable workspace; Hermes is the runtime and widgets use the sandboxed plugin lifecycle.

- Only open `docs/AGENT_GUIDE.md` when changing a live workspace (injected into workspace-aware Hermes requests).
- Open `docs/PLUGINS.md` when adding plugins, and `docs/ARCHITECTURE.md` only when changing core code.
- Consult `docs/WORKSPACE_USABILITY.md` and `docs/TECHNOLOGY_FEATURES.md` only when those features change.
- Use `docs/WORKSPACE_PROMPTS.md` only for owner-facing examples; keep it aligned with implemented features.
- Open `docs/DEPLOYMENT.md` only before activation.

Preserve uncommitted owner changes; never stage everything blindly. Keep credentials, `.runtime`, transcripts and personal screenshots out of Git. Use a separate browser workspace for tests/screenshots. Don't restart a server with live terminals without preserving sessions.

Prefer validated workspace operations over source edits. Use content-addressed plugin publication; never overwrite bundles needed by checkpoints. Don't claim browser visibility without acknowledgement and inspection.

Run `npm run check`, relevant publisher tests and real browser tests; report limitations honestly. Dev candidate uses schema 12 while package metadata is 0.3.1; don't imply a release is published. After included source/doc changes, regenerate the archive with `scripts/bundle_hermes.py` and verify parity. Keep expensive browser CI weekly/manual.
