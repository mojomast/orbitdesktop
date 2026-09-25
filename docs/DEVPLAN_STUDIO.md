# Devplan Studio 1.0.0

Original static Orbit app inspired by https://github.com/mojomast/devussy, inspected at 06d01a1228bd2e3b003ff7defa8b038adf6e1574 (README adaptive seven-stage pipeline and development/handoff prompts). No upstream implementation copied.

Source: apps/devplan-studio/. Published entry: /apps/devplan-studio-8959576ec51336ec9be101b0/index.html.

## Use

Answer the 15 interview questions. Use one feature and one corresponding acceptance criterion per line. Review heuristic complexity, generate/edit the spec, resolve structural blockers, and explicitly approve the design. Inspect phases, save a checkpoint, then download the ZIP. Extract it into the target project and give handoff.md to an agent alongside the artifacts. Scope changes must be made in the interview and regenerated to retain coverage.

Export project saves the editable interview, spec and up to 12 checkpoints. Import validates the project and clears approval. Orbit's opaque sandbox cannot use localStorage; the displayed memory-only warning is intentional. Export before closing/reloading. Orbit workspace checkpoints do not back up project data.

## Boundaries

This is a local guided questionnaire and deterministic planning scaffold, not the full Devussy LLM pipeline. No model calls, conversational follow-up inference, repository scanning, automatic semantic review, or execution occur. An agent-review prompt can be exported for manual review through Hermes. Complexity is an original transparent heuristic, not Devussy's exact rubric. Generated phases provide requirement-linked task/gate scaffolding rather than invented file-level implementation details. The starting handoff requires real evidence, dependency gates, correction, updates and bounded retries.

No credentials, third-party scripts, external API calls or backend changes. Source contains no user project data. Generated project files can contain private answers; keep exports private.

## Evidence

npm run check: build succeeded; 69 tests passed. tests/devplan-studio.browser.py runs against the actual published CSP-sandboxed endpoint and verifies interview progression, missing-answer gates, draft generation, approval, phases, checkpoint creation, ZIP CRC/content, project export/import, invalid imports, reset approval, literal input rendering and 390px layout with no JavaScript errors. Test data is synthetic and separate from the owner workspace. Browser acknowledged plugin activation at revision 955. Existing terminals/apps retained.
