# Release readiness: conversation-first Orbit

## Current disposition

The owner authorized the integration merge, completed through PR #10 at `6301ccb`
after all candidate CI passed. The same source tree is deployed as `orbit-c87d54a`.
Version 0.3.0 now aligns desktop and Hermes plugin metadata for a separately pinned
catalog package; see [release notes](RELEASE_0.3.0.md) and the GitHub release for
the final immutable pin and packaging evidence. Desktop remains default, Docking
experimental, and native Workbench execution separately configured.

The plan below is the **historical assessment from 2026-09-28**, including its
then-open decisions and baseline versions. It is retained as evidence, not a
current deployment instruction or a claim that every proposed usability,
performance or accessibility assessment has been completed.

Post-release follow-up on `main`: Project Workbench is now an **experimental,
off-by-default** surface enabled in **Orbit settings** (◉ orbit menu → Orbit
settings → Experimental features → Project Workbench). All Workbench entry points
and task-result cards stay hidden while it is off; stored tasks, candidates,
results and per-pane mode preferences are preserved, and the server authority
boundaries are unchanged. `tests/experimental-workbench.browser.py` covers the
gate. This change is not part of the published 0.3.0 pin; it is prepared for the
0.3.1 package on `release/0.3.1`.

## Baseline and release decision

Assessment baseline: `workbench/next-integration` at `3a0262a`, compared with
`origin/main` at `38a9d56`: 231 commits ahead, none behind; 433 changed files.
The live executable remains `orbit-4fec70f` at this assessment. The theme/fresh-chat
hotfix is published at `3a0262a`; it does not fix the idle Send blink or restore a
visible New chat control.

Recommend **0.3.0-rc.1 → 0.3.0**, subject to owner agreement. This is a substantial
pre-1.0 product release. Release size alone does not establish a 1.0 stability
promise. Currently `package.json` says 0.1.0 while the Hermes plugin says 0.2.7.
Choose a documented product/plugin version policy and update package metadata,
lockfile root metadata, plugin metadata, any UI version display, release notes
and portable archive together. Schema, API contract and plugin manifest format
versions remain independent; do not change them for marketing consistency.

Recommended renderer policy: **Desktop default; Docking explicitly experimental**
for this release. Owner comparison and measured usability should inform any later
promotion. See [renderer comparison](RENDERER_COMPARISON.md).

## 1. Fix the reported interaction blockers first

### Stable Send and conversation controls

At the assessment baseline, `src/agent-chat.ts` refreshes shared state every 1800 ms. `syncShared()` sets
`sharing=true`, calls `update()`, and clears it after the read. `update()` disables
Send while sharing; `submit()` returns early during sharing. Conversation controls
also depend on that same transient flag. This is a concrete code path for periodic
button flicker and ignored submissions, separate from execution-lane blocking.

Implementation requirements:

- Distinguish initial binding acquisition, passive refresh, deliberate conversation
  switching, actual submission and execution uncertainty in the UI state model.
- Passive refresh must not toggle actionable controls, move focus, replace the
  composer, or announce a new busy state every polling interval.
- A Send click during a delayed refresh must be handled deterministically. Keep
  exact binding revision and session checks; if binding changed, preserve the
  draft and explain the conflict. Do not route it to a newly selected conversation.
- Keep submission exclusion and exact-request recovery. Removing `sharing` from
  the disabled expression alone is not a complete concurrency fix.
- Distinguish a background-read error from failed message delivery. Display a
  useful connection status without repeated alerts or automatic retries of an
  uncertain submission.

Acceptance: observe idle controls for at least 30 seconds with normal and delayed
reads; zero poll-induced enabled/disabled transitions. Click Send and press Enter
during an outstanding read; exactly one intended submission or an explicit stale
binding refusal, preserved draft, zero silent loss/duplicates. Cover late refresh
responses, remote conversation switches, disconnect/reconnect, active runs,
pending approvals and unknown receipts in both renderers.

### Findable New chat

Baseline location: **agent pane ⋯ → Conversation settings → New chat**. It was a
frequent conversation action hidden inside configuration.

Implemented candidate design: a visibly labeled **New chat** action in the
conversation action row, alongside **History** and **Show tools**. The row wraps
in narrow panes; profile configuration stays in Settings. Missing-history errors
also offer an explicit New chat action at the point of failure. Owner acceptance
remains part of the release gate.

Acceptance: owner can start another conversation without instructions or opening
Settings, using pointer and keyboard. Preserve the prior conversation and its
draft; explain real blockers inline. Background reads never make New chat flicker.

## 2. UX quality pass: measurable owner journeys

Use realistic synthetic content and actual server fixtures, plus owner walkthroughs.
An attractive screenshot or a high automated test count is not sufficient evidence.

| Journey | Acceptance |
| --- | --- |
| Connect → first message → reply → follow-up | Clear connection state; stable composer; no dropped/duplicate sends; visible tool activity; retained context |
| New chat → return to old conversation | Discoverable controls; correct transcript; each draft stays with its conversation |
| Describe a goal → brief → prepare → review start | Plain-language steps; preparation and execution visibly distinct; unavailable native runtime explained before an unusable Start action |
| Run → activity → stop/error/recovery | Quiet idle UI; useful progress; no invented completion; exact recovery action for uncertainty |
| Theme → customize → switch → reload | Coherent parent chrome; owner overrides survive; preset defaults do not leak; embedded-app limits explained |
| Arrange → narrow pane → reload | Composer and essential actions remain usable; no clipping, trapped focus or lost work |

Review hierarchy, terminology, spacing, contrast, focus order, dialogs, empty
states, loading states and errors across those journeys. Avoid technical IDs in
primary labels; keep precise scope/receipt information in details. Proposed plain
language labels must be evaluated with the owner before replacing established ones.

Test both renderers at representative desktop sizes and 520 px / 360 px narrow
viewports, including 200% zoom and reduced motion. Check keyboard-only operation,
screen-reader names/status announcements, focus visibility and WCAG 2.2 AA
contrast/target-size requirements. Record failures rather than claiming formal
accessibility certification from automated checks.

Measure idle polling/render counts, layout shifts, input responsiveness, network
request volume and behavior with long conversations and several windows. Set
performance budgets from a recorded reference device and workload. In particular,
idle polling must not visually pulse primary controls or trigger repeated live
region announcements.

## 3. Renderer comparison and decision

Run the same three-window workload in separate disposable workspaces: chat,
document/app with an unsaved draft, and a private tmux terminal. Compare finding
work, arranging it, switching tasks, resizing, narrow layouts and reload recovery.
Capture labeled before/after screenshots and owner observations. Keep identical
content/theme/viewport for the initial comparison.

Technical gates: runtime continuity and terminal identity; docking tab/float/grid
persistence; stale placement conflicts; theme coverage; chat/Workbench parity;
unsupported-browser fallback. Existing tests cover many of these invariants, but
do not establish that either renderer is easier to use.

Owner steering moved arrangement controls to a **Docking** disclosure in the top
Orbit bar beside host connection. Full viewport keeps only its compact toggle
at the upper right. Removing the internal toolbar's height from the grid also
corrected the 520×700 screenshot's clipped composer; the visual fixture now checks
composer containment rather than only component size. The retained library tab
labels above Orbit title bars still warrant owner review before promoting Docking
beyond experimental status.

Owner steering also identified an unnecessary global exclusion between Normal
chats. The candidate permits independent accepted ordinary conversations to
overlap, using durable receipt/run/binding/configuration checks. Same-session
duplicates, uncertain or unreceipted work, native Workbench execution and managed
jobs keep their guards. The host gateway still controls its own concurrency cap.

Exit: owner chooses the release default based on the walkthrough; documentation
explains selection and saved-layout behavior. If Docking remains experimental,
that status must be visible and its browser limitations explicit.

## 4. Documentation audit alongside implementation

Deliver one current user-facing entry point and keep historical evidence dated.

- `README.md`: current capabilities, quick start, chat/Workbench distinction,
  renderer choice and links to the release guide. Its present introductory
  Workbench paragraph still describes native tools/acceptance as pending in terms
  that need reconciliation with later milestone evidence.
- `docs/HERMES.md` and `docs/AGENT_PANE_UX.md`: actual control locations, conversation
  and draft behavior, tool visibility, status/error meanings and recovery.
- `docs/WORKBENCH_SETUP.md`: supported `node-test` preparation flow and separately
  configured native execution. The current live service has no native worker
  configuration; successful preparation is not a successful worker launch.
- `docs/THEMES.md`: preset/override semantics and the boundaries of parent styling.
- `docs/RENDERER_COMPARISON.md`, `docs/OPTIONAL_DOCKING.md`,
  `docs/RENDERER_PARITY.md`: user guide versus technical/historical evidence.
  Old 255/255 and 278/278 counts must not appear to certify the new release.
- `docs/DEPLOYMENT.md`, `docs/WORKSPACE_STORE.md`, plugin activation guide:
  fresh-install and supported-upgrade paths, schema-11 compatibility, bootstrap
  assets, backup/restore and terminal preservation.
- New versioned release notes: cumulative changes since main, breaking/setup
  changes, known limitations, exact acceptance revision and release identities.

Verify every documented walkthrough in a clean environment. Link-check docs and
cross-check visible labels against real screenshots. Preserve historical records
as historical; do not rewrite their old measurements as current evidence.

## 5. Candidate verification and merge gate

1. Fix the blockers, review the owner journeys, and agree renderer/version policy.
2. Freeze a candidate SHA. Map every release-blocking issue to a reproducible test
   or a recorded manual acceptance result; record browser/viewport/build identity.
3. Run `npm run check`, relevant publisher/portable parity checks, and all seven
   Workbench CI suites plus the aggregate gate on that exact candidate. Required
   local-model native acceptance must run in its configured CI environment, not
   be counted as an optional local skip. Record any rerun and its cause.
4. Validate clean install and upgrade from the actually supported main runtime
   version using disposable copies. The live schema-11 hotfix rehearsal alone
   does not validate upgrading every installation from main. Verify full restore
   and preservation of conversations, notebooks, journals, receipts, candidates,
   plugin artifacts, configuration and persistent terminal identities.
5. Owner completes the short renderer/UX walkthrough. No unresolved blockers for
   sending, conversation navigation, lost data, misleading execution status or
   core theme readability. File other issues with explicit release disposition.
6. Open a release PR from `workbench/next-integration` to `main`, grouped in its
   description by product capability, runtime/storage, integrations, UI and tests.
   Review source/contract/permission/migration boundaries separately. Preserve the
   existing commit/evidence references; agree merge strategy before rewriting
   history. Refresh main divergence and check branch protections/required checks.
7. Merge only after the reviewed head is green. Build and verify the resulting
   merge revision, refresh distributable parity, and run post-merge smoke checks;
   pre-merge CI is not the identity of a newly built merge artifact.
8. Tag/release the chosen version, activate the verified artifact through the
   documented controlled rollout, verify HTTPS identity and fresh-browser
   behavior, and give the owner an explicit reload instruction.

Rollback keeps the matching binary, full runtime and configuration together.
Preserve post-backup durable writes; reconcile receipts/journals instead of
restoring a stale snapshot over new work or performing a pointer-only schema
downgrade. No live paid-provider run is implied by fixture acceptance; record
provider acceptance separately if the owner elects to perform it.

## Open owner decisions

1. Confirm 0.3.0 release naming (recommended), or define the stronger promises
   needed for a 1.0 release.
2. Choose renderer policy after the comparison; Desktop default plus experimental
   Docking is the starting recommendation.
3. Decide whether native Workbench execution configuration/provider acceptance is
   part of this release's live rollout or a clearly documented optional setup.

## Assessment evidence

### Implemented follow-up (candidate, pending exact-head CI and rollout)

Deployment preflight found a concurrent live theme release, `orbit-74557da`, with
Deep Field, Sakura and Amber CRT. Its theme-only delta relative to `4fec70f` was
imported exactly, with manifest provenance in commit `9d67906`, and merged into
the chat/Docking candidate. The existing theme matrix now covers those additions;
activation must preserve the currently deployed themes as well as owner runtime.

Exact-head CI on the first chat/Docking candidate exposed newly created Review
and project-tool bodies with no layout boxes in Docking. Reproduction isolated
the move of an unlaid-out new monitor; fresh windows now mount directly into the
connected Docking surface before panes are created. Existing-window movement
still uses the continuity-preserving path. The real candidate-review and native
result-review browser journeys pass with that fix. CI also found a controller
fixture racing pending UI saves: the continuity fixture now waits for identical
persisted state and browser acknowledgement before its next CAS mutation, without
retrying a rejected write. Theme contract coverage expects all 19 presets.

- Local `npm run check`: **774 passed, 0 failed, 8 optional skips**. Final isolated
  production build passed. Publisher: **6 passed**; portable plugin checks passed.

- New chat and History are visible above the Normal conversation; missing-history
  errors expose direct New chat recovery.
- Passive refresh does not disable either primary action. Foreground epochs fence
  old success/error responses across submissions, completions and binding changes.
- Both-renderer real-server chat journeys passed 30-second idle observation,
  delayed-read click/Enter submissions, late-response fencing, draft/history
  restoration, refresh outage, stale-binding refusal and missing-history recovery.
  They also held two distinct Normal runs active simultaneously and verified their
  separate run IDs and correctly routed replies. No live provider was called.
- Unit coverage verifies concurrent Normal admission after restart, duplicate-session
  refusal, native/job exclusion, and refusal of unknown/unreceipted/config-drifted
  other conversations.
- Docking controls moved into a top-bar disclosure beside host connection. A fresh
  56-case visual pass covered both renderers and four viewport sizes, with zero
  page errors. Idle cases now assert that the composer fits the viewport, New chat
  and History are visible, and the Docking disclosure supports keyboard dismissal.
- Updated docking persistence passed: tab/float and three-column restoration,
  no hydration autosave, empty reset/recovery restore and the same tmux shell PID.
  Fresh `renderer-parity.browser.py --pty` passed 34 transitions per renderer;
  `docking-workspace.browser.py --pty` also passed its complete interaction gate.
- During verification, moving the toolbar exposed an event-scope dependency: the
  trusted placement gesture gate still listened only inside the desktop. It now
  also listens on the top-bar docking host, retaining trusted-event and remote-
  reconciliation guards. The persistence tests failed before that fix and passed
  after it. An existing fence-message assertion and disclosure-opening fixture
  steps were also updated to the new UI; assertions remain enforced.

### Earlier assessment baseline

At `3a0262a`: local `npm run check` reported 772 passed, 0 failed and 8 optional
skips. Theme preset-switch browser tests passed on both renderers; the fresh-pane
chat browser journey passed; six publisher tests and the portable plugin checks
passed. Those results cover the preceding hotfix, not completion of this plan.
Fresh renderer and idle-control observations:

- Fresh `renderer-parity.browser.py --pty` run against an isolated copy of
  `3a0262a` and its matching production dist: **PASS**, 34 transitions per renderer,
  Chromium 145.0.7632.6, zero page errors, identical normalized behavior transcripts.
  Default revision/acknowledgement 21/21; Docking 26/26. Checkpoint-restored frames
  matched, iframe drafts survived layout-only movement and private tmux continuity
  passed. Both synthetic screenshots were inspected; no owner workspace was used.
- Exact hotfix CI passed: [plugin](https://github.com/mojomast/orbitdesktop/actions/runs/36509663378)
  and [Workbench](https://github.com/mojomast/orbitdesktop/actions/runs/36509663380).
  Green hotfix CI does not resolve the newly reported Send/discoverability issues.
- A private instrumented copy of `tests/agent-selection.browser.py` reproduced
  three periodic idle Send disable/re-enable cycles in 6.2 seconds **on each
  renderer**. New chat was not visible in either pane's normal view. The subsequent
  synthetic fresh-message, profile/session routing, draft and reload journey
  passed in each renderer with zero page errors. This is diagnostic observation,
  not a passing regression for the blink. The probe and synthetic screenshots
  remain outside Git. Its first attempt had a probe-only undefined-variable error;
  that was corrected before collecting these results.
