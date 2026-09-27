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
  onLaneBusy: (busy: boolean) => void;
  timeline: LiveTimeline;
  onError?: (message: string) => void;
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

function formatRelative(at: unknown): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'unknown';
  const epoch = at > 1e12 ? at : at * 1000;
  const delta = epoch - Date.now();
  const seconds = Math.round(Math.abs(delta) / 1000);
  const label = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;
  return delta >= 0 ? `in ${label}` : `${label} ago`;
}

export function mountPaneWorkbench(deps: PaneWorkbenchDeps): {
  refresh(): Promise<void>;
  setVisible(visible: boolean): void;
  invalidateBinding(): void;
  liveSlot(): HTMLElement;
  openLiveReference(item: LiveItem): void;
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
  let headerGrant: Data | null = null;
  let laneNote = '';
  type Panel = { refresh?(): void | Promise<void>; dispose(): void; setScope?(scope: Data): void };
  let authorityMount: Panel | null = null;
  let executionMount: Panel | null = null;
  let workflowMount: Panel | null = null;
  let resultMount: Panel | null = null;
  let mountedFor: string | null = null;
  let liveClient: ReturnType<typeof watchWorkbenchLive> | null = null;
  let liveAttempt: string | null = null;

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

  const newTask = button('New task', 'Open the task/candidate creation controls in the Checks tab', () => {
    showTab('checks');
    executionPanel.querySelector<HTMLInputElement>('input[aria-label="Task title"]')?.focus();
  }, 'small-button');
  const openFull = button('Full Project Workbench', 'Open the complete Project Workbench for registration, files and Doctor', () => {
    void import('./project-workbench').then((m) => m.showProjectWorkbench(deps.getToken)).catch(fail);
  }, 'small-button');
  head.append(
    labelled('Project', projectSelect),
    labelled('Task', taskSelect),
    labelled('Candidate', candidateSelect),
    labelled('Attempt', attemptSelect),
    labelled('Result', resultSelect),
    newTask,
    openFull,
  );

  // Actual selected-scope header. Values come from the selected records and the
  // durable snapshot; anything absent reads "unknown" rather than newest.
  const header = el('div', 'pane-workbench-scope');
  const scopeLine = el('p', 'pane-workbench-scope-line');
  const candidateLine = el('p', 'pane-workbench-candidate-line');
  const grantLine = el('p', 'pane-workbench-grant-line');
  header.append(scopeLine, candidateLine, grantLine);

  const authority = el('details', 'pane-workbench-authority');
  authority.append(el('summary', '', 'Task authority, consent and readiness'));
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
  panels.live.append(liveNote, liveSlotEl);
  const executionPanel = panels.checks;
  const changesPanel = panels.changes;
  const resultPanel = panels.result;
  const tabButtons = new Map<string, HTMLButtonElement>();
  function showTab(name: string) {
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== name;
      const tab = tabButtons.get(key);
      if (tab) {
        tab.setAttribute('aria-selected', String(key === name));
        tab.classList.toggle('active', key === name);
      }
    }
  }
  for (const [key, label] of [['live', 'Live'], ['changes', 'Changes'], ['checks', 'Checks'], ['result', 'Result']] as const) {
    const tab = button(label, `${label} workbench view`, () => showTab(key), 'pane-workbench-tab');
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
  const boundNote = el('p', 'pane-workbench-excerpt-bound', 'Selected excerpts are captured to the project context; bind them to the task/attempt in Task authority. The whole conversation is never inherited.');
  const capture = button('Capture conversation excerpts', 'Create one immutable context snapshot from the checked excerpts only', () => void captureExcerpts(), 'small-button');
  const refreshHandoff = button('Refresh excerpts', 'Rebuild the excerpt checklist from the current conversation', () => renderHandoff(), 'small-button');
  const previewButton = button('Preview exact bytes', 'Preview the bounded payload without capturing anything', () => void renderPreview(), 'small-button');
  handoff.append(handoffList, composer, excerptCount, previewButton, preview, capture, refreshHandoff, boundNote, previewBytes);
  const contextUi = button('Open file / diff / job context…', 'Use the existing context review to add a file, diff or job snapshot', () => {
    if (!projectId) { fail(new Error('Choose a project first.')); return; }
    void import('./workbench-context')
      .then((m) => m.showWorkbenchContext({ token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectId as string, source: { kind: 'diff', expected_hash: '' } }))
      .catch(fail);
  }, 'small-button');
  handoff.append(contextUi);
  const advanced = el('details', 'pane-workbench-advanced');
  advanced.append(el('summary', '', 'Handoff is data, never approval: capturing context does not start a worker.'));
  advanced.append(el('p', '', 'Approval and execution happen only in the authority and Checks controls below, against the exact previewed snapshot.'));

  root.append(head, header, status, error, staleNote, authority, tabBar, panels.live, panels.changes, panels.checks, panels.result, handoff, advanced);
  deps.body.replaceChildren(root);
  showTab('live');

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
    if (!response.ok || data.ok !== true) throw Error(typeof data.code === 'string' ? data.code : 'unavailable');
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
  }

  function syncTopSelects() {
    for (const [select, value] of [[taskSelect, prefs.taskId], [candidateSelect, prefs.candidateId], [attemptSelect, prefs.attemptId], [resultSelect, prefs.resultId]] as const) {
      if (value && Array.from(select.options).some((option) => option.value === value)) select.value = value;
    }
  }

  function pushScope() {
    applyingScope = true;
    authorityMount?.setScope?.({ taskId: prefs.taskId, candidateId: prefs.candidateId, attemptId: prefs.attemptId });
    resultMount?.setScope?.({ grantId: prefs.grantId, resultId: prefs.resultId });
    applyingScope = false;
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

  function renderHeader() {
    const project = projectName || projectId || 'unknown';
    scopeLine.textContent = `Scope · Project ${project} · Task ${unknown(prefs.taskId)} · Attempt ${unknown(prefs.attemptId)} · ${prefs.attemptId ? 'attempt-scoped live' : 'project-scoped live'}`;
    const candidate = selectedCandidate();
    candidateLine.textContent = candidate
      ? `Candidate ${candidate.id} · generation ${unknown(candidate.generation)} · sha256 ${unknown(candidate.hash)} · status ${unknown(candidate.status)}`
      : 'Candidate unknown (no explicit candidate selected)';
    const grantId = prefs.grantId || (grantCache.find((grant) => grant.attempt_id === prefs.attemptId)?.id ?? null);
    const snapshotGrant = latestSnapshot?.latest_grant && latestSnapshot.latest_grant.id === grantId ? latestSnapshot.latest_grant : null;
    const grant = headerGrant && headerGrant.id === grantId ? headerGrant : null;
    const budget = grant?.budget ?? {};
    const calls = grant ? `${unknown(grant.calls_used, 'unknown')}/${unknown(budget.calls, 'unknown')}` : 'unknown';
    const checks = grant ? `${unknown(grant.checks_used, 'unknown')}/${unknown(budget.checks, 'unknown')}` : 'unknown';
    const repairs = grant ? `${unknown(grant.repairs_used, 'unknown')}/${unknown(budget.repair_iterations, 'unknown')}` : 'unknown';
    const started = grant?.started_at ?? grant?.created_at;
    const elapsed = grant?.started_at ? formatRelative(started) : 'unknown';
    const expiry = grant?.expires_at ? formatRelative(grant.expires_at) : 'unknown';
    const state = snapshotGrant?.status ?? grant?.status ?? 'unknown';
    grantLine.textContent = `Grant ${unknown(grantId)} · status ${state} · calls ${calls} · checks ${checks} · repairs ${repairs} · elapsed ${elapsed} · expires ${expiry}`
      + (laneNote ? ` · lane ${laneNote}` : '');
  }
  let projectName: string | null = null;

  function emitBadge() {
    const snapshot = latestSnapshot;
    const pending = snapshot
      ? (Number(snapshot.active_grants) || 0) + (Number(snapshot.active_jobs) || 0)
      : grantCache.filter((grant) => ['approved', 'running', 'prepared', 'dispatching', 'submission_unknown', 'result_pending', 'dispatch_unknown'].includes(String(grant.status))).length;
    const results = snapshot ? Number(snapshot.results) || 0 : cardCache.length;
    const laneBusy = laneState.agent_busy || laneState.job_busy;
    const badge: PaneWorkbenchBadge = {
      mode: 'workbench',
      pending,
      results,
      laneBusy,
      status: `${pending} pending · ${results} result(s)` + (laneState.unknown ? ' · lane unknown' : ''),
    };
    deps.onBadge(badge);
    deps.onLaneBusy(laneBusy);
  }
  let cardCache: Data[] = [];
  let laneState: { agent_busy: boolean; job_busy: boolean; unknown: boolean } = { agent_busy: false, job_busy: false, unknown: true };

  function reflectLane(lane: { agent_busy: boolean; job_busy: boolean; unknown: boolean }) {
    laneState = { agent_busy: lane.agent_busy === true, job_busy: lane.job_busy === true, unknown: lane.unknown === true };
    laneNote = laneState.unknown ? 'unknown' : laneState.agent_busy || laneState.job_busy ? 'busy' : 'idle';
    emitBadge();
    renderHeader();
  }

  // ---- live client --------------------------------------------------------
  function stopLive() {
    liveClient?.dispose();
    liveClient = null;
    liveAttempt = null;
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
        latestSnapshot = page.snapshot ?? null;
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
    });
  }

  async function loadGrantHeader() {
    headerGrant = null;
    const grant = grantCache.find((entry) => entry.id === prefs.grantId) ?? grantCache.find((entry) => entry.attempt_id === prefs.attemptId) ?? null;
    if (!grant || !projectId || !deps.getToken()) { renderHeader(); return; }
    try {
      const data = await owner('/api/workbench/native', { action: 'status', workspace_id: deps.workspaceId, project_id: projectId, grant_id: grant.id });
      headerGrant = (data.grant as Data) ?? null;
    } catch {
      headerGrant = null; // Absent or denied reads stay explicitly unknown.
    }
    renderHeader();
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
      candidateCache = candidates;
      options(taskSelect, projectId ? 'Choose task…' : 'Choose project first', (projectId ? tasks : []).map((task) => ({ id: String(task.id), label: `${task.title ?? task.id} · ${task.status ?? ''}` })), prefs.taskId);
      options(candidateSelect, projectId ? 'Choose candidate…' : 'Choose project first', (projectId ? candidates : []).map((candidate) => ({ id: String(candidate.id), label: `${candidate.id} · gen ${candidate.generation ?? '?'} · ${candidate.status ?? ''}` })), prefs.candidateId);
      options(attemptSelect, projectId ? 'Choose attempt…' : 'Choose project first', (projectId ? attempts : []).map((attempt) => ({ id: String(attempt.id), label: `${attempt.id} · ${attempt.task_id ?? ''}` })), prefs.attemptId);
      options(resultSelect, projectId ? 'Choose result…' : 'Choose project first', (projectId ? cardCache : []).map((card) => ({ id: String(card.result_id), label: `${card.result_id} · ${card.availability ?? ''}` })), prefs.resultId);
      renderHeader();
      emitBadge();
      if (projectId && projectId !== mountedFor) await mountPanels(projectId, ticket);
      if (disposed || ticket !== epoch) return;
      pushScope();
      void loadGrantHeader();
      if (liveAttempt !== (prefs.attemptId ?? null)) startLive();
      status.textContent = projectId
        ? `Workbench: ${projects.length} project(s) · ${grantCache.length} attempt(s) · ${cardCache.length} result(s). Read-only until you approve.`
        : `Workbench: ${projects.length} project(s). Choose one explicitly (no automatic selection).`;
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
      scope: { taskId: prefs.taskId, candidateId: prefs.candidateId, attemptId: prefs.attemptId },
      onScopeChange: (next) => {
        if (applyingScope || disposed) return;
        const attemptChanged = (next.attemptId ?? null) !== (prefs.attemptId ?? null);
        prefs = { ...prefs, candidateId: next.candidateId, attemptId: next.attemptId };
        deps.onPrefs({ candidateId: next.candidateId, attemptId: next.attemptId });
        syncTopSelects();
        renderHeader();
        if (attemptChanged) { void loadGrantHeader(); startLive(); }
      },
    });
    executionMount = mountWorkbenchExecution({ container: executionPanel, token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectIdValue, onError: (message) => { error.textContent = message; } });
    workflowMount = mountWorkbenchWorkflow({ container: changesPanel, token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectIdValue, onError: (message) => { error.textContent = message; } });
    resultMount = mountWorkbenchTaskResult({
      container: resultPanel,
      token: deps.getToken,
      workspace_id: deps.workspaceId,
      project_id: projectIdValue,
      scope: { grantId: prefs.grantId, resultId: prefs.resultId },
      onChanged: () => { void load(); },
      onScopeChange: (next) => {
        if (applyingScope || disposed) return;
        prefs = { ...prefs, grantId: next.grantId, resultId: next.resultId };
        deps.onPrefs({ grantId: next.grantId, resultId: next.resultId });
        syncTopSelects();
        void loadGrantHeader();
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
    const reference = item.reference;
    if (!reference) return;
    const dialog = el('dialog', 'hermes-tools-dialog pane-workbench-detail');
    dialog.setAttribute('aria-label', `Focused detail · ${item.summary}`);
    const content = el('pre', 'workbench-result-text');
    content.textContent = 'Reading the exact recorded detail…';
    const actions = el('div', 'pane-workbench-detail-actions');
    const tailButton = reference.kind === 'job'
      ? button('Tail retained log (unverified)', 'Read a bounded unverified tail of the retained job log', () => void readTail(reference.id, content), 'small-button')
      : null;
    actions.append(...(tailButton ? [tailButton] : []), button('Close', 'Close focused detail', () => dialog.close(), 'small-button'));
    dialog.append(el('h3', '', `Focused detail · ${item.summary}`), actions, content);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    void (async () => {
      if (!liveClient) { content.textContent = 'Private activity scope is not connected. No content is substituted.'; return; }
      try {
        const detail = await liveClient.detail(reference as never);
        content.textContent = renderDetail(detail);
      } catch (reason) {
        content.textContent = `Focused detail unavailable: ${reason instanceof Error ? reason.message : 'unavailable'}. No current content is substituted for the historical reference.`;
      }
    })();
  }

  function renderDetail(detail: Data): string {
    const lines: string[] = [];
    lines.push(`mode: ${unknown(detail.mode)}`);
    lines.push(`verified: ${detail.verified === true ? 'true' : 'false'}`);
    lines.push(`diff: ${detail.not_diff === true ? 'metadata only (not a diff)' : unknown(detail.not_diff)}`);
    if (detail.mode === 'candidate_snapshot') {
      lines.push(detail.available === true
        ? 'This is an exact recorded candidate snapshot/metadata for the referenced generation and hash, not a diff against the current candidate.'
        : `The exact historical candidate snapshot is not currently verifiable (${unknown(detail.reason ?? detail.note, 'unavailable')}). No newer or substituted content is presented as this version.`);
    }
    lines.push(JSON.stringify(detail, null, 2));
    return lines.join('\n');
  }

  async function readTail(jobId: string, content: HTMLElement) {
    if (!liveClient) return;
    try {
      const tail = await liveClient.tail(jobId);
      const banner = `Unverified bounded tail · cap ${unknown(tail.cap_bytes)} bytes · returned ${unknown(tail.tail_bytes ?? tail.bytes)} bytes · ${tail.truncated === true ? 'truncated' : 'not truncated'} · sha256 ${unknown(tail.sha256)} · never a progress, pass or failure signal.`;
      content.textContent = tail.available === false
        ? `${banner}\n${JSON.stringify(tail, null, 2)}`
        : `${banner}\n\n${String(tail.text ?? '')}`;
    } catch (reason) {
      content.textContent = `Tail unavailable: ${reason instanceof Error ? reason.message : 'unavailable'}. No pass or failure is inferred.`;
    }
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
      checkbox.setAttribute('aria-label', `Include ${message.role} excerpt`);
      const text = el('span', 'pane-workbench-excerpt-text', short(message.text.replace(/\s+/g, ' ')));
      const size = el('small', '', `${message.role} · ${bytesOf(message.text)} bytes`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(message.id);
        else selected.delete(message.id);
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

  async function buildPayload() {
    const list = boundedExcerpts();
    if (!list.length) throw Error('Select at least one excerpt or compose a task.');
    const excerpts: ConversationExcerpt[] = [];
    for (const item of list) excerpts.push({ id: item.id, role: item.role, text: item.text, sha256: await sha256Hex(item.text) });
    const binding = deps.binding();
    return {
      kind: 'conversation' as const,
      pane_id: deps.paneId,
      profile_id: binding.profileId,
      session_id: binding.sessionId,
      expected_binding_revision: binding.bindingRevision,
      excerpts,
    };
  }

  async function renderPreview() {
    error.textContent = '';
    try {
      const payload = await buildPayload();
      preview.textContent = JSON.stringify(payload, null, 2);
      previewBytes.textContent = `${bytesOf(JSON.stringify(payload))} bytes · hashes computed client-side; no capture performed.`;
    } catch (reason) {
      preview.textContent = 'Preview unavailable.';
      previewBytes.textContent = '';
      error.textContent = reason instanceof Error ? reason.message : 'unavailable';
    }
  }

  async function captureExcerpts() {
    error.textContent = '';
    status.textContent = 'Capturing the exact previewed conversation excerpts…';
    try {
      const payload = await buildPayload();
      // Exact lead-owned contract: source.kind='conversation' with the live
      // binding revalidated and each excerpt re-hashed server-side. This never
      // inherits the whole conversation and never starts a worker.
      const snapshot = await owner('/api/workbench/context', { action: 'capture', workspace_id: deps.workspaceId, project_id: projectId, source: payload });
      const context = (snapshot.context ?? {}) as Data;
      status.textContent = `Captured conversation snapshot ${context.id ?? '(recorded)'} · ${context.snapshot?.hash ?? ''}. Select it in Task authority and bind it to a task/attempt; nothing was sent to a model.`;
      // Surface the new packet in the mounted authority controls (read-only refresh).
      await authorityMount?.refresh?.();
      renderPreview();
    } catch (reason) {
      status.textContent = 'Conversation context capture unavailable.';
      fail(reason);
    }
  }

  projectSelect.addEventListener('change', () => {
    const next = projectSelect.value || null;
    deps.onPrefs({ projectId: next, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null });
    prefs = { ...prefs, projectId: next, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null };
    headerGrant = null;
    latestSnapshot = null;
    stopLive();
    disposePanels();
    void load();
  });
  taskSelect.addEventListener('change', () => {
    prefs = { ...prefs, taskId: taskSelect.value || null };
    deps.onPrefs({ taskId: prefs.taskId });
    pushScope();
    renderHeader();
  });
  candidateSelect.addEventListener('change', () => {
    prefs = { ...prefs, candidateId: candidateSelect.value || null };
    deps.onPrefs({ candidateId: prefs.candidateId });
    pushScope();
    renderHeader();
  });
  attemptSelect.addEventListener('change', () => {
    prefs = { ...prefs, attemptId: attemptSelect.value || null };
    deps.onPrefs({ attemptId: prefs.attemptId });
    pushScope();
    renderHeader();
    void loadGrantHeader();
    startLive(); // Deliberate scope change, not a per-event reload.
  });
  resultSelect.addEventListener('change', () => {
    prefs = { ...prefs, resultId: resultSelect.value || null };
    deps.onPrefs({ resultId: prefs.resultId });
    pushScope();
  });

  const onConnected = () => { if (!disposed && visible) void load(); };
  window.addEventListener('orbit-host-connected', onConnected);

  renderHandoff();

  return {
    refresh: () => load(),
    setVisible(next: boolean) {
      visible = next;
      // Hidden mode stays live: never unsubscribe on a view toggle.
      if (visible && !disposed) void load();
    },
    invalidateBinding() {
      epoch++;
      disposePanels();
      stopLive();
      latestSnapshot = null;
      headerGrant = null;
      renderHandoff();
      void load();
    },
    liveSlot: () => liveSlotEl,
    openLiveReference,
    dispose() {
      disposed = true;
      epoch++;
      window.removeEventListener('orbit-host-connected', onConnected);
      stopLive();
      disposePanels();
      deps.body.replaceChildren();
    },
  };
}
