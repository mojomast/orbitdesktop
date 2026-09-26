# Workbench agent loop — current increment

Starting checkout: `c40cbe9e9cfec021824dfd064e75a7d8a195a820`, branch
`testing/orbit-docking-managed-terminals`, clean at inspection. Actual baseline
CI: Workbench `36215190423` and plugin `36215190350` both passed. Baseline has
owner-mediated candidates, one-shot context and synthetic-gateway acceptance;
native runtime tools, linked worktrees and integration are not yet delivered.

## Review findings

| Finding | Current evidence |
| --- | --- |
| A: terminal lease syntax | **Reproduced.** Actual disposable tmux → adopted broker → 32-hex observe lease → owner HTTP context capture returned 400. Canonical terminal-owned lease schema fixes the boundary; capture/preview now pass. Revoked/expired/foreign/workspace/replaced-shell cases reject. Logs `/tmp/opencode/comet-lease-{before,after}.log`. |
| B: empty tests | Under reproduction with actual subprocess runner; source currently equates exit 0 with pass. |
| C: changed idempotent request | Under reproduction; source returns by op_id without request comparison. |
| D: revoke/re-register | Under reproduction; source retains project ID in a permanent in-memory revoked map. |
| E: finalization errors | Under fault-injection reproduction; evidence/task writes occur outside cleanup transaction. |

## Ordered implementation

1. Real boundary regressions and fixes A–E; canonical IDs, structured test outcomes,
   unique request identity, durable authority generations and finalization recovery.
2. Actual pinned Hermes plugin/runtime with authenticated per-attempt binding and
   deterministic local model protocol; no owner credentials or external spending.
3. Explicit linked-worktree registration and dependency-aware execution inputs.
4. Multi-resource question/context, native candidate changes, complete-check review.
5. Explicit recipes/integration, operational budgets/retention and release matrix.

At most three direct development workers, no recursive delegation. Lead owns
contracts/migrations, registration/routes/UI integration and independent checks.
Execution worker owns checks/execution and findings tests. Native worker owns new
bridge/plugin/runtime fixture. Workflow worker owns candidate provider, then
linked-worktree provider (sequential ownership handoff). No worker commits.

All builds/runtimes are disposable under `/tmp/opencode`; no owner service restart,
deployment, runtime migration, credential rotation or main merge is authorized.
The real-model smoke gate is separate from real-runtime/simulated-model acceptance.
