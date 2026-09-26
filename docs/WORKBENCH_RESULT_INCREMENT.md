# Comet task results, provenance and safe handoff

## Inspected baseline

- Owner checkout `/home/mojo/projects/orbit`: clean, branch
  `testing/orbit-docking-managed-terminals`, SHA
  `5b31fdaba1f867eeaf7b0aa30438f096a55b54f6`.
- Baseline CI: Workbench `36220879554` and plugin `36220879552`, both successful.
- Existing native loop, schema 7, complete-check review, linked-root registration
  and dependency-bearing deterministic runtime acceptance are preserved baselines.
- Owner checkout, served assets and runtime are protected. Integration is in
  `/tmp/opencode/comet-next-integration`, branch `workbench/next-integration`.

## Exact workers and ownership

Local OpenCode agent aliases were read from the configured `agents` entries and
model availability confirmed through the supported model catalogue. No inferred
API IDs or substituted models:

| Requested worker | Configured agent / model | Worktree / branch | Session |
| --- | --- | --- | --- |
| GPT Sol | `worker-sol` / `openai/gpt-6-sol` | `/tmp/opencode/comet-next-sol` / `workbench/next-sol` | `ses_f21f90ef9ffeygExjQQpw0goLO` |
| GPT Luna | `worker-luna` / `openai/gpt-6-luna` | `/tmp/opencode/comet-next-luna` / `workbench/next-luna` | `ses_f21f8cbecffe7Sgqt5EvpMyGUW` |
| DeepSeek Flash | `worker-flash` / `deepseek/deepseek-flash` | `/tmp/opencode/comet-next-flash` / `workbench/next-flash` | `ses_f21f879f3ffeDgJ61tycNG77Rn` |

All four worktrees began at the same baseline. No recursive workers. Separate
temporary HOME/runtime/database/ports/tmux/browser/build directories are mandatory.
Heavy tests serialize on `/tmp/opencode/comet-next-heavy-check.lock`; source work
and lightweight checks remain parallel. Shared installed tooling is read-only.

- **Sol:** `hermes-plugin/workbench.py`, native runtime/service, execution/data,
  SQLite migrations and authoritative source contracts; new result/provenance
  tests. Environment provider changes only in wave 2.
- **Luna:** existing task authority/execution/workflow frontend modules, new
  task-result component, workflow/patch provider and dedicated UI/patch tests.
- **Flash:** CI, independent result-boundary/runtime/browser evaluation fixtures,
  isolated verification/release scripts and separation tests. Packaging source
  scripts are Flash-owned; archive regeneration is parent-owned.
- **Parent only:** `server/index.mjs`, `src/project-workbench.ts`,
  `src/agent-chat.ts`, `src/workspace-extensions.ts`, package/lockfiles,
  generation script/artifacts, portable archive and current capability docs.

## Schedule and gates

1. Parallel short contract audits: Sol proposes trusted result/provenance;
   Luna supplies consumer fields; Flash independently reproduces both findings
   and specifies observable acceptance. Commit the agreed baseline before
   dependent implementation, then fast-forward all clean lane branches.
2. Parallel result/provenance, handoff/result UI/patch, and independent harness /
   build isolation work. Integrate schema/contracts before consumers.
3. **Gate 1:** actual pinned Hermes, deterministic model, real private channel,
   SQLite/check providers, visible explanation/provenance and reload on both renderers.
4. Parallel representative-project extension, patch round-trip/review placement,
   evaluation/release tests. Cross-review by the other assigned models; owners fix.
5. **Gate 2:** final integrated regressions and separate disposable-release gate.
   Reports are not acceptance; all evidence binds its actual source/build/runtime.

Live-model evaluation is **unrun**: no product endpoint/model/budget authorization
has been supplied. Six case families will be prepared without paid inference.
Owner deployment/activation, runtime migration, token rotation and main merge are
not authorized. A disposable activation test does not authorize owner activation.

## Current status

All three requested aliases completed their initial contract/audit phase. Sol's
contract-only `b76b6e8` was integrated as `a1fa0f7`; the ownership ledger baseline
is `99a1990`. Worker branches received that shared contract baseline, preserving
Sol's original commit with a merge. All three implementation lanes are active.

Flash independently ran the actual pinned runtime baseline: existing fixture
7/7 passed; the new boundary regression produced one pass and two expected
failures (lost final response and owner attribution on native checks). The
separate two-attempt Python runtime test rejected the host terminal fallback.
Sanitized logs live under `/tmp/opencode/comet-next-flash-scratch/`.

The representative real-project selection is the maintained Orbit agent-profile
subproject at `5b31fda`: `server/agent-profiles.mjs` and its existing
`tests/agent-profiles.test.mjs`. This is an explicit selected subproject, not a
claim of full-repository executable capture. Its existing meaningful tests need
only Node built-ins. Selection/profile implementation and acceptance are pending.

The user explicitly chose **Keep live gate unrun**. No real-model trials will
be admitted in this increment. Deterministic acceptance remains a separate gate.
