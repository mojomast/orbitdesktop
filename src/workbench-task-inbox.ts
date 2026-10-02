import { button, el } from './dom';

type Data = Record<string, any>;

// Embedded in the existing task chooser. Reads and acknowledgments never grant
// execution, acceptance or publication authority.
export function createWorkbenchTaskInbox(deps: { workspaceId: string; projectId: () => string | null; getToken: () => string; open: (taskId: string, view: string, candidateId: string | null) => void }) {
  const element = el('details', 'pane-workbench-inbox'); element.setAttribute('aria-label', 'Task status inbox');
  const summary = el('summary', '', 'Task status inbox');
  const status = el('p', '', 'Choose a project to read authoritative task status.'); status.setAttribute('role', 'status');
  const rows = el('div');
  const capacity = el('details'); capacity.append(el('summary', '', 'Record capacity'));
  const refreshButton = button('Refresh task inbox', 'Read current authoritative task records; never execute work', () => void refresh(), 'small-button');
  element.append(summary, refreshButton, status, rows, capacity);
  let disposed = false, epoch = 0, controller: AbortController | null = null;
  const current = (ticket: number, project: string, token: string) => !disposed && epoch === ticket && deps.projectId() === project && deps.getToken() === token;
  async function request(body: Data, project: string, token: string, signal: AbortSignal) {
    const response = await fetch('/api/workbench/workflow', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: deps.workspaceId, project_id: project, ...body }), signal });
    const data = await response.json(); if (!response.ok || data.ok !== true) throw Error(data.code === 'stale_resource' ? 'Task status changed. Refresh the inbox before acknowledging.' : 'Task inbox unavailable. Refresh after reconnecting.'); return data;
  }
  async function refresh() {
    const ticket = ++epoch, project = deps.projectId(), token = deps.getToken(); controller?.abort(); controller = new AbortController();
    rows.replaceChildren(); capacity.replaceChildren(el('summary', '', 'Record capacity')); summary.textContent = 'Task status inbox';
    if (!project || !token || disposed) { status.textContent = 'Choose a connected project to read task status.'; return; }
    const signal = controller.signal; refreshButton.disabled = true; status.textContent = 'Reading authoritative task snapshot…';
    try {
      const [snapshot, inventory] = await Promise.all([request({ action: 'task_status_snapshot' }, project, token, signal), request({ action: 'retention_inventory' }, project, token, signal)]);
      if (!current(ticket, project, token)) return;
      const items: Data[] = snapshot.items ?? [];
      summary.textContent = `Task status inbox · ${items.filter(item => !item.read).length} unread / ${items.length} tasks`;
      status.textContent = 'Current authoritative snapshot. Completion means observed runtime exit, not verified checks or human approval. Missed trace events are not backfilled.';
      for (const item of items) {
        const row = el('article', 'workbench-setup-suggestion'); row.dataset.taskId = item.task_id;
        row.append(el('strong', '', String(item.task?.title || item.task_id)), el('p', '', `${String(item.category).replaceAll('_', ' ')} · ${item.read ? 'read' : 'unread'} · last recorded ${new Date(item.last_authoritative_observation).toLocaleString()}`));
        row.append(el('p', '', `Result: ${(item.results ?? []).map((r: Data) => String(r.availability).replaceAll('_', ' ')).join(', ') || 'none recorded'}. Recorded checks: ${item.check_acceptance === null ? 'not assessed' : item.check_acceptance?.complete === true ? 'required evidence complete; inspect current source' : 'required evidence incomplete'}. Review: ${(item.reviews ?? []).map((r: Data) => r.decision).join(', ') || 'none'}. Publication: ${(item.integrations ?? []).map((r: Data) => r.status).join(', ') || 'none'}.`));
        const exact = el('details'); exact.append(el('summary', '', 'Runtime and recorded evidence'), el('pre', '', JSON.stringify({ jobs: item.jobs, grants: item.grants, evidence: item.evidence }, null, 2))); row.append(exact);
        for (const view of ['live', 'checks', 'result']) row.append(button(`Open ${view}`, `Inspect ${view} for ${item.task?.title || item.task_id}`, () => { if (current(ticket, project, token)) deps.open(item.task_id, view, item.task?.candidate_id ?? null); }, 'small-button'));
        const read = button('Mark status read', 'Acknowledge only this exact status; this is not approval', () => {
          if (!current(ticket, project, token)) return; read.disabled = true;
          void request({ action: 'task_status_read', task_id: item.task_id, expected_notification_id: item.notification_id }, project, token, signal).then(() => { if (current(ticket, project, token)) void refresh(); }).catch(reason => { if (current(ticket, project, token)) { status.textContent = reason.message; read.disabled = false; } });
        }, 'small-button'); read.disabled = item.read === true; row.append(read); rows.append(row);
      }
      if (!items.length) rows.append(el('p', '', 'No saved tasks in this project.'));
      for (const [kind, value] of Object.entries(inventory.capacity ?? {}) as [string, Data][]) capacity.append(el('p', '', `${kind}: ${value.remaining} slots remaining · ${value.active} active / ${value.limit} · ${value.archived} archived · ${value.retained} retained`));
    } catch (reason) { if (current(ticket, project, token)) status.textContent = reason instanceof Error ? reason.message : 'Task inbox unavailable'; }
    finally { if (!disposed && epoch === ticket) refreshButton.disabled = false; }
  }
  return { element, refresh, dispose() { disposed = true; epoch++; controller?.abort(); element.remove(); } };
}
