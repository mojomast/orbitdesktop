# Terminal resource registry and managed-shell identity

`server/terminal-resource-registry.mjs` remains a process-local identity primitive.
It does not itself issue grants, read output, send input, attach a viewer or provide
cross-process exclusivity. A pane ID is a placement hint, never identity proof or a
bearer credential. Registry lookup rechecks the exact registered provider resource
and fails closed if missing, replaced, revoked or uncertain. Registrations and its
random process epoch are lost on restart.

The owner-facing managed-terminal integration uses an attach-mode provider, a
separate durable continuity ledger and a process-local grant broker. Its trusted
owner bearer/Origin route is `POST /api/managed-terminals`, reached from **Managed…**
in the existing terminal PaneView toolbar. It can explicitly adopt an **existing**
`pane-<UUID>` tmux session only after owner confirmation. Status and reconcile are
side-effect-free inspections: neither adopts nor captures. A finite observe lease
permits explicit bounded one-shot reads; a finite input lease permits individually
confirmed literal-only sends with operation IDs. Pending and changed-payload
replays are refused; an exact applied replay returns its result without resending.
Operation receipts are never compacted: at journal capacity, a new ID receives
`journal_full` before any send. Each grant advertises a per-lease expiration;
enforcement uses a monotonic deadline. Revoking one lease fences that lease's
in-flight work without revoking unrelated leases.
No output or grant is delivered through model, plugin, event or receipt channels.
See [managed terminals](MANAGED_TERMINALS.md) for the operator workflow.

The provider checks exact tmux server/session/pane markers plus Linux kernel
PID/starttime and boot identity before and after each action. A shell respawn,
same-name recreation, tmux restart, absent marker, altered incarnation or uncertain
probe fails closed and requires fresh consent. Revocation fences in-flight work;
already-delivered bytes cannot be recalled. Grants never restore after process
restart. Continuity metadata persists separately in a 0700 directory / 0600 file;
it is not a grant and cannot authorize output by itself. There is no auto-capture,
 auto-adopt, auto-respawn or auto-kill.

An explicit owner-consented `release` recovery request includes workspace/pane,
current revision, `consent: true`, and the exact acknowledgement
`does not kill shell; next explicit Connect may create a NEW shell if missing`.
It revokes the binding and leases and removes continuity metadata; for a live
target, it clears only its own adoption markers under an exact identity check.
Foreign markers prevent release. Release never kills or creates a process; a
subsequent explicit Connect may create a NEW shell only if the target is missing.
When ownership cannot be proven, deliberately close the pane and add a new
terminal. Layout transitions do not change pane IDs. A private `.initialized`
sentinel persists after ledger initialization: missing ledger plus sentinel is
loss and fails closed; missing both is a fresh empty install. The directory and
ledger/sentinel files use modes 0700 and 0600 respectively.

This remains a single-owner/same-UID host design. It has no rolling-upgrade
guarantee, reboot supervision, cross-process broker, same-UID isolation or
pidfd-proof incarnation. PIDs and starttimes are secondary checks, not an
ABA-proof authority; another same-UID process can tamper with tmux state.
The older private-namespace lifecycle provider and the process-local registry
are separate primitives, not alternate owner APIs. See
[ADR 008](adr/008-resource-authority-boundaries.md).
