# Experimental isolated checks

The optional **gVisor/runsc rootless systrap** backend executes only the existing
approved `node-test` check. It is off by default, offline (`--network=none`), and
uses the existing single serial job gate. It never falls back to trusted-host
execution. Dependency preparation (`npm ci --offline --ignore-scripts`) remains
trusted-host execution; native Hermes is also unchanged.

## Integration hooks

Parent service wiring (no new dependency):

```js
import {createWorkbenchSandboxProvider} from './workbench-sandbox-provider.mjs';
const sandboxProvider = createWorkbenchSandboxProvider({
  root: path.join(store.root, 'workbench-sandbox'), env: process.env,
});
// Pass this same object as sandboxProvider to both factories:
// createWorkbenchEnvironments({store, records, data, gate, sandboxProvider})
// createWorkbenchExecution({store, records, data, gate, environments, sandboxProvider})
```

The existing authenticated execution POST dispatch accepts
`{action:'provider_status',workspace_id,project_id}` with no extra request fields.
`execution_state` includes the same public `provider` capability. Do not add an
unauthenticated probe route. The factory performs no IO on construction.
`publicStatus()` is a bounded, IO-free display projection of the last authority
probe, with `display_only:true` and `checked_at` (or an unprobed/unavailable state).
Execution polling and `provider_status` use only this projection; they never hash
rootfs/runtime trees or launch probe processes. Approval, profile readiness,
execution-view validation and launch use fresh `describe()` probes, **never** the
display cache. Selecting a displayed backend is not execution authority.
The execution pane's automatic polling also skips fresh `candidate_get` readiness
probes for a selected gVisor task. Explicit refresh, selection and actions still
request fresh readiness, and admission independently revalidates it. Existing
trusted-host polling behavior is preserved.
`sandboxProvider.reconcile()` is read-only, reporting retained resources as
`resources_unknown`; admission also rechecks this fence before every launch.
Execution construction quarantines the existing shared gate for such orphan
resources. Operator reconciliation followed by fresh service construction is
required to release that provider quarantine; acknowledging a core job alone
does not assert termination of an unowned provider resource.
`close()` returns unknown owned resource IDs and disables further launches; it
does not guess termination or kill resources with lost ownership. Execution's
existing restart and cancellation fences continue to own durable job outcomes.
Parent should call provider `close()` **after** closing execution at shutdown.
Regenerate the execution/environment JSON contracts with the existing generator.

## Operator provisioning

No host provisioning is performed by Orbit. Supply an approved checksum-pinned
Linux runsc executable and an independent approved Node rootfs. Docker daemon
control, sudo, OS modification and server/owner terminal restarts are unnecessary
for source integration and outside this feature's authority.

Required environment variables:

| Variable | Meaning |
| --- | --- |
| `ORBIT_WORKBENCH_GVISOR_RUNSC` | Absolute executable regular-file path; not group/world writable |
| `ORBIT_WORKBENCH_GVISOR_RUNSC_SHA256` | Expected lowercase SHA-256 of runtime bytes |
| `ORBIT_WORKBENCH_GVISOR_RUNTIME_LAYOUT` | Required `gvisor-bin-v1`; unknown or standalone layouts are unsupported |
| `ORBIT_WORKBENCH_GVISOR_SIDECARS_SHA256` | Expected lowercase `sandboxTreeHash(adjacentGvisorBin, {allowSymlinks:false})` content digest |
| `ORBIT_WORKBENCH_GVISOR_ROOTFS` | Absolute rootfs directory, no symlink root |
| `ORBIT_WORKBENCH_GVISOR_IMAGE_DIGEST` | Expected lowercase content digest from `sandboxTreeHash(rootfs)` (not an OCI registry manifest digest) |
| `ORBIT_WORKBENCH_GVISOR_ROOT` | Optional absolute existing 0700 provider state root owned by service UID; defaults to the integration hook root |
| `ORBIT_WORKBENCH_GVISOR_PLATFORM` | Only `systrap`, default |
| `ORBIT_WORKBENCH_GVISOR_NETWORK` | Only `none`, default |

Rootfs must contain a real guest `/usr/local/bin/node`, its runtime libraries,
directories `/workspace`, `/tmp`, `/proc`, `/opt/orbit`, a regular placeholder
`/opt/orbit/runner.mjs`, and `/opt/orbit/node-version` containing the provisioned
Node version (`vMAJOR.MINOR.PATCH`). This version manifest is operator-declared;
the Node executable bytes and the complete bounded rootfs are hash-bound too.
Use a rootfs with no group/world-writable entries, devices or hardlinked files.
Rootfs symlink text is hashed without following links; Linux symlink mode 0777
does not make the symlink unsupported. Guest absolute symlinks resolve inside the
guest root. Host-resolved symlink components are forbidden in the rootfs root,
bind-mount target paths and pinned Node path, preventing provisioned links from
redirecting host mount/identity operations outside the approved rootfs.
The provider does not run a guest
binary on the host to determine its version. The gated guest journey must verify
the actual runtime before any deployment claims.

Modern upstream releases use an executable `runsc` plus an adjacent **`gvisor-bin/`**
payload directory. Keep that exact layout together; a launcher checksum alone
does not approve its runtime payload. The complete bounded sidecar tree is hashed
with modes and bytes, must be nonempty, and must have no symlinks, hardlinks,
devices or group/world-writable entries. Missing, changed or unverified payloads
fail readiness. Runtime payload digest and layout are part of provider identity
and approvals; cleanup re-verifies both launcher and payload before execution.
No `runsc install` or automatic payload download is performed. Standalone legacy
versions are currently rejected; permitting one requires a separately verified,
explicitly pinned known artifact layout, not merely absence of `gvisor-bin/`.
Upstream layout reference: [gVisor installation and legacy migration](https://gvisor.dev/docs/user_guide/install/).

The host probe checks runtime checksum/version and complete sidecar payload, rootfs digest, supported policy,
state permissions and actual unprivileged user-namespace creation. Capability is
configuration/admission evidence, not proof that a complete guest check succeeded.
Run the real test on the deployment host before claiming containment support.

## Identity, approval and compatibility

Profiles bind backend, complete public provider snapshot, runtime byte hash and
version, sidecar tree hash, runtime layout/payload digest, guest Node byte hash/version manifest, complete rootfs digest, image
digest, offline/rootless policy and bundle-spec digest. Preview approval rechecks
the exact snapshot; readiness, view creation and launch recheck it again. Changes
require fresh profile and acceptance approvals. Host Node/npm identity remains
separately bound for dependency preparation. Dependency hashes are checked before
and after launch. Jobs and evidence retain public provider/resource generation,
host boot identity and policy/spec identities; private runtime paths are omitted.

Trusted-host profiles remain record version 1. gVisor profiles are **record
version 2**, a deliberate backward writer fence; workspace/core schema remains
**12**. Authentic `6db86bd` environment code rejects record version 2 in
`profileContract`, before reading candidate/dependencies or constructing a host
execution view. Existing acceptance contracts bind the execution profile identity,
including its version, backend and provider digest. The focused regression loads
the entire historical module from that exact Git revision and proves rejection
through `verifyProfile`, `createExecutionView` and readiness. Historical running
jobs are handled by the existing restart-unknown fence, never replayed.

## Transport and limits

The host-pinned structured runner is mounted read-only at a fixed guest path;
only the immutable private execution view is mounted at `/workspace`. Rootfs and
source are read-only; `/tmp` is guest tmpfs. No owner source, HOME, `.runtime`,
terminal socket or Docker socket is mounted. FD3 donation uses
`run --pass-fd=3:3`; the existing bounded JSONL parser validates test evidence.
Guest stdout/stderr are log previews, never pass evidence.

The existing independent timeout supervisor, PID/kernel-start cancellation,
bounded previews/log retention and unknown-survival fence are reused. After
observed exit the provider performs bounded exact-ID `runsc --rootless
--platform=systrap --network=none --root=<same-per-check-root> delete --force` and
requires an empty per-check runtime state directory before declaring cleanup.
Cleanup failure is inconclusive/unknown, never a pass. Orphan state/bundles after
restart block new sandbox launches until an operator independently reconciles
the retained resources. They are never automatically replayed or deleted.
Back up the private `workbench-sandbox` state alongside Workbench runtime records.

**No disk quota, CPU quota or memory quota is advertised.** Tmpfs is not a disk
quota. `ORBIT_WORKBENCH_GVISOR_DISK_QUOTA` is explicitly unsupported and fails
readiness rather than making an unenforceable containment claim. The fixed wall
deadline and retained log cap are the existing command/recorder limits.

## Verification and current host blocker

Focused tests:

```sh
node --experimental-strip-types --test tests/workbench-sandbox*.test.mjs tests/workbench-environments.test.mjs
```

Operator-gated real fixture, using the provisioned variables above:

```sh
ORBIT_TEST_GVISOR_REAL=1 node --test tests/workbench-sandbox-real.test.mjs
```

This is a small real `node:test` fixture, not an arbitrary provider call. It checks
FD3 test evidence, source-write denial, absent Docker socket and runtime cleanup.
When gated on, unavailable capability **fails** the test rather than becoming a
mocked success. Further deployment acceptance must measure timeout/cancellation,
network/host-path denial and representative performance (target <=2x host fixture)
and a real isolated browser journey. Those claims are not established here.

On the implementation host, the actual command
`/usr/bin/unshare --user --map-root-user -- /usr/bin/true` failed with
`unshare: write failed /proc/self/uid_map: Operation not permitted`. A real rootless
guest therefore cannot be established in this service environment. runsc and an
approved Node rootfs are not provisioned. No Docker/sudo/provisioning workaround
was attempted. Real guest test remains gated; no guest success or browser visibility
is claimed.
