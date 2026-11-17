# Rizzstack Rails in Orbit

Connect the Orbit host, choose **Rizzstack Rails** in Start or the command palette,
enter a public attempt, job, campaign, session, or event ID, and choose **Inspect**.
Alternatively, choose **Rails** beside an attempt or job in [Observatory](../rizzstack-observatory/README.md).
The row preselects the ID; the shell waits for Inspect before reading. Close Rails
to return focus to that row. No ID or snapshot schema extension is required on
rows that do not support drill-down.

The signed-in shell reads the bounded `rizzstack.rails-view/1` projection. Select
a timeline mark (or use the event table) to inspect its origin event, evidence
references and available timing. The shell fetches its safe event detail by ID.
**Next page** follows a snapshot cursor; **Latest** returns to the first page.
Source freshness, partial coverage, unchecked integrity, a failed tool and a
verifier's acceptance evidence are different observations. Neither a green mark
nor a successful HTTP response establishes product acceptance.

## Authority and configuration

Orbit's `/api/rizzstack/rails/` prefix accepts owner-authenticated GETs only for
`health`, `events`, `view`, `stream`, and `feedback/export`. The shell uses its
in-memory host credential. The proxy checks Orbit's Host/Origin policy (including
browser-supplied same-origin Fetch Metadata for GET without Origin). It reads a
distinct private, regular credential file and connects to one server-configured
numeric loopback port. A browser cannot choose a backend or supply its credential.
Reader configuration for an independently authorized installation:

| Orbit server setting | Meaning |
|---|---|
| `ORBIT_RAILS_PORT` | Port of the R12 service on IPv4 loopback |
| `ORBIT_RAILS_READ_TOKEN_FILE` | Absolute path to its private reader file (owner-only permissions) |

See the [R12 service contract](../../contrib/rails_server/README.md) for the
separate ledger/reader configuration. Without it the shell reports unavailable.
GETs do not initialize, ingest, retry or attach to a terminal. The existing
`/obs-snapshot` collector proxy is **not** the Rails authorization boundary.

The reviewed static timeline is served directly from release source at
`/rails-pane/index.html` in an opaque, scripts-only frame with `connect-src 'none'`.
A document-bound channel carries only the validated projection and mark selection.
Runtime/catalog apps cannot become this renderer by choosing its slug. Observatory
frames may request navigation and receive a close notification, never owner data
or credentials. A standalone copy of the Rails static bundle published with ID
`rizzstack-rails` offers **Open Rails in Orbit** to open an empty shell chooser;
opening it outside Orbit explains the host requirement. It does not display
fixture data on failure.

Only the shell can prepare a quality rating. Typed prose becomes `[redacted]`
before leaving the shell. With no **separately enrolled** coordinator writer,
POST `feedback` returns `503 capability_unavailable`. With one, **Prepare signed
feedback** obtains a five-minute, quality-only review from the coordinator. Save
and inspect its exact bytes, sign with your independently held enrolled SSH
signing key using namespace `rizzstack-rails-feedback-v1`, paste the detached
signature into the shell, and select **Confirm signed feedback**. Never paste a
private key. A lost reply is uncertain: reconfirm only that exact same review
to recover the original receipt. Later, lookup the feedback by its target and
receipt before preparing another. Drafts and signatures are transient.

### Optional coordinator feedback enrollment

This path requires an existing independently administered SSH transport and
an explicit workspace/owner signer enrollment. Do not enable it where the
Orbit host account or its terminal can write coordinator state, alter the
forced command/profile, or access the private owner signing key. A test using
disposable keys in one account does not establish that deployment isolation.

* The coordinator operator supplies a fixed, private JSON profile (mode 0600,
  owned by the writer identity) with exactly `workspace_id`, `owner`,
  `ledger_uuid`, `ledger`, `state_dir`, `signers`. Use absolute paths into
  trusted private directories. The target's job authorization must verify
  under the coordinator's **existing** key and name that human `by` identity.
  No model-provided `actor`, workspace capability, generic SSH login or job
  seal alone can authorize an annotation.
* The profile's private allowed-signers file must already contain the exact
  `WORKSPACE_UUID:OWNER namespaces="rizzstack-rails-feedback-v1" ssh-ed25519 PUBLIC_KEY_DATA`
  enrollment (no wildcard or shared unrestricted key). The private signing key
  belongs to that human outside Orbit. No route creates enrollments. Removing
  the enrollment prevents new confirmations and receipt replay.
* On the coordinator, restrict the **distinct transport identity** to an
  existing SSH forced command invoking the installed
  `bundlebees_plugin.rails_owner_bridge` with that fixed profile. Disable PTY,
  shell, forwarding, user RC and agent access. Pin the installation, interpreter
  and working directory; ignore SSH_ORIGINAL_COMMAND, caller environment and
  caller-supplied arguments. The command consumes one bounded JSON document
  on stdin and terminates. No daemon, listener, scheduler, job approval key or
  writable R12 instance is added. Do not configure if no such restricted
  transport and separation already exist.
* Orbit's opt-in settings are `ORBIT_RAILS_FEEDBACK_WORKSPACE` (an existing
  registered workspace UUID), `ORBIT_RAILS_RELAY_USER`, `ORBIT_RAILS_RELAY_PORT`
  (numeric IPv4 loopback SSH endpoint), `ORBIT_RAILS_RELAY_IDENTITY` (relay-only
  identity file) and `ORBIT_RAILS_RELAY_HOST_KEYS` (pinned known-hosts file
  with exact alias `rails-feedback-coordinator`). Only the trusted server reads
  the last two; give it no coordinator or approval keys. Existing workspace
  recovery hold blocks submissions. With any required setting absent, the
  write route stays disabled.

**Retry remains unavailable.** R15 implements revision/fence-bound queue
operations but this checkout registers no coordinator `rails_retry` claimant
that can revalidate a delegated workspace owner on claim and commit. A
feedback-scoped signing enrollment does not fill that role. The existing
interactive job/recovery authorization is not a workspace-bound retry session.
`interventions` returns `503 capability_unavailable`; no request is enqueued,
no retry is dispatched, and approvals remain disabled.

## Reproduction

Use Node 22.12+ with Orbit dependencies, Python 3 and an installed Playwright
Chromium (`CHROMIUM_EXECUTABLE` may name a compatible local browser).

```
node --test tests/rails-ui.test.mjs tests/rails-proxy.test.mjs tests/rails-feedback.test.mjs
python3 tests/rails-live.browser.py
python3 tests/rails-live.browser.py --signed-feedback
```

The browser fixture builds to scratch, opens a new profile and boots disposable
Orbit and R12 servers with synthetic credentials and ledger records. It checks
owner refusal, frame isolation, selected event identity, stream invalidation,
reader restart/revocation and focus restoration. This proves local integration,
not production proxy configuration or Windows worker coverage. The signed variant
uses a sibling BundleBees checkout, test-only Paramiko SSH peer and OpenSSH key
tools. It records real R11 feedback against a job sealed with a new disposable
coordinator key, drops the committed response, then checks the original receipt.
