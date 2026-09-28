// Per-pane Workbench integration.
//
// Mounts the existing Workbench execution surfaces inside one agent pane and
// wires the private durable live projection. Authorization is never duplicated:
// task/candidate creation, attempt binding, native consent, checks, review/export
// and result delivery stay inside their existing components on the same
// owner-authenticated routes.
//
// Event handling is intentionally cheap: a live page only upserts its bounded
// events and refreshes the local header. It never reloads the whole project.
// Focused detail/tail reads happen only on a deliberate click.

import { button, el } from './dom';
import type { LiveItem } from './agent-live-types';
import type { createLiveTimeline } from './agent-live-timeline';
import { watchWorkbenchLive, type WorkbenchLivePage } from './workbench-live-client';
import { candidateDiffFromDetail } from './candidate-diff-adapter';
import type { CandidateDiffData } from './candidate-diff-types';
import type { PaneMode, PaneWorkbenchPrefs } from './pane-prefs';
import './pane-workbench.css';

type Data = Record<string, any>;
type LiveTimeline = ReturnType<typeof createLiveTimeline>;

export interface ConversationExcerpt {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sha256: string;
}

export interface PaneWorkbenchBadge {
  mode: PaneMode;
  pending: number;
  results: number;
  laneBusy: boolean;
  status: string;
}

export interface PaneWorkbenchDeps {
  paneId: string;
  body: HTMLElement;
  workspaceId: string;
  getToken: () => string;
  binding: () => { profileId: string; sessionId: string; bindingRevision: number };
  messages: () => readonly { id: string; role: 'user' | 'assistant'; text: string }[];
  prefs: PaneWorkbenchPrefs;
  onPrefs: (patch: Partial<PaneWorkbenchPrefs>) => void;
  onBadge: (badge: PaneWorkbenchBadge) => void;
  onLane: (lane: { agent_busy: boolean; job_busy: boolean; unknown: boolean; observed?: boolean }) => void;
  timeline: LiveTimeline;
  onError?: (message: string) => void;
  onOpenNormal?: () => void;
}

const EXCERPT_MAX_COUNT = 8;
const EXCERPT_MAX_BYTES = 16 * 1024;
const EXCERPT_TOTAL_BYTES = 64 * 1024;

const bytesOf = (text: string) => new TextEncoder().encode(text).length;
const short = (text: string, length = 160) => (text.length <= length ? text : `${text.slice(0, length)}…`);
const unknown = (value: unknown, fallback = 'unknown') => (value === undefined || value === null || value === '' ? fallback : String(value));

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function mountPaneWorkbench(deps: PaneWorkbenchDeps): {
  refresh(): Promise<void>;
  setVisible(visible: boolean): void;
  invalidateBinding(): void;
  liveSlot(): HTMLElement;
  openLiveReference(item: LiveItem): void;
  openHandoff(options?: { statement?: string; messageIds?: readonly string[] }): void;
  dispose(): void;
} {
  let disposed = false;
  let visible = false;
  let prefs: PaneWorkbenchPrefs = { ...deps.prefs };
  let epoch = 0;
  let busy = false;
  let projectId: string | null = prefs.projectId;
  let applyingScope = false;
  let latestSnapshot: Data | null = null;
  let laneNote = '';
  // Immutable previews. Capture/create submit only the exact previewed payload;
  // any input, project or binding change invalidates them. No whole-conversation
  // text is ever cached — only the explicitly selected excerpts.
  let excerptPreview: { request: Data; question: string; key: string } | null = null;
  let taskPreviewCache: { payload: Data; key: string } | null = null;
  let taskCreatePending = false; // ambiguous create outcome: manual reconcile only
  let pendingPacketId: string | null = null;
  type Panel = { refresh?(): void | Promise<void>; dispose(): void; setScope?(scope: Data): void; setLane?(lane: { busy: boolean; unknown: boolean }): void };
  let authorityMount: Panel | null = null;
  let executionMount: Panel | null = null;
  let workflowMount: Panel | null = null;
  let resultMount: Panel | null = null;
  let mountedFor: string | null = null;
  let liveClient: ReturnType<typeof watchWorkbenchLive> | null = null;
  let liveAttempt: string | null = null;
  let changesController: AbortController | null = null;
  let changesViewer: { element: HTMLElement; dispose(): void } | null = null;
  let changesKey = '';
  let changesTicket = 0;
  const detailDialogs = new Set<HTMLDialogElement>();

  const root = el('section', 'pane-workbench');
  root.setAttribute('aria-label', 'Pane Workbench');
  const head = el('div', 'pane-workbench-head');
  const status = el('p', 'pane-workbench-status', 'Workbench: connect host to read projects.');
  status.setAttribute('role', 'status');
  const error = el('p', 'pane-workbench-error');
  error.setAttribute('role', 'alert');
  const staleNote = el('p', 'pane-workbench-stale');
  staleNote.hidden = true;

  const projectSelect = el('select', 'pane-workbench-project');
  projectSelect.setAttribute('aria-label', 'Workbench project');
  const taskSelect = el('select', 'pane-workbench-task');
  taskSelect.setAttribute('aria-label', 'Workbench task');
  const candidateSelect = el('select', 'pane-workbench-candidate');
  candidateSelect.setAttribute('aria-label', 'Workbench candidate');
  const attemptSelect = el('select', 'pane-workbench-attempt');
  attemptSelect.setAttribute('aria-label', 'Workbench attempt');
  const resultSelect = el('select', 'pane-workbench-result');
  resultSelect.setAttribute('aria-label', 'Workbench result');

  const labelled = (name: string, control: HTMLElement): HTMLElement => {
    const label = el('label', 'pane-workbench-field');
    label.append(el('span', '', name), control);
    return label;
  };

  const newTask = button('New task', 'Open task creation and context handoff', () => {
    setup.open = true;
    handoff.open = true;
    taskTitle.focus();
  }, 'small-button');
  const openFull = button('Full Project Workbench', 'Open the complete Project Workbench for registration, files and Doctor', () => {
    void import('./project-workbench').then((m) => m.showProjectWorkbench(deps.getToken)).catch(fail);
  }, 'small-button');
  // Read-only re-read. Also the explicit manual step that clears an ambiguous
  // task-creation outcome (which is never auto-retried).
  const refreshAll = button('Refresh', 'Re-read projects, tasks and state without executing anything', () => { taskCreatePending = false; void load(); }, 'small-button');
  const settings = el('details', 'pane-workbench-settings');
  settings.append(el('summary', '', 'Task settings'));
  const chooser = el('div', 'pane-workbench-chooser');
  chooser.append(labelled('Project', projectSelect), labelled('Task', taskSelect));
  const identities = el('details', 'pane-workbench-identities');
  identities.append(el('summary', '', 'Candidate, attempt and result selection'));
  identities.append(labelled('Candidate', candidateSelect), labelled('Attempt', attemptSelect), labelled('Result', resultSelect));
  chooser.append(identities, newTask, refreshAll, openFull);
  if (deps.onOpenNormal) chooser.append(button('Open Normal chat window', 'Open or focus the separate Normal chat window', deps.onOpenNormal, 'small-button'));
  settings.append(chooser);
  head.append(settings);

  // Actual selected-scope header. Values come from the selected records and the
  // durable snapshot; anything absent reads "unknown" rather than newest.
  const header = el('div', 'pane-workbench-scope');
  const scopeLine = el('p', 'pane-workbench-scope-line');
  const startNote = el('p', 'pane-workbench-start');
  const startButton = button('Choose a project and task', 'Open Task settings to choose a project and task explicitly', () => {
    settings.open = true;
    projectId ? taskSelect.focus() : projectSelect.focus();
  }, 'small-button');
  startNote.append(el('span', '', 'Start by choosing a project and task. Selection does not grant authority. '), startButton);
  const candidateLine = el('p', 'pane-workbench-candidate-line');
  const grantLine = el('p', 'pane-workbench-grant-line');
  header.append(scopeLine, head, startNote, candidateLine);
  const scopeDetails = el('details', 'pane-workbench-exact-scope');
  const scopeIdentity = el('pre', 'pane-workbench-scope-identities');
  scopeDetails.append(el('summary', '', 'Exact scope and runtime details'), scopeIdentity, grantLine, status);
  settings.append(scopeDetails);

  const authority = el('details', 'pane-workbench-authority');
  authority.append(el('summary', '', 'Authority · attempt, consent and readiness'));
  const authorityContainer = el('div', 'pane-workbench-authority-body');
  authority.append(authorityContainer);

  const tabBar = el('div', 'pane-workbench-tabs');
  tabBar.setAttribute('role', 'tablist');
  const panels: Record<string, HTMLElement> = {
    live: el('section', 'pane-workbench-panel'),
    changes: el('section', 'pane-workbench-panel'),
    checks: el('section', 'pane-workbench-panel'),
    result: el('section', 'pane-workbench-panel'),
  };
  const liveNote = el('p', 'pane-workbench-live-note', 'Private durable Workbench activity. Connecting…');
  const liveSlotEl = el('div', 'pane-workbench-live-slot');
  // The Workbench owns its own renderer instance, independent of the Normal feed.
  deps.timeline.element.classList.add('pane-workbench-live-timeline');
  liveSlotEl.append(deps.timeline.element);
  panels.live.append(liveNote, liveSlotEl);
  const executionPanel = panels.checks;
  const executionContainer = el('div', 'pane-workbench-execution');
  executionPanel.append(executionContainer);
  const changesPanel = panels.changes;
  const changesNote = el('p', 'pane-workbench-changes-note', 'Select a candidate to inspect its exact retained generation transition.');
  const comparisonSelect = el('select', 'pane-workbench-comparison');
  comparisonSelect.setAttribute('aria-label', 'Candidate comparison');
  for (const [value, label] of [['initial', 'Overall candidate · generation 1 → selected'], ['previous', 'Latest transition · preceding → selected']] as const) {
    const option = el('option', '', label); option.value = value; comparisonSelect.append(option);
  }
  const changesDiff = el('div', 'pane-workbench-changes-diff');
  const detailPath = el('input'); detailPath.placeholder = 'Exact changed file path'; detailPath.setAttribute('aria-label', 'Inspect one exact changed file');
  const fileReadControls = el('div', 'pane-workbench-file-read');
  fileReadControls.hidden = true;
  fileReadControls.append(detailPath, button('Inspect file', 'Read one changed file from these exact generations within the private source bound', () => { clearChanges(); void refreshChanges(); }, 'small-button'), button('All changed files', 'Restore bounded comparison of all changed files', () => { detailPath.value = ''; clearChanges(); void refreshChanges(); }, 'small-button'));
  fileReadControls.append(el('small', '', 'For partial comparisons, inspect a specific changed path. The same exact identities and 64 KiB limit apply.'));
  const workflowContainer = el('div', 'pane-workbench-workflow');
  const arrangementContainer = el('div', 'pane-workbench-arrangements');
  const arrangementDisclosure = el('details', 'pane-workbench-arrangements-disclosure');
  arrangementDisclosure.append(el('summary', '', 'Workspace arrangements'), arrangementContainer);
  const exportTools = el('details', 'pane-workbench-export-tools');
  exportTools.append(el('summary', '', 'Verified patch and integration actions'), workflowContainer);
  changesPanel.append(labelled('Compare', comparisonSelect), changesNote, fileReadControls, changesDiff, arrangementDisclosure, exportTools);
  comparisonSelect.addEventListener('change', () => { clearChanges(); void refreshChanges(); });
  const resultPanel = panels.result;
  const tabButtons = new Map<string, HTMLButtonElement>();
  const tabPreferenceKey = `orbit-workbench-tab:${deps.workspaceId}:${deps.paneId}`;
  let preferredTab = 'live';
  let userSelectedTab = false;
  try { const saved = localStorage.getItem(tabPreferenceKey); if (saved && Object.hasOwn(panels, saved)) { preferredTab = saved; userSelectedTab = true; } } catch {}
  function showTab(name: string, explicit = false) {
    if (explicit) { userSelectedTab = true; try { localStorage.setItem(tabPreferenceKey, name); } catch {} }
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== name;
      const tab = tabButtons.get(key);
      if (tab) {
        tab.setAttribute('aria-selected', String(key === name));
        tab.classList.toggle('active', key === name);
      }
    }
    if (name === 'changes') void refreshChanges();
  }
  for (const [key, label] of [['live', 'Live'], ['changes', 'Changes'], ['checks', 'Checks'], ['result', 'Result']] as const) {
    const tab = button(label, `${label} workbench view`, () => showTab(key, true), 'pane-workbench-tab');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tabButtons.set(key, tab);
    tabBar.append(tab);
  }
  const openReview = button('Open candidate Review view', 'Create or select one trusted project-bound Review pane', () => {
    if (!projectId) return;
    openReview.disabled = true;
    void import('./workbench-review-host')
      .then((m) => m.openWorkbenchReview(projectId as string, deps.getToken))
      .catch(fail)
      .finally(() => { openReview.disabled = false; });
  }, 'small-button');
  changesPanel.append(openReview);

  function clearChanges() {
    changesController?.abort(); changesController = null;
    changesViewer?.dispose(); changesViewer = null;
    changesDiff.replaceChildren(); changesKey = ''; changesTicket++;
  }
  async function refreshChanges() {
    if (panels.changes.hidden || disposed) return;
    const candidate = selectedCandidate();
    if (!projectId || !candidate || !Number.isSafeInteger(candidate.generation) || typeof candidate.hash !== 'string') {
      clearChanges(); changesNote.textContent = 'Select a current candidate to inspect an exact generation transition.'; return;
    }
    const comparison = comparisonSelect.value as 'initial' | 'previous';
    const requestedPath = detailPath.value;
    const key = JSON.stringify([projectId,candidate.id,candidate.generation,candidate.hash,comparison,requestedPath]);
    if (key === changesKey) return;
    clearChanges(); changesKey = key;
    const ticket = changesTicket;
    const source = liveClient;
    changesController = new AbortController();
    changesNote.textContent = `Reading exact candidate ${candidate.id} generation ${candidate.generation}…`;
    if (!source) { changesNote.textContent = 'Private activity scope is not connected. Refresh the selected scope.'; changesKey = ''; return; }
    try {
      const detail = await source.detail({ kind: 'candidate', id: candidate.id, generation: candidate.generation, hash: candidate.hash }, changesController.signal, comparison, requestedPath || undefined);
      const data = candidateDiffFromDetail(detail, { candidate_id: candidate.id, generation: candidate.generation, candidate_hash: candidate.hash });
      if (disposed || ticket !== changesTicket || source !== liveClient) return;
      const { createCandidateDiffViewer } = await import('./candidate-diff-viewer');
      if (disposed || ticket !== changesTicket) return;
      changesViewer = createCandidateDiffViewer(data, { title: comparison === 'initial' ? `Initial candidate generation 1 → generation ${candidate.generation}` : `Latest transition → generation ${candidate.generation}` });
      fileReadControls.hidden = !(requestedPath || data.truncated || (data.changed_files ?? 0) > (data.files?.length ?? 0));
      changesDiff.replaceChildren(changesViewer.element);
      changesNote.textContent = data.available ? 'Private read-only candidate-generation comparison · not the Git base or recorder verification.' : `Exact comparison unavailable: ${data.reason ?? 'unavailable'}. No newer content substituted.`;
    } catch (reason) {
      if (disposed || ticket !== changesTicket) return;
      changesKey = '';
      changesNote.textContent = `Exact transition unavailable: ${reason instanceof Error ? reason.message : 'unavailable'}. No newer content substituted.`;
    }
  }

  const handoff = el('details', 'pane-workbench-handoff');
  handoff.append(el('summary', '', 'Create supervised task / hand off selected context'));
  const handoffList = el('div', 'pane-workbench-excerpts');
  const composer = el('textarea', 'pane-workbench-composer');
  composer.rows = 3;
  composer.maxLength = 8000;
  composer.placeholder = 'Task or question to include as an explicit excerpt…';
  composer.setAttribute('aria-label', 'Task or question excerpt');
  const excerptCount = el('p', 'pane-workbench-excerpt-count');
  const preview = el('pre', 'pane-workbench-excerpt-preview', 'Select excerpts or compose a task to preview the exact bytes that would be captured.');
  const previewBytes = el('p', 'pane-workbench-excerpt-bytes');
  const boundNote = el('p', 'pane-workbench-excerpt-bound', 'Selected excerpts are captured into a selectable context packet; the packet is not disclosure or approval. The whole conversation is never inherited.');
  const capture = button('Capture selected context packet', 'Freeze exactly the previewed selected excerpts into a packet selectable in Task authority', () => void captureExcerpts(), 'small-button');
  const refreshHandoff = button('Refresh excerpts', 'Rebuild the excerpt checklist from the current conversation', () => { invalidateExcerptPreview(); renderHandoff(); }, 'small-button');
  const previewButton = button('Preview context packet', 'Preview the exact capture and packet request without sending anything', () => void renderPreview(), 'small-button');
  handoff.append(handoffList, composer, excerptCount, previewButton, preview, capture, refreshHandoff, boundNote, previewBytes);

  // Create/select the actual task (not capture-only). Uses the existing
  // task_create contract with an explicit owner-chosen acceptance statement and
  // allowlisted check definition. Preview first; nothing is created until then.
  const taskTitle = el('input', 'pane-workbench-task-title');
  taskTitle.setAttribute('aria-label', 'Task title (handoff)');
  taskTitle.placeholder = 'Task title';
  taskTitle.maxLength = 240;
  const taskAcceptance = el('textarea', 'pane-workbench-task-acceptance');
  taskAcceptance.setAttribute('aria-label', 'Acceptance statement (handoff)');
  taskAcceptance.rows = 2;
  taskAcceptance.maxLength = 4000;
  taskAcceptance.value = 'The requested change is applied and the recorded check passes.';
  const definitionSelect = el('select', 'pane-workbench-task-definition');
  definitionSelect.setAttribute('aria-label', 'Task check definition (handoff)');
  const taskPreview = el('pre', 'pane-workbench-task-preview', 'Preview the exact task_create request before creating anything.');
  const previewTask = button('Preview task', 'Preview the exact task_create fields without creating a task', () => renderTaskPreview(), 'small-button');
  const createTask = button('Create task', 'Create the task with the previewed acceptance and check definition', () => void createTaskNow(), 'small-button');
  handoff.append(labelled('Task title', taskTitle), labelled('Acceptance statement', taskAcceptance), labelled('Check definition', definitionSelect), previewTask, createTask, taskPreview);
  const contextUi = button('Open file / diff / job context…', 'Use the existing context review to add a file, diff or job snapshot', () => {
    if (!projectId) { fail(new Error('Choose a project first.')); return; }
    void import('./workbench-context')
      .then((m) => m.showWorkbenchContext({ token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectId as string, source: { kind: 'diff', expected_hash: '' } }))
      .catch(fail);
  }, 'small-button');
  handoff.append(contextUi);
  const advanced = el('details', 'pane-workbench-advanced');
  advanced.append(el('summary', '', 'Handoff is data, never approval: capturing context does not start a worker.'));
  advanced.append(el('p', '', 'Approval and execution happen only in the authority and Checks controls, against the exact previewed snapshot.'));

  // Task creation and context handoff are deliberate task-setup operations.
  const setup = el('details', 'pane-workbench-setup');
  setup.append(el('summary', '', 'Task handoff · selected conversation and context'));
  setup.append(handoff, advanced);
  executionPanel.prepend(authority);

  root.append(header, error, staleNote, tabBar, panels.live, panels.changes, panels.checks, panels.result, setup);
  deps.body.replaceChildren(root);
  showTab('live');
  // Restore only after the pane's caches and adapters have been initialized.
  queueMicrotask(() => { if (!disposed) showTab(preferredTab); });

  function fail(reason: unknown) {
    if (disposed) return;
    const message = reason instanceof Error ? reason.message : 'unavailable';
    error.textContent = message;
    deps.onError?.(message);
  }

  async function owner(endpoint: string, body: Data): Promise<Data> {
    const token = deps.getToken();
    if (!token) throw Error('permission_denied');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = (await response.json()) as Data;
    if (!response.ok || data.ok !== true) {
      const code = typeof data.code === 'string' ? data.code : 'unavailable';
      // A typed code is an authoritative outcome; a thrown fetch/parse error
      // (no code) is an ambiguous network outcome.
      throw Object.assign(Error(code), { code });
    }
    return data;
  }

  function options(select: HTMLSelectElement, placeholder: string, values: { id: string; label: string }[], current: string | null) {
    select.replaceChildren();
    const none = el('option', '', placeholder);
    none.value = '';
    select.append(none);
    for (const value of values) {
      const option = el('option', '', value.label);
      option.value = value.id;
      select.append(option);
    }
    select.value = values.some((value) => value.id === current) ? (current as string) : '';
    // Once an explicitly chosen identity is the only alternative, display its
    // human label rather than a one-item dropdown. A missing selection still
    // requires an explicit choice, even when there is only one option.
    if (select !== definitionSelect) {
      const onlySelected = values.length === 1 && select.value === values[0].id;
      select.hidden = onlySelected;
      let label = select.nextElementSibling as HTMLElement | null;
      if (!label?.classList.contains('pane-workbench-only-choice')) {
        label = el('span', 'pane-workbench-only-choice');
        select.insertAdjacentElement('afterend', label);
      }
      label.textContent = onlySelected ? values[0].label : '';
      label.hidden = !onlySelected;
      let clear = select.parentElement?.nextElementSibling as HTMLButtonElement | null;
      if (!clear?.classList.contains('pane-workbench-clear-choice')) {
        clear = button(`Clear ${select.getAttribute('aria-label') ?? 'selection'}`, 'Clear this explicit Workbench selection', () => {
          select.hidden = false;
          label!.hidden = true;
          clear!.hidden = true;
          select.value = '';
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.focus();
        }, 'small-button pane-workbench-clear-choice');
        select.parentElement?.insertAdjacentElement('afterend', clear);
      }
      clear.hidden = !onlySelected;
    }
  }

  function syncTopSelects() {
    for (const [select, value] of [[taskSelect, prefs.taskId], [candidateSelect, prefs.candidateId], [attemptSelect, prefs.attemptId], [resultSelect, prefs.resultId]] as const) {
      options(select, select.options[0]?.textContent ?? 'Choose explicitly…', Array.from(select.options).filter(option => !!option.value).map(option => ({id:option.value,label:option.textContent ?? option.value})), value);
    }
  }

  function pushScope() {
    applyingScope = true;
    authorityMount?.setScope?.({ taskId: prefs.taskId, candidateId: prefs.candidateId, attemptId: prefs.attemptId, contextId: pendingPacketId, paneId: deps.paneId });
    resultMount?.setScope?.({ grantId: prefs.grantId, resultId: prefs.resultId });
    applyingScope = false;
  }
  function pushLane() {
    // Only an observed lane may disable Start; not-observed is not a fence.
    authorityMount?.setLane?.({ busy: laneState.observed && (laneState.agent_busy || laneState.job_busy), unknown: laneState.observed && laneState.unknown });
  }

  function reconcile(present: { projects: Set<string>; tasks: Set<string>; candidates: Set<string>; attempts: Set<string>; grants: Set<string>; results: Set<string> }) {
    const patch: Partial<PaneWorkbenchPrefs> = {};
    const notes: string[] = [];
    const clearWork = () => { patch.taskId = null; patch.candidateId = null; patch.attemptId = null; patch.grantId = null; patch.resultId = null; patch.reviewId = null; };
    if (prefs.projectId && !present.projects.has(prefs.projectId)) { patch.projectId = null; clearWork(); notes.push('The previously selected project is no longer active or authorized.'); }
    if (prefs.taskId && !present.tasks.has(prefs.taskId)) { patch.taskId = null; patch.candidateId = null; patch.attemptId = null; patch.grantId = null; patch.resultId = null; patch.reviewId = null; notes.push('The previously selected task is no longer current.'); }
    if (prefs.candidateId && !present.candidates.has(prefs.candidateId)) { patch.candidateId = null; patch.attemptId = null; patch.grantId = null; patch.resultId = null; patch.reviewId = null; notes.push('The previously selected candidate is no longer current.'); }
    if (prefs.attemptId && !present.attempts.has(prefs.attemptId)) { patch.attemptId = null; patch.grantId = null; patch.resultId = null; notes.push('The previously selected attempt is no longer current.'); }
    if (prefs.grantId && !present.grants.has(prefs.grantId)) { patch.grantId = null; patch.resultId = null; notes.push('The previously selected native consent record is no longer current.'); }
    if (prefs.resultId && !present.results.has(prefs.resultId)) { patch.resultId = null; notes.push('The previously selected result is no longer current.'); }
    if (Object.keys(patch).length) {
      deps.onPrefs(patch);
      prefs = { ...prefs, ...patch };
    }
    if (notes.length) {
      staleNote.hidden = false;
      staleNote.textContent = `Prior selection cleared (no substitution): ${notes.join(' ')} Choose explicitly.`;
    }
  }

  // ---- header -------------------------------------------------------------
  function selectedCandidate(): Data | null {
    return (candidateCache.find((candidate) => candidate.id === prefs.candidateId) as Data | undefined) ?? null;
  }
  let candidateCache: Data[] = [];
  let grantCache: Data[] = [];
  let definitions: Data[] = [];
  let projectName: string | null = null;
  let taskCache: Data[] = [];

  function renderHeader() {
    const project = projectName || 'Choose project';
    const task = taskCache.find((entry) => entry.id === prefs.taskId);
    const snapshot = latestSnapshot;
    scopeLine.textContent = `${project}  /  ${task?.title ?? 'Choose task'}${task?.status ? ` · ${task.status}` : ''}`;
    startNote.hidden = !!(projectId && prefs.taskId);
    // An attempt-scoped live snapshot may contain a later candidate generation.
    // Never present that identity as if the owner explicitly selected it.
    const candidate = selectedCandidate();
    scopeIdentity.textContent = `Project: ${projectId ?? 'not selected'}\nTask: ${prefs.taskId ?? 'not selected'}\nAttempt: ${prefs.attemptId ?? 'not selected'}\nCandidate: ${candidate?.id ?? 'not selected'}\nGeneration: ${candidate?.generation ?? 'unknown'}\nCandidate hash: ${candidate?.hash ?? 'unknown'}\nGrant: ${prefs.grantId ?? 'not selected'}\nResult: ${prefs.resultId ?? 'not selected'}`;
    candidateLine.textContent = candidate
      ? `Candidate ${unknown(candidate.generation, '?')} · ${unknown(candidate.status)}${snapshot?.candidate?.id === candidate.id && snapshot?.candidate?.hash !== candidate.hash ? ' · newer version observed; refresh before acting' : ''}`
      : 'No candidate selected';
    // Header metrics come only from the durable page snapshot, never a repeated
    // native status read. Anything the snapshot does not expose stays "unknown".
    const grant = snapshot?.grant ?? null;
    const job = snapshot?.job ?? null;
    const duration = (ms: number) => `${String(Math.floor(Math.max(0, ms) / 60000)).padStart(2, '0')}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, '0')}`;
    const elapsed = grant?.started_at ? duration((grant.ended_at ?? Date.now()) - grant.started_at) : 'unknown';
    const expires = grant?.expires_at ? (grant.expires_at <= Date.now() ? 'expired' : `in ${duration(grant.expires_at - Date.now())}`) : 'unknown';
    grantLine.textContent = grant
      ? `${unknown(grant.model)} · supervised Hermes · ${unknown(grant.status)} · calls ${unknown(grant.calls_used)}/${unknown(grant.budget?.calls)} · checks ${unknown(grant.checks_used)}/${unknown(grant.budget?.checks)} · repairs ${unknown(grant.repairs_used)}/${unknown(grant.budget?.repair_iterations)} · elapsed ${elapsed} · authority ${expires}`
        + (job ? ` · ${unknown(job.definition_id)} ${unknown(job.status)}${job.started_at ? ` · ${duration((job.ended_at ?? Date.now()) - job.started_at)}` : ''}` : '')
        + (laneNote ? ` · lane ${laneNote}` : '')
      : `No attempt-scoped authority selected`
        + (laneNote ? ` · lane ${laneNote}` : '');
  }

  function emitBadge() {
    const snapshot = latestSnapshot;
    const attemptScoped = snapshot?.scope === 'attempt';
    // Selected-scope grant: the attempt-scoped snapshot grant when present, else
    // the cached native grant for the exact selected attempt — never the newest
    // unrelated grant. The global gate remains authoritative for global busy.
    const snapshotGrant = attemptScoped ? (snapshot?.grant ?? null) : null;
    const cachedGrant = prefs.attemptId
      ? (grantCache.find((entry) => String(entry.attempt_id) === prefs.attemptId) ?? null)
      : null;
    const grant = snapshotGrant ?? cachedGrant;
    const grantStatus = String(grant?.status ?? '');
    const runtimeStatus = String(grant?.runtime_status ?? '');
    // A live run is a first-class visible state, independent of a momentarily
    // stale global lane snapshot.
    const running = grantStatus === 'running' || /^(running|started|in_progress|starting)$/.test(runtimeStatus);
    const failed = /fail|error/.test(grantStatus) || /fail/.test(runtimeStatus);
    const stopRequested = grantStatus === 'stop_requested';
    const outcomeUnknown = /^(dispatch_unknown|submission_unknown|outcome_unknown)$/.test(grantStatus);
    const stopped = /^(stopped|cancelled|revoked|denied|expired)$/.test(grantStatus);
    const waiting = /approved|prepared|dispatching|paused_budget|stop_requested|submission_unknown|dispatch_unknown/.test(grantStatus);
    // Only an explicitly observed lane counts; "not observed yet" is never a fence.
    const globalLaneBusy = laneState.observed && (laneState.agent_busy || laneState.job_busy);
    const executionUnresolved = running || stopRequested || outcomeUnknown || grantStatus === 'starting';
    const laneBusy = globalLaneBusy || executionUnresolved;
    // A pending receipt is NOT a completed result. Count available results only
    // for the selected scope; fall back to the server count solely when the scope
    // exposes no result record.
    const scopedResult = attemptScoped ? (snapshot?.result ?? null) : (snapshot?.latest_result ?? null);
    const resultAvailability = String(scopedResult?.availability ?? '');
    const results = scopedResult
      ? (resultAvailability === 'available' ? 1 : 0)
      : (snapshot ? Number(snapshot.results) || 0 : cardCache.length);
    const activeGrants = snapshot ? Number(snapshot.active_grants) || 0 : 0;
    const activeJobs = snapshot ? Number(snapshot.active_jobs) || 0 : 0;
    const cachedPending = grantCache.filter((entry) => ['approved', 'running', 'prepared', 'dispatching', 'submission_unknown', 'result_pending', 'dispatch_unknown'].includes(String(entry.status))).length;
    const pending = running ? 1
      : waiting ? Math.max(1, activeGrants + activeJobs)
      : (snapshot ? activeGrants + activeJobs : cachedPending) + (resultAvailability === 'pending' ? 1 : 0);
    const stateLabel = outcomeUnknown || (laneState.observed && laneState.unknown) ? 'Execution outcome unknown'
      : stopRequested ? 'Stop requested'
      : failed ? 'Failed'
      : stopped ? 'Stopped'
      : running ? 'Running'
      : waiting ? 'Waiting'
      : globalLaneBusy ? 'Lane busy'
      : resultAvailability === 'pending' ? 'Result pending'
      : `${pending} pending · ${results} result(s)`;
    const badge: PaneWorkbenchBadge = { mode: 'workbench', pending, results, laneBusy, status: stateLabel };
    deps.onBadge(badge);
    // Report a busy lane while this pane's selected grant is live so a hidden
    // Normal view never enables Send against a real run even if the global lane
    // snapshot is momentarily stale.
    // "Not observed yet" must never be reported as execution unknown; only an
    // explicit server lane.unknown or an unresolved selected grant qualifies.
    deps.onLane({ agent_busy: laneState.agent_busy || executionUnresolved, job_busy: laneState.job_busy, unknown: (laneState.observed && laneState.unknown) || outcomeUnknown, observed: laneState.observed });
  }
  let cardCache: Data[] = [];
  // `observed` distinguishes "no authoritative lane read yet" from an explicit
  // execution-unknown fence. It starts false so an opened Workbench with no
  // project/scope cannot fabricate a permanent unknown.
  let laneState: { agent_busy: boolean; job_busy: boolean; unknown: boolean; observed: boolean } = { agent_busy: false, job_busy: false, unknown: false, observed: false };

  function reflectLane(lane: { agent_busy: boolean; job_busy: boolean; unknown: boolean }) {
    laneState = { agent_busy: lane.agent_busy === true, job_busy: lane.job_busy === true, unknown: lane.unknown === true, observed: true };
    laneNote = laneState.unknown ? 'unknown' : laneState.agent_busy || laneState.job_busy ? 'busy' : 'idle';
    emitBadge();
    pushLane();
    renderHeader();
  }

  // ---- live client --------------------------------------------------------
  function stopLive() {
    clearChanges();
    for (const dialog of detailDialogs) dialog.close();
    liveClient?.dispose();
    liveClient = null;
    liveAttempt = null;
    // A stopped scope is "not observed", never an execution-unknown fence; the
    // authoritative shared_chat execution_lane is unaffected.
    laneState = { agent_busy: false, job_busy: false, unknown: false, observed: false };
    deps.onLane({ agent_busy: false, job_busy: false, unknown: false, observed: false });
    pushLane();
  }
  function startLive() {
    if (disposed || !projectId) return;
    const attemptId = prefs.attemptId || undefined;
    stopLive();
    liveAttempt = prefs.attemptId;
    liveNote.textContent = 'Private durable Workbench activity. Connecting…';
    liveClient = watchWorkbenchLive({
      workspaceId: deps.workspaceId,
      projectId,
      ...(attemptId ? { attemptId } : {}),
      getToken: deps.getToken,
      onPage: (page: WorkbenchLivePage) => {
        if (disposed) return;
        deps.timeline.upsert(page.events);
        const selected = selectedCandidate();
        if (selected && page.events.some(event => event.reference?.kind === 'candidate' && event.reference.id === selected.id && (event.reference.generation ?? 0) > selected.generation)) {
          staleNote.hidden = false;
          staleNote.textContent = 'The selected candidate changed. Refresh setup before acting; no newer candidate has been selected for you.';
        }
        applyLiveSnapshot(page.snapshot ?? null);
        if (page.lane) reflectLane(page.lane);
        emitBadge();
        renderHeader();
      },
      onConnection: (state, message) => {
        if (disposed) return;
        deps.timeline.setConnection(state, message);
        liveNote.textContent = `Private durable Workbench activity: ${state}${message ? ` · ${message}` : ''}`;
      },
      onReset: () => {
        if (disposed) return;
        deps.timeline.reset();
        latestSnapshot = null;
        renderHeader();
      },
      onLane: (lane) => { if (!disposed) reflectLane(lane); },
      onSnapshot: (snapshot) => { if (!disposed) { applyLiveSnapshot(snapshot); emitBadge(); renderHeader(); } },
    });
    void refreshChanges();
  }

  function applyLiveSnapshot(snapshot: Data | null) {
    const before = latestSnapshot?.candidate, after = snapshot?.candidate;
    if (before?.id && before.id === after?.id && (before.hash !== after.hash || before.generation !== after.generation)) {
      staleNote.hidden = false;
      staleNote.textContent = `Candidate changed to generation ${unknown(after.generation)}. Refresh setup before acting; review and consent must bind the current identity.`;
    }
    latestSnapshot = snapshot;
    if (!userSelectedTab && snapshot?.scope === 'attempt') {
      const candidateMatches = after?.id && after.id === prefs.candidateId && after.hash === selectedCandidate()?.hash;
      if (snapshot.result?.availability === 'available') showTab('result');
      else if (snapshot.job && ['completed', 'failed', 'cancelled', 'inconclusive'].includes(String(snapshot.job.status))) showTab('checks');
      else if (candidateMatches && (!before || before.hash !== after.hash)) showTab('changes');
    }
    if (!panels.changes.hidden && after?.id === prefs.candidateId && (before?.hash !== after?.hash || before?.generation !== after?.generation)) {
      // The top selector still names its last explicit selection. A newer live
      // snapshot must not silently replace it; request an explicit refresh.
      changesNote.textContent = 'A newer generation was observed. Refresh setup to choose the new identity explicitly.';
    }
  }

  // ---- project/task/candidate selectors -----------------------------------
  async function load() {
    if (disposed || busy) return;
    const ticket = ++epoch;
    busy = true;
    error.textContent = '';
    if (!deps.getToken()) {
      status.textContent = 'Workbench: connect host to read projects.';
      options(projectSelect, 'Connect host', [], null);
      busy = false;
      return;
    }
    status.textContent = 'Workbench: loading projects…';
    try {
      const listed = await owner('/api/workbench', { action: 'list', workspace_id: deps.workspaceId });
      if (disposed || ticket !== epoch) return;
      const projects: Data[] = (listed.projects ?? []).filter((project: Data) => project.active !== false);
      const projectIds = new Set<string>(projects.map((project) => String(project.id)));
      if (prefs.projectId && !projectIds.has(prefs.projectId)) {
        deps.onPrefs({ projectId: null, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null });
        prefs = { ...prefs, projectId: null, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null };
        latestSnapshot = null; pendingPacketId = null;
        invalidateExcerptPreview(); invalidateTaskPreview();
        deps.timeline.reset(); stopLive(); disposePanels();
        staleNote.hidden = false;
        staleNote.textContent = 'Prior project selection cleared (no substitution): it is no longer active or authorized. Choose explicitly.';
      }
      projectId = prefs.projectId && projectIds.has(prefs.projectId) ? prefs.projectId : null;
      projectName = projects.find((project) => String(project.id) === projectId)?.name ?? null;
      options(projectSelect, 'Choose project…', projects.map((project) => ({ id: String(project.id), label: String(project.name ?? project.id) })), projectId);

      let tasks: Data[] = [];
      let candidates: Data[] = [];
      let attempts: Data[] = [];
      if (projectId) {
        const binding = deps.binding();
        const [execution, context, native, cardPage] = await Promise.all([
          owner('/api/workbench/execution', { action: 'execution_state', workspace_id: deps.workspaceId, project_id: projectId }),
          owner('/api/workbench/context', { action: 'list', workspace_id: deps.workspaceId, project_id: projectId }),
          owner('/api/workbench/native', { action: 'list', workspace_id: deps.workspaceId, project_id: projectId }),
          owner('/api/workbench/native', { action: 'cards_list', workspace_id: deps.workspaceId, pane_id: deps.paneId, profile_id: binding.profileId, session_id: binding.sessionId }),
        ]);
        if (disposed || ticket !== epoch) return;
        tasks = Array.isArray(execution.tasks) ? execution.tasks : [];
        candidates = Array.isArray(execution.candidates) ? execution.candidates : [];
        definitions = Array.isArray(execution.definitions) ? execution.definitions : [];
        attempts = Array.isArray(context.attempts) ? context.attempts : [];
        grantCache = Array.isArray(native.grants) ? native.grants : [];
        cardCache = Array.isArray(cardPage.cards) ? cardPage.cards : [];
        reconcile({
          projects: projectIds,
          tasks: new Set(tasks.map((task) => String(task.id))),
          candidates: new Set(candidates.map((candidate) => String(candidate.id))),
          attempts: new Set(attempts.map((attempt) => String(attempt.id))),
          grants: new Set(grantCache.map((grant) => String(grant.id))),
          results: new Set(cardCache.map((card) => String(card.result_id))),
        });
      } else {
        grantCache = [];
        cardCache = [];
      }
      taskCache = tasks;
      candidateCache = candidates;
      options(taskSelect, projectId ? 'Choose task…' : 'Choose project first', (projectId ? tasks : []).map((task) => ({ id: String(task.id), label: `${task.title ?? task.id} · ${task.status ?? ''}` })), prefs.taskId);
      options(candidateSelect, projectId ? 'Choose candidate…' : 'Choose project first', (projectId ? candidates : []).map((candidate, index) => ({ id: String(candidate.id), label: `Candidate ${index + 1} · generation ${candidate.generation ?? '?'} · ${candidate.status ?? ''}` })), prefs.candidateId);
      options(attemptSelect, projectId ? 'Choose attempt…' : 'Choose project first', (projectId ? attempts : []).map((attempt, index) => ({ id: String(attempt.id), label: `Attempt ${index + 1} · ${attempt.status ?? 'ready'}` })), prefs.attemptId);
      options(resultSelect, projectId ? 'Choose result…' : 'Choose project first', (projectId ? cardCache : []).map((card) => ({ id: String(card.result_id), label: `${card.result_id} · ${card.availability ?? ''}` })), prefs.resultId);
      options(definitionSelect, projectId ? 'Choose check definition…' : 'Choose project first', (projectId ? definitions : []).map((definition) => ({ id: String(definition.id), label: `${definition.id}${definition.executable ? ` · ${definition.executable}` : ''}` })), definitionSelect.value || null);
      if (projectId && !definitionSelect.value && definitions.length) definitionSelect.value = String(definitions[0].id);
      renderHeader();
      emitBadge();
      // Hidden (Normal-selected) mode monitors read-only: it never mounts the
      // authority/execution controls until the Workbench view is actually shown.
      if (projectId && projectId !== mountedFor && visible) await mountPanels(projectId, ticket);
      if (disposed || ticket !== epoch) return;
      pushScope();
      pushLane();
      if (projectId && (!liveClient || liveAttempt !== (prefs.attemptId ?? null))) startLive();
      void refreshChanges();
      status.textContent = projectId
        ? `Selected project · ${grantCache.length} grant(s) · ${cardCache.length} result(s). Actions require explicit approval.`
        : `Choose a project explicitly to begin (${projects.length} available).`;
      renderHandoff();
    } catch (reason) {
      if (disposed || ticket !== epoch) return;
      if (!deps.getToken()) status.textContent = 'Workbench: connect host to read projects.';
      else { status.textContent = 'Workbench: state unavailable.'; fail(reason); }
    } finally {
      if (ticket === epoch) busy = false;
    }
  }

  async function mountPanels(projectIdValue: string, ticket: number) {
    disposePanels();
    const [{ mountWorkbenchExecution }, { mountWorkbenchTaskAuthority }, { mountWorkbenchWorkflow }, { mountWorkbenchTaskResult }] = await Promise.all([
      import('./workbench-execution'),
      import('./workbench-task-authority'),
      import('./workbench-workflow'),
      import('./workbench-task-result'),
    ]);
    if (disposed || ticket !== epoch || prefs.projectId !== projectIdValue) return;
    authorityMount = mountWorkbenchTaskAuthority({
      container: authorityContainer,
      token: deps.getToken,
      workspace_id: deps.workspaceId,
      project_id: projectIdValue,
      scope: { taskId: prefs.taskId, candidateId: prefs.candidateId, attemptId: prefs.attemptId, contextId: pendingPacketId, paneId: deps.paneId },
      lane: { busy: laneState.agent_busy || laneState.job_busy, unknown: laneState.unknown },
      onScopeChange: (next) => {
        if (applyingScope || disposed) return;
        const attemptChanged = (next.attemptId ?? null) !== (prefs.attemptId ?? null);
        pendingPacketId = next.contextId ?? pendingPacketId;
        prefs = { ...prefs, candidateId: next.candidateId, attemptId: next.attemptId };
        deps.onPrefs({ candidateId: next.candidateId, attemptId: next.attemptId });
        // A capture preview is bound to one attempt; changing it clears the preview.
        if (attemptChanged) invalidateExcerptPreview();
        syncTopSelects();
        renderHeader();
        if (!userSelectedTab) {
          if (next.candidateId) showTab('changes');
          else if (next.attemptId) showTab('checks');
        }
        if (attemptChanged) startLive();
      },
    });
    executionMount = mountWorkbenchExecution({ container: executionContainer, token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectIdValue, onError: (message) => { error.textContent = message; } });
    workflowMount = mountWorkbenchWorkflow({ container: workflowContainer, arrangementContainer, token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectIdValue, onError: (message) => { error.textContent = message; } });
    resultMount = mountWorkbenchTaskResult({
      container: resultPanel,
      compact: true,
      token: deps.getToken,
      workspace_id: deps.workspaceId,
      project_id: projectIdValue,
      scope: { grantId: prefs.grantId, resultId: prefs.resultId },
      onChanged: () => { if (!userSelectedTab) showTab('result'); void load(); },
      onScopeChange: (next) => {
        if (applyingScope || disposed) return;
        prefs = { ...prefs, grantId: next.grantId, resultId: next.resultId };
        deps.onPrefs({ grantId: next.grantId, resultId: next.resultId });
        syncTopSelects();
      },
      onOpenEvidence: (reference) => openReference('Exact recorded check evidence', { action: 'job_get', job_id: reference.job_id }, reference.evidence_id),
      onOpenCandidate: (reference) => openReference('Exact recorded candidate version', { action: 'candidate_version_get', ...reference }),
    });
    changesPanel.append(openReview);
    mountedFor = projectIdValue;
  }

  function disposePanels() {
    authorityMount?.dispose();
    executionMount?.dispose();
    workflowMount?.dispose();
    resultMount?.dispose();
    authorityMount = executionMount = workflowMount = resultMount = null;
    mountedFor = null;
  }

  function openReference(title: string, request: Data, evidenceId?: string) {
    if (!projectId) return;
    const dialog = el('dialog', 'hermes-tools-dialog');
    dialog.setAttribute('aria-label', title);
    const content = el('pre', 'workbench-result-text');
    content.textContent = 'Loading exact recorded identity…';
    dialog.append(el('h3', '', title), button('Close', 'Close recorded reference', () => dialog.close()), content);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    void (async () => {
      try {
        const data = await owner('/api/workbench/execution', { ...request, workspace_id: deps.workspaceId, project_id: projectId });
        if (evidenceId) {
          const evidence = (data.evidence ?? []).find((entry: Data) => entry.id === evidenceId);
          if (!evidence) throw Error('unavailable');
          content.textContent = JSON.stringify({ job: data.job, evidence }, null, 2);
          return;
        }
        const candidate = data.candidate;
        if (candidate?.id !== request.candidate_id || candidate?.hash !== request.candidate_hash || candidate?.generation !== request.generation) throw Error('stale_resource');
        content.textContent = JSON.stringify(candidate, null, 2);
      } catch (reason) {
        content.textContent = `Recorded reference unavailable: ${reason instanceof Error ? reason.message : 'unavailable'}. No newer version was substituted.`;
      }
    })();
  }

  // Focused durable detail for a timeline reference. Only called on an explicit
  // "Open details" click, never for each event.
  function openLiveReference(item: LiveItem) {
    const recordedReference = item.reference;
    const reference = recordedReference?.kind === 'toolcall' && recordedReference.candidate_id && typeof recordedReference.generation === 'number' && typeof recordedReference.hash === 'string'
      ? { ...recordedReference, kind: 'candidate' as const, id: recordedReference.candidate_id }
      : recordedReference;
    if (!reference) return;
    const dialog = el('dialog', 'hermes-tools-dialog pane-workbench-detail');
    dialog.setAttribute('aria-label', `Focused detail · ${item.summary}`);
    const content = el('div', 'pane-workbench-detail-body');
    content.setAttribute('role', 'region');
    content.textContent = 'Reading the exact recorded detail…';
    const actions = el('div', 'pane-workbench-detail-actions');
    const source = liveClient, requestController = new AbortController();
    let diffViewer: { element: HTMLElement; dispose(): void } | null = null;
    let tailActive = false, tailTimer: ReturnType<typeof setTimeout> | undefined;
    const stopTail = () => { tailActive = false; if (tailTimer !== undefined) clearTimeout(tailTimer); };
    const updateTail = async () => {
      if (!source || source !== liveClient || !dialog.open || !tailActive) { stopTail(); return; }
      try {
        const tail = await source.tail(reference.id, requestController.signal);
        if (!dialog.open || !tailActive) return;
        content.replaceChildren(el('p', 'pane-workbench-tail-banner', `LIVE OUTPUT · UNVERIFIED · bounded ${unknown(tail.cap_bytes)}-byte tail · ${tail.truncated === true ? 'truncated' : 'not truncated'}. No progress or pass count is inferred from output.`));
        if (tail.available) {
          const pre = el('pre', 'workbench-result-text'); pre.textContent = String(tail.text ?? ''); content.append(pre);
        } else content.append(el('p', '', `Output unavailable: ${unknown(tail.reason)}.`));
        if (['completed', 'failed', 'cancelled', 'inconclusive', 'outcome_unknown'].includes(tail.status)) {
          stopTail(); content.append(el('p', '', 'Output observation ended. Inspect the separate recorder event for the final structured result.'));
          if (tailButton) tailButton.textContent = 'Read retained output (unverified)';
        } else tailTimer = setTimeout(() => void updateTail(), 1000);
      } catch (reason) {
        stopTail(); if (dialog.open) content.replaceChildren(el('p', '', `Output disconnected: ${reason instanceof Error ? reason.message : 'unavailable'}. No execution is retried.`));
        if (tailButton) tailButton.textContent = 'Retry output read (unverified)';
      }
    };
    const tailButton = reference.kind === 'job'
      ? button('Show live output (unverified)', 'Read a bounded unverified tail of the retained job log', () => {
        if (tailActive) { stopTail(); tailButton!.textContent = 'Resume live output (unverified)'; }
        else { tailActive = true; tailButton!.textContent = 'Pause live output'; void updateTail(); }
      }, 'small-button')
      : null;
    actions.append(...(tailButton ? [tailButton] : []), button('Close', 'Close focused detail', () => dialog.close(), 'small-button'));
    dialog.append(el('h3', '', `Focused detail · ${item.summary}`), actions, content);
    detailDialogs.add(dialog);
    dialog.addEventListener('close', () => { stopTail(); requestController.abort(); diffViewer?.dispose(); detailDialogs.delete(dialog); dialog.remove(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    void (async () => {
      if (!source) { content.replaceChildren(el('p', '', 'Private activity scope is not connected. No content is substituted.')); return; }
      try {
        const detail = await source.detail(reference, requestController.signal);
        if (dialog.open && !tailActive) {
          if (detail.mode === 'candidate_generation_diff') {
            const data = candidateDiffFromDetail(detail, reference.kind === 'candidate' && typeof reference.generation === 'number' && typeof reference.hash === 'string'
              ? { candidate_id: reference.id, generation: reference.generation, candidate_hash: reference.hash } : undefined);
            const { createCandidateDiffViewer } = await import('./candidate-diff-viewer');
            if (!dialog.open) return;
            diffViewer = createCandidateDiffViewer(data, { title: 'Exact historical candidate transition', selectedPath: item.target });
            content.replaceChildren(diffViewer.element);
          } else content.replaceChildren(renderDetail(detail));
        }
      } catch (reason) {
        if (dialog.open && !tailActive) content.replaceChildren(el('p', '', `Focused detail unavailable: ${reason instanceof Error ? reason.message : 'unavailable'}. No current content is substituted for the historical reference.`));
      }
    })();
  }

  function renderDetail(detail: Data): HTMLElement {
    const wrap = el('div', 'pane-workbench-detail-meta');
    wrap.append(el('p', 'pane-workbench-detail-note', `Private ${unknown(detail.mode)} · ${detail.mode === 'evidence_record' ? 'RECORDER · structured result for the recorded identity; inspect verdict and completeness' : detail.mode === 'artifact_receipt' && detail.verified === true ? 'RECORDER · independently verified artifact' : 'OBSERVED · metadata only, not verification'}`));
    const pre = el('pre', 'workbench-result-text');
    pre.textContent = JSON.stringify(detail, null, 2);
    wrap.append(pre);
    return wrap;
  }

  // ---- explicit excerpt handoff -------------------------------------------
  const selected = new Set<string>();

  function renderHandoff() {
    selected.clear();
    handoffList.replaceChildren();
    const messages = deps.messages();
    if (!messages.length) handoffList.append(el('p', '', 'This pane has no conversation messages yet. Compose a task or question to hand off.'));
    for (const message of messages.slice(-100)) {
      const row = el('label', 'pane-workbench-excerpt');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.messageId = message.id;
      checkbox.setAttribute('aria-label', `Include ${message.role} excerpt`);
      const text = el('span', 'pane-workbench-excerpt-text', short(message.text.replace(/\s+/g, ' ')));
      const size = el('small', '', `${message.role} · ${bytesOf(message.text)} bytes`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(message.id);
        else selected.delete(message.id);
        invalidateExcerptPreview();
        updateExcerptCount();
      });
      row.append(checkbox, text, size);
      handoffList.append(row);
    }
    handoffList.append(composer);
    updateExcerptCount();
  }

  function chosen() {
    const list: { id: string; role: 'user' | 'assistant'; text: string }[] = [];
    const byId = new Map(deps.messages().map((message) => [message.id, message]));
    for (const id of selected) {
      const message = byId.get(id);
      if (message) list.push(message);
    }
    const statement = composer.value.trim();
    if (statement) list.push({ id: 'composer', role: 'user', text: statement });
    return list;
  }

  function boundedExcerpts() {
    const list: { id: string; role: 'user' | 'assistant'; text: string }[] = [];
    let total = 0;
    for (const item of chosen()) {
      if (list.length >= EXCERPT_MAX_COUNT) break;
      if (bytesOf(item.text) > EXCERPT_MAX_BYTES) throw Error(`one excerpt exceeds ${EXCERPT_MAX_BYTES} bytes`);
      if (total + bytesOf(item.text) > EXCERPT_TOTAL_BYTES) throw Error(`selected excerpts exceed ${EXCERPT_TOTAL_BYTES} bytes total`);
      total += bytesOf(item.text);
      list.push({ ...item });
    }
    return list;
  }

  function updateExcerptCount() {
    try {
      const list = boundedExcerpts();
      excerptCount.textContent = `${list.length}/${EXCERPT_MAX_COUNT} excerpts · ${list.reduce((sum, item) => sum + bytesOf(item.text), 0)}/${EXCERPT_TOTAL_BYTES} bytes total`;
    } catch (reason) {
      excerptCount.textContent = reason instanceof Error ? reason.message : 'selection too large';
    }
  }

  function updateActionGating() {
    // Capture requires an explicitly selected bound attempt AND the exact
    // previewed packet (which itself freezes that attempt id). Task creation only
    // needs the previewed task payload.
    capture.disabled = !excerptPreview || !prefs.attemptId;
    capture.title = !prefs.attemptId
      ? 'Create and select a bound attempt in Task authority before capturing the context packet.'
      : 'Freeze exactly the previewed selected excerpts into a packet selectable in Task Authority';
    createTask.disabled = !taskPreviewCache || taskCreatePending;
  }
  function invalidateExcerptPreview() { excerptPreview = null; updateActionGating(); }
  function invalidateTaskPreview() { taskPreviewCache = null; updateActionGating(); }
  const excerptKey = (request: Data, question: string) => JSON.stringify({ request, question });

  // Exact wire requests. The strict conversation source allows only
  // {role,text,sha256} per excerpt (no client id); the bound attempt id travels as
  // the top-level capture/packet field so the server can require
  // context.attempt_id === attempt.id. A bound attempt is mandatory.
  async function buildCaptureRequest(requireAttempt: boolean): Promise<{ request: Data; question: string; attemptId: string | null }> {
    const list = boundedExcerpts();
    if (!list.length) throw Error('Select at least one excerpt or compose a task.');
    const question = composer.value.trim();
    if (!question) throw Error('Enter the task or question statement.');
    const attemptId = prefs.attemptId;
    if (requireAttempt && !attemptId) throw Error('Create and select a bound attempt in Task Authority before capturing the context packet.');
    const excerpts: { role: 'user' | 'assistant'; text: string; sha256: string }[] = [];
    for (const item of list) excerpts.push({ role: item.role, text: item.text, sha256: await sha256Hex(item.text) });
    const binding = deps.binding();
    // Preview is allowed before an attempt exists, but the capture request only
    // carries attempt_id once a bound attempt is explicitly selected; the server
    // then requires context.attempt_id === attempt.id.
    const request: Data = {
      action: 'capture',
      workspace_id: deps.workspaceId,
      project_id: projectId,
      ...(attemptId ? { attempt_id: attemptId } : {}),
      source: {
        kind: 'conversation',
        pane_id: deps.paneId,
        profile_id: binding.profileId,
        session_id: binding.sessionId,
        expected_binding_revision: binding.bindingRevision,
        excerpts,
      },
    };
    return { request, question, attemptId: attemptId ?? null };
  }

  async function renderPreview() {
    error.textContent = '';
    invalidateExcerptPreview();
    try {
      const built = await buildCaptureRequest(false);
      excerptPreview = { request: built.request, question: built.question, key: excerptKey(built.request, built.question) };
      const packet = { action: 'packet', workspace_id: deps.workspaceId, project_id: projectId, context_ids: ['<captured context id>'], question: built.question, ...(built.attemptId ? { attempt_id: built.attemptId } : { attempt_id: '<create and select a bound attempt before capture>' }) };
      preview.textContent = `${JSON.stringify(built.request, null, 2)}\n\n// packet request (context id filled from the just-captured snapshot)\n${JSON.stringify(packet, null, 2)}`;
      previewBytes.textContent = `${bytesOf(JSON.stringify(built.request))} bytes · ${built.attemptId ? `bound attempt ${built.attemptId}` : 'no bound attempt selected: capture stays disabled until you create and select one'} · hashes computed client-side; the reviewed bytes are frozen until an input, attempt, project or binding changes.`;
    } catch (reason) {
      preview.textContent = 'Preview unavailable.';
      previewBytes.textContent = '';
      error.textContent = reason instanceof Error ? reason.message : 'unavailable';
    }
    updateActionGating();
  }

  async function captureExcerpts() {
    error.textContent = '';
    if (!prefs.attemptId) { error.textContent = 'Create and select a bound attempt in Task Authority before capturing the context packet.'; renderHandoff(); return; }
    if (!excerptPreview) { error.textContent = 'Preview the selected context packet first.'; return; }
    status.textContent = 'Capturing the exact previewed selected excerpts…';
    try {
      const current = await buildCaptureRequest(true);
      if (excerptKey(current.request, current.question) !== excerptPreview.key) { invalidateExcerptPreview(); throw Error('Selection, attempt or binding changed; preview again before capturing.'); }
      const request = excerptPreview.request;
      const attemptId = String(request.attempt_id);
      // 1) Exact conversation snapshot (strict {role,text,sha256}; bound to the
      //    selected attempt; never the whole conversation, no model request).
      const captured = ((await owner('/api/workbench/context', request)).context ?? {}) as Data;
      const capturedId = typeof captured.id === 'string' ? captured.id : '';
      if (!capturedId) throw Error('unavailable');
      // 2) Freeze it into a packet bound to the same attempt, selectable in Task
      //    Authority. The server validates context.attempt_id === attempt.id.
      const packetReply = await owner('/api/workbench/context', { action: 'packet', workspace_id: deps.workspaceId, project_id: projectId, context_ids: [capturedId], question: excerptPreview.question, attempt_id: attemptId });
      const packet = (packetReply.context ?? {}) as Data;
      pendingPacketId = typeof packet.id === 'string' ? packet.id : null;
      pushScope();
      await authorityMount?.refresh?.();
      status.textContent = `Captured context packet ${pendingPacketId ?? '(recorded)'} bound to attempt ${attemptId} from ${((request.source as Data).excerpts as unknown[]).length} selected excerpt(s). Nothing was sent to a model.`;
      // Require a fresh preview before another capture (never silently duplicate).
      invalidateExcerptPreview();
      renderHandoff();
    } catch (reason) {
      status.textContent = 'Context packet capture unavailable.';
      fail(reason);
    }
  }

  // ---- actual task creation (explicit preview first) ----------------------
  function taskPayload(): Data {
    if (!projectId) throw Error('Choose a project first.');
    const binding = deps.binding();
    const title = taskTitle.value.trim() || ((chosen()[0]?.text ?? 'Conversation handoff').replace(/\s+/g, ' ').slice(0, 120));
    const acceptance_statement = taskAcceptance.value.trim();
    const check_definition_id = definitionSelect.value;
    if (!title) throw Error('Enter a task title.');
    if (!acceptance_statement) throw Error('Enter an acceptance statement.');
    if (!check_definition_id) throw Error('Select an allowlisted check definition.');
    return {
      action: 'task_create',
      workspace_id: deps.workspaceId,
      project_id: projectId,
      pane_id: deps.paneId,
      title,
      acceptance_statement,
      check_definition_id,
      profile_id: binding.profileId,
      session_id: binding.sessionId,
    };
  }

  function renderTaskPreview() {
    error.textContent = '';
    invalidateTaskPreview();
    try {
      const payload = taskPayload();
      taskPreviewCache = { payload, key: JSON.stringify(payload) };
      taskPreview.textContent = JSON.stringify(payload, null, 2);
    } catch (reason) {
      taskPreview.textContent = reason instanceof Error ? reason.message : 'unavailable';
    }
    updateActionGating();
  }

  async function createTaskNow() {
    error.textContent = '';
    if (!taskPreviewCache) { error.textContent = 'Preview the task (title, acceptance, check definition) first.'; return; }
    if (taskCreatePending) { error.textContent = 'A previous task creation outcome is unknown. Refresh and select the existing task; do not resend.'; return; }
    const payload = taskPayload();
    if (JSON.stringify(payload) !== taskPreviewCache.key) { invalidateTaskPreview(); error.textContent = 'Task fields changed; preview again before creating.'; return; }
    status.textContent = 'Creating the previewed task…';
    try {
      const result = await owner('/api/workbench/execution', taskPreviewCache.payload);
      const task = (result.task ?? {}) as Data;
      if (typeof task.id === 'string' && task.id) {
        prefs = { ...prefs, taskId: task.id };
        deps.onPrefs({ taskId: task.id });
        syncTopSelects();
        pushScope();
      }
      invalidateTaskPreview();
      status.textContent = `Created task ${task.id ?? '(recorded)'} with the previewed acceptance and check definition. Select it and capture its context packet.`;
      await load();
      syncTopSelects();
    } catch (reason) {
      const code = (reason as { code?: string } | undefined)?.code;
      if (!code) {
        // Ambiguous network outcome; task_create has no operation id. Never
        // auto-retry — require an explicit refresh and selection of the task.
        taskCreatePending = true;
        invalidateTaskPreview();
        error.textContent = 'Ambiguous task creation outcome — manual reconciliation required.';
        status.textContent = 'Task creation outcome unknown. Refresh and select the existing task explicitly; do not resend.';
      } else {
        status.textContent = 'Task creation refused.';
        fail(reason);
      }
    }
    updateActionGating();
  }

  projectSelect.addEventListener('change', () => {
    const next = projectSelect.value || null;
    deps.onPrefs({ projectId: next, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null });
    prefs = { ...prefs, projectId: next, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null };
    latestSnapshot = null;
    pendingPacketId = null;
    invalidateExcerptPreview();
    invalidateTaskPreview();
    // The Workbench instance is bound to the selected project/attempt, so a
    // deliberate scope change clears only this instance's history.
    deps.timeline.reset();
    stopLive();
    disposePanels();
    void load();
  });
  taskSelect.addEventListener('change', () => {
    const selection = { taskId: taskSelect.value || null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null };
    prefs = { ...prefs, ...selection };
    deps.onPrefs(selection);
    latestSnapshot = null; pendingPacketId = null;
    invalidateExcerptPreview(); invalidateTaskPreview(); clearChanges();
    syncTopSelects(); deps.timeline.reset();
    pushScope();
    renderHeader();
    startLive();
  });
  candidateSelect.addEventListener('change', () => {
    detailPath.value = ''; fileReadControls.hidden = true;
    prefs = { ...prefs, candidateId: candidateSelect.value || null };
    deps.onPrefs({ candidateId: prefs.candidateId });
    pushScope();
    renderHeader();
    void refreshChanges();
  });
  attemptSelect.addEventListener('change', () => {
    prefs = { ...prefs, attemptId: attemptSelect.value || null };
    deps.onPrefs({ attemptId: prefs.attemptId });
    // The immutable capture preview is bound to one attempt: any attempt change
    // invalidates it so a packet can never be captured against another attempt.
    invalidateExcerptPreview();
    pushScope();
    renderHeader();
    deps.timeline.reset(); // Bound to the attempt; clear only this instance.
    startLive(); // Deliberate scope change, not a per-event reload.
  });
  resultSelect.addEventListener('change', () => {
    prefs = { ...prefs, resultId: resultSelect.value || null };
    deps.onPrefs({ resultId: prefs.resultId });
    pushScope();
  });

  // Authenticated acknowledgement re-reads state even while Normal is selected,
  // so a remembered Workbench scope reconnects its read-only lane/badge without
  // mounting execution controls.
  const onConnected = () => { if (!disposed) void load(); };
  window.addEventListener('orbit-host-connected', onConnected);

  composer.addEventListener('input', () => { invalidateExcerptPreview(); updateExcerptCount(); });
  taskTitle.addEventListener('input', invalidateTaskPreview);
  taskAcceptance.addEventListener('input', invalidateTaskPreview);
  definitionSelect.addEventListener('change', invalidateTaskPreview);

  renderHandoff();
  updateActionGating();
  renderHeader();

  const headerClock = setInterval(() => { if (!disposed && visible && deps.body.isConnected) renderHeader(); }, 1000);
  return {
    refresh: () => load(),
    setVisible(next: boolean) {
      visible = next;
      // Hidden mode stays live: never unsubscribe on a view toggle, and the
      // read-only monitor keeps running without mounting execution controls.
      if (!disposed) void load();
    },
    invalidateBinding() {
      epoch++;
      // A superseded load cannot clear the new epoch's busy latch in its
      // finally block. Release its ownership before starting the replacement.
      busy = false;
      disposePanels();
      stopLive();
      latestSnapshot = null;
      pendingPacketId = null;
      invalidateExcerptPreview();
      invalidateTaskPreview();
      deps.timeline.reset();
      renderHandoff();
      void load();
    },
    liveSlot: () => liveSlotEl,
    openLiveReference,
    // Read-only entry from Normal mode: open and focus the handoff preview. It
    // copies the supplied statement in memory and may pre-check selected messages,
    // but never captures or creates anything; the owner must preview and confirm.
    openHandoff(options?: { statement?: string; messageIds?: readonly string[] }) {
      if (disposed) return;
      setup.open = true;
      handoff.open = true;
      if (typeof options?.statement === 'string') {
        composer.value = options.statement.slice(0, 8000);
        invalidateExcerptPreview();
      }
      if (Array.isArray(options?.messageIds) && options.messageIds.length) {
        renderHandoff();
        const wanted = new Set(options.messageIds);
        for (const node of Array.from(handoffList.querySelectorAll<HTMLInputElement>('input[type=checkbox][data-message-id]'))) {
          if (wanted.has(node.dataset.messageId ?? '')) {
            node.checked = true;
            selected.add(node.dataset.messageId ?? '');
          }
        }
      }
      updateExcerptCount();
      handoff.scrollIntoView({ block: 'nearest' });
      composer.focus();
    },
    dispose() {
      disposed = true;
      clearInterval(headerClock);
      for (const dialog of detailDialogs) dialog.close();
      epoch++;
      window.removeEventListener('orbit-host-connected', onConnected);
      stopLive();
      disposePanels();
      deps.body.replaceChildren();
    },
  };
}
