# Verification record

## Published CSV handoff — October 2, 2026

Data workbench accepts a strict, same-origin published CSV identity plus SHA-256
through its built-in surface URL. The browser bounds downloads, verifies bytes
before loading the existing DuckDB engine, and leaves query execution explicit.
See [Data Lab](DATA_LAB.md) for the route and publication contract.

- `npm run check`: **1,011 tests, 1,000 passed, 11 optional skips, zero failures**.
- Real Chromium/DuckDB tests passed auto-loading without a file picker, explicit
  query results, hash mismatch refusal, recovery with manual input, cancellation
  versus replacement, and narrow-screen wrapping. The existing CSV/JSON/Parquet,
  recipe, exact numeric sharing and external-access confinement journeys passed.
- Publisher tests **9/9** and regenerated Hermes source archive parity **3/3**
  passed. This feature retains schema **12** and package metadata **0.3.1**.
- Browser-local input state is separate from the layout acknowledgement. These
  disposable checks do not claim to inspect an owner's existing browser tab.

## Agency integration — October 2, 2026

The owner authorized merging and deployment. The usability, technology and agency
PRs [#11](https://github.com/mojomast/orbitdesktop/pull/11),
[#12](https://github.com/mojomast/orbitdesktop/pull/12) and
[#13](https://github.com/mojomast/orbitdesktop/pull/13) were merged in dependency
order into `release/0.3.1`. Each retargeted prerequisite base had the same source
tree as its previously tested feature head. Package metadata remains **0.3.1**,
workspace schema is **12**, and no new tag or published release is implied.

Agency application-source validation at `611d3a9e5ca98af94a696815f53ba7c845a626d8`:

- Local `npm run check`: **1,007 tests, 998 passed, nine optional skips, zero
  failures**, with real MiniLM assets and pinned Hermes context acceptance enabled.
- Hermes adapter 18/18, resource-cache lifecycle 3/3, publisher 9/9 and regenerated
  source archive parity 3/3 passed; 292 relative documentation links resolved.
- Real browser feature, document/canvas recovery, Normal cited-brief, Workbench
  recovery, command-palette and integrated technology/release journeys passed.
  Default and Docking were exercised in disposable synthetic workspaces.
- Exact-head PR-event CI passed: Workbench
  [37020536916](https://github.com/mojomast/orbitdesktop/actions/runs/37020536916),
  technology [37020536886](https://github.com/mojomast/orbitdesktop/actions/runs/37020536886),
  plugin [37020537199](https://github.com/mojomast/orbitdesktop/actions/runs/37020537199)
  and catalog [37020536829](https://github.com/mojomast/orbitdesktop/actions/runs/37020536829).

Normal adapter tests used actual pinned gateway lifecycle, registry and thread
context with a deterministic agent body; they do not establish provider inference
quality. [Agency evolution](AGENCY_EVOLUTION.md) describes implemented outcomes;
[resource delegation](RESOURCE_DELEGATION.md) describes compatible gateway setup.
Committed arrangements, completed channels and successful adapter operations no
longer consume active capacity indefinitely; physical history garbage collection
remains separate work.

### Deployment evidence and remaining acceptance

The [PR #13 delivery log](https://github.com/mojomast/orbitdesktop/pull/13) records
the selected immutable package, exact merge/CI identity, activation receipt and
preservation checks for **8803 — main-next**. Confirm live identity through
`/api/health`; a merged PR or successful build alone is not activation evidence.
Complete stopped-writer runtime/configuration backups and terminal identity checks
are required by [Deployment](DEPLOYMENT.md).

- Owner walkthrough/visual acceptance remains distinct from disposable browser
  tests. Desktop Review was disconnected during agency acceptance; headless real
  browser journeys and synthetic screenshot inspection supplied that evidence.
- Normal delegation requires the source-pinned local gateway and explicit profile
  mapping. The owner's existing gateway is not source-compatible; use a separately
  provisioned compatible test gateway rather than weakening source checks.
- gVisor remains unavailable on this host: user-namespace creation is denied and
  approved runsc/rootfs are absent. No real containment acceptance is claimed.
- Browser copilot uses disposable signed-out browsers; logged-in Discord and
  autonomous provider quality are separate acceptance trials. MCP snapshots retain
  closed capabilities. Workbench remains experimental and off by default.
- Upstream catalog admission, version selection, tags and release publication are
  separate from this authorized source merge and testing deployment.

## Historical documentation and prompt refresh — October 1, 2026

The follow-up documentation update adds feature workflows, refreshed injected
agent guidance, three revised/new chat shortcuts and an eight-step onboarding
tour. Local `npm run check` with the provisioned MiniLM passed: 969 total, 960
passed, zero failed, nine optional skips. Publisher 9/9, Hermes adapter 16/16,
regenerated source archive parity 3/3 and 104 relative documentation links passed.
A disposable copy of the real built frontend exercised the three shortcut drafts
and all eight tour steps in Default and Docking; zero sends or uncaught page
errors, with synthetic screenshots inspected. API authority was mocked and no
model was invoked. This follow-up was subsequently activated as `orbit-tech-efc8c22`,
preserving six terminal identities and 22 conversation files; see the
[deployment receipt](https://github.com/mojomast/orbitdesktop/pull/12#issuecomment-5944462938).

## Historical technology candidate — October 1, 2026

Recorded source: **`66d7cb33c01534cd7ce69e9badbc0560326445a3`** on
`feat/agent-workspace-technologies`, stacked on the usability branch. Package
metadata remains 0.3.1; this is testing evidence, not a published release or merge
authorization. Later documentation/prompt edits require their own checks and do
not retroactively inherit this exact-head CI result.

- [PR #11](https://github.com/mojomast/orbitdesktop/pull/11) contains usability work;
  [PR #12](https://github.com/mojomast/orbitdesktop/pull/12) contains technologies.
  They were subsequently merged in that order after owner authorization.
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

### Limits recorded at that milestone

- Owner walkthrough and visual acceptance of the actual workspace remain pending;
  disposable automated acceptance does not establish that.
- gVisor remains off on this host: the unprivileged user-namespace probe is denied,
  and approved runsc/rootfs are absent. No real containment acceptance is claimed.
- Browser copilot/MCP Apps are configured on the testing deployment; browsers are
  disposable/signed out, and imported MCP snapshots have closed capabilities.
- Upstream Hermes catalog admission was pending and Workbench was experimental/off
  by default. The committed-arrangement capacity limit recorded then is superseded
  by the agency retention implementation above.
- Merge was subsequently authorized; version selection, tag and release publication
  remain separate owner decisions.

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
