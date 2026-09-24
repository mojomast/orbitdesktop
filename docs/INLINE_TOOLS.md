# Inline agent tool observability

Reference inspected: https://github.com/mojomast/hermesdashboard at 74ef867f3d7ad408c6c3c6aca6c91d4532464da9. Reviewed dashboard.js timer, argument-summary and execution trace code and its lifecycle normalization documentation. This implementation independently adapts the expandable status/timing/details pattern to Comet's existing authenticated SSE bridge; it is not a complete port of Dashboard's assistant timeline.

Each agent pane has a Show tools / Hide tools toggle, off by default, remembered in browser localStorage per pane. The latest observed turn's tool trace sits inside the conversation before the final reply. Live details are in memory only and cleared on conversation/new-run change or reload. Load saved details requests the existing session-scoped persisted activity endpoint (bounded/truncated by the server), also available after reload. Saved history covers the conversation, not only the current turn.

Live rows show tool names, runtime previews, status, duration or a running elapsed clock and expandable arguments/output if present in the stream. Canonical call IDs correlate updates; missing IDs are explicitly standalone observations, never heuristically merged by tool name. On the tested runtime start/completion events lacked IDs. Completed standalone rows show their own reported duration, while unpaired starts end with result-not-observed status. Stream gaps and unavailable connections are disclosed; no guaranteed replay or complete historical reconstruction is claimed.

The existing tool-feed watcher supplies one SSE subscription per pane for both the chat and optional plugin. The plugin still receives only sanitizeToolEvent metadata, never arguments or output. Raw details render as text, never HTML. Up to 100 live rows, 12 details per row and 12,000 characters per detail. Details can contain private data; hiding is not redaction. No transcript, prompt, credentials or workspace checkpoint content is changed by the toggle.

New events follow the bottom when already near it. Scrolling up pauses following; Jump to latest resumes. Styling inherits theme colors, with no animation requirement.

Verification: npm run check (92 tests); production rebuild after saved-details addition; tests/inline-tools.browser.py against local Vite port 4187 tests fixtures for correlation, parallel IDs, literal rendering, failures, bounds, scrolling and session reset; tests/inline-tools.live.py runs an actual read-only terminal request through the deployed authenticated backend in an isolated browser workspace, checks live completion, loads persisted arguments and verifies toggle-off persistence on reload. Initial live test hit the existing shared-chat linking race; the test now waits for registration before sending.

One frontend refresh is required. No backend restart, owner layout mutation or terminal-session restart is required. Workspace checkpoints do not roll back source changes.
