# Evolution testing branch

Branch: **`testing/orbit-docking-managed-terminals`**

This branch starts from implementation commit `23a1afe` and includes the cumulative
evolution work since `38a9d56`, not only the latest docking changes. It is a testing
candidate, not approval to deploy, migrate an owner runtime, or replace `main`.

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
  placement are transient and reset on reload, not new checkpointed v1 fields.
- An internal managed-terminal lifecycle prototype and identity registry. They
  are **unwired**: no existing terminal adoption, observation API, grants or new
  permission path. The Linux prototype has documented kernel-identity limitations;
  it is not pidfd-class ABA proof or a sandbox against another same-UID process.

Serialized layouts and plugin manifests remain **v1**. SQLite is **schema 3**.
See [store operations](WORKSPACE_STORE.md) before considering any runtime upgrade:
stop old writers through an authorized session-preserving plan, retain a verified
backup and bundles, and never treat legacy JSON as a writable fallback. Database
downgrade requires deliberate export to a separate runtime; layout checkpoints do
not undo schema changes, shell effects, conversations or disposed iframe documents.

## Verification recorded for the implementation

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
/tmp/opencode/orbit-test-venv/bin/python tests/runtime-continuity.browser.py --pty
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
