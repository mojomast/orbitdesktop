# GitHub picker review: PR #27

Reviewed `96916aa` (#25), `104c3e3` (#26), `7c5103d` (#27) and the #30 boundary against baseline `9cb894b`. Use the difference **#25 head → #27 head** to isolate the picker. The registry, adapter docs, zero-agent boot, first-run wizard, quickstart and container smoke were already present; importing the entire #27 branch would duplicate them. The signed evidence model, panel and owner route were also already present. #30 documents per-job evidence versus campaign closeout.

| F12 | Fetched PR | Local candidate |
| --- | --- | --- |
| AC-001 optional | Skippable wizard; status is local. | Manual names, Settings and Minimal install remain usable without GitHub. |
| AC-002 credential storage | Private token plus an unnecessary account metadata file. Invalid endpoint configuration silently fell back to github.com. | Only the private token is retained. Invalid endpoint configuration fails closed. Status returns connection flags. |
| AC-003 masking and removal | Masked input and disconnect, but a pending verification could restore the token after disconnect. | Late responses are fenced; removal and rejected re-authentication leave no credential file. Local disconnect is distinct from issuer revocation. |
| AC-004 selection | Empty config and explicit picks, but PR description promises observability and shares repo names with setup. | Only chosen names persist for owner review. No collectors, setup-agent disclosure, or implicit tracking. |
| AC-005 actionable failures | Denied/expired/rejected responses handled; upstream throttling not distinguished and the UI polled automatically. | Explicit code check; separate rate-limit, denial, expiry and rejected-token messages. |
| AC-006 offline | In-process and loopback stubs. | These are retained; the Chromium smoke also uses a loopback GitHub stub and disposable Orbit. |

The proposed device flow requested `repo read:org`. The local version requests no extra scopes; private names can instead be entered manually or selected with a fine-grained metadata-only token. The picker projects repository names only, takes at most the first page, and never fetches repository content. This is a local review result, not approval of the original PR. See [Config](CONFIG.md#github-and-repository-preferences) and [Quick start](QUICKSTART.md) for the user-facing contract.
