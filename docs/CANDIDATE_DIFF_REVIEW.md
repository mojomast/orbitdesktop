# Exact candidate change review

## Authority boundary

The trusted, owner-authenticated Workbench endpoint resolves candidate identity,
the two retained generations and hashes, file manifests, modes and availability.
It validates both immutable trees before and after source reads. Missing history,
hash mismatches and changed authority fail closed. Current source is never a
replacement for the requested historical comparison.

Private detail requests can select `comparison: "initial"` for a cumulative
comparison from the server-resolved initial retained candidate generation, or
`"previous"` (the default) for the immediately preceding generation. Both use an
exact requested destination generation/hash. The initial candidate is labeled as
such; it is not silently equated to a Git base. A Live historical event always
keeps its original transition. Neither option lets the browser choose source
roots, file hashes, or an alternate fallback identity.

The browser receives private source for presentation only. Its diff calculations,
syntax colors, whitespace filtering and line statistics confer no verification.
Recorder evidence, literal worker explanations and human review decisions remain
distinct. A copied/raw review diff is not the independently verified patch artifact.

## Dependency decision

The frontend is Vite with TypeScript and native DOM components (no React). Four
options were evaluated before implementation:

| Option | Fit and tradeoffs |
| --- | --- |
| jsdiff + native DOM + highlight.js core | Selected. Mature bounded diff algorithms; explicit split/unified alignment and accessibility under our control; language modules can be locally bundled selectively. Row rendering and navigation require our own component. |
| CodeMirror MergeView | Strong editor virtualization, syntax and accessible editing ecosystem. A credible option for an editing product, but adds the editor/view/state/language ecosystem for a read-only surface and still requires identity, file navigation and evidence integration. |
| Monaco Diff Editor | Excellent editor-grade diff, syntax and virtualization. Its multi-worker language/editor packaging is disproportionate for the current read-only native-DOM app. Registry unpacked size at evaluation was about 102 MB, not a measure of compressed runtime cost. |
| @git-diff-view/core | Dedicated mature browser diff UI, with useful layout features. Adds a second presentation framework/contract to adapt and audit; does not own our authoritative generation contract. Registry unpacked size was about 1.4 MB, not compressed runtime cost. |

Selected versions are exactly pinned in `package.json` and `package-lock.json`:
`diff@9.0.0` and `highlight.js@11.12.0` (both BSD-3-Clause). CodeMirror and Monaco
are MIT. No CDN, remote font, external code-analysis service or runtime package
download is used. Source and lockfile are included in the portable source archive;
release builds bundle the selected frontend modules locally. Production dependency
installation continues to use the existing lockfile-based packaging workflow.

An isolated minified ESM bundle measurement with the complete selected language
set was 92,864 bytes / 31,096 gzip for the viewer and 14,088 bytes / 5,422 gzip for
the diff worker, excluding CSS. These are measurement bundles, not a promise of
identical Vite chunk boundaries or network transfer sizes.

The small-library approach makes the trusted code surface explicit. Source must
be inserted as text; syntax tokens are presentation spans, never executable HTML.
Visual preferences can be stored locally; loaded source, search strings, raw diffs
and calculated line content must remain browser-memory-only. Diff work is bounded
and runs in a local worker, and hidden source need not create DOM nodes.

## Review semantics

File renames are not inferred: a removed path and an added path remain deletion
and addition. This avoids inventing file identity from similarity. File mode and
binary changes remain visible independently of textual line statistics. Totals
for incomplete source are labeled partial; missing text is not zero changes.

Executable modes are read by the server through the existing descriptor-confined
retained-tree capture and checked again after the source read. They are explicitly
labeled **observed retained-tree metadata**: legacy candidate hashes bind file
content, not Unix mode bits. This increment does not rewrite historical hashes or
claim that they authenticate modes. Missing mode metadata is shown as unavailable.
Artifact verification continues to independently verify patch round-trip modes.

Ignore-whitespace affects the rendered comparison only. Exact hashes and raw
review diff retain original content. Syntax highlighting never rewrites source.
Normal line counts and diff statistics come from line operations, not character
counts. Added/deleted empty files and mode-only changes can have zero changed
text lines while still being meaningful file changes.

The source-detail bound remains 32 files / 64 KiB per comparison. Limits and
unavailable files must be explicit in the viewer rather than silently omitted.
Partial comparisons expose an **Inspect file** control in Changes. It requests
one exact changed path under the same generation identities and byte bound. The
server accepts only membership in the already validated changed-file manifests;
it never opens an arbitrary request path. This permits inspection beyond the
first 32 files without increasing the global source limit. A single file exceeding
the source bound remains explicitly unavailable.

## Reading and navigation

The Workbench **Changes** tab offers cumulative initial-to-selected changes and
the latest generation transition. Live **View diff** opens its recorded transition,
including a recorded tool result's exact candidate identity and path where known.
Trusted Review uses the same viewer beside recorder evidence and the literal
worker explanation. Historical approvals resolve their retained generation on the
server and are prominently labeled as historical, never current authorization.

Split and unified layouts, 3/5/10/all context, and wrapping are browser-local visual
preferences. Source wraps by default; narrow panes automatically use unified.
Unchanged ranges expand on demand. Rendering is paged at 180 aligned rows (at most
360 unified source rows), even with All context. The diff worker is cancelled when
its result becomes stale. Search is local, covers available file paths and source
side-lines, and expands the relevant context. The search count is capped explicitly
at 10,000 side-line/path matches; repetitive lines have at most 128 search
decorations, without removing text.

Keyboard shortcuts are focus-scoped and listed in the viewer: j/k or Alt+Down/Up
for hunks, [/ ] or Alt+Left/Right for files, u/s for layout, and / for search.
Expand moves the same viewer into a dialog; returning preserves state and scroll.
Raw and copied text are review conveniences, separate from verified patch download.
Embedded Review uses the component's compact layout so that code and recorder
verdicts fit together in small default and docking panes. Its **Controls** button
opens layout, context, search and the file list; identities and hunk/file navigation
stay visible. The expanded dialog retains the same selected comparison.

Syntax is line-local, with plain-text fallback for unknown formats and lines over
12,000 characters. Multiline lexical context is approximate. No rename heuristic,
inline review-comment system or image diff is introduced.

## Acceptance evidence

Deterministic calculation tests exercise exact raw-patch application, aligned
adds/deletes/modifications, EOF, CRLF, Unicode, empty/mode-only files and bounded
full replacements. Server tests exercise retained-history loss and tampering,
concurrent generation changes, byte/file bounds, executable-mode races, and
exact single-file reads beyond the initial 32-file page.

The presentation browser fixture covers source injection resistance, local-only
preferences/search, both layouts, folding, navigation, raw/copy, expanded-view
scroll restoration, dark/light styling, repetitive long-line search and 5,000-line
source paging. The real-backend Workbench journey runs separately in both renderers.

Read-only presentation acceptance reused the private, exact retained payload from
the previously authorized DeepSeek task. Both file text hashes were rechecked
before rendering. The viewer reported **1 file, 57 additions, 7 deletions, 4 hunks**;
aligned split rows, token/syntax highlighting, unified layout and hunk navigation
were checked, and dark/light screenshots inspected. One local cold development
import-to-render measurement was 129 ms, not a production performance benchmark.
The prior disposable service was offline: this acceptance reused its retained
validated payload rather than claiming a fresh request to that service. Real
endpoint identity behavior is covered by the disposable-server journey. No new
model run or provider spend was used, and private source/screenshots are not in Git.
