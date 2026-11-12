# Onboarding: Connect GitHub and Repos to watch

Two steps sit between **Models** and **Review** in the setup wizard. Both are optional and dark-mode only.

```
1. Install → 2. Providers & keys → 3. Models → 4. GitHub (optional) → 5. Repos to watch → 6. Review
```

Minimal install still goes from Providers & keys straight to Review. Review then shows a card, "Optional: Connect GitHub · Repos to watch", that opens either step. Settings also has both, so a minimal user never has to go back through the wizard.

## Acceptance criteria

### Connect GitHub (optional)
1. **Skippable.** The step has a **Skip** button. Skipping stores nothing, makes no network call and moves to Repos to watch. Apply never needs a GitHub connection.
2. **Two ways to connect:**
   - **Pasted token**, either a fine-grained or a classic PAT. Orbit checks it once with `GET /user` on the GitHub API and stores it only if GitHub accepts it.
   - **Device flow** (`POST /login/device/code`, then polling `POST /login/oauth/access_token`). This needs an OAuth app client id from `ORBIT_GITHUB_CLIENT_ID`; Orbit ships none. Without one, the device option says so and points to the token option; it never fails silently. The `device_code` stays on the server, and the browser only sees `user_code`, `verification_uri`, `interval` and `expires_in`.
3. **Stored locally with tight permissions.** The token goes in `<runtime>/github/token` (file 0600, directory 0700). The login, scopes, method and timestamp go in `<runtime>/github/account.json` (0600). The token is never stored in `orbit-config.json` or in browser storage.
4. **Never logged or echoed.**
   - No response contains the token: status, connect, device, repos, settings, the setup-agent request or errors.
   - No log line contains it.
   - Errors from GitHub are reduced to fixed messages.
   - The token input is a password field that clears after submit.
5. **Status** reports only `{connected, login, method, scopes, connectedAt}`.
6. **Disconnect** in Settings (and in the step) deletes the token and the account file. The status then reads `connected: false`. Orbit cannot revoke the token on GitHub without a client secret, so the UI links to GitHub's token settings for that.
7. Token input is validated before any network call: 20–255 printable characters, no whitespace.
8. GitHub's API base can be overridden (`ORBIT_GITHUB_API`, `ORBIT_GITHUB_WEB`) for GitHub Enterprise and for tests. Only `https:` URLs, or `http:` on loopback, are accepted.

### Repos to watch
9. Observability tracks commits, PRs and CI for each repo on this list.
10. **Empty by default.** A new config has `observability.repos: []`. No repo names are hardcoded anywhere in the product.
11. Each entry is `owner/name`:
    - owner is 1–39 characters of `[A-Za-z0-9-]`;
    - name is 1–100 characters of `[A-Za-z0-9._-]`, and not `.` or `..`.
    Entries are trimmed and de-duplicated case-insensitively. At most 50 are allowed; anything else is rejected with a clear message.
12. When GitHub is connected, the step can list your repositories (`GET /user/repos`, names only) to pick from. Manual entry always works, with or without GitHub.
13. The list is editable later in **Settings → Repos to watch**, through `GET` and `PUT /api/settings/repos`, the same endpoints as `/api/onboarding/repos`. Saving an empty list is allowed.
14. The list is part of the config schema (`config/orbit-config.schema.json`) and goes to the setup agent with the rest of the key-free config.

### Both steps
15. Every route is owner-only (bearer token) and same-origin, like the other setup routes.
16. Custom-path users see both steps in order. Back and Continue work. Step numbers read "Step N of 6".
17. The colours and focus rings match the rest of the wizard, in dark mode.

## TODO (not built): connect the hyvv worker host

A later onboarding step will install or connect **hyvv** on a host. hyvv is the standalone worker host and PC launcher (`mojomast/hyvv`). The host can be this machine or one of the configured SSH hosts. The step will check `GET /v1/version` for capabilities before Orbit sends it work. Until then, no onboarding UI installs or probes hyvv; new UI and docs will use the name "hyvv" for the worker host.
