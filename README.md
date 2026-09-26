# Orbit Desktop

Your workspace. Shaped by your agent. Built around you.

Orbit is an agent-customizable browser desktop powered by Hermes. Instead of adapting your work to a fixed dashboard, describe what you need: a research station, a project cockpit, an interactive asset viewer, or a tool that does not exist yet. Your agent can build the interface, place it beside your work, and refine it with you.

Conversations, persistent host terminals, web apps, and optional Linux applications share one workspace. Start with the tools you have. Ask for the tools you wish you had. Keep changing the desktop as your needs change.

**Local-first · Single-owner · Agent-operated · Yours to shape.**

![Orbit desktop with Linux application launchers](docs/images/desktop-launchers.png)

[Quick start](#quick-start) · [Linux apps](docs/XPRA_APPS.md) · [Agent guide](docs/AGENT_GUIDE.md) · [Security](docs/SECURITY.md)

**Testing branch:** see the [evolution testing guide](docs/TESTING_BRANCH.md) for
the cumulative changes, verified results, isolated test commands and remaining
gates. Optional docking is off by default; this branch is not a live-runtime
upgrade instruction.

**Comet Project Workbench:** the normal workspace menu opens an owner-approved
project inspector, exact one-shot context sharing, and supervised candidate checks
with recorder evidence and human review. [Current capabilities and limits](docs/PROJECT_WORKBENCH.md)
distinguish the working owner-mediated flow from pending native agent tools,
automatic integration, and real-Hermes acceptance.

Local loopback operation does **not** require Tailscale. Ordinary HTTP(S) hosting
and optional private tailnet access use the same application; see the
[deployment and rollback guide](docs/DEPLOYMENT.md). Deployment-specific acceptance
is documented separately from local fixture results.

## More than a chat window

Most AI interfaces end at an answer. Orbit gives the agent a workspace in which to act: create a small application, place it beside your work, configure its behavior, and help you use it. You remain in control of the files, services, credentials, and deployment.

Use familiar movable windows or switch to a spatial view. Keep an editor next to your terminal and your conversation. Desktop shortcuts bring applications back without requiring you to reconstruct the workspace.

Orbit is actively developed software, not a finished operating system or a multi-user cloud desktop. Some integrations require separate setup. The boundaries below are part of the product, not fine print.

## What you can do

### Launch real Linux applications

The optional Xpra integration provides desktop shortcuts for Chromium, Apache OpenOffice Writer, Calc and Impress, a file manager, a text editor, and a Linux terminal. Each application opens in a movable, resizable Orbit window.

These are native Linux programs running in containers, displayed through Xpra's HTML5 client—not applications compiled to WebAssembly and not VNC streams. Each launcher has its own Xpra session. Application menus and dialogs remain inside that application's viewer; Orbit does not yet map every X11 child window to a separate desktop window.

The apps have separate persistent home directories and a shared Documents volume. Closing the Orbit viewer does not quit the Linux application. Reopening reconnects; quitting inside the app ends the application. A host reboot loses running application state, while named-volume files persist.

![Apache OpenOffice Writer running through the real Xpra HTML5 viewer](docs/images/xpra-writer.png)

Setup and limitations: [per-app launchers](docs/XPRA_APPS.md) and [Xpra deployment](docs/XPRA.md).

### Work with Hermes where the work happens

Use separate conversations in separate panes. Inspect tool activity, guide an active run, respond to approvals, and use supported scheduling controls. Available features depend on the configured Hermes gateway. Chat messages, guidance, and saved drafts support up to 100,000 characters. Optional browser desktop notifications announce agent replies without including conversation content; permission is required, Orbit must remain open, and browser/OS restrictions apply.

Ask for concrete changes: “Build a timer beside my editor,” “Arrange my research workspace,” or “Change this widget without losing its old version.” Hermes receives the active workspace context and an operator guide for scoped, revision-checked changes.

### Keep your shells alive through reloads

Host terminals use tmux-backed sessions identified by stable pane IDs. Reload Orbit, unlock host access, and reconnect to the same shell. Closing a pane detaches its shell; typing exit ends it. Running processes do not survive host reboot automatically.

The Xpra Linux Terminal is different: it runs inside its application container, not as a host shell.

### Build small tools as sandboxed plugins

Publish static HTML, CSS, and JavaScript as versioned app plugins. Install disabled, test, enable, configure, update, and roll back entry references through workspace checkpoints. Content-addressed bundles keep older versions available when their files are retained.

Plugins run in sandboxed iframes. They do not receive host credentials or a privileged host bridge. Do not include secrets, private documents, or personal reports in publicly served bundles or URL-fragment configuration.

### Shape the desktop around your work

Desktop icons open existing windows, restore minimized applications, and launch configured integrations. The Desktop control reveals shortcuts without closing running applications. The old eight-window cap has been removed; resource constraints and other validation limits still apply.

Move, resize, split, reorder, and arrange windows. Adjust supported colors, wallpaper, corners, spacing, and chrome. Full viewport hides surrounding controls; it is not browser fullscreen. Core frontend changes still require loading the updated frontend once.

### Recover workspace changes deliberately

Revision-checked controller mutations and supported plugin changes create checkpoints. Restore layout, appearance, plugin registrations, configuration, and entry references.

The independent [`/recovery` console](docs/RECOVERY.md) also offers an owner-only,
persistent registered-plugin activation hold. Layout restore cannot release it;
release does not automatically re-enable apps. It does not stop running backends,
disconnected frames, cached offline pages or public app URLs. See
[workspace store operations](docs/WORKSPACE_STORE.md) before upgrading an existing
runtime: SQLite schema upgrades and legacy JSON migration require planned writer
coordination, not a live mixed-version restart.

Checkpoints are not filesystem backups. They do not restore documents, shell processes, conversations, container state, emails, or other external effects.

## Hermes plugin integration

Orbit includes a native Hermes agent plugin in [`hermes-plugin/`](hermes-plugin/README.md). It registers one `orbit_workspace` tool for scoped workspace reads, previews, revision-checked edits, history, checkpoints and confirmed restores. It defaults to read-only and requires an explicitly configured local workspace; no credentials are pasted into chat and no services start automatically.

The Hermes catalog submission is pending review. The plugin now bundles Orbit's reviewed source and an explicit setup/start CLI: no separate repository clone is needed. See the [activation guide](hermes-plugin/README.md) for installation, two-command setup/start, prerequisites and trust boundaries. Orbit opens in a browser, not inside the Hermes Desktop Electron renderer. Xpra and its Linux desktop shortcuts remain optionally provisioned integrations; their source and deployment instructions are included.

## Everyday workflows

Writing and research: open Writer and Chromium beside Hermes. Develop an outline, check sources, and save the document to the Linux apps' shared Documents folder.

Software development: combine persistent host terminals, project documentation, agent conversations, and a custom status widget. Rearrange panes without recreating terminal IDs.

Personal tools: ask Hermes to build a focused timer, notes panel, calculator, or project dashboard. Test the published app before enabling it and keep an older bundle for recovery.

Linux applications from a browser: use the Xpra launchers for documents, spreadsheets, presentations, and files. Reconnect to applications after closing their viewer without starting a whole remote desktop session.

Shared visual work: use the separately configured Shared Chromium or shared Linux desktop when a common browser or complete desktop is useful. These are distinct sessions from the per-app Xpra launchers, with different storage and control paths.

## From a request to a working workspace

> “Make a workspace for this project. Keep my shell beside our conversation, build a tool for reviewing the assets, and give me a way to compare voice takes.”

Orbit gives Hermes concrete ways to act on that request:

1. **Arrange what is already there.** Move and resize windows, split panes, adjust supported appearance settings, and preserve existing terminal IDs.
2. **Build what is missing.** Create a focused HTML/CSS/JavaScript app, publish a versioned bundle, test it, and enable it as a sandboxed workspace plugin.
3. **Iterate together.** Change configuration, refine the interface, publish a new version, or reshape the surrounding desktop as the workflow develops.
4. **Recover deliberately.** Preview supported workspace changes and restore layout/plugin settings from checkpoints when needed. Files and external actions require their own recovery strategy.

This is customization through real code and scoped controls—not a promise that arbitrary backend changes hot-swap safely. Built-in layout and plugin operations can apply live; new core features need source changes, tests, a build, and an updated frontend load. Services need separate setup and explicit trust.

## Examples: tools built around a real project

These are examples of what an agent can build with you, not a catalog of local tools bundled with Orbit. Both were developed for a game-production workflow and run as separately configured applications. The screenshots show the actual interfaces, not mockups.

### “Let me explore the assets in my game repository”

The COCS Asset Observatory turns a project's procedural geometry into an interactive 3D library. Browse maps, characters, weapons, vehicles, and materials; inspect a model with orbit/pan/zoom, change viewing controls, and see geometry statistics. Repository updates and saved snapshots support review beyond a static image.

![Agent-built COCS asset viewer showing the Puma vehicle, searchable asset library, 3D controls and geometry statistics](docs/images/cocs-agent-example.png)

The broader lesson: ask for a viewer that understands your project's data rather than forcing that data into a generic dashboard. The project-specific models and service are not installed by Orbit's quick start.

### “Build me a voice experiment bench”

The OmniVoice app organizes a voice-production workflow around editable text and direction, generation settings and seeds, a take queue, an A/B listening desk, and reusable recipes. Completed takes retain their settings and offer WAV downloads, making it easier to compare variations and return to a promising result.

![Agent-built OmniVoice experiment bench with voice controls, A/B listening desk and completed COCS announcer takes](docs/images/omnivoice-agent-example.png)

This example uses a separately configured voice backend. Orbit itself does not bundle the voice model or promise generation speed or exact seed reproducibility. The same pattern can support an analysis workbench, a review queue, or a purpose-built editor: describe the job, build a small tool, test it, and refine it together.

## Community plugin catalog

Orbit's GitHub-backed catalog accepts sandboxed static apps through maintainer-reviewed pull requests. Each app is pinned to an exact upstream commit; updates require another reviewed PR. CI validates metadata and pinned bundles without executing third-party code. The Plugin Manager shows synced catalog entries and supports disabled-first installation and explicit updates.

Read the [submission guide and admission policy](plugin-catalog/README.md). Refresh approved entries with `python3 scripts/orbit_catalog.py sync`, then rebuild/deploy the static frontend. Merge admits a listing upstream; existing desktops pick it up at their next operator sync. The initial public catalog is intentionally empty, separate from local/private tools. GitHub branch-protection settings must enforce the documented review gate.

## Quick start

The verified target is Linux with an ordinary user account, Node.js 22.12 or newer, npm, Python 3, and tmux at /usr/bin/tmux. Native node-pty builds may also require make and a C++ compiler.

For a development instance, clone https://github.com/mojomast/orbitdesktop.git,
enter the repository, then run:

    npm ci
    npm run dev

In a second terminal, start the API with the development origins explicitly allowed:

    ORBIT_DEV_ORIGINS=http://127.0.0.1:4173,http://localhost:4173 npm start

Open http://127.0.0.1:4173. Choose Connect host, enter the server's host-access token,
and connect a shell. Without a configured ORBIT_TOKEN, the server generates a token
on startup and stores it in the private runtime's `session-token` file.

`npm run build` and `npm run check` build into a separate scratch directory and
report its path; they do not replace a served checkout's `dist/`. For a served
release, use the explicit packaging, activation and compatible-backup procedure
in [deployment documentation](docs/DEPLOYMENT.md).

Host access grants a real shell as the server's operating-system user. Do not run Orbit as root or expose it directly to the public Internet.

Start the Hermes API server separately and configure its base URL and API key on the Orbit server. See docs/HERMES.md. The agent's tools need access to the repository and runtime for local workspace control.

The base setup does not automatically provision Xpra, OpenOffice, Shared Chromium, or the shared Linux desktop. Follow their deployment guides separately. The current Xpra app deployment requires Docker and uses private Tailscale HTTPS endpoints; adapt installation-specific paths and settings rather than copying credentials or private hostnames.

## Launching and reconnecting to Linux apps

After Xpra services are configured and the current frontend is loaded, reveal the desktop and select an application shortcut. Authenticate when the Xpra viewer asks.

On deployments with the Connection passwords integration, unlock Orbit host access and use Copy Xpra password. Passwords should not be placed in workspace URLs, screenshots, app bundles, or documentation. Clipboard managers may retain copied credentials.

![Copy-only connection password controls; no passwords displayed](docs/images/connection-passwords.png)

Save shared work in Documents. The Xpra Documents volume is separate from the existing VNC desktop's files. Closing a viewer is not the same as quitting the application, and a workspace checkpoint does not back up your document.

## Security and honest boundaries

Orbit is a powerful single-owner workspace, not an isolation boundary between mutually untrusted users. Keep the server on loopback and use private authenticated remote access. Do not expose Docker, X11, VNC, or browser-debugging sockets publicly.

The current per-app Xpra setup disables clipboard synchronization, file transfer, audio, webcam, printing, and arbitrary client-requested command launching. Each app runs as a non-root user in a restricted container. Network egress remains enabled, and shared documents are accessible to the apps that mount that volume.

The Xpra Chromium launcher currently requires --no-sandbox under the deployed container policy. Its internal Chromium sandbox is therefore not a security boundary. Do not treat it as a high-security browser or store sensitive browsing credentials there. Its profile is separate from Shared Chromium.

Shared Chromium and the full shared Linux desktop remain separate integrations; adding Xpra does not silently migrate or replace them. Remote-app rendering is not browser-local execution. Container restart policies are not guarantees that unsaved application state survives a reboot.

## Architecture

The browser frontend uses TypeScript, Vite, and Three.js/CSS3D. The Node.js server provides authenticated host access, workspace state, and integration routes. Hermes supplies the agent runtime through its API bridge.

Workspace operations manage revisioned layout and checkpoints. Sandboxed plugins supply static tools. Host terminals connect through node-pty and tmux. Optional Xpra services deliver containerized Linux applications through separate authenticated browser viewers.

Generated plugins are not trusted backend extensions. Host services and core changes require explicit trust, source review, testing, and deployment.

## Development and verification

Run npm run check for typechecking, the production build, and Node tests. Run python3 tests/plugin-publish.test.py for publisher checks.

Live browser tests under tests/ exercise integrations separately and require a configured deployment. Passing a build alone does not prove an app rendered or that a live browser applied a workspace mutation. Verify real interaction, reconnect behavior, and saved results before reporting success.

Preserve the owner's uncommitted changes, existing pane IDs, running sessions, and older plugin bundles. Never commit .runtime, tokens, transcripts, or private screenshots.

The desktop, Writer, and connection-control screenshots were captured in an isolated browser workspace using `scripts/capture_xpra_readme.py`. The COCS and OmniVoice examples were freshly captured from the running applications in separate headless browser contexts for this documentation release. They show the game asset library and announcer-take workflow, not the owner's desktop or conversations. No generation jobs, source updates, or live workspace rearrangements were performed for these captures. Project-specific applications shown here are examples, not dependencies or bundled local services.

## Documentation map

Agent operations: docs/AGENT_GUIDE.md
Workspace controller: docs/WORKSPACE_CONTROL.md
Plugin lifecycle: docs/PLUGINS.md
Linux app launchers: docs/XPRA_APPS.md
Xpra pilot and deployment: docs/XPRA.md
Shared Chromium: docs/SHARED_BROWSER.md
Shared Linux desktop: docs/SHARED_DESKTOP.md
Hermes configuration: docs/HERMES.md
Architecture: docs/ARCHITECTURE.md
Security: docs/SECURITY.md
Checkpoints: docs/CHECKPOINTS.md
Roadmap: docs/ROADMAP.md

## What's next

The direction is a more coherent agent-operated desktop: better application integration, clearer persistence and recovery, stronger permission boundaries, and easier deployment. Full multi-user isolation, universal backend hot-swapping, arbitrary X11-to-Orbit window mapping, and reboot-persistent running shells are not promised as shipped features.

Build the workspace you need. Keep the ability to understand it, change it, and recover it.

## Interface themes

Make Orbit look radically different with Windows XP (Luna-inspired), Classic 95, Paper Studio or Cyberpunk, alongside the existing color presets. Open **Themes** for previews and per-element customization: title bars, window controls, Start menu, taskbar, dialogs, controls and chat surfaces. XP includes blue beveled scrollbars, a green Start button and red Close controls.

Customize colors, UI font, corner radii and title-bar height without replacing panes or wallpaper. Changes save a recovery checkpoint; embedded apps and terminals retain their own styling. See [Theme customization and agent operations](docs/THEMES.md) for validated fields, reset examples, compatibility and upgrade boundaries.
