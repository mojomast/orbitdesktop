# Unified taskbar and named layouts

The bottom taskbar combines Start, open/minimized window tabs, local/sync save status and a bottom-right named layout switcher. Minimized windows have a restore arrow and dashed marker; no second floating minimized-window bar is displayed. The obsolete footer is removed. The taskbar remains bottom-aligned even when the older navigationPosition override is top; full-viewport mode still hides it. Start has a distinct orbit mark, Chat/Terminal/Browser quick launch, search, arrow-key navigation and Escape dismissal.

## Named layouts

Use the bottom-right button, enter a name and choose New from current. The new layout starts as a copy of current positions. Change its view/positions/scaling; changes are automatically saved. Switch to another name to restore it. Rename and confirmed Delete are available; deleting applies the next remaining layout and never closes applications. Keep at least one layout; maximum 32.

Each layout remembers Windows (2D) or Spatial (3D), frame geometry, spatial geometry and resolution, both text sizes, legacy geometry, selected window, minimized IDs, arc and camera. The collection can mix 2D and 3D layouts; this is not simultaneous flat/spatial window compositing. Apps, pane trees, window names, plugins and appearance remain shared. Missing/closed windows are not resurrected; new windows are retained. Layout changes update existing monitor objects and do not recreate panes. Switching renderer hosts can still reload iframes; this is not a guarantee of unsaved iframe state retention.

The collection is browser-local under orbit.layouts.<workspace ID>, not a list of separate server workspaces. Clearing browser storage removes it. The active resulting geometry uses ordinary workspace sync; the layout collection itself is not synchronized across devices, exported by normal workspace export, or captured by server checkpoints. No new backend operation or restart was required.

## Deployment and verification

Production build served by the live HTTPS endpoint was exercised in isolated browser storage, never by editing the owner's live workspace. npm run check passed 82 tests. tests/layout-switcher.browser.py passed against the live endpoint: create/rename/delete, mixed 2D/3D switching, independent font restoration, reload persistence, unchanged window IDs and connected DOM nodes, single-taskbar minimize/restore, Start search, and center-point hit tests at widths 390/700/1024/1600. No page JavaScript errors. tests/view-scaling.browser.py also passed on the production preview.

Existing pages require one reload for JavaScript changes. No backend or terminal restart was performed. Build rollback backup: .runtime/unified-taskbar-backup-1790190887/dist. Workspace checkpoints do not roll back source/build files or the browser-local layout collection. The normal browser screenshot tool was unavailable (HTTP 500); Playwright interaction and DOM hit-testing supplied browser verification instead.
