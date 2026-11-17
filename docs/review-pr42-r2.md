# Independent re-review — orbitdesktop PR #42 (fix/orbit-source-bundle-rebuild), round 2

- Head under review: `2d305a990571f17f07ad9c793a6e68fe4a514449` (base `main` `84dadcb96`)
- Prior round: first review found DEFECT-1 (prescribed rebuild did not reproduce the committed tarball sha256 on this host — gzip header byte 9 OS-field interpreter dependence); repair attempt `att_f90fabd8` landed as coordinator-applied commit `2d305a9` (patch unmodified, exactly `scripts/bundle_hermes.py` + `tests/test_orbit_bundle.py`).
- This review ran on a supplied snapshot working tree at head `2d305a9` (local git contains a single snapshot commit `0420585` mapping to that head; the object database holds **no** PR-history objects, no remote is configured, and `gh` is unauthenticated). Consequences are stated per check below; every executable check was run on-host.

## Environment limitations (stated up front, not silent)

1. `git diff e9efdbad..2d305a9` and `git diff 84dadcb..2d305a9` cannot be executed locally: revisions `e9efdbad`, `84dadcb96` and `2d305a9` are not present (`git cat-file -t` fails for all three; `git cat-file --batch-all-objects --batch-check` shows exactly **1** commit object — the snapshot; refs: `master` only, no tags, no packed-refs). Compensating evidence is given in checks 1 and 5.
2. The commit message of `2d305a9` (disclosure chain) is likewise not readable locally.
3. `gh pr checks 42` is unavailable: `gh` is installed (`/usr/local/bin/gh`) but unauthenticated ("To get started with GitHub CLI, please run: gh auth login"); no remote is configured.

## Check 1 — Repair delta exactness (`e9efdbad..2d305a9`)

Status: **not directly executable in this environment** (no history objects; see limitations). Compensating evidence gathered on the shipped tree:

- The repair content is confined to the two leased files. A whole-tree grep for the repair mechanism (`GzipFile`, `OS=0x03`, `interpreter-independent`, `0xff` in framing context) matches only `scripts/bundle_hermes.py:39-42`; the DEFECT-1 regression matches only `tests/test_orbit_bundle.py:56-66`. No other tracked file carries repair-related content.
- `scripts/bundle_hermes.py` at head uses `gzip.GzipFile(fileobj=..., mode='wb', mtime=0)` (framing written by `GzipFile`, which always emits OS=0xff), with a comment that names the defect mechanism exactly as disclosed: `gzip.compress(mtime=0)`'s Python 3.11+ zlib fast path writes OS=0x03.
- On-host mechanism confirmation (Python 3.12.3): `GzipFile` header byte 9 = `0xff` (255); `gzip.compress(mtime=0)` header byte 9 = `0x03` (3) — the exact DEFECT-1 divergence the repair addresses.
- The commit-message disclosure chain (attempt id `att_f90fabd8`, verify-sandbox refusal + reason, on-host evidence) could not be read from local git. Not verifiable here; recorded as such and treated as a non-blocking environment limitation (see Blocking items).

## Check 2 — DEFECT-1 resolution proof at the head (bundler run, sha pair)

Command: `python3 scripts/bundle_hermes.py` (writes `hermes-plugin/orbit-source.tar.gz` in place), sha256 before and after, then `git checkout -- hermes-plugin/orbit-source.tar.gz`.

- Python on host: 3.12.3 (the interpreter family whose `gzip.compress` fast path caused DEFECT-1).
- sha256 BEFORE: `bca47223a21f287feeb4778562f09ff90c1f8272ecfeaee5471d2d51c1980bfb`
- sha256 AFTER:  `bca47223a21f287feeb4778562f09ff90c1f8272ecfeaee5471d2d51c1980bfb`
- **Equal.** Matches the committed/expected `bca47223a21f287f…` prefix. DEFECT-1 is resolved at the head on this host.
- Direct header evidence: committed tarball gzip header byte 9 (OS field) is `0xff` (255), mtime=0 — the interpreter-independent framing the fix prescribes.
- Restore: `git checkout -- hermes-plugin/orbit-source.tar.gz` executed; sha256 re-checked unchanged (`bca47223a21f287f…`), `git status` clean.

## Check 3 — Regression test quality + full suites at the head

Test under review: `tests/test_orbit_bundle.py::BundleTest::test_rebuilt_bundle_reproduces_committed_tarball_bytes`

- Asserts **rebuilt bytes == committed bytes** (line 66: `self.assertEqual(rebuilt, committed, ...)` on the raw tarball bytes, not merely the gunzipped payload).
- Does **not** clobber tracked files: `bundler.build(target)` writes to a `tempfile.TemporaryDirectory()` path (`temp/orbit-source.tar.gz`); the committed tarball is only read (line 61). Verified additionally by running the full suite and confirming `git status` stays clean.

Full runs at the pristine head (in a detached `git worktree` at `0420585`, so the tracked set equals the PR head exactly):

- `python3 tests/test_orbit_bundle.py` → **Ran 4 tests … OK** (`test_unpack_complete_and_private`, `test_bundle_matches_reviewable_source_and_excludes_private_data`, `test_bundle_contains_every_policy_member`, `test_rebuilt_bundle_reproduces_committed_tarball_bytes`).
- `python3 tests/test_portable_endpoints.py` → **Ran 3 tests … OK**.

## Check 4 — RED both ways (mutation)

All mutation work was done in detached `git worktree`s at the pristine head (`0420585`), because this review's own committed report (`docs/review-pr42-r2.md`) is a new tracked `docs/` file on the review branch and would legitimately change any rebuild (see "review-workspace artifact" below). Mutations were reverted to **byte-identical** state each time, verified by sha256 against the committed blob `068ee1c7efe2f33974b1369c82456a33332254dea1b92cbbbc1c06c58911a772`.

- Baseline (pristine): bundle suite 4/4 OK; regression test OK; rebuilt size 2153309 bytes.
- **RED way 1 (OS byte forced back to the 0x03 path):** replaced the `GzipFile` block with `compressed.write(gzip.compress(output.getvalue(), mtime=0))` → regression test **FAILED**: rebuilt bytes ≠ committed bytes with the framing delta isolated (`…x02\x03…` vs committed `…x02\xff…` — same length, only header byte 9 differs). This is exactly the pre-fix behavior.
- Restore: file reverted, sha256 `068ee1c7…` byte-identical → regression test **OK** again.
- **RED way 2 (payload divergence):** removed `README.md` from the bundler's `FILES` set (framing untouched) → regression test **FAILED** (rebuilt length differs from committed). Restore: sha256 byte-identical → full bundle suite **4/4 OK** again (re-verified in a fresh worktree).
- Note (honest negative controls): two earlier trial mutations excluding `LICENSE` were no-ops — `LICENSE` is listed in `FILES` but is not tracked/on disk, so the rebuild was unchanged and the test correctly stayed **green**. The regression test fails only on real divergence.

Review-workspace artifact (not a PR defect): on the review branch (where this report is a tracked file), `python3 tests/test_orbit_bundle.py` reports 2 failures — `test_bundle_contains_every_policy_member` (missing member: exactly `docs/review-pr42-r2.md`) and `test_rebuilt_bundle_reproduces_committed_tarball_bytes`. Both are the tests correctly detecting that the review workspace adds a tracked `docs/` file that the PR-head tarball cannot contain. At the pristine head both pass. This incidentally confirms the tests detect any tracked-tree drift.

## Check 5 — Whole-PR sanity (`84dadcb..2d305a9`)

Status: **direct diff not executable in this environment** (no history objects; see limitations). Compensating evidence on the shipped tree:

- The PR ships the tarball with sha256 `bca47223a21f287feeb4778562f09ff90c1f8272ecfeaee5471d2d51c1980bfb` — exactly the expected `bca47223a21f287f` prefix — and the prescribed rebuild reproduces it **byte-for-byte** on this host (check 2). Whether the tarball bytes changed in `e9efdba` is not observable locally; the shipped sha is `bca47223a21f287f…` and it is reproduced by the rebuild.
- Docs members ship inside the tarball (e.g. `docs/XPRA_APPS.md` is asserted by `test_unpack_complete_and_private`; `test_bundle_contains_every_policy_member` proves the archive set equals the bundler's tracked-file policy set exactly — no extra or missing members at this tree).
- No unrelated files: the repair-related content greps to exactly the two leased files (check 1); the only other binary artifact involved is the tarball itself. A literal `--stat` listing could not be produced locally and is not claimed.

## Check 6 — Scanner self-scan of this report

Command: the coordinator-supplied house credential pattern, run as `grep -nEi '<pattern as supplied>' docs/review-pr42-r2.md`. The pattern text is deliberately not reproduced in this file: quoting any of its token-shaped alternatives verbatim makes this line self-match.

Result recorded below: exactly one match, the mandated negative control.

Negative control (mandated, not a secret): Authorization: Bearer SYNTHETIC-NEGATIVE-CONTROL-NOT-A-SECRET

## Check 7 — CI

`gh pr checks 42` **unavailable** (gh unauthenticated; no remote configured) — recorded as unavailable, not as a pass.

## Blocking items

None.

## Non-blocking limitations (environment, not the PR)

1. Literal `e9efdbad..2d305a9` delta diff and the `2d305a9` commit-message disclosure chain could not be read: the supplied environment contains no PR-history git objects and no remote. Compensating evidence: repair content confined to the two leased files; both leased files verified in full on-host (checks 1–4).
2. Literal `84dadcb..2d305a9` diff could not be produced (same reason). Compensating evidence: check 5.
3. CI status unavailable (gh unauthenticated, no remote). Recorded as unavailable.

## Verdict

VERDICT: APPROVE

Basis: the shipped bundler reproduces the committed tarball byte-for-byte on this host (sha pair equal, `bca47223a21f287f…`), the regression test asserts exact byte equality without clobbering tracked files, fails on both framing-level and payload-level divergence, and restores to byte-identical state; both suites are green at the head (4 + 3 tests). All findings that could not be re-verified are provably unanswerable in the supplied snapshot environment and are recorded as such.
