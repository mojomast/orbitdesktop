# Working on Orbit Desktop

Orbit is a single-owner, agent-customizable workspace, not just a spatial terminal demo. Hermes is the runtime; generated widgets use the sandboxed plugin lifecycle. Read `docs/AGENT_GUIDE.md` before changing a live workspace, `docs/PLUGINS.md` for plugins, and `docs/ARCHITECTURE.md` before changing core code.

For current features, read `docs/WORKSPACE_USABILITY.md`, `docs/TECHNOLOGY_FEATURES.md` and the linked feature contracts. `docs/WORKSPACE_PROMPTS.md` contains owner-facing examples; `docs/AGENT_GUIDE.md` is injected into workspace-aware Hermes requests. Keep both aligned with implemented capabilities. Reuse reviewed built-in surfaces before generating replacements. Owner-only feature APIs are not workspace-controller or generated-plugin capabilities; explicit draft insertion never sends a message. Private documents, drafts, sources and recipes are outside layout checkpoints.

Preserve uncommitted owner changes. Never stage everything blindly. Keep credentials, `.runtime`, transcripts and personal screenshots out of Git. Use a separate browser workspace for tests/screenshots. Do not restart a server with live terminals without considering session preservation.

Prefer validated workspace operations over source edits. Use content-addressed plugin publication for new widgets. Do not overwrite old bundles needed by checkpoints. Do not claim browser visibility without acknowledgement and inspection. Run `npm run check`, relevant publisher tests and real browser tests; report limitations honestly.

The development candidate uses workspace schema 12 while package metadata remains 0.3.1; do not imply a new release is published. Read `docs/DEPLOYMENT.md` before activation. Regenerate the tracked Hermes source archive with `scripts/bundle_hermes.py` after included source/documentation changes and verify archive parity. Keep expensive browser CI scoped with weekly/manual coverage.

## Cursor Cloud specific instructions

The Cloud Agent environment starts the local development servers on boot. Vite listens on port 4173 and proxies `/api` to the Orbit API on port 4318. The API is started with `ORBIT_DEV_ORIGINS=http://127.0.0.1:4173,http://localhost:4173`. Open http://127.0.0.1:4173. When `ORBIT_TOKEN` is unset, the API writes a generated host token to `.runtime/session-token`. Use that token with Connect host, then Connect shell in a terminal pane. Do not commit `.runtime`, and do not restart those servers while a terminal session is in use.

`npm run check` runs the contract checks, typecheck, isolated production build, and Node tests. `python3 tests/plugin-publish.test.py` covers the publisher. Optional Xpra, shared desktop, and Hermes gateway setup are separate from this environment. The `node` on `PATH` must be a full Node distribution (npm resolved from `../lib/node_modules/npm` beside `process.execPath`); the agent overlay binary does not have that layout.
