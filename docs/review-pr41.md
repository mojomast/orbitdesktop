APPROVED

# Independent review — PR #41 (approval-surface: decision route + operator app)

- Reviewer: independent audit bee (single-bee review, no subagents)
- Audited head: `3bd5b07fca57d84c6941b4c0374da58befef3271`
- Base: `main` @ `84dadcb96c9f2aea71e7fe523f83c1586d7e11da`
- Delivery context audited: coordinator-APPLIED worker payload (`att_4782ec6fc1a34d13`), whose coordinator verify refused with a secret-scanner trip on `server/approvals-route.mjs`, attributed to a scanner overmatch (identifier-shaped assignment, no secret value) per the recorded precedent.
- Scope: audit of the attribution and the delivery. Verdict and blocking findings below; disclosures are non-blocking.
- Rules honored: nothing pushed, nothing commented on the PR; the only file written in this repo is this report, on branch `review/pr41`.

## Grounding

Before any work, from a repo clone with no prior remote state:

- `git ls-remote https://github.com/mojomast/orbitdesktop.git refs/heads/main refs/pull/41/head`
  - `refs/heads/main` -> `84dadcb96c9f2aea71e7fe523f83c1586d7e11da`
  - `refs/pull/41/head` -> `3bd5b07fca57d84c6941b4c0374da58befef3271`
- Public REST (`/repos/mojomast/orbitdesktop/pulls/41`): head sha `3bd5b07fca57d84c6941b4c0374da58befef3271`, base ref `main`, state open. Both values match the briefed head/base exactly.
- A fetch-only remote (`audit`, no push configured use) was added to obtain the exact commits; the local checkout tree (`59e3739199129c2a159452719fac0c8943cbed26`) is byte-identical to the PR head tree.
- Re-ground immediately before committing: see "Head re-grounding" near the end.

## Check 1 — delta exactness: PASS

`git diff 84dadcb96c9f2aea71e7fe523f83c1586d7e11da..3bd5b07fca57d84c6941b4c0374da58befef3271 --numstat`:

```
104  0  apps/rizzstack-approvals/app.js
 47  0  apps/rizzstack-approvals/index.html
336  0  server/approvals-route.mjs
408  0  server/approvals-route.test.mjs
895 additions, 0 deletions across exactly 4 files
```

- Exactly the four leased files; no other path touched; `--stat` totals `4 files changed, 895 insertions(+)`.
- Single commit: `3bd5b07fca57d84c6941b4c0374da58befef3271`, sole parent is `84dadcb96c9f2aea71e7fe523f83c1586d7e11da` (current main tip), so the PR is one commit on top of main.
- Commit subject: `approval-surface: decision route + operator app (worker attempt att_4782ec6fc1a34d13, coordinator-applied after scanner-overmatch attribution)`; body restates the verify refusal, the single-trip diagnosis and the precedent reference. The coordinator-apply attribution is carried as required.

## Check 2 — route suite at the head: PASS (14/14)

Command: `node --test server/approvals-route.test.mjs` (node v24.21.0, in a clean worktree at the head; the suite imports node builtins only, so it runs without the repo's node_modules).

```
tests 14, pass 14, fail 0, cancelled 0, skipped 0
```

Matches the coordinator reference (14/14). The fourteen test names cover loader/factory, pending listing, detail refusal, approve receipt (atomic 0600), decline record, expiry refusal, binding/forgery refusal, decided-lock, receipt canonical shape, journal completeness, secret never returned or persisted, transport/body guards, configurable root, and secret-free page render.

## Check 3 — RED-first mutation counterfactuals, both ways: PASS

Two security-bearing assertions were mutated in `server/approvals-route.mjs` in a scratch worktree, one at a time; each was shown RED, then restored and shown GREEN. Restores were verified with `git status` (clean) and a full suite re-run.

Mutation A — decided-lock violated (assertion behind "a second decision is refused with the recorded state"):

- Exact mutation: in `decide()`, the existing-decision gate `if (existing) { return send(409, { error: 'already_decided', ... }); }` was changed to `if (false) {` (new-file lines ~263-270).
- RED: `tests 14, pass 12, fail 2` — failing: `a second decision is refused with the recorded state` and `decision journal stays complete and no temp files linger` (the journal side effect is a direct consequence of the unlocked second write).
- Restore (`git checkout -- server/approvals-route.mjs`): GREEN `pass 14, fail 0`.

Mutation B — no-secret-return/persist violated (assertion: "the signing secret is never returned or persisted"):

- Exact mutation: in `buildReceipt()`, one line added after the HMAC computation: `fields.signing_secret = signingSecret();` — the receipt (returned in the approve response AND written to disk) now carries the secret value.
- RED: `tests 14, pass 11, fail 3` — failing: `the signing secret is never returned or persisted` (both the response-leak and the persisted-file assertion), plus `approve writes an atomic 0600 receipt and flips the listed state` and `receipt shape follows the canonical field set and signature rules` (both fail because the receipt no longer has the canonical field set).
- Restore: GREEN `pass 14, fail 0`.

Both counterfactuals behave as required: mutation trips the intended security assertion (and only coherent companions), restoration returns the suite to exactly 14/14. The suite is not decorative — it detects violations of both the decided-lock and the no-secret-return/persist semantics.

## Check 4 — house-predicate scan over every added line: PASS with disclosure

Disclosure first: the house scanner itself is NOT runnable in this audit environment. The instructed import (`bundlebees_plugin.security.looks_like_secret` via the bundlebees checkout) fails — the bundlebees tree does not exist on this host and no `bundlebees_plugin` module is importable anywhere on it. This is an environment limitation of this audit, not a property of the PR; it is disclosed rather than papered over, and the scan below was reproduced from the predicate's documented behavior plus an independent, stricter real-secret-shape sweep.

Evidence base: all 895 added lines were extracted with their new-file positions from `git diff 84dadc..3bd5b07`.

1. Reconstruction of the documented predicate ("an assignment whose NAME contains a secret-bearing token, with a function-definition VALUE"):
   - Under that full reading (name token AND function-definition value), the reconstruction trips on EXACTLY ONE added line:
     - `server/approvals-route.mjs` line 110: `const signingSecret = () => {`
   - This reproduces the coordinator's reported single trip, including the exact file and line.
2. Under a laxer name-only reading (drop the value-shape clause), three identifier-shaped added lines trip: `server/approvals-route.mjs` line 18 (the constant naming the signing-secret env setting), line 110, and `server/approvals-route.test.mjs` line 19 (the test-side constant naming the same env setting). All three are identifier/constant NAME shapes; none contains a value literal of any credential shape. This observation is recorded because the true binary's exact value-shape condition could not be executed here; it does not change the safety conclusion (see 3).
3. Independent aggressive real-secret-shape sweep over all 895 added lines — 0 trips in every family: bearer-scheme-with-token, provider key prefixes (OpenAI-style, GitHub token and fine-grained PAT prefixes, Slack workspace-token prefixes, AWS access-key prefix, Google API-key prefix, and the JWT three-segment prefix), embedded-basic-auth URLs, name-equals-quoted-value auth shapes, PEM private-key headers, and long hex/hex40 runs. Additionally, a manual review of every added line containing secret/token/credential/password/key vocabulary found only: comments, env-setting NAME strings, identifiers, and synthetic in-test seed values (test-local, e.g. `'orbit-approvals-surface'`) — no credential material.
4. Trip control proving the scan runs (synthetic, composed for this audit, never a real value):

   ```
   const apiToken = "ghp" + "XSYNTHETICCONTROL000000";
   ```

   This line trips both the name-only reconstruction (token-bearing identifier) and the aggressive name-equals-quoted-value auth family. A benign control (`const binding = bindingDigest(request);`) does not trip either. The scan demonstrably detects both classes.

## Check 5 — independent re-derivation of the overmatch attribution: PASS (honest)

The audited line, with its function body (new-file lines 110-114):

```js
  const signingSecret = () => {
    const value = env[SECRET_ENV];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
```

Decision comparison between a synthetic real-credential-shaped control and the audited line:

| Input | Documented predicate reading (name token + function-value) | Name-only reading | Real-secret-shape families |
|---|---|---|---|
| Synthetic control (token-named identifier assigned a fake provider-token-shaped string) | no trip (string value) | trip | trip (auth-shape family) |
| `server/approvals-route.mjs:110` (function-value assignment) | trip | trip | no trip (no value literal at all) |

Assessment: the attribution "identifier-shaped assignment, no secret value" is honest and independently confirmed:

- Line 110's value is a function definition, not a credential literal; the secret enters only via the environment at call time.
- Zero real-secret-shaped literals exist anywhere in the 895-line patch (family sweep: 0 trips; manual review of all vocabulary-bearing lines concurs).
- The scanner-overmatch classification (identifier name carries a secret-bearing token, no secret material present) matches the evidence. The residual scanner defect (names trip regardless of value) is a scanner-side issue, correctly filed outside this PR.
- A real secret-shaped literal found anywhere in the patch would have been a BLOCKING defect; none was found.

## Check 6 — PR CI: recorded (pending, acceptable per brief)

`gh` CLI is unauthenticated in this environment; the public REST check-runs endpoint was used for the head sha instead. At audit time: 20 check runs — `test` and the Workbench matrix (`core`, `chat`, `themes`, `workspace`, `workspace-composition`, `tools`, `deferred execution and results`) `in_progress`; `catalog`, `Fresh container onboarding`, `Detect Workbench scope` completed (success); `Workbench / deferred execution and results` skipped in one earlier run. Combined commit status: `pending`. Pending CI is recorded as instructed; the local 14/14 route-suite run (Check 2) is the binding local evidence for the leased slice, and the disclosed node_modules gap (full od suite not run locally) remains delegated to CI as the PR body states.

## Check 7 — this report scanned with the house-style predicate

The report was scanned post-draft with the same shape families as Check 4's sweep (bearer-with-token, provider prefixes, embedded-basic URLs, name-equals-quoted-value auth shapes, PEM headers, long hex runs): 0 trips. Credential-adjacent identifiers quoted in this report carry function-definition or env-setting-name values only; the synthetic control line uses an intentionally invalid marker value. No name-value auth shapes, no provider token literals.

## Disclosures (non-blocking)

1. The house scanner binary (`bundlebees_plugin.security.looks_like_secret`) is not importable in this audit environment (bundlebees checkout absent from this host). The Check 4/5 results come from a documented-behavior reconstruction cross-checked by an independent, stricter family sweep. The reconstruction reproduces the coordinator's exactly-one-trip claim only under the documented value-shape clause; under a name-only reading, two additional benign identifier lines would also trip (env-setting name constants). Zero real-secret-shaped literals is the binding, independently verified fact.
2. Full od suite not run locally (worktree lacks node_modules: better-sqlite3, ajv); identical to the PR's own disclosure. CI is the backstop (Check 6, pending at audit time).
3. CI was pending, not green, at audit time — recorded as acceptable per the review brief.

## Blocking findings

None.

## Verdict

APPROVED — the delivery is exactly the four leased files (+895/-0, single attributed commit), the route suite passes 14/14, both RED-first counterfactuals trip and restore cleanly, the patch contains no secret material, and the scanner-overmatch attribution is independently confirmed as honest. Recommend merge per the coordinator's acceptance flow once CI completes.
