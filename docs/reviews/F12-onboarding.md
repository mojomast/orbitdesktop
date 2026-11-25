VERDICT: PASS

# F12 — Connect GitHub and Repos to watch: independent review

Reviewed the onboarding slice at `40c2cc6` on the local main branch. The review is limited to the F12 acceptance criteria and reads `docs/ONBOARDING-GITHUB.md`, `docs/QUICKSTART.md`, `docs/CONFIG.md`, `server/onboarding-github.mjs`, `server/onboarding-wiring.mjs`, `server/orbit-config.mjs`, `src/onboarding-github.ts`, `src/onboarding-repos-input.ts`, `src/onboarding.ts`, `src/settings.ts` and the onboarding/config tests. No code was changed. All six criteria are met behaviorally, with no blocker or major findings. The findings are proof-hardening and edge-case robustness items. PASS means the behavior meets the bar; it does not mean the packet's exact proof filenames exist (see F6) or that every sub-claim has an automated assertion (see F1).

## Test run

Command:

```text
timeout 900 node --experimental-strip-types --test --test-concurrency=1 tests/onboarding-github.test.mjs tests/onboarding-wiring.test.mjs tests/orbit-config-repos.test.mjs
```

Result: 23 tests, 21 passed, 2 failed, 0 skipped.

- `tests/onboarding-github.test.mjs`: 12/12 passed. These prove token storage, no-echo behavior, device-flow errors and offline stubs.
- `tests/orbit-config-repos.test.mjs`: 6/6 passed. These prove the empty default, validation, case-insensitive de-duplication, persistence, schema and no hard-coded repository names.
- `tests/onboarding-wiring.test.mjs`: 3/5 passed. The two failing tests are `fresh boot: first run, owner-only setup routes, minimal install end to end, no key leaks, no router` and `GitHub connect and repos to watch over the real routes: optional, owner-only, token never echoed`. Both fail before any assertion because the checkout has no installed dependencies and `server/index.mjs` imports `ws`: `ERR_MODULE_NOT_FOUND ... Cannot find package 'ws'`, raised from `tests/fixtures/local-orbit.mjs:38`. No dependency was installed (no network, no new dependencies), so the route-level evidence for those two tests is static review only.

## AC-001 — The connect step is optional and user-initiated

**MET**

**Criterion.** Skipping leaves a working install and no network call is made before the user starts the connect flow.

**Evidence.** The minimal path skips the GitHub and Repos steps entirely (`src/onboarding-steps.ts:6-10`). The wizard exposes both steps as optional from the review card (`src/onboarding.ts:1119-1132`), and the GitHub step has an explicit skip action that moves to Repos without connecting (`src/onboarding.ts:1150-1155`). The Repos step can be completed with an empty list; its save writes the empty list and continues to Review (`src/onboarding.ts:1245-1260`). Construction of the GitHub connection reads only environment strings and does no I/O (`server/onboarding-github.mjs:41-49`); status is a filesystem read (`server/onboarding-github.mjs:74-80`); the first GitHub request occurs only in `deviceStart` or `verify` (`server/onboarding-github.mjs:121-142`, `:82-92`). Routing does not call GitHub for setup or apply (`server/onboarding-wiring.mjs:259-289`). The public docs state the step is optional and skippable (`docs/QUICKSTART.md:117-122`, `docs/CONFIG.md:454-458`).

**Proof.** `tests/onboarding-github.test.mjs::starts disconnected and skipping makes no network call` asserts the fake endpoint has zero calls after status. `tests/onboarding-github-ui.test.mjs::minimal path still goes from providers straight to review, and back` proves the minimal path. `tests/onboarding-wiring.test.mjs::GitHub connect and repos to watch over the real routes: optional, owner-only, token never echoed` is the intended route-level proof (`:112-121`), but it did not execute in this environment; see the Test run section.

**Gap.** The packet names `tests/onboarding/connect-github.test.mjs::skipping_connect_leaves_a_working_install_with_no_github_call`, which does not exist under that path. Equivalent coverage exists under the actual files above. This is a traceability gap only, recorded as F6.

## AC-002 — Credential storage is user-only and never in config or logs

**MET**

**Criterion.** Whichever credential path is used, the token lands only in a user-only file under the runtime directory with mode 0600; it is never in the config file, git, logs, responses or the agent registry.

**Evidence.** The token directory is created 0700 and the file is written through a 0600 temporary file followed by a rename (`server/onboarding-github.mjs:30-39`). Reads are refused unless the directory is a real directory, the token is a real file, and neither has group or other permission bits (`server/onboarding-github.mjs:66-72`). Both the pasted-token and device-flow paths reach the same `store()` function, which verifies before writing (`server/onboarding-github.mjs:94-106`, `:159-167`). The only write target is `<runtime>/github/token` (`server/onboarding-github.mjs:46-47`). The config schema has no credential field: its only observability member is the repository list (`config/orbit-config.schema.json:52-71`, `server/orbit-config.mjs:41-73`, `:487`). The config writer is 0600 (`server/orbit-config.mjs:599-614`). The runtime directory is excluded from Git by default (`.gitignore:11-12`). Logging is limited to fixed strings: `GitHub connected.`, `GitHub disconnected.` (`server/onboarding-github.mjs:51-53`, `:98`, `:113`). Server request errors log only `error.message`, and request bodies are never logged (`server/index.mjs:329-335`, `:374-379`). The setup agent receives a key-free config with observability removed (`server/onboarding-wiring.mjs:57-61`, `:100-114`), and the registry projection selects provider and role fields only (`server/orbit-config.mjs:743-780`).

**Proof.** `tests/onboarding-github.test.mjs::a pasted token is verified, stored 0600 and never echoed or logged` asserts file contents, 0600, directory 0700, the single directory entry, and no leak in the returned view, status or logs. `tests/onboarding-github.test.mjs::a rejected token is not stored and the error does not echo it` and `::malformed tokens are refused before any network call` cover rejection. `tests/orbit-config-repos.test.mjs::no repository names are hardcoded in the product` covers shipped defaults. The route-level checks at `tests/onboarding-wiring.test.mjs:154-156` are written but did not execute here.

**Gap.** No test directly asserts that the token file is excluded from the agent registry projection, although the token is not part of the config document at all. See F8 for the related watch-list assertion.

## AC-003 — Token masking, no agent propagation, and complete local removal

**MET** — with no automated test for the masking sub-claim.

**Criterion.** The token is masked in the UI, is never sent to agents or workers, and revocation or re-authentication removes the stored file completely.

**Evidence.** The token field is a password input (`src/onboarding-github.ts:108-116`), its value is cleared before the request is sent, and the connected card says the token is never shown again and replaces the form (`src/onboarding-github.ts:84-102`). The form element is removed from the DOM when the connected view is drawn. The token is not in the config and therefore cannot reach the registry (`server/orbit-config.mjs:743-780`); the setup agent config drops observability and provider key material (`server/onboarding-wiring.mjs:57-61`); the token is only read from the runtime file for GitHub calls (`server/onboarding-github.mjs:82-92`, `:170-189`). Disconnect removes the token file and is idempotent; no account file is created, and the test also asserts its absence (`server/onboarding-github.mjs:108-115`). A rejected re-authentication first disconnects, so it also leaves no prior credential (`server/onboarding-github.mjs:102-106`). The UI reports that local disconnect is distinct from revoking the token at the issuer and links to token settings (`src/onboarding-github.ts:88-99`). The docs repeat the same contract (`docs/CONFIG.md:460`).

**Proof.** `tests/onboarding-github.test.mjs::disconnect removes the token and account files` proves local removal and idempotence. `::re-auth with a rejected token forgets the previous credential` proves re-auth removal. `::a late verification cannot undo a disconnect` proves a pending verification cannot restore the token. The route-level token-not-echoed and setup-request assertions are at `tests/onboarding-wiring.test.mjs:143-156`, but did not execute here.

**Gap.** There is no automated assertion for the UI masking itself or for the absence of the token from the setup-agent request in a unit test that can run without the missing server dependency. See F1 and F8.

## AC-004 — The repository picker is user-managed and starts empty

**MET**

**Criterion.** No repository is tracked without the user adding it; the picker accepts adds and removes and persists the list as user data, not a shipped default.

**Evidence.** The default config has `observability.repos: []` (`server/orbit-config.mjs:145-153`), and the schema documents the empty default, 50-entry cap and uniqueness (`config/orbit-config.schema.json:52-71`). `normalizeRepoList` trims, validates `owner/name`, de-duplicates case-insensitively with the first spelling winning, and enforces the 50-entry cap (`server/orbit-config.mjs:50-67`). Configs without observability load with an empty list (`server/orbit-config.mjs:68-74`). The UI parses free text and GitHub URLs, de-duplicates case-insensitively and validates through the same owner/name pattern and 50-entry cap (`src/onboarding-repos-input.ts:1-23`). The picker can add a name from the connected account and the textarea can remove any name (`src/onboarding-github.ts:175-180`, `:158-221`). The route persists the normalized list into the config document and returns the saved view (`server/onboarding-wiring.mjs:126-136`). No `mojomast/workflow`, `mojomast/bundlebees` or `mojomast/orbitdesktop` default is present in the product modules or schema, and the test corpus enforces that.

**Proof.** `tests/orbit-config-repos.test.mjs::a new config watches no repositories`, `::repo names are trimmed, validated and de-duplicated case-insensitively`, `::the config validates and persists the watch list`, `::a config file without observability still loads with an empty list`, `::the schema documents observability.repos, empty by default` and `::no repository names are hardcoded in the product`. The route-level add/remove/persist assertions are at `tests/onboarding-wiring.test.mjs:137-147` (did not execute here). The pure input tests are `tests/onboarding-github-ui.test.mjs::repo input accepts commas, spaces, newlines and GitHub URLs`.

**Gap.** The packet's named `tests/onboarding/repo-picker.test.mjs::picker_starts_empty_and_tracks_only_user_added_repos` does not exist under that path; the coverage is split across the files above (F6).

## AC-005 — Device-flow failures are named and never silently retried

**MET**

**Criterion.** Expired or denied flow, rejected token and rate limiting are shown as named, actionable states and are never silently retried or swallowed.

**Evidence.** The shared request helper maps HTTP 429 and the GitHub throttling signals to a named rate-limit error (`server/onboarding-github.mjs:55-64`). Token verification maps 401/403 to a named rejected-token message (`server/onboarding-github.mjs:82-92`). Device polling maps `slow_down` to a rate-limit message, leaves `authorization_pending` as an explicit pending state, and maps `expired_token`, `access_denied` and other failures to distinct actionable messages (`server/onboarding-github.mjs:144-168`). Repository listing maps 401 and 403 separately (`server/onboarding-github.mjs:170-189`). The UI displays the server messages and requires an explicit “Check sign-in” click; there is no timer, interval loop or automatic re-poll (`src/onboarding-github.ts:136-142`). A grep of the module and UI found no retry timer or automatic retry. The docs state denial, expiry and rate limiting require user action and no background poll runs (`docs/CONFIG.md:458`).

**Proof.** `tests/onboarding-github.test.mjs::device denial, expiry and rate limit have actionable errors without retries` asserts each named message and `polls === 1`, proving no retry. `::device flow is unavailable without a client id and says what to do instead`, `::a rejected token is not stored and the error does not echo it` and `::only https or loopback http API bases are accepted` cover the adjacent failure states. The route-level device-start rejection is at `tests/onboarding-wiring.test.mjs:121` (did not execute here).

## AC-006 — Offline testability with a stubbed endpoint

**MET** — the route-level test is authored but its execution was blocked by the missing installed dependency.

**Criterion.** The connect and picker flows are testable offline with a stubbed endpoint; no test in the slice contacts the public GitHub service.

**Evidence.** The connection accepts an injected `fetchImpl` (`server/onboarding-github.mjs:41-44`), and every network call goes through that injection (`:55-64`, `:82-92`, `:121-168`, `:170-189`). The unit suite uses an in-process fake that records calls and returns canned responses (`tests/onboarding-github.test.mjs:21-46`). The route-level suite uses a loopback HTTP server and passes its base to the server under test (`tests/onboarding-wiring.test.mjs:97-110`). A search of the slice's test files found no fetch of the public service; the only public-service text is expected response data and URL normalization fixtures. The endpoint validator refuses non-HTTPS bases except loopback and refuses credentials, queries, fragments and redirects (`server/onboarding-github.mjs:21-28`, `:58`), so a test cannot silently fall back to the public service through an invalid base.

**Proof.** `tests/onboarding-github.test.mjs` in full (12 passing tests) uses the injected fake. `tests/onboarding-wiring.test.mjs::GitHub connect and repos to watch over the real routes` is the loopback route-level proof, but it failed to start in this checkout because `ws` is not installed; see the Test run section. No unit test failed and no test made an external call.

## Findings

### F1 — minor — No automated proof for UI token masking and clearing

- **Where:** `src/onboarding-github.ts:108-116` (password input, clear-before-send) and `:84-102` (connected card replaces the form).
- **Issue:** AC-003 requires the token to be masked in the UI. The implementation is correct by inspection but no test asserts the input type, the clear-before-send behavior or the absence of the token from the connected view. The packet's named masking/removal test does not exist.
- **Fix:** add a DOM-level or source-level assertion that the token field is a password input, that its value is cleared before `githubConnectToken` is called, and that the connected card contains no sentinel. Keep the existing server removal tests.
- **Test to add RED first:** `tests/onboarding-github-ui.test.mjs::token_field_is_masked_and_cleared` (or a new DOM test file). It should fail now because the assertion does not exist.

### F2 — minor — An unsafe GitHub credential state also breaks the independent repository routes

- **Where:** `server/onboarding-wiring.mjs:126-128` (`reposView` calls `github.connected()`), `:130-136` (`putRepos` returns `reposView`), and `server/onboarding-github.mjs:66-72` (`stored()` throws a 409 for unsafe storage).
- **Issue:** The repository list is independent of GitHub, but if the stored credential is unsafe (group/other permission bits, a non-file, or a size outside the accepted range), `github.connected()` throws and both `GET /api/onboarding/repos` and `PUT /api/onboarding/repos` fail. That makes the optional Repos step unusable until the GitHub section is used to disconnect. The GitHub step is optional, so the independent list should degrade rather than fail.
- **Fix:** use a non-throwing connected flag for `reposView` (catch and return `false`) while keeping the strict 409 for GitHub operations, or split `stored()` into an inspection result and a throwing assertion.
- **Test to add RED first:** `tests/onboarding-wiring.test.mjs::repos_routes_survive_an_unsafe_github_credential` — create an unsafe token file or directory, then assert both repo routes answer 200 with the expected list and `githubConnected: false`.

### F3 — minor — Disconnect leaves crash-left staging files behind

- **Where:** `server/onboarding-github.mjs:34-38` (random temporary name) and `:108-115` (disconnect removes only the token file).
- **Issue:** A process crash between the temporary write and the rename can leave a `token.<pid>.<uuid>.tmp` file containing the credential. It is still 0600 inside the 0700 directory, so it is user-only, but disconnect and re-auth only remove `token`. AC-003 says the stored file is removed completely. The current test checks only the token and account files (`tests/onboarding-github.test.mjs:99-109`).
- **Fix:** on disconnect and at connection construction, remove `token` plus any `token.*.tmp` staging files in the GitHub directory, or use one fixed staging name and unlink it on every path. Assert after disconnect that the directory contains no credential-bearing files.
- **Test to add RED first:** `tests/onboarding-github.test.mjs::disconnect_removes_staged_token_files` — pre-create a staging file with a sentinel, disconnect, and assert no file under the GitHub directory contains the sentinel.

### F4 — minor — The picker can offer a repository name the saver rejects

- **Where:** `server/onboarding-github.mjs:184-187` (listing filter) versus `server/orbit-config.mjs:55-59` and `src/onboarding-repos-input.ts:22` (save-time rejection of `.` and `..` as the repository segment).
- **Issue:** `listRepos` filters with the owner/name pattern but does not reject a dot or dot-dot repository segment. A malformed or hostile endpoint response can therefore populate the picker with a name that `save` will reject, producing a confusing add-then-fail flow. The save-time validation still prevents persistence, so this is not a data-integrity issue.
- **Fix:** apply the same dot-segment rejection in the listing filter so the picker only offers names the saver accepts.
- **Test to add RED first:** `tests/onboarding-github.test.mjs::list_repos_drops_dot_segment_names` — include a dot-segment name in the fake response and assert it is absent from `repos`.

### F5 — minor — The portability guard is narrower than the stated requirement

- **Where:** `tests/onboarding-portability.test.mjs:4-9`.
- **Issue:** The guard hard-codes one test workspace root and two specific user names under the Unix home roots, and scans only test files whose names match a fixed prefix set. It would not catch another user name, a drive-letter path, or an owner-specific path in the product modules or docs. Manual inspection of the reviewed source, tests and docs found no owner-specific absolute paths, so the current tree is clean; the guard itself is weak.
- **Fix:** broaden the pattern to any user name under the Unix home roots and to drive-letter paths, and scan the reviewed source and docs in addition to the test corpus. Keep the existing requirement that no maintainer name is shipped.
- **Test to add RED first:** a meta-test that feeds a synthetic violating line through the same matcher and asserts it is rejected; the current matcher should fail that meta-test.

### F6 — minor — Packet proof identifiers do not match the checked-in tests

- **Where:** F12 packet AC-001 through AC-006 versus `tests/onboarding-github.test.mjs`, `tests/onboarding-github-ui.test.mjs`, `tests/onboarding-wiring.test.mjs` and `tests/orbit-config-repos.test.mjs`.
- **Issue:** The packet names `tests/onboarding/connect-github.test.mjs` and `tests/onboarding/repo-picker.test.mjs` with specific test names. Neither file exists. The behavior is covered, but the proof trail cannot be followed from the packet to the repository without the mapping in this review.
- **Fix:** update the packet's proof map to the checked-in test names, or add thin wrapper tests under the packet paths and names that import the real modules. Prefer the mapping so the suite is not duplicated.
- **Test to add RED first:** `tests/onboarding/connect-github.test.mjs::skipping_connect_leaves_a_working_install_with_no_github_call` and `tests/onboarding/repo-picker.test.mjs::picker_starts_empty_and_tracks_only_user_added_repos` as wrappers, if the packet identifiers must be executable. They fail now because the files do not exist.

### F7 — minor — Invalid endpoint configuration has no route-level proof and leaves no recoverable GitHub section

- **Where:** `server/onboarding-wiring.mjs:118-124` (fallback object exposes `connected` and `route` but no `status`), `server/onboarding-github.mjs:21-28` (invalid base throws at construction), and `src/onboarding-github.ts:77-79` (initial status failure only notifies).
- **Issue:** The fail-closed behavior is correct and is described in `docs/ONBOARDING-GITHUB.md:8`, but the fallback makes every GitHub route, including status, return the invalid-endpoint 409. The UI then has no status view, no disconnect control and no retry, only an error notification. The repository routes still work, and the user can skip GitHub, so the install remains usable. There is no test that proves the invalid configuration fails closed without taking down the repository list.
- **Fix:** keep the fail-closed route, but give the fallback a status view that reports the disabled state and a recoverable message, and render that state with a retry or skip affordance in the UI. Add a route-level test for the invalid base.
- **Test to add RED first:** `tests/onboarding-wiring.test.mjs::invalid_github_endpoint_fails_closed_and_repos_still_work` — boot with an invalid API base, assert the GitHub status is a named failure, then assert `GET` and `PUT` on the repository routes still succeed and the setup request contains no credential.

### F8 — minor — No unit test that the watch list stays out of the registry and setup request

- **Where:** `server/orbit-config.mjs:743-780` (registry projection selects provider and role fields only), `server/onboarding-wiring.mjs:57-61` and `:100-114` (key-free setup config), and `tests/onboarding-wiring.test.mjs:143-146` (the only such assertion, inside the route-level test that did not execute here).
- **Issue:** The product contract says the watch list is not shared with the setup agent or worker registry (`docs/CONFIG.md:456`). The source supports that, but the only assertion lives in the route-level test that could not run in this checkout. There is no small unit test that saves a watch list and inspects the registry projection and setup request.
- **Fix:** add a unit test that saves a couple of repository names, builds the registry projection and the setup request, and asserts neither contains the names. This is independent of the missing server dependency.
- **Test to add RED first:** `tests/orbit-config-repos.test.mjs::watch_list_stays_out_of_registry_and_setup_request` (or a new small unit test file in the PR lane).
