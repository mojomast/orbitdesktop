# Workspace upgrade verification

Executed against the private deployment at `https://orbit.example.invalid:4325/` using the mojo native user service.

## Automated suite

`npm run check`: TypeScript production build and 27 tests passed. Coverage includes original layout/PTYS/security, Hermes bridge auth and history, scoped workspace capabilities, optimistic revision conflicts, atomic operation batches, invalid geometry, and preview CSP/path/symlink isolation.

## Real host terminal

`node verify-deploy.mjs`: HTTPS frontend and health returned 200; auth/foreign-origin checks passed. Authenticated WSS ready metadata reported `mojo@Kimi`, cwd `/home/mojo`. The PTY executed a command that checked the account, directory, and absence of `/.dockerenv`; expected output was observed. This is a host shell, not the old node container.

## Real browser and agent workflow

`tests/browser-workspace-live.py` with Playwright:

- Moved a window by pointer dragging its title bar.
- Resized it by dragging the corner.
- Hid and restored the sidebar, and verified geometry/sidebar persisted on reload.
- Authenticated and sent a real Hermes prompt from the chat pane.
- Hermes read the workspace, hid the sidebar, renamed the terminal window to Host Workshop, wrote `examples/comet-counter-test/index.html`, published it, and opened a Comet Counter window.
- The test observed the completed agent reply and browser-acknowledged layout changes.
- The iframe displayed the expected heading and button. Clicking Add star changed `#count` from 0 to 1.
- The iframe lacked `allow-same-origin`; trying to read `parent.document` failed, as intended.
- No page JavaScript errors were observed.

`tests/browser-live.py` was rerun after the upgrade and passed: real chat reply, reload restoration, reauthentication, follow-up memory, New chat, cooperative Stop, and no page JavaScript errors.

Generated screenshots and detailed JSON receipts are local, Git-ignored artifacts. Live tests create isolated browser workspaces so they do not rearrange the owner's existing layout. The published counter demo remains available at `/apps/comet-counter-test/` and its source is included as a reusable example.

## Known boundaries

The controller sees layout metadata, not private terminal output or iframe DOM. Current app publishing serves static frontend builds; backend services need a separate scoped integration. Prior container sessions were not killed during cutover. Opening a new tab and connecting a new shell reaches the native mojo service. Service restarts still terminate its active PTYs.
