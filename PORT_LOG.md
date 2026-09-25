# Port log: reconcile/port-onto-0.2.7

Trunk target: origin/main @195d529 (release 0.2.7). Main and the live workspace are untouched.

## Corrected understanding of the theme split

Earlier guidance said the two lines had two incompatible theme architectures. That was
wrong, and the diffs prove it. `theme-tokens.ts` and `theme-picker.ts` are **byte-identical**
on both lines (md5 verified), as are `theme-icons.ts`, `theme-icon-surrounds.css`,
`theme-nous.css`, `theme-personalities.css`, `theme-taskbars.css` and `theme-95.css`.

The 14-preset catalogue is byte-identical too. So the token contract was never forked.
Our line *extends* the shared contract additively; it does not replace it. The port is
therefore an additive merge for the theme layer, not the two-architecture refactor that
was originally described.

## Slices

- **Slice 1 — theme layer (DONE, commit 045a73a).** New: `orbit-menu.ts/.css`,
  `theme-menus.css`, `theme-coverage.css`. Modified: `theme-chrome.ts` (import the two new
  stylesheets), `theme-chrome.css` (derived `--theme-menu*`/`--theme-dock*`/`--theme-background`
  tokens; exclude `.orbit-logo`/`.orbit-menu-*`/`.orbit-toolbar-item` from the blanket button
  rule), `theme-xp.css` (XP chat skin, a pure superset of upstream). Owner-private brand files
  deliberately excluded so a clean checkout builds. Build green.

## Blocking finding for slice 2

Our UI modules (`spatial-controls.ts`, `spatial-layout.ts`, `mobile.ts`, `layout-switcher.ts`,
`onboarding.ts`) do **not** compile against upstream's types: they reference
`Monitor.spatial` and `DesktopScene.frameAll`, which exist only in our `model.ts` / `scene.ts`.
Dropping the modules in produces TS2339 errors (verified). So before wiring can be ported,
the *core type contract* has to be reconciled first — and that is exactly where upstream also
changed `model.ts` / `scene.ts`. This is the real reconciliation work, not a file copy.

## Remaining slices

2. Core types: reconcile `model.ts` / `scene.ts` (add `Monitor.spatial`, `DesktopScene.frameAll`
   and any other ours-only extensions) as the dependency for everything below.
3. UI wiring: `main.ts`, `desktop-icons.ts` (folder grouping), `workspace-appearance.ts`,
   plus the module set from the blocking finding.
4. Server: `agent.mjs` (shared-chats link/validate path), add `shared-chats.mjs`,
   `mobile-proxy.mjs`, `mobile-security.mjs`. Note upstream has `automation.mjs` which we lack.
5. Owner-brand themes: on-host only, never committed (matches main's posture).
6. Content corpus: `extensions/` (90), `apps/` (55), `docs/`, `tests/`.

## Reversibility

Each slice is one commit on `reconcile/port-onto-0.2.7`. Revert a slice with
`git revert <sha>`; abandon the whole port by deleting the branch — main, the backup
bundle and `backup/pre-reconciliation-20260925` are unchanged.

## Known pre-existing test failure (not caused by the port)

`tests/agent.test.mjs:131` "unconfigured bridge fails closed" expects 503, gets 202, so
77/78 pass. Slice 1 touches only theme CSS/TS; it cannot influence the server bridge path.
Pre-existing on origin/main / environmental.
