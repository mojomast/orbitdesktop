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
- **A record counts only after server-side HMAC-SHA256 verification.** The HMAC key is read from `<ORBIT_ACDD_STATE_DIR>/lease.key` on the server (and the bundlebees evidence key derived from it is also accepted). The key is never logged, returned, put in a view or sent to the browser bundle.
- `produced_by.role` is only a label, never authority. A record must verify **and** say `produced_by.role == "verifier"` to count; unsigned, modified and worker records never count.
- A modified or unsigned record that claims `produced_by.role == "verifier"` is a stolen label: it adds `evidence_tampered` and a note, and can never mark anything accepted.
- Records whose `contract_sha256` differs from the frozen contract are flagged `stale_revision` and ignored for status.
- When a **verified** bundlebees acceptance report is present (`reports/<contract_id>.json`, HMAC-signed with the same key and matching the contract id and `contract_sha256`), its per-criterion status is shown as-is. An unsigned, wrongly signed or mismatched report is ignored and cannot set `accepted: true`.
- Without a verified report, `accepted` is `false` and criteria/phases come from verified verifier records only.
- Every displayed string goes through the existing activity redactor (`makeRedactor`), and the panel escapes HTML.
- `readEvidenceDir` reads only regular `*.json` files (no symlinks), with file-count and size limits, and returns skipped files with a reason.

## Signature scheme

This matches `bundlebees_plugin/tdd.py` on `feat/acdd-tdd`:

- The payload is the record with the top-level `signature` key and every top-level key starting with `_` removed.
- Its canonical JSON is Python `json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)`: keys sorted recursively by code point, no spaces, non-ASCII escaped as lowercase `\uXXXX` (surrogate pairs for astral characters), and Python's control-character escapes.
- The signature is lowercase hex HMAC-SHA256 over that canonical JSON and is compared with `crypto.timingSafeEqual`.
- `lease.key` must be a regular, non-symlink file of exactly 32 bytes, owned by the current uid, with no group or world permission bits. If it is missing or unsafe, the route still answers but the view reports verification as unavailable and counts nothing (`accepted: false`).
- Reports use the same scheme and are additionally required to match the frozen contract's `contract_id` and `contract_sha256`.

## Verification states

The view exposes exactly one overall `verificationState`, and `accepted` is true only when it is `verified`. No record label, report field, phase string or client input can set acceptance independently.

| State | Plain-language meaning | What produces it |
|---|---|---|
| `verified` | The evidence is verified and accepted. | A verified acceptance report with matching `contract_id` and `contract_sha256` and `accepted: true`, every phase in `contract.evidence_required` has a verified record, and nothing is rejected. |
| `rejected` | Something failed verification. | Any rejected record (modified signature, stolen verifier label, stale contract sha) or a rejected report (bad/unsigned signature, `contract_id` or `contract_sha256` mismatch). |
| `invalid` | The contract or records cannot be read. | The contract is invalid, or every supplied record is invalid (unreadable JSON, wrong `evidence_version`, missing required fields). |
| `unverified` | Verification could not be performed. | No usable lease key, or there are no evidence records at all. |
| `incomplete` | Verification has not finished. | Nothing is rejected, but a required phase lacks a verified record, there is no verified report, or the verified report says `accepted: false`. |

Each record is also reported as `{index, phase, status, reason}` where `status` is one of `verified`, `rejected`, `invalid` or `unverified`. Reasons are fixed codes; file paths and key material are never included.

## Data contract

Inputs, all produced by bundlebees (`bundlebees contract freeze`, `bundlebees tdd red|green|refactor|report`, contract-aware `verify` and `integrate`):

- the frozen contract (`acdd/1`, `review.status == "approved"`, `review.contract_sha256`);
- evidence records (`tdd-evidence/1`), one per phase, in the run's evidence directory;
- optionally the acceptance report (`acceptance_report/1`), which maps each AC id to `passed`, `failed`, `unrun` or `review_required` and names the evidence file.

Output of `buildEvidenceView`: `{contractId, title, shortSha, frozen, authority, timeline[], criteria[], phases{}, accepted, verificationState, records[{index,phase,status,reason}], verification{available,verified,rejected}, failures[{code,text}], notes[]}`. `accepted` is exactly `verificationState === "verified"`. The route returns the same `verification` summary at the top level. `toActivityItems(view)` turns it into activity-feed items.

## Wiring (slice 2, built)

- **Server route:** `GET /api/acdd-evidence` (`server/acdd-evidence-route.mjs`). It needs the Orbit session token and the same origin checks as other host APIs, and it answers only GET/HEAD (anything else gets 405). Set `ORBIT_ACDD_STATE_DIR` to the bundlebees plugin data directory. Without it, the route returns `{configured: false}` and the window says so. With it:
  - no query: lists `evidence/<contract_id>/` directories (real directories with valid ids; symlinks and dotfiles are skipped), each with its record count and the contract title from the lease;
  - `?contract=<id>`: finds the frozen contract in `leases/*.json` (`brief.contract`), verifies each `evidence/<id>/*.json` record with the lease key, optionally verifies `reports/<id>.json`, and returns `buildEvidenceView` plus `toActivityItems` and a `verification` summary. An unknown id, or evidence with no lease contract, is a 404; Orbit never invents a contract. A bad or mismatched report is ignored, so `accepted` stays `false`.
  
  The route never writes, and errors and responses never include the key, its path or other absolute host paths.
- **Window:** a dark, read-only dialog (`src/acdd-evidence-window.ts`, `src/acdd-evidence.css`). Open it with **ACDD evidence** in the command palette (group Hermes) or the Hermes menu. It lists contracts, then shows `renderEvidencePanel` for the one you pick. It makes GET requests only, and there are no approve/merge buttons.
- **Not built yet:** board-card phase chips, feeding `toActivityItems` into the live activity stream, and showing the contract on local-worker cards. Human gates stay human, as above.

## Compatibility

Briefs without a contract keep working exactly as today and show "no ACDD contract; TDD evidence not required". Slice 2 only adds a route and a menu entry; when `ORBIT_ACDD_STATE_DIR` is unset the view says it is not configured.
