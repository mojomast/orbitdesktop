// Read-only ACDD evidence window. Orbit only displays bundlebees contracts,
// verifier records and acceptance; it never writes, signs or decides.
import { renderEvidencePanel, type AcddEvidenceView } from './acdd-evidence-panel.ts';

if (typeof document !== 'undefined') {
  void import('./acdd-evidence.css');
}

export const ACDD_EVIDENCE_COMMAND = 'acdd-evidence';

export interface AcddContractSummary {
  id: string;
  title: string | null;
  records: number;
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const TEXT_ENTITIES: Record<string, string> = {
  ...ENTITIES,
  '=': '&#61;',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ENTITIES[character] ?? '');
}

function escapeText(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'=]/g, character => TEXT_ENTITIES[character] ?? '');
}

export function evidenceRequest(token: string, contractId?: string): {
  url: string;
  init: { method: 'GET'; headers: { Authorization: string } };
} {
  const url = contractId === undefined
    ? '/api/acdd-evidence'
    : `/api/acdd-evidence?contract=${encodeURIComponent(contractId)}`;
  return {
    url,
    init: { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  };
}

export function contractListHtml(list: AcddContractSummary[]): string {
  const entries = Array.isArray(list) ? list : [];
  if (entries.length === 0) {
    return '<p class="acdd-empty">No ACDD evidence yet. Set ORBIT_ACDD_STATE_DIR to the bundlebees plugin data directory.</p>';
  }
  const rows = entries.map(entry => {
    const id = String(entry?.id ?? '');
    const label = typeof entry?.title === 'string' && entry.title ? entry.title : id;
    const count = typeof entry?.records === 'number' && Number.isFinite(entry.records) ? entry.records : 0;
    const unit = count === 1 ? 'record' : 'records';
    return `<li><button type="button" data-contract="${escapeHtml(id)}">${escapeText(label)}</button> <span>${escapeText(count)} ${unit}</span></li>`;
  }).join('');
  return `<ul class="acdd-contract-list">${rows}</ul>`;
}

interface EvidenceListResponse {
  configured?: boolean;
  contracts?: AcddContractSummary[];
}

interface EvidenceViewResponse {
  view?: AcddEvidenceView;
  skipped?: number;
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : 'ACDD evidence is unavailable.';
    throw new Error(message);
  }
  return data as T;
}

export async function openAcddEvidence(token: string): Promise<void> {
  const dialog = document.createElement('dialog');
  dialog.className = 'hermes-tools-dialog acdd-evidence-dialog';
  dialog.setAttribute('aria-label', 'ACDD evidence');

  const heading = document.createElement('h2');
  heading.textContent = 'ACDD evidence';
  const note = document.createElement('p');
  note.className = 'acdd-note';
  note.textContent = 'Read-only. Decided by the bundlebees verifier; Orbit only displays.';
  const status = document.createElement('p');
  status.className = 'acdd-status';
  status.setAttribute('role', 'status');
  const listHost = document.createElement('div');
  listHost.className = 'acdd-list';
  const detailHost = document.createElement('div');
  detailHost.className = 'acdd-detail';
  detailHost.hidden = true;
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = 'Back';
  back.hidden = true;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());

  dialog.append(heading, note, status, listHost, detailHost, back, close);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();

  const showError = (error: unknown) => {
    status.textContent = error instanceof Error && error.message
      ? error.message
      : 'ACDD evidence is unavailable.';
  };

  const showList = async () => {
    status.textContent = 'Loading…';
    listHost.hidden = false;
    detailHost.hidden = true;
    detailHost.replaceChildren();
    back.hidden = true;
    try {
      const request = evidenceRequest(token);
      const data = await fetchJson<EvidenceListResponse>(request.url, request.init);
      const contracts = data.configured === false
        ? []
        : Array.isArray(data.contracts) ? data.contracts : [];
      listHost.innerHTML = contractListHtml(contracts);
      status.textContent = '';
    } catch (error) {
      listHost.replaceChildren();
      showError(error);
    }
  };

  const showContract = async (contractId: string) => {
    const request = evidenceRequest(token, contractId);
    status.textContent = 'Loading…';
    try {
      const data = await fetchJson<EvidenceViewResponse>(request.url, request.init);
      if (!data.view) throw new Error('ACDD evidence is unavailable.');
      detailHost.innerHTML = renderEvidencePanel(data.view);
      listHost.hidden = true;
      detailHost.hidden = false;
      back.hidden = false;
      const skipped = typeof data.skipped === 'number' ? data.skipped : 0;
      status.textContent = skipped > 0
        ? `${skipped} evidence ${skipped === 1 ? 'record' : 'records'} skipped.`
        : '';
    } catch (error) {
      showError(error);
    }
  };

  listHost.addEventListener('click', event => {
    const target = event.target;
    const button = target instanceof HTMLElement
      ? target.closest<HTMLButtonElement>('button[data-contract]')
      : null;
    const contractId = button?.dataset.contract;
    if (contractId) void showContract(contractId);
  });
  back.addEventListener('click', () => { void showList(); });

  await showList();
}
