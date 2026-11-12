# ACDD evidence view (integration contract and plan)

Status: **slice 1 (read-only model + panel renderer) and slice 2 (wiring) built**, on `feat/acdd-evidence-view`, under review (not merged). Slice 2 adds three lines to `server/index.mjs` and three to `src/main.ts`. The runnable-by-anyone branch (`feat/runnable-by-anyone`) also edits those two files; `git merge-tree` against its head `cd2e8eb` merges cleanly, and nothing on that branch was touched.

The protocol is defined in the workflow repo: [ACDD + TDD](https://github.com/mojomast/workflow/blob/main/docs/16-acdd-tdd.md). Execution and verification belong to [bundlebees](https://github.com/mojomast/bundlebees/blob/main/docs/ACDD.md). Orbit is the coordination interface: it **displays** contracts and verifier evidence and asks humans for the gates. It never decides acceptance, never re-classifies a test result and never runs its own orchestrator.

## Layers

| Layer | Owns | Orbit's role |
|---|---|---|
| Workflow (protocol) | `acdd/1` contract schema, `tdd-evidence/1` evidence schema, failure codes, lifecycle | Uses the same version strings and failure codes; refuses other versions |
| Bundlebees (execution) | Contract validation and freezing, RED/GREEN/REFACTOR/integration records, acceptance report | Reads the records and the report as-is |
| Orbit (coordination) | Board, activity feed, human gates (approve contract, merge, release, deploy, publish) | Shows the timeline, AC status and plain-language failures |

## What slice 1 contains

| File | What it does |
|---|---|
| `server/acdd-evidence.mjs` | `parseContract`, `parseEvidence`, `buildEvidenceView`, `toActivityItems`, `readEvidenceDir`, `FAILURE_TEXT`, `STATUS_LABEL` |
| `src/acdd-evidence-panel.ts` | `renderEvidencePanel(view)`: a self-contained, escaped HTML fragment with no scripts or inline handlers |
| `tests/acdd-evidence.test.mjs` | 9 approved acceptance tests, committed before the implementation (RED commit `20eadb9`) |

Rules the view enforces (all covered by the tests):

- Only `contract_version: "acdd/1"` and `evidence_version: "tdd-evidence/1"` are read. Anything else is skipped with a note, never guessed.
- An `unrun` or `not_run` check is shown as **Not run**, never as passed.
- Records whose `contract_sha256` differs from the frozen contract are flagged `stale_revision` and ignored for status.
- Records produced by the worker (`produced_by.role == "worker"`) are shown as a note and ignored: worker claims are not authority.
- When a bundlebees acceptance report is present, its per-criterion status is shown as-is (the verifier is the authority).
- Every displayed string goes through the existing activity redactor (`makeRedactor`), and the panel escapes HTML.
- `readEvidenceDir` reads only regular `*.json` files (no symlinks), with file-count and size limits, and returns skipped files with a reason.

## Data contract

Inputs, all produced by bundlebees (`bundlebees contract freeze`, `bundlebees tdd red|green|refactor|report`, contract-aware `verify` and `integrate`):

- the frozen contract (`acdd/1`, `review.status == "approved"`, `review.contract_sha256`);
- evidence records (`tdd-evidence/1`), one per phase, in the run's evidence directory;
- optionally the acceptance report (`acceptance_report/1`), which maps each AC id to `passed`, `failed`, `unrun` or `review_required` and names the evidence file.

Output of `buildEvidenceView`: `{contractId, title, shortSha, frozen, authority, timeline[], criteria[], phases{}, accepted, failures[{code,text}], notes[]}`. `toActivityItems(view)` turns it into activity-feed items.

## Wiring (slice 2, built)

- **Server route:** `GET /api/acdd-evidence` (`server/acdd-evidence-route.mjs`). It needs the Orbit session token and the same origin checks as other host APIs, and it answers only GET/HEAD (anything else gets 405). Set `ORBIT_ACDD_STATE_DIR` to the bundlebees plugin data directory. Without it, the route returns `{configured: false}` and the window says so. With it:
  - no query: lists `evidence/<contract_id>/` directories (real directories with valid ids; symlinks and dotfiles are skipped), each with its record count and the contract title from the lease;
  - `?contract=<id>`: finds the frozen contract in `leases/*.json` (`brief.contract`) and returns `buildEvidenceView` plus `toActivityItems`. An unknown id, or evidence with no lease contract, is a 404; Orbit never invents a contract.
  
  The route never writes, and errors never include paths.
- **Window:** a dark, read-only dialog (`src/acdd-evidence-window.ts`, `src/acdd-evidence.css`). Open it with **ACDD evidence** in the command palette (group Hermes) or the Hermes menu. It lists contracts, then shows `renderEvidencePanel` for the one you pick. It makes GET requests only, and there are no approve/merge buttons.
- **Not built yet:** board-card phase chips, feeding `toActivityItems` into the live activity stream, and showing the contract on local-worker cards. Human gates stay human, as above.

## Compatibility

Briefs without a contract keep working exactly as today and show "no ACDD contract; TDD evidence not required". Slice 2 only adds a route and a menu entry; when `ORBIT_ACDD_STATE_DIR` is unset the view says it is not configured.
