// The task selects a contract revision, not a current code head. Even a
// signed, accepted report can only supply history to this board.
import type { AcddEvidenceView } from './acdd-evidence-panel.ts';

export type ContractRef = { id: string; contract_sha256: string };
export type FeedItem = { id: string; state: 'done' | 'pending' | 'error'; text: string };
type BoardState = 'pending' | 'error';
export type BoardEvidence = { chip: string; state: BoardState; rows: (FeedItem & { state: BoardState })[] };
const neutral: BoardEvidence = { chip: 'ACDD · no verified record', state: 'pending', rows: [] };

export function contractKey(ref?: ContractRef): string {
  return ref && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ref.id) && /^[a-f0-9]{64}$/.test(ref.contract_sha256)
    ? `${ref.id}:${ref.contract_sha256}` : '';
}

export function projectEvidence(ref: ContractRef, response: {view?: AcddEvidenceView; items?: FeedItem[]}): BoardEvidence {
  const view = response?.view;
  if (!contractKey(ref) || view?.frozen !== true || view.contractId !== ref.id || view.contractSha256 !== ref.contract_sha256 || view.verification?.available !== true) return neutral;
  if (view.verificationState === 'rejected') return { chip: 'ACDD · evidence rejected', state: 'error', rows: [] };
  if (view.verificationState !== 'verified' && view.verificationState !== 'incomplete') return neutral;
  if (!Array.isArray(view.timeline) || !view.timeline.length) return neutral;
  return {
    chip: 'ACDD · historical runs only', state: 'pending',
    rows: (response.items ?? []).filter(item => item.id !== `${ref.id}:summary`).map(item => ({
      id: item.id, text: `Historical · ${item.text}`, state: item.state === 'error' ? 'error' : 'pending',
    })),
  };
}

export async function readBoardEvidence(ref: ContractRef, token: string, signal: AbortSignal): Promise<BoardEvidence> {
  if (!token || !contractKey(ref)) return neutral;
  const params = new URLSearchParams({ contract: ref.id, sha: ref.contract_sha256 });
  const response = await fetch(`/api/acdd-evidence?${params}`, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'origin', cache: 'no-store', signal,
    headers: { Authorization: `Bearer ${token}` } });
  return response.ok ? projectEvidence(ref, await response.json()) : neutral;
}
