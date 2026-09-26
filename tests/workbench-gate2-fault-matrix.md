# Gate 2 fault matrix and cross-boundary coverage

Required fault → actual independent test (merged producer), not a mirrored helper.
Real-model evaluation remains an explicit UNRUN gate: 0 admitted live-model trials.

| Required fault | Actual independent coverage | Gap / note |
| --- | --- | --- |
| missing / malformed explanation | `tests/workbench-result-boundary.test.mjs` (typed `availability`/`unavailable_reason`, `contracts/workbench-result-v1.mjs` frame/receipt schemas) | Runtime is a deterministic simulated frame, not a live malformed frame |
| forged references / principals | `tests/workbench-result-boundary.test.mjs` (model args), `tests/workbench-fault-boundary.test.mjs` (owner requests/model args), `tests/release-external-resolution.test.mjs` (declared dep path) | — |
| revoked late calls/results | `tests/workbench-native.test.mjs` (revoked late private results), `tests/workbench-authority.test.mjs` | — |
| finalization failure | `tests/workbench-findings.test.mjs`, `tests/workbench-loop-execution.test.mjs` (durable staging/atomic finalization), `tests/release-isolation.test.mjs` (thrown-probe + rollback restore) | — |
| contradictory checks | `tests/workbench-result-boundary.test.mjs` "a delivered success claim cannot override a failing recorded check" (actual Hermes) | — |
| moving patch targets | `tests/workbench-patch-moving-target.test.mjs` (real Git; source mutated after `patch_preview` → `patch_export` refuses; owner change preserved) | — |
| limited capture | `tests/project-files-adversarial.test.mjs`, `tests/workbench-context.test.mjs` | — |
| unsupported dependencies | `tests/workbench-environments.test.mjs` | — |
| interrupted run | `tests/workbench-fault-boundary.test.mjs` "interrupted runtime ownership stays unknown", `tests/workbench-native.test.mjs` (lost ownership) | — |
| forbidden build destinations | `tests/build-isolation.test.mjs` (source served dist, protected roots, non-scratch policy), `tests/release-isolation.test.mjs` (pointer/path/protected roots) | — |
| Gate 2 integrated journey | `tests/workbench-results-ui.browser.py` both renderers: owner review → patch preview/export/download → git apply to a safe exact base → independent check → reload; original and unrelated panes unchanged | normal-UI only; real-model unrun |

Live-model acceptance is unrun (no endpoint/model/budget authorized); no cost is
fabricated and no failed trial is excluded. Deterministic simulated-model trials are
counted separately.
