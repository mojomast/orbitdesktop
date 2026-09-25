# Docking evaluation: continuity before replacement

Status: candidate research, **not a measured docking-library bake-off or selection**.
Checked September 25, 2026. No candidate was installed, no package scripts ran, and
no production dependency or framework was added in this increment.

## Candidate evidence

| Candidate | Exact package metadata checked | Documented continuity approach | Open questions for an Orbit spike |
|---|---|---|---|
| Existing Orbit renderer | Checked-in Three.js/CSS3D, vanilla TypeScript, v1 layout | Pane views keyed by ID; connected DOM reconciliation is the current implementation workstream | Actual document/draft/PTY continuity across 50 transitions; fallback browsers; focus and accessibility; no new docking tabs yet |
| Dockview core | `dockview-core@8.3.1`, npm declares MIT | Official rendering guide requires `renderer: 'always'` for iframe panels; default `onlyWhenVisible` removes hidden panel DOM | Test actual inter-group/floating moves with sandboxed iframe documents, xterm and Orbit spatial/focus modes; map v1 model without making library JSON authoritative |
| Golden Layout | `golden-layout@2.6.0`, npm declares MIT | Official Virtual Components guide describes application-owned root elements, with rectangle/visibility/z-index events rather than reparenting | Implement virtual binding with stable surface hosts, then measure drag/focus/resize behavior and accessibility; integrate spatial coordinates separately |

Metadata commands:

```sh
npm view dockview-core version license engines dependencies repository --json
npm view golden-layout version license engines dependencies repository --json
```

These commands returned the versions above; neither result declared an `engines`
field. That absence is not a compatibility test. License metadata is not a legal
review of every distributed file. Before adoption, pin the selected exact release,
inspect its packaged license and source, and test its actual installation/build.

## Licensing boundary that affects the decision

Dockview's current official licensing matrix distinguishes MIT core from commercial
Enterprise features. In particular it lists **keyboard docking**, spatial keyboard
navigation, layout history, pinned tabs and several advanced tab behaviors as
Enterprise features. Do not assume those are included because the core npm package
declares MIT. Orbit would need its own accessible command/keyboard interaction path
or an explicit licensing decision; no purchase, trial activation or license-key
configuration was authorized here.

Golden Layout documents classic embedded binding as potentially reparenting a
component's ancestors. Only evaluate its **virtual** binding for continuity-sensitive
surfaces, unless measurement proves another approach safe. Its documentation claims
virtual components avoid reparenting; that is not yet Orbit-specific test evidence.

Sources:
- https://dockview.dev/docs/core/panels/rendering/
- https://dockview.dev/docs/overview/licence
- https://golden-layout.github.io/golden-layout/binding-components/
- https://registry.npmjs.org/dockview-core/8.3.1
- https://registry.npmjs.org/golden-layout/2.6.0

## Required measured comparison before selection

The current renderer fix uses native `Element.moveBefore` where available. MDN marks
it **Limited availability** (not Baseline) at the time of this review and documents
same-document/connectedness constraints. `append`/`insertBefore` cannot be advertised
as an equivalent iframe-preserving polyfill. A passing Chromium run therefore does
not establish continuity on an unsupported browser or for cross-document popouts.
Reference: https://developer.mozilla.org/en-US/docs/Web/API/Element/moveBefore

Reuse the isolated runtime-continuity fixture rather than counting preserved pane IDs
as session evidence. Run the same transition matrix against each adapter and record:

1. Iframe document nonce/identity, unsaved form data and unexpected navigation count.
2. Xterm/terminal view and WebSocket identity; fresh shell-variable and PID evidence.
3. Focus, selection, keyboard reachability, pointer resizing and hidden-frame behavior.
4. Repeated dock, float, minimize, split, reorder, cross-window move and checkpoint
   reconciliation without dropping unrelated configuration or starting new sessions.
5. Browser capability requirements and negative controls: deliberate URL/kind changes
   must still replace content, and closing a pane must dispose its runtime.
6. Cold-load cost, steady-state geometry/update cost and memory, using measured data,
   not marketing bundle-size comparisons.

Layout policy, runtime ownership and permissions remain separate. A docking library
must not become the owner of conversations, PTYs, app storage or recovery policy.
Checkpoint restore remains layout restoration, not resurrection of destroyed runtime
state. Keep library-specific placement data behind an adapter; do not combine this
spike with a normalized v2 persistence migration.
