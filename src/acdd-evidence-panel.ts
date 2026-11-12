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

  return `<section class="acdd-evidence">`
    + '<header class="acdd-header">'
    + `<h2>${escapeHtml(view.title)}</h2>`
    + `<p class="acdd-meta">Contract ${escapeHtml(view.contractId)} · revision ${escapeHtml(view.shortSha ?? 'unknown')}`
    + `${view.frozen ? ' · frozen' : ' · not frozen'}</p>`
    + '<p class="acdd-authority">Decided by bundlebees verifier; Orbit only displays</p>'
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
