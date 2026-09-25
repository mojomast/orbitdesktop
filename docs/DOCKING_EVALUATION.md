# Docking evaluation: continuity before replacement

Status: **isolated browser adapter experiment, not a production selection**.
Measured September 25, 2026 in disposable Chromium fixtures. Dependencies were
installed only under `/tmp/opencode`; no production package or renderer changed.

## Reproduce and measured outcome

```sh
bash experiments/docking/setup.sh /tmp/opencode/orbit-docking-deps
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python \
  tests/docking-adapters.browser.py --move-control
```

The script starts a disposable loopback HTTP fixture and creates a new Playwright
context for each candidate/capability control. It serves the existing
`tests/fixtures/runtime-continuity.html` without modifying it, and exposes the
external npm packages from the temporary installation under `/vendor/`. It does
**not** connect to Orbit's server, workspace, owner profile, credentials, Hermes,
terminal socket or any external app. The output is JSON on stdout; a failed
assertion, failed pointer-resize probe, or fewer than 50 executed transitions makes
its exit nonzero. There are
no checked-in downloaded bundles, recordings or screenshots.

Actual run: Chromium **145.0.7632.6**, headless, 1400×900. Each candidate used
three application surfaces (`a`, `b`, `c`) with sandboxed iframes; `a` and `b`
were checked **after every transition** for connected root/iframe/contentWindow
object identity, document nonce, unsaved draft, zero unexpected iframe
navigations and zero page exceptions. Both native `Element.moveBefore` present
and a separate context with the method disabled were exercised (the disabled
Chromium context is **not** a Firefox/WebKit compatibility result).

| Adapter/control | Actual operations per type × 12 rounds | Executed / attempted; continuity failures | Cold navigation+initialization wall time; adapter initialization | Transition wall-time median / maximum |
|---|---|---|---|---|
| Dockview core/native | select, reorder, intergroup move, split, float, resize, save/load | 84/84; 0 | 56.61 ms; 17.6 ms | 41.56 / 54.15 ms |
| Dockview core/disabled `moveBefore` | same seven | 84/84; 0 | 38.12 ms; 17.1 ms | 41.21 / 51.72 ms |
| Golden Layout virtual/native | select, reorder, interstack move, split, resize, hide, show, save/load | 96/96; 0 | 57.45 ms; 8.5 ms | 40.4 / 46.28 ms |
| Golden Layout virtual/disabled `moveBefore` | same eight | 96/96; 0 | 50.49 ms; 12.5 ms | 40.41 / 47.75 ms |

Timing is one run, not a benchmark: `performance.now()` around synchronous adapter
initialization and Python `perf_counter` around navigation and each operation
**including a fixed 30 ms settle plus Playwright round-trip and assertions**.
The median is therefore not an isolated library update cost; startup includes
local HTTP, JavaScript import and frame loading. No memory measurement was made.
Negative controls intentionally changed one iframe URL (new nonce, cleared
draft), closed that panel/component (surface disconnected), then disposed the
remaining adapter in all four contexts. Golden's application-owned virtual
surface requires an explicit `.remove()` after removing its layout item.
The URL mutation is fixture-level, **not** proof of integrated pane-kind/URL
reconciliation. Dockview's save/load used `reuseExistingPanels: true`; Golden
Layout's `saveLayout()` result required `LayoutConfig.fromResolved()` before
`loadLayout()`. Raw resolved config initially threw `value.trimStart is not a
function` on all 12 attempts; this is an adapter format mismatch that was fixed
before the recorded final run, not an erased library continuity failure.

Pointer and keyboard observations: Dockview's minimal **experiment-authored** CSS
made its splitter hit-testable; one physical pointer drag changed measured panel
width 490→450 px in each control. Its three tabbable host elements included a
real tab reached by Tab, but keyboard docking/navigation was **not** tested or
established. Golden Layout had a hit-testable splitter (`lm_drag_handle`) but the
same 40 px pointer drag left stack width 606→606 px; its host had zero explicit
nonnegative `tabindex` elements and the single Tab probe focused an iframe. This
is not a complete focus-order/accessibility audit. Lead review reproduced the
resize failure, including after waiting two animation frames for layout. The
virtual adapter now captures the splitter's pointer on pointerdown so movement
continues across application-owned sibling iframe documents. Fresh runs passed
**606→646 px in both controls**, retaining all 96 transition checks. The harness
now waits for settled geometry and requires a width change; this is an adapter
integration fix, not a patched Golden Layout package. Keyboard accessibility
remains an **unresolved gap**. Neither
test covers screen readers, focus restoration after every transition, selection
inside an iframe, text selection, touch or real user DnD gestures.

The sampled operations are library API calls, not Orbit UI commands. Dockview
hide/show and Golden floating windows were not implemented by these adapters;
neither adapter measures Orbit minimize, spatial focus, CSS3D, cross-window
movement, normalized v1 persistence/checkpoints, live terminal/xterm, reconnect,
or plugin/Hermes ownership. **PTY was not tested**: these results are not
equivalent to Orbit's 94-transition private-socket PTY gate. No cross-document
popout continuity is claimed. Native-move control only removes a method from
the same Chromium engine, not a full fallback-browser test.

Both exact pinned packages declare MIT and their **packaged** `LICENCE.md`
(Dockview) / `LICENSE` (Golden) contain MIT grants. npm registry tarball
integrities checked by setup script were:

| Package | Registry `dist.integrity` | Declared direct / installed transitive dependencies |
|---|---|---|
| `dockview-core@8.3.1` | `sha512-6Loais9hlIRo25sTQSWGWlgbPr22ddoLBzpGDFaTnocawnC45twp5f2S2WxUz5/HPa/a65I4yxKUqZa8xrcc5Q==` | none / none |
| `golden-layout@2.6.0` | `sha512-sIVQCiRWOymHbVD1Aw/T9/ijbPYAVGBlgGYd1N9MRKfcyBNSpjr87Vg9nSHm+RCT8ELrvK8IJYJV0QRJuVUkCQ==` | none / none |

Installation used `npm install --ignore-scripts --no-save --package-lock=false`
outside the repository; the script checks the installed versions, packaged
license files and current registry integrities against recorded exact values.
This is not a complete legal audit of sources/assets or a production supply-chain
review. No Enterprise feature or license activation was used.

Lead verification repeated all four cases from a fresh disposable installation
after the pointer-capture fix; all passed with actual pointer width changes. The
setup script now rejects targets inside the Orbit repository and checks registry
integrity metadata before installation. Logs: `/tmp/opencode/orbit-docking-lead-final.json`.

**Recommendation: defer selection.** Dockview's core adapter shows broader
floating and pointer-resize evidence and built-in focusable tabs, but its MIT
core excludes advertised Enterprise keyboard docking/navigation and it needs a
considered styling/accessibility path. Golden virtual components give explicit
application-owned surface placement, and tested load reconciliation retained
documents. Its initial pointer-resize gap was resolved with adapter pointer capture;
keyboard accessibility still needs an explicit design and implementation.
Both still need Orbit model mapping, real app/PTY and spatial-mode acceptance,
browser-engine coverage, accessibility, and a measured cost study before a
production replacement decision. Keep the current 93-browser/94-PTY renderer
gate as the shipping evidence, not this fixture.

## Candidate evidence

| Candidate | Exact package metadata checked | Documented continuity approach | Open questions for an Orbit spike |
|---|---|---|---|
| Existing Orbit renderer | Checked-in Three.js/CSS3D, vanilla TypeScript, v1 layout | Pane views keyed by ID; 93 browser/94 PTY transitions passed separately | Fallback browsers; focus and accessibility; no new docking tabs yet |
| Dockview core | `dockview-core@8.3.1`, packaged MIT | Official rendering guide requires `renderer: 'always'` for iframe panels; default `onlyWhenVisible` removes hidden panel DOM | Sandbox iframe moves measured above; xterm and Orbit spatial/focus modes, model mapping remain |
| Golden Layout | `golden-layout@2.6.0`, packaged MIT | Virtual components use application-owned root elements and rectangle/visibility/z-index events | Virtual binding and adapter pointer capture measured above; focus accessibility and spatial coordinates remain |

Metadata commands:

```sh
npm view dockview-core version license engines dependencies repository --json
npm view golden-layout version license engines dependencies repository --json
```

These commands returned the versions above; neither result declared an `engines`
field. That absence is not a compatibility test. License metadata is not a legal
review of every distributed file. The isolated installation and packaged license
were inspected here; before adoption, inspect the source/assets and production build.

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
surfaces, unless measurement proves another approach safe. Its virtual binding
retained fixture documents here; Orbit-specific runtime integration remains untested.

Sources:
- https://dockview.dev/docs/core/panels/rendering/
- https://dockview.dev/docs/overview/licence
- https://golden-layout.github.io/golden-layout/binding-components/
- https://registry.npmjs.org/dockview-core/8.3.1
- https://registry.npmjs.org/golden-layout/2.6.0

## Remaining comparison gates before selection

Follow-up: the separate [Orbit integration spike](ORBIT_DOCKING_SPIKE.md) now
imports real PaneViews/model/scene with Dockview and passes 84 isolated PTY/spatial
transitions. That is stronger but still experimental evidence; it does not modify
the standalone comparison above or establish production acknowledgement, general
v1 graph support, persistent tabs, Hermes ownership or complete accessibility.

The current renderer fix uses native `Element.moveBefore` where available. MDN marks
it **Limited availability** (not Baseline) at the time of this review and documents
same-document/connectedness constraints. `append`/`insertBefore` cannot be advertised
as an equivalent iframe-preserving polyfill. A passing Chromium run therefore does
not establish continuity on an unsupported browser or for cross-document popouts.
Reference: https://developer.mozilla.org/en-US/docs/Web/API/Element/moveBefore

The experiment reused the isolated HTML fixture, **not** Orbit's full transition
matrix. A production candidate must still run the same Orbit transition matrix
and record:

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
