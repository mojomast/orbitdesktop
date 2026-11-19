# Dictation

Dictation is a Grok Bots input aid, not a standalone Orbit feature. It is opened
only from the 🎤 button in a Grok Bots window's composer. There is no Start menu
entry, command-palette command, onboarding step, capability row or separate
surface for it.

The surface records a short clip or reads an explicitly chosen audio file,
recognizes speech with the separately provisioned local Moonshine model and puts
the editable text in the window. Processing stays on the device: audio is not
uploaded, the server has no inference endpoint and there is no remote fallback.
The microphone requires browser permission and a secure Orbit window.

## Using it

1. Open a Grok Bots window in Orbit and select the conversation or group.
2. Choose 🎤. The Dictation surface opens in an ordinary browser-kind window.
3. Start and stop a recording (up to five minutes), or choose an audio file up
   to 25 MB. Recognition runs locally.
4. Review and edit the text. **Insert into selected draft** appends it to the
   Grok Bots conversation you pick; nothing is sent automatically.

Each Grok Bots window registers itself as a conversation-transfer recipient, so
the same **Choose draft…** flow used by other Orbit surfaces can deliver the
reviewed text into its composer. A Grok Bots window with no selected
conversation refuses the insert and keeps the text in the Dictation surface.
Drafts remain visible for review and are never transmitted by the transfer.

## Provisioning the model

The model is never downloaded by normal server startup. Provision it into a
private runtime directory, then point the server at the same directory when it
is overridden:

```sh
node scripts/provision_voice_models.mjs --models-root /absolute/private/runtime/models
```

The server reads `ORBIT_VOICE_MODELS_ROOT` when it is set; otherwise it uses
`<runtime>/models`. Verify an existing directory without changing it:

```sh
node scripts/provision_voice_models.mjs --verify --models-root /absolute/private/runtime/models
```

Provisioning downloads the reviewed Moonshine artifacts, checks each exact byte
size and SHA-256 pin, refuses overwrites that fail verification and writes the
model files with private permissions. Keep model assets and the runtime out of
Git.

## Asset route and limits

`GET`/`HEAD /vendor/voice/<reviewed-name>` serves only the pinned allowlist.
Unknown names, absolute or traversing paths, symlinks, hardlinks, size changes
and hash mismatches are never served. Responses use the correct content type and
are not stored as immutable by intermediaries. The browser worker is loaded from
the same origin; the page CSP permits same-origin workers and WebAssembly but no
blob scripts, CDN origin or unrestricted evaluation.

If the model is absent, the Dictation surface still opens and explains that
recognition needs provisioning. There is no cloud substitution.

## Tests

- `tests/voice-audio.test.mjs` covers resampling, duration limits and WAV
  conversion without a browser.
- `tests/voice-model-assets.test.mjs` covers the pinned manifest, private-path
  checks, symlink refusal and the exact vendor allowlist.
- `tests/voice-capture.browser.py` exercises microphone lifecycle and insertion
  through the real host surface; it runs with the provisioned model in the
  technology browser suite.
