# Managed terminals (internal lifecycle provider)

`server/managed-terminal-provider.mjs` is an **internal, unwired, opt-in** lifecycle
provider for terminals that the provider itself creates. It is a real adapter for
`TerminalResourceRegistry` (`inspectExact({sessionName, signal})`), but it is **not** a
grant, consent UI, observation/read endpoint, input channel, storage schema, or a
replacement for the owner terminal WebSocket. No production route imports it. It does
not capture output, send input, attach to a viewer, or expose private bytes.

It exists to answer one narrow question honestly: *can a trusted provider prove that a
terminal resource it created is still the same server lifetime and the same shell
incarnation, using only side-effect-free inspection?* It manages only its own private
tmux socket and namespace; it cannot and does not retroactively trust a legacy or
otherwise unmanaged session. Existing unmanaged tmux terminals remain **unavailable for
grants**. See [registry](TERMINAL_RESOURCE_REGISTRY.md) and
[ADR 008](adr/008-resource-authority-boundaries.md).

## Scope and ownership

- The provider is given a dedicated fresh namespace `directory` and a random, private
  `socket`. `start()` claims that namespace exclusively, denies a pre-existing socket or
  tmux server, and refuses any namespace that already holds a provider lock or tmux
  socket files. The directory must be owned by the current UID, private (no group/
  other permissions), not itself a symlink, and contain no unrelated files. Two
  providers cannot claim the same namespace.
- The provider never touches the default `orbit-persistent` socket, never adopts or kills
  a pre-existing/user tmux session, and never starts a tmux server or shell during
  lookup. Cleanup only removes its own random socket/process and lock.
- `dispose()` kills only the server whose pid and epoch it created and still owns, and
  removes its own lock file; a replaced or foreign server is never killed. tmux may retain
  the stale socket file after `kill-server`, so `start()` requires a **fresh** namespace
  and refuses a directory that already contains a socket; a disposed namespace is not
  reused.
- A `createSession` that fails after it started the server makes a bounded best-effort
   attempt to stop that same owned server **only when its nonempty epoch marker matches**,
   using a cleanup budget independent of the inspection deadline. An absent marker is
   not ownership proof: another client can win the absent-server/startup race. A timeout
   before installing our marker can therefore leave private residue requiring explicit
   operator cleanup. If ownership cannot be established, it fails
  closed and leaves the process rather than force-killing an uncertain target.
- Sessions are created only through the explicit trusted `createSession({sessionName})`
  lifecycle call. A session created outside that call — even one whose tmux options mimic
  the provider's format — is never trusted because the provider keeps a separate
  in-memory ledger of exactly what it created.

Destructive cleanup also rechecks the current epoch/target markers in a tmux
`if-shell -F` command on the same command queue as the kill action. A successful
inspection in an earlier client is insufficient: the server could be replaced
between inspection and cleanup. Tests replace the real private server at that
boundary and require the foreign replacement to survive both close and dispose.

Lead verification replaced the unreliable skipped 1 ms test with a deterministic
timeout: stop only the owned fixture server with `SIGSTOP`, require a bounded
inspection failure and no lingering client, then resume it in `finally` and prove
the shell survived. Namespace, absent-marker startup race, and cleanup-replacement
regressions also pass. These are isolated fixtures, never owner processes.

## Provider-issued lifecycle tokens

On every server-lifetime start the provider rotates a random CSPRNG **`serverEpoch`**
(128-bit, 64-hex) and, per created session, a random CSPRNG **`shellInstance`**. These are
the identity fields returned to the registry; they are never derived from PIDs, counters
or timestamps. They are stored in the provider's in-memory ledger and mirrored as tmux
user options (`@orbit_managed_epoch`, `@orbit_managed_shell`,
`@orbit_managed_session_epoch`) on the provider's **own** private server only. Tokens are
not authentication and must never be logged, persisted in layouts/checkpoints/receipts,
or exposed to plugins, events, URLs or model channels.

## How continuity is checked (side-effect-free)

`inspectExact` resolves the exact pane recorded at creation, then:

1. Runs a single read-only tmux `display-message` probe (no create/attach/capture/mutation).
   An absent target or missing server is unavailable, never created.
2. Reads kernel identity (`/proc/<pid>/stat` starttime for the tmux server and pane
   process, plus boot id) as a **secondary** check that the same process incarnations
   remain.
3. Repeats the probe and the kernel read and requires the before/after values to be
   identical, so a concurrent respawn/restart between reads is denied rather than missed.
4. Requires the current `serverEpoch`, `shellInstance`, session/pane ids, server pid and
   kernel identity to all match the creation-time ledger entry.

Any mismatch, missing metadata, malformed output, foreign server, or uncertainty yields
`null`/a fixed typed error and drops the binding (conservatively invalidating all
bindings on a server-level anomaly). The adapter never surfaces raw tmux stderr.

## What invalidates a managed binding

- **`respawn-pane`** in the same pane (critical): tmux pane/session user options survive
  respawn, but the pane process and its kernel starttime change, so the provider denies.
  Option presence alone is never treated as proof of shell continuity.
- **Same-name session recreation** after `kill-session`: new shell incarnation (and, if
  the server also stopped, a new `serverEpoch`).
- **tmux server restart / counter reset**: the epoch option is lost with server memory,
  the server pid changes, and tmux may reuse `$0`/`%0`; all are denied. The provider also
  rotates `serverEpoch` and clears its ledger when it observes a fresh server lifetime.
- **External tamper or missing metadata**: a changed/removed `@orbit_managed_*` option, or
  malformed provider output, fails closed.
- **Provider/registry process restart**: the in-memory ledger and registry epoch are gone;
  old bindings are unusable and cannot be restored from any checkpoint, layout or backup.
- **Unknown/legacy sessions**: no ledger entry, so `inspectExact` returns `null` without
  touching tmux.

## Honest limitations

- This is a single-owner local system. It is **not** isolation from a malicious same-UID
  host process, compromised trusted code, or an owner shell. A same-UID process can read
  and copy tmux options or `/proc`; the provider cannot cryptographically prove
  incarnation against such an attacker. Tokens are identity metadata, not authorization.
- `/proc` starttime and pid are used as a **secondary** kernel continuity check, not as
  the identity token, and not as a formal ABA-proof guarantee. Preserved tmux options plus
  a matching PID/starttime are **not** cryptographic proof of shell incarnation. The
  guarantee is deliberately narrowed to: *fail closed unless `serverEpoch`, `shellInstance`,
  tmux markers and the observed kernel identity all agree, and continue to agree across a
  before/after re-read.* A theoretically perfect PID+starttime reuse coinciding with copied
  tokens/options, or a malicious same-UID process replaying them, is **not** defended
  against, and must not be described as proven incarnation.
- A true ABA-proof reference would need kernel `pidfd`-class liveness or an independent
  signed/high-water authority. This kernel (6.17) supports `pidfd_open`, but Node exposes
  no stable pidfd API (only the unsupported internal `process.binding`), and holding a
  `/proc/<pid>` file descriptor does not pin a process against PID reuse. The provider
  therefore does not claim pidfd semantics; anything that cannot be established fails
  closed. Linux `/proc` and a same-UID host are explicit platform limitations.
- The ledger is process-local and in-memory only. There is no cross-process exclusive
  provider broker, durable revocation, or anti-rollback fence; those remain prerequisites
  in ADR 008. Process restart invalidates everything by design.
- The provider manages only sessions it created. It provides no owner consent,
  authentication of a recipient, bounded read-only observation, output sanitization,
  durable generation/revocation, or final-release fencing. Those are **not** satisfied by
  a registry binding or a managed identity, and no grant/read path is opened here.

## API summary (internal)

```js
import { ManagedTerminalProvider } from '../server/managed-terminal-provider.mjs';

const provider = await ManagedTerminalProvider.create({ directory, socket });
const identity = await provider.createSession({ sessionName }); // {sessionName, serverEpoch, sessionId, paneId, shellInstance}
await provider.inspectExact({ sessionName, signal });           // {serverEpoch, sessionId, paneId, shellInstance} | null
await provider.closeSession({ sessionName });
await provider.dispose();
```

`ManagedTerminalProviderError.code` is one of `invalid_request`, `conflict`,
`unavailable`, `provider_error`, `timeout`, `busy`. Subprocess work is bounded and
output-limited, and errors never include raw provider stderr.

The adapter is exercised by `tests/managed-terminal-provider.test.mjs`, including a real
controlled registry link (`register`/`lookup`/`unregister`) across attach/detach, layout
change, respawn, same-name recreation, server restart and tamper events. This module is
**not wired to any live API** and must not be integrated without parent review.
