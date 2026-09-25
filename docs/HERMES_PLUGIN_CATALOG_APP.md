# Hermes Plugin Catalog app

An authenticated browser application for discovering and installing the official Nous Research Hermes catalog. This is distinct from Orbit's static workspace-plugin manager: these packages install into Hermes, not into `/apps/`.

## Use

Open the **Hermes · Plugin Catalog** workspace window. Browse/search by name, author, description or capability; filter by category, tier and installed status. Plugin details include the full disclosure, exact SHA, platform/minimum-version requirements, declared tools/hooks/middleware/environment variables and documentation links.

Click **Unlock installs** and enter your existing Orbit host token locally. Do not paste it into a chat. Select a plugin, choose **Review installation**, read its disclosures and check the confirmation box, then **Install disabled**. The result is a real Hermes installation, not a generated prompt or copied command. Enable is a separate reviewed action. Start a new Hermes session afterwards; this app does not restart gateways or running sessions. External dependencies/API keys are configured separately, never collected here.

Desktop-only plugins target the Hermes Desktop SDK, not the Orbit renderer. Installing them does not make their UI appear inside Orbit. Native plugins can add capabilities to Hermes used from Orbit.

## Architecture and security

`extensions/plugin-catalog/` is a standalone standard-library Python service and static frontend, deployed through the trusted extension runner. It binds loopback. A private Tailscale HTTPS proxy exposes it only within the existing tailnet; it is not Funnel/public hosting. Origin/Host checks and an explicit Orbit-token unlock gate management. The server validates the token against Orbit's existing `/api/auth` endpoint, discards it, and issues an hour-long session credential. That credential lives only in frontend memory, never in URLs, storage, plugin configuration, cookies, or published app bundles. Reload requires another unlock. POSTs also require the session's CSRF value. No wildcard CORS or host command bridge is exposed. Catalog text is rendered through `textContent`.

The official source is `https://hermes-agent.nousresearch.com/docs/api/plugin-catalog.json`, discovered from the authoritative plugin-catalog documentation. Catalog metadata is cached for 15 minutes in memory. A fresh fetch is mandatory before each installation or enable action: removal-list matches, delisted names, changed SHAs, unsupported Linux platforms and unmet minimum Hermes versions fail closed. Refresh while unlocked forces another fetch. No stale/offline installs.

Only catalog names and reviewed SHAs are accepted. The server resolves the repository itself; clients cannot supply arbitrary Git URLs, filesystem paths or shell commands. Subprocesses use argument arrays, bounded output/timeouts and one-at-a-time mutation locking. Jobs and their bounded output are in memory; they are not a durable audit log.

`bridge.py` uses the configured Hermes interpreter and its ordinary installer at the exact SHA. This compatibility adapter is tested against the installed Hermes 0.20.4 CLI, whose bare-name search uses an older community index; therefore the app supplies the official catalog repository/subdirectory and SHA explicitly instead of using that older index. It forces the install scanner on even if local configuration has disabled it. It never bypasses dangerous verdicts or automatically accepts caution warnings. Packages requiring interactive scanner approval must be reviewed through the CLI. It never force-reinstalls, moves a pin, grants built-in tool override, runs a package setup script, or automatically installs dependencies. Installed names may differ from catalog keys; source metadata resolves that mapping. A stale enabled allow-list entry is explicitly disabled after installation.

Only catalog-matched Git installations recorded by Hermes are shown as installed. Bundled/local-copy plugins without install provenance are not managed. Update, removal and credential/config editing are deliberately absent in this first version. Capability grants required by newer Hermes/plugin manifests may still need the ordinary CLI flow.

## Local deployment

Run `python3 scripts/setup_plugin_catalog_local.py` from this deployment to create owner-only `.runtime/plugin-catalog/config.json`. It uses this process's `HERMES_HOME`, the actual installed Hermes interpreter and the existing `.env.deploy` public origin. It copies no credentials. The helper selects HTTPS port 4360 for this deployment. Review/change it if that port is already in use. Source code contains no machine-specific Tailscale hostname.

The non-secret config fields are `public_origin`, `orbit_origin`, `orbit_auth_url`, `hermes_home`, `hermes_python`, and `profile_label`. Other deployments should set these explicitly. `ORBIT_CATALOG_CONFIG` overrides config discovery when running directly. The extension runner locates the config beside its private runtime store; the standard runner uses a minimal environment and does not forward this override.

After source review, `python3 scripts/deploy_plugin_catalog_local.py` stages an immutable release, chooses an available loopback candidate port, activates it with explicit host-code trust, verifies health and updates only the dedicated Tailscale Serve port. It does not restart Orbit or its terminals. Use `python3 scripts/extensions.py health plugin-catalog` for checks. This is an owner-privileged service, not a sandbox. The runner does not provide automatic reboot supervision.

To stop: `python3 scripts/extensions.py stop plugin-catalog`, then `tailscale serve --https=4360 off` (substitute your configured public port). Closing the workspace window does not stop the service. Extension rollback restores service code, not Hermes installations, profile configuration or external effects. Workspace checkpoints restore only the added window/layout, not service code or installed Hermes packages.

## Verification

`tests/plugin-catalog.browser.py` checks the real deployed catalog, search/details, token unlock, explicit consent/cancel, lock, mobile layout and the same external-browser sandbox used by Orbit. Its real pinned install check runs only in a disposable Hermes home.

`tests/plugin-catalog.e2e.py` performs real browser-click installation, enable and disable using the ordinary Hermes installer in a temporary home, checks the exact recorded SHA and disabled-by-default status, and deletes the home. No plugin is loaded in a running Hermes session. It also checks hostile Host/Origin, unauthenticated access, invalid tokens, unknown names, stale SHAs, removals, traversal and minimum-version rejection. Policy edge cases use identified fixtures; installation uses the real official catalog and upstream Git repository, not mock success responses.

Core regression check: `npm run check`. Screenshots and local diagnostic output stay under `.runtime/plugin-catalog/`, not in public application assets. No owner chat transcripts or credentials are packaged.
