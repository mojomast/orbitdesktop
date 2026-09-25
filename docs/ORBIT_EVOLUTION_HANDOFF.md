# Evolution handoff — September 25, 2026

## Repository and scope

Started at `38a9d56bbe056ba3083cce7ca805077fb3662911` after cloning into the supplied
empty directory. The unrelated parent checkout was not modified. Work is on local
branch `evolution/contracts-recovery-foundations`; no merge, push, deployment, live
service restart or owner-runtime inspection occurred.

Commit `427f0e1` isolates terminal/server test runtimes. The following adjacent
contract/recovery increment is described below; consult `git log` for its final hash
(a commit cannot embed its own hash). No v2 records or database migration exist yet.

## Implemented and checked

- Canonical trusted draft-07 request/operation schemas in `contracts/workspace-v1.mjs`,
  generated JSON, TS operation types, Python limit blocks and operation reference.
  Strict Ajv 8.20.0 rejects coercion/extra fields. Existing semantic checks still run.
  Shared bounds: 32 operations, 150,000 request bytes, 2,000,000 response bytes,
  120-character new checkpoint labels. UTF-8 decoding spans network chunks correctly.
- Structured workspace error categories; parser/schema errors do not echo values.
  Future-version records reject stale v1 mutations with `UPGRADE_REQUIRED`.
- `JsonWorkspaceStore` read/write boundary with unique temporary files, preserving
  current records. **Not** a multi-record transaction or cross-process lock.
- Independent `/recovery` assets load directly from source public files, not `dist`.
  Authenticated read/history do not scan bundles or acknowledge rendering. Explicit
  restore and disable-all use revision checks and pre-change checkpoints.
- Recovery UI has keyboard-operable, labelled controls, text-only errors and no
  token persistence, normal renderer, iframe, terminal, or agent startup.
- Test terminal socket, HOME/cwd/environment/config and server roots/ports are
  isolated. PTY check now tests new output after reconnect, not old screen history,
  for retained variable **and** shell PID. Cleanup targets only the test socket.
- Portable packaging includes the new contracts and omits the unimported owner-specific
  standalone mobile proxy. Its repository source/deployment remains unchanged.
- Fixed obsolete CLI history/restore and eight-window-limit documentation.

## Reproducible verification

Node v22.23.1; npm 10.9.8; Python 3.13.7; TypeScript 5.9.3; Vite 7.3.6;
tmux 3.5a. Ajv 8.20.0 MIT. Browser: Playwright Python 1.58.0 with Chromium
145.0.7632.6 (v1208), disposable contexts only; Playwright reports an unsupported
host OS and uses the Ubuntu 24.04 fallback binary. Firefox/WebKit remain untested.

Initial failing baseline is retained in ORBIT_EVOLUTION_AUDIT.md. Native binding
repaired after reviewing the existing node-pty install scripts:
`npm rebuild node-pty --nodedir=/usr`. No new dependency install scripts were run.
Ajv installed with `--ignore-scripts`; `npm audit` reports zero known vulnerabilities.

Run the following from the repository:

```sh
npm run check
python3 tests/test_workspace_contract.py
python3 tests/test_workspace_batch_limit_regression.py
python3 tests/test_hermes_plugin.py
python3 tests/plugin-publish.test.py
python3 tests/orbit-catalog.test.py
python3 tests/test_orbit_bundle.py
python3 tests/test_portable_endpoints.py
git diff --check

PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/recovery.browser.py
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/recovery-real-server.browser.py
```

The first browser suite is a 10-case contract fixture, not integration evidence.
The second copies actual Node/server/contract source into a disposable tree, executes
a deliberately broken normal renderer and throwing app, then exercises real recovery
authentication, disable and restore through the UI to revision 4. It checks unrelated
identity bindings, keyboard connection, 390px layout, forced colors and reduced-motion
mode. It does **not** prove session/document continuity or complete accessibility.

Final recorded results: `npm run check` build + **89/89 Node tests passed**, no skips;
the seven Python commands above **43/43 tests passed** (7 + 2 + 10 + 1 + 18 + 2 + 3).
Browser contract fixture **10/10 passed**, and the real-server broken-renderer/app
scenario passed. Archive parity/portability failures from baseline are resolved.
`git diff --check` passed. Logs for this checkout are in
`/tmp/opencode/orbit-evolution-final-check.log` and
`/tmp/opencode/orbit-evolution-final-python.log`; browser results were printed by
the reproducible commands above. The remaining Vite shared-browser static/dynamic
import warning is non-fatal and predates this increment.

## Remaining gates / risks

1. Complete command receipt/idempotency and actor/intent policy, output-schema coverage
   for optional Jev results, and provider-detail schema discovery. Python tools use
   simplified schemas and generated limits; server validation is authoritative.
2. Select supported SQLite binding; deterministic retained-original v1→v2 migration,
   transactional revision/checkpoint/receipt/outbox commits, crash tests and live backup.
   Do not pretend JSON rename solves this. Single-process synchronous mutations are
   serialized today, but multiple writers/crashes remain unsupported.
3. Persistent server-enforced safe mode/quarantine, broker channel revocation, indexed
   bundles and bounded events. Current recovery disable is reversible layout state,
   not a security hold; disconnected frames/external backend services continue.
4. Stable surface-runtime extraction and real 50-transition iframe/PTY/draft tests;
   docking spike, accessible tabs/recipes/projects and per-client viewport state.
5. Grants/observation leases, broker with reviewed egress restrictions, Project Inspector,
   app storage, exact drafts/promotion and evidence-backed tasks. Both full requested
   product acceptance scenarios remain incomplete.

No migration/rollback of application data or external effects is claimed. Reverting
source is not restoring a UI checkpoint. This increment retains v1 store format;
older source can still read it, but would lose the new schema/recovery protections.
Rebuild the bundle from explicitly tracked source after any subsequent change.

## Delegation ledger (all completed; no descendants running)

- Initial audit: `ses_f268fe272ffeaqwALhpSlFl1mN`.
- Initial Python batch fix: `ses_f268d6ad0ffe70L84JX4eAFhlY`.
- Luna test isolation: `ses_f268aa654ffeiL8C2W28VW0n05`.
- Flash recovery review: `ses_f268a82f5ffeLNdMcvmSD0oSKV`.
- Flash recovery UI/tests: `ses_f2686aa5dffedNV04DPy6pgrJI`.
- Luna contract parity tests: `ses_f26867b8dffeLy4iCwiq3kkkVq`.

Lead reviewed results and fixed the CLI capability-response leak found by the parity
worker, strengthened terminal reconnect evidence/environment isolation, removed
arbitrary browser-binary selection/external harness targeting from the fixture test,
and ran the real-server browser integration separately.
