import { button, el } from './dom';
import { validChat } from './chat-storage';

type Recipient = { pane_id: string; profile_id: string; session_id: string };
type Data = Record<string, unknown>;
type Attempt = { id: string; task_id?: string | null; recipient?: Partial<Recipient> | null };
const codes = new Set(['invalid_request', 'permission_denied', 'expired', 'stale_resource', 'unsupported', 'unavailable', 'limit_exceeded', 'busy']);
const asRecord = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const asText = (value: unknown): string => typeof value === 'string' ? value : '';
const display = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const row = (name: string, value: unknown) => el('p', '', `${name}: ${display(value)}`);
const gatewayNotice = 'Owner-configured Hermes gateway. The gateway may route to any provider configured on it; Orbit does not promise a fixed provider or model.';
function capturedAt(value: unknown): string {
  const date = new Date(typeof value === 'number' ? value : asText(value));
  if (!Number.isFinite(date.getTime())) return 'unavailable';
  const age = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const relative = age < 60 ? `${age} seconds ago` : age < 3600 ? `${Math.floor(age / 60)} minutes ago` : age < 86400 ? `${Math.floor(age / 3600)} hours ago` : `${Math.floor(age / 86400)} days ago`;
  return `${date.toISOString()} (${relative})`;
}

export function showWorkbenchContext(args: {
  token: (() => string) | string;
  workspace_id: string;
  project_id: string;
  source:
    | { kind: 'file'; resource_id: string; start_line: number; end_line: number; expected_hash: string }
    | { kind: 'diff'; expected_hash: string }
    | { kind: 'job'; job_id: string }
    | { kind: 'terminal'; resource_id: string; lease_id: string };
}): void {
  const existing = document.querySelector<HTMLDialogElement>('dialog.workbench-context-dialog');
  if (existing?.open) { existing.focus(); return; }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = el('dialog', 'workbench-context-dialog');
  dialog.setAttribute('aria-label', 'Share project context with agent');
  const status = el('p', 'workbench-context-status', 'Choose an agent recipient, then capture context.');
  status.setAttribute('role', 'status');
  const error = el('p', 'workbench-context-error');
  error.setAttribute('role', 'alert');
  const recipients = el('select');
  recipients.setAttribute('aria-label', 'Agent recipient');
  const attempts = el('select');
  attempts.setAttribute('aria-label', 'Task/attempt link');
  const listedAttempts: Attempt[] = [];
  const details = el('section', 'workbench-context-details');
  const text = el('textarea', 'workbench-context-text');
  text.readOnly = true;
  text.rows = 16;
  text.cols = 90;
  text.setAttribute('aria-label', 'Exact context preview text (read-only)');
  const warning = el('p', 'workbench-context-warning', 'Trusted host, not a sandbox. Sharing sends these exact bytes to the selected agent recipient.');
  warning.style.fontWeight = 'bold';
  const destinationNotice = el('p', 'workbench-context-destination', gatewayNotice);
  destinationNotice.hidden = true;
  const approvalNote = el('p', 'workbench-context-approval');
  const outcome = el('p', 'workbench-context-outcome');
  outcome.setAttribute('role', 'status');
  const responseLabel = el('label', '', 'Agent response (read-only)');
  const responseText = el('textarea', 'workbench-context-response');
  responseText.readOnly = true;
  responseText.rows = 12;
  responseText.cols = 90;
  responseLabel.append(responseText);
  responseLabel.hidden = true;
  const withheld = el('p', 'workbench-context-withheld', 'Agent output is withheld because this project is no longer active (revoked). No output was released.');
  withheld.hidden = true;
  const outputTruncated = el('p', 'workbench-context-truncated', 'Agent response was truncated at the 256 KiB display limit; only the truncated text is shown or copied.');
  outputTruncated.hidden = true;
  let pending = false;
  let closed = false;
  let contextId = '';
  let previewId = '';
  let approvalId = '';
  let disclosureId = '';
  let shared = false;
  let unknown = false;
  let recipient: Recipient | null = null;
  let runId = '';
  let attemptId = '';

  function refreshAttempts() {
    const selected = asRecord((() => { try { return JSON.parse(recipients.value); } catch { return null; } })());
    attempts.replaceChildren();
    const none = el('option', '', 'No task link');
    none.value = '';
    attempts.append(none);
    for (const attempt of listedAttempts) {
      const target = asRecord(attempt.recipient);
      if (!selected.pane_id || target.pane_id !== selected.pane_id ||
        (target.profile_id != null && target.profile_id !== selected.profile_id) ||
        (target.session_id != null && target.session_id !== selected.session_id)) continue;
      const option = el('option', '', attempt.task_id || attempt.id);
      option.value = attempt.id;
      attempts.append(option);
    }
    attemptId = '';
  }
  function showOutput(data: Data) {
    const output = asText(data.output);
    const released = data.output_released !== false;
    responseText.value = released ? output : '';
    responseLabel.hidden = !released || !output;
    copyResponse.hidden = responseLabel.hidden;
    withheld.hidden = data.output_released !== false;
    outputTruncated.hidden = !(released && data.output_truncated === true && !!output);
  }

  const ownerToken = (): string => typeof args.token === 'function' ? args.token() : args.token;
  async function api(body: Data): Promise<Data> {
    const owner = ownerToken();
    if (!owner) throw Error('permission_denied');
    const response = await fetch('/api/workbench/context', {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, workspace_id: args.workspace_id, project_id: args.project_id }),
      signal: AbortSignal.timeout(15000),
    });
    const data = asRecord(await response.json());
    if (!response.ok || data.ok !== true) throw Error(codes.has(asText(data.code)) ? asText(data.code) : 'unavailable');
    return data;
  }
  function controls() {
    recipients.disabled = pending || !!contextId || shared;
    attempts.disabled = pending || !!contextId || shared || !recipients.value;
    capture.disabled = pending || !!contextId || shared || !recipients.value;
    discard.disabled = pending || !contextId || shared;
    preview.disabled = pending || !contextId || !!previewId || !recipients.value || shared;
    approve.disabled = pending || !previewId || !!approvalId || shared;
    share.disabled = pending || !approvalId || shared || unknown;
    reconcile.disabled = pending || !unknown;
    check.disabled = pending || !disclosureId;
    stop.disabled = pending || !disclosureId || !runId;
  }
  async function run(task: () => Promise<void>, ambiguousShare = false) {
    if (pending || closed) return;
    pending = true; error.textContent = ''; controls();
    try { await task(); }
    catch (reason) {
      if (closed) return;
      const code = reason instanceof Error && codes.has(reason.message) ? reason.message : 'unavailable';
      error.textContent = `Context sharing: ${code.replaceAll('_', ' ')}. ${code === 'expired' || code === 'stale_resource' ? 'Capture and review fresh context before sharing.' : ''}`;
      if (ambiguousShare) {
        shared = true; unknown = true;
        outcome.textContent = 'Submission outcome unknown. It may have reached the agent. It will NOT be retried automatically. Use Check status or Reconcile separately; do not send again.';
      }
    } finally { pending = false; if (!closed) controls(); }
  }
  const capture = button('Capture context', 'Capture bounded project context metadata only', () => void run(async () => {
    const data = await api({ action: 'capture', source: args.source, ...(attemptId ? { attempt_id: attemptId } : {}) });
    contextId = asText(asRecord(data.context).id);
    if (!contextId) throw Error('unavailable');
    status.textContent = 'Context metadata captured. No text displayed yet. Select a recipient and preview explicitly.';
  }));
  const discard = button('Discard context and choose again', 'Discard the current reviewed source and capture a fresh one', () => {
    if (pending || shared) return;
    contextId = ''; previewId = ''; approvalId = ''; recipient = null; attemptId = '';
    text.value = ''; details.replaceChildren(); approvalNote.textContent = '';
    destinationNotice.hidden = true;
    attempts.value = '';
    status.textContent = 'Context discarded. Choose a recipient and task link, then capture context again.';
    error.textContent = '';
    controls();
  });
  const preview = button('Preview for selected recipient', 'Preview exact context bytes for the selected agent recipient', () => void run(async () => {
    recipient = JSON.parse(recipients.value) as Recipient;
    const data = await api({ action: 'preview', context_id: contextId, recipient });
    previewId = asText(data.preview_id);
    if (!previewId || typeof data.text !== 'string' || data.trusted_host !== true || data.sandbox !== false) throw Error('unavailable');
    text.value = data.text;
    details.replaceChildren(
      row('Recipient', data.recipient ?? recipient), row('Hash', data.hash), row('Digest', data.digest),
      row('Captured at', capturedAt(data.captured_at)), row('Source', data.source),
      row('Included references (identifiers sent to the agent; not authority)', data.references), row('Destination', data.destination),
      row('Policy', data.policy), row('Bytes', data.bytes), row('Lines', data.lines),
      row('Truncated', data.truncated === true ? 'yes' : 'no'), row('Exclusions', data.exclusions),
      row('Preview expires', data.expires_at), row('Trusted host', data.trusted_host), row('Sandbox', data.sandbox),
    );
    destinationNotice.hidden = false;
    status.textContent = 'Review the exact preview text and recipient before approval.';
  }));
  const approve = button('Approve', 'Approve this exact preview once with an expiring approval', () => void run(async () => {
    const data = await api({ action: 'approve', preview_id: previewId });
    approvalId = asText(data.approval_id);
    if (!approvalId) throw Error('unavailable');
    approvalNote.textContent = `Single-use, expiring approval. Digest: ${display(data.digest)} · Policy: ${display(data.policy)} · Expires: ${display(data.expires_at)}. Share once only after reviewing the exact bytes.`;
    status.textContent = 'Approved once. Sharing still requires a separate owner action.';
  }));
  const share = button('Share once', 'Send the approved exact context bytes to this agent recipient once', () => void run(async () => {
    // Fence double-clicks and ambiguous transport failures before dispatch.
    shared = true; controls();
    const data = await api({ action: 'share', preview_id: previewId, approval_id: approvalId, ...(attemptId ? { attempt_id: attemptId } : {}) });
    disclosureId = asText(asRecord(data.disclosure).id);
    runId = asText(data.run_id) || asText(asRecord(data.submission).run_id);
    unknown = data.state === 'submission_unknown';
    outcome.textContent = unknown
      ? 'Submission outcome unknown. It may have reached the agent. It will NOT be retried automatically. Use Check status or Reconcile separately; do not send again.'
      : `Shared once. Agent run ID: ${runId || 'unavailable'}. Jobs are not cancelled by stopping this agent run.`;
    if ('output' in data || 'output_released' in data) showOutput(data);
  }, true));
  const check = button('Check status', 'Check status of this disclosure without sending context again', () => void run(async () => {
    const data = await api({ action: 'status', disclosure_id: disclosureId });
    runId = asText(asRecord(data.submission).run_id) || runId;
    outcome.textContent = `Disclosure status: ${display(asRecord(data.submission).state ?? asRecord(data.disclosure).state)} · Run ID: ${runId || 'unknown'}. No context was re-sent.`;
    showOutput(data);
  }));
  const reconcile = button('Reconcile', 'Reconcile unknown submissions without resending context', () => void run(async () => {
    const data = await api({ action: 'reconcile' });
    outcome.textContent = `Reconciliation: ${display(data.state ?? data.submissions ?? data.disclosures ?? 'requested')}. No context was re-sent.`;
  }));
  const stop = button('Stop agent run (jobs are not cancelled)', 'Stop only the agent run; jobs are not cancelled', () => void run(async () => {
    const data = await api({ action: 'stop', disclosure_id: disclosureId });
    if (data.stop_requested !== true) throw Error('unavailable');
    outcome.textContent = `Stop requested for agent run ${runId}. Jobs are not cancelled.`;
    runId = '';
  }));
  const copyResponse = button('Copy response', 'Copy the agent response as plain text', () => {
    const copy = async () => {
      try {
        if (!navigator.clipboard) throw Error('clipboard unavailable');
        await navigator.clipboard.writeText(responseText.value);
      } catch {
        responseText.focus(); responseText.select();
      }
    };
    void copy();
  });
  copyResponse.hidden = true;
  const close = button('Close', 'Close context sharing dialog', () => dialog.close());
  recipients.addEventListener('change', () => { refreshAttempts(); controls(); });
  attempts.addEventListener('change', () => { attemptId = attempts.value; });
  dialog.append(el('h2', '', 'Share project context'), status, error, recipients, attempts, capture, discard, preview,
    warning, destinationNotice, details, text, approve, approvalNote, share, outcome, responseLabel, copyResponse, outputTruncated, withheld, check, reconcile, stop, close);
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('close', () => { closed = true; dialog.remove(); previousFocus?.focus(); }, { once: true });
  document.body.append(dialog); dialog.showModal(); controls(); close.focus();
  void run(async () => {
    // List context history separately; recipient choices are current agent surfaces and browser-held bindings.
    const list = await api({ action: 'list' });
    for (const entry of Array.isArray(list.attempts) ? list.attempts : []) {
      const attempt = asRecord(entry);
      if (typeof attempt.id === 'string') listedAttempts.push({ id: attempt.id, task_id: asText(attempt.task_id) || null, recipient: asRecord(attempt.recipient) });
    }
    const response = await fetch('/api/workbench', {
      method: 'POST', headers: { Authorization: `Bearer ${ownerToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', workspace_id: args.workspace_id }), signal: AbortSignal.timeout(15000),
    });
    const data = asRecord(await response.json());
    if (!response.ok || data.ok !== true) throw Error('unavailable');
    for (const surface of Array.isArray(data.surfaces) ? data.surfaces : []) {
      const pane = asRecord(surface);
      if (pane.kind !== 'agent' || typeof pane.pane_id !== 'string') continue;
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${pane.pane_id}`) || 'null');
        if (!validChat(saved)) continue;
        const recipient: Recipient = { pane_id: pane.pane_id, profile_id: saved.profile_id ?? 'default', session_id: saved.session };
        const option = el('option', '', `${asText(pane.name) || pane.pane_id} · ${recipient.profile_id} · ${recipient.session_id} · ${recipient.pane_id}`);
        option.value = JSON.stringify(recipient);
        recipients.append(option);
      } catch { /* Invalid browser chat state is not a selectable recipient. */ }
    }
    refreshAttempts();
    if (!recipients.length) status.textContent = 'No active agent pane with a valid conversation binding is available.';
    else status.textContent = 'Choose an agent recipient and explicitly capture context metadata.';
  });
}

/**
 * Owner-only disclosure/activity view. It never captures or shares new context and
 * does not require an active (non-revoked) project: metadata, reconcile and stopping
 * an already-created agent run remain available. Private agent output is shown only
 * when the server reports it was released (active project).
 */
export function showWorkbenchActivity(args: { token: (() => string) | string; workspace_id: string; project_id: string }): void {
  const existing = document.querySelector<HTMLDialogElement>('dialog.workbench-activity-dialog');
  if (existing?.open) { existing.focus(); return; }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = el('dialog', 'workbench-activity-dialog');
  dialog.setAttribute('aria-label', 'Project context activity and disclosures');
  const status = el('p', 'workbench-context-status', 'Loading disclosures…');
  status.setAttribute('role', 'status');
  const error = el('p', 'workbench-context-error');
  error.setAttribute('role', 'alert');
  const notice = el('p', 'workbench-context-warning', 'This view shows disclosure metadata and can stop an agent run. It does not capture or share any context. Jobs are never cancelled here. Revocation does not hide metadata or prevent stopping.');
  const disclosures = el('select');
  disclosures.setAttribute('aria-label', 'Disclosure');
  const details = el('section', 'workbench-context-details');
  const responseLabel = el('label', '', 'Agent response (read-only)');
  const responseText = el('textarea', 'workbench-context-response');
  responseText.readOnly = true; responseText.rows = 12; responseText.cols = 90;
  responseLabel.append(responseText); responseLabel.hidden = true;
  const withheld = el('p', 'workbench-context-withheld', 'Agent output is withheld because this project is no longer active (revoked). No output was released.');
  withheld.hidden = true;
  const outputTruncated = el('p', 'workbench-context-truncated', 'Agent response was truncated at the 256 KiB display limit; only the truncated text is shown or copied.');
  outputTruncated.hidden = true;
  const copyResponse = button('Copy response', 'Copy the agent response as plain text', () => {
    const copy = async () => { try { if (!navigator.clipboard) throw Error('clipboard'); await navigator.clipboard.writeText(responseText.value); } catch { responseText.focus(); responseText.select(); } };
    void copy();
  });
  copyResponse.hidden = true;
  let pending = false, closed = false, runId = '', currentId = '';
  const ownerToken = (): string => typeof args.token === 'function' ? args.token() : args.token;
  async function api(body: Data): Promise<Data> {
    const owner = ownerToken();
    if (!owner) throw Error('permission_denied');
    const response = await fetch('/api/workbench/context', {
      method: 'POST', headers: { Authorization: `Bearer ${owner}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, workspace_id: args.workspace_id, project_id: args.project_id }),
      signal: AbortSignal.timeout(15000),
    });
    const data = asRecord(await response.json());
    if (!response.ok || data.ok !== true) throw Error(codes.has(asText(data.code)) ? asText(data.code) : 'unavailable');
    return data;
  }
  function controls() { disclosures.disabled = pending || !disclosures.length; check.disabled = pending || !currentId; stop.disabled = pending || !currentId || !runId; reconcile.disabled = pending; }
  async function run(task: () => Promise<void>) {
    if (pending || closed) return;
    pending = true; error.textContent = ''; controls();
    try { await task(); }
    catch (reason) { if (!closed) error.textContent = `Context activity: ${reason instanceof Error && codes.has(reason.message) ? reason.message.replaceAll('_', ' ') : 'unavailable'}.`; }
    finally { pending = false; if (!closed) controls(); }
  }
  function showOutput(data: Data) {
    const output = asText(data.output);
    const released = data.output_released !== false;
    responseText.value = released ? output : '';
    responseLabel.hidden = !released || !output;
    copyResponse.hidden = responseLabel.hidden;
    withheld.hidden = released;
    outputTruncated.hidden = !(released && data.output_truncated === true && !!output);
  }
  const check = button('Check status', 'Check the selected disclosure status without sending context again', () => void run(async () => {
    const data = await api({ action: 'status', disclosure_id: currentId });
    runId = asText(asRecord(data.submission).run_id) || '';
    details.replaceChildren(row('Disclosure', data.disclosure), row('Submission', asRecord(data.submission)), row('Run ID', runId || 'unknown'));
    status.textContent = `Disclosure status: ${display(asRecord(data.submission).state ?? asRecord(data.disclosure).state)}. No context was sent.`;
    showOutput(data);
  }));
  const reconcile = button('Reconcile', 'Reconcile unresolved submissions without resending context', () => void run(async () => {
    const data = await api({ action: 'reconcile' });
    status.textContent = `Reconciled ${display(data.reconciled)}; unresolved ${display(Array.isArray(data.unresolved) ? data.unresolved.length : 0)}. No context was sent.`;
  }));
  const stop = button('Stop agent run (jobs are not cancelled)', 'Stop only the agent run; jobs are not cancelled', () => void run(async () => {
    if (!currentId) return;
    const data = await api({ action: 'stop', disclosure_id: currentId });
    if (data.stop_requested !== true) throw Error('unavailable');
    status.textContent = `Stop requested for agent run ${runId || 'unknown'}. Jobs are not cancelled.`;
    runId = '';
  }));
  const close = button('Close', 'Close activity view', () => dialog.close());
  disclosures.addEventListener('change', () => { currentId = disclosures.value; runId = ''; check.disabled = !currentId; stop.disabled = true; void run(async () => { const data = await api({ action: 'status', disclosure_id: currentId }); runId = asText(asRecord(data.submission).run_id) || ''; details.replaceChildren(row('Disclosure', data.disclosure), row('Submission', asRecord(data.submission)), row('Run ID', runId || 'unknown')); showOutput(data); }); });
  dialog.append(el('h2', '', 'Context activity and disclosures'), status, error, notice, disclosures, check, reconcile, stop, details, responseLabel, copyResponse, outputTruncated, withheld, close);
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('close', () => { closed = true; dialog.remove(); previousFocus?.focus(); }, { once: true });
  document.body.append(dialog); dialog.showModal(); close.focus();
  void run(async () => {
    const list = await api({ action: 'list' });
    const rows = Array.isArray(list.disclosures) ? list.disclosures : [];
    for (const entry of rows) {
      const record = asRecord(entry);
      const option = el('option', '', `${asText(record.state) || 'disclosure'} · ${asText(record.run_id) || asText(record.id)}`);
      option.value = asText(record.id);
      disclosures.append(option);
    }
    if (!rows.length) status.textContent = 'No disclosures exist for this project.';
    else { currentId = disclosures.value; status.textContent = 'Select a disclosure to inspect its status. No context is sent.'; void run(async () => { const data = await api({ action: 'status', disclosure_id: currentId }); runId = asText(asRecord(data.submission).run_id) || ''; details.replaceChildren(row('Disclosure', data.disclosure), row('Submission', asRecord(data.submission)), row('Run ID', runId || 'unknown')); showOutput(data); }); }
  });
  controls();
}

(globalThis as any).__orbitShowWorkbenchContext = showWorkbenchContext;
(globalThis as any).__orbitShowWorkbenchActivity = showWorkbenchActivity;
