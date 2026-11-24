VERDICT: APPROVE

# T2 review of PR #92 — F12 Connect-GitHub review

## Scope and method

Read `docs/reviews/F12-onboarding.md` in full (145 lines) and checked its citations against
`docs/ONBOARDING-GITHUB.md`, `docs/QUICKSTART.md`, `docs/CONFIG.md`,
`server/onboarding-github.mjs`, `server/onboarding-wiring.mjs`,
`server/orbit-config.mjs`, `config/orbit-config.schema.json`,
`src/onboarding-github.ts`, `src/onboarding-repos-input.ts`,
`src/onboarding.ts`, `src/onboarding-steps.ts`, `src/settings.ts`, and the
onboarding/config tests. No source file was changed. The PR is a single new
review document; it does not weaken a gate, sandbox or test. Its verdict is
justified by the implementation, with only documentation-evidence gaps.

## Findings

1. **minor** — `docs/reviews/F12-onboarding.md:12-19, 29, 65`.
   The reported test command omits `tests/onboarding-github-ui.test.mjs`, yet
   AC-001 and AC-004 cite two tests from that file as proof. Those tests do
   pass (4/4 here), but the review does not show that they were run.
   **Fix:** add `tests/onboarding-github-ui.test.mjs` to the reported command,
   or report its result separately, so every cited proof is in the test log.

2. **minor** — `docs/reviews/F12-onboarding.md:103` (F2).
   The proposed RED test
   `tests/onboarding-wiring.test.mjs::repos_routes_survive_an_unsafe_github_credential`
   is in the file the review itself says cannot boot in this checkout because
   `server/index.mjs` imports `ws`. The bug is real, but its proposed proof
   cannot run here.
   **Fix:** propose a unit-level RED test through `createOrbitSetup` and
   `setup.handle` (the same harness that lets the three non-booting wiring
   tests pass), and keep the route-level test as additional coverage.

3. **minor** — `docs/reviews/F12-onboarding.md:101-103` (F2).
   `putRepos` saves the normalized list before `reposView()` calls
   `github.connected()`, so in the unsafe-credential case a `PUT` persists the
   new list and then returns 409. The review says both routes fail but does not
   note that the write already happened.
   **Fix:** call a non-throwing connected probe before saving (or make
   `reposView` non-throwing) and describe the 409-after-write ordering in the
   finding.

4. **minor** — `docs/reviews/F12-onboarding.md:5`.
   The provenance line names source slice `40c2cc6`; the PR base/head supplied
   for this review are `0765a932eca46768030132cb99da8f742924bc24`/
   `dc54297073c3b0322ab036002b4bc37287a0f443`, and git history is not available
   here to correlate them. The evidence therefore cannot be anchored to the
   exact reviewed revision from the document alone.
   **Fix:** cite the actual `source_rev` used for the review, or explicitly
   state that `40c2cc6` is the source slice and how it relates to the PR
   base/head.

5. **minor** — `docs/reviews/F12-onboarding.md:15-19`.
   The test summary reports only three files and stops at the two
   environment-blocked wiring tests; it does not list the onboarding tests it
   did not run. This makes the PASS look broader than the executed evidence.
   **Fix:** add an explicit "not run" list with the reason (no installed
   dependencies; `ws` missing), or run the pure onboarding files that do not
   boot `server/index.mjs`.

## Test commands and results

- `timeout 900 node --experimental-strip-types --test --test-concurrency=1 tests/onboarding-github.test.mjs tests/orbit-config-repos.test.mjs`
  — exit 0; 18 tests, 18 passed, 0 failed. This covers token storage 0600,
  no-echo/log behavior, device-flow named errors, offline stubs, empty repo
  default, validation, case-insensitive de-duplication, 50-entry cap,
  persistence, schema, and no hard-coded repository names.
- `timeout 120 node --experimental-strip-types --test --test-concurrency=1 tests/onboarding-wiring.test.mjs`
  — exit 1; 5 tests, 3 passed, 2 failed. Both failures occur before any
  assertion in `boot()` with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'ws' imported from server/index.mjs`
  (`tests/fixtures/local-orbit.mjs:38`), matching the environment limitation
  reported by the F12 review.
- `timeout 120 node --experimental-strip-types --test --test-concurrency=1 tests/onboarding-github-ui.test.mjs`
  — exit 0; 4 tests, 4 passed. This is the pure test file cited by AC-001 and
  AC-004; it runs without the missing server dependency.

## Environment limitation

The full suite was not run: the sandbox has no `node_modules` and no network,
and `server/index.mjs` imports `ws`. Any test that boots that server at either
revision fails at import time, so this is an environment limitation, not a
defect in PR #92. No test was weakened, skipped or edited. `git status` after
the review shows only the new `docs/reviews/T2-REV27.md`.
