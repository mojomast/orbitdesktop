# Hermes Orbit acceptance handoff

## Goal and scope

Repository: `https://github.com/mojomast/orbitdesktop`, working directory
`/home/mojo/projects/orbit`, branch `testing/orbit-docking-managed-terminals`.
The previous published baseline is `3fec20e`; the feature candidate is the commit
containing this updated handoff and its source archive. Verify `git rev-parse HEAD`,
working-tree status, and build identity rather than assuming the branch name
identifies these changes. Publication is not deployment acceptance.

Verify the candidate on `testing/orbit-docking-managed-terminals` at a **served,
isolated test origin**, preserving iframe and terminal lifetime. Local HTTP and
ordinary HTTPS are supported. The owner's tailnet origin is an **optional extra
deployment gate**, not a prerequisite for other users.

The originating agent has not been given a test endpoint or authority to migrate
the owner runtime. Determine the candidate commit/build and authorized test origin
with the owner. Do not invent a live URL, infer credentials from private files, or
upgrade/restart an owner service. This handoff is acceptance work, not permission
to deploy.

## Discovery before changes

Read `AGENTS.md`, `docs/TESTING_BRANCH.md`, `docs/DEPLOYMENT.md`,
`docs/DOCKING_PERSISTENCE.md`, `docs/MANAGED_TERMINALS.md`, and `docs/HERMES.md`.
For useful parallel work use at most two bounded discovery agents:

1. Inspect the candidate build, served origin, schema compatibility, and whether
   the runtime/tmux namespace is disposable. Read-only; never migrate it.
2. Inspect the browser harnesses and identify deployment-specific differences
   (authentication, CSP, reverse proxy, browser version). Read-only; no mocks in
   place of actual renderer/PTY behavior.

Wait for both results. State the exact disposable resources and test plan before
making changes. Keep any necessary test-only adaptations separate from production
code and serialize overlapping edits. Preserve unrelated owner changes.

## Reproduce local gates first

```sh
npm ci
npm run check
git diff --check
git status --short
```

Use a separate Python venv with Playwright/Chromium and `PLAYWRIGHT_BROWSERS_PATH`
outside the repository. Run the candidate's isolated fixtures (read their setup
and cleanup code before execution):

```sh
python tests/agent-selection.browser.py
python tests/managed-terminals.browser.py --renderer default
python tests/managed-terminals.browser.py --renderer docking
python tests/runtime-continuity.browser.py --pty --renderer default
python tests/runtime-continuity.browser.py --pty --renderer docking
python tests/docking-workspace.browser.py --pty
python tests/docking-persistence.browser.py
python tests/renderer-parity.browser.py --pty
python tests/recovery-real-server.browser.py
python tests/workspace-store.browser.py
```

These scripts start disposable local servers. Their success is **not** evidence
for a separately deployed origin. Do not simply replace a URL in a script that
owns a private tmux namespace and uses `kill-server` during cleanup.

## Served-origin acceptance matrix

Use a new browser context and synthetic workspace/pane IDs. Keep credentials and
screenshots of private output outside Git. Never target an owner's terminals or
conversations. Test the exact built revision under both renderer choices:

1. **Placement:** group two windows as tabs, dock a third, float and resize one,
   move a splitter, and select a tab. Wait for durable save/acknowledgement. Reload
   and reconnect; assert group membership, float bounds, ordering and visible
   active content. Add/remove a referenced fixture window and verify graceful
   pruning, no blank or broken renderer, and preservation of surviving pane IDs.
2. **Continuity/parity:** retain iframe element/document nonces and unsent drafts,
   shell variable/PID and WebSocket count while repeating select/tab/dock/float,
   resize/reorder, spatial/focus/unfocus and minimize/restore. An actual URL change
   or explicit close is a negative control, not a continuity promise. A browser
   reload creates new iframe documents/WebSocket clients; assert the existing
   tmux shell's PID and fresh variable output survive reconnect, not iframe
   document continuity through reload.
3. **Managed terminals:** opening/reconciling performs no capture. Reject absent
   consent, stale revisions, wrong scopes and malformed input. Explicitly adopt
   the fixture shell, grant finite observation, read once, revoke and verify no
   late output is shown. Grant input, confirm the exact harmless fixture send,
   replay the same operation ID and prove no duplicate input. Newlines require
   separate acknowledgement. Reload and reattach the same shell. Only in a
   private namespace, replace a fixture shell and verify stale identity is denied
   rather than silently respawned. Restart only the authorized disposable test
    service: grants must be gone, while surviving tmux identity may reconnect.
    Delay a grant's revision read, click Revoke (also with no previous lease),
    and prove no stale grant POST occurs. Lose an input response after dispatch,
    retry the identical operation ID/body, and prove the harmless marker executed
    once. Closing/reopening controls must retain the unknown-send warning. Test
    explicit Release separately: it does not kill the shell, and only a later
    explicit Connect may create a new one when missing. Never delete continuity
    metadata to make a failing reconnect test pass.
4. **Recovery/store:** checkpoint layout and placement, change both, and restore
   through `/recovery`. Record current revision before mutation, returned committed
   revision, and later observed revision / `browser_applied`. Test schema-3 upgrade
   and backup rollback on **copies**, never the live owner database. A newer-schema
   database must be refused by an old binary. Verify the original backup survives.
5. **Bundles/events:** publish a synthetic immutable bundle, checkpoint a reference,
   update/restore it, exercise the dry-run retention CLI and verify byte-identical
   retained files. Events are bounded authenticated polling only; test reconnect
   and cursor reset, not nonexistent workspace SSE. No destructive deletion.
6. **Release coherence:** choose theme personalities, use the Orbit menu and
   reviewed catalog, and repeat the lifecycle checks. They must share the same
   v1 layout validation and preserve pane identity. No plugin host bridge.
7. **Hermes bindings:** with explicitly configured test profiles, bind different
   panes to different existing test sessions, preserve separate drafts, reload,
   and route status/stop/approval/activity to the selected profile. The local mock
   gateway fixture proves Orbit routing, not installed Hermes API compatibility.
   Real-model requests consume resources and need owner approval.

## Required evidence and final report

- Exact candidate commit/build, browser/version, and tested origin class.
- Assertions passed/failed individually; zero `pageerror` events is required.
- Revision/observed revision and `browser_applied` for workspace mutations. Do not
  count an event receipt as proof of rendering; inspect the visible result.
- Synthetic screenshots for placement, focus/spatial and managed-control visuals.
- Test command exit codes and private log locations, not credentials/transcripts.
- Separate local results from optional tailnet results and installed-Hermes results.
- No rolling upgrade, no automatic host-reboot recovery or test-service reboot
  supervision, and checkpoints restore layout/placement—not shell effects.

Fix discovered regressions in bounded sequential implementation workstreams,
update docs, and rerun the affected real-origin gates. Commit/push or restart a
service only with the owner's authorization; stage only the intended files. If
deployment is authorized, verify the served asset/build revision after restart
and provide the actual test link. Otherwise report the pending gate plainly.
