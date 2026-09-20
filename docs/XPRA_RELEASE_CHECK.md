# Xpra desktop repository verification

This update includes the previously untracked desktop UI and its imported dependencies, Xpra/shared-viewer deployment sources, copy-only credentials UI, agent guidance, and the owner-approved README. Runtime files, credentials, private project checkouts and chat transcripts are excluded.

Verification performed for this update:

- Exported the Git index into an isolated directory, linked installed dependencies, and ran `npm run check`: production build and 67 Node tests passed. This checks the staged source, not merely the larger working tree.
- `python3 tests/plugin-publish.test.py`: passed.
- `tests/connection-passwords.browser.py`: real Chromium/Xpra clipboard values matched, no secret in DOM/text, unauthenticated and invalid-service calls rejected.
- `tests/xpra-launchers-readonly.browser.py`: all seven shortcuts launch/deduplicate, Desktop minimizes, Writer restores and renders a real native canvas, no page errors. No native keystrokes sent.
- `tests/xpra-apps-lifecycle.browser.py`: invalid password rejected, reconnect did not duplicate editor process, viewer closure preserved it.
- `scripts/capture_xpra_readme.py`: generated three fresh PNGs from an isolated browser workspace; no transcript was imported.
- Staged file checks found none of the checked deployment credentials; README relative links resolve; `git diff --cached --check` passed.

Known regression / incomplete verification:

`tests/xpra-icons.browser.py` failed at its terminal keyboard-to-shared-file assertion. This shared-session interactive test is NOT a passing result for this update. Do not infer native terminal input reliability from the successful read-only launcher test. Investigation should use a disposable Xpra terminal session rather than send further commands to an owner's shared application. The earlier pilot test claims in XPRA.md are historical results.

Vite also reports an existing mixed static/dynamic import warning for shared-browser.ts. Generic browser screenshot inspection was unavailable during this run; Playwright captured the images and verified UI/canvas presence, not an independent pixel-level review.

No live service or application container was restarted. Workspace checkpoints cannot undo repository commits, containers, document changes or external publication.
