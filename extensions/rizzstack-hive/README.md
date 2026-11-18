# The Hive · Nightshift field atlas

## Start a shift

The command strip shows active attempts, eligible work, scheduler slots, pending decisions, the known price subtotal, and the dated release verdict. **Shift control** opens on the highest-ranked observed issue. Read the ticket, then its question, source, ID and timestamp in **Investigation**. A ticket marked *Verification queue* opens the stage measurement: compare dwell and target before treating the queue as stalled. Unknown recovery status is not evidence that a retry is running.

Click **On shift** to inspect an actual execution-associated attempt, or press **/** for the operational workbench. Work, Workers, Queue, Decisions, Evidence and Usage provide different indexes into the same projection. Follow exact job references, use the contextual back link to return, or inspect a selected public attempt/job in the existing trusted Rails shell. The Workbench retains its filters and sort while you inspect a record. No private selection is stored in the URL.

The observation source is always identified: the host delivers **snapshot polling** at a 30-second floor, the separate Rails shell can stream a selected history, and the incident recorder is **historical replay**. A disconnected session can display its last confirmed observations. Revocation discards the granted pane. No control in the demo authorizes an owner action. Free-text labels cross the host boundary only under the adapter's reviewed publication policy; other records retain safe stable identifiers.

The Hive is a read-only Orbit control room for the Rizzstack factory. Each of its eight machined stations has a fixed address. A station is a workflow stage; a wing marker is a recorded **attempt ID**, not a claim that a unique machine is busy. The marker register retains terminal attempts. The **in flight** reading counts active records independently. A missing source, an unresolved gap and a measured zero have different meanings.

## Open a private local demonstration

From a checkout of this Orbit candidate, no build, downloads or credentials are needed:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory apps/rizzstack-hive
# http://127.0.0.1:8765/?demo=shift
```

- **Working shift:** follow the priority signal to an owner request; press **B** to inspect measured pressure. See the verification queue and its source timestamp. Select a wing or use Work register to search exact objects.
- **Full complement, quiet floor, signal loss:** compare fourteen active attempts, a confirmed idle fleet, and missing coverage. A launcher limit and the scheduler’s available slots are different quantities. A partial price is a subtotal, not the price of the whole shift.
- **Duplicate receipt:** open `?demo=replay`. Step through 35 origin events from the separate recorded receipt-replay lab. The stage geography remains fixed. Select the first failure, B’s candidate pass, then the four-test combined-tree pass; compare their Git revisions and evidence references. The Windows check was not run. The recording is independent of the shift fixtures; names are not inferred to be joins. The Git tests ran locally; orchestration and event times are synthetic.
- **Release desk:** read the dated #92 evidence, default vs indexed p95, canary and pending receiver. It describes the Rails base, not a current deployment measurement or qualification of Hive itself.

Use the text station register on a narrow screen or with the keyboard. Enter/Space inspect a station; arrow keys move between neighboring stations. The Display menu provides high contrast and still transitions. System reduced motion takes precedence, and audio is off. No persistent client-side data store is required.

## Read an enrolled Orbit source

Follow [the host integration guide](../../docs/HIVE_INTEGRATION.md). The default standalone state is **Host read not confirmed**. Only an explicitly granted, exact content-addressed pane receives the bounded host projection. Refresh is limited to the snapshot cadence. Select an observed attempt or job and choose **Open Rails timeline**, then **Inspect** in Orbit. The original shell handles R12 authentication, bounded pagination, selected-scope invalidation/replay and detail. Declining to share, loss of access, and a stale or partial read are all visible; none selects a demo for you.

For **authorized staging** use the existing `plugin_publish.py` on `apps/rizzstack-hive` with `--id rizzstack-hive --title 'The Hive' --version 1.0.0 --runtime <isolated-runtime>`. Verify the resulting entry against `src/hive-host.ts`, and install the manifest through Orbit's normal disabled-first plugin workflow. Re-enable only with operator approval, after confirming the installed and loaded source revisions. Do not use production runtime directories for a rehearsal. Roll back by revoking the read grant and returning to the retained earlier bundle/host. No ledger, worker lease, queue entry, RETURN decision, or job should be edited to roll back this UI.

## Verify

```sh
node --experimental-strip-types --test tests/hive-*.test.mjs
CHROMIUM_EXECUTABLE=/path/to/chromium node tests/hive-atlas.browser.mjs /path/to/scratch/render
CHROMIUM_EXECUTABLE=/path/to/chromium python3 -B tests/hive-integration.browser.py
```

The static app needs no Node dependencies. Engineering tests use Orbit's locked local dependencies. The integration test additionally uses the matching sibling Workflow checkout, a temporary runtime, loopback collector handler and actual R12 reader. See Workflow `schemas/hive/fixtures/README.md` for deterministic collector reproduction. `scripts/hive-trace-import.mjs` imports the versioned public lab recording, not live/private events. When static app bytes change, the pinned host entry and portable source archive must be regenerated and all exact-candidate checks rerun.
