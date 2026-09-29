// Read-only, sanitized projection of existing recorded Workbench check facts
// for the `evidence_checks` host-rendered card.
//
// This module invents no facts and stores nothing. It reads the authoritative
// `wb_evidence`, `wb_annotations`, `wb_jobs` and `wb_reviews` records that the
// existing Workbench execution recorder already wrote, and reduces each to a
// small set of recorded fields. It never emits log paths, stdout/stderr bodies,
// environment fingerprints, commands, execution profiles or candidate file
// contents. Absence of records is reported as "no recorded evidence" and is
// never rendered as a pass.
//
// Supersession is authoritative as an *annotation*, not only as a raw record
// flag: the recorder writes `evidence_superseded` / `acceptance_superseded`
// annotations while the immutable evidence row keeps `superseded:false`. This
// module folds those annotations with the same interpretation as
// `server/workbench-execution.mjs` `projectedEvidence`, so invalidated evidence
// is never presented as a current fact. The newest identity-matched review is
// joined (never an arbitrary insertion-order match), and the exact
// candidate/acceptance identity is carried through rather than synthesized.
//
// Read only from the owner-authenticated host route. It must never be wired into
// the Normal controller, Hermes tools, workspace description or a generated
// frame.

import {TOOL_LIMITS} from '../contracts/project-tools-v1.mjs';

const SUPERSEDE_KINDS = Object.freeze(['evidence_superseded', 'acceptance_superseded']);
const integer = value => (Number.isInteger(value) ? value : null);

function publicReview(review) {
  // Exact stored review identity and candidate/acceptance identity; the
  // `review_identity` digest, when present, is passed through, never invented.
  return {
    id: review.id ?? null,
    decision: review.decision ?? null,
    review_identity: review.review_identity ?? null,
    candidate_id: review.candidate_id ?? null,
    candidate_hash: review.candidate_hash ?? null,
    acceptance_version: integer(review.acceptance_version),
    acceptance_digest: review.acceptance_digest ?? null,
    created_at: integer(review.created_at),
  };
}

// Durable ordering: later list entries (higher rowid) win an equal created_at
// tie, so the most recently persisted matching record is surfaced.
function newestMatching(list, predicate) {
  let match = null;
  for (const entry of list) {
    if (!predicate(entry)) continue;
    if (!match || (entry.created_at ?? 0) >= (match.created_at ?? 0)) match = entry;
  }
  return match;
}

// A review is attached only when it names this exact evidence and does not mix
// candidate generations: candidate id must match, and any candidate hash,
// acceptance digest and (when a job is joined) acceptance version that both
// sides expose must be equal. Missing legacy fields do not fabricate a match.
function reviewMatches(entry, review, job) {
  if (!review.evidence_ids.includes(entry.id)) return false;
  if (review.candidate_id !== entry.candidate_id) return false;
  if (review.candidate_hash !== undefined && entry.candidate_hash_after !== undefined && review.candidate_hash !== entry.candidate_hash_after) return false;
  if (review.acceptance_digest !== undefined && entry.acceptance_digest !== undefined && review.acceptance_digest !== entry.acceptance_digest) return false;
  if (job && review.acceptance_version !== undefined && job.acceptance_version !== undefined && review.acceptance_version !== job.acceptance_version) return false;
  return true;
}

export function projectToolChecks({data}, {workspace_id, project_id}) {
  const annotations = data.list('annotations', workspace_id, project_id);
  const isSuperseded = entry => entry.superseded === true
    || entry.revoked === true
    || annotations.some(annotation => SUPERSEDE_KINDS.includes(annotation.kind) && annotation.evidence_id === entry.id);

  const jobs = data.list('jobs', workspace_id, project_id);
  const reviews = data.list('reviews', workspace_id, project_id).filter(entry => entry && Array.isArray(entry.evidence_ids));

  const current = data.list('evidence', workspace_id, project_id)
    .filter(entry => entry && !isSuperseded(entry));

  const facts = current.map(entry => {
    const job = jobs.find(record => record.id === entry.job_id) ?? null;
    const review = newestMatching(reviews, candidate => reviewMatches(entry, candidate, job));
    return {
      evidence_id: entry.id,
      job_id: entry.job_id ?? null,
      task_id: entry.task_id ?? null,
      candidate_id: entry.candidate_id ?? null,
      // Exact candidate generation from the authoritative job record; null when
      // no matching job is retained. Optional for the frozen card UI.
      candidate_generation: job ? (integer(job.candidate_generation) ?? null) : null,
      definition_id: entry.definition_id ?? null,
      definition_digest: entry.definition_digest ?? null,
      verdict: entry.verdict ?? 'inconclusive',
      exit_code: integer(entry.exit_code),
      timed_out: entry.timed_out === true,
      process_survival_unknown: entry.process_survival_unknown === true,
      candidate_hash_before: entry.candidate_hash_before ?? null,
      candidate_hash_after: entry.candidate_hash_after ?? null,
      project_generation: integer(entry.project_generation),
      created_at: integer(entry.created_at),
      review: review ? publicReview(review) : null,
    };
  }).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0) || String(b.evidence_id).localeCompare(String(a.evidence_id)));

  const shown = facts.slice(0, TOOL_LIMITS.checksMax);
  const truncated = facts.length > shown.length;
  return {
    version: 1,
    recorded_count: facts.length,
    truncated,
    recorded: shown,
    // The card must never translate "no failing record" into "verified". Only
    // recorder verdicts are shown, and they are facts, not a merge or deploy.
    message: facts.length
      ? `${facts.length} recorded evidence record${facts.length === 1 ? '' : 's'}; verdicts are recorder facts, not a merge, deployment or reusable grant.`
      : 'No recorded evidence; absence of records is never a pass.',
  };
}
