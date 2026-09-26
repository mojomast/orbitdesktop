# Evolution testing branch

Branch: **`testing/orbit-docking-managed-terminals`**

**Current work:** [Comet Project Workbench](PROJECT_WORKBENCH.md) adds the inspector,
one-shot context sharing, supervised candidate checks and schema 6. Its [ledger](PROJECT_WORKBENCH_LEDGER.md) tracks
fresh CI/baseline results and remaining slices. The release-integration evidence
below describes the reviewed `78b6a8f` increment (schema 4), not the newer feature.

This branch starts from implementation commit `23a1afe` and includes the cumulative
evolution work since `38a9d56`, not only the latest docking changes. It is a testing
candidate, not approval to deploy, migrate an owner runtime, or replace `main`.

## Release integration

The current working candidate adds durable docking placement, owner-managed
terminal controls, and per-pane Hermes profile/session selection. The older
implementation evidence below is historical; it is not evidence for untested
changes in this candidate. See [deployment and rollback](DEPLOYMENT.md).

**Tailscale is optional.** Core tests use isolated served loopback origins. Ordinary
HTTP(S) deployments do not require a tailnet. The owner has delegated optional
tailnet-origin acceptance to the Hermes Orbit agent; those results are pending
and must not be inferred from local browser passes.

### User-reachable surfaces

- `?renderer=docking`: docking placement is implemented as a versioned,
  per-workspace Windows-view adjunct, outside v1 layout. Docking remains opt-in;
  saving placement is on by default when using it. See
  [persistence model](DOCKING_PERSISTENCE.md) for validation, orphan handling and
  checkpoint/recovery semantics.
- Terminal pane **Managed…**: metadata-only reconciliation, explicit adoption,
  finite observe/input leases, one-shot bounded output, per-send confirmation and
  revocation. Adoption does not create or move the shell. Recorded managed panes
  use identity-conditional **attach-only** reconnect; missing/changed identity
  never silently respawns a replacement. Grants are process-local and are not
  restored with the private continuity ledger. See [lifecycle and consent](MANAGED_TERMINALS.md).
  **Release…** is a separate explicit recovery action, not automatic respawn: it
  removes proven continuity metadata without killing the shell, and warns that a
  later explicit Connect may create a new shell if missing. Uncertain input sends
  retain the exact operation ID/body for retries, including across dialog reopen;
  discarding that warning requires explicit acknowledgement of duplicate risk.
- Agent pane **Profile / Session / Apply**: select a server-configured Hermes
  profile and an existing conversation independently per pane. Profile URLs/keys
  remain server-side. Changes are staged until Apply, pending runs block switching,
  and drafts are isolated by profile/session. See [configuration](HERMES.md).
- `/recovery`: independent owner recovery, checkpoint restore and registered-plugin
  activation hold; the hold is not process termination or private-data revocation.

### Deliberate boundaries

Workspace event delivery is **polling only**; there is no half-enabled workspace
SSE/push route. Hermes run-activity SSE is separate. Bundle retention remains an
explicit dry-run planner: destructive collection is not shipped. The CLI test
publishes a real disposable bundle, refreshes its index, runs the plan twice,
rejects a delete command and verifies unchanged artifact bytes.

The fresh-private-namespace terminal creation/cleanup provider remains internal;
normal panes use the non-destructive attach/adopt path over their existing tmux
namespace. No plugin/model observation bridge, host reboot supervision, pidfd-class
identity guarantee, or mixed-version rolling upgrade is implied. Checkpoints
cover layout and placement, not processes or shell side effects.

Theme personalities remain presets of the same generated v1 appearance contract,
not a competing schema. The release coherence test validates all 14 presets as
both operation requests and full sync states, checks packaged wallpapers and
verifies that applying a theme preserves the pane/layout identities. Catalog
admission and immutable publication remain separate supply-chain gates, not an
alternate workspace authority.

## Included and deliberately excluded

- Strict workspace contracts; SQLite transactional state/revisions/checkpoints,
  command receipts, explicit legacy migration and backup/restore tooling.
- Independent recovery console and persistent registered-plugin activation hold.
  This is **not** full safe boot, private-data revocation or process isolation.
- Indexed immutable bundles, dry-run retention planning and scoped metadata event
  polling. No destructive bundle cleanup or SSE/push delivery.
- Connected runtime reconciliation and experimental normal-frontend docking.
  `?renderer=docking` opts in **only on a build containing this branch**. The default
  movable-window renderer remains available without that flag. Tabs/floating
  placement now has a separate persistence adjunct; it is never a new v1 field.
- An owner-reachable managed-terminal attach/adopt path and identity registry.
  Its Linux provider has documented kernel-identity limitations;
  it is not pidfd-class ABA proof or a sandbox against another same-UID process.

Serialized layouts and plugin manifests remain **v1**. The candidate uses SQLite
**schema 4**, with an additive migration from schema 3 for placement adjuncts.
See [store operations](WORKSPACE_STORE.md) before considering any runtime upgrade:
stop old writers through an authorized session-preserving plan, retain a verified
backup and bundles, and never treat legacy JSON as a writable fallback. Database
downgrade requires a compatible pre-upgrade backup restored to a separate runtime
with the matching older build (`restore --preserve-schema` avoids upgrading the
copy); it cannot convert a schema-4 backup into schema 3. Layout checkpoints do
not undo schema changes, shell effects, conversations or disposed iframe documents.

### Current integration evidence (local acceptance, not deployment acceptance)

`npm run check` passes the production build/typecheck and **278/278 Node tests**;
`npm audit` reports zero vulnerabilities. All eight Python adapter/publisher/catalog/
portable-source suites pass (**55/55 tests**), including regenerated source archive
parity. The expanded disposable docking persistence test has passed three-column geometry
reload, grouped/floating placement reload, surviving tmux shell PID, empty-adjunct
reset, and restoration through the independent `/recovery` UI. Surviving iframe
elements remain identical through in-page placement changes; a full reload creates
fresh documents as expected. This run reported **zero page errors**, revision
**7/7** observed, and browser application. The separate docking workspace/PTY
fixture passes **85 checks / 73 layout transitions**, including pointer sash resize,
plugin publication/lifecycle, recovery hold, and URL-change/close negative controls.

Unit regressions additionally cover per-group active tabs, 100-window conversion,
same-axis split geometry, orphan pruning inside the store transaction, queued
gestures during saves, recovery after a concurrent failed layout read (without
poisoning the placement/polling promise queue), and schema-preserving offline rollback. Managed-terminal
lifecycle and ambiguous-input retry fixes are integrated. These results do not
imply deployment or owner-runtime migration; source publication is separate.

Final tested `dist/index.html` SHA-256:
`dc62f47d8dc59c798d2c032b38a98882e3838b8e208de15476d3aa5fa3e5d3ed`.
The strict common renderer matrix passes **34 transitions per renderer** with
identical normalized transcripts, restored checkpoint frame coordinates, and
zero page errors (default revision **21/21**, docking **26/26**). The companion
live-PTY continuity suite passes **94 transitions under each renderer**, revision
**53/53**, with `browser_applied=true` and zero page errors. Docking metadata is
pruned in every view, not only Windows. See [renderer parity](RENDERER_PARITY.md).

## Historical verification for implementation `23a1afe`

| Check | Observed result |
| --- | --- |
| `npm run check` | Build and **209/209 Node tests**, no skips |
| Eight Python adapter/publisher/archive suites | **55/55 tests** |
| Optional docking, isolated live PTY | **85 numbered checks / 73 layout transitions**, plus rendered-pixel, Windows focus and hidden-tab Spatial regressions |
| Default renderer, isolated live PTY | **94/94 continuity transitions** |
| Managed terminal lifecycle | **17/17 tests**, included in Node total |
| Independent recovery fixture | **13/13** |
| Real-server recovery/hold, normal UI publication/events/bundle restore, import | Passed |
| `npm audit` | Zero vulnerabilities at verification time |

Browser evidence uses Chromium **145.0.7632.6**, Playwright **1.58.0**. The tests
check iframe document nonce/draft/DOM identity and fresh terminal marker/variable/PID
output with one WebSocket. Optional docking also checks the server's acknowledged
revision, plugin lifecycle and recovery policy. These results are not a claim about
Firefox/WebKit, live Hermes conversation binding, assistive technology, arbitrary
large layouts, full performance, or host reboot recovery.

## Reproduce safely

Use a separate checkout or worktree and disposable test resources. Do not point any
test at an owner runtime, default tmux socket, existing browser profile or live
service. A branch checkout or source push does not update a running frontend.

On Linux with Node **>=22.12**, Python 3, tmux at `/usr/bin/tmux`, and the native
build prerequisites for `node-pty` and `better-sqlite3`:

```sh
mkdir -p /tmp/opencode
npm ci
npm run check

for test in tests/test_command_adapters.py tests/test_workspace_contract.py \
  tests/test_workspace_batch_limit_regression.py tests/test_hermes_plugin.py \
  tests/plugin-publish.test.py tests/orbit-catalog.test.py \
  tests/test_orbit_bundle.py tests/test_portable_endpoints.py; do
  python3 "$test" || exit 1
done
npm audit
git diff --check
```

`npm ci` runs the pinned dependencies' native installation scripts; inspect them
under the applicable source-trust policy before installation. The managed-provider
fixtures use Linux `/proc` and signals and do not establish platform portability.
The GitHub Node-test workflow prepares `/tmp/opencode`; browser suites remain
explicit local gates rather than being implied by that workflow's success.

For a fresh, separate browser-test environment (downloads public Playwright assets):

```sh
python3 -m venv /tmp/opencode/orbit-test-venv
/tmp/opencode/orbit-test-venv/bin/pip install playwright==1.58.0
export PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-test-browsers
/tmp/opencode/orbit-test-venv/bin/python -m playwright install chromium

/tmp/opencode/orbit-test-venv/bin/python tests/docking-workspace.browser.py --pty
/tmp/opencode/orbit-test-venv/bin/python tests/docking-persistence.browser.py
/tmp/opencode/orbit-test-venv/bin/python tests/renderer-parity.browser.py --pty
/tmp/opencode/orbit-test-venv/bin/python tests/runtime-continuity.browser.py --pty
/tmp/opencode/orbit-test-venv/bin/python tests/runtime-continuity.browser.py --pty --renderer docking
/tmp/opencode/orbit-test-venv/bin/python tests/managed-terminals.browser.py --renderer default
/tmp/opencode/orbit-test-venv/bin/python tests/managed-terminals.browser.py --renderer docking
/tmp/opencode/orbit-test-venv/bin/python tests/agent-selection.browser.py
/tmp/opencode/orbit-test-venv/bin/python tests/runtime-import.browser.py
/tmp/opencode/orbit-test-venv/bin/python tests/recovery.browser.py
/tmp/opencode/orbit-test-venv/bin/python tests/recovery-real-server.browser.py
/tmp/opencode/orbit-test-venv/bin/python tests/workspace-store.browser.py
```

Install any required Chromium OS libraries in the disposable test environment,
not by modifying or restarting the owner's live host. These scripts start their
own temporary servers/ports/runtimes and clean up their own private sockets.
Do not run `npm start` in an owner checkout as a substitute for the isolated tests.

## Documentation and next gates

- [Detailed implementation handoff and delegation ledger](ORBIT_EVOLUTION_HANDOFF.md)
- [Dependency-ordered plan](ORBIT_EVOLUTION_PLAN.md)
- [Optional docking controls and limits](OPTIONAL_DOCKING.md)
- [Managed terminals](MANAGED_TERMINALS.md) and [registry](TERMINAL_RESOURCE_REGISTRY.md)
- [Resource authority proposal](RESOURCE_AUTHORITY_PROPOSAL.md) and
  [authority ADR](adr/008-resource-authority-boundaries.md)

Next: broader docking graph/focus/browser/accessibility coverage and a persistence
decision before default adoption; stronger lifecycle/authority review before any
bounded owner-consented observations; grants/revocation, broker/egress controls,
Project Inspector, scoped app data, exact-tested promotion and reliable tasks.

Publishing this branch does not authorize deployment. No testing-branch deployment
step is present in the checked-in workflows; external repository automation has
not been audited here. GitHub Actions results must be inspected after the push,
not inferred from the local test results above.
