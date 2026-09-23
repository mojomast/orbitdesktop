# App catalog experience

Open Workspace plugins or press Ctrl+Alt+P. The catalog combines the local feed with `orbit-community-catalog.json`, produced by the reviewed GitHub catalog sync. Filter by source, category, installation status or available updates; search titles, IDs, categories and descriptions.

Community cards show maintainer, license, exact commit, a pinned GitHub source link and declared network/storage usage. Declarations are informational, not enforced permissions. Apps install disabled and lifecycle changes retain revision checks and checkpoints. Updates require explicit confirmation; delisted installed apps remain manageable.

Refresh reloads deployment feeds and workspace state. It does not download new GitHub submissions or run the operator sync. Follow `plugin-catalog/README.md` for review and synchronization. The Publish your app link currently targets the foundation branch until that PR merges.

The responsive catalog uses a discovery header, adaptive cards, sticky filters, keyboard focus indicators and reduced-motion support. Advanced manifest import and recovery remain separate from browsing. Configuration and window settings currently retain the existing JSON prompts.

Verification: `npm run check`, then run `tests/orbit-catalog.browser.py` with Playwright. The browser test downloads a real pinned GitHub bundle, publishes it, verifies source/category filtering and a 390px layout, then installs, enables, renders, updates, disables, delists and removes it on an isolated server. Test-only release metadata is not a public catalog submission.
