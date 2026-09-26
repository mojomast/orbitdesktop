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
| B: empty tests | **Reproduced and fixed in first slice.** Node test events use a bounded versioned channel, separate from project output. Empty/skipped-only/incomplete results cannot pass; required discovery files are pinned. |
| C: changed idempotent request | **Reproduced and fixed in first slice.** Canonical request fingerprint plus schema-7 scoped unique operation index; changed requests conflict, identical historical receipts survive consumed previews. |
| D: revoke/re-register | **Reproduced and fixed in first slice.** Durable authority generation fences old results; newly registered work succeeds. Permanent in-memory revoked flag removed. |
| E: finalization errors | **Reproduced and fixed in first slice.** Durable observed-result staging and atomic finalization; private journal/unhealthy admission on storage failure; DB-only finalization retry does not spawn. |

Execution red evidence: `/tmp/opencode/comet-hardening-execution-before.log`.
Lead independent first-slice verification: **56/56** at
`/tmp/opencode/comet-five-findings-lead.log`; normal-UI real subprocess fail/repair/
pass on default renderer at `/tmp/opencode/comet-five-findings-browser.log`.
Actual broker lease fix committed as `e46dc1e`. Later slice acceptance remains open.

Linked-worktree explicit-registration UI and provider now pass the docking browser
journey on a real disposable linked worktree (`/tmp/opencode/comet-linked-docking.log`).
Copy-on-write candidate batch changes and bounded multi-source question packets
are implemented; their full native-agent joined acceptance is pending.

Worker workflow incident: despite explicit restrictions, a worker ran checkout
`npm run check` and rebuilt `dist`. The worker was stopped. Lead restored the
verified baseline entrypoint/assets atomically from the preserved `78b6a8f` build,
SHA-256 `dc62f47d8dc59c798d2c032b38a98882e3838b8e208de15476d3aa5fa3e5d3ed`.
No service restart was performed. Subsequent build verification is lead-only in
explicit disposable directories.

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

## Integrated native loop (local evidence)

- `2d8393c`: additive schema 7 and unique operation receipts; conflicting schema-6
  receipts fail migration without deletion.
- `520a9af`: B–E, structured Node test events, immutable evidence annotations,
  complete required-check aggregation, copy-on-write candidate edits, offline
  dependency profiles and prompt durable `check_start` admission.
- `12e0980`: actual pinned Hermes/plugin/private authenticated bridge.
- `fdaf689`: ordinary pane-backed chat shares the exact-payload adapter, private
  durable request journal, original-configuration status and explicit recovery.

Actual Hermes: `d0288be5b3330d2442e3907185b8e9d0958297bb`, Python **3.14.3**,
OpenAI SDK **2.24.0**, pinned upstream `uv.lock`, deterministic numeric-loopback
OpenAI protocol fixture. Source-derived capabilities are in
`contracts/hermes-runtime-contract.json`; upstream has no invented version or
`session_continuation` flag. Advertised support, installation compatibility and
live-model acceptance are separate facts.

Lead reran the actual runtime/provider gate: **7/7**, no skips, at
`/tmp/opencode/comet-native-lead.log`; two independent actual runtimes reject
host-tool fallback at `/tmp/opencode/comet-native-runtime-lead.log`.

Normal-UI representative journey passes on **default and docking**, independently
repeated by the lead on Chromium **145.0.7632.6**:
`/tmp/opencode/comet-native-browser-{default,docking}.log`. It registers a real
linked worktree, prepares an approved locked local dependency, runs a real failing
Node assertion (not a missing-module failure), previews job + file + question,
grants native scope, receives six authenticated tool calls including candidate
patch/check/evidence, approves exact review, creates the private two-commit branch,
applies/returns a role-order recipe, and reloads durable results. Original source
remains wrong, reviewed artifact is repaired, dependency identity is unchanged,
zero page errors/terminal connections/external browser traffic/gateway run POSTs.

Legacy joined journeys still pass both renderers:
`/tmp/opencode/comet-legacy-journey-{default,docking}.log`. Live-PTY continuity passes
**94 transitions each**, revision/observed **53/53**, `browser_applied=true`, zero
page errors: `/tmp/opencode/comet-continuity-{default,docking}.log`. Independent
real-server recovery passes: `/tmp/opencode/comet-recovery-current.log`.

The first lead disposable full `npm run check` passed **449/450**, with only the
opt-in actual-runtime gate skipped (separately passed above), in
`/tmp/opencode/comet-hardening-check-tljbmyuo`; log
`/tmp/opencode/comet-hardening-full-check.log`. Final source verification follows
the remaining integration edits; these counts are a dated intermediate result.

### Deliberate limits and unpassed gates

Final lead disposable source gate: **456/456 Node tests**, zero skips/failures,
generated contracts, TypeScript and Vite build all passed with the actual Hermes
runtime enabled. Build: `/tmp/opencode/comet-agent-loop-final-67ias9tu`; log:
`/tmp/opencode/comet-agent-loop-final-check.log`. Python adapters/publisher/catalog/
portable parity: **55/55** passed. `9cb55a5` integrates the normal UI, packets,
linked roots, prepared profiles, reviewed branches and recipe controls. The
portable archive includes the native plugin and generated model-tool schema.
GitHub CI for the final published release commit is tracked separately below.

- No authorized paid/real model or live deployment was exercised. No credentials
  were borrowed, service restarted, owner runtime migrated or tokens rotated.
- The isolated model toolset denies host-tool fallback, but candidate test code
  executes under the service UID. There is no filesystem/network/process sandbox
  or enforced disk quota; integrity hashes are not adversarial attestation.
- The Node lane supports locked local tarballs, offline preparation and disabled
  lifecycle scripts; no online installs/arbitrary package commands/general build
  outputs. Required checks pin files/discovery and verifier/profile versions;
  this does not prove that arbitrary edited test code remains a sound test oracle.
- Integration publishes an independent private repository with captured-base and
  candidate commits, not original-repository ancestry. Original writes/merge,
  publication and deployment remain unavailable/separate. Branch/HEAD changes after
  review invalidate integration, including a different branch at the same commit.
- Recipes change role-prioritized window order with explicit revision CAS; they
  preserve geometry/IDs and do not implement a broader automatic layout designer.
- Retention ships inventory/dry-run protection, not automatic deletion. Incident,
  token and cost totals not supplied by a recorder/runtime remain unknown.
- Direct owner-UID tampering, disk exhaustion beyond retained artifact caps, and
  unsupported runtime/dependency environments remain explicit trust limits.
