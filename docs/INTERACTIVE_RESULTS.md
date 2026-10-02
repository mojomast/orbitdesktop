# Interactive results — actual A2UI v0.9 cards

Open **Interactive results** (`orbit://surface/interactive-results`). Paste JSON,
choose a JSON/NDJSON file, or drop one onto the pane. **Load editable comparison**
is a synthetic, editable example using the actual protocol: decision notes,
option selection, a review checkbox, and an explicit summary button. No model is
needed to use or test it.

**Apply incremental updates** appends a message/batch to the current producer
stream. **Import JSON** starts a new result with a new source identity. Edit
fields, **Save result**, and reopen it from the private library. **Pin result**
saves its pin and sorts it first. **Export JSON** downloads the producer stream;
user edits are stored separately in the private library rather than rewriting
the original result. A page reload recovers saved results; a same-pane remount
also recovers its in-memory unsaved draft. Invalid imports/updates and failed
saves show an error and retain the current card and edits.

## Producer format (honest boundary)

Complete authenticated Normal replies and available Workbench delivery cards
offer **Open interactive result** when the adapter accepts the exact text. Choose
one already-open results pane; its inbox acknowledges a unique queued delivery.
**Open queued result** renders it, with explicit confirmation before replacing a
displayed card; save existing edits first. Each workspace/pane inbox holds at most
eight entries. Concurrent deliveries remain separate, and overflow refuses rather
than replacing entries. Disposal or credential/workspace rebinding discards the
ephemeral inbox and invalidates old mount-generation selectors. Optional trusted
`onAcknowledgement` callbacks receive `rendered`, `discarded` or `stale` with the
exact delivery/workspace/pane/generation identity, at most once. Rendering and
private saving are separate acknowledgements. Normal actions are attached to the
just-completed response; cached transcript text alone is not authenticated anew.

The renderer is pinned `@a2ui/lit@0.12.0` and
`@a2ui/web_core@0.12.0`, imported through **`/v0_9`**, not their deprecated v0.8
root entrypoints. `@a2ui/markdown-it@0.2.0` satisfies the package peer; Orbit does
not enable markdown rendering for these results.

There is no claim that Hermes automatically emits A2UI. The primary, always
usable producer is an explicit JSON import. The trusted parent can adapt a
complete, already authenticated Hermes/Workbench result **only when its exact
text contains one of these envelopes**:

````text
```a2ui
[...actual v0.9 messages...]
```
````

or a top-level JSON object containing only `{ "a2ui": [...] }`. Plain result
text returns `unavailable`; there is no guessing, scraping, or interpretation of
truncated activity output. Envelope text is bounded to 65,536 UTF-8 bytes.

Minimal editable result (import this complete JSON array):

```json
[
  {
    "version": "v0.9",
    "createSurface": {
      "surfaceId": "decision",
      "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"
    }
  },
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "decision",
      "components": [
        {
          "id": "root",
          "component": "Column",
          "children": ["description", "notes", "button"]
        },
        {
          "id": "description",
          "component": "Text",
          "text": "Option A is simpler. Option B is more flexible. Record your decision."
        },
        {
          "id": "notes",
          "component": "TextField",
          "label": "Decision notes",
          "value": { "path": "/notes" }
        },
        {
          "id": "button",
          "component": "Button",
          "child": "buttonText",
          "action": { "event": { "name": "prepare_summary" } }
        },
        { "id": "buttonText", "component": "Text", "text": "Prepare summary" }
      ]
    }
  },
  {
    "version": "v0.9",
    "updateDataModel": {
      "surfaceId": "decision",
      "path": "/",
      "value": { "notes": "Prefer A for this task." }
    }
  }
]
```

Then edit the notes and apply this batch with **Apply incremental updates**:

```json
[
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "decision",
      "components": [
        {
          "id": "description",
          "component": "Text",
          "text": "Updated comparison: B also requires more maintenance."
        }
      ]
    }
  },
  {
    "version": "v0.9",
    "updateDataModel": {
      "surfaceId": "decision",
      "path": "/notes",
      "value": "Producer now recommends B."
    }
  }
]
```

The updated description renders while your notes remain intact. A conflict
banner names `/notes`; **Use incoming value** explicitly removes your override
and uses the latest producer value. Updates cannot rebind an edited input to a
different component identity. A changed source ID/version or replacement of a
previously saved stream requires a new import, never a silent reassociation.

## Closed rendering policy

The actual official `MessageProcessor`, `Catalog`, and `<a2ui-surface>` perform
rendering and component validation. The catalog contains the official reviewed
implementations of `Text`, `Card`, `Row`, `Column`, `Button`, `TextField`,
`CheckBox`, `ChoicePicker`, `Slider`, `Divider`, `List`, and `Tabs`; its local
function registry is empty. There is one surface per result. Static child trees
are bounded and cycle-checked. Inputs require absolute JSON Pointer bindings.

Media, arbitrary components/catalogs, function calls, expressions, custom HTML,
themes/styles, custom markdown settings, regex validation and plugin injection
are rejected. URLs (including embedded markdown links, `javascript:` and `data:`)
are forbidden in producer data and saved edits. The catalog's literal protocol
ID is the only URL exception. Text is data, never executable source.

**Important 0.12.0 renderer detail:** official basic-catalog Text has both a Lit
context markdown renderer and a global markdown fallback. Merely leaving a
renderer unconfigured is insufficient if another host module installs one.
This host blocks inherited context requests and normalizes body Text to the
official escaped `caption` rendering branch (styled as ordinary text). Explicit
heading variants remain headings. Thus neither contextual nor globally installed
custom markdown code is used, and the official `unsafeHTML` branch is unreachable
for this feature. This is an admission/rendering adapter around the published
renderer, not an invented component renderer.

Official DataModel writes adopt object references. The host clones every batch
separately for the displayed processor and the incoming baseline. User edits
cannot mutate either the saved producer stream or the incoming comparison data.
Data subscriptions record `user_values` independently; incremental processing is
suppressed from that edit recorder, then dirty values are overlaid before display.

Bounds: 256 KiB/document, 256 messages, 2,000 traversed data/tree nodes, depth 32,
16,384 characters/string, 128 components/batch, 128 saved results/workspace,
60-character titles, 4,096 durable retry receipts, and a 64 MiB private library.

## Private storage and API

`createInteractiveResults({root, workspaceRead})` performs no IO on construction
and returns `{dispatch(body), close()}`. `root` is the private runtime root.
Parent mounts authenticated **POST `/api/interactive-results`**, using the
existing owner route helper (token/origin checks and 1 MiB request cap). The
service itself validates exact request shapes and workspace existence.

Storage is `<runtime>/interactive-results/<workspace_id>/library.json`, directory
mode `0700`, file mode `0600`. Include this directory in complete runtime backups.
Reads/writes refuse symlinked feature directories/files. Updates hold an exclusive
private write lock, write a fresh `0600` temporary file, fsync, atomically rename,
and fsync the directory. Records and retry receipts commit in the same file.
After a process crash that leaves `.write-lock`, remove that lock only with the
service stopped and the runtime backed up; ordinary requests fail closed as busy.

The private records are independent of layout checkpoints and metadata events.
Restoring a layout does not roll result edits back. No files are published under
`apps`, and none belong in Git.

Actions:

- `list`: `{action, workspace_id}` → `{items}` (bounded metadata, pins first).
- `read`: `{action, workspace_id, id}` → `{record}`.
- `create`: `{action, workspace_id, op_id, title, messages, user_values, source,
pinned?}` → `{record}`.
- `update`: `{action, workspace_id, id, op_id, expected_revision, title, messages,
user_values, source, pinned}` → `{record}`.

`source` is `{id: string, version: string}`: the exact source selector/version,
not a path, URL, credential or conversation identifier. Explicit imports receive
a fresh opaque source ID. `user_values` maps bound absolute data paths to
strings, finite numbers, booleans or string arrays. A record includes its
revision, timestamps and SHA-256 digest of policy version, protocol, exact source,
messages and user values. Every read validates the policy and digest.

An update requires the current `expected_revision` and an unchanged source plus
exact prior message prefix. Stale revisions return `stale_resource`; source or
stream replacement returns `conflict`. An exact `op_id` retry returns the original
committed record even after later edits. Reusing that key with a different payload
returns `conflict`. The client keeps the exact pending save key after uncertain
responses and retains edits on all failures; it never silently retries against a
new revision.

## Parent integration and draft handoff

```ts
import {
  mountInteractiveResults,
  queueInteractiveResult,
} from "./interactive-result-host";

// Called explicitly from a trusted, authenticated complete result snapshot:
const result = queueInteractiveResult(
  text,
  {
    id: resultId,
    version: exactResultVersion,
  },
  { paneId, generation: selectedTarget.generation },
);
if (result.status === "queued") {
  // deliveryId/paneId/generation acknowledge queueing, not rendering or saving.
}

// Trusted host-surface mount:
const view = mountInteractiveResults(host, getLiveOwnerToken, { paneId });
// Also supported: options.initialResult = {text, source:{id,version}}.
// On pane disposal:
view.dispose();
```

`extractInteractiveResult(text)` is separately exported from
`src/interactive-result-adapter.ts`. Helpers are ordinary reviewed module exports;
there is no global browser entrypoint or generated-frame bridge. The host URL
carries no token, source ID, JSON, arbitrary component or code.
`interactiveResultTargets()` lists mounted targets with their generation.
`queueInteractiveResult` requires a selected mounted pane. It never guesses a
recipient or retains content for an unrelated future mount. Trusted callers must
retain and pass the selected generation. No automatic producer update is inferred
from another complete result; use the existing explicit incremental-stream path.

**Prepare summary** captures bounded rendered text and current field values,
including the exact source ID/version. For a saved document it checks the saved
revision/source/stream before opening the existing conversation-transfer preview,
and again on the user's insertion click. Changed local fields or source snapshots
fence insertion. One explicitly selected registered conversation receives the
text in its draft. Cancel inserts nothing; no model request or automatic send is
performed. Closing the surface cancels its owned preview, aborts requests, clears
subscriptions/processors/observers and detaches the official surface.

Restored panes may mount before the owner unlocks host access. The host listens
for `orbit-host-connected` and watches credential/workspace binding changes. It
reloads the saved library after unlock without replacing the rendered card or
local edits. Requests capture the exact credential and workspace binding;
binding changes abort outstanding requests and fence late responses. A changed
workspace selector fails closed until the original workspace is reopened.
Transient service failures retry after three seconds; connected library metadata
refreshes every fifteen seconds. Disposal removes reconnect listeners, clears the
timer, and aborts binding-scoped requests.

## Focused verification

```sh
node --experimental-strip-types --test tests/interactive-results.test.mjs
/tmp/opencode/orbit-evolution-browser-venv/bin/python tests/interactive-results.browser.py
# Import/render spike only:
/tmp/opencode/orbit-evolution-browser-venv/bin/python tests/interactive-results.browser.py --spike
```

The browser fixture uses real Vite and the pinned official renderer, an actual
private feature store in a disposable directory, synthetic workspace sync and a
synthetic registered chat-draft recipient. It exercises edits, incremental updates,
conflicts, save/reload/pins, stale CAS/source fences, summary cancellation/draft-only
insertion, remount/disposal, a globally installed hostile markdown renderer and
literal hostile HTML text, and narrow width. It contacts no provider or owner
runtime. These checks establish the feature behavior, not visibility in a live
owner workspace; parent wiring/full-build checks are separate integration checks.
