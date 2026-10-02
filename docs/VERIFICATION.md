# Verification record

## Documentation and prompt refresh — October 1, 2026

The follow-up documentation update adds feature workflows, refreshed injected
agent guidance, three revised/new chat shortcuts and an eight-step onboarding
tour. Local `npm run check` with the provisioned MiniLM passed: 969 total, 960
passed, zero failed, nine optional skips. Publisher 9/9, Hermes adapter 16/16,
regenerated source archive parity 3/3 and 104 relative documentation links passed.
A disposable copy of the real built frontend exercised the three shortcut drafts
and all eight tour steps in Default and Docking; zero sends or uncaught page
errors, with synthetic screenshots inspected. API authority was mocked and no
model was invoked. This follow-up has not been activated on the testing service;
the exact-head hosted/deployment evidence below belongs to its preceding build.

## Technology candidate — October 1, 2026

Recorded source: **`66d7cb33c01534cd7ce69e9badbc0560326445a3`** on
`feat/agent-workspace-technologies`, stacked on the usability branch. Package
metadata remains 0.3.1; this is testing evidence, not a published release or merge
authorization. Later documentation/prompt edits require their own checks and do
not retroactively inherit this exact-head CI result.

- [PR #11](https://github.com/mojomast/orbitdesktop/pull/11) contains usability work;
  [PR #12](https://github.com/mojomast/orbitdesktop/pull/12) contains technologies.
  Merge order, if authorized: #11 first, retarget #12 to `release/0.3.1`, then
  verify checks on the resulting base before merging.
- Exact-head hosted CI passed: catalog
  [36926014752](https://github.com/mojomast/orbitdesktop/actions/runs/36926014752),
  plugin [36926014768](https://github.com/mojomast/orbitdesktop/actions/runs/36926014768),
  technology [36926014794](https://github.com/mojomast/orbitdesktop/actions/runs/36926014794)
  (10/10), and Workbench
  [36926014812](https://github.com/mojomast/orbitdesktop/actions/runs/36926014812)
  (7/7 plus aggregate). Expensive browser coverage remains scope-gated with
  weekly/manual coverage; workspace continuity and composition run separately.
- `npm run check` with real MiniLM assets: 969 tests, 960 passed, zero failed,
  nine optional skips. Publisher 9/9, Hermes plugin 16/16 and regenerated archive
  parity 3/3 passed. These counts belong to that run, not all future environments.
- Packaged Default/Docking × optional capabilities off/configured journeys passed.
  Document-library creation was checked against a held initial response; canvas
  font handoff used the actual engine at 4× CPU throttling, with regressions shown
  to fail against the prior implementation.
- Testing deployment **8803 — main-next** activated immutable package
  `orbit-tech-66d7cb3` after idle checks and a verified complete backup. Six terminal
  identities and 22 conversation files were preserved. The initial 11→12 migration
  also preserved all 41 existing database tables.
- Post-activation public frontend/separate HTTPS sandbox checks passed in both
  renderers using disposable API state: browser launch/snapshot/close, actual MCP
  SDK result replay/local interaction, seven authority refusals and zero uncaught
  page errors per renderer. Synthetic screenshots were inspected.

Full delivery evidence:
[PR #12 verification comment](https://github.com/mojomast/orbitdesktop/pull/12#issuecomment-5940948624).
Reproduction: [Technology acceptance](TECHNOLOGY_ACCEPTANCE.md),
[Usability](WORKSPACE_USABILITY.md), and the feature-specific browser fixtures.

### Outstanding acceptance and limits

- Owner walkthrough and visual acceptance of the actual workspace remain pending;
  disposable automated acceptance does not establish that.
- gVisor remains off on this host: the unprivileged user-namespace probe is denied,
  and approved runsc/rootfs are absent. No real containment acceptance is claimed.
- Browser copilot/MCP Apps are configured on the testing deployment; browsers are
  disposable/signed out, and imported MCP snapshots have closed capabilities.
- Upstream Hermes catalog admission remains pending. Workbench remains
  experimental/off by default, and projects retaining 200 committed arrangement
  proposals still need a separate archival design.
- Merge, version selection, tag and release publication remain owner decisions.

## Historical initial verification — September 19, 2026

The following records the original small build, not current coverage or feature
availability. Later guides and the exact-head evidence above supersede its limits.

Environment: Linux x64, Node 24.19.0. Date: 19 September 2026.

### Automated

`npm run build`: strict TypeScript check and production Vite bundle.

`npm test`: 12 tests covering:

- Valid/corrupt workspace validation and duplicate ID rejection.
- Nested split/removal and pane identity retention.
- Portrait dimensions and excessive tree/pane rejection.
- Token/dimension validation and hostile Host input.
- Production HTML and security headers.
- Authentication origin and token rejection/acceptance.
- HTTP Host rejection with an actual overridden Host header.
- WebSocket foreign-origin rejection.
- Wrong token rejection without creating a shell.
- Actual PTY command execution, resize (`stty size`), and disconnect cleanup.
- Malformed protocol input rejection.
- Real high-volume shell output pause and resume via ACK flow control.

Tests start a temporary loopback server on port 14318 with an explicitly test-only token. The shell integration commands use Unix tools and are currently Linux/macOS-oriented; native Windows requires equivalent test commands before claiming cross-platform verification.

### Interactive browser checks

Verified startup, monitor selection, flat focus, aspect changes, split creation, keyboard splitter resize, chat stub messaging, adding displays, pitch changes, and restoring saved layout after reload. Also verified preset replacement with confirmation and return from focus to the same spatial monitor.

The cloud test browser has WebGL disabled. Three.js CSS3D monitor transforms and the functional DOM fallback were exercised; the WebGL grid/room could not be visually verified in that browser. Actual terminal commands were verified through the production backend integration tests; credential entry and live xterm typing were not exercised through the cloud browser.

Optional WebMCP registration is feature-detected. The test browser did not provide modelContext, so calls to those optional tools could not be validated. No dependency on WebMCP is required for the UI.

Native Windows/macOS, assistive-technology behavior, touch-device hardware, XR, remote SSH, real agents, and unrestricted browser embedding are not claimed as tested or implemented.
