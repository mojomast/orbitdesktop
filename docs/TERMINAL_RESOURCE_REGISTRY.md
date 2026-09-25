# Terminal resource registry (internal prerequisite)

`server/terminal-resource-registry.mjs` is an **unwired, process-local** identity
registry. It is not a grant ledger, an observation endpoint, a consent UI, or a
replacement for the existing owner terminal WebSocket. No production route imports
it. It does not capture output/history, send input, create a PTY, or attach to a
terminal. Merely placing a terminal pane in a layout does not register or authorize
its underlying shell.

## Boundary and lifetime

A trusted operator supplies the workspace and provider namespace, and explicitly
registers an **already existing, exact** terminal resource. The registry keeps a
random process-lifetime epoch and an unpredictable, per-registration binding token;
the layout pane ID is only a placement hint, not a resource key or a bearer
credential. Resolution requires the same trusted owner/workspace/provider/resource
scope and current binding. Foreign, malformed, missing, replaced, revoked, or
uncertain resources fail closed before any private data could be read. Lookup is
identity-only and never starts a missing tmux server or shell. A disconnected tmux
viewer or layout move does not by itself replace the shell. Explicit unregister,
provider invalidation, or registry replacement makes old bindings unusable;
fresh registration does not revive an old token.

The exported `TerminalResourceRegistry` constructor accepts trusted `ownerId`,
`workspaceId`, canonical `providerId`, and an adapter implementing
`inspectExact({sessionName, signal})`. `register({sessionName})` reserves that name
and verifies its existing identity before returning a frozen binding;
`lookup(binding)` rechecks it and returns the binding or `null`. `revoke(binding)`
and `unregister(binding)` remove that exact binding; `invalidate()` clears all
bindings and rotates the epoch, including during in-flight inspections. Competing
registries **within one Node process** cannot reserve the same provider/session
name concurrently. Provider IDs must identify the exact namespace, not a generic
provider type; cross-process exclusivity is not implemented. Fixed error codes
distinguish invalid requests, conflicts, unavailability, provider failure, timeout
and capacity saturation without returning provider stderr. Inspection is limited
to four concurrent operations and a one-second deadline by default (configurable
within hard caps of 16 operations and five seconds); an adapter that ignores abort
continues to occupy its slot until it actually settles.

The registry is intentionally **not persisted**. Creating a new registry on server
restart rotates its epoch and loses all registrations. It cannot restore a token
from a checkpoint, layout, database backup, or an earlier process. Independent
processes do not share its memory or establish each other's ownership. Deploying a
multi-process broker would require an exclusive provider lifetime owner and a
separately reviewed cross-process fence; this module alone cannot provide one.

## Provider proof requirement

An identity adapter must inspect an existing exact provider target without attach,
create, capture, or mutation during lookup. Every successful inspection must prove
the same **provider server lifetime** and **shell incarnation** as registration,
in addition to exact session/pane identity. Missing and ambiguous responses are
unavailable, not invitations to call `LocalHostProvider.spawn` or
`captureHistory`. Provider errors/timeouts deny access; raw provider stderr is not
exposed as diagnostic text. Registration is a trusted lifecycle operation, not
something a controller, plugin, or arbitrary request may initiate.

The existing tmux observations (`session_id`, `pane_id`, server PID and
second-resolution creation times) are **not** a sufficient proof: tmux counters
can reset when the server restarts, PIDs/timestamps can repeat, and `respawn-pane`
can retain the pane ID while replacing its shell. A future real-tmux provider must
own or otherwise reliably verify a server-lifetime token and a shell-instance
token, fence competing registrars without overwriting another owner's options,
and treat missing/replaced metadata as unavailable. A fake adapter proving its
contract in unit tests is not evidence that an unmanaged existing tmux session
has these properties. Until that independent provider lifecycle integration is
proven, existing unmanaged tmux terminals remain **unavailable for grants**.

This is a single-owner local system, not isolation from a malicious same-UID host
process, compromised trusted code, or an owner shell. Random binding tokens are
not subject authentication or permission grants. Do not log or expose them through
layout, workspace events, generic receipts, URLs, or plugins.

## Integration prerequisites (not implemented)

Before any terminal disclosure, a trusted production lifecycle must register only
an already existing exact session and invalidate it on shell respawn, session
replacement, tmux-server restart, uncertain provider state, and server restart.
The broker must separately authenticate the recipient, obtain explicit owner
consent for a finite, bounded read-only operation, enforce independent durable
generation/revocation and final-release fencing across processes, reverify resource
identity at capture and release, bound and sanitize output, and keep private bytes
out of layout, receipts, events, plugin/model channels and logs. See
[ADR 008](adr/008-resource-authority-boundaries.md). None of those requirements
are satisfied by possession of a registry binding or pane ID; no grant API,
observation/storage schema migration, or private-output path is provided here.
