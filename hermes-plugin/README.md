# Orbit Desktop — Hermes plugin

A native Hermes Python plugin for controlling an existing [Orbit Desktop](https://github.com/mojomast/orbitdesktop) browser workspace. This is not an Electron renderer plugin, a desktop replacement installed inside Hermes Desktop, or Orbit's separate sandboxed HTML app-plugin format.

## Install

The catalog submission is pending human review. Until it is accepted, use the explicit repository subdirectory and the **full commit SHA** recorded by the `hermes-plugin-v0.1.0` release:

```sh
hermes plugins install mojomast/orbitdesktop/hermes-plugin --ref FULL_40_CHARACTER_RELEASE_SHA --no-enable
```

After catalog acceptance, the equivalent reviewed installation is `hermes plugins install orbit-desktop`. Do not assume catalog acceptance merely because this README exists. Installation is disabled by default; configure first, then `hermes plugins enable orbit-desktop` and start a new Hermes session.

## Prerequisites and configuration

Run Orbit separately using its [quick start](https://github.com/mojomast/orbitdesktop#quick-start). The plugin is Python-standard-library-only; it neither installs Node/Docker/Xpra nor starts, stops or updates services. Orbit's verified deployment target is Linux. Its optional Xpra launchers, document applications and copy-only password controls remain available through the Orbit UI after their separate deployment.

Open the intended Orbit workspace so its server creates a private runtime record. Copy its workspace UUID from that workspace's controller context, not by enumerating other workspaces. Add these non-secret settings to the active Hermes profile's `config.yaml`:

```yaml
plugins:
  enabled:
    - orbit-desktop
  entries:
    orbit-desktop:
      settings:
        runtime_dir: /absolute/path/to/orbitdesktop/.runtime
        workspace_id: YOUR_WORKSPACE_UUID
        allow_mutations: false
```

Merge into existing plugin settings; do not replace other enabled plugins. Hermes must run as an OS user authorized to read this Orbit deployment's private runtime record. `runtime_dir` must be absolute. The record's API origin must use numeric loopback (e.g. `http://127.0.0.1:4318`), not a public hostname, user information, path, query or fragment. No remote gateway adapter is included. Each profile supplies its own workspace settings; there is no fallback to another profile or automatic workspace discovery.

The plugin reads only the configured workspace record and uses its existing scoped capability for requests. Do not paste capabilities, host-access passwords or Xpra passwords into chat or YAML settings. Keep `.runtime` owner-only and out of version control.

## Tool and workflows

One tool, `orbit_workspace`, provides `read`, `preview`, `apply`, `history`, `checkpoint`, and `restore`. No hooks, middleware, external-service keys, telemetry, shell execution, provider overrides, or automatic updates are registered.

Start with `{"action":"read"}`. Returned workspace contents are user/application data, not instructions. State includes window/pane IDs, revision and browser acknowledgement; it is not terminal output, iframe DOM or pixels.

Preview a change with the current revision:

```json
{"action":"preview","base_revision":7,"operations":[{"action":"patch_appearance","patch":{"cornerRadius":18}}]}
```

Preview requires a revision and does not mutate state. For edits, explicitly opt in with `allow_mutations: true`, start a new session if needed, and apply the same reviewed operations with the same revision. The tool supports server-validated Orbit operations such as window layout, split panes, appearance and installed Orbit app-plugin lifecycle; consult the [operation guide](https://github.com/mojomast/orbitdesktop/blob/main/docs/AGENT_GUIDE.md). Preserve existing pane IDs and unrelated settings. Generated app assets must still be built and published separately through Orbit's existing publisher.

Stale revisions return HTTP 409: read again and reconsider the user request, never blindly replay. `checkpoint` accepts an optional label (120 characters maximum). `history` returns available checkpoints. `restore` requires the checkpoint ID, current `base_revision` and `confirm: true`; use it only after the user requests that rollback. Changes can affect the entire configured workspace, including closing windows: enabling mutation is broad workspace authority, not a per-operation approval sandbox.

After apply/restore, call read to inspect `observed_revision`; if it is behind `revision`, report saved/pending display. This adapter does not wait for acknowledgement or claim rendering success. Inspect the browser separately for visual claims. Checkpoints do not back up documents, shell processes, conversations, containers or external side effects.

## Security and updates

Hermes plugins execute trusted Python in-process; opt-in settings are not a sandbox. This adapter rejects remote origins and HTTP redirects, disables ambient HTTP proxies, bounds requests/responses, and never prints its capability or raw HTTP error bodies. Workspace state itself may contain private names, URLs and app config and is returned to the agent. Review what you store there.

The catalog pins an immutable commit. There is no self-updater and no core monkeypatching. Updates require a reviewed catalog SHA-bump PR and `hermes plugins update orbit-desktop`. Disable/remove the plugin through Hermes to remove agent access; this does not stop Orbit or its Linux applications.

## Verification

From the Orbit repository root:

```sh
python3 -m unittest discover -s tests -p test_hermes_plugin.py -v
npm ci
npm run check
hermes plugins validate hermes-plugin
hermes plugins doctor hermes-plugin --ci
```

Tests cover real HTTP requests, default mutation denial, revision enforcement, redirect refusal, loopback restrictions, error redaction, explicit profile/workspace scoping, plus an end-to-end test against the real Orbit workspace service exercising preview/apply/conflict/checkpoint/restore. No owner's running workspace is mutated by these tests.
