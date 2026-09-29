# Managed terminals (owner controls)

The terminal pane's **Managed…** toolbar control opens an owner-only dialog. It uses
`POST /api/managed-terminals` with the Orbit bearer token and exact Origin/Host checks.
Only the trusted owner page has this route: no model, plugin, workspace event or
receipt receives output, input authority, identity tokens or shell metadata.
The existing shell WebSocket is independent. Opening the dialog, connecting a shell,
reloading the page, and checking status/reconciling do **not** auto-capture output.

## Workflow

1. Connect an already existing terminal pane shell if needed. Choose **Reconcile**
   to inspect its current status without reading output or adopting it.
2. Choose **Adopt…** and explicitly confirm. Adoption records continuity metadata
   for that exact existing pane; it does not create, respawn or kill a shell.
3. Select an `observe` or `input` scope and explicitly **Grant lease**. Grants are
    finite and bound to that workspace and exact shell identity. Explicit owner
    consent is required for adoption, observation and input.
    The UI uses a 60-second lease. API limits are 5 seconds minimum, 5 minutes
    maximum for observation and 2 minutes for input; at most 32 leases and 16
    adopted resources are held by one broker. Each lease advertises its own
    expiration from its grant time; enforcement uses a monotonic deadline.
4. With an active observe lease, **Read output once** makes one bounded read of
   up to 2,000 lines / 65,536 bytes. Its result appears in a labelled, copyable,
   read-only **untrusted output** area. A lease does not cause periodic capture.
5. With an active input lease, enter literal text, confirm that individual send,
   acknowledge newlines separately when present, and choose **Send literal text**.
   Control/escape characters are rejected; there is no implicit Enter. Every send
   uses a fresh operation ID. Pending IDs and changed-payload replays are refused;
    an exact already-applied ID returns its recorded result without another send.
    Receipts are never compacted (that could permit duplicate sends). At journal
    capacity, new operation IDs fail closed with `journal_full` before dispatch.
   The dialog displays the operation ID and applied result. If an outcome is
   indeterminate, do not create another ID for the same send.
6. **Revoke lease** fences further work on that lease and clears displayed output.
   Revoking one lease does not interrupt unrelated leases. Revocation fences
   in-flight work on its lease but cannot retract bytes already delivered to the
   owner browser or terminal.

For recovery, the owner can explicitly request `release` for the pane with its
current `base_revision`, `consent: true`, and this exact `acknowledge` text:
`does not kill shell; next explicit Connect may create a NEW shell if missing`.
Release removes the continuity record, binding and grants. If the session exists
and still bears the recorded adoption markers, it clears those markers only under
an exact identity check; unknown/foreign markers are refused. If the target is
missing, release removes metadata only. **Release never kills or creates a shell.**
A later explicit Connect may create a NEW shell only when the target is missing.
When ownership cannot be proven, close the pane deliberately and add a new
terminal; pane IDs do not change merely because of layout transitions.

The client fetches the current workspace revision immediately before adoption,
grant, observe, or input actions. The HTTP contract requires explicit consent for
adoption/grants, and `confirm: true` for each input (plus `confirm_newline: true`
when needed). Unknown request fields and non-Bearer authentication are rejected;
responses are `no-store`. The broker checks workspace membership and shell identity before
and after each action. Capture and input recheck the grant immediately before
dispatch; tmux evaluates the expected markers/session/pane/PIDs in the **same
command queue** as capture/input. A send already dispatched may finish after a
revocation; its effects cannot be recalled. Missing/stale identity fails closed and requires fresh owner
consent. Browser output is never interpreted as instructions; treat it as arbitrary
shell data. On an identity change or unavailable result, the dialog discards its
lease and displayed output.

## Persistence and limitations

Continuity metadata is maintained outside workspace layouts/checkpoints in a
private directory (0700) and file (0600). Grants are **never restored** on server
restart; restart invalidates them even if continuity metadata persists. The
attach-mode provider verifies exact tmux markers and Linux `/proc` identities,
including reinspection around actions. It does not silently adopt, start, respawn
or kill owner sessions. The older private lifecycle provider remains distinct.

Startup performs metadata-only reconciliation for persisted adopted workspace
references. Unmanaged panes remain candidates for explicit owner adoption, not
automatic authority. A managed pane reconnects using an identity-conditional
**attach-only** tmux command; it never falls back to `new-session -A` when its
recorded shell is missing or changed. After browser reload, unlock and reconnect
the terminal normally: a verified surviving shell retains its PID and variables.
Unknown pre-existing adoption markers are not overwritten. A private 0600
`.initialized` sentinel distinguishes a fresh installation (no ledger and no
sentinel) from a lost ledger (sentinel present, ledger missing). Loss or unreadable
identity metadata fails closed rather than creating a replacement shell.

Local real-server Chromium tests exercise explicit adoption/read/input/revoke,
and reload with fresh output proving the same shell variable and PID, plus stale
identity after deliberate fixture respawn. Real-tmux tests cover recovery of the
private ledger, guarded attachment, credential stripping, and a marker changed
between inspection and dispatch. Tailnet is optional and its deployment-specific
acceptance remains delegated to Hermes; these tests do not access owner terminals.

This is a single-owner, same-UID service. It does not claim isolation from another
same-UID process, pidfd-proof shell incarnation, cross-process broker/fencing,
rolling upgrade safety or reboot supervision. Shells do not survive a host reboot.
Kernel PID/starttime checks and random markers narrow uncertainty but are not
cryptographic proof against a malicious same-UID process. Partial shell-side
effects cannot be undone after an interrupted send. Keep private output out of
logs, exports, plugins, model context and screenshots. See
[resource registry](TERMINAL_RESOURCE_REGISTRY.md) for the lower-level identity
primitive and [ADR 008](adr/008-resource-authority-boundaries.md) for boundaries.
