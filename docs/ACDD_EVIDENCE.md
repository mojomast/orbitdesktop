# ACDD evidence view (integration contract and plan)

Status: **slice 1 built (read-only model + panel renderer, not wired into the UI)**. Wiring is planned and waits for the runnable-by-anyone work (`feat/runnable-by-anyone`), which currently owns `server/index.mjs`, `src/main.ts` and the settings/onboarding surfaces.

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

## Wiring plan (planned, not built)

1. **Server route** (planned): `GET /api/acdd/:runId` returns `buildEvidenceView` for a bundlebees run directory under the existing runtime root. Read-only. Lives in `server/index.mjs`, so it waits for the runnable-by-anyone branch to land.
2. **Board card** (planned): a card linked to a contract shows the short contract hash, frozen or not, and the phase chips (RED, GREEN, REFACTOR, integration) from `view.phases`.
3. **Panel** (planned): `renderEvidencePanel` mounted from `src/main.ts` when a card is opened.
4. **Activity feed** (planned): `toActivityItems` feeds the existing activity stream, so a RED or GREEN record appears like any other worker event.
5. **Human gates** (planned): contract approval and merge/release/deploy/publish stay human buttons. Orbit records who approved; bundlebees freezes the contract hash. No auto-merge.
6. **Local workers** (planned): when a brief carries a contract, the local-worker card shows the contract id and links the evidence view; the launcher protocol does not change.

## Compatibility

Briefs without a contract keep working exactly as today and show "no ACDD contract; TDD evidence not required". Nothing in slice 1 is imported by existing code, so it changes no current behaviour.
