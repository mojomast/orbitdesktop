VERDICT: APPROVE

# P2 review of PR #101 — Rails view endpoint 503 during sustained soaks

## Scope and method

The checkout supplied for this review contains a single squashed commit whose
tree already holds the head state, so the supplied two-file diff could not be
re-derived with `git diff`; I verified the two changed lines directly in
`server/rails-proxy.mjs` and read `tests/rails-view-503.load.test.mjs` in full
(154 lines, including the four disclosed fixture-workaround lines). The approved
`tests/rails-proxy.test.mjs` is present and unchanged in behaviour: it still
asserts scoped credentials, fixed paths, same-origin mutations, redirect
rejection and `Last-Event-ID` forwarding. No product file, test or gate was
modified by this review. The product change is exactly the two constants in the
diff: the non-stream absolute deadline `10_000 -> 30_000` and the upstream
socket idle `8_000 -> 35_000` (`server/rails-proxy.mjs:84-85`). The stream
absolute deadline stays at `300_000`.

## Assessment of the five questions

1. **Does it fix the reported failure, and is the diagnosis supported?** Yes.
   At base the non-stream path had *two* deadlines below the observed
   10 250 ms computation: the 8 s socket idle and the 10 s absolute timer.
   The RED reader log (`view_start delay_ms 10250`, `view_aborted elapsed_ms
   8001`, `view_complete elapsed_ms 10252 destroyed true`) pins the proximate
   teardown to the 8 s socket idle: destroy emits the request error, the
   `backend.on('error')` handler answers 503, and the upstream then completes
   into a destroyed response. The diff raises both premature bounds, which is
   necessary — raising only the idle bound would still have produced a 503 at
   10 s. The fixture reproduces the symptom (a view slower than the idle
   timeout) rather than the reason the Rails view took 10.25 s; that remaining
   question is discussed in finding 4.

2. **Is the new bound safe?** Yes on the security controls: authentication,
   header/origin checks, `active>=32` / `streams>=8` capacity caps, cursor and
   query validation, redirect/content-type rejection and fail-closed 503s are
   untouched (`server/rails-proxy.mjs:72` still caps; the diff reaches no
   other line). A genuinely stalled reader is still answered 503
   `source_unavailable` `retryable:true`. Two notes: the 35 s socket idle can
   never fire for a non-stream request because the 30 s absolute timer fires
   first (finding 3), and a stalled upstream now holds an `active` slot for up
   to 30 s instead of 10 s — bounded by the unchanged 32-slot cap, so
   acceptable.

3. **Is the regression test real?** The main soak-shaped test is real and
   cannot pass at base: it asserts HTTP 200 on every one of 60 views (any
   non-200 enters the failure branch and fails), asserts 60 upstream views and
   60 upstream streams, and requires the cycle-34 view latency to be at least
   10 250 ms. Both base deadlines are below that, so base fails at cycle 34
   exactly as reported. The stalled-view test does assert the 503 shape, but
   its "still pending at 29 999 ms" step is weaker than claimed: it can also
   pass with the old 10 s deadline (finding 1). The 503 summary field quoted in
   the PR evidence is a literal, not a measurement (finding 2).

4. **Scope.** Clean. Only `server/rails-proxy.mjs` and the new test are in
   scope; the approved test is untouched, no dependency, network call, retry
   loop, error swallowing, allow-list or gate change was added, no secret or
   credential literal is present (tokens are `randomBytes(32)` at runtime), and
   the only address in the new test is loopback binding, matching existing
   test precedent. The disclosed fixture workaround (the `AUTH_HEADER`
   constant) is a scanner-shape workaround, not a weakened check, and no
   assertion or target changed.

5. **Four-hour soak gaps.** Replay cursor forwarding is unchanged and remains
   covered by the approved test; stream fan-out is unchanged (the 300 s stream
   cycle deadline and 35 s stream socket idle are untouched), so the diff
   introduces no new stream risk. The remaining exposure is the 30 s absolute
   bound itself: it is ~3x the observed 10.25 s, but if SQLite lock contention
   in a long soak pushes a real view past 30 s the 503 returns by design (no
   retry, per requirements). The owner-gated 4 h arm should record upstream
   view latencies to confirm 30 s is above the observed maximum.

## Findings

1. **major** — `tests/rails-view-503.load.test.mjs:136,144-146`.
   The stated "keeps a stalled view pending at 29 999 ms" proof does not hold.
   `t.mock.timers.tick()` runs the fired timer callbacks synchronously, and the
   single `await Promise.resolve()` drains only microtasks, not the socket read
   that settles `fetch`. Under the base 10 s absolute deadline the timer fires
   during `tick(29_999)` and writes the same 503/`source_unavailable`/
   `retryable:true` body the test expects, so the final assertions still pass.
   The test therefore does not regression-lock the new 30 s value (the band
   10.25 s–30 s is untested); only the exact pre-fix 8 s/10 s values are caught,
   and those are caught by the first test. The second test also has no
   `{timeout: ...}`, so a regression to a deadline >30 s hangs the file instead
   of failing at the global timeout. This is not a blocker because the main
   test independently fails at base, but the fail-closed evidence is
   overstated.
   **Fix:** give the test a bounded timeout (`{timeout: 5000}`) and sample the
   pre-deadline state with a real event-loop turn, e.g. advance to 10 001,
   20 001 and 29 999 ms and after each `tick` `await new Promise(resolve =>
   setImmediate(resolve))` (and re-check `settled === false`) before the final
   `tick(1)`/503 assertions. That makes a 10 s or 15 s deadline fail while
   still proving 30 s.

2. **minor** — `tests/rails-view-503.load.test.mjs:92,110`.
   `status_503: 0` in the printed summary is a hard-coded literal, not a count
   of observed responses; the cited evidence line is therefore not measured.
   The per-cycle `assert.equal(response.status, 200)` is real (every non-200
   takes that branch), so the test is not vacuous, but the log can be misread.
   **Fix:** increment a `failures` counter for every non-200 response, print
   that, and `assert.equal(failures, 0)`.

3. **minor** — `server/rails-proxy.mjs:84-85`.
   For non-stream routes the socket idle is now 35 s while the absolute
   deadline is 30 s, so the idle teardown can never fire on those routes; the
   `backend.setTimeout` change only has effect for streams (which were already
   35 s). This is harmless but makes the new constant look like a bound it is
   not, and the intent ("generous idle, hard 30 s cap") is implicit.
   **Fix:** keep the values but assert the intended ordering explicitly (idle
   below the absolute cap) or name both constants and comment that the 30 s
   absolute is the binding bound for non-stream requests.

4. **minor** — `server/rails-proxy.mjs:84`.
   The 30 s absolute is still a premature 503 for a legitimately slow view.
   The PR fixes the observed 10.25 s case with ~3x headroom, but it does not
   investigate why the real Rails view took 10.25 s (lock contention, replay
   work), so a 4 h soak under heavier contention can exceed 30 s and reproduce
   the symptom. No silent retry is added, correctly.
   **Fix:** have the owner-gated 4 h arm log upstream view durations and the
   `view_max_ms` distribution, and treat "max view < 30 s" as its acceptance
   criterion; if not, raise the bound once with evidence (and keep it a named
   constant) rather than adding retries.

5. **minor** — `tests/rails-view-503.load.test.mjs:60-103`.
   The 60 cycles run one view then one stream serially, so the `streams>=8`
   fan-out and the `active>=32` cap are never exercised, and the test does not
   itself assert that `Last-Event-ID` reached upstream (the approved test does,
   `tests/rails-proxy.test.mjs` stream case). The diff does not change either
   path, but neither is protected by this new soak test.
   **Fix:** optionally add a short fan-out subtest that opens 8 concurrent
   streams and asserts the 9th is 429 `capacity`, and assert the upstream saw
   the cursor on at least one replay.

6. **info** — `tests/rails-view-503.load.test.mjs:9-12`.
   The `AUTH_HEADER` constant plus explanatory comment is a disclosed,
   harmless workaround for the credential-shaped-line scanner rule; no secret
   exists and nothing was allow-listed or weakened. It should be reverted to
   the plain header literal once the scanner rule accepts runtime-random
   fixtures, so the workaround does not become a pattern.

## Commands and results

- `timeout 900 node --test tests/rails-proxy.test.mjs tests/rails-view-503.load.test.mjs`
  — exit 0. 3 tests, 3 passed, 0 failed, total ~11.0 s. The soak test printed
  `{"cycles":60,"views":60,"streams":60,"status_503":0,"duration_ms":10866,
  "view_max_ms":10252,"view_over_10s":1,...}` with cycle 34
  `view_start delay_ms 10250` and `view_complete elapsed_ms 10251,
  destroyed:false`; the stalled-view test passed in 5.6 ms; the approved proxy
  test passed in 42 ms.
- `node --version` — exit 0, v24.21.0 (node is available; no substitute
  reasoning was needed).
- `git status --porcelain=v1 --untracked-files=all` — exit 0, empty before this
  review was written (only this new review file is added; no tracked file is
  modified).
- Read-only inspection (`git log`, `git show --stat`, `sed`, `grep` over
  `server/rails-proxy.mjs`, `server/security.mjs`, `tests/rails-proxy.test.mjs`,
  `tests/rails-view-503.load.test.mjs`, `docs/reviews/T2-REV27.md`) — all exit
  0. Note: the checkout is one squashed commit, so the supplied base/head diff
  itself could not be reproduced with git; the two changed lines and the
  unchanged controls were verified from the file contents.

## Environment limitation

The supplied RED run at base was not repeated (coordinator-verified, and base is
not checked out here); the RED conclusion above follows from the base diff
(`8 s` idle and `10 s` absolute both below the asserted `10 250 ms` view) and
from the supplied reader log.
