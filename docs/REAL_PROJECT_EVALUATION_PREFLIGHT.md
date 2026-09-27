# Real Project Trial — Initial Unsupported-Environment Preflight

Evaluation date: **2026-09-26**.

## Outcome

**BLOCKED at the real-project dependency preflight.** The deployed UI rejected
the unmodified RouteTok dependency profile with HTTP 422 `unsupported`. No model
attempt, dependency installation, managed check, repair, or publication occurred
in this increment. This is evidence of an unsupported project type, not a failed
model repair or a failing test baseline. The milestone's success criteria are not
met.

The instruction to stop rather than bypass an unsupported environment was
followed. The subsequent real-model reliability cases were not substituted with
synthetic fixtures or results from previous milestones.

## Deployment and preflight

| Item | Observed value |
| --- | --- |
| URL | https://kimi.tailec998.ts.net:8801/ |
| Release | `orbit-7799b41` |
| Commit | `7799b41cbbaba731cd424dace0302600d463acf3` |
| Manifest integrity | `14aaf7d520d0023f91fb8ca8b1598a7d54eadf266b5ed6f1b2f6f60987d85135` |
| Schema | 8 |
| Server build | `880f253f4571e4506ff8c7a4df2b57a2c2bd4dd9705754880a6a46374c58d264` |
| Configured model/provider | `deepseek-flash`, DeepSeek |
| Endpoint | `https://api.deepseek.com/v1` |
| Hermes pin | `d0288be5b3330d2442e3907185b8e9d0958297bb` |
| Toolchain | Node 22.23.1; previously verified pinned Hermes Python 3.14.3 |

Health and owner-authenticated doctor were queried on the deployed instance.
Doctor reported configured native adapter, healthy dispatch, zero active
dispatches and zero active Workbench jobs. Read-only runtime records showed three
historical grants: failed before launch, budget-paused with runtime exited, and
completed with runtime exited. The three historical jobs were two failed checks
and one completed check; there were no submission records. No unknown grant or
pending job was ignored. No restart, release selection, schema migration, or
configuration change was performed.

The previous successful smoke and failed stale-contract attempt were retained.
The latter is not scored as a product regression here. This assignment authorizes
the named real-model evaluations, with bounded per-task consent; it is not an
unlimited retry-until-green budget. **Zero new model attempts were consumed.** The
one unused activation authorization was not used and is not treated as an
inference budget. No provider token or monetary ceiling is enforced by this
release's task budget.

## Real repository and isolated base

- Repository: owner-maintained **mojomast/routetok**, package `routetok` 0.1.0.
- Read-only source inspected: owner's `routetok-recovered` checkout, initially
  clean at `5982efe845f99528b2facde08991d951269ec4ab`.
- Disposable independent clone: `/tmp/opencode/orbit-real-project-routetok`,
  detached at that same commit. Created with `git clone --no-hardlinks`; owner
  worktree files and Git metadata were not used as a write target.
- 285 tracked files, including 59 `test/*.test.ts` files (recursive count).
- Normal tests: `npm test` invokes `tsx --test "test/**/*.test.ts"`.
- Normal type check: `tsc --noEmit`; build: `tsc` (generated `dist/` is used by
  the project's start command).
- Declared runtime: Node >=22.
- Normal development dependencies: `@types/node`, `tsx`, `typescript`.
- Lockfile: npm version 3, 32 HTTPS registry-resolved entries, no local-tarball
  entries. SHA-256:
  `2072045378d8d279ba288daeb183061b6bfa3a7eb667d1d22866110a76b4eef1`.

The clone's lockfile is byte-identical to the owner's. Both repositories remained
Git-clean at the final check. No `.env`, owner dependency tree, or production
credential was imported into the clone. No dependency download was attempted;
whether all required registry artifacts were already cached was not established.
The root manifest has no install lifecycle hook. Transitive lifecycle behavior
was not certified because the profile was rejected before installation.

Other accessible owner checkouts inspected at manifest level included Orbit and
COCS. Their normal locks likewise use registry dependencies and development
dependencies. None of the inspected npm repositories used the currently
supported all-local-tarball dependency lane. This is not a claim that every
repository anywhere on the host was inventoried.

**Repair issue and failing baseline: not selected/executed.** Environment
compatibility failed before a truthful repair task could be admitted. No typo or
artificial missing-module failure was introduced. The created UI task explicitly
said “Preflight only” and prohibited starting a worker before baseline execution.

## Deployed UI evidence

A fresh isolated Playwright browser context visited the deployed external origin.
The operator connected normally, registered the disposable repository, opened
the project, created a preflight task/candidate, selected its authority candidate,
and clicked **Preview offline Node environment**.

| Record | Identifier |
| --- | --- |
| Workspace | `b9f12dee-0e37-4f8f-bf1e-4743a3c13d15` |
| Project | `c56e46b4-928e-4836-8628-9cdb56eb2b5e` |
| Preflight task | `e0186c15-c950-442b-ae00-a85b1dccfee2` |
| Candidate, generation 1 | `0f07d77a-80c2-4557-9c70-b3196ac02792` |
| Candidate hash | `42fc44f7d955f53eb26d3e0766b03882cb056dfd28d96ef42abab2028b40c68d` |
| Acceptance version | 1 |
| Acceptance digest | `3956cd5a3e4dac5a0fa4cfc0f5da31c18c23ad8a358465bad368d3376aac5ea7` |

Registration, task creation, candidate preview and candidate creation returned
HTTP 200. Candidate capture reported `limited: false`. The UI then submitted:

```json
{
  "action": "profile_preview",
  "candidate_id": "0f07d77a-80c2-4557-9c70-b3196ac02792",
  "required_inputs": ["package-lock.json", "package.json"]
}
```

The authenticated request also carried the workspace/project IDs above. The
response was **HTTP 422**:

```json
{"ok": false, "code": "unsupported", "error": "unsupported"}
```

Private, credential-free response evidence is retained at
`/tmp/opencode/orbit-real-project-evidence/preflight.json`. The new project has
zero grants, jobs and evidence rows. No attempt, review or patch was created.

## Why the environment cannot be represented

The deployed `server/workbench-environments.mjs` was compared byte-for-byte with
the inspected source. Its admission rules:

1. Reject manifests with `devDependencies`, workspaces, optional/peer/bundled
   dependencies, or overrides.
2. Require every dependency lock entry to resolve to an approved candidate-local
   `file:*.tgz` with SHA-512 integrity.
3. Reject root install lifecycle hooks; permit only the bounded offline lane.

RouteTok violates rules 1 and 2 without any modification. Removing development
dependencies, rewriting the lock into tarballs, or attaching ambient packages
would not establish execution of its normal supported environment.

There is also a distinct check-contract mismatch: the shipped `node-test`
definition discovers JavaScript `.test.{js,cjs,mjs}`/JavaScript test-directory
files, not RouteTok's TypeScript suite, and does not execute its `tsx` package
script. A successful zero-test invocation would not meet this trial's criteria.
No such invocation was used as evidence. Full candidate capture is not proof
that its dependencies or tests can run.

## Agent, verification and explanation assessment

- Model calls/tool calls/checks/repairs: **0 / 0 / 0 / 0** for this increment.
- Attempt/grant, check/evidence, review/patch IDs: **not issued**.
- Attempt elapsed time: **N/A**, no worker launched.
- Owner interventions during an agent attempt: **N/A**.
- Final repaired candidate, patch hash and round-trip: **UNRUN**.
- No model final explanation exists to classify. Supported claims, inaccurate
  claims and omitted caveats: **NOT ASSESSED**, not scored as accurate by default.
- Reload/no-replay on a repaired real task: **UNRUN**. The prior smoke's result is
  historical and is not substituted for this evaluation.

## Reliability matrix

`BLOCKED` means a prerequisite was unsupported, not a failed model/security test.

| Case | Result | Notes |
| --- | --- | --- |
| Real dependency-bearing repair | **BLOCKED** | Normal dependency profile rejected in deployed UI; TypeScript runner also unsupported. |
| Bounded second repair | **NOT EXERCISED** | No repair worker admitted. |
| A: Insufficient authority | **BLOCKED / UNRUN** | Real-project success prerequisite unmet; no fresh real-model case launched. |
| B: Malicious context | **BLOCKED / UNRUN** | No malicious-context trial or disclosure occurred. |
| C: Cancellation | **BLOCKED / UNRUN** | No cancellation task launched; prior tests not counted. |
| D: Interrupted/unknown recovery | **BLOCKED / UNRUN** | No live fault or exact-release disposable recovery experiment run in this increment. |

## Observed product friction

### Major

1. **Common dependency setups are not supported.** Both development dependencies
   and ordinary registry locks are refused; this prevents trying the inspected
   owner repositories without changing their environment semantics.
2. **Check selection does not represent the project's actual tests.** The UI
   allows a Node-task/candidate to be created, while its handoff displays required
   checks as “none” for this TypeScript project. A user must understand discovery
   internals to identify that this cannot verify their suite.
3. **The dependency refusal is not actionable.** The API/UI says only
   `unsupported`; identifying the devDependency/local-tarball restrictions
   required reading server source. This blocks ordinary operator diagnosis.

### Minor

4. Dependency readiness is discovered only after registration, task creation,
   candidate creation, and selecting the separate authority candidate. An earlier
   compatibility summary would avoid creating records for an unexecutable task.

No Critical unsafe action was observed in this preflight; the dependency boundary
failed closed. No friction fixes were made during evaluation.

## Remaining boundaries and disposition

- Execution remains trusted same-UID host execution, not an OS sandbox.
- Only the previously authorized DeepSeek `deepseek-flash` configuration is in
  scope; no other provider/model was tried. Prior smoke success does not imply
  real-project reliability.
- Registry/devDependency-backed TypeScript projects are unsupported by the
  present dependency/check lane; this includes the selected RouteTok base.
- No token/cost accounting was added. No inference expenditure was incurred by
  this increment; wider runtime token/cost reporting remains unavailable.
- Original-repository integration was not attempted. The UI offers private Git
  integration, but ancestry-preserving integration for this real repository is
  **unverified**, not claimed unavailable or complete.
- Owner repository and isolated clone remained unchanged; historical Orbit
  attempts were not rewritten. No owner service was operated on, and no claim is
  made of independently auditing every unrelated instance.
- **Broader product reliability remains unproven.**

The concrete next decision is whether to authorize support for this repository's
locked development dependencies and TypeScript test command, or supply a real
repository already using the shipped local-tarball/JavaScript lane. This report
does not authorize or implement an environment expansion. Do not start the
reliability matrix by silently substituting synthetic/dependency-free projects.
