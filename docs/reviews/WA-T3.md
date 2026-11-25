VERDICT: APPROVE

# WA-T3 independent review of PR #103 — AGENTS.md short router

## Scope and method

The checkout is a single squashed commit whose tree holds PR head `081a80a3`
(`AGENTS.md` blob `2c40c79`, matching the supplied diff header
`index 99b42ca..2c40c79`); the base is not present as a git object, so the
base..head diff could not be re-derived with `git diff`. I reviewed the head
file, the approved `tests/agents-router.test.mjs` (read-only, blob `be1db3f`,
working tree clean), the supplied diff, the bundled archive
`hermes-plugin/orbit-source.tar.gz`, and the referenced docs. To check the RED
claim independently I reverse-applied the supplied diff in `/tmp` (outside the
workspace), recovering a 1938-byte base `AGENTS.md` that reproduces the supplied
RED output exactly (tests 1, 3 and 4 fail; test 2 passes). No product file,
approved test, gate, sandbox or check was edited by this review.

## Acceptance criteria

- **Short file:** `AGENTS.md` is 1481 bytes (limit 1500), down from 1938.
- **Non-standard commands kept:** `npm run check` and
  `scripts/bundle_hermes.py` are both present (`AGENTS.md:15`), and both scripts
  exist in the tree.
- **Conditional doc pointers:** every line naming `docs/*.md` uses
  when/if/only and names at most two docs (`AGENTS.md:5-9`). The five named docs
  (`AGENT_GUIDE`, `PLUGINS`, `ARCHITECTURE`, `WORKSPACE_USABILITY`,
  `TECHNOLOGY_FEATURES`, `WORKSPACE_PROMPTS`, `DEPLOYMENT`) all exist and are in
  the archive.
- **No blanket read-first instruction:** the old "Read … before changing" and
  "For current features, read" prose is gone; only conditional bullets remain.
- **Archive regenerated:** `AGENTS.md` is in `scripts/bundle_hermes.py`'s
  `FILES`, and the archive contains `AGENTS.md` with the same SHA-256 and 1481
  bytes as the working file. `tests/test_orbit_bundle.py` (7/7) includes the
  byte-identical rebuild check, so the tarball is the tracked tree's archive.
- **No weakening:** the approved test is unchanged and passes 4/4. The diff
  removes no check or gate. The owner-only API and draft-insertion guardrail
  dropped from the always-loaded file remains in the conditionally pointed
  `docs/AGENT_GUIDE.md:61-70` and in `docs/DOCUMENTS.md:164` /
  `docs/ARCHITECTURE.md:111`, so guidance is relocated, not lost.
- **No secrets/hosts/paths:** `AGENTS.md` contains no credential, hostname, IP
  or absolute path.
- **Lease:** the supplied diff changes only `AGENTS.md`; the binary archive is
  the rebuilt bundle and its parity test passes.

## Findings

1. **minor — `AGENTS.md:15`.** The retained sentence says "package metadata is
   0.3.1", but this checkout's `package.json:3` and `package-lock.json:3,9`
   declare `0.4.0` (while `README.md` and the deployment/verification docs still
   say 0.3.1). The sentence pre-dates this PR in substance, so the slice does
   not introduce it, but the PR re-affirms a claim that is false for this tree.
   **Fix:** confirm the authoritative version and either update the number or
   drop it, e.g. "Dev candidate uses schema 12 and is not a published release".
   Not blocking: the approved test does not assert this text, and `schema 12`
   itself is accurate (`server/sqlite-workspace-store.mjs:174`).

2. **minor — `AGENTS.md:3-9` (compression).** The rewrite removes "Reuse
   reviewed built-in surfaces before generating replacements" and the inline
   owner-only/draft/private-document sentences from the always-loaded file.
   Those remain documented (`docs/AGENT_GUIDE.md:61-70`,
   `docs/DOCUMENTS.md:161-165`, `docs/CONVERSATION_LIBRARY.md:73`,
   `docs/ARCHITECTURE.md:111`), and the guide is still pointed at for live
   workspace changes, so no security check or test is weakened.
   **Fix:** none required for this slice; if desired, one short bullet pointing
   owner-only boundaries at `docs/AGENT_GUIDE.md` would preserve the routing.

3. **minor — `AGENTS.md` size headroom.** 1481/1500 bytes leaves 19 bytes, so
   the next small edit will break the approved test.
   **Fix:** none required; note for future edits that the cap is hard.

## Test commands and results

- `git status --porcelain` — exit 0, clean before review (only the new review
  file exists afterwards).
- `wc -c AGENTS.md` — exit 0, `1481 AGENTS.md`.
- `timeout 900 node --test tests/agents-router.test.mjs` — exit 0; 4 tests,
  4 pass, 0 fail.
- `python3 -m unittest -v tests.test_orbit_bundle` — exit 0; 7 tests, 7 pass.
  (`pytest` is not installed, so the stdlib `unittest` runner was used; the file
  is a `unittest.TestCase` suite.)
- Base reconstruction: `patch -R -p1` of the supplied diff in `/tmp/wa3base` —
  exit 0, produced a 1938-byte base file; `node --test` against it — exit 1,
  tests 1/3/4 fail, test 2 passes, matching the supplied RED output.
- Archive parity: `tar -xzf … AGENTS.md` plus `sha256sum`/`diff -u` — exit 0,
  byte-identical (`b6056a1d…`, 1481 bytes).
- `timeout 900 npm run check` — exit 1, environment limitation: the runner
  aborts with `unshare: unshare failed: Operation not permitted` before running
  checks; no check was skipped or weakened by the PR.
- `timeout 1800 npm test` — exit 1, same `unshare` limitation.
- `command -v gitleaks` — not installed; gitleaks could not be re-run locally.

## Environment limitation

Node v24.21.0 is present, but unprivileged user namespaces are blocked and
`node_modules` is absent, so the repository's `npm run check`/`npm test`
wrappers cannot start here; the full 964-test suite and gitleaks were therefore
not independently re-run. The approved router test and the bundle parity suite
ran directly and passed. CI status and the full-suite NEW=0/FIXED=3 multiset at
the head were taken from the coordinator's supplied facts, not re-derived.
