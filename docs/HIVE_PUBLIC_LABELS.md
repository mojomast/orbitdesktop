# Publishing an operator-authored Hive title

By default, a new project has safe IDs such as `Job saffron-wave`. To give it a public display name, the operator writes a **separate alias**, for example `Saffron relay`, and explicitly binds it to one reviewed observation. This changes only the record title. Selectors, navigation, decision questions, provenance, state and authority still come from the ordinary snapshot projection.

## Publish from two pinned inputs

1. Use Linux, Python 3 and Node 20+ with Web Crypto. Run the reviewed publisher, JS module and Node binary from operator-controlled code and `PATH`. Place inputs and reports in **separate** existing owner-owned `0700` directories. All ancestors must be real directories owned by the operator or root, without group/world write. Keep them outside checkouts, shared scratch, runtimes, agent homes and worker state. For the report reader use an absolute path on its supported root filesystem; see [Host integration](HIVE_INTEGRATION.md). Directory permissions do **not** distinguish processes running as the same user: if an agent can edit these files, the publisher, the binary, its parents or service configuration, do not enroll it. No path auto-discovery or credential is involved.
2. Obtain a fresh snapshot/1 JSON capture from the already-authorized collector reader. Keep it **private**. Review the public selectors and base revision against the intended project, then record the SHA-256 of its exact UTF-8 bytes. No pretty printing after pinning: commas, whitespace and final newline are part of the hash. For example, in a private operator shell:

   ```sh
   umask 077
   # inputs and reports are the two absolute directories described above.
   snapshot_pin=$(sha256sum -- "$capture" | cut -d' ' -f1)
   install -m 0600 -- "$capture" "$inputs/$snapshot_pin.json"
   ```

3. Author a *new* local `aliases.json`. Replace the placeholder with the reviewed 64 lowercase hex characters. Write `title` yourself for public viewing. Do not populate it from source objectives, paths, questions, summaries, transcripts, personal data or a formatter over source text. A scrubbed sentence is not a public alias. The following fields are the entire draft schema; there is no `aliasFrom`, generic metadata, note or extension field:

   ```json
   {
     "version": "hive.public-aliases/1",
     "snapshotSha256": "<exact reviewed capture digest>",
     "rows": [
       {"kind":"job","id":"saffron-wave","repo":"observatory/saffron","jobId":"saffron-wave","title":"Saffron relay"},
       {"kind":"backlog","id":"saffron-card","repo":"observatory/saffron","jobId":"saffron-wave","title":"Orchard handoff"}
     ]
   }
   ```

4. Inspect the complete draft, pin *that* file, and publish using its reviewed address. Use real selectors present in the capture. This is a local, one-shot operation; the publisher never fetches a source. The reviewed snapshot must still be fresh at publication.

   ```sh
   draft_pin=$(sha256sum -- "$draft" | cut -d' ' -f1)
   install -m 0600 -- "$draft" "$inputs/$draft_pin.json"
   python3 scripts/hive_public_labels.py --inputs-dir "$inputs" \
     --draft-sha256 "$draft_pin" --staging-dir "$reports"
   ```

   Only the two named `<digest>.json` files are read: regular, single-link, owned by the caller, mode `0400` or `0600`. Pins are recomputed from the bytes read. Duplicate JSON keys, bad pins, unsafe permissions, unknown versions/fields and unbound selections refuse the publication. The publisher replaces only `labels.json` (mode `0600`) by atomic rename in `reports`; it never appends or merges. Validation failure leaves the existing packet alone. Do not put either input in the report directory or distribute it with the app.

5. The operator may separately enroll that report directory via `ORBIT_HIVE_REPORT_DIR` in trusted service configuration and grant **Share enrolled evidence with this pane** on the trusted host. A plugin, snapshot row, agent or worker cannot enroll a label. A digest authenticates content relative to a reviewed pin; it does not authenticate the publisher. Reading only the enrolled, operator-controlled file and obtaining the independent pane grant are mandatory.

## Exactly what can cross

`labels.json` contains exactly `version: "hive.public-labels/1"`, `reviewedAt` (the reviewed snapshot's generation time normalized to UTC with milliseconds) and `rows`. Each row has exactly the five draft fields plus `revision` (lowercase SHA-256). The report has at most 64 unique `(kind,id)` rows and is capped at 64 KiB. The raw capture, draft, their pins and unpublished source text are not report fields. The guest never receives the catalog, either pin, or any label revision.

* **IDs**: case-sensitive ASCII, 1–64 characters, start with a letter, then letters/digits with at most 24 characters per segment and single `-`/`_` separators. A repo is exactly two such segments separated by `/`. No placeholders, dot notation, credential/network-shaped or private identifiers. **Titles**: 1–8 words, single spaces, 1–64 characters total. Each word is up to 15 lowercase letters optionally preceded by a capital, or a 1–4 letter acronym. No digits, punctuation, paths, addresses, markup, controls, bidi or secret/private markers. Lexical checks are defense in depth: ordinary words can be sensitive, and only a human choosing public text is the declassification step.
* **Job**: `id === jobId`. Require the exact visible, live pipeline job, exact repo, full 40/64-hex base revision and a complete vector of up to 64 fresh tasks. Hash UTF-8 `JSON.stringify(["hive.public-labels/1", ...J])` with `J = ["snapshot/1:pipeline", repo, jobId, base_rev, task_count, escalation_count, tasks]`. Each task is `[task_id,state,attempts_count]` sorted by ASCII `task_id`. Only the snapshot/1 public typed fields listed here contribute. A private note or prompt change cannot affect a digest.
* **Backlog feature**: require the exact visible, live feature, its explicit `job_id` and the qualifying job above. Hash the same version prefix followed by `["snapshot/1:backlog", feature_id, job_id, status, sortedDependsOn, J]`. Dependencies must be unique public IDs (at most 32). A job's repo is reached only via this explicit job key. No subject→job or shared-title join. Attempts, tasks, decision requests, PRs and arbitrary source fields are not independently labelable in v1.
* **Scope and time**: both sides recompute these scoped revisions independently. Reordering does not create a new revision. Sampling clocks are freshness checks, not content: an unchanged job can retain its alias after the next poll. Any bound content change invalidates the old alias. Only live rows in the bounded projection are eligible. Each application checks the oldest contributing timestamp against the 10-minute live window, the overview generation against the reviewed generation, and review age against a 24-hour ceiling. A future-dated overview beyond the adapter's one-minute skew allowance fails. Missing Web Crypto leaves the baseline view.

## Trusted-side API and clearing

```js
import {projectLabelView, validateLabels, applyLabels} from './public-labels.js';
const base = await projectLabelView(snapshot); // unchanged full snapshot/1 admission first
const display = applyLabels(base, validateLabels(packet) ? packet : null);
```

`validateLabels(value): boolean` validates parsed JSON; raw size and duplicate-key checks belong to the enrolled file reader. `projectLabelView(snapshot, {now}?)` returns an immutable, ordinary safe view. A host-local weak map holds bindings for that exact object, without raw source or serializable provenance metadata. `applyLabels(view, packet, {now}?)` synchronously returns a **new view**, changing only `records[i].title` on exact matches. The time option is for deterministic testing; operational callers use the host clock. Use this API only on a trusted projection, never as a sanitizer of arbitrary guest-supplied views. A clone of a baseline, even one with matching IDs, cannot gain a binding. A result from this API can be reapplied locally: it always starts from its original baseline.

After each accepted overview, restore the original titles and re-evaluate against the current file and grant. Transfer only matched title changes for that exact accepted view. A malformed file clears *all* overrides; a stale or mismatched row clears that row. Unavailable source, out-of-order observation, lost consent, mode switch or remount must not retain a current override. To withdraw aliases, remove `labels.json` or publish an empty `rows` list; on the next permitted read the baseline is restored. Stop sharing to discard the granted document immediately. Publication does not erase copies a human already saw.

Focused tests: `node --test tests/hive-public-labels.test.mjs` and `python3 tests/test_hive_public_labels.py -v`. They use synthetic snapshots and independent temporary report/input directories.
