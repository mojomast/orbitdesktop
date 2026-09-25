# Dependency-ordered evolution plan

This is the working backlog, not a claim that phases are complete.

Current increment: strict legacy request/operation schemas, generated parity artifacts,
isolated green native tests, a JSON store boundary and independent layout recovery UI.
Phase A remains partial until actor/receipt/idempotency and migration semantics exist.
The early recovery UI does not satisfy Phase B's persistent safe-mode/revocation gate.

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
   and controlled-browser observations before input leases and managed jobs.
6. Enforce private-data/egress boundaries before broker capabilities. Deliver Project
   Inspector, revocation, scoped storage and audit evidence as one vertical slice.
7. Persistent exact drafts and exact-tested-hash promotion, then evidence-backed
   serial tasks. Parallel dispatch remains blocked on serial reliability checks.

Each gate requires focused tests, full regression checks, recovery/compatibility
instructions and evidence in the handoff. No deployment, main merge, service restart,
credential change or third-party host-code activation is authorized by this plan.
