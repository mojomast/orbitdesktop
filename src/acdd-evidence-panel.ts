// Read-only ACDD evidence panel. Produces a self-contained HTML fragment with
// no scripts or inline event handlers; Orbit only displays verifier output.
export interface AcddTimelineRow {
  phase: string;
  classification: string;
  shortRev: string | null;
  at: string;
  by: string;
  ok: boolean;
}

export interface AcddCriterionRow {
  id: string;
  text: string;
  verification: string;
  status: string;
  label: string;
  evidence: string | null;
}

export interface AcddFailure {
  code: string;
  text: string;
}

export interface AcddVerification {
  available: boolean;
  verified: number;
  rejected: number;
}

export interface AcddRecordRow {
  index: number;
  phase: string | null;
  status: string;
  reason: string;
}

export type AcddVerificationState = 'verified' | 'rejected' | 'invalid' | 'unverified' | 'incomplete';

export interface AcddEvidenceView {
  contractId: string;
  title: string;
  shortSha: string | null;
  frozen: boolean;
  authority: string;
  timeline: AcddTimelineRow[];
  criteria: AcddCriterionRow[];
  phases: Record<string, string>;
  accepted: boolean;
  verificationState?: AcddVerificationState;
  records?: AcddRecordRow[];
  verification?: AcddVerification;
  failures: AcddFailure[];
  notes: string[];
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ENTITIES[character] ?? '');
}

function statusClass(status: string): string {
  if (status === 'review_required') return 'review';
  return String(status ?? '').replace(/_/g, '-').replace(/[^A-Za-z0-9-]/g, '-');
}

const STATE_LABELS: Record<string, { text: string; background: string; color: string; border: string }> = {
  verified: {
    text: 'Verified — signed by the bundlebees verifier and all required evidence is present.',
    background: '#173a27', color: '#b9f0c4', border: '#4f8a5f',
  },
  rejected: {
    text: 'Rejected — the evidence or acceptance report failed verification.',
    background: '#3a1d1d', color: '#ffc4c4', border: '#9a4a4a',
  },
  invalid: {
    text: 'Invalid — the contract or every evidence record is unreadable or malformed.',
    background: '#3a3017', color: '#f2dea0', border: '#9a824a',
  },
  unverified: {
    text: 'Unverified — there is no usable signing key, or there are no evidence records.',
    background: '#2b2b33', color: '#d7d7e2', border: '#6a6a7a',
  },
  incomplete: {
    text: 'Incomplete — a required phase or a verified acceptance report is still missing.',
    background: '#1d2d3a', color: '#bcdcf4', border: '#4a769a',
  },
};

function verificationBadge(state: string | undefined): string {
  const label = STATE_LABELS[state ?? ''];
  if (!label) return '';
  const safeState = escapeHtml(state);
  return `<p class="acdd-verification-state acdd-verification-state-${safeState}"`
    + ` data-verification-state="${safeState}"`
    + ` style="display:inline-block;margin:6px 0;padding:4px 10px;border-radius:999px;`
    + `background:${label.background};color:${label.color};border:1px solid ${label.border};font-weight:600">`
    + `${escapeHtml(label.text)}</p>`;
}

export function renderEvidencePanel(view: AcddEvidenceView): string {
  const criteria = Array.isArray(view.criteria) && view.criteria.length
    ? view.criteria.map(criterion => (
      `<tr class="acdd-status-${escapeHtml(statusClass(criterion.status))}">`
      + `<td>${escapeHtml(criterion.id)}</td>`
      + `<td>${escapeHtml(criterion.text)}</td>`
      + `<td>${escapeHtml(criterion.label)}</td>`
      + '</tr>'
    )).join('')
    : '<tr><td colspan="3">No acceptance criteria.</td></tr>';

  const timeline = Array.isArray(view.timeline) && view.timeline.length
    ? view.timeline.map(row => {
      const revision = row.shortRev ? ` · ${escapeHtml(row.shortRev)}` : '';
      const by = row.by ? ` · ${escapeHtml(row.by)}` : '';
      const at = row.at ? ` · ${escapeHtml(row.at)}` : '';
      const state = row.ok ? '' : ' · not counted';
      return `<li class="acdd-timeline-${escapeHtml(statusClass(row.phase))}">`
        + `<strong>${escapeHtml(row.phase)}</strong>: ${escapeHtml(row.classification)}`
        + `${revision}${by}${at}${state}</li>`;
    }).join('')
    : '<li>No evidence records yet.</li>';

  const failures = Array.isArray(view.failures) && view.failures.length
    ? '<section class="acdd-failures"><h3>Failures</h3><ul>'
      + view.failures.map(failure => (
        `<li><code>${escapeHtml(failure.code)}</code> ${escapeHtml(failure.text)}</li>`
      )).join('')
      + '</ul></section>'
    : '';

  const notes = Array.isArray(view.notes) && view.notes.length
    ? '<section class="acdd-notes"><h3>Notes</h3><ul>'
      + view.notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')
      + '</ul></section>'
    : '';

  const verification = view.verification
    ? `<p class="acdd-verification${view.verification.available ? '' : ' acdd-verification-unavailable'}">`
      + (view.verification.available
        ? `Signature verification: ${escapeHtml(view.verification.verified)} verified, ${escapeHtml(view.verification.rejected)} rejected`
        : 'Signature verification unavailable; evidence is not counted')
      + '</p>'
    : '';

  const stateBadge = verificationBadge(view.verificationState);

  return `<section class="acdd-evidence">`
    + '<header class="acdd-header">'
    + `<h2>${escapeHtml(view.title)}</h2>`
    + `<p class="acdd-meta">Contract ${escapeHtml(view.contractId)} · revision ${escapeHtml(view.shortSha ?? 'unknown')}`
    + `${view.frozen ? ' · frozen' : ' · not frozen'}</p>`
    + '<p class="acdd-authority">Decided by bundlebees verifier; Orbit only displays</p>'
    + stateBadge
    + verification
    + '</header>'
    + '<table class="acdd-criteria">'
    + '<thead><tr><th>ID</th><th>Criterion</th><th>Status</th></tr></thead>'
    + `<tbody>${criteria}</tbody>`
    + '</table>'
    + '<section class="acdd-timeline"><h3>Evidence timeline</h3><ol>'
    + timeline
    + '</ol></section>'
    + failures
    + notes
    + '</section>';
}
