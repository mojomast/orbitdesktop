APPROVED

# Independent re-review — orbitdesktop PR #43 (rails/r03-vendor), round 2

- Reviewer: independent audit bee (single-bee review, no subagents)
- Review target: the branch UPDATE after round 1. R03 was cut at `8530a14b`, reviewed and APPROVED at `ca2411a` (att_15d1c1fd077744d6, applied as `review/pr43` commit `2e5a1cd5`); the coordinator then merged main `99a10c9` (the #42 bundle rebuild) into the branch to clear the PROVEN-INHERITED bundle-parity red at the merge-ref. New head: `36e7f7a4f91ff39ce5de9ed38f1303a7bdb04190`.
- Scope: independent re-verification of grounding, delta exactness, pristine byte-identity, the KEY bundle-gate regression proof (the round-1 open issue), inert execution posture, CI at the exact head, and scanner hygiene. Verdict and blocking findings below; disclosures are non-blocking (BLOCKING counts DEFECTS ONLY).
- Rules honored: nothing pushed, nothing commented on the PR; the only file written in this repo is this report, on branch `review/pr43-r2`, based at the PR head content.

## Environment (stated up front, not silent)

The supplied workspace is a snapshot: local git holds exactly one commit (`c2adee5f5aa8867ee8b60cb48d768b5d37db4409` on `master`, message `base 36e7f7a4f91ff39ce5de9ed38f1303a7bdb04190`), no remotes, no tags, no PR-history objects; `gh` is installed but unauthenticated. The snapshot commit's tree is **byte-identical to the PR head tree** — both are git tree `07f70825d8dadd1a23051645ed9e0db5cf3c4bcc` — so the checked-out rev content equals the PR head content exactly, and every local file check below is authoritative for the head. All GitHub-side facts were gathered through the public REST API plus a fetch-only clone of the public repo into a scratch directory (`/tmp/opencode/pr43-review/repo`); nothing was ever pushed. System python is 3.12.3 without pytest; the pytest runs used a disposable venv (pytest 9.2.0) — same disclosed limitation as the `review/pr45` audit.

## Check 1 — Grounding: PASS

Public REST `GET /repos/mojomast/orbitdesktop/pulls/43`:

- state `open`; head `rails/r03-vendor` @ `36e7f7a4f91ff39ce5de9ed38f1303a7bdb04190` (label `mojomast:rails/r03-vendor`); base `main` @ `99a10c95e49de27ba80a0e69f594a72aaadd975d`; `mergeable: true`; `commits: 2`; `changed_files: 13`. The branch ref `rails/r03-vendor` independently reads `36e7f7a4` in the branch listing — PR head, branch tip and merge commit are the same commit.
- Head = the checked-out rev: the snapshot commit records the head sha in its message and its tree hash equals the PR head's tree hash (`07f70825d8dadd1a23051645ed9e0db5cf3c4bcc`, compared programmatically), so the audited working tree IS the PR head.
- Branch history is exactly the R03 vendor commit plus this one merge commit: `git log origin/main..pr43` lists exactly two commits — `36e7f7a` ("merge main (99a10c9: the #42 bundle rebuild) into rails/r03-vendor", second parent IS main's tip `99a10c9`) and `ca2411a` ("rails R03: vendor vibeline pristine at pin d5d0f425…", parent `8530a14b`, which `git merge-base --is-ancestor` confirms is an ancestor of main). Nothing else is reachable from the branch that is not on main.

## Check 2 — Delta exactness at the new head: PASS

The merge base of `origin/main` and the PR head is `99a10c95e49de27ba80a0e69f594a72aaadd975d` — i.e. main's tip itself, because the coordinator merged main INTO the branch. Therefore the three-dot diff `origin/main...HEAD` equals the delta vs main, with no reverse-displayed main-only noise (the round-1 two-dot artifact is structurally gone).

`git diff --name-status 99a10c9…36e7f7a` — exactly 13 files, all status `A` (added), +3148/−0:

```
A  contrib/vibeline/LICENSE                  +21
A  contrib/vibeline/PROVENANCE.json         +108
A  contrib/vibeline/README.md               +274
A  contrib/vibeline/feedback.py             +180
A  contrib/vibeline/ledger.py               +94
A  contrib/vibeline/rails.py                +293
A  contrib/vibeline/rewind.py               +97
A  contrib/vibeline/sessions.py             +299
A  contrib/vibeline/shell.py                +149
A  contrib/vibeline/swarm.py                +172
A  contrib/vibeline/web.py                  +432
A  contrib/vibeline/web/index.html          +814
A  tests/test_rails_vendor.py               +215
13 files changed, 3148 insertions(+), 0 deletions(-)
```

Cross-checked against public REST `pulls/43/files`: 13 files, every one `added`, identical path set and identical +/− counts. The merge introduced NO other delta vs main: any main-side change absorbed by the merge is by construction identical on both sides of the merge base, and the three-dot file set above is the complete remaining delta.

## Check 3 — Pristine byte-identity re-proof at the new head: PASS

Upstream fetch (scratch clone, fetch-only): blobless clone of `https://github.com/listeningpost/vibeline`, checkout of pin `d5d0f425a64906ae1a50c1222314a5420da404d5` — which is that repo's `refs/heads/main` HEAD today (`git ls-remote` re-verified live during this audit, same as in round 1).

Three-way comparison over FULL file bytes for every upstream-derived file — pin blob vs PR-head bytes (verified identical in the local working tree, whose tree hash equals the head's) vs the manifest in `contrib/vibeline/PROVENANCE.json` — plus a fourth leg: the git blob OID of each path at the pin vs at the head:

| vendored file | sha256 (pin == head == manifest) | bytes | git blob OID pin==head |
|---|---|---|---|
| README.md | `7c4dd60ebf0ccf86…` | 14424/14424 | match |
| LICENSE | `df20bdb784e05921…` | 1070/1070 | match |
| ledger.py | `cc70ca9506127ec4…` | 3122/3122 | match |
| rails.py | `2cf4e505dd3b5e77…` | 10770/10770 | match |
| web.py | `3160139f0e63e6f8…` | 19087/19087 | match |
| sessions.py | `fe35d767de9d7920…` | 12387/12387 | match |
| swarm.py | `b4fb4fd5c64e908e…` | 9379/9379 | match |
| shell.py | `ee516e76b5f6476b…` | 6401/6401 | match |
| feedback.py | `5c00010d4ab1cfe6…` | 7742/7742 | match |
| rewind.py | `bc7f0451ccca9f6c…` | 4012/4012 | match |
| web/index.html | `2a3974a51a8d78bd…` | 54719/54719 | match |

- ANY-mismatch rule: zero mismatches on any leg, any file — full 64-hex digests compared programmatically (16-hex prefixes shown for gate-safe presentation; the authoritative full values are committed in `PROVENANCE.json` and matched exactly).
- The merge commit did not touch a single vendored byte: the PR head's `contrib/vibeline/*` blobs are the same git objects as at the r1 head `ca2411a` (the delta status is pure `A` on 13 files; nothing else changed), so the round-1 pristine proof carries over byte-for-byte — and was re-proven independently here anyway.
- `PROVENANCE.json` is the vendor's own manifest (not an upstream file); all 11 of its entries were recomputed and matched: sha256, byte counts and upstream git blob OIDs.

## Check 4 — THE KEY REGRESSION PROOF (bundle-parity gate at the head): PASS

Command: `python3 -m pytest tests/test_orbit_bundle.py -q` at the head (tree == PR head; pytest 9.2.0 venv, Python 3.12.3):

```
....  [100%]
4 passed in 0.67s
```

**The inherited red is cleared.** Before/after record:

- BEFORE (base `8530a14b` and r1 head `ca2411a`, both reproduced in scratch worktrees): each tree's own gate passes 3/3 — the pre-#42 gate contains no rebuild assertion. The inherited red reproduced IDENTICALLY at both revs on this host when the rebuild is executed with the pre-#42 bundler: rebuilt = 2124905 bytes with gzip OS byte 3 (`gzip.compress(mtime=0)` Python 3.11+ zlib fast path) vs committed artifact = 2124905 bytes with OS byte 255 → `EQUAL: False`, same length, byte prefix identical before byte 9. This is exactly DEFECT-1's interpreter-dependence mechanism named in the PR #42 review; it failed identically at base and at `ca2411a` because both carry the same pre-#42 bundler and the same committed artifact (`bded4e0904a08565…`, 2124905 bytes).
- The #42 fix lands as: bundler framing switched to explicit `GzipFile` (always OS 0xff), `build(target=None)`, and the tarball REBUILT and committed (`bca47223a21f287feeb4778562f09ff90c1f8272ecfeaee5471d2d51c1980bfb`, 2153309 bytes — byte-identical to the expected sha recorded by the PR #42 round-2 review).
- AFTER (head `36e7f7a`): the merge brings the fixed bundler + rebuilt tarball onto the branch; the gate now runs 4 tests and passes 4/4, including `test_rebuilt_bundle_reproduces_committed_tarball_bytes` (byte-exact reproduction on this host) and `test_bundle_contains_every_policy_member` (the bundler's inclusion policy excludes `contrib/`, so the vendored reference material is deliberately outside the bundle policy — the PR does not perturb bundle parity).
- Cleanliness: `git status` clean after every local run; the rebuild writes only to temporary directories; no tracked file was clobbered.

Companion gate: `python3 -m pytest tests/test_rails_vendor.py -q` at the head → `9 passed` (9/9, exit 0), matching the round-1 result.

## Check 5 — No startup hooks; inert execution posture re-affirmed: PASS

- The 9/9 acceptance gate statically proves from within the run: no auto-run-hook signatures (`if __name__`, `console_scripts`, `entry_points`, `setuptools`, `"scripts"`, `postinstall`, `preinstall`, `uvicorn`) anywhere in the vendored bytes; the suite never imported any vendored module (`sys.modules` proof); no executable bits; the tree is exactly the leased set (11 upstream files + `web/index.html` + `PROVENANCE.json`); the web asset is plain readable text with no node dependency.
- Independent re-scan at the head (this audit, not the suite): the same eight signature families over all 12 vendored files → **0 hits**; top-level entries are exactly the leased set; the upstream direct-execution and packaging surfaces (`__main__.py`, `cli.py`, `install.sh`, `plugin.yaml`, `Makefile`, `__init__.py`) exist at the pin but are absent from the vendored subset (checked against the pin's tree listing).
- Repo-wide reference scan at the head tree: the ONLY reference to `contrib/vibeline` anywhere outside the directory itself is `tests/test_rails_vendor.py` (bytes-only inspection). No server, src, package.json, workflow or runtime code imports, executes, installs or runs any vendored file. `PROVENANCE.json`'s execution_policy states this explicitly and was verified.

## Check 6 — CI at the exact head: recorded (in progress; non-blocking per the review contract)

Public REST check-runs for `36e7f7a4f91ff39ce5de9ed38f1303a7bdb04190` at audit time: 13 check runs — `Detect Workbench scope` completed success; `test` and `Fresh container onboarding` in progress; the Workbench matrix (`core`, `chat`, `themes`, `tools`, `workspace`, `workspace-composition`, `deferred execution and results` — one skipped) and `catalog` queued. Combined commit status: `pending` (0 classic statuses). No check at the head has concluded `failure`. In-progress is recorded as a non-blocking observation; the local suite results (Check 4) are the deciding evidence for this review. At the pre-commit re-grounding the wave had advanced to 20 check runs — 3 completed success, 2 skipped, 4 in progress, 11 queued — still zero failures.

Historical CI context at the r1 head `ca2411a` (for the record): two concurrent waves ran at that sha (the workflow's push+pull_request triggers with cancel-in-progress concurrency); one wave concluded failure (`test` at the "Widget schema and publisher parity" step — the step that runs `tests/test_orbit_bundle.py` — plus `workbench` and `Workbench / core`) while the twin wave concluded success at the same sha. Logs are not retrievable unauthenticated, so the failing assertion within that step is not attributable from public data; the local before/after evidence above is the binding record of the bundle-gate state at each rev.

## Check 7 — Scanner hygiene: PASS (0 trips on the delta; one mandated line here)

Rule list (disclosed): the coordinator's canonical six gate rules are not retrievable from this repository (the verify harness is external), so this review scanned every added line against six explicitly stated canonical secret gates, calibrated with the od-r1 value-shape clause (empty values, identifier passthroughs, f-string/brace placeholders, runtime concatenations, env-var NAME accessors and generator calls are not credential literals):

- G1 Authorization headers carrying access credentials (literal values only)
- G2 provider API-key shapes (OpenAI-style `sk-`, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, Slack `xox…`, AWS `AKIA…`, Google `AIza…`, JWT three-segment)
- G3 secret-bearing key/value assignments (password, passwd, secret, token, api key, access key, client secret, auth token, credential) with a quoted literal value of eight or more characters
- G4 PEM private-key block headers
- G5 URL userinfo credentials (`user:pass@host`, non-elided values)
- G6 Slack incoming-webhook paths and package-registry token shapes (`_authToken`, `pypi-AgEI…`)

Controls (both directions, synthetic values only): all twelve positive shapes trip (one per family/shape); all eight negative shapes stay clean — plural key with identifier value, bare name guard, `Bearer ${token}` interpolation, `'Bearer ' + token` concatenation, f-string bearer value, elided `user:....@` URL, empty-string token default, env-var NAME accessor. The negative set includes the delta's own runtime-plumbing shapes, so the calibration is anchored to this PR's material.

Results:

- Added lines: all **3148** lines of the 13 added files scanned (the files are new, so every line is an added line; line numbers agree with the file-relative numbers used by `PROVENANCE.json`'s exception ledger) → **0 trips** under G1–G6.
- The 13 lines recorded in `PROVENANCE.json`'s `house_scan_exceptions` were spot-verified: an example `--peer` invocation whose URL carries an elided `token=...` placeholder (README.md line 111); empty-string `token` parameter defaults and an env-var NAME accessor, a bare name guard, a `secrets.token_urlsafe` generator call and an identifier passthrough (`web.py` 209/289/400/405/407/408/410); startup-banner f-string URL prints interpolating the runtime variable (421/422); client-side runtime reads and concatenations of the URL-query token (index.html 276/279/356). None contains a credential-shaped literal; none trips the six gates. This is consistent with the round-1 finding (11 trips under the house scanner's broader name-based family, all identifier-shaped or prose) and with the commit message's scanner-overmatch attribution.
- This report file: scanned with the same six gates → **exactly 1 trip**, which is the mandated negative-control line below, labeled NOT a secret in the same line; no other trip.

Negative control (NOT a secret — synthetic coordinator-owned marker, proves the scanner fires): `Authorization: Bearer NEGATIVE-CONTROL-SYNTHETIC-MARKER-NOT-A-SECRET`

## Disclosures (non-blocking)

1. Local git holds no PR-history objects (single flattened snapshot commit); all commit-graph, merge-base, delta and CI facts were established through the public REST API and a fetch-only scratch clone. The snapshot tree hash equals the PR head tree hash, so all local file checks are authoritative for the head.
2. System python lacks pytest; the suite runs used a disposable venv (pytest 9.2.0, Python 3.12.3). The gate is stdlib-only; a plain `python3 -m unittest` run of the vendor gate also passes 9/9.
3. The "before" half of Check 4 could not be reproduced through pytest at the baselines using the head's test FILE alone, because the pre-#42 bundler's `build()` lacks the `target` parameter the post-#42 test calls with (a `TypeError` at the call site, identical at both baselines). The faithful before-record is the direct rebuild comparison above (old bundler output vs committed artifact: OS byte 3 vs 255, `EQUAL: False` identically at base and `ca2411a`), which is the exact mechanism DEFECT-1 names. With the post-#42 bundler AND test transplanted onto the baseline trees the rebuild assertion passes there too — the baseline artifacts are 0xff-framed; the red manifests specifically through the pre-#42 `gzip.compress` bundler on 3.11+ interpreters.
4. CI at the exact head was still in progress at review time (Check 6); recorded as a non-blocking observation per the review contract. The historical ca2411a failing step bundles three scripts and its per-script log is not publicly retrievable unauthenticated; that ambiguity does not affect the local before/after evidence.
5. Review-workspace artifact (not a PR defect): this report is a new tracked `docs/` file on the review branch, and the bundler's inclusion policy includes `docs/` — so on the review branch (not at the PR head) `tests/test_orbit_bundle.py`'s reverse-completeness test will count `docs/review-pr43-r2.md` as a policy member missing from the committed tarball. At the pristine PR head the gate passes 4/4 (Check 4). Same pattern as the `review/pr42-r2` precedent.
6. PR-carried open issue from round 1 (bundle manifest outside the lease) is RESOLVED by the merge: the #42 rebuild regenerated the artifact and the gate is green at the head; no follow-up remains on this PR's account.

## Blocking findings

None.

## Verdict

APPROVE — the branch update is exactly one merge commit of main `99a10c9` into the round-1-approved R03 branch; the delta remains exactly the 13 leased files (+3148/−0, all additions); all 11 vendored files are byte-identical to the upstream pin `d5d0f425a64906ae1a50c1222314a5420da404d5` (sha256 × pin/head/manifest + git blob OID × pin/head, zero mismatches); the KEY regression proof holds — `tests/test_orbit_bundle.py` passes 4/4 at the head where the same rebuild-parity assertion mechanism failed identically at base and at `ca2411a` before the #42 rebuild; the vendor gate passes 9/9; the vendored subset remains demonstrably inert; CI at the head is in progress with no failures observed; and the scanner-hygiene scan of all 3148 added lines yields zero trips under the six gates with exactly one mandated, labeled negative-control line in this report. Recommend merge per the coordinator's acceptance flow once CI completes.


## Head re-grounding (immediately before the final commit)

`git ls-remote https://github.com/mojomast/orbitdesktop refs/pull/43/head refs/heads/rails/r03-vendor refs/heads/main` and the public REST pulls/43 endpoint re-run at commit time: `refs/pull/43/head` = `refs/heads/rails/r03-vendor` = `36e7f7a4f91ff39ce5de9ed38f1303a7bdb04190`, `main` = `99a10c95e49de27ba80a0e69f594a72aaadd975d`, state `open`. No head movement occurred between initial grounding and this commit; the audited tree is still the PR head tree. The upstream pin re-check (`listeningpost/vibeline` `refs/heads/main`) also still reads `d5d0f425a64906ae1a50c1222314a5420da404d5`. This report was scanned with the same six gates immediately before committing: exactly 1 trip — the mandated negative-control line (line 120), labeled NOT a secret in the same line; no other trip.

## JSON summary

```json
{"summary":"Independent round-2 review of PR #43 (rails/r03-vendor) at the updated head 36e7f7a (coordinator merge of main 99a10c9 into the r1-approved branch ca2411a): grounding PASS (open, base main 99a10c9, head == branch tip == merge commit; branch history is exactly ca2411a + one merge; local snapshot tree == PR head tree 07f70825), delta PASS (three-dot origin/main...HEAD is exactly the 13 leased files, all added, +3148/-0, cross-checked against pulls/43/files), pristine byte-identity PASS (all 11 upstream-derived files sha256-identical across pin d5d0f425 / head / manifest with matching git blob OIDs; zero mismatches), KEY regression PASS (pytest tests/test_orbit_bundle.py 4/4 at the head; the rebuild-parity red reproduced identically at base 8530a14b and ca2411a - rebuilt OS byte 0x03 vs committed 0xff, EQUAL False on both - and cleared by the #42 rebuild; vendor gate 9/9), inert posture PASS (zero auto-run signatures, no vendored module ever imported, no exec bits, exact leased file set, sole repo reference is the gate test), CI at head in-progress with zero failures (non-blocking, recorded), scanner hygiene PASS (0 trips across all 3148 added lines under six disclosed gates with both-direction controls; this report carries exactly one mandated, labeled negative-control line)","changed_files":["docs/review-pr43-r2.md"],"checks":[{"name":"grounding","command":"GET api.github.com/repos/mojomast/orbitdesktop/pulls/43 + git ls-remote + local tree-hash comparison (07f70825)","passed":true},{"name":"branch-history","command":"git log origin/main..pr43 + merge-base --is-ancestor 8530a14b main","passed":true},{"name":"delta-exactness","command":"git diff --name-status 99a10c9...36e7f7a + GET pulls/43/files","passed":true},{"name":"pristine-byte-identity","command":"sha256(pin blob) vs sha256(head bytes) vs PROVENANCE.json + git blob OID pin vs head, 11 files","passed":true},{"name":"bundle-gate-at-head","command":"python3 -m pytest tests/test_orbit_bundle.py -q (venv pytest 9.2.0, python 3.12.3)","passed":true},{"name":"vendor-gate-at-head","command":"python3 -m pytest tests/test_rails_vendor.py -q","passed":true},{"name":"inherited-red-baseline","command":"scratch worktrees 8530a14b + ca2411a: own gates 3/3; old-bundler rebuild vs committed artifact EQUAL False (OS byte 3 vs 255) identically at both","passed":true},{"name":"inert-posture","command":"8 auto-run signature families over 12 vendored files (0 hits) + sys.modules proof in-suite + repo-wide reference scan","passed":true},{"name":"ci-at-head","command":"GET check-runs + commit status for 36e7f7a (in progress, 0 failures)","passed":true},{"name":"scanner-hygiene","command":"six-gate scan of 3148 added lines (0 trips) + controls + this report (exactly 1 mandated trip)","passed":true}],"open_issues":["CI at the exact head still in progress at review time (0 failures observed; local results are the deciding evidence)","coordinator's canonical six gate rules not in-repo; six equivalent gates applied and disclosed per the review/pr45 precedent","review-workspace artifact: on the review branch the bundler completeness test counts this report as a policy member missing from the tarball (docs/ is in the inclusion policy); passes at the pristine head"]}
```