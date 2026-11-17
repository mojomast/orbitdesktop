APPROVED

# Independent review — PR #43 (rails R03: vendor vibeline pristine at upstream pin d5d0f425)

- Reviewer: independent audit bee (single-bee review, no subagents)
- Audited head: `ca2411a85fcecba2b31201d2e0b58df5354dbdb4` (branch `rails/r03-vendor` = `refs/pull/43/head`)
- Base: `main` @ `84dadcb96c9f2aea71e7fe523f83c1586d7e11da`
- Delivery context audited: coordinator-APPLIED worker payload (`att_4be4db6493c14270`, RAILS-R03 per the frozen rails spec @ workflow 9850efa), whose coordinator verify refused with a house secret-scan trip (`secret_detected`) on three of the vendored files; the coordinator applied the payload UNMODIFIED per the pristine-file rule ("leave pristine, report, coordinator owns any gate exception") and the od-r3 `att_a26db3aa` precedent, with attribution carried in the commit message.
- Scope: audit of the pristine-vendoring delivery and of the scanner-trip attribution. Verdict and blocking findings below; disclosures are non-blocking (BLOCKING counts DEFECTS ONLY).
- Rules honored: nothing pushed, nothing commented on the PR; the only file written in this repo is this report, on branch `review/pr43`, based at the PR head.

## Grounding

From a workspace with no pre-existing git remote (fresh snapshot commit `f787369` on `master`, whose tree is byte-identical to the audited head tree — both are git tree `6316c39aa83653b04f3474a8c93a02256ae43843`):

- `git ls-remote https://github.com/mojomast/orbitdesktop refs/pull/43/head refs/heads/rails/r03-vendor refs/heads/main`
  - `refs/pull/43/head` -> `ca2411a85fcecba2b31201d2e0b58df5354dbdb4`
  - `refs/heads/rails/r03-vendor` -> `ca2411a85fcecba2b31201d2e0b58df5354dbdb4`
  - `refs/heads/main` -> `84dadcb96c9f2aea71e7fe523f83c1586d7e11da`
- Public REST (`/repos/mojomast/orbitdesktop/pulls/43`): state `open`, head sha `ca2411a85fcecba2b31201d2e0b58df5354dbdb4` (label `mojomast:rails/r03-vendor`), base ref `main` @ `84dadcb96c9f2aea71e7fe523f83c1586d7e11da`. Both values match the brief exactly.
- A fetch-only remote (`origin_public`) was added to obtain the exact commits. Nothing was ever pushed.
- Re-ground immediately before committing (final section below): unchanged; no head movement at any point during this audit.

## Check 1 — delta exactness: PASS

The literal two-dot command `git diff 84dadcb96..ca2411a85 --stat` shows 24 files. That is NOT the PR's delta: the merge base of the two commits is `8530a14be7ce480ef35dd11890e72de4c89bed09`, and `main` advanced by 6 commits after the branch was cut, so the two-dot view displays those newer main-only changes in reverse. The 11 non-leased paths in that view (`apps/rizzstack-observatory/app.js`, `contrib/rizzstack-observability/README.md`, `docs/orbit-decomposition.md`, `docs/orbit-inventory.json`, `pc-launcher/prices.json`, `pc-launcher/scripts/usage_ingest_service.py`, `pc-launcher/scripts/usage_report.py`, `pc-launcher/tests/test_usage_report.py`, `pc-launcher/tests/test_usage_wiring.py`, `server/index.mjs`, `tests/test_orbit_decomposition.py`) are untouched by the PR branch relative to the merge base.

The PR's actual delta (three-dot from the merge base, which is what GitHub's Files-changed view shows) is:

```
A  contrib/vibeline/LICENSE                    +21
A  contrib/vibeline/PROVENANCE.json           +108
A  contrib/vibeline/README.md                 +274
A  contrib/vibeline/feedback.py               +180
A  contrib/vibeline/ledger.py                 +94
A  contrib/vibeline/rails.py                  +293
A  contrib/vibeline/rewind.py                 +97
A  contrib/vibeline/sessions.py               +299
A  contrib/vibeline/shell.py                  +149
A  contrib/vibeline/swarm.py                  +172
A  contrib/vibeline/web.py                    +432
A  contrib/vibeline/web/index.html            +814
A  tests/test_rails_vendor.py                 +215
13 files changed, 3148 insertions(+), 0 deletions(-)
```

- EXACTLY the 13 leased files, all additions, nothing else.
- Cross-checked against the public REST `pulls/43/files` endpoint: 13 files, every one status `added`, identical path set and +/− counts. Also matches the PR body's "+3148/-0".
- Single commit `ca2411a85`, message carries the required attribution (attempt id, coordinator-apply, scanner-overmatch on pristine upstream bytes, upstream pin).
- Merge safety: `git merge-tree --write-tree 84dadcb ca2411a` produces a clean tree with zero conflicts; the merged result preserves main's newer versions of all 11 non-leased paths (spot-checked: `pc-launcher/prices.json` in the merged tree is byte-identical to main's). The PR adds the leased delta and reverts nothing.

Of the 13 files: 11 are vendored upstream bytes (below), and `contrib/vibeline/PROVENANCE.json` + `tests/test_rails_vendor.py` are orbit-side provenance/acceptance artifacts within the lease.

## Check 2 — pristine byte-identity vs the upstream pin: PASS

Upstream fetch: blobless clone of `https://github.com/listeningpost/vibeline`, then a single depth-1 fetch of the pin commit, detached checkout — `git rev-parse HEAD` = `d5d0f425a64906ae1a50c1222314a5420da404d5` exactly. Independent corroboration at audit time: a live `git ls-remote https://github.com/listeningpost/vibeline refs/heads/main` still reports `d5d0f425a64906ae1a50c1222314a5420da404d5` TODAY, so the recorded `pin_source` claim ("main pointed at this commit at fetch time") is consistent with the current public state.

All 11 vendored paths exist at the pin. Three-way SHA-256 comparison over FULL file bytes — pin blob (via `git cat-file blob pin:path`) vs PR-head blob (via `git cat-file blob ca2411a:contrib/vibeline/<path>`) vs the recorded manifest in `contrib/vibeline/PROVENANCE.json` — result `ALL_MATCH` for every file. Full 64-hex digests were compared programmatically for all three legs; 16-hex prefixes shown here for gate-safe presentation (the authoritative full values are committed in `PROVENANCE.json` and matched exactly):

| vendored file | pin blob | PR head | manifest | bytes | upstream blob-SHA (git) |
|---|---|---|---|---|---|
| README.md | 7c4dd60ebf0ccf86 | 7c4dd60ebf0ccf86 | 7c4dd60ebf0ccf86 | 14424/14424 | 3b5248a47cfd… match |
| LICENSE | df20bdb784e05921 | df20bdb784e05921 | df20bdb784e05921 | 1070/1070 | 59520901b956… match |
| ledger.py | cc70ca9506127ec4 | cc70ca9506127ec4 | cc70ca9506127ec4 | 3122/3122 | 3ca78c35df54… match |
| rails.py | 2cf4e505dd3b5e77 | 2cf4e505dd3b5e77 | 2cf4e505dd3b5e77 | 10770/10770 | c6402a026113… match |
| web.py | 3160139f0e63e6f8 | 3160139f0e63e6f8 | 3160139f0e63e6f8 | 19087/19087 | e9ec387b6747… match |
| sessions.py | fe35d767de9d7920 | fe35d767de9d7920 | fe35d767de9d7920 | 12387/12387 | 3622214c3b16… match |
| swarm.py | b4fb4fd5c64e908e | b4fb4fd5c64e908e | b4fb4fd5c64e908e | 9379/9379 | 3f2ee4bd1acf… match |
| shell.py | ee516e76b5f6476b | ee516e76b5f6476b | ee516e76b5f6476b | 6401/6401 | c49fa56819f7… match |
| feedback.py | 5c00010d4ab1cfe6 | 5c00010d4ab1cfe6 | 5c00010d4ab1cfe6 | 7742/7742 | 171636e51b78… match |
| rewind.py | bc7f0451ccca9f6c | bc7f0451ccca9f6c | bc7f0451ccca9f6c | 4012/4012 | 59d34b6a034c… match |
| web/index.html | 2a3974a51a8d78bd | 2a3974a51a8d78bd | 2a3974a51a8d78bd | 54719/54719 | 7be914d43597… match |

- ANY-mismatch rule: zero mismatches found — not on any leg, not on any file.
- The three files the house scan tripped on are pristine, verified especially: README.md (`7c4dd60e…`), web.py (`3160139f…`), web/index.html (`2a3974a5…`) — all three byte-identical to the pin blobs, matching the partial digests quoted in the commit message.
- Additional crosscheck: the git blob SHA-1 of every vendored path at the pin equals the `upstream_git_blob` value recorded in `PROVENANCE.json`, and every file size matches the recorded `bytes` field.

## Check 3 — acceptance suite at the head: PASS (9/9)

Command: `python3 -m unittest discover -s tests -p test_rails_vendor.py` (Python 3.12.3, run in a workspace whose tree equals the head tree `6316c39a…`; the suite is stdlib-only).

```
Ran 9 tests in 0.004s
OK
```

The nine tests, all passing: provenance manifest present with exact pin; provenance records explicit nothing-executed statement; provenance records fetch method and license; every vendored file digest matches manifest; license present with MIT copyright line; no auto-run hook in vendored bytes; suite never imported vendored modules; vendored tree contains exactly the leased files; web asset inspectable without node.

Exact counts: 9 passed, 0 failed, 0 errors. (The worker's self-check was reported as 6/6 in the dispatch context; the committed suite as applied contains 9 tests and passes 9/9 — a superset, no contradiction.)

## Check 4 — RED-first mutation counterfactual, both ways: PASS

Mutation (RED leg): exactly one byte flipped inside a vendored file — offset 0 of `contrib/vibeline/README.md`, byte value 0x23 changed to 0x22 (the file's first character). Effect: the file's SHA-256 changed from the recorded `7c4dd60ebf0ccf86…` to `b201938ca90e9fb5…`.

- RED: `Ran 9 tests ... FAILED (failures=1)` — the digest-manifest test fails with "README.md is not byte-identical to the recorded digest" (observed vs recorded digest shown in the test output). The other 8 tests still pass.

Restore (GREEN leg): the same offset restored to its original value 0x23; the file's SHA-256 returned to `7c4dd60ebf0ccf86…` (verified programmatically), i.e. byte-identical to the pin and the manifest again.

- GREEN: `Ran 9 tests ... OK` (9/9). `git status --porcelain` and `git diff --stat` empty afterwards — pristine state fully restored, no residue.

Both directions demonstrated: the digest-manifest gate genuinely detects a one-byte drift in vendored material and returns to green on restoration. It is not decorative.

## Check 5 — house-scan re-verification over every added line: PASS with disclosures

Disclosure first: the house scanner binary (`bundlebees_plugin.security.looks_like_secret`) is NOT importable in this audit environment (bundlebees checkout absent from this host) — the same disclosed environment limitation recorded in the `review/pr41` precedent. The scan below reproduces the predicate from its documented behavior, cross-checked against the shape families named in the review brief, with controls proving the scan runs in both directions.

Evidence base: all 3148 added lines of the PR delta extracted with exact new-file line numbers from `git diff 84dadcb...ca2411a --unified=0`.

Reconstructed predicate families (documented behavior: an assignment or parameter whose NAME carries secret-bearing vocabulary, with a non-empty value after the separator — the value-shape clause established in the od41 precedent — plus the brief's literal families):

- Family A — secret-bearing name (password, passwd, secret, token, api key, access key, auth token, authorization, credential; case-insensitive, word-bounded, singular) followed by a name/value separator and at least one non-space character.
- Family B — a Bearer-prefixed header value carrying six or more token-class characters.
- Family C — provider key literals (OpenAI-style, GitHub classic/fine-grained PAT, Slack workspace, AWS access-key, Google API-key, and the JWT three-segment prefix).
- Family D — credential-shaped URL query parameters with a non-elided value.

Results over all 3148 added lines:

1. Family A trips on EXACTLY 11 lines; families B, C, D trip NOWHERE in the delta (zero bearer-with-literal, zero provider literals, zero credential URL values).
2. The 11 trips, matching the coordinator's diagnosis counts exactly (README 1, web.py 7, web asset 3):
   - `contrib/vibeline/README.md` line 111 — prose example invocation whose example URL carries an elided token placeholder (dots, no value).
   - `contrib/vibeline/web.py` lines 209 and 400 — keyword-only parameter declarations whose annotated name is the singular token word and whose default value is the empty string.
   - `contrib/vibeline/web.py` line 405 — parameter filled from a named environment secret accessor; the literal is an env-var NAME in caps, not a value.
   - `contrib/vibeline/web.py` line 408 — the parameter assigned from a standard library token-GENERATOR call (a random generator invocation, not a value).
   - `contrib/vibeline/web.py` line 410 — the parameter passed through to a server constructor as an identifier-to-identifier binding.
   - `contrib/vibeline/web.py` lines 421 and 422 — startup banner f-strings printing connection URLs whose query parameter interpolates the runtime variable (brace placeholder, not a literal).
   - `contrib/vibeline/web/index.html` line 276 — client-side read of the URL query parameter into a constant, empty-string fallback.
   - `contrib/vibeline/web/index.html` line 279 — the client fetch wrapper building an Authorization header from a Bearer-prefixed value plus the runtime variable (runtime concatenation; no literal follows the scheme word, so family B does not trip).
   - `contrib/vibeline/web/index.html` line 356 — runtime query-string builder concatenating the same runtime variable into a link URL.
3. Per-line classification: every one of the 11 trips is identifier-shaped token plumbing or prose/example text. NONE contains a credential-shaped literal: the value sides are empty strings, identifier passthroughs, f-string placeholders, runtime concatenations, env-var names, or generator calls. A real secret-shaped literal anywhere in the patch would have been a BLOCKING defect; none exists.
4. Negative/positive controls proving the scan runs (synthetic, composed for this audit, fake values only — never real material):
   - Trips as intended: a control pairing the name `password` with a colon separator and the fake value SYNTHETIC-CONTROL-VALUE-0123456789 (family A); a control pairing a Bearer-prefixed header value with a 22-character fake marker SYNTHETICCONTROL000000 (family B); a control carrying a fake OpenAI-style key literal `sk-` plus SYNTHETICCONTROL0123456789 (family C).
   - Does NOT trip, as intended: an object-literal key in the plural (`tokens:`) with an identifier value; a bare name guard with no value after the separator; an env-name accessor call. The plural and no-value exclusions are exactly what keeps the many benign `tokens` count fields (sessions.py, swarm.py, ledger totals, dashboard stat cells) out of the trip set.
5. Attribution reconciliation (all non-blocking, disclosed):
   - The commit message's diagnosis — 11 trips: README (1), web.py (7), web/index.html (3) — matches my scan EXACTLY, line for line.
   - The review brief's line enumeration lists 10 of the 11 (it omits web.py line 422, the twin `--peer` URL-print line of 421, while its own total of 11 and the commit message's "web.py (7)" require it). Taken as a brief-text omission, not a delivery defect.
   - `PROVENANCE.json`'s own `house_scan_exceptions` ledger lists a 13-line superset (adds web.py lines 289 and 407, both bare name-guard lines — a bare singular token name with no value after the separator — excluded by the documented value-shape clause). The worker's recorded ledger is stricter than the coordinator's diagnosis; both agree on the binding fact: zero credential-shaped literals in the 3148 added lines.
   - The vendored files being pristine upstream bytes (Check 2) independently proves the coordinator applied the payload unmodified: no post-scan editing of "tripping" lines occurred.

## Check 6 — inert execution posture + PROVENANCE completeness: PASS

- The vendored subset is exactly 11 upstream files. The upstream root's direct-execution and packaging surfaces (`__main__.py`, `cli.py`, `install.sh`, `plugin.yaml`, `Makefile`) exist at the pin but are deliberately NOT vendored (verified against the pin's tree listing) — no upstream startup/install hook is present in the vendored tree.
- All 13 PR files carry git mode 100644 — no executable bits.
- The ONLY reference to the vendored tree anywhere in the repo outside `contrib/vibeline/` is `tests/test_rails_vendor.py` itself, which inspects bytes statically. No server, src, package.json, workflow or runtime code references the directory: Orbit does not import, execute, install or run any vendored file.
- The acceptance gate statically proves the inert posture from within the 9/9 run: no auto-run hook signatures (direct-execution guard, setuptools/console_scripts/entry_points, npm-style scripts/preinstall/postinstall, and similar) appear anywhere in the vendored bytes, and the suite proves it never imported any vendored module.
- `PROVENANCE.json` records, and this audit verified: the exact pin; `pin_source` (main pointed at the pin at fetch time, ls-remote-verified — independently corroborated live TODAY); `fetch_method` (single clone + checkout, byte-for-byte copy, re-verified against object-database output); per-file SHA-256 digests for all 11 vendored files (all matched, Check 2); license `MIT` and copyright `Copyright (c) 2026 ListeningPost` (present as the second line of the committed LICENSE); and an explicit execution_policy statement that nothing upstream is executed by Orbit at runtime.

## Check 7 — PR CI: recorded (pending, acceptable per brief)

`gh` is unauthenticated in this environment; the public REST check-runs and combined-status endpoints were used for the head sha instead. At audit time: 20 check runs — completed success: `catalog`, `Fresh container onboarding`, `Detect Workbench scope` (two matrix instances); in progress or queued: `test` (two instances) and the Workbench matrix (`core`, `chat`, `themes`, `tools`, `workspace`, `workspace-composition`, `deferred execution and results`, one skipped instance of the latter); combined commit status: `pending`. Pending is recorded as instructed; Checks 1–6 are the binding local evidence. (Duplicate per-name runs are the workflow's matrix re-runs, not a failure signal.)

## Check 8 — this report scanned with the same predicate: 0 trips

The finished report text was scanned with the same four families as Check 5 plus a manual vocabulary review: 0 trips. The 11 tripped upstream lines are described by shape and line number rather than quoted verbatim; the only hex strings are git commit/object identifiers (public repo state) and 16-character SHA-256 prefixes of public upstream file contents (content digests, not credentials); provider-vocabulary appears only as bare prefix names with no literal values; the bearer word appears only as a bare name, never followed by six or more token-class characters; the synthetic controls are described rather than embedded as scannable shapes.

## Disclosures (non-blocking)

1. The house scanner binary is not importable in this audit environment (bundlebees checkout absent) — same disclosed precedent as the `review/pr41` audit. Check 5 uses a documented-behavior reconstruction with both-direction controls; the binding, independently verified fact is zero credential-shaped literals across all 3148 added lines.
2. The review brief's enumerated trip list contains 10 lines while requiring 11; the missing line is web.py 422 (the twin URL-print of 421). The commit message's 1/7/3 attribution is the set my scan reproduces exactly.
3. `PROVENANCE.json`'s recorded exception ledger lists 13 lines (a strict superset adding the two value-less guard lines 289 and 407 of web.py). The worker's ledger and the coordinator's 11-line diagnosis differ in scanner strictness only; both agree no credential material exists.
4. The two-dot `main..head` diff shows 24 files because main advanced 6 commits past the branch point; the PR branch itself touches exactly the 13 leased files relative to the merge base, and a merge-tree simulation confirms a clean merge preserving main's newer work.
5. CI was pending, not green, at audit time — recorded as acceptable per the review brief.
6. PR-carried open issue (from the PR body, outside this lease): Orbit CI's bundle-parity gate (`tests/test_orbit_bundle.py`) may require a follow-up bundle-manifest update for the new contrib files; that manifest is outside this lease and was not touched.

## Blocking findings

None.

## Verdict

APPROVED — the delivery is exactly the 13 leased files (+3148/−0, single attributed commit), all 11 vendored files are byte-identical to the upstream pin `d5d0f425a64906ae1a50c1222314a5420da404d5` (three-way sha256 + blob-SHA + size crosschecks, zero mismatches), the acceptance gate passes 9/9 with a proven both-directions digest-mutation detector, the scan re-verification reproduces the coordinator's 11-trip attribution exactly with zero credential-shaped literals, the vendored subset is demonstrably inert with complete provenance, and the coordinator's scanner-overmatch attribution is independently confirmed as honest. Recommend merge per the coordinator's acceptance flow once CI completes.

## Head re-grounding (immediately before committing)

`git ls-remote https://github.com/mojomast/orbitdesktop refs/pull/43/head refs/heads/main` and the public REST pulls/43 endpoint re-run at commit time: `refs/pull/43/head` = `ca2411a85fcecba2b31201d2e0b58df5354dbdb4`, `main` = `84dadcb96c9f2aea71e7fe523f83c1586d7e11da`, state `open`. No head movement occurred between initial grounding and this commit. The upstream pin re-check (`listeningpost/vibeline` `refs/heads/main`) also still reads `d5d0f425a64906ae1a50c1222314a5420da404d5`.
