import { button, el } from './dom';

type Definition = { id: string; executable: string; args: string[]; limits: unknown; policy: unknown };
type Task = { id: string; title: string; status: string; acceptance_version: number; acceptance_digest: string; acceptance: { statement: string; check_definition_id: string; policy: unknown }; check_definition_id: string; recipient: { profile_id: string; session_id: string } | null; candidate_id: string | null; latest_evidence_id: string | null };
type FileEntry = { path: string; hash: string; bytes: number; state: string };
type Candidate = { id: string; task_id: string; source_manifest_hash: string; preview_digest: string; base_hash: string; generation: number; hash: string; files: FileEntry[]; exclusions: unknown; limited: boolean; total_bytes: number; head: null; status: string };
type Job = { id: string; op_id: string; candidate_id: string; status: string; pid: number | null; process_start: string | null; started_at: number | null; ended_at: number | null; definition_id: string; spec_digest: string; supervisor?: string; command?: unknown; cancel_confirmed?: boolean; outcome_note?: string };
type Evidence = { id: string; job_id: string; candidate_id: string; verdict: 'pass' | 'fail' | 'inconclusive'; exit_code: number | null; signal: string | null; started_at: number | null; ended_at: number | null; candidate_hash_before: string; candidate_hash_after: string; definition_id: string; definition_hash: string; artifact_hash: string; log_hash: string; log_bytes: number; stdout_preview: string; stderr_preview: string; superseded: boolean; revoked: boolean };
type Review = { id: string; candidate_id: string; evidence_ids: string[]; decision: string; review_identity: string; created_at: number };
type Projection = { tasks: Task[]; candidates: Candidate[]; jobs: Job[]; evidence: Evidence[]; reviews: Review[]; definitions: Definition[]; active_count: number; revoked: boolean; review_identity: Record<string, string>; target_changed: Record<string, boolean>; unknown_jobs: Record<string, string>; policy: string; execution: string };
type CandidatePreview = { digest: string; preview_id: string; expires_at: number; base: { manifest_hash: string; files: FileEntry[]; exclusions: unknown; limited: boolean; total_bytes: number; head: null } };
type CheckPreview = { spec_digest: string; preview_id: string; expires_at: number; candidate_id: string; candidate_hash: string; acceptance_version: number; definition_id: string; definition_digest: string; definition_hash: string; executable: string; args: string[]; script: string; limits: unknown; policy: unknown };
type Reply = Record<string, unknown>;

function row(label: string, value: unknown) {
  return el('p', '', `${label}: ${typeof value === 'string' ? value : JSON.stringify(value ?? null)}`);
}
function labelled(label: string, control: HTMLElement) {
  const node = el('label');
  node.append(el('span', '', `${label} `), control);
  return node;
}
function input(label: string) {
  const node = el('input');
  node.setAttribute('aria-label', label);
  return node;
}
function choice(select: HTMLSelectElement, values: { id: string; label: string }[], selected: string) {
  select.replaceChildren();
  for (const value of values) {
    const option = el('option', '', value.label);
    option.value = value.id;
    select.append(option);
  }
  select.value = selected;
  if (!select.value && values.length) select.value = values[0].id;
}

export function mountWorkbenchExecution(args: {
  container: HTMLElement;
  // Accepts either the owner token or a getter, so the host can mount with
  // `token:getToken` or a resolved string without changing the call shape.
  token: string | (() => string);
  workspace_id: string;
  project_id: string;
  onAskContext?: (jobId: string) => void;
  onError?: (message: string) => void;
}): { dispose(): void; refresh(): Promise<void> } {
  const status = el('p', 'workbench-execution-status', 'Loading execution state…');
  status.setAttribute('role', 'status');
  const error = el('p', 'workbench-execution-error');
  error.setAttribute('role', 'alert');
  const summary = el('section', 'workbench-execution-summary');
  const taskView = el('section', 'workbench-execution-tasks');
  const candidateView = el('section', 'workbench-execution-candidate');
  const fileList = el('div', 'workbench-execution-files');
  const previewView = el('div', 'workbench-execution-preview');
  const fileMeta = el('div', 'workbench-execution-file-meta');
  const checkView = el('div', 'workbench-execution-check-preview');
  const jobsView = el('section', 'workbench-execution-jobs');
  const reviewView = el('section', 'workbench-execution-review');
  const title = input('Task title');
  const acceptance = el('textarea'); acceptance.setAttribute('aria-label', 'Acceptance statement');
  const definition = el('select'); definition.setAttribute('aria-label', 'Task check definition');
  const profile = input('Recipient profile ID');
  const session = input('Recipient session ID');
  const taskSelect = el('select'); taskSelect.setAttribute('aria-label', 'Selected task');
  const candidateSelect = el('select'); candidateSelect.setAttribute('aria-label', 'Selected candidate');
  const checkDefinition = el('select'); checkDefinition.setAttribute('aria-label', 'Check definition');
  const edit = el('textarea'); edit.setAttribute('aria-label', 'Candidate file edit'); edit.rows = 12; edit.cols = 90;
  const expected = el('p', '', 'Expected hash: no file selected');
  const proposed = el('textarea'); proposed.setAttribute('aria-label', 'Owner-pasted structured patch'); proposed.rows = 5;
  const submissionNote = el('p', '', 'Owner-pasted proposed patch only; tool: agent_tool_blocked. Not agent-authored and not verified.');
  let projection: Projection | null = null;
  let candidatePreview: CandidatePreview | null = null;
  let checkPreview: CheckPreview | null = null;
  let opId = '';
  let selectedFile: { candidate_id: string; path: string; hash: string; text: string; binary: boolean } | null = null;
  let dirty = false;
  let pending = false;
  let disposed = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controllers = new Set<AbortController>();
  const selectedEvidence = new Set<string>();

  function report(message: string) {
    error.textContent = message;
    if (message) args.onError?.(message);
  }
  function invalidate() {
    epoch++;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    return epoch;
  }
  function current(ticket: number) { return !disposed && epoch === ticket; }
  async function request(body: Reply, ticket: number): Promise<Reply | null> {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const owner = typeof args.token === 'function' ? args.token() : args.token;
      if (!owner) throw Error('permission_denied');
      const response = await fetch('/api/workbench/execution', {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: args.workspace_id, project_id: args.project_id, ...body }),
        signal: controller.signal,
      });
      const data = await response.json() as Reply;
      if (!current(ticket)) return null;
      if (!response.ok || data.ok !== true) throw Error(typeof data.code === 'string' ? data.code : 'unavailable');
      return data;
    } catch (reason) {
      if (current(ticket) && !(reason instanceof Error && reason.name === 'AbortError')) {
        const message = reason instanceof Error && /^[a-z_]+$/.test(reason.message) ? reason.message : 'unavailable';
        report(`Execution: ${message}. Refresh state before retrying.`);
        status.textContent = message === 'outcome_unknown' ? 'Outcome unknown — not verified. Inspect the job state; do not assume the check passed.' : `Execution request: ${message}`;
      }
      return null;
    } finally { controllers.delete(controller); }
  }
  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!disposed && args.container.isConnected) timer = setTimeout(() => { timer = null; void refresh(); }, 2000);
  }
  function selectedCandidate() { return projection?.candidates.find(item => item.id === candidateSelect.value) ?? null; }
  function resetPreview() { candidatePreview = null; checkPreview = null; opId = ''; renderPreviews(); }
  function controls() {
    const candidate = selectedCandidate();
    createTask.disabled = pending || !title.value.trim() || !acceptance.value.trim() || !definition.value;
    previewCandidate.disabled = pending || !taskSelect.value;
    createCandidate.disabled = pending || !candidatePreview || !taskSelect.value;
    saveEdit.disabled = pending || !candidate || !selectedFile || selectedFile.candidate_id !== candidate.id || selectedFile.binary || candidate.files.find(file => file.path === selectedFile?.path)?.hash !== selectedFile.hash;
    previewCheck.disabled = pending || !candidate || !checkDefinition.value;
    runCheck.disabled = pending || !candidate || !checkPreview || checkPreview.candidate_id !== candidate.id || !opId || !!projection?.revoked || Object.keys(projection?.unknown_jobs ?? {}).length > 0;
    submission.disabled = pending || !candidate || !proposed.value.trim();
    exportCandidate.disabled = pending || !candidate;
  }
  async function act(label: string, body: Reply, done: (data: Reply) => void, refreshAfter = true) {
    if (pending || disposed) { if (!disposed) report('Execution: busy.'); return; }
    pending = true; report(''); controls();
    const ticket = invalidate();
    status.textContent = `${label}…`;
    try {
      const result = await request(body, ticket);
      if (!result || !current(ticket)) return;
      done(result);
      status.textContent = `${label} complete.`;
      if (refreshAfter) await project();
    } finally { pending = false; if (!disposed) { controls(); schedule(); } }
  }
  async function project() {
    const ticket = invalidate();
    const result = await request({ action: 'execution_state' }, ticket);
    if (!result || !current(ticket)) return;
    projection = result as unknown as Projection;
    render();
  }
  async function refresh() {
    if (disposed) return;
    if (pending) { report('Execution: busy.'); return; }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    await project();
    schedule();
  }

  const createTask = button('Create task', 'Create an owner task', () => void act('Creating task', {
    action: 'task_create', title: title.value.trim(), acceptance_statement: acceptance.value.trim(), check_definition_id: definition.value,
    profile_id: profile.value.trim(), session_id: session.value.trim(),
  }, data => { const task = data.task as Task | undefined; if (task?.id) taskSelect.dataset.next = task.id; }));
  const previewCandidate = button('Preview candidate', 'Preview a bounded candidate from this task', () => void act('Previewing candidate',
    { action: 'candidate_preview', task_id: taskSelect.value }, data => { candidatePreview = { ...(data.preview as CandidatePreview), preview_id: data.preview_id as string, expires_at: data.expires_at as number }; renderPreviews(); }, false));
  const createCandidate = button('Create candidate', 'Create exactly the previewed candidate', () => {
    if (!candidatePreview) return;
    void act('Creating candidate', { action: 'candidate_create', task_id: taskSelect.value, preview_id: candidatePreview.preview_id, preview_digest: candidatePreview.digest }, data => {
      const candidate = data.candidate as Candidate | undefined;
      if (candidate?.id) candidateSelect.dataset.next = candidate.id;
      resetPreview();
    });
  });
  const saveEdit = button('Save edit', 'Save edited candidate file with expected hash', () => {
    if (!selectedFile) return;
    void act('Saving edit', { action: 'candidate_edit', candidate_id: selectedFile.candidate_id, path: selectedFile.path, expected_hash: selectedFile.hash, content: edit.value }, data => {
      const candidate = data.candidate as Candidate;
      const file = data.file as FileEntry;
      selectedFile = { ...selectedFile!, hash: file.hash, text: edit.value };
      dirty = false;
      fileMeta.replaceChildren(row('Generation', candidate.generation), row('Candidate hash', candidate.hash), row('File hash', file.hash), row('Prior evidence superseded', data.superseded_evidence_ids));
      resetPreview();
    });
  });
  const previewCheck = button('Preview check', 'Preview exact check specification', () => {
    const candidate = selectedCandidate(); if (!candidate) return;
    void act('Previewing check', { action: 'check_preview', candidate_id: candidate.id, definition_id: checkDefinition.value }, data => {
      checkPreview = { ...(data.preview as CheckPreview), preview_id: data.preview_id as string, expires_at: data.expires_at as number };
      opId = crypto.randomUUID();
      renderPreviews();
    }, false);
  });
  const runCheck = button('Run check', 'Run exactly the previewed check once', () => {
    if (!checkPreview || !opId) return;
    const preview = checkPreview, operation = opId;
    // Preserve the operation ID on an ambiguous transport failure; never auto-resubmit.
    void act('Running check', { action: 'check_run', candidate_id: preview.candidate_id, preview_id: preview.preview_id, preview_digest: preview.spec_digest, op_id: operation }, data => {
      checkView.append(row('Job', data.job), row('Evidence', data.evidence));
      resetPreview();
    });
  });
  const exportCandidate = button('Export read-only artifact', 'Export the candidate as a read-only artifact; integration is unsupported', () => {
    const candidate = selectedCandidate(); if (!candidate) return;
    void act('Exporting candidate', { action: 'candidate_export', candidate_id: candidate.id }, data => {
      const artifact = data.artifact as { target_changed: boolean; truncated: boolean; files: { path: string; state: string; source_state: string; source_text: string | null; candidate_text: string | null }[] };
      checkView.append(row('Integration supported', data.integration_supported), row('Integration note', data.integration_note),
        row('Target changed since candidate creation', artifact.target_changed), row('Export truncated', artifact.truncated));
      for (const file of artifact.files) {
        const block = el('div', 'workbench-execution-diff');
        block.append(row('File', `${file.path} · candidate ${file.state} · source ${file.source_state}`),
          el('h4', '', 'Source (current original)'), el('pre', '', file.source_text ?? '(unavailable)'),
          el('h4', '', 'Candidate'), el('pre', '', file.candidate_text ?? '(binary)'));
        checkView.append(block);
      }
    }, false);
  });
  const submission = button('Submit owner-pasted patch', 'Record a proposed patch pasted by the owner, not agent-authored or verified', () => {
    const candidate = selectedCandidate(); if (!candidate) return;
    let files: unknown;
    try { files = JSON.parse(proposed.value); if (!Array.isArray(files) || !files.every(file => file && typeof file.path === 'string' && typeof file.content === 'string' && typeof file.base_hash === 'string')) throw Error('invalid_request'); }
    catch { report('Execution: invalid_request. Paste an array of {path, content, base_hash}.'); return; }
    void act('Recording owner-pasted proposal', { action: 'submission_create', task_id: candidate.task_id, candidate_id: candidate.id, files }, () => { proposed.value = ''; });
  });

  function renderPreviews() {
    previewView.replaceChildren(el('h3', '', 'Candidate preview'));
    if (candidatePreview) previewView.append(row('Digest', candidatePreview.digest), row('Base manifest hash', candidatePreview.base.manifest_hash),
      row('Files', candidatePreview.base.files.map(file => `${file.path} · ${file.hash} · ${file.bytes} bytes`).join('\n')),
      row('Exclusions', candidatePreview.base.exclusions), row('Limited', candidatePreview.base.limited), row('Total bytes', candidatePreview.base.total_bytes));
    checkView.replaceChildren(el('h3', '', 'Check preview'));
    if (checkPreview) checkView.append(row('Spec digest', checkPreview.spec_digest), row('Candidate hash', checkPreview.candidate_hash),
      row('Acceptance version', checkPreview.acceptance_version), row('Definition', checkPreview.definition_id),
      row('Definition hash', checkPreview.definition_hash), row('Executable', checkPreview.executable), row('Args', checkPreview.args),
      row('Limits', checkPreview.limits), row('Policy', checkPreview.policy), row('Operation ID', opId));
    controls();
  }
  function render() {
    const data = projection!;
    status.textContent = data.revoked ? 'Project access revoked. Outcomes are not verified.' : `Execution: ${data.execution} · Active checks: ${data.active_count}`;
    summary.replaceChildren(el('h3', '', 'Definitions and limits'), row('Policy', data.policy), row('Execution', data.execution), row('Revoked', data.revoked));
    for (const item of data.definitions) summary.append(row(item.id, { executable: item.executable, args: item.args, limits: item.limits, policy: item.policy }));
    const oldDefinition = definition.value, oldCheck = checkDefinition.value;
    choice(definition, data.definitions.map(item => ({ id: item.id, label: item.id })), oldDefinition);
    choice(checkDefinition, data.definitions.map(item => ({ id: item.id, label: item.id })), oldCheck);
    const oldTask = taskSelect.value;
    choice(taskSelect, data.tasks.map(item => ({ id: item.id, label: `${item.title} · ${item.status}` })), taskSelect.dataset.next || oldTask);
    delete taskSelect.dataset.next;
    taskView.replaceChildren(el('h3', '', 'Tasks'));
    for (const task of data.tasks) taskView.append(row(task.title, `status ${task.status} · acceptance v${task.acceptance_version} · digest ${task.acceptance_digest} · candidate ${task.candidate_id ?? 'none'} · latest verdict ${data.evidence.find(item => item.id === task.latest_evidence_id)?.verdict ?? 'none'}`));
    const oldCandidate = candidateSelect.dataset.next || candidateSelect.value;
    delete candidateSelect.dataset.next;
    choice(candidateSelect, data.candidates.map(item => ({ id: item.id, label: `${data.tasks.find(task => task.id === item.task_id)?.title ?? item.task_id} · ${item.id}` })), oldCandidate);
    const candidate = selectedCandidate();
    if (checkPreview && (!candidate || checkPreview.candidate_id !== candidate.id || checkPreview.candidate_hash !== candidate.hash)) { checkPreview = null; opId = ''; }
    candidateView.replaceChildren(el('h3', '', 'Candidate'), row('Identity', candidate?.id ?? 'none'));
    if (candidate) candidateView.append(row('Status', candidate.status), row('Generation', candidate.generation), row('Hash', candidate.hash), row('Base hash', candidate.base_hash), row('Source manifest', candidate.source_manifest_hash), row('Exclusions', candidate.exclusions), row('Limited', candidate.limited), row('Total bytes', candidate.total_bytes));
    fileList.replaceChildren();
    for (const file of candidate?.files ?? []) fileList.append(button(file.path, `Read candidate file ${file.path}`, () => void act('Reading candidate file',
      { action: 'candidate_read', candidate_id: candidate!.id, path: file.path }, reply => {
        const loaded = reply.file as { path: string; hash: string; bytes: number; text: string; binary: boolean };
        selectedFile = { candidate_id: candidate!.id, path: loaded.path, hash: loaded.hash, text: loaded.text, binary: loaded.binary };
        edit.value = loaded.binary ? '' : loaded.text;
        edit.readOnly = loaded.binary;
        dirty = false;
        expected.textContent = `Expected hash: ${loaded.hash}`;
        fileMeta.replaceChildren(row('Path', loaded.path), row('Hash', loaded.hash), row('Bytes', loaded.bytes), row('Binary', loaded.binary));
      }, false)), row('File', `${file.path} · ${file.hash} · ${file.bytes} bytes · ${file.state}`));
    if (selectedFile) {
      const latest = candidate?.id === selectedFile.candidate_id ? candidate.files.find(file => file.path === selectedFile?.path) : null;
      if (!latest) { selectedFile = null; if (!dirty && document.activeElement !== edit) edit.value = ''; expected.textContent = 'Expected hash: no file selected'; }
      else {
        expected.textContent = `Expected hash: ${selectedFile.hash}${latest.hash !== selectedFile.hash ? ' · stale (reload file before editing)' : ''}`;
        if (!dirty && document.activeElement !== edit) edit.value = selectedFile.binary ? '' : selectedFile.text;
      }
    }
    jobsView.replaceChildren(el('h3', '', 'Jobs and evidence'));
    for (const job of data.jobs.filter(item => !candidate || item.candidate_id === candidate.id)) {
      const item = el('div', 'workbench-execution-job');
      item.append(row('Job', `${job.id} · ${job.status} · pid ${job.pid ?? 'none'} · started ${job.started_at ?? 'none'} · ended ${job.ended_at ?? 'none'} · op ${job.op_id}`));
      if (job.outcome_note) item.append(row('Outcome', `${job.outcome_note} — not verified`));
      if (job.status === 'outcome_unknown') item.append(row('Outcome', 'Unknown — not verified'));
      if (args.onAskContext) item.append(button('Ask agent about this job', `Ask agent about job ${job.id}`, () => { if (pending) { report('Execution: busy.'); return; } args.onAskContext?.(job.id); }));
      if (job.status === 'starting' || job.status === 'running') item.append(button('Cancel check', `Cancel check job ${job.id}`, () => void act('Requesting cancellation',
        { action: 'check_cancel', job_id: job.id, expected_pid: job.pid, expected_started_at: job.process_start }, () => {})));
      if (job.status === 'cancel_requested') item.append(row('Cancellation', `Requested; not confirmed until the child exits. ${job.cancel_confirmed ? 'Confirmed.' : 'Not yet confirmed.'}`));
      if (data.unknown_jobs[job.id]) item.append(
        row('Acknowledge digest', data.unknown_jobs[job.id]),
        button('Acknowledge unknown outcome', `Acknowledge unknown outcome for job ${job.id}`, () => {
          if (pending) { report('Execution: busy.'); return; }
          void act('Acknowledging unknown outcome', { action: 'job_acknowledge', job_id: job.id, digest: data.unknown_jobs[job.id] }, () => {});
        }),
      );
      for (const evidence of data.evidence.filter(entry => entry.job_id === job.id)) {
        item.append(row('Evidence', `${evidence.id} · ${evidence.revoked || data.revoked ? 'revoked — not verified' : evidence.verdict} · exit ${evidence.exit_code ?? 'none'} · signal ${evidence.signal ?? 'none'} · ${evidence.started_at}–${evidence.ended_at}`),
          row('Artifact hash', evidence.artifact_hash), row('Definition hash', evidence.definition_hash), row('Candidate hash before / after', `${evidence.candidate_hash_before} / ${evidence.candidate_hash_after}`),
          row('Superseded', evidence.superseded), el('pre', '', evidence.stdout_preview), el('pre', '', evidence.stderr_preview));
      }
      jobsView.append(item);
    }
    reviewView.replaceChildren(el('h3', '', 'Owner review'), el('p', '', 'Acceptance records the owner decision only; it is not a merge, deployment or overwrite. Agent tool gate is blocked until a sound runtime binding exists.'));
    if (candidate) {
      const targetChanged = data.target_changed[candidate.id] === true;
      reviewView.append(row('Expected review identity', data.review_identity[candidate.id] ?? 'unavailable'),
        row('Source target', targetChanged ? 'changed since candidate creation — a fresh candidate and review are required; approval is refused' : 'unchanged'));
      for (const evidence of data.evidence.filter(item => item.candidate_id === candidate.id && item.verdict === 'pass' && !item.superseded && !item.revoked && !data.revoked)) {
        const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedEvidence.has(evidence.id);
        checkbox.addEventListener('change', () => { if (checkbox.checked) selectedEvidence.add(evidence.id); else selectedEvidence.delete(evidence.id); });
        reviewView.append(labelled(`Passing evidence ${evidence.id}`, checkbox));
      }
      for (const review of data.reviews.filter(item => item.candidate_id === candidate.id)) reviewView.append(row('Review', `${review.decision} · ${review.id} · ${review.created_at}`));
      for (const decision of ['approved', 'rejected'] as const) {
        const node = button(decision === 'approved' ? 'Approve' : 'Reject', `Record owner ${decision} review`, () => {
          if (pending) { report('Execution: busy.'); return; }
          const evidence_ids = data.evidence.filter(item => item.candidate_id === candidate.id && item.verdict === 'pass' && !item.superseded && !item.revoked && selectedEvidence.has(item.id)).map(item => item.id);
          void act('Recording review', { action: 'review_decide', candidate_id: candidate.id, evidence_ids, decision, expected_identity: data.review_identity[candidate.id] }, () => { selectedEvidence.clear(); });
        });
        if (decision === 'approved' && targetChanged) node.disabled = true;
        reviewView.append(node);
      }
    }
    renderPreviews(); controls();
  }
  for (const control of [title, acceptance, profile, session, proposed]) control.addEventListener('input', controls);
  edit.addEventListener('input', () => { dirty = true; controls(); });
  definition.addEventListener('change', controls);
  checkDefinition.addEventListener('change', () => { checkPreview = null; opId = ''; renderPreviews(); });
  taskSelect.addEventListener('change', resetPreview);
  candidateSelect.addEventListener('change', () => { selectedFile = null; dirty = false; edit.value = ''; expected.textContent = 'Expected hash: no file selected'; selectedEvidence.clear(); resetPreview(); render(); });
  args.container.replaceChildren(el('h2', '', 'Execution workbench'), status, error, summary,
    el('h3', '', 'Create task'), labelled('Title', title), labelled('Acceptance statement', acceptance), labelled('Check definition', definition),
    labelled('Profile ID', profile), labelled('Session ID', session), createTask, taskView,
    labelled('Task', taskSelect), previewCandidate, previewView, createCandidate,
    labelled('Candidate', candidateSelect), candidateView, fileList, fileMeta, exportCandidate, expected, edit, saveEdit,
    labelled('Check definition', checkDefinition), previewCheck, checkView, runCheck, jobsView, reviewView,
    el('h3', '', 'Owner-pasted proposed patch'), submissionNote, proposed, submission);
  controls();
  void refresh();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true; invalidate();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      args.container.replaceChildren();
    },
  };
}
