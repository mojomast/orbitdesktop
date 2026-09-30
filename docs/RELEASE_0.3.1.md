# Orbit Desktop / Hermes plugin 0.3.1

Version 0.3.1 is the follow-up package to 0.3.0. Desktop and Hermes plugin
metadata use the same product version. The `hermes-plugin-v0.3.1` GitHub release
records the exact catalog-pinned commit and bundled-source checksum; catalog
acceptance is a separate reviewed SHA update.

## Highlight

**Project Workbench is now experimental and off by default.** The Normal/Workbench
switch, the **Set up task** handoff, the separate **Workbench window**, the
Project Workbench workspace tool, the troubleshooting shortcut and supervised
task-result cards stay hidden until the owner enables **Project Workbench** in
**Orbit settings** (◉ orbit menu → Settings → Orbit settings → Experimental
features).

- The switch is saved per browser, never starts work, approves execution or
  configures a worker.
- Disabling the surface hides its controls without deleting stored tasks,
  candidates, results, receipts or conversations, and preserves each pane's
  earlier Normal/Workbench preference.
- A pane last used in Workbench mode shows a short notice with an enable action
  while its Normal chat remains fully usable.
- Server authority boundaries are unchanged: preparation, native workers, checks
  and review still require their existing explicit approvals and host setup.

Everything else matches 0.3.0, including SQLite schema 11, the v1 workspace
contract and the sandboxed app-manifest format. No data migration is required.

## Verification

- `npm run check`: **776 passed, 0 failed, 8 optional skips**, including the new
  `tests/experimental.test.mjs`.
- New `tests/experimental-workbench.browser.py` real-server gate test: hidden by
  default (including a pane previously left in Workbench mode), revealed only
  from Orbit settings, restored across reload, and disabled again without
  touching stored state.
- Workbench browser suites (`pane-workbench-mode`, `workbench-setup`,
  `project-workbench`, `workbench-results-ui`, `agent-pane-ux`) pass with the
  feature explicitly enabled.
- The exact-head CI results for this package are recorded on `release/0.3.1` and
  its release page. No paid-provider acceptance is claimed.

## Upgrade and rollback

Compatibility is unchanged from 0.3.0: workspace database schema 11, v1
serialized workspace, plugin manifest versioned independently. Read
[Deployment](DEPLOYMENT.md) before changing a running deployment and keep the
standard full runtime/configuration backup. Rolling back to 0.3.0 against
schema-11 data is supported; the only behavioral difference is the restored
Workbench default.
