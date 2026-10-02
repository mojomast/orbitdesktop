# Private canvas

Canvas documents are `scene/excalidraw` records in the private
[document store](DOCUMENTS.md). The editor is the real pinned
**`@excalidraw/excalidraw@0.18.1`** component with **React/ReactDOM 18.3.1**.
The parent selected React 18 because Excalidraw's pinned nested Radix packages
have React-18-only peers; Excalidraw's own React-19 peer declaration is not enough
to establish a compatible whole dependency graph.

## Reviewed lazy island

`src/canvas-editor.ts` dynamically loads React, `react-dom/client`, Excalidraw
and its CSS only when a canvas opens. It mounts a real `createRoot` React island
inside a native shadow root. The pinned CSS is injected into that shadow root,
with upstream `:root` selectors rewritten to `:host` so direction and stacking
variables work locally. Excalidraw resets cannot restyle the Orbit shell.

The native host stays connected through normal pane movement, Windows↔Spatial
and focus reconciliation. React is not the desktop framework; the ordinary
Orbit pane retains placement/identity. There is no iframe or generic message
bridge. Disposal unmounts the React root and removes the island.

Narrow panes use an owned, clipped horizontal viewport around the engine's
finite 800px usable inner footprint. The native centered toolbar never extends
left of its inner canvas; ordinary control scrolling/clicking stays inside the
assigned pane even at 180px. Wider panes use their existing available width.
Resizing preserves the same React root, canvas DOM and scene; it does not
maximize the user's pane or change neighboring desktop placement.

## Drawing, saves and export

The engine supports rectangles, ellipses, diamonds, lines/arrows, freehand strokes,
text and frames. Tools operate on actual canvas geometry. Native undo/redo and
selection remain inside the canvas, with global keyboard handling disabled.
Library/cloud collaboration and AI are not enabled. Embedded binaries, image
tools and embeddable frames are disabled/refused by the storage schema.

Canonical content is bounded **512 KiB UTF-8** `.excalidraw` JSON:

```json
{"type":"excalidraw","version":2,"source":"Orbit","elements":[],
 "appState":{"viewBackgroundColor":"#ffffff"},"files":{}}
```

Only scene content and finite background/grid settings are saved. Transient
selection, collaborator maps, application dialogs and host credentials are not
scene data. `files` must be empty. Unsupported/oversized engine edits show an
error and retain the current client draft for correction. Save and export
validation refuse unsupported content instead of silently dropping shapes or
persisting an older scene. Convert unsupported text using the reviewed font
selector, remove unsupported assets or reduce an oversized scene before
exporting. Unsupported cached content is not loaded into the engine after reload.

**Export JSON** downloads the current draft as `.excalidraw`, including unsaved
supported edits. Save, conflict, exact-retry and pane-cache recovery semantics are
the same as rich documents. No collaboration service, CDN application build,
automatic graph links or content-derived edges are introduced. PNG export is not
part of this surface.

## Reviewed scene replacement and selected sharing

**Import / review replacement** accepts canonical `.excalidraw` JSON (empty
`files`, supported elements/fonts) or a revision-and-draft-digest-bound proposal;
see [Documents](DOCUMENTS.md). Review displays literal before/after scene elements
and properties, then changes the draft only. The real public `updateScene` API
captures an immediate native-history entry. Removed elements receive tombstones;
incoming elements retain IDs/bindings and receive fresh version metadata so native
Undo can observe changed elements. No call to `history.clear()` occurs on proposal
application. Explicit saved-content reload still resets history.

Native snapshot Undo restores visible scene content, not a byte-identical archived
JSON document: Excalidraw owns version/versionNonce metadata, history deltas and
transient selection. It is not a merge protocol, element-level conflict resolver,
or cross-reload history. Full-document proposals bind the whole current draft
digest; stale drafts or saved revisions are refused before application. Save and
its independent CAS/exact receipt remain separate.

**Share selected content** includes exactly the selected elements and their IDs
as a labelled scene-selection excerpt. Bindings to unselected elements may remain
as references; the excerpt is not advertised as a standalone importable scene and
does not silently disclose the rest of the canvas. The bounded literal payload
includes draft digest/base revision and previews into one selected chat draft.
Dirty/unknown-save close recovery restores the original pane UUID from Document
library, preserving exact pending operation identities and divergent pane drafts.

## Local asset contract and actual licenses

Before importing Excalidraw the host sets:

```ts
window.EXCALIDRAW_ASSET_PATH = '/vendor/excalidraw-0.18.1/';
```

The integration build serves the exact pinned package's approved subset of
`dist/prod/fonts/<family>/<file>.woff2` beneath
`/vendor/excalidraw-0.18.1/fonts/`, retaining hashed filenames. Only **Assistant,
ComicShanns, Excalifont, Lilita, Nunito and Xiaolai** are published. The CSS's
Assistant files are also bundled by Vite. Publish the complete checked-in
`docs/licenses/EXCALIDRAW_FONTS.txt` beside the fonts and keep a manifest of
packaged files. Cascadia, Virgil and Liberation directories are excluded.

The exact scene text font IDs are **5 Excalifont, 6 Nunito, 7 Lilita One,
8 Comic Shanns**. The reviewed native **Text font** selector offers these four;
it calls the real engine's public `updateScene` API and
`convertToExcalidrawElements` to change the next text family or recompute selected
text geometry. Font changes enter the real undo history. The original font
popover is replaced inside the island so native selection works reliably across
the shadow boundary. Assistant
is UI text, Xiaolai is Excalifont's OFL CJK fallback, and emoji uses local system
faces. Scene validation rejects legacy/system/export font IDs 1, 2, 3, 4 and 9
before rendering, storage or export. A legacy imported scene must explicitly
convert its text to IDs 5–8 before admission; it is not silently substituted.

Excalidraw 0.18.1 has **no public registerFonts/unregisterFonts or font-list prop**:
its `Fonts.register` is private and the class is not exported from the package
entrypoint. Therefore `server/documents-canvas-assets.mjs` supplies a narrow
pinned Vite adapter that removes the four legacy/system/server font registration
calls from the actual engine registry. Exclusion is not CSS hiding. It verifies
the exact installed dev/prod source SHA-256 fingerprints, checks the four
registration removals and one fallback replacement, and refuses a changed
source/pattern. The canvas mount checks the fingerprinted build marker before
rendering. The same policy runs inside Vite's esbuild dependency prebundling,
so development optimization cannot bypass it and transitive CommonJS modules
continue to be correctly bundled for browsers.

Font licensing is distinct from the Excalidraw library's MIT license. Font
metadata was inspected directly from the installed package's WOFF2 name tables;
the pinned upstream `v0.18.1` font source comments were also inspected.

| Family in pinned package | Copyright / license |
| --- | --- |
| Excalifont | © 2024 Excalidraw; SIL OFL 1.1; full license in pinned upstream font source |
| Comic Shanns Mono | © 2018 Shannon Miwa, 2023 Jesus Gonzalez and Rodrigo Batista de Moraes, 2024 Fini Jastrow and Kyle Beechly; MIT |
| Xiaolai | © 2020 LXGW; SIL OFL 1.1; full license in pinned upstream font source |
| Assistant | © 2020 Assistant Project Authors; © 2010 Source Sans Pro Authors; SIL OFL 1.1 |
| Nunito | © 2014 Nunito Project Authors; SIL OFL 1.1 |
| Lilita One | © 2011 Juan Montoreano, reserved name Lilita One; SIL OFL 1.1 |

OFL permits redistribution bundled with software with the full copyright/license
notices, retaining licensing and reserved-name rules; MIT requires its copyright
and permission notice. The actual bundled Liberation Sans was identified as
old 1.05/GPL+font exception and is excluded from publication, registry, admission
and exports. No old Liberation corresponding-source obligation is left in the
approved font distribution. Cascadia is also excluded, so its proprietary-looking
embedded Microsoft metadata is neither shipped nor used as license evidence.

Review sources:

- Pinned metadata/full licenses: `excalidraw/excalidraw`, tag `v0.18.1`,
  `packages/excalidraw/fonts/{Excalifont,ComicShanns,Xiaolai}/index.ts`.
- Additional OFL notices: Google Fonts `ofl/{assistant,nunito,lilitaone}/OFL.txt`.
- Full shipping notices, including exact bundled reserved-name/copyright entries:
  [EXCALIDRAW_FONTS.txt](licenses/EXCALIDRAW_FONTS.txt).

The unmodified upstream loader appends an esm.sh fallback even when a local
asset path is configured. The fingerprinted adapter replaces that fallback with
the same-origin `/vendor/excalidraw-0.18.1/` URL before bundling. Thus a missing
local font cannot trigger an esm.sh request, independently of CSP. The real
browser fixture additionally forces local Excalifont 404 responses and verifies
that the actual failure/fallback path produces no external request. The supported
registry has no Liberation fallback: Excalifont uses Xiaolai/system emoji; the
other offered text families use system emoji.

### Parent Vite integration

```js
import {canvasFontPolicyPlugin, isPublishedCanvasFont}
  from './server/documents-canvas-assets.mjs';
// Add canvasFontPolicyPlugin() to plugins (it also configures prebundling).
// In the existing font walker: publish only isPublishedCanvasFont(relative).
// Emit docs/licenses/EXCALIDRAW_FONTS.txt as
// vendor/excalidraw-0.18.1/EXCALIDRAW_FONTS.txt beside the filtered manifest.
```

Filter development serving as well as production emission. A production check
must reject excluded family paths in output/manifest, not merely omit them from
the current UI. The adapter and asset policy are shared with the browser fixture.

## Verification

`tests/canvas.browser.py` runs real rectangle/ellipse pointer drawing against a
full disposable Node document API and desktop. It verifies canonical export,
independent documents, durable save, conflict draft preservation and page reload,
lost-response exact retry, and native host/island preservation through both
renderer modes and focus. Delayed binding requests are disposed on close.
The fixture publishes only the approved font families, asserts the complete set
of four offered font choices, types with each real family, persists/exports each
font ID, and asserts no excluded font or external requests, including when a
local font is deliberately unavailable. Node tests validate and syntax-check
the actual fingerprinted production/development transform, exact scene font
admission and asset filtering. Integration additionally verifies its production
font manifest/notices and same-origin CSP.
