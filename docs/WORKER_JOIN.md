# Pair a worker on one machine

Use join-only mode to give one worker a short-lived grant to report presence, check its installed client, or claim a synthetic data-only brief. See the [offline kit, enrolled transport and acceptance ledger](WORKER_JOIN_ACCEPTANCE.md) for the BundleBees queue and verification rehearsal. The launcher-backed [local workers](LOCAL_WORKERS.md) still serve ordinary executable attempts. The two modes are mutually exclusive.

## Rehearse without configuring Orbit

From the checkout with the existing Node dependencies installed:

```sh
node scripts/worker-join-rehearse.mjs --dry-run
node scripts/worker-join-rehearse.mjs --local
```

The dry run reads the standalone client, checks its bytes against the reviewed SHA-256 pin in `server/worker-join-artifact.mjs` and prints the size and digest. It writes nothing and makes no network request. The local run creates its own private temporary directory and ephemeral loopback listener, stages and **rechecks** the module before importing it, creates a throwaway owner identity and exercises the registered worker route. Neither command accepts a target machine, install path, image URL or credential. The existing host recipe's placeholder digest is not a published image or a trust anchor.

The JSON report distinguishes observed results from `not_run`. If a check fails, the command exits nonzero. A `digest_matched` review compares a worker report with an independent coordinator pin; it is **not host attestation**. The local rehearsal additionally verifies the staged file itself. The pin trusts the reviewed checkout; it is not a publisher signature.

## Owner inventory

For an **isolated test instance** enable `ORBIT_LOCAL_WORKERS=1` and `ORBIT_WORKER_JOIN_ONLY=1` together, bind `ORBIT_HOST=127.0.0.1`, leave `ORBIT_PUBLIC_ORIGIN` unset and set an explicit test `ORBIT_TOKEN`. Use a new private runtime. Do not switch modes on a running launcher with outstanding attempts. With only the first flag the existing launcher configuration and behavior apply. With both flags the existing `POST /api/local-workers` mount never initializes the launcher, board client, attempt ledger or polling timer. No new listener is mounted.

Open `/worker-join.html` at the numeric loopback origin of the built test instance. Unlock with that instance's owner token, label a worker and choose the optional digest scope. The returned JSON contains a worker ID, one-time code, expiry, protocol version and local Orbit URL. This is a QR-compatible payload; no QR image is rendered. Keep it private. **Hide invitation** clears the displayed copy; **Revoke** invalidates the invitation or paired worker at the coordinator. Lock clears the inventory in the tab. The UI does not persist owner credentials or invitations in web storage.

To join, pass the invitation JSON on **stdin** to the checked-in worker client. Specify the one exact **owned numeric loopback endpoint** that the worker may contact. For example, if your disposable instance is bound at port 4318:

```sh
node scripts/worker-join/client.mjs --loopback http://127.0.0.1:4318 < private-invitation.json
```

Keep any input file private; remove it after the exchange. Do not pass a secret in argv or a URL. `--once` performs one polling cycle and exits. Otherwise the client polls every five seconds, holds the worker token in memory, refreshes within the session limit, and exits on credential refusal. After a client restart, unknown exchange/refresh outcome, expiry, or revocation, obtain a new invitation; do not infer success from a dropped response. The owner can refresh the inventory, request a digest, compare a submitted report with the pin, and revoke a worker even when disconnected.

## What is authorized

| Authority | Operations | Limits |
| --- | --- | --- |
| Owner bearer **and exact browser Origin** | `invite`, `inventory`, `queue-verification`, `review-verification`, `revoke` | Direct loopback only. Board keys, plugin frames, workspace capabilities and worker bearers are not owner grants. |
| Single-use invite | `probe`, `pair` | Random 256-bit code, 15 minutes. The probe uses a fresh nonce and verifies a proof bound to the origin before the client sends a code. Exactly one exchange can commit. |
| Valid worker bearer | `refresh` | Rotates the old bearer immediately. Five minutes per token, at most one hour from pairing. No refresh after expiry. |
| `presence` | `heartbeat` | Only bounded platform and arch names. Last-seen is when the coordinator heard from the worker, not a guarantee of liveness. |
| `verify-client` | `claim`, `report` | Only this worker's preassigned `hash-installed-client` task and a 64-hex digest. No executable brief, shell, arguments, arbitrary path, free-form event, patch or evidence upload. |
| `sum-brief` | `claim-brief`, `status-brief`, `report-brief` | Only this worker's assigned immutable attempt and base revision. A report is one integer. Acceptance requires a trusted coordinator, signed lease, scanner and combined suite. |

The active coordinator uses its clock and a private `worker-join/registry.sqlite`. Exchange, rotation, task ownership checks, comparison and revocation take immediate SQLite transactions. Every request checks current authority. The DB contains credential hashes and bounded metadata; it is outside workspace layouts and checkpoints. An invitation appears once in its issue response; later inventory does not reveal secrets or verifiers. Revocation clears both hashes and atomically moves all queued, claimed or reported checks to `quarantined`. A late report, claim or refresh cannot revive them, even after reopen. Completed comparisons remain history. Expired workers cannot complete checks; revoke to quarantine outstanding records. No transport teardown or listener/mesh key rotation is implied.

The store requires a private POSIX service directory: owner-only `0700` directory, `0600` DB. Capacity is 256 worker records and 1,024 checks per runtime; at capacity it refuses new records rather than silently deleting history. Protect backups like the runtime: restoring an older credential DB can roll back revocations. Native Windows coordinator storage/ACL handling is unverified.

## Transport and acceptance boundaries

The worker considers HTTPS first, then plain HTTP loopback, then records tailcat and mesh as unavailable. At most **one explicitly supplied exact endpoint per supported kind** is eligible. Both kinds require `127.0.0.1` or `[::1]` and an explicit port. `--only https` or `--only loopback` restricts selection further. There is no host, DNS, port or subnet discovery, proxy environment handling or redirect following. A QR URL is a hint, never an owned-endpoint allowlist. Diagnostic observations contain only transport kinds and status. Keep ordinary HTTP on a trusted local machine; the probe is not a substitute for transport encryption. HTTPS uses normal certificate and hostname verification; the stock Orbit listener is HTTP, the HTTPS acceptance fixture owns a test CA and TLS listener.

| Draft | Evidence in this candidate | Not exercised / not shipped |
| --- | --- | --- |
| F15 | Concurrent single use, expiry, actual HTTP/TLS client, scoped rotation, authenticated polling and durable inventory | Public HTTPS relay, WebSocket/long-poll, arbitrary worker evidence, execution backend and disposable sandbox |
| F16 | Stable unavailable result; no native dependency or saved overlay material | tailcat binary, listener, handshake or NAT/DERP run. The proposed point-to-point tool promises no stable CLI/API/wire format and originally assumes the same person on both ends. Public DERP is rate-limited; self-hosted DERP is an option for a future approved integration. It is not a mesh. |
| F17 | Fixed selection order, explicitly owned endpoints only, rejected redirects, fallback and override, CLI test with trusted local TLS | Mesh enrollment, image supervisor, GPU/sandbox capability scheduling or image publication |
| F18 | Browser inventory/revocation, offline reconnect refused, unreviewed local reports quarantined | Cancelling a running BundleBees sandbox or invalidating another backend's leases |
| F19 | Verified client bytes, throwaway stage, exchange/replay/refresh, revoke/reopen and teardown; separate [OCI and accepted synthetic wave evidence](WORKER_JOIN_ACCEPTANCE.md) | No released worker image installed, second-machine rehearsal or live-host install. |

**Recorded local rehearsal (Linux, Node 22.19):** the 9,266-byte client matched SHA-256 `e8ae82a283a627d71b2f27e042ddcad4979fa66250ed7509703ea940eb78c3ee` before and after staging. The invitation lifetime was 900,000 ms; a second exchange was refused. There was no HTTPS endpoint in that rehearsal and the explicitly supplied HTTP loopback endpoint was selected. The first reported digest matched; the second report was quarantined on revoke. Claim, refresh and review were refused after reopening the DB. The temporary stage was removed and the listener closed. This receipt applies only to those bytes and that local run.

Run the isolated protocol and actual Orbit mount tests with `node --experimental-strip-types --test tests/worker-join*.test.mjs`. The TLS test uses the installed OpenSSL to create a throwaway certificate. With an already provisioned Chromium, `ORBIT_TEST_CHROMIUM=/path/to/chromium node --test tests/worker-join.browser.mjs` exercises the inventory page against a disposable instance of the route. No external service is required.
