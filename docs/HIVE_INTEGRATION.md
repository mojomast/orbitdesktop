# Hive overview: exact-pane owner read

This candidate adds a narrow host/guest integration in `src/hive-host.ts` and
`apps/rizzstack-hive/host-client.js`. Open the **exact published release** as an
Orbit app with empty config, unlock Orbit, and choose **Share read-only overview
with this Hive pane** in the host chrome. Unlocking, enabling a plugin, changing
demo scenarios or clicking Refresh in an ungranted frame cannot start a read.
Stop sharing, change source, or close the pane to release the grant. After a
frame navigation/remount the owner must establish a new session. No registration
is enabled by default. Demo data is an explicit independent selection.

* Identity is the exact registry-verified, content-addressed HTML entry in the
  built frontend, not the name of a catalog entry. Other hashes, aliases,
  config, query parameters, origins and documents do not qualify. The initial
  document gets a random rendezvous fragment, **not a bearer**: it is never
  persisted to the layout, and grants no read by itself. It offers one
  `MessagePort` to the exact parent origin. Orbit checks the rendezvous, `null`
  source origin and exact iframe WindowProxy and never broadcasts a projection.
  Subsequent loads do not inherit the port. The frame is scripts-only and the
  client installs `connect-src 'none'` before offering the port.
* Each enabled read revalidates the in-memory Orbit credential with the existing
  `/api/auth` check, then the host GETs
  `/api/ext/rizzstack-observatory/snapshot/snapshot` with the owner bearer. The
  extension proxy checks that bearer plus same-origin request metadata, forwards
  only the declared path to the loopback collector, and injects the server-side
  collector credential. Redirects, caching and owner-selected query parameters
  are not used. Workflow's qualified collector serves `/snapshot` (also `/`),
  **not** `/snapshot.json`. Only the server holds the upstream read credential.
  No second collector is started. The host caps/validates the response and runs
  the same reviewed `project(snapshot,{now})` adapter locally before delivering
  the bounded view.
  Errors and raw source records do not leave the host. A credential rejection
  revokes the grant and replaces the entire previously granted document (including
  hidden register rows, search text and accessibility announcements); interrupted transport is labeled
  unavailable/disconnected, never silently replaced by a demo. Read starts
  are spaced by at least 30 s per granted pane, with a 10 s deadline. Hidden
  tabs pause reads. The guest marks a silent connection disconnected after 65 s.
* Only an exact attempt or job from the latest successfully transferred view is
  a navigation target. The existing `openRailsShell` opens with that public
  selector, then waits for a separate **Inspect history** action before reading.
  Returning to Hive uses the same document port. No Rails query data, authority,
  stream, signer, writer, arbitrary URL or generic API is granted to Hive.

**Legacy route perimeter:** `serveObsSnapshot` remains in this Orbit base for
the legacy standalone Observatory app only. It is a CORS-enabled proxy which
injects the collector credential and does **not** enforce an Orbit owner check
itself. The Hive host no longer uses it; it reads through the
owner-authenticated extension proxy described above. Do not enable the legacy
route on an untrusted network or claim it is an owner-authenticated service
perimeter. Removing it requires separate coordinated review once the legacy
standalone app is verified and retired.

## Fixture proof and release packaging

### Companion evidence and read admission

The trusted host runs the same monotonic snapshot admission rule as the pane. Starting a new read clears the previous selectors and pending offer. The host sends a valid projection, then its positive transport acknowledgement and a document-local read sequence. Only a matching acceptance reply on that document's port for the still-current `(sequence, generatedAt)` enables companion enrollment and Rails selector navigation. Older or same-time conflicting projections never produce an offer. Consent to the overview does not read companion files: the operator separately clicks **Share enrolled evidence with this pane**. See [Mission control](HIVE_MISSION_CONTROL.md) for enrollment and [the browser proof](HIVE_MISSION_QA.md) for the full journey. With no enrollment the original overview works as before.

The independent companion reader serializes I/O. A busy reader can delay another pane; the pane distinguishes a delayed retry from an empty validated report. Neither a busy reader nor a withdrawn grant substitutes demonstration data. Stopping sharing discards the previously granted document.

With local project dependencies, Node ≥22.12, Chromium, and the candidate
Workflow tree adjacent to the Orbit checkout (or `HIVE_WORKFLOW_TEST_ROOT`):

```sh
node --test tests/hive-host.test.mjs
CHROMIUM_EXECUTABLE=/path/to/chromium python3 tests/hive-integration.browser.py
```

The latter builds a scratch frontend (or takes an **explicit matching**
`HIVE_TEST_DIST`), publishes the actual static files with `plugin_publish.py`,
starts a disposable loopback Orbit with a fresh runtime/home and synthetic
credentials, and opens actual Windows-layout browser panes in Chromium. A
temporary ledger/real R12 reader supplies an independently read origin event
ID. The actual Workflow collector HTTP handler gets a pure synthetic snapshot
provider: no production probes run. `tests/hive-integration.remap.mjs`,
preloaded **only in that disposable Node process**, redirects its fixed numeric
upstream port 8787 to an ephemeral loopback fixture port, preserving exact
path, method, and Authorization. The harness never probes or binds port 8787.
No live workspace, collector, worker, terminal session or signing key is used.

After **any** static byte change, publish into scratch, review, explicitly pin
the new entry in the trusted host and rebuild the frontend. A hash mismatch
must fail rather than inheriting the old release's grant. Keep prior addressed
bundles for rollback. The release packager must include every static Hive file
and its digest in the distribution, including `snapshot-adapter.js` and its JS
validator (both are trusted-side Vite build inputs), and verify the portable
Hermes source archive parity. Deployment, loaded parity and live canary are
separate release gates.
