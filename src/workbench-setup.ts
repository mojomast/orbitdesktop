import { button, el } from './dom';
import './workbench-setup.css';

type Data = Record<string, any>;
type Draft = { id: string; op_id?: string; project_id: string; goal: string; title: string; acceptance_statement: string; check_definition_id: string; status: string; task_id?: string; candidate_id?: string; attempt_id?: string; context_ids?: string[]; grant_id?: string };
type Review = { preview_id: string; preview_digest: string; expires_at: number; summary?: unknown; draft?: Draft; preview?: Data; source?: Data; repair_iteration_limit?: number };
type Phase = 'draft' | 'prepare' | 'launch' | 'wait' | 'wait_cancel';

export function createWorkbenchSetup(deps: {
  workspaceId: string; paneId: string; getToken: () => string;
  binding: () => { profileId: string; sessionId: string; bindingRevision: number };
  selectedProject: () => string | null;
  selectedTask: () => string | null;
  onProject: (id: string) => void;
  onRegister: () => void;
  onPrepared: (draft: Draft) => void;
  onOpenNormal?: () => void;
}) {
  const root = el('section', 'workbench-setup'); root.setAttribute('aria-label', 'Set up a Workbench task');
  const heading = el('h2', '', 'What are we working on?');
  const goal = el('textarea'); goal.rows = 3; goal.maxLength = 4000; goal.placeholder = 'Describe the outcome you want for your project…'; goal.setAttribute('aria-label', 'What are we working on?');
  const project = el('select'); project.setAttribute('aria-label', 'Project for this task');
  const projectField = el('label', 'workbench-setup-field'); projectField.append(el('span', '', 'Project'), project);
  const register = button('Register project', 'Choose and register a project folder', deps.onRegister, 'small-button');
  const projectRow = el('div', 'workbench-setup-row'); projectRow.append(projectField, register);
  const suggestionList = el('div', 'workbench-setup-suggestions');
  const draftChoice = el('select'); draftChoice.setAttribute('aria-label', 'Resume saved task setup'); draftChoice.hidden = true;
  const savedDrafts = el('label', 'workbench-setup-field'); savedDrafts.append(el('span', '', 'Saved task setups'), draftChoice);
  savedDrafts.hidden = true;
  const adjust = el('details'); adjust.append(el('summary', '', 'Adjust plan'));
  const title = el('input'); title.maxLength = 240; title.setAttribute('aria-label', 'Proposed task title');
  const success = el('textarea'); success.rows = 2; success.maxLength = 4000; success.setAttribute('aria-label', 'What success looks like');
  const check = el('select'); check.setAttribute('aria-label', 'Supported check');
  const field = (label: string, control: HTMLElement) => { const node = el('label', 'workbench-setup-field'); node.append(el('span', '', label), control); return node; };
  adjust.append(field('Title', title), field('Success criteria', success), field('Verification', check), el('p', '', 'node-test requires discoverable Node tests in this project. host-regression tests Orbit itself, not your project; use manual Task settings for that check.'));
  const brief = el('div', 'workbench-setup-brief');
  const state = el('p', 'workbench-setup-state'); state.setAttribute('role', 'status');
  const error = el('p', 'workbench-setup-error'); error.setAttribute('role', 'alert');
  const review = el('div', 'workbench-setup-review');
  const actions = el('div', 'workbench-setup-row');
  const newTask = button('Set up another task', 'Start a new goal without changing the selected task', () => {
    if (busy || pending) return;
    draft = null; draftChoice.value = ''; startingNew = true; setupReview = launchReview = null; goal.value = ''; title.value = ''; success.value = ''; check.value = ''; render(); goal.focus();
  }, 'small-button');
  const refreshButton = button('Check saved state', 'Read the authoritative setup state without retrying an operation', () => void refresh(), 'small-button');
  const primary = button('Review setup', 'Review the task before setting it up', () => void next());
  primary.classList.add('workbench-setup-primary');
  const retry = button('Retry exact request', 'Retry the identical saved operation and key; never create a new request', () => void retryPending(), 'small-button');
  actions.append(primary, retry, refreshButton, newTask);
  const limits = el('details'); limits.append(el('summary', '', 'Work limits'));
  const waiting = el('section', 'workbench-setup-waiting'); waiting.setAttribute('aria-label', 'Saved waiting intentions');
  const capacity = el('details'); capacity.append(el('summary', '', 'Setup capacity'));
  const waitMinutes = el('input'); waitMinutes.type = 'number'; waitMinutes.min = '1'; waitMinutes.max = '1440'; waitMinutes.step = '1'; waitMinutes.value = '60'; waitMinutes.setAttribute('aria-label', 'Wait deadline in minutes');
  const waitButton = button('Save for later review', 'Save a waiting intention without approving or starting execution', () => void saveWait());
  const waitControls = el('div', 'workbench-setup-row'); waitControls.append(field('Review within (minutes)', waitMinutes), waitButton);
  const budgetInputs = [
    ['Tool calls', 20, 1, 100], ['Managed checks', 2, 0, 5], ['Duration (seconds)', 300, 1, 900], ['Repair iterations', 1, 0, 10],
  ].map(([label, value, min, max]) => {
    const input = el('input'); input.type = 'number'; input.value = String(value); input.min = String(min); input.max = String(max); input.step = '1'; input.setAttribute('aria-label', String(label)); limits.append(field(String(label), input)); return input;
  });
  root.append(heading, goal, projectRow, savedDrafts, suggestionList, adjust, brief, review, limits, waitControls, waiting, capacity, state, error, actions);

  let disposed = false, generation = 0, busy = false, dirty = false, startingNew = false, draft: Draft | null = null;
  let setupReview: Review | null = null, launchReview: Review | null = null;
  let projects: { id: string; name: string }[] = [], suggestions: Data[] = [];
  let availableDrafts: Draft[] = [];
  let waits: Data[] = [];
  let queuedGoal: { value: string; binding: string } | null = null;
  type Pending = { phase: Phase; draftId?: string; opId: string; bindingKey: string; request: Data };
  let pending: Pending | null = null;
  const bindingKey = () => JSON.stringify([deps.workspaceId, deps.paneId, deps.binding().bindingRevision, deps.binding().profileId, deps.binding().sessionId]);
  const pendingKey = `orbit-workbench-setup-pending:${deps.workspaceId}:${deps.paneId}`;
  const readPending = (): Pending | null => { try { const saved = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); return saved?.bindingKey === bindingKey() && ['draft','prepare','launch','wait','wait_cancel'].includes(saved.phase) && typeof saved.opId === 'string' && saved.request?.op_id === saved.opId && saved.request?.workspace_id === deps.workspaceId && saved.request?.pane_id === deps.paneId && saved.request?.expected_binding_revision === deps.binding().bindingRevision && saved.request?.action === saved.phase ? saved as Pending : null; } catch { return null; } };
  const savePending = (value: typeof pending) => { pending = value; try { if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); } catch { error.textContent = 'Browser session storage unavailable. Keep this tab open; check saved state before another action.'; } };
  const wire = (body: Data) => ({ workspace_id: deps.workspaceId, pane_id: deps.paneId, expected_binding_revision: deps.binding().bindingRevision, ...body });
  const mark = (phase: Phase, body: Data) => { const opId = crypto.randomUUID(); savePending({ phase, draftId: draft?.id, opId, bindingKey: bindingKey(), request: wire({ action: phase, ...body, op_id: opId }) }); };
  const current = (ticket: number, binding: string) => !disposed && ticket === generation && binding === bindingKey();
  const explain = (code: string, reason?: string): string => {
    const messages: Record<string, string> = {
      native_runtime_unconfigured: 'This conversation has no configured native worker. Configure its trusted-host profile before starting work.',
      no_discoverable_node_tests: 'No supported Node tests were found in this project. Add a discoverable test or use manual Task settings.',
      check_not_supported_for_project_setup: 'Guided setup supports node-test only. Use manual Task settings for other checks.',
      incomplete_source_capture: 'Project files could not be captured completely. Inspect project scope in Project Workbench.',
      binding_changed: 'The linked conversation changed. Refresh this pane before preparing work.',
      draft_binding_changed: 'This saved setup belongs to another conversation. Choose one for the current binding.',
      setup_source_or_policy_changed: 'Project files or workspace policy changed since review. Check saved state and review again.',
      execution_lane_busy_or_unknown: 'Another execution is busy or its outcome is unknown. Inspect Workbench status before starting.',
      native_unavailable: 'Native worker execution is unavailable on this host.',
      setup_preview_expired: 'The task setup review expired. Review the task again.',
      launch_preview_changed: 'The start review is stale. Review work limits and scope again.',
      outcome_unknown: 'Execution outcome unknown. Check saved state, then retry only the exact pending request.',
      submission_unknown: 'Submission outcome unknown. Check saved state, then retry only the exact pending request.',
    };
    return messages[reason || ''] || messages[code] || (reason ? `${code.replace(/_/g, ' ')} · ${reason.replace(/_/g, ' ')}` : code.replace(/_/g, ' '));
  };
  async function api(body: Data, ticket: number, key: string): Promise<Data> {
    const token = deps.getToken(); if (!token) throw Error('Connect the host to set up a task.');
    const response = await fetch('/api/workbench/setup', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body.workspace_id ? body : wire(body)), signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!current(ticket, key) || token !== deps.getToken()) throw Error('Binding changed. Read saved state before continuing.');
    if (!response.ok || data.ok === false) throw Object.assign(Error(explain(String(data.code || 'unavailable'), typeof data.reason === 'string' ? data.reason : undefined)), { known: response.status < 500 && !['outcome_unknown','submission_unknown'].includes(data.code) });
    return data;
  }
  function invalidate() { setupReview = launchReview = null; review.replaceChildren(); }
  function setDraft(value: Draft) { draft = value; dirty = false; startingNew = false; goal.value = value.goal || ''; title.value = value.title || ''; success.value = value.acceptance_statement || ''; if (value.project_id) project.value = value.project_id; if (value.check_definition_id) check.value = value.check_definition_id; }
  function applyGoal(value: string) {
    draft = null; draftChoice.value = ''; startingNew = true; goal.value = value.slice(0, 4000);
    title.value = ''; success.value = ''; check.value = ''; dirty = true; invalidate(); render(); goal.focus();
  }
  function acceptMutation(phase: Phase, response: Data) {
    if (phase === 'wait' || phase === 'wait_cancel') {
      if (!response.intent?.id || typeof response.intent.state !== 'string') throw Error('Waiting response incomplete. Retry only the exact request.');
      waits = [...waits.filter(item => item.id !== response.intent.id), response.intent]; savePending(null); invalidate(); return;
    }
    if (!response.draft?.id || typeof response.draft.status !== 'string') throw Error('Response incomplete; check saved state or retry the exact request.');
    setDraft(response.draft); savePending(null); invalidate();
    if (phase !== 'draft') deps.onPrepared({ ...response.draft, grant_id: response.draft.grant_id ?? response.grant?.id });
  }
  function render() {
    const prepared = draft?.status === 'prepared';
    waitControls.hidden = !prepared;
    waitMinutes.disabled = busy || !!pending;
    waitButton.disabled = busy || !!pending || waits.some(item => item.draft_id === draft?.id && ['waiting_lane','needs_review'].includes(item.state));
    waiting.replaceChildren(el('h3', '', 'Waiting for owner review'), el('p', '', 'Saved intentions never start automatically. Refresh saved state, review current scope and approve Start work separately. Cancelling an intention does not stop a running process.'));
    waiting.hidden = !waits.length;
    for (const item of waits) {
      const card = el('div', 'workbench-setup-suggestion'); card.dataset.intentId = item.id;
      const saved = availableDrafts.find(d => d.id === item.draft_id);
      card.append(el('strong', '', saved?.title || `Task ${item.task_id}`), el('p', '', `${item.state.replaceAll('_', ' ')}${item.position ? ` · position ${item.position}` : ''} · deadline ${new Date(item.deadline).toLocaleString()}`), el('p', '', String(item.reason || '').replaceAll('_', ' ')));
      if (['waiting_lane','needs_review'].includes(item.state)) {
        const resume = button('Review waiting task', 'Revalidate current task scope and request a fresh start review', () => {
          if (!saved || busy || pending) return; setDraft(saved); invalidate();
          const b = item.budget; if (b) [b.calls,b.checks,b.duration_ms / 1000,b.repair_iterations ?? 1].forEach((value, index) => { budgetInputs[index].value = String(value); });
          deps.onPrepared(saved); render(); void next();
        }, 'small-button'); resume.disabled = busy || !!pending || !saved;
        const cancel = button('Cancel waiting intention', 'Cancel only this saved intention; never signal a running worker', () => void waitingMutation('wait_cancel', { intent_id: item.id }), 'small-button'); cancel.disabled = busy || !!pending;
        card.append(resume, cancel);
      }
      waiting.append(card);
    }
    const complete = draft?.status === 'launched';
    const unresolved = !!draft && ['preparing','prepare_unknown','launch_unknown','failed'].includes(draft.status);
    brief.replaceChildren();
    if (draft) brief.append(el('strong', '', draft.title || 'Work brief'), el('p', '', draft.goal), el('p', '', `Success: ${draft.acceptance_statement || 'Review and add success criteria.'}`), el('p', '', `Check: ${draft.check_definition_id || 'Choose a supported check.'}`));
    if (prepared || complete) {
      brief.append(el('p', '', `${complete ? 'Work started' : 'Task set up; no model execution started'} · ${draft?.goal || ''}`));
      if (deps.onOpenNormal) brief.append(button('Open linked conversation', 'Open the originating Normal chat', deps.onOpenNormal, 'small-button'));
    }
    newTask.hidden = !draft;
    newTask.disabled = busy || !!pending;
    retry.hidden = !pending;
    retry.disabled = busy || !pending;
    refreshButton.disabled = busy;
    draftChoice.disabled = busy || !!pending;
    register.disabled = busy || !!pending;
    suggestionList.querySelectorAll<HTMLButtonElement>('button').forEach(suggestion => { suggestion.disabled = busy || !!pending; });
    const locked = busy || !!pending || prepared || complete || unresolved;
    for (const control of [goal, project, title, success, check]) control.disabled = locked;
    for (const control of budgetInputs) control.disabled = busy || !!pending || !prepared;
    limits.hidden = !prepared || complete;
    primary.textContent = complete ? 'View task status' : launchReview ? 'Start work' : setupReview ? 'Set up task' : prepared ? 'Review start' : 'Review setup';
    primary.disabled = busy || unresolved || !!pending || (!complete && (!goal.value.trim() || !project.value));
    state.textContent = busy ? 'Saving or reading setup…' : pending ? `${pending.phase === 'launch' ? 'Start' : 'Setup'} outcome unknown. Check saved state; no operation will be replayed automatically.`
      : unresolved ? `Setup status: ${draft!.status}. Inspect saved state and Task settings; an unknown outcome is never replayed.`
      : complete ? 'Work was started. See Live, Changes, Checks and Result below for recorded progress and outcome.'
      : prepared ? 'Next: review the exact execution scope and limits before starting work.'
      : draft ? 'Next: review the proposed setup. Setting up a task does not start a worker.'
      : projects.length ? 'Describe your goal, then review the proposed task setup.' : 'Choose a registered project to set up a task.';
  }
  function showReview(data: Review, execution: boolean) {
    review.replaceChildren(el('h3', '', execution ? 'Review before starting work' : 'Review task setup'));
    const summary = data.summary;
    if (typeof summary === 'string') review.append(el('p', '', summary));
    else if (summary && typeof summary === 'object') for (const [key, value] of Object.entries(summary)) if (typeof value === 'string' || typeof value === 'number') review.append(el('p', '', `${key.replace(/_/g, ' ')}: ${value}`));
    const actual: Data = data.preview ?? data;
    if (execution) {
      const recipient = actual.recipient ?? {};
      const runtime = recipient.native_runtime ?? actual.native_runtime ?? {};
      const limits = actual.budget ?? {};
      review.append(el('p', '', `Recipient profile: ${recipient.profile_id || 'unknown'} · model ${runtime.model || 'unknown'} · destination ${runtime.destination || 'unknown'}`));
      review.append(el('p', '', `Context shared with worker: your goal “${draft?.goal || ''}” and success criteria “${draft?.acceptance_statement || ''}”. No whole conversation is inherited.`));
      review.append(el('p', '', `Allowed scope: private candidate reading and expected-hash changes; recorded required checks: ${(actual.required_checks ?? []).map((item: Data) => item.definition_id).join(', ') || draft?.check_definition_id || 'none'}. No original-tree application.`));
      review.append(el('p', '', `Reviewed work limits: ${limits.calls ?? 'unknown'} calls, ${limits.checks ?? 'unknown'} checks, ${Number.isFinite(limits.duration_ms) ? limits.duration_ms / 1000 : 'unknown'} seconds, ${limits.repair_iterations ?? data.repair_iteration_limit ?? 'unknown'} repairs. Starting work runs a separate worker on the private copy.`));
      const technical = el('details'); technical.append(el('summary', '', 'Exact scope details'), el('p', '', `Candidate ${actual.candidate_id || 'unknown'} · context records ${(actual.contexts ?? []).map((item: Data) => item.id).join(', ') || 'none'} · attempt ${actual.attempt_id || 'unknown'}`)); review.append(technical);
    } else {
      review.append(el('p', '', `Goal: ${draft?.goal || goal.value} · Project: ${projects.find(item => item.id === project.value)?.name || project.value}`));
      review.append(el('p', '', `Title: ${draft?.title || title.value} · Success: ${draft?.acceptance_statement || success.value} · Verification: ${draft?.check_definition_id || check.value}`));
      if (data.source) review.append(el('p', '', `Private candidate: ${data.source.files?.length ?? 'unknown'} source files · excluded: ${data.source.exclusions?.length ?? 'unknown'}.`));
      review.append(el('p', '', 'Set up task creates the task, private candidate, bound attempt and goal-only context. No model or check runs.'));
    }
    review.append(el('small', '', `Review expires ${new Date(data.expires_at).toLocaleString()}. Editing the work limits requires a new start review.`));
  }
  function validReview(value: Data): value is Review {
    return typeof value.preview_id === 'string' && /^[a-f0-9-]{36}$/.test(value.preview_id)
      && typeof value.preview_digest === 'string' && /^[a-f0-9]{64}$/.test(value.preview_digest)
      && Number.isFinite(value.expires_at) && value.expires_at > Date.now();
  }
  function budget() {
    const numbers = budgetInputs.map(input => input.valueAsNumber);
    if (numbers.some((value, index) => !Number.isSafeInteger(value) || value < Number(budgetInputs[index].min) || value > Number(budgetInputs[index].max))) throw Error('Enter whole-number limits within the shown ranges.');
    return { calls: numbers[0], checks: numbers[1], duration_ms: numbers[2] * 1000, repair_iterations: numbers[3] };
  }
  async function saveWait() {
    if (!draft || busy || pending) return;
    try {
      const minutes = waitMinutes.valueAsNumber;
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) throw Error('Choose a review deadline from 1 to 1440 minutes.');
      await waitingMutation('wait', { draft_id: draft.id, deadline: Date.now() + minutes * 60000, budget: budget() });
    } catch (reason) { error.textContent = reason instanceof Error ? reason.message : 'Waiting intention unavailable'; }
  }
  async function waitingMutation(phase: 'wait' | 'wait_cancel', fields: Data) {
    if (busy || pending) return;
    let completed = false;
    const ticket = generation, key = bindingKey(); busy = true; error.textContent = ''; mark(phase, fields); render();
    try { acceptMutation(phase, await api(pending!.request, ticket, key)); completed = true; }
    catch (reason) { if (current(ticket, key)) { error.textContent = reason instanceof Error ? reason.message : 'Waiting outcome unknown'; if ((reason as {known?: boolean}).known) savePending(null); } }
    finally { if (current(ticket, key)) { busy = false; render(); if (completed) void refresh(); } }
  }
  async function next() {
    if (busy) return;
    if (draft?.status === 'launched') { root.closest('.pane-workbench')?.querySelector<HTMLButtonElement>('.pane-workbench-tab[aria-label="Live workbench view"]')?.click(); return; }
    if (pending) { error.textContent = 'Check saved state before another operation. An unknown request is never sent again automatically.'; return; }
    const ticket = generation, key = bindingKey(); busy = true; error.textContent = ''; render();
    try {
      if (launchReview) {
        if (Date.now() >= launchReview.expires_at) { invalidate(); throw Error('Start review expired. Review again.'); }
        mark('launch', { draft_id: draft!.id, preview_id: launchReview.preview_id, preview_digest: launchReview.preview_digest }); render();
        acceptMutation('launch', await api(pending!.request, ticket, key));
      } else if (setupReview) {
        if (Date.now() >= setupReview.expires_at) { invalidate(); throw Error('Setup review expired. Review again.'); }
        mark('prepare', { preview_id: setupReview.preview_id, preview_digest: setupReview.preview_digest }); render();
        acceptMutation('prepare', await api(pending!.request, ticket, key));
      } else if (draft?.status === 'prepared') {
        const result = await api({ action: 'launch_preview', draft_id: draft.id, budget: budget() }, ticket, key);
        if (!validReview(result)) throw Error('Start review incomplete or expired. Check saved state and review again.');
        launchReview = result as Review; showReview(launchReview, true);
      } else {
        if (!project.value || !goal.value.trim()) throw Error('Choose a project and describe the goal.');
        if (!draft || dirty || draft.goal !== goal.value.trim() || draft.project_id !== project.value) {
          mark('draft', { goal: goal.value.trim(), project_id: project.value, ...(title.value.trim() ? { title: title.value.trim() } : {}), ...(success.value.trim() ? { acceptance_statement: success.value.trim() } : {}), ...(check.value ? { check_definition_id: check.value } : {}) }); render();
          acceptMutation('draft', await api(pending!.request, ticket, key));
        }
        const result = await api({ action: 'preview', draft_id: draft!.id, op_id: crypto.randomUUID() }, ticket, key);
        if (!validReview(result)) throw Error('Setup review incomplete or expired. Check saved state and review again.');
        setupReview = result as Review; showReview(setupReview, false);
      }
    } catch (reason) {
      if (current(ticket, key)) { error.textContent = reason instanceof Error ? reason.message : 'Setup unavailable'; if ((reason as {known?: boolean}).known) savePending(null); invalidate(); }
    } finally { if (current(ticket, key)) { busy = false; render(); } }
  }
  async function retryPending() {
    if (busy || !pending || pending.bindingKey !== bindingKey()) return;
    const exact = pending, ticket = generation, key = bindingKey(); busy = true; error.textContent = ''; render();
    try { acceptMutation(exact.phase, await api(exact.request, ticket, key)); }
    catch (reason) { if (current(ticket, key)) { error.textContent = reason instanceof Error ? reason.message : 'Outcome unknown'; if ((reason as {known?: boolean}).known) savePending(null); } }
    finally { if (current(ticket, key)) { busy = false; render(); } }
  }
  async function refresh() {
    if (busy || disposed) return;
    const ticket = ++generation, key = bindingKey(); busy = true; error.textContent = ''; invalidate(); render();
    try {
      const result = await api({ action: 'state' }, ticket, key);
      projects = Array.isArray(result.projects) ? result.projects : [];
      suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
      waits = Array.isArray(result.waiting_intents) ? result.waiting_intents : [];
      capacity.replaceChildren(el('summary', '', 'Setup capacity'));
      if (result.capacity) {
        capacity.append(el('p', '', `Private journal: ${result.capacity.bytes.used} / ${result.capacity.bytes.limit} bytes`));
        for (const [kind, value] of Object.entries(result.capacity.records ?? {}) as [string, Data][]) capacity.append(el('p', '', `${kind}: ${value.remaining} slots remaining (${value.retained} / ${value.limit} retained)`));
      }
      const selected = project.value || deps.selectedProject() || '';
      project.replaceChildren(new Option('Choose a project…', ''), ...projects.map(item => new Option(item.name, item.id)));
      if (projects.some(item => item.id === selected)) project.value = selected;
      else if (projects.length === 1) project.value = projects[0].id;
      check.replaceChildren(new Option('Server-recommended check', ''), new Option('node-test · project Node tests', 'node-test'));
      const drafts: Draft[] = Array.isArray(result.drafts) ? result.drafts : [];
      availableDrafts = drafts;
      savedDrafts.hidden = draftChoice.hidden = drafts.length <= 1;
      draftChoice.replaceChildren(new Option('Choose a saved setup…', ''), ...drafts.map(item => new Option(`${item.title || item.goal.slice(0, 60)} · ${item.status}`, item.id)));
      const saved = drafts.find(item => item.id === draft?.id)
        ?? (!draft && !dirty && !startingNew && !pending && !readPending() ? drafts.find(item => item.task_id && item.task_id === deps.selectedTask()) ?? (drafts.length === 1 ? drafts[0] : undefined) : undefined);
      if (saved && !dirty) {
        setDraft(saved);
        draftChoice.value = saved.id;
        if (saved.attempt_id && !deps.selectedTask() && ['prepared','launched','launch_unknown'].includes(saved.status)) deps.onPrepared(saved);
      }
      const uncertain = pending ?? readPending();
      if (uncertain) {
        // The read can establish that the exact operation completed, but it may
        // not prove a missing receipt failed. Never replay an unknown mutation.
        const recovered = drafts.find(item => item.op_id === uncertain.opId && (uncertain.phase === 'draft' || item.id === uncertain.draftId));
        if (recovered && (uncertain.phase === 'draft' || uncertain.phase === 'prepare' && recovered.status === 'prepared' || uncertain.phase === 'launch' && recovered.status === 'launched')) { setDraft(recovered); savePending(null); if (recovered.attempt_id) deps.onPrepared(recovered); }
        else { pending = uncertain; error.textContent = 'Saved state cannot confirm this exact operation. Retry exact request to recover its receipt; no automatic replay occurs.'; }
      }
      suggestionList.replaceChildren();
      for (const item of suggestions) {
        const card = el('div', 'workbench-setup-suggestion');
        card.append(el('strong', '', 'Agent suggestion — review before setup'), el('p', '', String(item.goal || item.title || 'Suggested work')),
          button('Adopt suggestion', 'Copy this suggestion into the editable work brief; no setup or authorization', () => {
            if (busy || pending) return;
            draft = null; draftChoice.value = ''; startingNew = true; goal.value = String(item.goal || '').slice(0, 4000); title.value = String(item.title || '').slice(0, 240); success.value = String(item.acceptance_statement || '').slice(0, 4000);
            if (projects.some(project => project.id === item.project_id)) project.value = item.project_id;
            check.value = item.check_definition_id === 'node-test' ? 'node-test' : '';
            dirty = true; invalidate(); render(); goal.focus();
          }, 'small-button'));
        suggestionList.append(card);
      }
    } catch (reason) { if (current(ticket, key)) error.textContent = reason instanceof Error ? reason.message : 'Setup state unavailable'; }
    finally { if (current(ticket, key)) {
      busy = false;
      if (queuedGoal?.binding === key && !pending && !dirty) applyGoal(queuedGoal.value);
      queuedGoal = null; render();
    } }
  }
  for (const control of [goal, title, success, project, check, ...budgetInputs]) control.addEventListener(control === project || control === check ? 'change' : 'input', () => { dirty = true; invalidate(); render(); });
  draftChoice.addEventListener('change', () => { const chosen = availableDrafts.find(item => item.id === draftChoice.value); if (!chosen || busy || pending) return; setDraft(chosen); invalidate(); render(); });
  project.addEventListener('change', () => { if (project.value) deps.onProject(project.value); });
  render(); void refresh();
  return {
    element: root, refresh, invalidate() {
      generation++; busy = false; draft = null; dirty = false; startingNew = false; pending = null; queuedGoal = null; projects = []; suggestions = []; availableDrafts = []; waits = []; capacity.replaceChildren();
      goal.value = ''; title.value = ''; success.value = ''; check.replaceChildren(); project.replaceChildren();
      brief.replaceChildren(); suggestionList.replaceChildren(); draftChoice.replaceChildren(); savedDrafts.hidden = true;
      invalidate(); render(); void refresh();
    },
    seedGoal(value: string) { if (disposed || pending) return; if (value.trim()) { if (busy) queuedGoal = { value, binding: bindingKey() }; else applyGoal(value); } else goal.focus(); },
    dispose() { disposed = true; generation++; },
  };
}
