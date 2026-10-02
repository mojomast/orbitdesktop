# Browser Copilot

Browser Copilot is a reviewed host surface at `orbit://surface/browser-copilot`.
It starts a real, disposable Chromium context and supports explicit owner-staged
`navigate`, `snapshot`, `click`, `fill`, and `scroll` actions. It performs no model
inference, provider planning, arbitrary evaluation, command execution, generic CDP
proxying, or attachment to Shared Chromium / an owner profile.

## Operator configuration

- Runtime dependency: exact `playwright-core@1.58.0`, compatible with Orbit's Node 22.
- `ORBIT_BROWSER_EXECUTABLE`: trusted operator-supplied Chromium executable path.
  An absent/non-executable path reports an unavailable capability. No engine download
  or executable path is accepted through the API.
- `ORBIT_BROWSER_ALLOWED_ORIGINS`: comma-separated operator rules. Exact origins
  such as `https://example.com` retain exact scheme/port matching. Wildcards such
  as `https://*.example.com` allow subdomains (including nested subdomains), not
  the apex or suffix lookalikes, and still bind scheme and port. Add HTTP or
  nondefault-port rules separately. Include required document/subresource origins.
  The explicit `local` rule permits HTTP(S) on any port when **every** resolved
  address is loopback, unspecified, RFC1918, IPv4 link-local, CGNAT/Tailscale,
  IPv6 unique-local or IPv6 link-local. It covers local hostnames by resolution;
  mixed public/local DNS is rejected unless another origin rule matches.
  Exact/wildcard rules explicitly allow their network, including private targets.
  Empty configuration permits no navigation. Rules are operator configuration,
  never API parameters. Credentials in URLs and non-HTTP(S) schemes are rejected.
- `ORBIT_BROWSER_HEADLESS`: defaults to headless; trusted operator `0` requests a
  graphical disposable browser where a display exists.

Contexts are fresh, signed out, nonpersistent, have downloads disabled, block
service workers and WebSockets, dismiss dialogs, and refuse host file uploads.
Browser-level request routing checks documents, redirects and subresources. This
is an origin policy, **not hard OS/network isolation**: Chromium and its driver
run under the server's OS account, Chromium's Playwright launch may disable its
  sandbox, and DNS / browser networking do not establish a kernel egress boundary.
Use synthetic/public content; a configured local/private origin expressly allows
its network. This does not provide hostile-page containment or secret redaction.

## Owner journey and binding

1. Enter an allowed URL and choose **Start disposable browser**. Select an exact
   opaque session and target. Popups remain distinct selectable target IDs.
2. Take a snapshot. The pane shows bounded page text, control references, a URL
   digest and identity, and an authenticated screenshot.
3. Choose an action and its control / URL / fill text / scroll amount. **Preview**
   records exact session, target, origin, full URL hash, current revision, bounded
   observation digest and before evidence. Review both action and image.
4. **Execute reviewed action once** uses that exact proposal and a new operation
   key. Changed revision, URL, origin, text/control observation, expired proposal
   or closed target refuses execution. Control references retain the reviewed DOM
   element handles; a detached/replaced element fails instead of matching a new
   nth element. The driver rechecks the exact URL/origin at dispatch and never
   falls back to a neighbor.
   Completion includes private before/after image digests and the resulting
   snapshot. Scroll is a bounded pointer-wheel action at the viewport center.
5. **Manual owner command** uses these same bounded primitives and exact selected
   tab, with its mode recorded in the receipt. It is not desktop/VNC control.
6. **Pause** fences subsequent actions and invalidates previews. It does not undo
   an already dispatched click. **Cancel** disposes the entire fresh context to
   interrupt pending work; any dispatched uncertain operation remains `unknown`.
   Close-target and close-session are separate explicit controls.

No blind retry after a lost response: retain the operation key and use **Read
operation receipt**. The pane retains the opaque key in pane-scoped sessionStorage
across reload. Same-key/same-request replay returns a stored receipt, never a
second click; changed payload with that key conflicts. Receipts have `pending`,
`completed`, `refused` (pre-dispatch), or `unknown` states. Unknown outcomes close
the context and require a fresh start, not replay. The 30-second execution
watchdog cancels long-pending contexts; driver actions individually time out at
10 seconds. Pending receipts become explicitly unknown after a server restart;
old live browsers/targets are not adopted. Completed receipts are historical
observations, not proof an old target is still available.

A pane restored while the host is locked automatically refreshes capability and
the session list after `orbit-host-connected`. A bounded binding watcher also
detects token/workspace changes and retries failed connection reads. Unlock and
reconnect never start a browser, preview, execute or replay an action. URL, fill
text and action inputs stay intact; authenticated session/target selections,
previews, page content and evidence are cleared on a binding-generation change.
Requests pin their credential/workspace generation through workspace sync and
response delivery, so an old response cannot restore content or status after a
relock/reconnect. A changed workspace requires reopening the pane in that
workspace. Disposal aborts requests and removes the binding timer/listeners.

## Private records and retention

### Owner-mediated research handoff

After **Snapshot selected target**, select text in **Observation text**, then
**Share selected observation**. The final draft contains the excerpt, exact
session/target/revision, URL hash, observation digest, UTF-16 offsets, bounded
capture time, up to 20 control descriptions with an omitted-control count, and
truncation flag. Screenshot bytes are not shared.
Observation text is labelled untrusted historical evidence; it is not a guarantee
that the live DOM is unchanged. Local binding/snapshot changes fence insertion.

Paste one proposed operation into **Proposed action JSON**, for example
`{"kind":"fill","ref":"EXACT_OBSERVED_REF","text":"Reviewed text"}`.
**Stage proposed action** accepts only the existing finite operation shapes and
observed references and populates controls. It clears the old proposal and makes
no backend action call. Review the controls, then use the ordinary **Preview
action** and **Execute reviewed action once** sequence. All server DOM/URL/revision
checks still apply. This is explicit owner mediation, not a browser planner.

Back up the optional `<root>/browser-copilot/` directory with the private runtime.
It contains `receipts/*.json` and `evidence/{SHA256}.json|png` only; no layout,
checkpoint, workspace event, public app artifact or model payload receives page
content. New directories are `0700`, files `0600`; existing feature directories
and files with insecure permissions are refused rather than chmodded. On Linux,
every runtime/path ancestor is opened with `O_NOFOLLOW`; private reads, writes,
enumeration and deletion are anchored to directory descriptors via `/proc/self/fd`
so replacing an ancestor with a symlink cannot redirect IO. Failed temporary
writes are removed. This feature requires Linux `/proc` and the server's UID.
Reads also refuse hardlinks. Stored receipts and evidence use strict bounded
schemas, exact filename/scope/key/content digest checks and result identity checks.
All receipts validate before any pending-restart conversion; malformed data makes
the optional store unavailable without implicit repair or completed authority.
Screenshot bytes and metadata have verified SHA-256 content identities. The API
binds evidence reads to the original workspace **and** session; target identity
is preserved in metadata and captions. Screenshot/page content is sensitive and
is not redacted.

Limits: two active sessions/workspace, 120 controls, 20,000 snapshot text characters,
2 MiB/image, 40 evidence observations/session, three-day image retention, and
64 MiB total image accounting, at most 4,096 evidence metadata records and 8,192
evidence directory entries. Enumeration is bounded before loading records, and
invalid counts/byte accounting are refused. Automatic pruning runs on capture; manual retention
has preview/apply controls scoped to the requesting workspace. Byte/count limits
can remove an old image referenced by a retained receipt; that read then reports
`stale_resource`. Idle contexts close after two minutes. Receipts are durable and
bounded at 2,000 for this optional store; reaching the cap refuses new operations
rather than forgetting once-only identities. There is no automatic receipt purge.

## Integration contract (parent-owned glue)

```js
import {createBrowserCopilot} from './browser-copilot.mjs';
import {createBrowserCopilotHandler} from './browser-copilot-route.mjs';
const copilot = createBrowserCopilot({root: workspaceService.store.root,
  workspaceRead: workspaceService.read});
const copilotHandler = createBrowserCopilotHandler({token,port,devOrigins,reply,copilot});
// POST /api/browser-copilot -> copilotHandler(req,res)
// shutdown: await copilot.close()
```

Factory construction does not open private stores or launch Chromium. Dispatch
validates strict schemas and workspace existence even without the route wrapper.
The route enforces owner bearer authentication, allowed Host/Origin, 16 KiB
requests, 4 MiB responses, `Cache-Control: no-store`, and closed error codes.

Frontend: import `mountBrowserCopilot` from `src/browser-copilot-pane.ts` (which
re-exports `src/browser-copilot.ts`), then
`mountBrowserCopilot(host, () => liveToken, {paneId}) -> {dispose()}`.
There is **no separate evidence asset/image route**: authenticated POST action
`evidence` returns `{evidence:{evidence_id,sha256,bytes,session_id,target_id,
observation,media_type:'image/png',data_base64}}`. The UI uses private in-memory
`data:image/png;base64,...` image sources, compatible with existing `img-src data:`.
No credentials, paths, CDP endpoint, private HTTP screenshot URL, or public image
publication is needed. Disposing the host aborts frontend requests and removes its
DOM/images; server contexts require explicit close or idle reap.

## Verification

```sh
node --test tests/browser-copilot.test.mjs
ORBIT_BROWSER_EXECUTABLE=/tmp/opencode/orbit-evolution-browsers/chromium-1208/chrome-linux64/chrome \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/browser-copilot.browser.py
```

The browser test launches its own private HTTP/SQLite/Vite server, HOME and fresh
Playwright browser contexts with synthetic content. It exercises the actual
authenticated driver route and rendered host, clicks and fills in manual mode,
inspects loaded before/after images, pauses, creates a second target, closes the
selected target and proves it refuses while the neighbor remains untouched.
It also mounts the pane locked, unlocks/reconnects, verifies ready capability and
draft preservation without implicit launch, and delays actual service responses
past relock/workspace changes/disposal to test generation fencing and cleanup.
No owner profile, live workspace, terminal provider or model inference is used.
