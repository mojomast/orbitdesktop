# ADR 005: Persistent registered-plugin activation hold

Status: implemented in the recovery-hold increment; verification is recorded in
`ORBIT_EVOLUTION_HANDOFF.md`.

## Problem

Disabling plugins inside layout state is useful but reversible by checkpoint restore,
full-state synchronization or a stale client. It cannot express an owner decision
that plugins must remain disabled until reviewed. Conflating disable with safe mode
also overstates what the current renderer and external-process architecture can do.

## Decision

Store a workspace-scoped `held` policy and monotonic generation separately from layout
and checkpoint state. Change it only through the owner-authenticated recovery route,
with explicit confirmation, revision checks and durable command identity. Entering
hold disables registered plugins atomically; release leaves them disabled. Validate
every committed candidate state while holding the SQLite write transaction, so no
concurrent browser/controller mutation can pass a stale policy check.

Policy transitions invalidate receipt replay across generations. The system returns
`RECOVERY_POLICY_CHANGED` instead of returning an obsolete layout snapshot that could
cause a browser to display an active plugin. Receipts are retained for audit, not
rewritten to pretend the original result was different. This is an explicit narrowing
of exact-response replay: it applies only within the same policy generation.

The policy survives SQLite-aware backup/restore and server restart. Database schema
versioning must prevent earlier writers from opening a store whose authority they do
not enforce. A legacy export cannot silently discard an active hold.

Upgrade requires stopping old server writers first. A schema-version check fences an
old binary when it opens the database; it cannot eject an already-open connection
from an old process. Do not do a rolling mixed-version deployment over one runtime.
Arrange session preservation before stopping any server with live terminals.

## Limits and consequences

- This is registered-plugin **activation policy**, not general safe boot, resource
  quarantine, network isolation or permission revocation.
- Public static app URLs, arbitrary browser panes, direct app tabs, disconnected
  frames and already-running host processes are outside this policy gate.
- A cached/offline normal frontend may render before it contacts the server. The
  independently served recovery console remains the recommended recovery entry point.
- Agents must not bypass the owner's policy using unregistered surfaces; future
  resource/grant enforcement must make more of that boundary technical rather than
  instructional.
- No terminal is killed or replaced to enter hold. Existing plugin-window split
  metadata and session identities must be preserved by the disable lifecycle.
- Layout/checkpoint undo never releases policy. Release itself is not authorization
  for a newly introduced external action or backend activation.
- This increment does not implement per-plugin quarantine, activation leases or the
  50-transition renderer continuity gate. Those remain separate workstreams.
