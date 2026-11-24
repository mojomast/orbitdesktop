# Integrated technology workspace acceptance

`tests/technology-workspace.browser.py` exercises the **built full Orbit shell**,
using its ordinary feature commands, host pane mounts, owner routes and persistence.
Run it once for each renderer against the same isolated release build:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python \
  tests/technology-workspace.browser.py --renderer default --dist /absolute/isolated/dist
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python \
  tests/technology-workspace.browser.py --renderer docking --dist /absolute/isolated/dist
```

Omitting `--dist` builds with `scripts/isolated_build.mjs` into private scratch;
the checkout's served `dist` is never changed. `--capabilities both` (default)
starts separate unconfigured and configured servers. All servers have private
HOME/runtime/cwd, their own tmux socket/config, synthetic fake Hermes, and no
terminal panes. The gateway refuses and records every POST, and the browser
blocks and records requests outside the explicitly isolated Orbit origins.
No owner environment/profile is inherited into the server.

## Resources and coverage

Configure `--browser-executable`, `--voice-models` and `--audio-file` as needed.
The voice asset root is a read-only input. Models and synthetic screenshots do
not belong in Git.

The configured journey covers keyword-only Shared sources; library-created real
Lexical and Excalidraw documents; A2UI edit/save and explicit selected-recipient
draft preview/append; local Moonshine audio recognition; empty trace/retention
state; arrange/reload identity and durable data checks, including reopening the
saved result in the restored pane after host unlock; automatic capability
recovery in the already mounted panes after unlock; and bounded 390px
keyboard/recipient layout checks. Reload checks do not click Refresh or reopen
these mounts, and assert that no app automatically launches.

Canvas drawing uses the intersection of the real engine canvas, its island and
owned scroller, assigned pane, and browser viewport after an ordinary native
Rectangle-tool click. Both drag endpoints must hit that exact interactive canvas
through shadow-root hit testing, and saving must persist a nondeleted rectangle
with positive dimensions. No forced tool click or programmatic shape insertion
substitutes for the pointer interaction.
Seven owner APIs reject absent/wrong credentials, forged origins, malformed JSON
and unknown fields. The off journey checks hidden unconfigured commands and the
ordinary keyword search path.

This integrated journey complements the feature engine browser suites, which
cover trace waterfalls, microphone lifecycle, editor conflicts and other
engine-specific details. It does not dispatch provider inference.

## Evidence

Synthetic screenshots, per-server logs, failure text and structured results are
written under `/tmp/opencode/orbit-tech-acceptance`. A result is `PASS` only after
all assertions finish, including zero uncaught page errors, zero outside browser
requests or external CSP-blocked asset attempts, and zero gateway POSTs. Results
identify the build's index hash and copied server/source hashes. Failures retain
their completed coverage and traceback. Inspect screenshots separately before
claiming visual acceptance; a saved file alone does not establish that review
occurred. Actual run status must be reported from these results, not inferred
from fixture implementation.

## Verified integrated run — 2026-09-30

All four journeys passed against the isolated build
`/tmp/opencode/orbit-isolated-build-c4185fea-70d2-4c34-8d9c-20db15b9d764`:
default/off, default/configured, docking/off and docking/configured. Both
configured journeys completed arrangement and all reload assertions. Recorded
external requests, external CSP attempts, uncaught errors and Hermes POSTs were
all zero.

Canvas interaction used ordinary native toolbar clicks and shadow-aware hit
tests. The docking canvas's measured visible intersection was 178px wide after
native horizontal scrolling; a real dragged rectangle was saved. Synthetic
canvas, reload and 390px recipient screenshots were inspected separately.
Thirteen side-by-side docking groups remain cramped; this run establishes the
tested control interactions and continuity, not a general readability guarantee
for that arrangement.
