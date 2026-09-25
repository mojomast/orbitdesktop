# Orbit Secrets

Owner-only secret manager at https://kimi.tailec998.ts.net:4364/ in an Orbit browser window. Backend `extensions/orbit-secrets` runs independently through the trusted extension runner, bound to loopback port 4465. Tailscale Serve authenticates the owner; no Funnel/public exposure. Other identities receive 403. Local host users remain inside the trust boundary because they can forge proxy headers over loopback.

Create, list masked metadata, explicitly replace, copy with confirmation, or permanently delete with confirmation. Secret values use password inputs and are never placed in localStorage, workspace state, URLs, plugin configuration, responses to list, or logs. Copy returns the selected value only after an authenticated same-origin POST. Clipboard availability depends on browser and iframe permissions; failure is reported without rendering plaintext. Clipboard history may retain copied values.

## Storage and use

`.runtime/secrets` is Git-ignored and mode 0700. `master.key` and `vault.sqlite3` are mode 0600. Fernet authenticated encryption protects values at rest; names and timestamps remain metadata. The master key is on this same host: this is NOT protection from the owner account, root, trusted host extensions, or full-host compromise. Back up the database AND key privately together; losing the key loses values. Database deletion is not guaranteed forensic erasure of backups or disk blocks.

`python3 scripts/orbit_secrets.py list` returns metadata only.
`python3 scripts/orbit_secrets.py set MIMO_API_KEY` prompts without terminal echo. Add `--replace` for deliberate rotation. `--stdin` supports private pipes; never put literal keys in shell command arguments or chat.
`python3 scripts/orbit_secrets.py run MIMO_API_KEY -- your-command` injects only selected variables into a child. The child can expose them; only execute trusted commands. Existing processes are not modified, and credentials are not automatically enabled for providers or sent externally.
`python3 scripts/orbit_secrets.py delete NAME` permanently deletes an entry.

## Operations

`python3 scripts/extensions.py health orbit-secrets` verifies health. Use the extension runner to stop/restart this service. The runner does not provide reboot supervision. If restarted on a different port, update only this Tailscale Serve proxy. Workspace checkpoints cover the window, not vault contents, processes, or proxy settings.

Python `cryptography` is required and verified available in the deployed interpreter. Run `python3 tests/orbit-secrets.test.py` and `.runtime/browser-venv/bin/python tests/orbit-secrets.browser.py`. Tests use an isolated vault for storage tests and one disposable credential for browser CRUD; they never copy the real MiMo key. Rotating any key previously pasted into chat is recommended.
