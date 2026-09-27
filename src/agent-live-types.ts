/** Presentation metadata only. References are resolved by authenticated owners. */
export type LiveAuthority = 'agent' | 'observed' | 'recorder' | 'human';
export type LiveCategory = 'agent' | 'tools' | 'files' | 'checks' | 'evidence' | 'warnings';
export type LiveStatus = 'ready' | 'running' | 'waiting' | 'pending' | 'completed' | 'failed' | 'denied' | 'stopped' | 'cancelled' | 'unknown' | 'info';
export type LiveReference = {
  kind: 'toolcall' | 'candidate' | 'job' | 'evidence' | 'result' | 'review' | 'artifact' | 'normal-tool';
  id: string;
  candidate_id?: string;
  generation?: number;
  hash?: string;
};
export type LiveItem = {
  version: 1;
  id: string;
  sequence?: number;
  at: number | null;
  authority: LiveAuthority;
  category: LiveCategory;
  kind: string;
  summary: string;
  status: LiveStatus;
  target?: string;
  duration_ms?: number;
  fields?: { label: string; value: string | number }[];
  reference?: LiveReference;
};
export type LiveConnection = 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'closed';
