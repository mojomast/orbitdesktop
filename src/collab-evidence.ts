// Owner-side projection of one exact contract revision. A task reference is
// only a lookup key. No board state, note, report summary or worker label is
// sufficient to synthesize a passing chip.
import type { AcddEvidenceView } from './acdd-evidence-panel.ts';

export type ContractRef = { id: string; contract_sha256: string };
export type FeedItem = { id: string; state: 'done' | 'pending' | 'error'; text: string };
export type BoardEvidence = { chip: string; state: FeedItem['state']; rows: FeedItem[] };
const neutral: BoardEvidence = { chip: 'ACDD · no verified record', state: 'pending', rows: [] };

export function contractKey(ref?: ContractRef): string {
  return ref && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ref.id) && /^[a-f0-9]{64}$/.test(ref.contract_sha256)
    ? `${ref.id}:${ref.contract_sha256}` : '';
}

export function projectEvidence(ref: ContractRef, response: {view?: AcddEvidenceView; items?: FeedItem[]}): BoardEvidence {
  const view = response?.view;
  if (!view?.frozen || view.contractId !== ref.id || view.contractSha256 !== ref.contract_sha256 || !view.verification?.available) return neutral;
  const latest = view.timeline.at(-1);
  const rows = (response.items ?? []).filter(item => item.id !== `${ref.id}:summary`);
  if (!latest) return { ...neutral, rows };
  const state = latest.result === 'unrun' ? 'pending' : latest.ok ? 'done' : 'error';
  return { chip: `ACDD ${latest.phase}: ${latest.result === 'valid' ? latest.classification : latest.result}`, state, rows };
}

export async function readBoardEvidence(ref: ContractRef, token: string, signal: AbortSignal): Promise<BoardEvidence> {
  if (!token || !contractKey(ref)) return neutral;
  const params = new URLSearchParams({ contract: ref.id, sha: ref.contract_sha256 });
  const response = await fetch(`/api/acdd-evidence?${params}`, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'origin', cache: 'no-store', signal,
    headers: { Authorization: `Bearer ${token}` } });
  return response.ok ? projectEvidence(ref, await response.json()) : neutral;
}
