// Private server-resolved identities. Presentation must never resolve versions.
export interface DiffIdentity {
  candidate_id: string;
  generation: number;
  candidate_hash: string;
}
export interface CandidateDiffFile {
  path: string;
  old_hash: string | null;
  new_hash: string | null;
  old_mode: string | number | null;
  new_mode: string | number | null;
  old_bytes?: number;
  new_bytes?: number;
  text_available: boolean;
  reason?: string;
  old_text?: string | null;
  new_text?: string | null;
}
export interface CandidateDiffData {
  available: boolean;
  mode?: string;
  comparison?: 'previous' | 'initial';
  mode_provenance?: 'retained_tree_observation';
  from?: DiffIdentity;
  to?: DiffIdentity;
  changed_files?: number;
  files?: CandidateDiffFile[];
  truncated?: boolean;
  reason?: string;
  current_generation?: number;
  note?: string;
}
export interface DiffToken { text: string; changed: boolean }
export interface DiffLine { number: number; text: string; tokens?: DiffToken[] }
export interface DiffRow {
  kind: 'context' | 'add' | 'delete' | 'modify';
  old?: DiffLine;
  new?: DiffLine;
}
export interface DiffHunk { start: number; end: number }
export interface CalculatedDiff {
  rows: DiffRow[];
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  raw: string;
  limited?: boolean;
  notice?: string;
}
