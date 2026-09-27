import type { CandidateDiffData, DiffIdentity } from './candidate-diff-types';

type RecordData = Record<string, unknown>;
const record = (value: unknown): value is RecordData => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (item: unknown): item is DiffIdentity => record(item) && typeof item.candidate_id === 'string' && Number.isSafeInteger(item.generation) && Number(item.generation) >= 1 && hash(item.candidate_hash);
const matches = (a: DiffIdentity, b: DiffIdentity) => a.candidate_id === b.candidate_id && a.generation === b.generation && a.candidate_hash === b.candidate_hash;

/** Normalize the private server's resolved comparison, without resolving identities in the browser. */
export function candidateDiffFromDetail(value: unknown, expected?: DiffIdentity): CandidateDiffData {
  if (!record(value) || value.mode !== 'candidate_generation_diff') throw Error('Unexpected candidate comparison');
  const detail = value as RecordData;
  if (expected && identity(detail.to) && !matches(detail.to, expected)) throw Error('stale_resource');
  if (detail.available !== true) return {
    available: false, mode: 'candidate_generation_diff', comparison: detail.comparison === 'initial' ? 'initial' : 'previous',
    from: identity(detail.from) ? detail.from : undefined,
    to: identity(detail.to) ? detail.to : expected,
    reason: typeof detail.reason === 'string' ? detail.reason : 'historical_diff_unavailable',
    current_generation: typeof detail.current_generation === 'number' ? detail.current_generation : undefined,
  };
  const from = detail.from, to = detail.to;
  const comparison = detail.comparison === 'initial' ? 'initial' : 'previous';
  if (!identity(from) || !identity(to) || from.candidate_id !== to.candidate_id ||
      (comparison === 'initial' ? from.generation !== 1 : from.generation + 1 !== to.generation) ||
      (expected && (to.candidate_id !== expected.candidate_id || to.generation !== expected.generation || to.candidate_hash !== expected.candidate_hash))) throw Error('stale_resource');
  if (!Array.isArray(detail.files) || detail.files.length > 32 || !Number.isSafeInteger(detail.changed_files) || Number(detail.changed_files) < detail.files.length) throw Error('Invalid candidate comparison');
  let sourceBytes = 0;
  const paths = new Set<string>();
  return {
    available: true, mode: 'candidate_generation_diff', comparison, from, to,
    mode_provenance: detail.mode_provenance === 'retained_tree_observation' ? 'retained_tree_observation' : undefined,
    changed_files: detail.changed_files as number, truncated: detail.truncated === true,
    files: detail.files.map((file: unknown) => {
      if (!record(file) || typeof file.path !== 'string' || typeof file.text_available !== 'boolean') throw Error('Invalid comparison file');
      if (paths.has(file.path) || !(file.old_hash === null || hash(file.old_hash)) || !(file.new_hash === null || hash(file.new_hash))) throw Error('Invalid comparison file identity');
      paths.add(file.path);
      if (file.text_available) {
        if ((file.old_hash !== null && typeof file.old_text !== 'string') || (file.new_hash !== null && typeof file.new_text !== 'string')) throw Error('Missing exact comparison source');
        sourceBytes += new TextEncoder().encode(typeof file.old_text === 'string' ? file.old_text : '').byteLength + new TextEncoder().encode(typeof file.new_text === 'string' ? file.new_text : '').byteLength;
        if (sourceBytes > 65536) throw Error('Private comparison exceeds source-detail bound');
      }
      return {
        path: file.path, old_hash: typeof file.old_hash === 'string' ? file.old_hash : null,
        new_hash: typeof file.new_hash === 'string' ? file.new_hash : null,
        old_mode: typeof file.old_mode === 'string' || typeof file.old_mode === 'number' ? file.old_mode : null,
        new_mode: typeof file.new_mode === 'string' || typeof file.new_mode === 'number' ? file.new_mode : null,
        old_bytes: typeof file.old_bytes === 'number' ? file.old_bytes : undefined,
        new_bytes: typeof file.new_bytes === 'number' ? file.new_bytes : undefined,
        text_available: file.text_available,
        reason: typeof file.reason === 'string' ? file.reason : undefined,
        old_text: file.text_available && typeof file.old_text === 'string' ? file.old_text : null,
        new_text: file.text_available && typeof file.new_text === 'string' ? file.new_text : null,
      };
    }),
  };
}
