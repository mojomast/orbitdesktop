# Dependency-ordered evolution plan

This is the working backlog, not a claim that phases are complete.

Current increment: strict legacy contracts, generated parity artifacts, isolated native
tests, SQLite transactional revisions/checkpoints/receipts/outbox, explicit retained-
original JSON import, private discovery and independent recovery UI. The recovery-hold
increment adds owner-only persistent registered-plugin activation policy outside layout
undo. Layout remains v1; normalized surface/placement migration is still outstanding.
Indexed bundles, dry-run retention planning and bounded authenticated metadata event
polling are now implemented. Destructive bundle cleanup and SSE/push delivery are not.
Connected DOM reconciliation and isolated import regressions are now implemented;
see [runtime continuity](RUNTIME_CONTINUITY.md) for the browser evidence and capability
limits. Isolated pinned docking adapters now pass iframe continuity and pointer-resize
probes, but selection awaits Orbit model/PTY/spatial integration and accessibility
evidence; see [comparison](DOCKING_EVALUATION.md). Next: an opt-in adapter/runtime
integration spike and accessible placement commands, followed by broader resource/grant
authority. Registered-plugin hold is not full
safe boot or revocation and does not complete Phase B's gate.

1. Finish isolated baseline and fix adapter batch parity. Establish strict versioned
   JSON Schemas, error taxonomy, byte budgets and generated/parity-tested adapters.
2. Introduce WorkspaceStore with existing behavior tests. Select a nonexperimental
   SQLite binding compatible with Node >=22.12 and distribution targets. Implement
   transactional revision/checkpoint/receipt/outbox writes, deterministic migration
   with retained v1 originals, and stale-client downgrade protection.
3. Build independent authenticated recovery UI and persistent safe-mode enforcement;
   test actual broken renderer/plugin fixtures. Add indexed immutable bundle records
   and bounded authenticated event replay, retaining polling compatibility.
4. Measure stable connected surface hosts against exact licensed docking candidates.
   Extract runtime ownership only with actual iframe/PTY/draft continuity tests;
   then accessible tabs/docking/recipes and project roles.
5. Separate grants from reversible state. Implement read-only exact-resource terminal
   and controlled-browser observations before input leases and managed jobs. The
   [resource authority proposal](RESOURCE_AUTHORITY_PROPOSAL.md) audits current routes
   and [ADR 008](adr/008-resource-authority-boundaries.md) scopes the first owner-only
   observation gate. Isolated tmux identity probes pass, but trusted resource
   registration, policy approval and implementation remain; no grants exist yet.
6. Enforce private-data/egress boundaries before broker capabilities. Deliver Project
   Inspector, revocation, scoped storage and audit evidence as one vertical slice.
7. Persistent exact drafts and exact-tested-hash promotion, then evidence-backed
   serial tasks. Parallel dispatch remains blocked on serial reliability checks.

Each gate requires focused tests, full regression checks, recovery/compatibility
instructions and evidence in the handoff. No deployment, main merge, service restart,
credential change or third-party host-code activation is authorized by this plan.
