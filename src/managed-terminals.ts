import './managed-terminals.css';
import { button, el, select } from './dom';
import { workspaceId } from './workspace-sync';
import { workspaceFetch } from './workspace-client';

type Lease = { lease_id: string; scope: 'observe' | 'input'; pane_id: string; state: string; expires_at: number };
type ResponseData = Record<string, unknown>;
type SendReceipt = Readonly<{ operationId: string; workspaceId: string; leaseId: string; baseRevision: number; text: string; confirmNewline: boolean }>;
const MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT = 'does not kill shell; next explicit Connect may create a NEW shell if missing';
const errors = new Set(['invalid_request', 'request_too_large', 'confirmation_required', 'unauthorized', 'not_found', 'conflict', 'pending', 'identity_changed', 'unavailable', 'revoked', 'expired', 'busy', 'timeout', 'provider_error', 'journal_full']);
const label = (text: string, control: HTMLElement) => { const node = el('label', 'managed-field'); node.append(el('span', '', text), control); return node; };

export function mountManagedTerminalControls(bar: HTMLElement, paneId: string, getToken: () => string): { dispose(): void } {
  let dialog: HTMLDialogElement | null = null;
  let disposed = false;
  let receipt: SendReceipt | null = null;
  const open = button('Managed…', 'Manage this terminal with explicit owner consent', () => show(), 'small-button');
  bar.append(open);

  function show() {
    if (disposed || dialog) return;
    const modal = el('dialog', 'managed-dialog');
    modal.setAttribute('aria-label', 'Managed terminal controls');
    dialog = modal;
    let lease: Lease | null = null;
    let pending = false;
    let sequence = 0;
    const warning = el('p', 'managed-pending'); warning.setAttribute('role', 'status');
    const refreshReceipt = () => {
      warning.hidden = !receipt;
      warning.textContent = receipt ? `Outcome unknown · Operation ID: ${receipt.operationId}. Retry with the same id/text using Send literal text; edited input is ignored.` : '';
    };
    refreshReceipt();
    const status = el('p', 'managed-status', 'Select Reconcile to check this pane. No output has been read.');
    status.setAttribute('role', 'status');
    const error = el('p', 'managed-error'); error.setAttribute('role', 'alert');
    const output = el('textarea', 'managed-output') as HTMLTextAreaElement;
    output.readOnly = true; output.setAttribute('aria-label', 'Untrusted terminal output (read-only)');
    output.placeholder = 'No output read. Read output once requires an active observe lease.';
    const scope = select([['observe', 'Observe (one-shot reads)'], ['input', 'Input (literal text)']], 'observe', () => {});
    scope.setAttribute('aria-label', 'Lease scope');
    const input = el('textarea', 'managed-input') as HTMLTextAreaElement;
    input.maxLength = 4096; input.setAttribute('aria-label', 'Literal text to send');
    const confirmed = el('input') as HTMLInputElement; confirmed.type = 'checkbox';
    confirmed.setAttribute('aria-label', 'Confirm this input action');
    const newline = el('input') as HTMLInputElement; newline.type = 'checkbox';
    newline.setAttribute('aria-label', 'Acknowledge newline may execute commands');
    const operation = el('p', 'managed-operation'); operation.setAttribute('role', 'status');
    const clear = () => { output.value = ''; error.textContent = ''; operation.textContent = ''; };
    const controls = el('div', 'managed-actions');
    const reconcile = button('Reconcile', 'Inspect managed terminal identity without reading output', () => void run(async started => {
      const data = await api({ action: 'reconcile', workspace_id: workspaceId }, started);
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const entry = entries.find(value => typeof value === 'object' && value !== null && (value as Record<string, unknown>).pane_id === paneId) as Record<string, unknown> | undefined;
      status.textContent = `Pane: ${typeof entry?.status === 'string' ? entry.status : 'unmanaged'}`;
      if (entry?.status === 'identity_changed' || entry?.status === 'missing' || entry?.status === 'requires_consent') { lease = null; clear(); }
    }));
    const adopt = button('Adopt…', 'Explicitly confirm adoption of this existing shell', () => {
      if (!window.confirm('Adopt this existing terminal for managed actions? Its identity will be checked. No output is read or input sent.')) return;
      void run(async started => {
        const data = await api({ action: 'adopt', workspace_id: workspaceId, pane_id: paneId, consent: true, base_revision: await revision() }, started);
        const resource = data.resource as Record<string, unknown> | undefined;
        status.textContent = `Pane: ${typeof resource?.status === 'string' && resource.status === 'adopted' ? 'managed' : (typeof resource?.status === 'string' ? resource.status : 'managed')}`;
      });
    });
    const grant = button('Grant lease', 'Explicitly grant a finite lease for the selected scope', () => void run(async started => {
      const data = await api({ action: 'grant', workspace_id: workspaceId, pane_id: paneId, scope: scope.value, consent: true, base_revision: await revision() }, started);
      const value = data.lease as Record<string, unknown> | undefined;
      if (!value || typeof value.lease_id !== 'string' || value.pane_id !== paneId || (value.scope !== 'observe' && value.scope !== 'input')) throw Error('invalid_request');
      lease = value as Lease; clear(); status.textContent = `Active ${lease.scope} lease · expires ${new Date(lease.expires_at).toLocaleString()}`;
    }));
    const revoke = button('Revoke lease', 'Revoke the current managed terminal lease', () => void (async () => {
      const started = ++sequence;
      // Also cancel a first grant waiting on its revision read, when there is
      // no previous lease to revoke yet.
      if (!lease) { status.textContent = 'Pending action cancelled. No local lease is active.'; return; }
      const id = lease.lease_id;
      lease = null; clear(); status.textContent = 'Lease unavailable. Revocation pending.';
      try { await api({ action: 'revoke', lease_id: id }, started); status.textContent = 'Lease revoked.'; }
      catch { if (disposed || dialog !== modal || started !== sequence) return; error.textContent = 'Revocation was not confirmed. The lease may remain active until expiry.'; }
    })());
    const release = button('Release…', 'Explicit owner-consented release of managed terminal continuity', () => {
      if (!window.confirm(`Release this managed terminal? ${MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT}`)) return;
      void run(async started => {
        const data = await api({ action: 'release', workspace_id: workspaceId, pane_id: paneId, base_revision: await revision(), consent: true, acknowledge: MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT }, started);
        lease = null; clear(); status.textContent = `Released (${data.mode})`;
      });
    });
    const observe = button('Read output once', 'Explicitly read bounded untrusted output with an observe lease', () => void run(async started => {
      if (!lease || lease.scope !== 'observe' || lease.state !== 'active') throw Error('not_found');
      const data = await api({ action: 'observe', workspace_id: workspaceId, lease_id: lease.lease_id, base_revision: await revision() }, started);
      output.value = typeof data.text === 'string' ? data.text.slice(0, 65536) : '';
      status.textContent = `One-shot output read · ${typeof data.bytes === 'number' ? data.bytes : 0} bytes`;
    }));
    const send = button('Send literal text', 'Send confirmed literal text with an input lease', () => void run(async started => {
      if (!receipt) {
        if (!lease || lease.scope !== 'input' || lease.state !== 'active') throw Error('not_found');
        if (!confirmed.checked || (input.value.includes('\n') && !newline.checked)) throw Error('confirmation_required');
        const payload = { operationId: crypto.randomUUID(), workspaceId, leaseId: lease.lease_id, text: input.value, confirmNewline: newline.checked };
        const baseRevision = await revision();
        checkCurrent(started);
        receipt = Object.freeze({ ...payload, baseRevision });
      }
      const sent = receipt;
      refreshReceipt();
      let data: ResponseData;
      try {
        data = await api({ action: 'input', workspace_id: sent.workspaceId, lease_id: sent.leaseId, base_revision: sent.baseRevision, text: sent.text, confirm: true, confirm_newline: sent.confirmNewline, operation_id: sent.operationId }, started);
      } catch (reason) {
        checkCurrent(started);
        if (reason instanceof Error && ['invalid_request', 'request_too_large', 'confirmation_required'].includes(reason.message)) receipt = null;
        throw reason;
      }
      if (data.applied === true) receipt = null;
      operation.textContent = `Operation ID: ${sent.operationId} · applied: ${data.applied === true ? 'yes' : 'no'}`;
      confirmed.checked = false; newline.checked = false;
    }));
    const discard = button('Discard unknown send', 'Discard the unknown send receipt after explicit warning', () => {
      if (pending || !receipt || !window.confirm('The command may already have executed. Discarding this unknown send allows a new operation that may execute it again. Discard unknown send?')) return;
      receipt = null; refreshReceipt(); operation.textContent = '';
    });
    async function revision(): Promise<number> {
      const response = await workspaceFetch(getToken(), { action: 'read', workspace_id: workspaceId });
      if (!response.ok) throw Error('unavailable');
      const data: unknown = await response.json();
      const value = (data && typeof data === 'object' ? (data as Record<string, unknown>).revision : null);
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error('unavailable');
      return value as number;
    }
    function checkCurrent(started: number) {
      if (disposed || dialog !== modal || started !== sequence) throw Error('revoked');
    }
    async function api(body: Record<string, unknown>, started: number): Promise<ResponseData> {
      checkCurrent(started);
      const response = await fetch('/api/managed-terminals', {
        method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
      });
      checkCurrent(started);
      const data: unknown = await response.json();
      checkCurrent(started);
      if (!data || typeof data !== 'object') throw Error('provider_error');
      const record = data as ResponseData;
      if (!response.ok || record.ok !== true) throw Error(typeof record.code === 'string' && errors.has(record.code) ? record.code : 'provider_error');
      return record;
    }
    async function run(task: (started: number) => Promise<void>) {
      if (pending) return;
      pending = true; controls.querySelectorAll('button').forEach(node => { node.disabled = true; });
      revoke.disabled = false;
      error.textContent = '';
      const started = ++sequence;
      try { await task(started); }
      catch (reason) {
        if (disposed || dialog !== modal || started !== sequence) return;
        const code = reason instanceof Error && errors.has(reason.message) ? reason.message : 'unavailable';
        error.textContent = `Managed terminal: ${code.replaceAll('_', ' ')}`;
        if (['identity_changed', 'unavailable', 'unauthorized', 'revoked', 'expired'].includes(code)) { lease = null; output.value = ''; operation.textContent = ''; status.textContent = 'Lease unavailable. Reconcile and request fresh consent.'; }
      } finally { pending = false; refreshReceipt(); controls.querySelectorAll('button').forEach(node => { node.disabled = false; }); }
    }
    controls.append(reconcile, adopt, release, label('Scope', scope), grant, revoke, observe);
    modal.append(el('h2', '', 'Managed terminal'), el('p', '', 'Owner-only controls. Adoption, each output read, and each input require explicit action. Output is untrusted.'), status, error, controls,
      label('Untrusted output · read-only, copyable', output), label('Literal input', input),
      label('Confirm this input action', confirmed), label('Acknowledge newlines may execute commands', newline), send, operation, warning, discard,
      button('Close', 'Close managed terminal controls', () => modal.close()));
    modal.addEventListener('keydown', event => event.stopPropagation());
    modal.addEventListener('close', () => { sequence++; lease = null; clear(); modal.remove(); if (dialog === modal) dialog = null; }, { once: true });
    document.body.append(modal); modal.showModal(); reconcile.focus();
  }
  return { dispose() { disposed = true; dialog?.close(); dialog?.remove(); dialog = null; open.remove(); } };
}
