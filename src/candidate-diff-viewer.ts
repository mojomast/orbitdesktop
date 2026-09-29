import './candidate-diff-viewer.css';
import type { CandidateDiffData, CandidateDiffFile, CalculatedDiff, DiffLine } from './candidate-diff-types';
import { renderDiffLine } from './candidate-diff-highlight';

type Preferences = { mode: 'split' | 'unified'; context: number; wrap: boolean };
type SearchHit = { file: number; side?: 'old' | 'new'; line?: number };
const PREF_KEY = 'orbit.candidate-diff.preferences.v1';
const PAGE = 180; // A modify row uses two DOM rows in unified mode: always <=360 source rows.
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text: string, action: () => void, label = text): HTMLButtonElement {
  const node = el('button', '', text); node.type = 'button'; node.setAttribute('aria-label', label); node.addEventListener('click', action); return node;
}
function readable(file: CandidateDiffFile | undefined): boolean {
  return !!file && file.text_available && (file.old_hash === null || typeof file.old_text === 'string') && (file.new_hash === null || typeof file.new_text === 'string');
}
function kind(file: CandidateDiffFile): string {
  if (file.old_hash === null) return 'A';
  if (file.new_hash === null) return 'D';
  if (file.old_hash === file.new_hash && file.old_mode !== file.new_mode) return 'Mode';
  return 'M';
}
function changeName(file: CandidateDiffFile): string {
  return ({A: 'Added file', D: 'Deleted file', M: 'Modified', Mode: 'Mode change'} as Record<string, string>)[kind(file)]!;
}
function modeName(mode: CandidateDiffFile['old_mode']): string {
  return typeof mode === 'number' ? (mode < 0o100000 ? mode | 0o100000 : mode).toString(8) : mode ?? 'unavailable';
}

/** Memory-only presentation of already resolved candidate bytes and identities. */
export function createCandidateDiffViewer(data: CandidateDiffData, options: { selectedPath?: string; title?: string; compact?: boolean } = {}): { element: HTMLElement; dispose: () => void } {
  const files = data.available ? [...data.files ?? []] : [];
  let prefs: Preferences = { mode: 'split', context: 3, wrap: true };
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null') as Partial<Preferences> | null;
    if (saved) prefs = { mode: saved.mode === 'unified' ? 'unified' : 'split', context: [3, 5, 10, -1].includes(saved.context!) ? saved.context! : 3, wrap: saved.wrap === true };
  } catch { /* Preferences are optional. */ }
  const save = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* Storage disabled. */ } };
  let selected = Math.max(0, files.findIndex(f => f.path === options.selectedPath));
  let disposed = false; let worker: Worker | undefined; let request = 0; let activeRequest = 0; let computing = -1;
  let ignoreWhitespace = false; let narrow = false; let raw = false; let page = 0; let hunk = -1;
  let expanded: [number, number][] = []; let hits: SearchHit[] = []; let hitIndex = -1; let capped = false;
  let pendingHit: SearchHit | undefined; let query = ''; let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const results = new Map<number, CalculatedDiff>(); const errors = new Map<number, string>();
  const collapsedFiles = new Set<number>();
  const root = el('section', 'candidate-diff-viewer'); root.tabIndex = 0; root.setAttribute('aria-label', options.title ?? 'Candidate diff viewer');
  root.classList.toggle('cdv-compact', options.compact === true);
  const header = el('header', 'cdv-header');
  const heading = el('strong', 'cdv-title', options.title ?? 'Candidate changes');
  const comparisonLabel = data.comparison === 'initial' ? 'Cumulative · initial → selected generation' : data.comparison === 'previous' ? 'Transition · previous → selected generation' : 'Exact selected versions';
  const comparison = el('div', 'cdv-comparison', `${comparisonLabel}${data.from && data.to ? ` · g${data.from.generation} → g${data.to.generation}` : ''}`);
  const identityStrip = el('div', 'cdv-identity-strip');
  identityStrip.textContent = `Candidate ${(data.to?.candidate_id ?? data.from?.candidate_id ?? 'unavailable').slice(0, 12)} · From ${data.from ? `g${data.from.generation} · ${data.from.candidate_hash.slice(0, 12)}` : 'unavailable'} → To ${data.to ? `g${data.to.generation} · ${data.to.candidate_hash.slice(0, 12)}` : 'unavailable'}`;
  const aggregate = el('span', 'cdv-muted');
  const status = el('span', 'cdv-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const expand = button('Expand', () => toggleExpanded());
  header.append(heading, aggregate, expand);
  const identities = el('details', 'cdv-identities'); identities.append(el('summary', '', 'Comparison identity'));
  for (const [label, identity] of [['From', data.from], ['To', data.to]] as const) {
    identities.append(el('div', '', `${label}: ${identity ? `${identity.candidate_id} · generation ${identity.generation} · ${identity.candidate_hash}` : 'Not supplied'}`));
    if (identity) identities.append(button(`Copy ${label.toLowerCase()} candidate hash`, () => copy(identity.candidate_hash)));
  }
  const notice = el('div', 'cdv-notice');
  notice.textContent = [!data.available ? `Comparison unavailable: ${data.reason ?? 'exact versions are unavailable'}. No substitute version is displayed.` : '', data.truncated || (data.changed_files !== undefined && data.changed_files > files.length) ? `Diff partially displayed: ${files.length} of ${data.changed_files ?? 'unknown'} changed files loaded. The 32-file / 64 KiB private source-detail bound applies; unavailable text is not counted.` : '', data.note, data.available ? data.reason : '', data.current_generation !== undefined ? `Current generation: ${data.current_generation}` : ''].filter(Boolean).join(' ');
  notice.hidden = !notice.textContent;
  const toolbar = el('div', 'cdv-toolbar');
  const whitespaceNotice = el('p', 'cdv-notice', 'Whitespace differences hidden for review. Underlying candidate contents and hashes are unchanged.'); whitespaceNotice.hidden = true;
  const mode = el('select'); mode.setAttribute('aria-label', 'Diff layout');
  for (const value of ['split', 'unified']) { const option = el('option', '', value === 'split' ? 'Split' : 'Unified'); option.value = value; mode.append(option); }
  mode.value = prefs.mode; mode.addEventListener('change', () => { prefs.mode = mode.value as Preferences['mode']; save(); render(); });
  const context = el('select'); context.setAttribute('aria-label', 'Context lines');
  for (const value of [3, 5, 10, -1]) { const option = el('option', '', value === -1 ? 'All context' : `${value} context lines`); option.value = String(value); context.append(option); }
  context.value = String(prefs.context); context.addEventListener('change', () => { prefs.context = Number(context.value); expanded = []; page = 0; save(); render(); });
  const wrap = button('Wrap', () => { prefs.wrap = !prefs.wrap; save(); render(); });
  const whitespace = button('Ignore whitespace', () => {
    ignoreWhitespace = !ignoreWhitespace; whitespace.setAttribute('aria-pressed', String(ignoreWhitespace));
    whitespaceNotice.hidden = !ignoreWhitespace;
    stopWorker(); results.clear(); errors.clear(); expanded = []; page = 0; hunk = -1; render(); schedule();
  }); whitespace.setAttribute('aria-pressed', 'false');
  const rawButton = button('Raw unified', () => { raw = !raw; page = 0; render(); });
  toolbar.append(mode, context, wrap, whitespace, rawButton, button('Expand file', () => { expanded = [[0, results.get(selected)?.rows.length ?? 0]]; page = 0; render(); }), button('Collapse unchanged', () => { expanded = []; prefs.context = 3; context.value = '3'; page = 0; save(); render(); }));
  const searchbar = el('div', 'cdv-search');
  const search = el('input'); search.type = 'search'; search.placeholder = 'Find path or source…'; search.setAttribute('aria-label', 'Search supplied file paths and source');
  const searchCount = el('span', 'cdv-muted');
  search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(find, 150); });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); if (query !== search.value.toLowerCase()) find(); else jumpSearch(event.shiftKey ? -1 : 1); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); search.value = ''; find(); root.focus(); } });
  searchbar.append(search, button('↑', () => jumpSearch(-1), 'Previous search result'), button('↓', () => jumpSearch(1), 'Next search result'), searchCount);
  const body = el('div', 'cdv-body'); const nav = el('nav', 'cdv-files'); nav.setAttribute('aria-label', 'Changed files');
  const main = el('div', 'cdv-main'); const fileHeader = el('div', 'cdv-file-header'); const controls = el('div', 'cdv-navigation');
  controls.append(button('← File', () => selectFile(selected - 1), 'Previous file'), button('File →', () => selectFile(selected + 1), 'Next file'), button('↑ Hunk', () => jumpHunk(-1), 'Previous hunk'), button('Hunk ↓', () => jumpHunk(1), 'Next hunk'));
  const hunkLabel = el('span', 'cdv-muted'); controls.append(hunkLabel);
  const viewport = el('div', 'cdv-viewport'); viewport.tabIndex = 0; viewport.setAttribute('aria-label', 'Diff source');
  const pagination = el('div', 'cdv-pagination');
  const help = el('details', 'cdv-help'); help.append(el('summary', '', 'Keyboard shortcuts'), el('p', '', 'With focus in the viewer: j / k or Alt+↓ / ↑: next / previous hunk. ] / [ or Alt+→ / ←: next / previous file. u / s: unified / split. /: search. Escape: leave expanded view. Source search counts matching lines on each available side and matching paths.'));
  const settings = el('details', 'cdv-settings'); settings.append(el('summary', '', 'Review controls and files'));
  main.append(fileHeader, controls, viewport, pagination);
  if (options.compact) {
    comparison.textContent = `${data.comparison === 'initial' ? 'Cumulative' : 'Historical transition'}${data.from && data.to ? ` · g${data.from.generation} → g${data.to.generation}` : ''}`;
    comparison.hidden = true; identityStrip.prepend(document.createTextNode(data.comparison === 'initial' ? 'Initial · ' : 'Transition · '));
    settings.append(identities, toolbar, searchbar, nav); body.append(main);
    settings.append(button('Copy selected hunk', () => { const result = results.get(selected), range = result?.hunks[Math.max(0, hunk)]; if (result && range) copyRows(Math.max(0, range.start - 3), Math.min(result.rows.length, range.end + 3), false); }));
    const controlsButton = button('Controls', () => { settings.open = !settings.open; if (settings.open) settings.scrollIntoView({block:'nearest'}); }, 'Review controls and files');
    controlsButton.setAttribute('aria-expanded', 'false'); settings.addEventListener('toggle', () => controlsButton.setAttribute('aria-expanded', String(settings.open)));
    header.insertBefore(controlsButton, expand);
    root.append(header, comparison, identityStrip, notice, whitespaceNotice, body, settings, status, help);
  } else { body.append(nav, main); root.append(header, comparison, identityStrip, identities, notice, toolbar, whitespaceNotice, searchbar, body, status, help); }
  let dialog: HTMLDialogElement | undefined; let placeholder: Comment | undefined; let returnFocus: HTMLElement | null = null;
  function toggleExpanded() {
    if (dialog) { closeExpanded(); return; }
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const top = viewport.scrollTop; const left = viewport.scrollLeft;
    placeholder = document.createComment('candidate diff location'); root.before(placeholder);
    dialog = el('dialog', 'cdv-dialog'); dialog.setAttribute('aria-label', options.title ?? 'Expanded candidate diff');
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeExpanded(); });
    document.body.append(dialog); dialog.append(root); dialog.showModal(); expand.textContent = 'Return to pane'; expand.setAttribute('aria-label', 'Return to pane'); root.focus(); viewport.scrollTop = top; viewport.scrollLeft = left;
  }
  function closeExpanded() {
    if (!dialog) return;
    const top = viewport.scrollTop; const left = viewport.scrollLeft;
    placeholder?.replaceWith(root); dialog.close(); dialog.remove(); dialog = undefined; placeholder = undefined; expand.textContent = 'Expand'; expand.setAttribute('aria-label', 'Expand');
    viewport.scrollTop = top; viewport.scrollLeft = left; returnFocus?.focus({ preventScroll: true });
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); if (!disposed) status.textContent = 'Copied to clipboard.'; }
    catch { if (!disposed) status.textContent = 'Clipboard unavailable. Select the displayed text to copy.'; }
  }
  function stopWorker() { worker?.terminate(); worker = undefined; computing = -1; activeRequest = ++request; }
  function schedule() {
    if (disposed || !data.available || computing >= 0) return;
    const index = [selected, ...files.map((_, i) => i)].find(i => readable(files[i]!) && !results.has(i) && !errors.has(i));
    if (index === undefined) { renderStats(); return; }
    try {
      worker ??= new Worker(new URL('./candidate-diff-worker.ts', import.meta.url), { type: 'module' });
      computing = index; const id = activeRequest = ++request;
      worker.onmessage = (event: MessageEvent<{ id: number; result?: CalculatedDiff; error?: string }>) => {
        if (disposed || event.data.id !== activeRequest) return;
        computing = -1;
        if (event.data.result) results.set(index, event.data.result); else errors.set(index, event.data.error ?? 'Diff computation unavailable');
        if (index === selected) { if (pendingHit) revealHit(pendingHit); else render(); }
        renderStats(); schedule();
      };
      worker.onerror = () => { if (disposed || id !== activeRequest) return; errors.set(index, 'Diff worker failed; exact source was not substituted.'); stopWorker(); render(); schedule(); };
      worker.postMessage({ id, file: files[index], ignoreWhitespace });
    } catch { errors.set(index, 'Diff worker is unavailable in this environment.'); stopWorker(); render(); schedule(); }
  }
  function renderStats() {
    let additions = 0; let deletions = 0; let hunks = 0;
    for (const result of results.values()) { additions += result.additions; deletions += result.deletions; hunks += result.hunks.length; }
    const complete = results.size === files.length && !data.truncated && (data.changed_files === undefined || data.changed_files === files.length) && ![...results.values()].some(r => r.limited);
    const binary = files.filter(file => file.reason === 'binary').length;
    const modes = files.filter(file => kind(file) === 'Mode').length;
    const unavailable = files.filter(file => !readable(file) && file.reason !== 'binary').length;
    aggregate.textContent = !data.available ? 'Unavailable · no source substituted' : `${files.length}${data.changed_files !== undefined ? ` / ${data.changed_files}` : ''} files · +${additions} −${deletions} · ${hunks} hunks${complete ? '' : ` · partial text totals (${results.size}/${files.length} computed)`}${binary ? ` · ${binary} binary` : ''}${modes ? ` · ${modes} mode-only` : ''}${unavailable ? ` · ${unavailable} unavailable` : ''}${ignoreWhitespace ? ' · whitespace ignored' : ''}`;
    const navFocused = nav.contains(document.activeElement);
    nav.replaceChildren();
    files.forEach((file, index) => {
      const result = results.get(index); const item = button('', () => selectFile(index), `${kind(file)} ${file.path}`);
      item.title = `${changeName(file)} · ${file.path}`;
      item.className = 'cdv-file'; item.setAttribute('aria-current', index === selected ? 'true' : 'false');
      item.append(el('span', 'cdv-badge', kind(file)), el('span', 'cdv-path', file.path), el('span', 'cdv-file-stat', result ? `+${result.additions} −${result.deletions}${result.limited ? ' partial' : ''}` : readable(file) ? errors.has(index) ? 'Error' : 'Pending' : file.reason ?? 'Unavailable'));
      nav.append(item);
    });
    if (navFocused) nav.querySelector<HTMLButtonElement>('[aria-current=true]')?.focus({ preventScroll: true });
  }
  function selectFile(index: number) {
    if (index < 0 || index >= files.length) return;
    if (selected !== index) { selected = index; expanded = []; page = 0; hunk = -1; pendingHit = undefined; viewport.scrollTop = 0; }
    if (computing >= 0 && computing !== index && !results.has(index)) stopWorker();
    render(); schedule();
  }
  function visibleRows(result: CalculatedDiff): number[] {
    if (prefs.context === -1) return result.rows.map((_, i) => i);
    const ranges = [...expanded, ...result.hunks.map(h => [Math.max(0, h.start - prefs.context), Math.min(result.rows.length, h.end + prefs.context)] as [number, number])].sort((a, b) => a[0] - b[0]);
    const indices: number[] = []; let previous = -1;
    for (const [start, end] of ranges) for (let i = Math.max(start, previous + 1); i < end; i++) { indices.push(i); previous = i; }
    return indices;
  }
  function revealRow(index: number) {
    const result = results.get(selected); if (!result) return;
    collapsedFiles.delete(selected);
    expanded.push([Math.max(0, index - 3), Math.min(result.rows.length, index + 4)]);
    page = Math.floor(visibleRows(result).indexOf(index) / PAGE); raw = false; render();
    const target = viewport.querySelector<HTMLElement>(`[data-row="${index}"]`); target?.classList.add('cdv-target');
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  function jumpHunk(direction: number) {
    const result = results.get(selected); if (!result?.hunks.length) return;
    hunk = hunk < 0 ? direction > 0 ? 0 : result.hunks.length - 1 : (hunk + direction + result.hunks.length) % result.hunks.length; revealRow(result.hunks[hunk]!.start);
  }
  function find() {
    query = search.value.toLowerCase(); hits = []; hitIndex = -1; capped = false;
    if (query) outer: for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      if (file.path.toLowerCase().includes(query)) hits.push({ file: i });
      if (!readable(file)) continue;
      for (const side of ['old', 'new'] as const) {
        const text = file[`${side}_text`] ?? ''; const lines = text.split('\n');
        for (let n = 0; n < lines.length; n++) if (lines[n]!.toLowerCase().includes(query)) {
          hits.push({ file: i, side, line: n + 1 });
          if (hits.length >= 10000) { capped = true; break outer; }
        }
      }
    }
    if (hits.length) jumpSearch(1); else { searchCount.textContent = query ? '0 matching paths / side-lines in supplied text' : ''; render(); }
  }
  function revealHit(hit: SearchHit) {
    pendingHit = undefined;
    const result = results.get(selected);
    if (hit.side && result) {
      const row = result.rows.findIndex(r => r[hit.side!]?.number === hit.line);
      if (row >= 0) { revealRow(row); return; }
      status.textContent = 'Match exists in supplied source but is outside the computed diff bounds.';
    }
    render();
  }
  function jumpSearch(direction: number) {
    if (!hits.length) return;
    hitIndex = hitIndex < 0 ? direction > 0 ? 0 : hits.length - 1 : (hitIndex + direction + hits.length) % hits.length; const hit = hits[hitIndex]!;
    selectFile(hit.file); searchCount.textContent = `${hitIndex + 1} / ${hits.length}${capped ? '+' : ''} matching paths / side-lines`;
    if (!results.has(hit.file) && readable(files[hit.file]!)) pendingHit = hit; else revealHit(hit);
  }
  function fold(start: number, end: number): HTMLElement {
    const node = el('div', 'cdv-fold');
    node.append(button(`⋯ ${end - start} unchanged lines · expand range`, () => { expanded.push([start, end]); render(); })); return node;
  }
  function render() {
    if (disposed) return;
    renderStats(); root.classList.toggle('cdv-wrap', prefs.wrap); wrap.setAttribute('aria-pressed', String(prefs.wrap)); rawButton.setAttribute('aria-pressed', String(raw));
    viewport.replaceChildren(); fileHeader.replaceChildren(); pagination.replaceChildren();
    const file = files[selected]; const result = results.get(selected);
    hunkLabel.textContent = result ? `${hunk < 0 ? 0 : hunk + 1} / ${result.hunks.length} hunks` : '';
    if (!file) { viewport.append(el('p', 'cdv-empty', data.available ? 'No changed files supplied.' : 'Exact comparison unavailable. See comparison identity above.')); return; }
    const path = el('strong', 'cdv-file-title', file.path); const copyPath = button('Copy path', () => copy(file.path)); fileHeader.append(path); if (!options.compact) fileHeader.append(copyPath);
    fileHeader.append(el('span', 'cdv-file-hashes', `old ${file.old_hash?.slice(0, 12) ?? 'absent'} → new ${file.new_hash?.slice(0, 12) ?? 'absent'}`));
    const collapseFile = button(collapsedFiles.has(selected) ? 'Expand source' : 'Collapse file', () => { if (collapsedFiles.has(selected)) collapsedFiles.delete(selected); else collapsedFiles.add(selected); render(); });
    collapseFile.setAttribute('aria-expanded', String(!collapsedFiles.has(selected))); if (!options.compact) fileHeader.append(collapseFile);
    const metadata = el('details', 'cdv-file-identity'); metadata.append(el('summary', '', `${changeName(file)} · ${result ? `+${result.additions} −${result.deletions}${result.limited ? ' · non-minimal / bounded' : ''}` : readable(file) && !errors.has(selected) ? 'Statistics pending' : 'Text statistics unavailable'} · Mode ${file.old_hash === null ? 'absent' : modeName(file.old_mode)} → ${file.new_hash === null ? 'absent' : modeName(file.new_mode)}`));
    for (const side of ['old', 'new'] as const) {
      const hash = file[`${side}_hash`]; metadata.append(el('div', '', `${side}: ${hash ?? 'absent'} · mode ${modeName(file[`${side}_mode`])}${file[`${side}_bytes`] !== undefined ? ` · ${file[`${side}_bytes`]} bytes` : ''}`));
      if (hash) metadata.append(button(`Copy ${side} hash`, () => copy(hash)));
    }
    if (data.mode_provenance === 'retained_tree_observation') metadata.append(el('p', '', 'Modes are server-observed executable bits of the retained trees, rechecked across this read. Legacy candidate hashes bind content, not file modes. Artifact verification validates its own modes independently.'));
    if (options.compact) metadata.append(copyPath, collapseFile);
    fileHeader.append(metadata);
    if (collapsedFiles.has(selected)) { viewport.append(el('p', 'cdv-empty', 'File source collapsed. Identity and statistics remain visible.')); return; }
    if (!readable(file)) { viewport.append(el('p', 'cdv-empty', `${file.reason === 'binary' ? 'Binary file changed. No text diff is provided.' : `Text unavailable: ${file.reason ?? 'missing exact source'}.`} Old: ${file.old_hash ?? 'absent'} (${file.old_bytes ?? 'unknown'} bytes). New: ${file.new_hash ?? 'absent'} (${file.new_bytes ?? 'unknown'} bytes). No substitute source is displayed.`)); return; }
    if (!result) { viewport.append(el('p', 'cdv-empty', errors.get(selected) ?? 'Computing exact diff…')); return; }
    if (file.reason || result.notice || result.limited) viewport.append(el('div', 'cdv-notice', [file.reason, result.notice, result.limited ? 'Computation bounded: replacement statistics may be non-minimal. Supplied exact text is retained in raw unified.' : ''].filter(Boolean).join(' ')));
    if (raw) {
      viewport.append(el('p', 'cdv-notice', 'Raw review diff — not an independently verified patch artifact. Generated from the loaded historical text; whitespace is preserved.'));
      const lines = result.raw.split('\n'); const pages = Math.max(1, Math.ceil(lines.length / PAGE)); page = Math.min(page, pages - 1);
      viewport.append(el('pre', 'cdv-raw', lines.slice(page * PAGE, (page + 1) * PAGE).join('\n')));
      paginate(pages, `${lines.length} raw lines`); pagination.append(button('Copy raw unified', () => copy(result.raw))); return;
    }
    if (!result.hunks.length) viewport.append(el('p', 'cdv-empty', ignoreWhitespace ? 'No text changes under the whitespace filter. Identity / mode changes may still be present.' : 'No text changes. Identity / mode changes may still be present.'));
    const visible = visibleRows(result); const pages = Math.max(1, Math.ceil(visible.length / PAGE)); page = Math.max(0, Math.min(page, pages - 1));
    const indices = visible.slice(page * PAGE, (page + 1) * PAGE); const split = prefs.mode === 'split' && !narrow;
    const table = el('div', `cdv-table ${split ? 'cdv-split' : 'cdv-unified'}`); table.setAttribute('role', 'table'); table.setAttribute('aria-label', split ? 'Split diff: old and new' : 'Unified diff');
    if (!prefs.wrap) {
      const columns = result.rows.reduce((max, row) => Math.max(max, row.old?.text.replace(/\t/g, '    ').length ?? 0, row.new?.text.replace(/\t/g, '    ').length ?? 0), 0);
      table.style.minWidth = `max(100%, calc(${columns * (split ? 2 : 1)}ch + ${split ? 144 : 116}px))`;
    }
    const labels = el('div', 'cdv-columns');
    if (split) { labels.classList.add('cdv-split-labels'); labels.append(el('span', '', 'BEFORE'), el('span', '', 'AFTER')); }
    else labels.textContent = 'OLD   NEW    CHANGE';
    table.append(labels);
    let previous = page ? (visible[page * PAGE - 1] ?? -1) : -1;
    for (const index of indices) {
      if (index > previous + 1) table.append(fold(previous + 1, index));
      const hunkIndex = result.hunks.findIndex(h => h.start === index);
      if (hunkIndex >= 0) {
        const marker = el('div', 'cdv-hunk'); const range = result.hunks[hunkIndex]!;
        marker.append(button(`@@ Hunk ${hunkIndex + 1} @@`, () => { hunk = hunkIndex; hunkLabel.textContent = `${hunk + 1} / ${result.hunks.length} hunks`; }), button('Copy hunk', () => copyRows(Math.max(0, range.start - Math.max(3, prefs.context)), Math.min(result.rows.length, range.end + Math.max(3, prefs.context)), false)), button('Copy changed lines', () => copyRows(range.start, range.end, true))); table.append(marker);
      }
      const row = result.rows[index]!;
      const makeCell = (line: DiffLine | undefined, side: 'old' | 'new', changed: boolean) => {
        const cell = el('div', `cdv-cell ${changed ? side === 'old' ? 'cdv-delete' : 'cdv-add' : ''}${line ? '' : ' cdv-blank'}`); cell.setAttribute('role', 'cell');
        const number = el('span', 'cdv-number', line ? String(line.number) : ''); number.setAttribute('aria-label', line ? `${side} line ${line.number}` : 'No corresponding line');
        const sign = el('span', 'cdv-sign', line && changed ? side === 'old' ? '−' : '+' : ' ');
        const code = el('code', 'cdv-code'); if (line) renderDiffLine(code, line, file.path, query);
        cell.append(number, sign, code); return cell;
      };
      if (split) { const node = el('div', 'cdv-row'); node.dataset.row = String(index); node.setAttribute('role', 'row'); node.append(makeCell(row.old, 'old', row.kind !== 'context'), makeCell(row.new, 'new', row.kind !== 'context')); table.append(node); }
      else {
        for (const side of row.kind === 'context' ? ['new'] as const : ['old', 'new'] as const) {
          if (!row[side]) continue;
          const node = el('div', 'cdv-row'); node.dataset.row = String(index); node.setAttribute('role', 'row');
          const oldNumber = el('span', 'cdv-number', side === 'old' || row.kind === 'context' ? String(row.old?.number ?? '') : '');
          const cell = makeCell(row[side], side, row.kind !== 'context');
          if (side === 'old') cell.querySelector('.cdv-number')!.textContent = '';
          node.append(oldNumber, cell); table.append(node);
        }
      }
      previous = index;
    }
    if (page === pages - 1 && previous < result.rows.length - 1) table.append(fold(previous + 1, result.rows.length));
    viewport.append(table); paginate(pages, `${visible.length} visible aligned rows / ${result.rows.length} total${narrow && prefs.mode === 'split' ? ' · unified for narrow pane' : ''}`);
  }
  function copyRows(start: number, end: number, changedOnly: boolean) {
    const result = results.get(selected); if (!result) return;
    const lines: string[] = [];
    for (const row of result.rows.slice(start, end)) {
      if (row.kind === 'context') { if (!changedOnly) lines.push(` ${row.new?.text ?? row.old?.text ?? ''}`); }
      else { if (row.old) lines.push(`-${row.old.text}`); if (row.new) lines.push(`+${row.new.text}`); }
    }
    void copy(lines.join('\n'));
  }
  function paginate(pages: number, label: string) {
    const prev = button('Previous rows', () => { page--; viewport.scrollTop = 0; render(); }); prev.disabled = page === 0;
    const next = button('Next rows', () => { page++; viewport.scrollTop = 0; render(); }); next.disabled = page >= pages - 1;
    pagination.append(prev, el('span', 'cdv-muted', `Page ${page + 1} / ${pages} · ${label}`), next);
  }
  root.addEventListener('keydown', event => {
    if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"],[role="textbox"]') || event.ctrlKey || event.metaKey) return;
    let handled = true;
    if (event.key === 'Escape' && dialog) closeExpanded();
    else if (event.key === '/' && !event.altKey) { if (options.compact) settings.open = true; search.focus(); }
    else if (event.key === 'j' || (event.altKey && event.key === 'ArrowDown')) jumpHunk(1);
    else if (event.key === 'k' || (event.altKey && event.key === 'ArrowUp')) jumpHunk(-1);
    else if (event.key === ']' || (event.altKey && event.key === 'ArrowRight')) selectFile(selected + 1);
    else if (event.key === '[' || (event.altKey && event.key === 'ArrowLeft')) selectFile(selected - 1);
    else if (event.key === 'u' || event.key === 's') { prefs.mode = event.key === 'u' ? 'unified' : 'split'; mode.value = prefs.mode; save(); render(); }
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  });
  const observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width ?? 0; if (width > 0 && narrow !== (width < 760)) { const top = viewport.scrollTop; const left = viewport.scrollLeft; narrow = width < 760; render(); viewport.scrollTop = top; viewport.scrollLeft = left; } }); observer.observe(root);
  render(); schedule();
  return { element: root, dispose: () => { if (disposed) return; disposed = true; clearTimeout(searchTimer); observer.disconnect(); stopWorker(); closeExpanded(); results.clear(); errors.clear(); hits = []; pendingHit = undefined; files.length = 0; data = { available: false }; query = ''; search.value = ''; nav.replaceChildren(); viewport.replaceChildren(); fileHeader.replaceChildren(); identities.replaceChildren(); root.replaceChildren(); } };
}
