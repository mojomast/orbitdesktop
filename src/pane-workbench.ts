// Per-pane Workbench integration.
//
// This module mounts the *existing* Workbench execution surfaces inside an agent
// pane. It deliberately does not re-implement authorization: task/candidate
// creation, attempt binding, native consent preview/approve/start/stop, checks,
// review/export and result delivery all stay inside their existing components,
// reached through the same owner-authenticated routes. This module contributes
// the pane-scoped navigation (explicit project/task/candidate/attempt selectors),
// the tab organization, the cross-mode badge signal, and the explicit
// conversation-excerpt handoff preview.
//
// Read-only first: mounting or refreshing never starts a run and never dispatches
// a submission. The only state-changing actions here are the owner's explicit
// buttons delegated to the reused components (or the explicit excerpt capture).

import { button, el } from './dom';
import type { PaneMode, PaneWorkbenchPrefs } from './pane-prefs';
import './pane-workbench.css';

type Data = Record<string, any>;

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
  /** Bounded read-only view of the pane conversation; excerpts are explicit only. */
  messages: () => readonly { id: string; role: 'user' | 'assistant'; text: string }[];
  prefs: PaneWorkbenchPrefs;
  onPrefs: (patch: Partial<PaneWorkbenchPrefs>) => void;
  onBadge: (badge: PaneWorkbenchBadge) => void;
  onLaneBusy: (busy: boolean) => void;
  onError?: (message: string) => void;
}

const EXCERPT_MAX_COUNT = 8;
const EXCERPT_MAX_BYTES = 16 * 1024;
const EXCERPT_TOTAL_BYTES = 64 * 1024;

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function truncated(text: string, length = 160): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function mountPaneWorkbench(deps: PaneWorkbenchDeps): {
  refresh(): Promise<void>;
  setVisible(visible: boolean): void;
  invalidateBinding(): void;
  dispose(): void;
} {
  let disposed = false;
  let visible = false;
  let prefs: PaneWorkbenchPrefs = { ...deps.prefs };
  let epoch = 0;
  let busy = false;
  let projectId: string | null = prefs.projectId;
  type Panel = { refresh?(): void | Promise<void>; dispose(): void };
  let authorityMount: Panel | null = null;
  let executionMount: Panel | null = null;
  let workflowMount: Panel | null = null;
  let resultMount: Panel | null = null;
  let mountedFor: string | null = null;

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
    const title = executionPanel.querySelector<HTMLInputElement>('input[aria-label="Task title"]');
    title?.focus();
  }, 'small-button');
  const openFull = button('Full Project Workbench', 'Open the complete Project Workbench for registration, files and Doctor', () => {
    void import('./project-workbench').then((m) => m.showProjectWorkbench(deps.getToken)).catch((reason) => fail(reason));
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

  // Cross-cutting authority: readiness, approved packet, consent preview/approve,
  // native start/stop and required-check acceptance. Mounted once per project.
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
  panels.live.append(el('p', 'pane-workbench-live-note', 'Shared live timeline mounts here through the reviewed timeline module. No events are synthesized when the live adapter or backend is unavailable.'));
  const executionPanel = panels.checks;
  const changesPanel = panels.changes;
  const resultPanel = panels.result;
  const tabButtons = new Map<string, HTMLButtonElement>();
  let activeTab = 'live';
  function showTab(name: string) {
    activeTab = name;
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== name;
      const button = tabButtons.get(key);
      if (button) {
        button.setAttribute('aria-selected', String(key === name));
        button.classList.toggle('active', key === name);
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
      .catch((reason) => fail(reason))
      .finally(() => { openReview.disabled = false; });
  }, 'small-button');
  changesPanel.append(openReview);

  // Explicit conversation-excerpt handoff. Only checked messages and the manual
  // composer enter the preview; the whole conversation is never inherited.
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
  const capture = button('Capture conversation excerpts', 'Create one immutable context snapshot from the checked excerpts only', () => void captureExcerpts(), 'small-button');
  const refreshHandoff = button('Refresh excerpts', 'Rebuild the excerpt checklist from the current conversation', () => renderHandoff(), 'small-button');
  const previewButton = button('Preview exact bytes', 'Preview the bounded payload without capturing anything', () => void renderPreview(), 'small-button');
  handoff.append(handoffList, composer, excerptCount, previewButton, preview, capture, refreshHandoff, previewBytes);
  const contextUi = button('Open file / diff / job context…', 'Use the existing context review to add a file, diff or job snapshot', () => {
    if (!projectId) { fail(new Error('Choose a project first.')); return; }
    void import('./workbench-context')
      .then((m) => m.showWorkbenchContext({ token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectId as string, source: { kind: 'diff', expected_hash: '' } }))
      .catch((reason) => fail(reason));
  }, 'small-button');
  handoff.append(contextUi);

  const advanced = el('details', 'pane-workbench-advanced');
  advanced.append(el('summary', '', 'Handoff is data, never approval: capturing context does not start a worker.'));
  advanced.append(el('p', '', 'Approval and execution happen only in the authority and Checks controls above, against the exact previewed snapshot.'));

  root.append(head, status, error, staleNote, authority, tabBar, panels.live, panels.changes, panels.checks, panels.result, handoff, advanced);
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
    // Callers pass the exact contract shape; several routes are strict and reject
    // an unexpected project_id, so this helper never augments the body.
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

  /** Clear any restored ID that is not present in current authenticated state. */
  function reconcile(present: { projects: Set<string>; tasks: Set<string>; candidates: Set<string>; attempts: Set<string>; grants: Set<string>; results: Set<string> }) {
    const patch: Partial<PaneWorkbenchPrefs> = {};
    const notes: string[] = [];
    const clearWork = () => { patch.taskId = null; patch.candidateId = null; patch.attemptId = null; patch.grantId = null; patch.resultId = null; patch.reviewId = null; };
    if (prefs.projectId && !present.projects.has(prefs.projectId)) { patch.projectId = null; clearWork(); notes.push('The previously selected project is no longer active or authorized.'); }
    if (prefs.taskId && !present.tasks.has(prefs.taskId)) { patch.taskId = null; patch.candidateId = null; patch.attemptId = null; patch.grantId = null; patch.resultId = null; patch.reviewId = null; notes.push('The previously selected task is no longer current.'); }
    if (prefs.candidateId && !present.candidates.has(prefs.candidateId)) { patch.candidateId = null; patch.attemptId = null; patch.grantId = null; patch.resultId = null; patch.reviewId = null; notes.push('The previously selected candidate is no longer current.'); }
    if (prefs.attemptId && !present.attempts.has(prefs.attemptId)) { patch.attemptId = null; notes.push('The previously selected attempt is no longer current.'); }
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

  function computeBadge(grants: Data[], cards: Data[], activeProjects: number) {
    const pendingStatuses = new Set(['approved', 'running', 'prepared', 'dispatching', 'submission_unknown', 'result_pending', 'dispatch_unknown']);
    const pending = grants.filter((grant) => pendingStatuses.has(String(grant.status))).length;
    const results = cards.length;
    const laneBusy = pending > 0;
    const badge: PaneWorkbenchBadge = {
      mode: 'workbench',
      pending,
      results,
      laneBusy,
      status: `${activeProjects} project${activeProjects === 1 ? '' : 's'} · ${grants.length} attempt${grants.length === 1 ? '' : 's'} · ${results} result${results === 1 ? '' : 's'}`,
    };
    deps.onBadge(badge);
    deps.onLaneBusy(laneBusy);
  }

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
      // A restored project that is no longer active/authorized is cleared with an
      // explicit note. No other project is substituted.
      if (prefs.projectId && !projectIds.has(prefs.projectId)) {
        deps.onPrefs({ projectId: null, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null });
        prefs = { ...prefs, projectId: null, taskId: null, candidateId: null, attemptId: null, grantId: null, resultId: null, reviewId: null };
        staleNote.hidden = false;
        staleNote.textContent = 'Prior project selection cleared (no substitution): it is no longer active or authorized. Choose explicitly.';
      }
      projectId = prefs.projectId && projectIds.has(prefs.projectId) ? prefs.projectId : null;
      options(projectSelect, 'Choose project…', projects.map((project) => ({ id: String(project.id), label: String(project.name ?? project.id) })), projectId);

      let tasks: Data[] = [];
      let candidates: Data[] = [];
      let attempts: Data[] = [];
      let grants: Data[] = [];
      let cards: Data[] = [];
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
        grants = Array.isArray(native.grants) ? native.grants : [];
        cards = Array.isArray(cardPage.cards) ? cardPage.cards : [];
        reconcile({
          projects: projectIds,
          tasks: new Set(tasks.map((task) => String(task.id))),
          candidates: new Set(candidates.map((candidate) => String(candidate.id))),
          attempts: new Set(attempts.map((attempt) => String(attempt.id))),
          grants: new Set(grants.map((grant) => String(grant.id))),
          results: new Set(cards.map((card) => String(card.result_id))),
        });
      }
      options(taskSelect, projectId ? 'Choose task…' : 'Choose project first', (projectId ? tasks : []).map((task) => ({ id: String(task.id), label: `${task.title ?? task.id} · ${task.status ?? ''}` })), prefs.taskId);
      options(candidateSelect, projectId ? 'Choose candidate…' : 'Choose project first', (projectId ? candidates : []).map((candidate) => ({ id: String(candidate.id), label: `${candidate.id} · gen ${candidate.generation ?? '?'} · ${candidate.status ?? ''}` })), prefs.candidateId);
      options(attemptSelect, projectId ? 'Choose attempt…' : 'Choose project first', (projectId ? attempts : []).map((attempt) => ({ id: String(attempt.id), label: `${attempt.id} · ${attempt.task_id ?? ''}` })), prefs.attemptId);
      options(resultSelect, projectId ? 'Choose result…' : 'Choose project first', (projectId ? cards : []).map((card) => ({ id: String(card.result_id), label: `${card.result_id} · ${card.availability ?? ''}` })), prefs.resultId);

      computeBadge(grants, cards, projects.length);
      if (projectId && projectId !== mountedFor) await mountPanels(projectId, ticket);
      if (disposed || ticket !== epoch) return;
      status.textContent = projectId
        ? `Workbench: ${projects.length} project(s) · ${grants.length} attempt(s) · ${cards.length} result(s). Read-only until you approve.`
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
    authorityMount = mountWorkbenchTaskAuthority({ container: authorityContainer, token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectIdValue });
    executionMount = mountWorkbenchExecution({ container: executionPanel, token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectIdValue, onError: (message) => { error.textContent = message; } });
    workflowMount = mountWorkbenchWorkflow({ container: changesPanel, token: deps.getToken, workspace_id: deps.workspaceId, project_id: projectIdValue, onError: (message) => { error.textContent = message; } });
    resultMount = mountWorkbenchTaskResult({
      container: resultPanel,
      token: deps.getToken,
      workspace_id: deps.workspaceId,
      project_id: projectIdValue,
      onChanged: () => void load(),
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

  // ---- Explicit excerpt handoff -------------------------------------------
  const selected = new Set<string>();

  function renderHandoff() {
    selected.clear();
    handoffList.replaceChildren();
    const messages = deps.messages();
    if (!messages.length) {
      handoffList.append(el('p', '', 'This pane has no conversation messages yet. Compose a task or question to hand off.'));
    }
    for (const message of messages.slice(-100)) {
      const row = el('label', 'pane-workbench-excerpt');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', `Include ${message.role} excerpt`);
      const text = el('span', 'pane-workbench-excerpt-text', truncated(message.text.replace(/\s+/g, ' ')));
      const size = el('small', '', `${message.role} · ${bytes(message.text)} bytes`);
      const update = () => {
        if (checkbox.checked) selected.add(message.id);
        else selected.delete(message.id);
        updateExcerptCount();
      };
      checkbox.addEventListener('change', update);
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
      const text = item.text;
      if (bytes(text) > EXCERPT_MAX_BYTES) throw Error(`one excerpt exceeds ${EXCERPT_MAX_BYTES} bytes`);
      if (total + bytes(text) > EXCERPT_TOTAL_BYTES) throw Error(`selected excerpts exceed ${EXCERPT_TOTAL_BYTES} bytes total`);
      total += bytes(text);
      list.push({ ...item, text });
    }
    return list;
  }

  function updateExcerptCount() {
    try {
      const list = boundedExcerpts();
      excerptCount.textContent = `${list.length}/${EXCERPT_MAX_COUNT} excerpts · ${list.reduce((sum, item) => sum + bytes(item.text), 0)}/${EXCERPT_TOTAL_BYTES} bytes total`;
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
      previewBytes.textContent = `${bytes(JSON.stringify(payload))} bytes · hashes computed client-side; no capture performed.`;
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
      // Server contract is lead-owned: source.kind='conversation' with the live
      // binding revalidated and each excerpt re-hashed. This never inherits the
      // whole conversation and never starts a worker.
      const snapshot = await owner('/api/workbench/context', { action: 'capture', workspace_id: deps.workspaceId, project_id: projectId, source: payload });
      const context = (snapshot.context ?? {}) as Data;
      status.textContent = `Captured conversation snapshot ${context.id ?? '(recorded)'} · ${context.snapshot?.hash ?? ''}. It is now an explicit choice in task authority; nothing was sent to a model.`;
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
    disposePanels();
    void load();
  });
  taskSelect.addEventListener('change', () => { prefs = { ...prefs, taskId: taskSelect.value || null }; deps.onPrefs({ taskId: prefs.taskId }); });
  candidateSelect.addEventListener('change', () => { prefs = { ...prefs, candidateId: candidateSelect.value || null }; deps.onPrefs({ candidateId: prefs.candidateId }); });
  attemptSelect.addEventListener('change', () => { prefs = { ...prefs, attemptId: attemptSelect.value || null }; deps.onPrefs({ attemptId: prefs.attemptId }); });
  resultSelect.addEventListener('change', () => { prefs = { ...prefs, resultId: resultSelect.value || null }; deps.onPrefs({ resultId: prefs.resultId }); });

  // Host unlock can arrive after the first paint (mode restored before Connect).
  // Reload only the read-only state when this view is actually visible.
  const onConnected = () => { if (!disposed && visible) void load(); };
  window.addEventListener('orbit-host-connected', onConnected);

  renderHandoff();

  return {
    refresh: () => load(),
    setVisible(next: boolean) {
      visible = next;
      if (visible && !disposed) void load();
    },
    invalidateBinding() {
      epoch++;
      disposePanels();
      renderHandoff();
      void load();
    },
    dispose() {
      disposed = true;
      epoch++;
      window.removeEventListener('orbit-host-connected', onConnected);
      disposePanels();
      deps.body.replaceChildren();
    },
  };
}
