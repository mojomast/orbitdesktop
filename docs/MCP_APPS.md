# Optional MCP Apps snapshot host

Orbit can render **owner-imported, exact MCP App snapshots** using the real
`@modelcontextprotocol/ext-apps` AppBridge. This is a useful limited host for
self-contained reports, visualizations and local controls. It is not a Hermes
resource adapter or arbitrary MCP server client. There is no server discovery,
resource URL fetch, model dispatch or tool execution.

## Setup and use

Set the server gate `ORBIT_MCP_APPS=1`; there is no separate Orbit settings toggle
for this integration. Once configured, open **MCP Apps** from Start or the command
palette. Configure `ORBIT_MCP_APPS_SANDBOX_ORIGIN` as an exact HTTP(S) origin
different from the Orbit page origin. For the optional local proxy listener also
configure `ORBIT_MCP_APPS_SANDBOX_PORT` explicitly; it binds loopback. No implicit
`port + 1` selection or same-origin fallback is allowed. Remote deployments need a
separately exposed HTTPS origin and exact allowed parent origins; a client's
loopback is not the server's loopback. Proxy configuration is operator authority,
not a caller-supplied API argument.

Set both variables when an HTTPS reverse proxy forwards the configured sandbox
origin to the local listener. The listener accepts only its loopback Host and the
configured public sandbox Host. With only the origin configured, an independently
served proxy is required. With only the port configured, the advertised origin is
loopback (suitable for local testing). The proxy serves only its two static relay
paths; owner APIs are never available on this origin.

Without a usable sandbox origin the surface reports setup unavailable. Import JSON:

```json
{
  "title": "Quarterly report",
  "resource_uri": "ui://reports/quarterly.html",
  "html": "<!doctype html><script type=\"module\">/* bundled MCP Apps SDK application */</script>",
  "arguments": {"quarter": 3},
  "result": {"content": [{"type": "text", "text": "Exact tool result"}]}
}
```

HTML must be self-contained with inline scripts/styles. Export or bundle the
application using the SDK's `App` class; merely importing ordinary HTML does not
establish a protocol connection. Resource IDs are exact snapshot identities, not
fetch targets. Open a saved snapshot to replay its exact arguments and result.
Delete unused snapshots to free retention space. Failed import preserves the
textarea. Close sends SDK teardown with a bounded wait; Cancel sends the SDK
tool-cancelled notification. Apps may handle these lifecycle messages.

A surface restored while locked refreshes capabilities and the saved library on
`orbit-host-connected`; token changes are also detected by a bounded binding
watcher. Reconnection preserves typed import JSON and never automatically opens
or executes an app. Token/workspace changes abort prior owner requests, fence
their late responses, clear the old library and tear down the old app. Because
the current workspace-sync module is bound at page initialization, changing the
workspace ID requires reopening/reloading that workspace; the host refuses to
fetch a different workspace under the old synchronization binding. Manual Refresh
rechecks capabilities and the library. Disposal removes connection/storage
listeners, stops binding checks, aborts requests and closes the frame transport.

## Capability and sandbox boundary

### Complete-result snapshot staging

A complete authenticated Normal reply or available Workbench delivery card may
contain the sole-key envelope `{"mcp_snapshot":{…exact snapshot fields above…}}`.
**Stage MCP snapshot** selects one mounted MCP pane, validates the closed snapshot
contract and inserts exact JSON into its empty import editor. A populated editor,
stale mount or changed host binding refuses delivery without replacing text.
The pane reports source ID/version and unknown capability requirements (the
current snapshot schema declares none); it does not claim ecosystem compatibility.
Review and **Import snapshot** explicitly to store/open through the existing CAS
and sandbox. Staging neither fetches a resource URI nor runs an app. Imported HTML
still needs a genuine self-contained SDK implementation to initialize.

The AppBridge uses `null` for its MCP client and advertises only `{logging:{}}`.
Initialization negotiates the SDK protocol; host context supplies theme and inline
display mode. Resize is bounded to 120–1600 pixels. Tools, resource access,
sampling, message/model context, links and downloads return protocol errors. Apps
requiring those capabilities are incompatible; initialization timeout is visible.

The trusted outer proxy is on the separate configured origin. The inner app is an
opaque-origin `srcdoc` iframe with **only `allow-scripts`**. Network, external
scripts, forms and base URLs are denied by CSP. The proxy's inline-script CSP
allowance is necessary because Chromium inherits parent CSP into srcdoc; the
inner CSP removes the proxy's `script-src 'self'` authority. No forms, popups,
downloads, same-origin access or permission-policy grants are supplied. Snapshot
HTML never goes through a public asset route.

Parent→proxy messages target the exact sandbox origin. Proxy→parent messages
target the exact configured host origin. A per-mount nonce binds each session;
both relays validate source window and origin. The host removes the nonce before
passing messages through the SDK's strict JSON-RPC parser, using a private
MessagePort identity for the validated SDK transport event source. The inner app
receives neither nonce nor Orbit token. The only wildcard send is to the known
opaque-origin inner window, whose origin cannot be named; inner replies must come
from that exact window with origin `null`. Untrusted apps cannot forge
sandbox-ready messages. Detach aborts owner fetches and closes transport listeners.

## Private storage and retention

`<root>/mcp-apps/<workspace_id>/<sha256>.json` stores exact snapshots, outside
layout/checkpoints, plugin bundles and metadata events. Include this directory in
private runtime backups. Directories are 0700 and files 0600. Snapshot bytes are
fsynced and atomically linked to their content-addressed identity; reads verify
the digest and contract. Exact retries reuse the identity. New imports require
the digest of the current sorted identity set (CAS, including same-count changes);
no caller path or arbitrary URL is accepted. Dispatch is serialized synchronously
in the single owning server process; do not share writable storage between servers.
Retention is limited to **64 snapshots per workspace, 1.5 MiB per snapshot**.
An owner can delete a snapshot explicitly; deletion fsyncs its directory. Deleting
an already absent immutable identity returns the same successful `deleted` identity,
including retries after an interrupted directory fsync. Checkpoints do not roll back this data.
This is owner-controlled local storage, not an OS-UID isolation boundary.

Existing storage root/feature/workspace directories must be owner-owned mode 0700;
the service rejects unsafe modes without changing owner permissions. Every path
ancestor is checked for symlinks. Reads use no-follow descriptors, require a regular
owner-owned mode-0600 single-link file, and check size before bounded allocation.
Unexpected entries, oversized/corrupt records and on-disk retention overflow fail
closed, without automatic repair or deletion. Interrupted publication residue must
be investigated by the operator. These checks do not isolate the service from an
adversarial process running as the same OS owner and racing filesystem operations.

## Integration contract

```js
createMcpApps({ root, workspaceRead, sandboxOrigin }) // {dispatch(body)}
createMcpAppsSandbox({ hostOrigins })               // {handler(req,res)}
```

`workspaceRead(id)` synchronously returns workspace existence. Dispatch validates
scope and exact fields independently of HTTP auth. Parent wires authenticated
`POST /api/mcp-apps`, with 2 MiB request cap and existing owner origin/token checks.
Actions: capabilities, list, get(id), import(snapshot, expected_revision), delete(id).
Only the explicit proxy factory serves `/mcp-apps/proxy` and `/mcp-apps/proxy.js`.
`mountMcpApps(host,token,options?)` returns `{dispose()}`. The reserved host URL,
feature gates, route and listener lifecycle are integrated by the core shell.

## Versions, licenses and verification

Pinned packages: `@modelcontextprotocol/ext-apps@2.0.3`, client/core `2.2.0`,
`zod@4.6.5`. Client/core/Zod declare MIT. ext-apps npm declares MIT but the package
LICENSE retains MIT for prior work and Apache-2.0 for newer code; documentation is
CC-BY-4.0. Preserve upstream notices; do not describe the full ext-apps tree as
uniformly MIT. This code consumes installed SDK files without vendoring them.

Focused verification:

```
node --test tests/mcp-apps.test.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
 /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/mcp-apps.browser.py
```

The fixture builds a real SDK App with Vite and starts two ephemeral isolated
loopback origins. It verifies initialize/result replay, local interaction, seven
authority refusals, nonce/source/origin binding, cancel and detach. It also covers
locked mount/reload followed by unlock, saved-library recovery without automatic
execution, delayed old-token/get and old-workspace/list responses, draft
preservation and no reconnect after disposal. Host Vite
library build passes. This does not prove compatibility with remote ecosystem apps
or Hermes, nor Windows/Spatial renderer reconciliation (core integration tests
own those surfaces). No live runtime, provider or owner artifact is used.
